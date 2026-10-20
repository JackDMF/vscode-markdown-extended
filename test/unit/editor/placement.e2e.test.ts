import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { GAP, INERT_MS, REST_MS } from '../../../src/editor/webview/placement';
import { closeEditorPage, delay, EditorPage, EXTENSION_ID, openEditorPage, pointAt, shot } from './pageHarness';
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

    /** s2: the caret in a link on a paragraph's second line. */
    const s2 = async () => {
        // Whole lines of text above and below the link's line, the link one word so it never wraps: the tie goes below.
        await showDocument(`Above the paragraph.\n\n${LONG}, ${LONG} then [linkedwords](https://example.com/limits) and more text after it, ${LONG.toLowerCase()}.\n\nBelow it.\n`, 'linkedwords');
        await clickBefore('linkedwords', 3);
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

    /** s5: the Formatting menu open, the pointer on Highlight: its preview card. */
    const s5 = async () => {
        await showDocument('Alpha beta gamma.\n', 'Alpha');
        await clickBefore('beta', 1);
        // From the keyboard: in a row narrower than its tools the face may stand past its visible end (wave 2 · #2 is the overflow).
        await page.focus('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector('.mep-menu[data-menu="formatting"]:not([hidden])', { timeout: 3000 });
        await page.hover('.mep-menu [data-action="mark"]');
        await delay(600);
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

    /** s7: the margin lane open, the caret in a link in a table cell, Shift+Enter refused: the hint and the bar. */
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

    test('s2: a link\'s bar on a second line goes below the link, at its start, never on the caret\'s line', async function () {
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

    test('s3a/s3b: a mouse selection in a note shows the bubble alone, below it; collapsed, the note\'s bar after a rest, the bubble gone', async function () {
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
        await page.keyboard.down('Shift');
        await page.keyboard.down('Control');
        await page.keyboard.press('End');
        await page.keyboard.up('Control');
        await page.keyboard.up('Shift');
        await delay(REST_MS + 200);
        await page.evaluate(() => window.scrollTo(0, (document.scrollingElement as Element).scrollHeight / 3));
        await delay(200);
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

    test('s4: the row\'s Attributes… and Insert → Link… fields open at the caret, under its line', async function () {
        this.timeout(15000);
        await s4();
        const field = await box(ROW_FIELD);
        // The caret as it was: the field holds the focus now, the selection stays in the state.
        const at = await page.evaluate(() => {
            const range = document.createRange();
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror blockquote') as HTMLElement, NodeFilter.SHOW_TEXT);
            const node = walker.nextNode() as Text;
            const i = (node.textContent ?? '').indexOf('words that') + 2;
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const r = range.getBoundingClientRect();
            return { left: r.left, bottom: r.bottom };
        });
        assert.ok(field);
        assert.ok(Math.abs(field.left - at.left) <= 2, `at the caret's x: ${JSON.stringify({ field, at })}`);
        assert.ok(Math.abs(field.top - (at.bottom + GAP)) <= 2, `under the caret's line: ${JSON.stringify({ field, at })}`);
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
            const entry = await box('.mep-menu [data-action="mark"]');
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
        await s5();
        const low = { card: await box(CARD), menu: await box('.mep-menu[data-menu="formatting"]') };
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

    test('s7: with the lane open the bar and the hint stop short of it; the hint flips above the caret\'s line, and a keystroke takes it', async function () {
        this.timeout(15000);
        await s7();
        const lane = await page.evaluate(() => {
            const body = getComputedStyle(document.body);
            const column = document.body.getBoundingClientRect().right - (parseFloat(body.paddingRight) || 0);
            const gaps = ['--md-note-gap', '--md-sidebar-gap'].map(n => parseFloat(body.getPropertyValue(n))).filter(n => !isNaN(n));
            return column + (gaps.length > 0 ? Math.min(...gaps) : 0);
        });
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
            (document.querySelector('.mep-editor') as HTMLElement).dispatchEvent(new Event('mep-chrome-moved'));
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

    // -- shots ----------------------------------------------------------------

    test('shots: every scenario light and dark at 1280 and 520', async function () {
        this.timeout(240000);
        const scenarios: [string, () => Promise<void>][] = [
            ['s1', s1], ['s2', s2], ['s3a', s3a], ['s3b', async () => {
                await s3a();
                await clickBefore('reference words', 4);
                await waitBar();
            }], ['s3m', s3m], ['s4', s4], ['s5', s5], ['s6', s6], ['s7', s7], ['t6-cue', t6],
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
