import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { GAP, INERT_MS, REST_MS } from '../../../src/editor/webview/placement';
import { LensRow } from '../../../src/editor/protocol';
import { closeEditorPage, delay, EditorPage, EXTENSION_ID, MOD, openEditorPage, pointAt, shot } from './pageHarness';
import { DARK_MODERN, LIGHT_MODERN, applyTheme } from './themes';

/** The caret's bar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
/** The pointer's bar, shown. */
const HOVER_BAR = '.mep-object-toolbar[data-trigger="hover"]:not([hidden])';
/** The bubble, shown. */
const BUBBLE = '.mep-bubble:not([hidden])';
/** A field bar of the row, shown. */
const ROW_FIELD = '.mep-object-toolbar[data-trigger="toolbar"]';
const CARD = '.mep-preview-card:not([hidden])';

type Box = { left: number; top: number; right: number; bottom: number };

/** A paragraph long enough to wrap onto several lines at any width the suite uses. */
const LONG = 'Every request is retried with back-off, and the limits below bound what a device keeps while it is offline and how long it waits before it gives up';

/**
 * One placement policy and one floating-layer slot (`placement.ts`, wave 2 ·
 * #9), in the real page with the real mouse and keyboard: every layer below
 * its anchor at its start, else above, never on the caret's line, under the
 * row, past the window or over another layer; one layer at a time; the rests,
 * Esc, typing and the pointer's inert time. With `MEP_SHOTS_DIR` set, each
 * scenario is saved light and dark at 1280 and 520.
 */
suite('Editor placement (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const showDocument = async (text: string, marker: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
        });
        await delay(300);
    };

    /** The host's answer to an edit made elsewhere: the document again, the page left as it is (a resync). */
    const resendDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
    };

    const clickBefore = async (needle: string, index = 0) => {
        const p = await pointAt(page, needle, index);
        await page.mouse.click(p.x, p.y);
        await delay(60);
    };

    const box = (selector: string): Promise<Box | null> => page.evaluate(sel => {
        const el = document.querySelector(sel);
        if (!el) {
            return null;
        }
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }, selector);

    /** The caret's line box: the selection's head as the browser draws it. */
    const caret = (): Promise<Box> => page.evaluate(() => {
        const sel = document.getSelection() as Selection;
        const range = document.createRange();
        range.setStart(sel.focusNode as Node, sel.focusOffset);
        range.collapse(true);
        const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });

    /** The document's text lines the element `selector` covers. */
    const coveredText = (selector: string): Promise<string[]> => page.evaluate(sel => {
        const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
        const covered: string[] = [];
        const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const r = document.createRange();
            r.selectNodeContents(node);
            if ((node.textContent ?? '').trim() !== '' && Array.from(r.getClientRects()).some(b => b.left < bar.right && b.right > bar.left && b.top < bar.bottom && b.bottom > bar.top)) {
                covered.push(node.textContent ?? '');
            }
        }
        return covered;
    }, selector);

    const overlap = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const offLine = (a: Box, line: Box) => a.bottom <= line.top + 1 || a.top >= line.bottom - 1;
    const shown = async (selector: string) => (await page.$(selector)) !== null;
    const waitBar = (timeout = REST_MS + 2000) => page.waitForSelector(BAR, { timeout });

    // -- the scenarios, each leaving the page in its state ----------------------

    /** s1: a table at the window's bottom, the caret in its last row. */
    const s1 = async () => {
        const filler = Array.from({ length: 50 }, (_, i) => `Paragraph ${i + 1} before the table.`).join('\n\n');
        await showDocument(`${filler}\n\n| Region | Q1 | Q2 |\n| --- | --- | --- |\n| North | 1 | 2 |\n| Southlast | 3 | 4 |\n\nAfter the table.\n`, 'Southlast');
        await page.evaluate(() => {
            const table = (document.querySelector('.ProseMirror > table') as HTMLElement).getBoundingClientRect();
            window.scrollBy(0, table.bottom - (window.innerHeight - 6));
        });
        await delay(100);
        await clickBefore('Southlast', 2);
        await waitBar();
    };

    /** s2's document: the link on a paragraph's second line, whole lines of text above and below it, as far across as the bar stands. */
    const S2_TEXT = `Above the paragraph.\n\n${LONG}, ${LONG} then [linkedwords](https://example.com/limits) and more text after it, ${LONG.toLowerCase()}, ${LONG.toLowerCase()}, ${LONG.toLowerCase()}.\n\nBelow it.\n`;

    /** s2: the caret in a link on a paragraph's second line. */
    const s2 = async () => {
        // Whole lines of text above and below the link's line, the link one word so it never wraps: text under both, the bar keeps below (#15 review 2).
        await showDocument(S2_TEXT, 'linkedwords');
        await clickBefore('linkedwords', 3);
        await waitBar();
    };

    /** s2b: the caret in a link on the document's last line, text above it and nothing below: the free side, below. */
    const s2b = async () => {
        await showDocument(`Above the line.\n\nThe last line holds [lastlink](https://example.com/last)\n`, 'lastlink');
        await clickBefore('lastlink', 3);
        await waitBar();
    };

    /** s3a: text selected with the mouse inside a sidenote's reference. */
    const s3a = async () => {
        await showDocument(`Intro line one.\n\nAlpha ++beta reference words here|the body of the note++ gamma, ${LONG}.\n\nSecond paragraph.\n`, 'reference words');
        const from = await pointAt(page, 'reference words', 0);
        const to = await pointAt(page, 'reference words', 14);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 4 });
        await page.mouse.up();
        await delay(100);
    };

    /** s3m: a selection over three lines, made with the mouse: the bubble under its last line, at that line's start. */
    const s3m = async () => {
        await showDocument(`Intro.\n\n${LONG}, ${LONG}, ${LONG}.\n\nAfter.\n`, 'Intro');
        const from = await pointAt(page, 'limits below', 0);
        await page.mouse.click(from.x, from.y);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.keyboard.down('Shift');
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('ArrowDown');
        }
        await page.keyboard.up('Shift');
        await delay(REST_MS + 200);
    };

    /** s4: Attributes of Quote… from the Formatting menu, the caret at the quote's second word. */
    const s4 = async () => {
        await showDocument(`Before the quote.\n\n> Quoted words that run on, ${LONG}.\n\nAfter the quote.\n`, 'Quoted words');
        await clickBefore('words that', 2);
        await page.click('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
        await page.waitForSelector('.mep-menu[data-menu="formatting"]:not([hidden])', { timeout: 3000 });
        await page.click('.mep-menu [data-action="block-attributes"]');
        await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { timeout: 2000 });
        await delay(50);
    };

    /**
     * s5: the Formatting menu open, the pointer on Highlight: its preview card, waited for — it shows a
     * delay after the pointer enters (`toolbar.ts`), which a loaded machine stretches past any fixed wait.
     * `card: false` where the window leaves it no room: the delay then passes with none shown.
     */
    const s5 = async (card = true) => {
        await showDocument('Alpha beta gamma.\n', 'Alpha');
        await clickBefore('beta', 1);
        // From the keyboard; in a row too narrow for it, Formatting is in "…" (wave 2 · #2) and opens from its entry there.
        if (await page.$eval('.mep-toolbar .mep-menu-face[data-menu="formatting"]', el => (el as HTMLElement).hidden)) {
            await page.focus('.mep-toolbar .mep-more-face');
            await page.keyboard.press('Enter');
            await page.waitForSelector('.mep-menu[data-menu="more"]:not([hidden])', { timeout: 3000 });
            await page.focus('.mep-menu[data-menu="more"] [data-submenu="formatting"]');
            await page.keyboard.press('ArrowRight');
        } else {
            await page.focus('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
            await page.keyboard.press('ArrowDown');
        }
        await page.waitForSelector('.mep-menu[data-menu="formatting"]:not([hidden])', { timeout: 3000 });
        await page.hover('.mep-menu[data-menu="formatting"] [data-action="mark"]');
        if (card) {
            await page.waitForSelector(`${CARD}[data-action="mark"]`, { timeout: 3000 });
        } else {
            await delay(600);
        }
    };

    /** s6: a heading with attributes, scrolled to just under the row, the caret in it. */
    const s6 = async () => {
        const filler = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
        await showDocument(`${filler}\n\n## Limits of the device {.spec}\n`, 'Limits of');
        await page.evaluate(() => {
            const heading = (document.querySelector('.ProseMirror > h2') as HTMLElement).getBoundingClientRect();
            const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
            window.scrollBy(0, heading.top - row.bottom - 2);
        });
        await delay(100);
        await clickBefore('Limits of', 3);
        await waitBar();
    };

    /** s6r: a requirement's heading with its lens row, a two-line title and a paragraph below, scrolled to just under the row, the caret in the title. */
    const s6r = async () => {
        const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
        // Text enough after it that the page can scroll the row up under the toolbar.
        const after = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 41}.`).join('\n\n');
        const title = 'FRS-RXE-040 Every floating layer keeps off the caret\'s line, the formatting row and the other open layers, whatever the width of the window';
        await showDocument(`${filler}\n\n## ${title}\n\nThe paragraph under the title says what the requirement asks for, in a line or two of text that the bar must not cover.\n\n${after}\n`, 'FRS-RXE-040');
        // The row above the heading is the foreign lenses (no surface); its bar's verbs are the `action` lenses.
        const rows: LensRow[] = [
            { blockIndex: 40, items: [{ id: '1.0', title: '$(check) 3 tests passing', tooltip: 'Runs the tests' }, { id: '1.1', title: 'Implemented' }] },
            { blockIndex: 40, items: [{ id: '1.2', title: 'Show in Req Explorer', surface: 'action', artifact: 'FRS-RXE-040' }] },
        ];
        await (editor as EditorPage).send({ type: 'lenses', version, blocks: 72, rows });
        await page.waitForSelector('.mep-lens-row', { timeout: 2000 });
        await page.evaluate(() => {
            const lens = (document.querySelector('.mep-lens-row') as HTMLElement).getBoundingClientRect();
            const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
            window.scrollBy(0, lens.top - row.bottom - 2);
        });
        await delay(100);
        await clickBefore('Every floating', 3);
        await waitBar();
    };

    /** s7: the margin lane open, the caret in a link in a table cell, Shift+Enter refused: the hint and the bar. */
    /** s7b: as s7 with the caret in the cell's plain text: the table's bar, below the table, and the hint above the caret's line. */
    const s7b = async () => {
        await showDocument(`Alpha ++beta|the note's body++ gamma.\n\n| Kind | Where it is written down |\n| --- | --- |\n| first | in [the device limits](https://example.com/a) |\n\nAfter.\n`, 'device limits');
        // The hint of the scenario before, if it still stands, would be the one shown again (`CaretHint.show`).
        await page.evaluate(() => {
            (document.querySelector('.mep-hint') as HTMLElement | null)?.setAttribute('hidden', '');
        });
        await clickBefore('first', 2);
        await waitBar();
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await page.waitForSelector('.mep-hint:not([hidden])', { timeout: 2000 });
    };

    const s7 = async () => {
        await showDocument(`Alpha ++beta|the note's body++ gamma.\n\n| Kind | Where it is written down |\n| --- | --- |\n| first | in [the device limits](https://example.com/a) |\n\nAfter.\n`, 'device limits');
        await clickBefore('device limits', 4);
        await waitBar();
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await page.waitForSelector('.mep-hint:not([hidden])', { timeout: 2000 });
    };

    /** t6: a link's bar up, the pointer on a source block: the cue, no pointer's bar. */
    const t6 = async () => {
        await showDocument('Text with [a link](https://example.com) in it.\n\n<div>A source block</div>\n\nAfter.\n', 'a link');
        await clickBefore('a link', 2);
        await waitBar();
        const atom = await box('.ProseMirror > .mep-atom');
        assert.ok(atom);
        await page.mouse.move((atom.left + atom.right) / 2, (atom.top + atom.bottom) / 2);
        await delay(200);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    setup(async () => {
        await page.setViewport({ width: 1280, height: 900 });
        await applyTheme(page, LIGHT_MODERN);
    });

    // -- geometry -------------------------------------------------------------

    test('s1: a table\'s bar at the window\'s bottom flips above it, at its left, off the caret\'s line', async function () {
        this.timeout(15000);
        await s1();
        const bar = await box(BAR);
        const table = await box('.ProseMirror > table');
        const line = await caret();
        assert.ok(bar && table);
        assert.ok(bar.bottom <= table.top - GAP + 1, `above the table: ${JSON.stringify({ bar, table })}`);
        assert.ok(Math.abs(bar.left - table.left) <= 1, `at the table's left: ${JSON.stringify({ bar, table })}`);
        assert.ok(offLine(bar, line), `off the caret's line: ${JSON.stringify({ bar, line })}`);
    });

    test('s2 (#15 review 2, Daniel: above only where below is text and above is not): a link\'s bar with text above and below keeps below the link, at its start, never on the caret\'s line', async function () {
        this.timeout(15000);
        await s2();
        const bar = await box(BAR);
        const link = await page.$eval('.ProseMirror a', a => {
            const rects = a.getClientRects();
            return { left: rects[0].left, bottom: rects[rects.length - 1].bottom };
        });
        const line = await caret();
        assert.ok(bar);
        assert.ok(bar.top >= link.bottom + GAP - 1, `below the link: ${JSON.stringify({ bar, link })}`);
        assert.ok(Math.abs(bar.left - link.left) <= 1, `at the link's first line's start: ${JSON.stringify({ bar, link })}`);
        assert.ok(offLine(bar, line), `off the caret's line: ${JSON.stringify({ bar, line })}`);
    });

    test('s2b: a link\'s bar with text only above stays below it, the free side', async function () {
        this.timeout(15000);
        await s2b();
        const bar = await box(BAR);
        const link = await page.$eval('.ProseMirror a', a => {
            const rects = a.getClientRects();
            return { left: rects[0].left, bottom: rects[rects.length - 1].bottom };
        });
        const line = await caret();
        assert.ok(bar);
        assert.ok(bar.top >= link.bottom + GAP - 1, `below the link: ${JSON.stringify({ bar, link })}`);
        assert.ok(Math.abs(bar.left - link.left) <= 1, `at the link's start: ${JSON.stringify({ bar, link })}`);
        assert.ok(offLine(bar, line), `off the caret's line: ${JSON.stringify({ bar, line })}`);
    });

    test('s6r: a requirement heading with its lens row, just under the row, has its bar below the title, clear of the row and the lens row', async function () {
        this.timeout(15000);
        await s6r();
        const bar = await box(BAR);
        const heading = await box('.ProseMirror > h2');
        const lens = await box('.mep-lens-row');
        const row = await box('.mep-toolbar');
        assert.ok(bar && heading && lens && row);
        assert.ok(lens.top >= row.bottom - 1 && lens.top <= row.bottom + 8, `the lens row just under the row: ${JSON.stringify({ lens, row })}`);
        assert.ok(bar.top >= row.bottom, 'not under the row');
        assert.ok(bar.top >= heading.bottom + GAP - 1, `below the two-line title: ${JSON.stringify({ bar, heading })}`);
        assert.ok(Math.abs(bar.left - heading.left) <= 1, `at the title's left: ${JSON.stringify({ bar, heading })}`);
        assert.ok(!overlap(bar, lens), 'not over the lens row');
    });

    test('s6l (wave 3 follow-up): in a requirement heading mid-window, a link\'s bar keeps off its lens row, the heading\'s Attributes… field stands above both; a plain heading\'s field stands above it', async function () {
        this.timeout(20000);
        const filler = Array.from({ length: 10 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
        const after = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 11}.`).join('\n\n');
        await showDocument(`${filler}\n\n## FRS-RXE-041 See [the limits](https://example.com/l) of every floating layer\n\nThe paragraph under the title says what the requirement asks for.\n\n## A plain heading\n\nIts paragraph.\n\n${after}\n`, 'FRS-RXE-041');
        const rows: LensRow[] = [{ blockIndex: 10, items: [{ id: '1.0', title: '$(check) 3 tests passing' }, { id: '1.1', title: 'Implemented' }] }];
        await (editor as EditorPage).send({ type: 'lenses', version, blocks: 26, rows });
        await page.waitForSelector('.mep-lens-row', { timeout: 2000 });
        await page.evaluate(() => {
            const h = (document.querySelector('.ProseMirror > h2') as HTMLElement).getBoundingClientRect();
            window.scrollBy(0, h.top - window.innerHeight / 3);
        });
        await delay(100);
        await clickBefore('limits', 2);
        await waitBar();
        const bar = await box(BAR);
        const lens = await box('.mep-lens-row');
        assert.ok(bar && lens);
        assert.ok(!overlap(bar, lens), `the link's bar not over the lens row: ${JSON.stringify({ bar, lens })}`);
        await shot(page, 'lens-row-inline-bar-1280.png');

        const openAttributes = async () => {
            await page.click('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
            await page.waitForSelector('.mep-menu[data-menu="formatting"]:not([hidden])', { timeout: 3000 });
            await page.click('.mep-menu [data-action="block-attributes"]');
            await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { timeout: 2000 });
            await delay(50);
            return box(ROW_FIELD);
        };
        await clickBefore('FRS-RXE-041', 3);
        const field = await openAttributes();
        assert.ok(field);
        assert.ok(!overlap(field, lens), `the heading's field not over its lens row: ${JSON.stringify({ field, lens })}`);
        assert.ok(field.bottom <= lens.top + 1, `above the heading and its lens row: ${JSON.stringify({ field, lens })}`);
        await shot(page, 'lens-row-heading-field-1280.png');
        await page.keyboard.press('Escape');
        await delay(100);

        await clickBefore('plain heading', 2);
        const plain = await openAttributes();
        const heading = await page.evaluate(() => {
            const r = (document.querySelectorAll('.ProseMirror > h2')[1] as HTMLElement).getBoundingClientRect();
            return { left: r.left, top: r.top };
        });
        assert.ok(plain);
        assert.ok(plain.bottom <= heading.top - GAP + 2, `a plain heading's field above it: ${JSON.stringify({ plain, heading })}`);
        await shot(page, 'heading-field-above-1280.png');
        await page.keyboard.press('Escape');
    });

    test('s3a/s3b: a mouse selection in a note shows the bubble alone, below it; collapsed, the note\'s bar after a rest, below its line with text on both sides (#15 review 2), the bubble gone', async function () {
        this.timeout(15000);
        await s3a();
        await page.waitForSelector(BUBBLE, { timeout: 500 });
        const bubble = await box(BUBBLE);
        const selection = await page.evaluate(() => {
            const r = (document.getSelection() as Selection).getRangeAt(0).getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        assert.ok(bubble);
        assert.ok(bubble.top >= selection.bottom + GAP - 1, `below the selection: ${JSON.stringify({ bubble, selection })}`);
        await delay(REST_MS + 200);
        assert.strictEqual(await shown(BAR), false, 'no bar while the bubble shows');

        await clickBefore('reference words', 4);
        await delay(100);
        assert.strictEqual(await shown(BUBBLE), false, 'the bubble goes with the selection');
        await waitBar();
        const bar = await box(BAR);
        const ref = await box('.ProseMirror .sn-ref');
        assert.ok(bar && ref);
        // Text above and below the note's line: the bar keeps below (#15 review 2, Daniel: above only where below is text and above is not).
        assert.ok(bar.top >= ref.bottom + GAP - 1, `the bar below the note's line: ${JSON.stringify({ bar, ref })}`);
        assert.strictEqual(await shown(BUBBLE), false);
    });

    test('s3c: the bubble hides while Shift+arrows grow the selection and shows a rest after the last key; a mouse-up shows it at once', async function () {
        this.timeout(15000);
        await showDocument(`Alpha beta gamma delta epsilon zeta.\n\nSecond paragraph.\n`, 'Alpha');
        await clickBefore('beta', 0);
        await page.keyboard.down('Shift');
        let last = 0;
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('ArrowRight');
            last = Date.now();
            await delay(60);
            assert.strictEqual(await shown(BUBBLE), false, `hidden while growing (key ${i + 1})`);
        }
        await page.keyboard.up('Shift');
        await page.waitForSelector(BUBBLE, { timeout: REST_MS + 1000 });
        assert.ok(Date.now() - last >= REST_MS - 50, 'not before the selection rested');

        // A selection drawn with the mouse shows at its release.
        const from = await pointAt(page, 'delta', 0);
        const to = await pointAt(page, 'delta', 4);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 3 });
        assert.strictEqual(await shown(BUBBLE), false, 'not while the pointer draws it');
        await page.mouse.up();
        await page.waitForSelector(BUBBLE, { timeout: 150 });
    });

    test('s3d: a selection taller than the window keeps the bubble at the window\'s visible bottom', async function () {
        this.timeout(20000);
        const paragraphs = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long selection.`).join('\n\n');
        await showDocument(`${paragraphs}\n`, 'Line 60');
        await clickBefore('Line 1 of', 0);
        // To the document's end: Shift+Ctrl+End, on macOS Shift+Cmd+Down — whose command the protocol does not run there unless named (`editCommand`).
        const mac = process.platform === 'darwin';
        await page.keyboard.down('Shift');
        await page.keyboard.down(MOD);
        await page.keyboard.press(mac ? 'ArrowDown' : 'End', mac ? { commands: ['MoveToEndOfDocumentAndModifySelection'] } : undefined);
        await page.keyboard.up(MOD);
        await page.keyboard.up('Shift');
        await page.waitForSelector(BUBBLE, { timeout: REST_MS + 2000 }).catch(() => undefined);
        await page.evaluate(() => window.scrollTo(0, (document.scrollingElement as Element).scrollHeight / 3));
        // Placed again in the frame after the scroll (`placement.ts`): waited for, not given a fixed time.
        await page.waitForFunction((sel, gap) => {
            const el = document.querySelector(sel);
            return el !== null && Math.abs(el.getBoundingClientRect().bottom - (window.innerHeight - gap)) <= 1;
        }, { timeout: 2000, polling: 20 }, BUBBLE, GAP).catch(() => undefined);
        const bubble = await box(BUBBLE);
        const height = await page.evaluate(() => window.innerHeight);
        assert.ok(bubble, 'the bubble shows');
        assert.ok(Math.abs(bubble.bottom - (height - GAP)) <= 1, `at the visible bottom: ${JSON.stringify({ bubble, height })}`);
    });

    test('s3m: a selection over three lines has its bubble under the last line, at that line\'s start', async function () {
        this.timeout(15000);
        await s3m();
        const bubble = await box(BUBBLE);
        const last = await page.evaluate(() => {
            const rects = Array.from((document.getSelection() as Selection).getRangeAt(0).getClientRects()).filter(r => r.width > 0);
            const top = Math.max(...rects.map(r => r.top));
            const line = rects.filter(r => r.bottom > top);
            return { left: Math.min(...line.map(r => r.left)), bottom: Math.max(...rects.map(r => r.bottom)) };
        });
        assert.ok(bubble);
        assert.ok(Math.abs(bubble.left - last.left) <= 1, `at the last line's start: ${JSON.stringify({ bubble, last })}`);
        assert.ok(bubble.top >= last.bottom + GAP - 1, `below the last line: ${JSON.stringify({ bubble, last })}`);
    });

    test('s4: the row\'s Attributes… opens at its block\'s left edge, above the block; Insert → Link… at the caret, under its line', async function () {
        this.timeout(15000);
        await s4();
        const field = await box(ROW_FIELD);
        // A block's attributes field stands above the block, whichever route opened it (Daniel, 2026-10-27: under it, it covered the next block's first line).
        const quote = await page.evaluate(() => {
            const r = (document.querySelector('.ProseMirror blockquote') as HTMLElement).getBoundingClientRect();
            return { left: r.left, top: r.top };
        });
        assert.ok(field);
        assert.ok(Math.abs(field.left - quote.left) <= 2, `at the block's left edge: ${JSON.stringify({ field, quote })}`);
        assert.ok(Math.abs(field.bottom - (quote.top - GAP)) <= 2, `above the block: ${JSON.stringify({ field, quote })}`);
        await page.keyboard.press('Escape');
        await delay(100);

        await showDocument('A plain paragraph with words in it.\n', 'plain paragraph');
        await clickBefore('words in', 0);
        const caretAt = await caret();
        await page.keyboard.down('Control');
        await page.keyboard.press('k');
        await page.keyboard.up('Control');
        const link = await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { timeout: 2000 });
        assert.ok(link);
        const linkBar = await box(ROW_FIELD);
        assert.ok(linkBar);
        assert.ok(Math.abs(linkBar.left - caretAt.left) <= 2, `Link… at the caret's x: ${JSON.stringify({ linkBar, caretAt })}`);
        assert.ok(Math.abs(linkBar.top - (caretAt.bottom + GAP)) <= 2, `Link… under the caret's line: ${JSON.stringify({ linkBar, caretAt })}`);
        await page.keyboard.press('Escape');
    });

    test('s5: the preview card stands beside its menu at 1280, below it at 420, and goes where it has no room', async function () {
        this.timeout(20000);
        const check = async () => {
            const card = await box(CARD);
            const menu = await box('.mep-menu[data-menu="formatting"]');
            const entry = await box('.mep-menu[data-menu="formatting"] [data-action="mark"]');
            assert.ok(card && menu && entry);
            assert.ok(!overlap(card, menu) && !overlap(card, entry), `never over the menu or its entry: ${JSON.stringify({ card, menu, entry })}`);
            return { card, menu };
        };
        await s5();
        const wide = await check();
        assert.ok(wide.card.left >= wide.menu.right, 'beside the menu');

        await page.setViewport({ width: 420, height: 1000 });
        await s5();
        const narrow = await check();
        assert.ok(narrow.card.top >= narrow.menu.bottom, `below the menu: ${JSON.stringify(narrow)}`);

        // A window so low the menu takes it all: no room below the menu either.
        await page.setViewport({ width: 420, height: 240 });
        await s5(false);
        const low = { card: await box(CARD), menu: await box('.mep-menu[data-menu="formatting"]'), more: await box('.mep-menu[data-menu="more"]') };
        assert.strictEqual(low.card, null, `no room beside, below or above: no card ${JSON.stringify(low)}`);
        await page.keyboard.press('Escape');
    });

    test('s6: a heading just under the row has its bar below it, at its left, over no text', async function () {
        this.timeout(15000);
        await s6();
        const bar = await box(BAR);
        const heading = await box('.ProseMirror > h2');
        const row = await box('.mep-toolbar');
        assert.ok(bar && heading && row);
        assert.ok(bar.top >= row.bottom, 'not under the row');
        assert.ok(bar.top >= heading.top, `below the heading's text: ${JSON.stringify({ bar, heading })}`);
        assert.ok(Math.abs(bar.left - heading.left) <= 1, `at the heading's left: ${JSON.stringify({ bar, heading })}`);
        assert.deepStrictEqual(await coveredText(BAR), []);
    });

    /** The lane's right edge, as the page reserves it (`rightLaneEdge`). */
    const laneEdge = () => page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const column = document.body.getBoundingClientRect().right - (parseFloat(body.paddingRight) || 0);
        const gaps = ['--md-note-gap', '--md-sidebar-gap'].map(n => parseFloat(body.getPropertyValue(n))).filter(n => !isNaN(n));
        return column + (gaps.length > 0 ? Math.min(...gaps) : 0);
    });

    test('s7: with the lane open the bar and the hint stop short of it and keep off each other and off the caret\'s line; the bar below with text on both sides (#15 review 2)', async function () {
        this.timeout(15000);
        await s7();
        const lane = await laneEdge();
        const bar = await box(BAR);
        const hint = await box('.mep-hint');
        const line = await caret();
        assert.ok(bar && hint);
        assert.ok(bar.right <= lane - GAP + 1 && hint.right <= lane - GAP + 1, `short of the lane: ${JSON.stringify({ bar, hint, lane })}`);
        assert.ok(!overlap(bar, hint), `the hint keeps off the bar: ${JSON.stringify({ bar, hint })}`);
        assert.ok(offLine(hint, line), `the hint off the caret's line: ${JSON.stringify({ hint, line })}`);
        // A link's bar keeps below where text is on both sides (#15 review 2): the hint takes the place above the line.
        assert.ok(bar.top >= line.bottom - 1 && hint.bottom <= line.top + 1, `the bar under the line, the hint above it: ${JSON.stringify({ bar, hint, line })}`);
    });

    test('s7b: with the table\'s bar below the table, the hint flips above the caret\'s line, and a keystroke takes it', async function () {
        this.timeout(15000);
        await s7b();
        const lane = await laneEdge();
        const bar = await box(BAR);
        const hint = await box('.mep-hint');
        const line = await caret();
        assert.ok(bar && hint);
        assert.ok(bar.right <= lane - GAP + 1 && hint.right <= lane - GAP + 1, `short of the lane: ${JSON.stringify({ bar, hint, lane })}`);
        assert.ok(!overlap(bar, hint), `the hint keeps off the bar: ${JSON.stringify({ bar, hint })}`);
        assert.ok(hint.bottom <= line.top + 1, `the hint above the caret's line: ${JSON.stringify({ hint, line })}`);
        assert.strictEqual(await page.$eval('.mep-hint', el => el.hasAttribute('data-flipped')), true);
        await page.keyboard.type('x');
        await delay(100);
        assert.strictEqual(await page.$eval('.mep-hint', el => (el as HTMLElement).hidden), true, 'gone with the keystroke');
    });

    // -- timing ---------------------------------------------------------------

    test('t1: Esc hides the bar until the caret leaves the object — from the bar and from the text; Alt+Enter brings it back', async function () {
        this.timeout(20000);
        await s2();
        // From the bar.
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await delay(80);
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BAR), false, 'hidden by Esc in the bar');
        await page.keyboard.press('ArrowRight');
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BAR), false, 'still hidden after rests in the same object');
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await waitBar(500);

        // From the text (F1): the bar shown, the text focused.
        await clickBefore('linkedwords', 5);
        await waitBar();
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BAR), false, 'hidden by Esc in the text');
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BAR), false, 'still hidden');
        // Out of the link and back: it shows after a rest.
        await clickBefore('Below it', 1);
        await clickBefore('linkedwords', 3);
        await waitBar();
    });

    test('t2: typing in a link hides its bar at the first key; it comes back a rest after the last', async function () {
        this.timeout(15000);
        await s2();
        await page.keyboard.type('a');
        await delay(30);
        assert.strictEqual(await shown(BAR), false, 'hidden at the first keystroke');
        await delay(100);
        await page.keyboard.press('b');
        await delay(100);
        await page.keyboard.press('c');
        const last = Date.now();
        assert.strictEqual(await shown(BAR), false, 'hidden while typing');
        await waitBar();
        assert.ok(Date.now() - last >= REST_MS - 50, 'back only after the rest');
    });

    test('t3: a bar that just appeared ignores the pointer: a click at once lands in the text; after the inert time the verb runs', async function () {
        this.timeout(20000);
        await s2();
        await clickBefore('Above the', 0);
        await clickBefore('linkedwords', 3);
        await page.waitForSelector(`${BAR}[data-inert]`, { timeout: REST_MS + 2000 });
        const verb = await box(`${BAR} [data-verb="remove-link"]`);
        assert.ok(verb);
        const before = (await (editor as EditorPage).edits()).length;
        // Pressed at once — `mouse.click` would wait for the inert time as a person does (`pageHarness.ts`).
        await page.mouse.move((verb.left + verb.right) / 2, (verb.top + verb.bottom) / 2);
        await page.mouse.down();
        await page.mouse.up();
        await delay(150);
        assert.strictEqual(await page.$eval('.ProseMirror a', a => a.textContent), 'linkedwords', 'no verb ran');
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'nothing was edited');

        await clickBefore('linkedwords', 3);
        await waitBar();
        await delay(INERT_MS + 50);
        const again = await box(`${BAR} [data-verb="remove-link"]`);
        assert.ok(again);
        await page.mouse.click((again.left + again.right) / 2, (again.top + again.bottom) / 2);
        await delay(100);
        assert.strictEqual(await page.$('.ProseMirror a'), null, 'the verb ran');
    });

    test('t4: placing again where nothing moved arms no inert time', async function () {
        this.timeout(15000);
        await s2();
        await delay(INERT_MS + 50);
        assert.strictEqual(await page.$eval(BAR, el => el.hasAttribute('data-inert')), false);
        await page.evaluate(() => {
            window.scrollBy(0, 0);
            window.dispatchEvent(new Event('resize'));
        });
        await delay(100);
        assert.strictEqual(await page.$eval(BAR, el => el.hasAttribute('data-inert')), false);
    });

    test('t5: a row menu open hides the bar; closed, the bar is back without a new rest', async function () {
        this.timeout(15000);
        await s2();
        await page.click('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
        await page.waitForSelector('.mep-menu[data-menu="formatting"]:not([hidden])', { timeout: 3000 });
        assert.strictEqual(await shown(BAR), false, 'hidden while the menu is open');
        // Closed as it was opened, by its face (the focus stayed in the text).
        await page.click('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
        await delay(50);
        assert.strictEqual(await shown('.mep-menu[data-menu="formatting"]:not([hidden])'), false, 'the menu closed');
        assert.strictEqual(await shown(BAR), true, 'back at once');
    });

    test('t6: the pointer on a block while a link\'s bar is up gets the hover cue, not a bar; with the slot free, the bar', async function () {
        this.timeout(15000);
        await t6();
        assert.strictEqual(await shown(HOVER_BAR), false, 'the caret\'s layer wins');
        assert.strictEqual(await page.$eval('.ProseMirror > .mep-atom', el => el.classList.contains('mep-hover-cue')), true, 'the cue');
        const outline = await page.$eval('.ProseMirror > .mep-atom', el => getComputedStyle(el).outlineStyle);
        assert.strictEqual(outline, 'solid');
        // Esc frees the slot: the pointer's bar shows.
        await page.keyboard.press('Escape');
        await page.waitForSelector(HOVER_BAR, { timeout: 1000 });
        assert.strictEqual(await page.$eval('.ProseMirror > .mep-atom', el => el.classList.contains('mep-hover-cue')), false, 'no cue once the bar shows');
    });

    // -- fix round 1 (review of 2026-10-20) -------------------------------------

    const FORMATTING_FACE = '.mep-toolbar .mep-menu-face[data-menu="formatting"]';
    const FORMATTING_MENU = '.mep-menu[data-menu="formatting"]:not([hidden])';
    /** The pointer on the document's source block, which has a bar of its own. */
    const SOURCE_BLOCK_TEXT = 'Text before.\n\n<div>A source block</div>\n\nAfter the block.\n';

    const hoverTheBlock = async () => {
        const atom = await box('.ProseMirror > .mep-atom');
        assert.ok(atom);
        await page.mouse.move((atom.left + atom.right) / 2, (atom.top + atom.bottom) / 2);
    };

    test('r1-1: Esc in the pointer\'s bar hides it for as long as the pointer stays; leaving the block and coming back brings it again', async function () {
        this.timeout(20000);
        await showDocument(SOURCE_BLOCK_TEXT, 'A source block');
        await hoverTheBlock();
        await page.waitForSelector(HOVER_BAR, { timeout: 2000 });
        await delay(INERT_MS + 50);
        await page.focus(`${HOVER_BAR} button`);
        await page.keyboard.press('Escape');
        await delay(100);
        assert.strictEqual(await shown(HOVER_BAR), false, 'hidden by Esc');
        await hoverTheBlock();
        await delay(200);
        assert.strictEqual(await shown(HOVER_BAR), false, 'still hidden while the pointer stays on the block');
        // Away for longer than the grace, then back on the block.
        await page.mouse.move(2, 2);
        await delay(600);
        await hoverTheBlock();
        await page.waitForSelector(HOVER_BAR, { timeout: 2000 });
    });

    test('r1-1b: the block whose pointer\'s bar Esc dismissed has no hover cue: the cue promises a bar', async function () {
        this.timeout(20000);
        await showDocument(SOURCE_BLOCK_TEXT, 'A source block');
        await hoverTheBlock();
        await page.waitForSelector(HOVER_BAR, { timeout: 2000 });
        await delay(INERT_MS + 50);
        await page.focus(`${HOVER_BAR} button`);
        await page.keyboard.press('Escape');
        await delay(100);
        assert.strictEqual(await page.$eval('.ProseMirror > .mep-atom', el => el.classList.contains('mep-hover-cue')), false, 'no cue for a bar that will not come');
        await page.mouse.move(2, 2);
        await delay(600);
    });

    test('r1-2: a row menu opened over a field bar leaves the field and what was typed in it', async function () {
        this.timeout(15000);
        await s4();
        await page.keyboard.type('.xy');
        await page.click(FORMATTING_FACE);
        await page.waitForSelector(FORMATTING_MENU, { timeout: 3000 });
        await delay(150);
        const field = await page.$eval(`${ROW_FIELD} input`, el => ({ value: (el as HTMLInputElement).value, hidden: (el.closest('.mep-layer') as HTMLElement).hidden }));
        // The field opens empty between the braces it draws: what was typed stands in it.
        assert.deepStrictEqual(field, { value: '.xy', hidden: false });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
    });

    test('r1-3: a selection that rested while a row menu was open has its bubble when the menu closes', async function () {
        this.timeout(15000);
        await showDocument('Alpha beta gamma delta epsilon zeta.\n\nSecond paragraph.\n', 'Alpha');
        await clickBefore('beta', 0);
        await page.keyboard.down('Shift');
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.up('Shift');
        // Opened and closed without the pointer, so no release asks for the bubble (`bubbleReleased`): only the rest does, and it fires while the menu is open.
        await page.$eval(FORMATTING_FACE, el => (el as HTMLElement).click());
        await page.waitForSelector(FORMATTING_MENU, { timeout: 3000 });
        await delay(REST_MS + 250);
        assert.strictEqual(await shown(BUBBLE), false, 'no bubble over an open menu');
        await page.$eval(FORMATTING_FACE, el => (el as HTMLElement).click());
        await page.waitForSelector(BUBBLE, { timeout: 1000 });
    });

    test('r1-4: the pointer\'s bar stays under a pointer that has not moved since it ran into the bar while it was inert', async function () {
        this.timeout(20000);
        await showDocument(SOURCE_BLOCK_TEXT, 'A source block');
        await hoverTheBlock();
        await page.waitForSelector(`${HOVER_BAR}[data-inert]`, { timeout: 2000 });
        const bar = await box(HOVER_BAR);
        assert.ok(bar);
        // At once, while the bar ignores the pointer: the event names the text under it.
        await page.mouse.move((bar.left + bar.right) / 2, (bar.top + bar.bottom) / 2);
        await delay(INERT_MS + 800);
        assert.strictEqual(await shown(HOVER_BAR), true, 'still there under the still pointer');
        const again = await box(HOVER_BAR);
        assert.deepStrictEqual(again, bar, 'and where it was');
    });

    test('r1-5: Esc\'s dismissal of the caret\'s bar survives the focus leaving the editor and coming back', async function () {
        this.timeout(20000);
        await s2();
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BAR), false, 'hidden by Esc');
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await delay(250);
        await page.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement).focus());
        assert.strictEqual(await page.evaluate(() => (document.getSelection()?.anchorNode?.parentElement?.closest('a') ?? null) !== null), true, 'the caret is still in the link');
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BAR), false, 'still hidden');
        // Out of the link, so the next test's click into it is a new arrival.
        await clickBefore('Below it', 1);
    });

    test('r1-5: Esc\'s dismissal of the caret\'s bar survives a resync that moves its object', async function () {
        this.timeout(20000);
        await s2();
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BAR), false, 'hidden by Esc');
        // The host's text changed above the caret: a paragraph more, every position after it moved.
        await resendDocument(`A paragraph the host put first.\n\n${S2_TEXT}`);
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('the host put first'), { timeout: 3000 });
        assert.strictEqual(await page.evaluate(() => (document.getSelection()?.anchorNode?.parentElement?.closest('a') ?? null) !== null), true, 'the caret is still in the link');
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BAR), false, 'still hidden');
        await clickBefore('Below it', 1);
    });

    test('r3-1: Esc on a table\'s bar, a character typed in a cell: the bar stays hidden — the block\'s first edit re-marks it in place, which is no deletion; deleting the table ends the dismissal', async function () {
        this.timeout(30000);
        const doc = (cell: string) => `Alpha.\n\n| Kind | Where |\n| --- | --- |\n| ${cell} | second |\n\nAfter.\n`;
        const shows = (text: string) => page.waitForFunction(t => document.querySelector('.ProseMirror')?.textContent?.includes(t), { timeout: 3000 }, text);
        await showDocument(doc('first'), 'second');
        await clickBefore('first', 2);
        await waitBar();
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BAR), false, 'hidden by Esc');
        await page.keyboard.type('x');
        await shows('fixrst');
        await delay(REST_MS * 2 + 200);
        assert.strictEqual(await shown(BAR), false, 'still hidden after the typed character');
        // The host's answer to the edit: the document again, the caret still in the cell.
        await resendDocument(doc('fixrst'));
        await delay(REST_MS * 2 + 200);
        assert.strictEqual(await shown(BAR), false, 'still hidden after the resync');

        // The table deleted, then back where it was: the dismissal did not outlive it.
        await resendDocument('Alpha.\n\nAfter.\n');
        await page.waitForFunction(() => !document.querySelector('.ProseMirror table'), { timeout: 3000 });
        await resendDocument(doc('first'));
        await shows('second');
        await clickBefore('first', 2);
        await waitBar();
    });

    test('r3-2: at 420 a submenu with no room beside stands against its entry: the pointer goes from the entry into it and it stays open', async function () {
        this.timeout(20000);
        // Tall enough for the admonition list under its entry also where Insert is a submenu of "…" and stands lower.
        await page.setViewport({ width: 420, height: 1100 });
        await showDocument('Alpha beta gamma.\n', 'Alpha');
        await clickBefore('beta', 1);
        // At 420 Insert is in "…" (wave 2 · #2): it opens from its entry there, as a submenu of "…".
        if (await page.$eval('.mep-toolbar .mep-menu-face[data-menu="insert"]', el => (el as HTMLElement).hidden)) {
            await page.focus('.mep-toolbar .mep-more-face');
            await page.keyboard.press('Enter');
            await page.waitForSelector('.mep-menu[data-menu="more"]:not([hidden])', { timeout: 3000 });
            await page.focus('.mep-menu[data-menu="more"] [data-submenu="insert"]');
            await page.keyboard.press('ArrowRight');
        } else {
            await page.focus('.mep-toolbar .mep-menu-face[data-menu="insert"]');
            await page.keyboard.press('ArrowDown');
        }
        await page.waitForSelector('.mep-menu[data-menu="insert"]:not([hidden])', { timeout: 3000 });
        const opener = await box('.mep-menu[data-menu="insert"] [data-submenu="admonition"]');
        assert.ok(opener);
        const x = (opener.left + opener.right) / 2;
        await page.mouse.move(x, (opener.top + opener.bottom) / 2);
        await page.waitForSelector('.mep-menu[data-menu="admonition"]:not([hidden])', { timeout: 3000 });
        await delay(300);
        const sub = await box('.mep-menu[data-menu="admonition"]');
        const first = await box('.mep-menu[data-menu="admonition"] .mep-menu-item:not([hidden])');
        assert.ok(sub && first);
        assert.ok(sub.top >= opener.bottom - 1 && sub.top <= opener.bottom + 1, `under its entry, against it: ${JSON.stringify({ opener, sub })}`);
        // A pixel at a time: a band between the two would be the next entry's, and entering it closes the submenu.
        for (let y = Math.round((opener.top + opener.bottom) / 2); y <= (first.top + first.bottom) / 2; y++) {
            await page.mouse.move(x, y);
        }
        await delay(200);
        assert.strictEqual(await shown('.mep-menu[data-menu="admonition"]:not([hidden])'), true, 'the submenu stays open under the pointer');
        assert.strictEqual(await page.evaluate(() => document.querySelector('.mep-menu[data-menu="admonition"] .mep-menu-item:hover') !== null), true, 'the pointer is on its first entry');
        await page.keyboard.press('Escape');
    });

    test('r4-1: at 420 a submenu taller than the room on both sides stands below its entry, else above it, never over it, its height the room: it scrolls', async function () {
        this.timeout(30000);
        // Low enough that the admonition list (70vh at most) fits neither under nor over its entry.
        await page.setViewport({ width: 420, height: 400 });
        await showDocument('Alpha beta gamma.\n', 'Alpha');
        await clickBefore('beta', 1);
        if (await page.$eval('.mep-toolbar .mep-menu-face[data-menu="insert"]', el => (el as HTMLElement).hidden)) {
            await page.focus('.mep-toolbar .mep-more-face');
            await page.keyboard.press('Enter');
            await page.waitForSelector('.mep-menu[data-menu="more"]:not([hidden])', { timeout: 3000 });
            await page.focus('.mep-menu[data-menu="more"] [data-submenu="insert"]');
            await page.keyboard.press('ArrowRight');
        } else {
            await page.focus('.mep-toolbar .mep-menu-face[data-menu="insert"]');
            await page.keyboard.press('ArrowDown');
        }
        await page.waitForSelector('.mep-menu[data-menu="insert"]:not([hidden])', { timeout: 3000 });
        const entry = '.mep-menu[data-menu="insert"] [data-submenu="admonition"]';
        const opener = await box(entry);
        assert.ok(opener);
        await page.mouse.move((opener.left + opener.right) / 2, (opener.top + opener.bottom) / 2);
        await page.waitForSelector('.mep-menu[data-menu="admonition"]:not([hidden])', { timeout: 3000 });
        await delay(300);
        const sub = await box('.mep-menu[data-menu="admonition"]');
        assert.ok(sub);
        const state = await page.$eval('.mep-menu[data-menu="admonition"]', el => ({ scrolls: el.scrollHeight > el.clientHeight + 1, maxHeight: (el as HTMLElement).style.maxHeight, window: window.innerHeight }));
        const said = JSON.stringify({ opener, sub, state });
        assert.ok(!overlap(sub, opener), `not over its own entry: ${said}`);
        assert.ok(sub.top >= -1 && sub.bottom <= state.window + 1, `inside the window: ${said}`);
        assert.ok(sub.top >= opener.bottom - 1 || sub.bottom <= opener.top + 1, `below the entry or above it: ${said}`);
        assert.ok(state.scrolls && state.maxHeight.endsWith('px'), `shrunk to the room, it scrolls: ${said}`);
        // The entry it hangs from is in sight: the panel does not stand over it.
        assert.strictEqual(await page.evaluate(sel => {
            const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
            return hit !== null && hit.closest(sel) !== null;
        }, entry), true, `its entry is not covered: ${said}`);
        await page.keyboard.press('Escape');
    });

    test('r1-7: a character typed with AltGr or Option counts as typing: the bar hides at once', async function () {
        this.timeout(15000);
        await s2();
        await page.evaluate(() => {
            document.querySelector('.ProseMirror')?.dispatchEvent(new KeyboardEvent('keydown', { key: '{', code: 'Digit7', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true }));
        });
        await page.keyboard.sendCharacter('{');
        await delay(60);
        assert.strictEqual(await page.$eval('.ProseMirror a', a => a.textContent?.includes('{') ?? false), true, 'the character is in the link');
        assert.strictEqual(await shown(BAR), false, 'hidden at the keystroke');
        await page.evaluate(() => {
            document.dispatchEvent(new KeyboardEvent('keyup', { key: '{', bubbles: true }));
        });
    });

    test('r1-8: a field whose range the document has shrunk past is placed again without an error', async function () {
        this.timeout(20000);
        const errors: string[] = [];
        const onError = (error: Error) => errors.push(String(error));
        page.on('pageerror', onError);
        try {
            const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph number ${i + 1} of the document.`).join('\n\n');
            await showDocument(`${paragraphs}\n`, 'number 6');
            await clickBefore('number 6', 0);
            await page.keyboard.down('Shift');
            for (let i = 0; i < 6; i++) {
                await page.keyboard.press('ArrowRight');
            }
            await page.keyboard.up('Shift');
            await page.keyboard.down('Control');
            await page.keyboard.press('k');
            await page.keyboard.up('Control');
            await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { timeout: 2000 });
            await resendDocument('Paragraph number 1 of the document.\n');
            await delay(200);
            await page.evaluate(() => window.dispatchEvent(new Event('resize')));
            await delay(300);
            assert.deepStrictEqual(errors, []);
        } finally {
            page.off('pageerror', onError);
            await page.keyboard.press('Escape');
        }
    });

    test('r1-9: typing in a link does not let the pointer\'s bar take the freed slot; it waits at the cue until the caret\'s bar is back', async function () {
        this.timeout(15000);
        await t6();
        await page.keyboard.type('x');
        await delay(100);
        assert.strictEqual(await shown(BAR), false, 'the caret\'s bar hid at the keystroke');
        assert.strictEqual(await shown(HOVER_BAR), false, 'the pointer\'s bar did not take its place');
        assert.strictEqual(await page.$eval('.ProseMirror > .mep-atom', el => el.classList.contains('mep-hover-cue')), true, 'the cue stays');
        await waitBar();
        assert.strictEqual(await shown(HOVER_BAR), false, 'the caret\'s layer wins again');
    });

    test('r1-10: placing a layer reads the other open layers once', async function () {
        this.timeout(20000);
        const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} before the link.`).join('\n\n');
        await showDocument(`${filler}\n\nA line with [a link](https://example.com/a) in it.\n\n${filler}\n`, 'a link');
        await page.evaluate(() => {
            const link = document.querySelector('.ProseMirror a') as HTMLElement;
            window.scrollBy(0, link.getBoundingClientRect().top - 300);
        });
        await delay(100);
        await clickBefore('a link', 4);
        await waitBar();
        await delay(INERT_MS + 50);
        const reads = await page.evaluate(() => {
            const w = window as unknown as { layerReads: number };
            w.layerReads = 0;
            const original = Element.prototype.querySelectorAll;
            Element.prototype.querySelectorAll = function (this: Element, selector: string) {
                if (typeof selector === 'string' && selector.startsWith('.mep-layer, .mep-menu')) {
                    w.layerReads++;
                }
                return original.call(this, selector);
            } as typeof Element.prototype.querySelectorAll;
            (window as unknown as { restoreQuery: () => void }).restoreQuery = () => {
                Element.prototype.querySelectorAll = original;
            };
            return 0;
        });
        assert.strictEqual(reads, 0);
        try {
            await page.evaluate(() => window.scrollBy(0, 30));
            await delay(250);
            assert.strictEqual(await page.evaluate(() => (window as unknown as { layerReads: number }).layerReads), 1);
        } finally {
            await page.evaluate(() => (window as unknown as { restoreQuery: () => void }).restoreQuery());
        }
    });

    test('r1-12: the harness\'s click fails, naming it, when a layer stays inert', async function () {
        this.timeout(15000);
        await page.evaluate(() => {
            const stuck = document.createElement('div');
            stuck.id = 'stuck-layer';
            stuck.className = 'mep-layer';
            stuck.dataset.inert = '';
            document.body.append(stuck);
        });
        try {
            await assert.rejects(page.mouse.click(5, 5), /layer still inert after 2 s/);
        } finally {
            await page.evaluate(() => document.getElementById('stuck-layer')?.remove());
        }
    });

    // -- fix round 2 (review of 2026-10-20) ---------------------------------------

    test('r2-3: Esc, the focus away, a click back into the same link: the bar stays hidden; Alt+Enter brings it back', async function () {
        this.timeout(20000);
        await s2();
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BAR), false, 'hidden by Esc');
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await delay(250);
        await clickBefore('linkedwords', 5);
        assert.strictEqual(await page.evaluate(() => (document.getSelection()?.anchorNode?.parentElement?.closest('a') ?? null) !== null), true, 'the caret is in the link');
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BAR), false, 'a click back into the same object does not bring the bar again');
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await waitBar(500);
        await clickBefore('Below it', 1);
    });

    test('r2-7: a source box focused while the selection is elsewhere ends Esc\'s dismissal: back in the link, its bar comes', async function () {
        this.timeout(25000);
        await t6();
        await page.keyboard.press('Escape');
        await page.waitForSelector(HOVER_BAR, { timeout: 1000 });
        await delay(INERT_MS + 50);
        // The pointer\'s bar on the source block opens its source box: the focus is in a control, the selection on the block.
        await page.click(`${HOVER_BAR} [data-verb="edit-source"]`);
        await page.waitForSelector('.mep-raw-block textarea', { timeout: 2000 });
        await delay(150);
        assert.strictEqual(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'the source box has the focus');
        await clickBefore('a link', 2);
        await waitBar();
    });

    test('r2-9: a field bar has no inert time: its input takes the pointer at once', async function () {
        this.timeout(15000);
        await showDocument('A plain paragraph with words in it.\n', 'plain paragraph');
        await clickBefore('words in', 0);
        await page.keyboard.down('Control');
        await page.keyboard.press('k');
        await page.keyboard.up('Control');
        await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { timeout: 2000 });
        assert.strictEqual(await page.$eval(ROW_FIELD, el => el.hasAttribute('data-inert')), false, 'the row\'s field bar');
        await page.keyboard.press('Escape');
        await delay(100);

        // A bar's own field replaces the bar's verbs: the inert time the bar had is given up with them.
        await s2();
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await delay(30);
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${BAR} .mep-inline-field`, { timeout: 2000 });
        assert.strictEqual(await page.$eval(BAR, el => el.hasAttribute('data-inert')), false, 'the object bar\'s field');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await clickBefore('Below it', 1);
    });

    test('r2-10: Esc in the bubble hides it for good: after a focus round trip with the selection unchanged it stays hidden until the selection changes', async function () {
        this.timeout(20000);
        await showDocument('Alpha beta gamma delta epsilon zeta.\n\nSecond paragraph.\n', 'Alpha');
        await clickBefore('beta', 0);
        await page.keyboard.down('Shift');
        for (let i = 0; i < 3; i++) {
            await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.up('Shift');
        await page.waitForSelector(BUBBLE, { timeout: REST_MS + 2000 });
        await page.evaluate(() => (document.querySelector('.mep-bubble .mep-tool') as HTMLElement).focus());
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BUBBLE), false, 'hidden by Esc');
        assert.strictEqual(await page.evaluate(() => document.activeElement === document.querySelector('.ProseMirror')), true, 'the focus is back in the text');
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await delay(250);
        await page.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement).focus());
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BUBBLE), false, 'still hidden after the round trip');
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.waitForSelector(BUBBLE, { timeout: REST_MS + 2000 });
    });

    /** A keyboard selection of 'beta' with its bubble up, the text below the host's first paragraph. */
    const bubbleOnBeta = async () => {
        await showDocument('Alpha beta gamma delta epsilon zeta.\n\nSecond paragraph.\n', 'Alpha');
        await clickBefore('beta', 0);
        await page.keyboard.down('Shift');
        for (let i = 0; i < 4; i++) {
            await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.up('Shift');
        await page.waitForSelector(BUBBLE, { timeout: REST_MS + 2000 });
    };
    const resyncAbove = async () => {
        await resendDocument('A paragraph the host put first.\n\nAlpha beta gamma delta epsilon zeta.\n\nSecond paragraph.\n');
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('the host put first'), { timeout: 3000 });
        assert.strictEqual(await page.evaluate(() => document.getSelection()?.toString()), 'beta', 'the selection moved with its text');
    };

    test('r3-3 (wave 3 follow-up): a resync above the selection keeps its bubble up: it does not hide and wait for a new rest', async function () {
        this.timeout(20000);
        await bubbleOnBeta();
        await page.evaluate(() => {
            const w = window as unknown as { bubbleHid: boolean };
            w.bubbleHid = false;
            new MutationObserver(records => {
                w.bubbleHid = w.bubbleHid || records.some(r => r.oldValue === null && (r.target as HTMLElement).hidden);
            }).observe(document.querySelector('.mep-bubble') as Element, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
        });
        await resyncAbove();
        await delay(REST_MS + 200);
        assert.strictEqual(await page.evaluate(() => (window as unknown as { bubbleHid: boolean }).bubbleHid), false, 'the bubble never hid');
        assert.strictEqual(await shown(BUBBLE), true, 'and is up');
        const bubble = await box(BUBBLE);
        const selection = await page.evaluate(() => {
            const r = (document.getSelection() as Selection).getRangeAt(0).getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        assert.ok(bubble && bubble.top >= selection.bottom + GAP - 1, `below the moved selection: ${JSON.stringify({ bubble, selection })}`);
    });

    test('r3-3: Esc\'s dismissal of the bubble survives a resync that moves its selection', async function () {
        this.timeout(20000);
        await bubbleOnBeta();
        await page.evaluate(() => (document.querySelector('.mep-bubble .mep-tool') as HTMLElement).focus());
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BUBBLE), false, 'hidden by Esc');
        await resyncAbove();
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BUBBLE), false, 'still hidden');
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.waitForSelector(BUBBLE, { timeout: REST_MS + 2000 });
    });

    test('r3-3: a resync that deletes the selected text ends the bubble\'s claim: the next bar takes the slot', async function () {
        this.timeout(20000);
        await bubbleOnBeta();
        await resendDocument('Alpha gamma.\n\n| Kind | Where |\n| --- | --- |\n| first | second |\n');
        await page.waitForFunction(() => document.querySelector('.ProseMirror table'), { timeout: 3000 });
        assert.strictEqual(await shown(BUBBLE), false, 'no selection, no bubble');
        await clickBefore('first', 2);
        await waitBar();
    });

    test('r3-4 (wave 3 follow-up): a bar Esc dismissed is not drawn on the next refresh: no code actions asked for it', async function () {
        this.timeout(20000);
        const table = 'Alpha.\n\n| Kind | Where |\n| --- | --- |\n| first | second |\n\nAfter.\n';
        await showDocument(table, 'second');
        await clickBefore('first', 2);
        await waitBar();
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(BAR), false, 'hidden by Esc');
        // No pointer's bar for the table either: the pointer away from it.
        await page.mouse.move(1, 1);
        const requests = async () => (await (editor as EditorPage).posted()).filter(m => m.type === 'actionsFor') as { requestId: number; blockIndex: number }[];
        const asked = async () => (await requests()).length;
        const before = await asked();
        assert.ok(before > 0, 'the bar asked for the table\'s code actions as it showed');
        // The host's answer: none. A question not answered yet is not asked again.
        const last = (await requests())[before - 1];
        await (editor as EditorPage).send({ type: 'actions', requestId: last.requestId, blockIndex: last.blockIndex, items: [] });
        await delay(150);
        // The host says every code action may be out of date: a bar that shows asks again.
        await (editor as EditorPage).send({ type: 'invalidateActions' });
        await delay(REST_MS * 2);
        assert.strictEqual(await shown(BAR), false, 'still hidden');
        assert.strictEqual(await asked(), before, 'nothing asked for a bar that would only be hidden');
        await clickBefore('After', 1);
    });

    // -- shots ----------------------------------------------------------------

    test('shots: every scenario light and dark at 1280 and 520', async function () {
        this.timeout(240000);
        const scenarios: [string, () => Promise<void>][] = [
            ['s1', s1], ['s2', s2], ['s2b', s2b], ['s3a', s3a], ['s3b', async () => {
                await s3a();
                await clickBefore('reference words', 4);
                await waitBar();
            }], ['s3m', s3m], ['s4', s4], ['s5', s5], ['s6', s6], ['s6r', s6r], ['s7', s7], ['s7b', s7b], ['t6-cue', t6],
        ];
        for (const [width, height] of [[1280, 900], [520, 640]]) {
            for (const [theme, name] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as const) {
                await page.setViewport({ width, height });
                await applyTheme(page, theme);
                for (const [id, run] of scenarios) {
                    try {
                        await run();
                    } catch (error) {
                        // A state the narrow page cannot reach is shot as it stands, and said.
                        console.log(`placement shot ${id}-${name}-${width}: ${String(error)}`);
                    }
                    await delay(INERT_MS);
                    await shot(page, `${id}-${name}-${width}.png`);
                    await page.keyboard.press('Escape');
                    await page.keyboard.press('Escape');
                }
            }
        }
    });
});
