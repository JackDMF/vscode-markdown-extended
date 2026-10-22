import * as assert from 'assert';
import * as fs from 'fs';
import * as puppeteer from 'puppeteer';
import * as vscode from 'vscode';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { closeEditorPage, delay, editCommand, EditorPage, EXTENSION_ID, MOD, openEditorPage, settle, shot, SHOTS_DIR, UNDO } from './pageHarness';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** A paragraph holding a footnote reference (a source block), words around it, and the footnote's text (another). */
const FOOTNOTE = [
    'Intro paragraph.',
    '',
    'A sentence with a footnote.[^1]',
    '',
    'Outro paragraph.',
    '',
    '[^1]: The footnote body.',
    '',
].join('\n');

/**
 * A source block selected as a whole (a click on it, as a person does) and a
 * key that would replace or remove a selection: the block is not edited as
 * text, so the key is refused at the block, never a silent loss.
 */
suite('Editor source block, selected, against typing over it (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const showDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await delay(100);
    };

    /** Click the footnote paragraph's source block: it is selected as a node. */
    const selectFootnoteBlock = async () => {
        await showDocument(FOOTNOTE);
        const box = await (await page.waitForSelector('.ProseMirror > .mep-raw-block .mep-atom-content'))?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + 20, box.y + box.height / 2);
        await delay(120);
        assert.ok(await page.$('.ProseMirror > .mep-raw-block.ProseMirror-selectednode'), 'the click selected the block');
    };

    /** After the key: no edit changed the file, the block still stands, nothing typed is left in the page, the refusal stands at it. */
    const assertRefused = async (before: number, what: string, typed = '') => {
        await settle();
        const edits = await (editor as EditorPage).edits();
        const changed = edits.slice(before).filter(e => e.text !== FOOTNOTE);
        assert.deepStrictEqual(changed.map(e => e.text), [], `${what}: the file is not changed`);
        assert.strictEqual(await page.$$eval('.ProseMirror > .mep-raw-block', els => els.length), 2, `${what}: both source blocks stand`);
        if (typed) {
            assert.ok(!(await page.$eval('.ProseMirror', el => el.textContent ?? '')).includes(typed), `${what}: nothing typed stands in the page`);
        }
        const hint = await page.$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden, tone: (el as HTMLElement).dataset.tone }));
        assert.deepStrictEqual(hint, { text: 'This paragraph holds a footnote — Edit source to change it', shown: true, tone: 'refusal' }, `${what}: the refusal says why`);
    };

    /** The caret at the start or the end of the `n`th top-level paragraph (1-based), by a click there. */
    const caretAt = async (n: number, end: 'start' | 'end') => {
        const box = await (await page.$(`.ProseMirror > p:nth-of-type(${n})`))?.boundingBox();
        assert.ok(box);
        await page.mouse.click(end === 'start' ? box.x + 1 : box.x + box.width - 2, box.y + box.height / 2);
        await delay(120);
    };

    /** Press `key` with `modifier` held. */
    const chord = async (modifier: puppeteer.KeyInput, key: puppeteer.KeyInput) => {
        await page.keyboard.down(modifier);
        await page.keyboard.press(key);
        await page.keyboard.up(modifier);
    };

    const undo = async () => {
        await page.keyboard.down(MOD);
        await page.keyboard.press('z');
        await page.keyboard.up(MOD);
        await settle();
    };

    const sourceBlocks = () => page.$$eval('.ProseMirror > .mep-raw-block', els => els.length);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('a character typed over it is refused', async function () {
        this.timeout(10000);
        await selectFootnoteBlock();
        const before = (await (editor as EditorPage).edits()).length;
        await page.keyboard.type('x');
        await assertRefused(before, 'typed x');
    });

    for (const key of ['Backspace', 'Delete'] as const) {
        test(`${key} on it is refused`, async function () {
            this.timeout(10000);
            await selectFootnoteBlock();
            const before = (await (editor as EditorPage).edits()).length;
            await page.keyboard.press(key);
            await assertRefused(before, key);
        });
    }

    test('a paste over it is refused', async function () {
        this.timeout(10000);
        await selectFootnoteBlock();
        const before = (await (editor as EditorPage).edits()).length;
        await page.evaluate(() => {
            const data = new DataTransfer();
            data.setData('text/plain', 'Pasted words');
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        });
        await assertRefused(before, 'paste');
    });

    // The keys that delete without being Backspace or Delete: macOS's Emacs-style ones (`macBaseKeymap`).
    for (const [modifier, key] of [['Control', 'd'], ['Control', 'h'], ['Alt', 'd']] as [puppeteer.KeyInput, puppeteer.KeyInput][]) {
        test(`${modifier}+${key.toUpperCase()} on it is refused`, async function () {
            this.timeout(10000);
            await selectFootnoteBlock();
            const before = (await (editor as EditorPage).edits()).length;
            await chord(modifier, key);
            await assertRefused(before, `${modifier}+${key}`);
        });
    }

    test('text put in without a key (dictation, the emoji picker, a text replacement) is refused', async function () {
        this.timeout(10000);
        await selectFootnoteBlock();
        const before = (await (editor as EditorPage).edits()).length;
        await page.keyboard.sendCharacter('Ω');
        await assertRefused(before, 'sendCharacter', 'Ω');
    });

    test('an input method\'s composition over it is refused', async function () {
        this.timeout(10000);
        await selectFootnoteBlock();
        const before = (await (editor as EditorPage).edits()).length;
        const cdp = await page.createCDPSession();
        try {
            await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
            await delay(60);
            await cdp.send('Input.insertText', { text: 'かな' });
        } finally {
            await cdp.detach();
        }
        await assertRefused(before, 'IME', 'か');
        await delay(100);
        assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 'the editor has the focus back');
        assert.ok(await page.$('.ProseMirror > .mep-raw-block.ProseMirror-selectednode'), 'the block is still selected');
    });

    test('cut takes it, onto the clipboard, and undo brings it back', async function () {
        this.timeout(10000);
        await selectFootnoteBlock();
        await page.keyboard.down(MOD);
        await page.keyboard.press('x', editCommand('x'));
        await page.keyboard.up(MOD);
        await settle();
        assert.strictEqual(await sourceBlocks(), 1, 'the block is cut');
        assert.ok(!(await (editor as EditorPage).edits()).pop()?.text.includes('A sentence with a footnote'), 'the file no longer holds it');
        await undo();
        assert.strictEqual((await (editor as EditorPage).edits()).pop()?.text, FOOTNOTE, 'undo brings it back');
        assert.strictEqual(await sourceBlocks(), 2);
    });

    test('a text selection across it is replaced as usual, and says the block went, with the key that brings it back', async function () {
        this.timeout(10000);
        await showDocument(FOOTNOTE);
        const intro = await (await page.$('.ProseMirror > p:nth-of-type(1)'))?.boundingBox();
        const outro = await (await page.$('.ProseMirror > p:nth-of-type(2)'))?.boundingBox();
        assert.ok(intro && outro);
        await page.mouse.click(intro.x + 30, intro.y + intro.height / 2);
        await page.keyboard.down('Shift');
        await page.mouse.click(outro.x + 30, outro.y + outro.height / 2);
        await page.keyboard.up('Shift');
        await delay(100);
        await page.keyboard.type('y');
        await settle();
        assert.strictEqual(await sourceBlocks(), 1, 'the block went with the selection');
        const hint = await page.$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden, tone: (el as HTMLElement).dataset.tone }));
        assert.deepStrictEqual(hint, { text: `Source block removed — ${UNDO}`, shown: true, tone: 'neutral' });
        await undo();
        assert.strictEqual((await (editor as EditorPage).edits()).pop()?.text, FOOTNOTE, 'undo brings it back');
    });

    test('a paste of one source block over a selection holding another says the other went, and undo brings it back', async function () {
        this.timeout(10000);
        const two = [
            'Para one.', '', 'Alpha holds one.[^1]', '', 'Para two here.', '', 'Beta holds two.[^2]', '', 'Para three here.', '',
            '[^1]: n1', '[^2]: n2', '',
        ].join('\n');
        await showDocument(two);
        const alpha = await (await page.$('.ProseMirror > .mep-raw-block .mep-atom-content'))?.boundingBox();
        assert.ok(alpha);
        await page.mouse.click(alpha.x + 20, alpha.y + alpha.height / 2);
        await delay(120);
        const clip = await page.evaluate(() => {
            const data = new DataTransfer();
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
            return { html: data.getData('text/html'), text: data.getData('text/plain') };
        });
        assert.ok(clip.html.includes('Alpha holds one'), 'the copy holds Alpha');
        // From "Para two" across Beta to "Para three": the block's bar stands over the paragraph below it, so the selection is made in the page.
        await page.evaluate(() => {
            const text = (n: number) => (document.querySelector(`.ProseMirror > p:nth-of-type(${n})`) as HTMLElement).firstChild as Text;
            window.getSelection()?.setBaseAndExtent(text(2), 5, text(3), 5);
        });
        await delay(150);
        await page.evaluate(c => {
            const data = new DataTransfer();
            data.setData('text/html', c.html);
            data.setData('text/plain', c.text);
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, clip);
        await settle();
        assert.ok(!(await (editor as EditorPage).edits()).pop()?.text.includes('Beta holds two'), 'Beta went with the selection');
        const hint = await page.$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden, tone: (el as HTMLElement).dataset.tone }));
        assert.deepStrictEqual(hint, { text: `Source block removed — ${UNDO}`, shown: true, tone: 'neutral' });
        await undo();
        assert.strictEqual((await (editor as EditorPage).edits()).pop()?.text, two, 'undo brings Beta back');
    });

    test('Backspace at the start of the paragraph after it selects it; a second Backspace is refused', async function () {
        this.timeout(10000);
        await showDocument(FOOTNOTE);
        const before = (await (editor as EditorPage).edits()).length;
        await caretAt(2, 'start');
        await page.keyboard.press('Backspace');
        await settle();
        assert.ok(await page.$('.ProseMirror > .mep-raw-block.ProseMirror-selectednode'), 'the first press selects the block');
        assert.strictEqual(await sourceBlocks(), 2, 'and deletes nothing');
        await page.keyboard.press('Backspace');
        await assertRefused(before, 'second Backspace');
    });

    test('Delete at the end of the paragraph before it selects it; a second Delete is refused', async function () {
        this.timeout(10000);
        await showDocument(FOOTNOTE);
        const before = (await (editor as EditorPage).edits()).length;
        await caretAt(1, 'end');
        await page.keyboard.press('Delete');
        await settle();
        assert.ok(await page.$('.ProseMirror > .mep-raw-block.ProseMirror-selectednode'), 'the first press selects the block');
        assert.strictEqual(await sourceBlocks(), 2, 'and deletes nothing');
        await page.keyboard.press('Delete');
        await assertRefused(before, 'second Delete');
    });

    test('Delete block in its bar still deletes it, and undo brings it back', async function () {
        this.timeout(10000);
        await selectFootnoteBlock();
        const verb = await page.waitForSelector(`${SELECTED_BLOCK_BAR} [data-verb="delete-block"]`, { visible: true, timeout: 3000 });
        const at = await verb?.boundingBox();
        assert.ok(at);
        await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
        await settle();
        assert.strictEqual(await sourceBlocks(), 1);
        await undo();
        assert.strictEqual((await (editor as EditorPage).edits()).pop()?.text, FOOTNOTE);
    });

    test('Enter on it does what it did before the marker: a new paragraph after the block', async function () {
        this.timeout(10000);
        await selectFootnoteBlock();
        await page.keyboard.press('Enter');
        await page.keyboard.type('New');
        await settle();
        const last = (await (editor as EditorPage).edits()).pop();
        assert.strictEqual(last?.text, FOOTNOTE.replace('[^1]\n\n', '[^1]\n\nNew\n\n'));
    });
});

/** Source blocks of each placement: a footnote paragraph (float), a definition list, one with a right sidebar (chip top-left above its first line), the footnotes' text (in its box). */
const MARKED = [
    'Intro paragraph.',
    '',
    'A sentence with a footnote.[^1] And enough words after it to run onto a second line where the window is narrow, so the wrap around the chip shows on the first one and not on the next. It says so twice over, at length, so that even a wide window gives it three lines to wrap.',
    '',
    'Term',
    ': Its definition, a pass over every file that reports what it finds.',
    '',
    'A note @10 min@ beside a footnote.[^2]',
    '',
    'Outro paragraph.',
    '',
    '[^1]: The footnote body.',
    '[^2]: The second body.',
    '',
].join('\n');

/** 16 paragraphs, each with a footnote reference, between plain ones: how a footnoted document looks with a chip on each. */
function clutterDocument(): string {
    const out: string[] = ['# A footnoted chapter', ''];
    for (let i = 1; i <= 16; i++) {
        out.push(`Paragraph ${i} states a finding and cites where it comes from.[^n${i}] It goes on for a sentence or two, as prose does, so the lines wrap at the window's width.`, '');
        if (i % 4 === 0) {
            out.push(`A plain paragraph between them, number ${i / 4}, with no reference at all.`, '');
        }
    }
    for (let i = 1; i <= 16; i++) {
        out.push(`[^n${i}]: Source ${i}: the minutes of the review.`);
    }
    return out.join('\n') + '\n';
}

const SELECTED_BLOCK_BAR = '.mep-object-toolbar[data-trigger="selection"][data-object="raw_block"]:not([hidden])';

/** The editor page showing documents, with what its suites share. */
function sourcePage(options: Parameters<typeof openEditorPage>[0]) {
    const state = { editor: undefined as EditorPage | undefined, page: undefined as unknown as puppeteer.Page, version: 0 };
    const show = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        state.version++;
        await state.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await (state.editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version: state.version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await delay(150);
        // Numbered for the tests (`block`): an atom's own DOM, which ProseMirror leaves alone.
        await state.page.evaluate(() => {
            document.querySelectorAll('.ProseMirror > .mep-raw-block').forEach((el, i) => el.setAttribute('data-test-n', String(i)));
            window.scrollTo(0, 0);
        });
    };
    const open = async (hook: Mocha.Context) => {
        hook.timeout(60000);
        state.editor = await openEditorPage(options);
        if (!state.editor) {
            hook.skip();
        }
        state.page = (state.editor as EditorPage).page;
    };
    return { state, show, open };
}

/** The `n`th top-level source block (0-based). */
const block = (n: number) => `.ProseMirror > .mep-raw-block[data-test-n="${n}"]`;

/** The chip of a source block (`sourceChip`, nodeViews.ts). */
const CHIP = ':scope > .mep-raw-rail > .mep-raw-chip';

/** Where the top-left chip of a block above its first line stands, against the block, the element before it and the note. */
function aboveChipGeometry(page: puppeteer.Page, sel: string) {
    return page.$eval(sel, (el, chipSel) => {
        const chip = (el.querySelector(chipSel) as HTMLElement).getBoundingClientRect();
        const b = el.getBoundingClientRect();
        const previous = (el.previousElementSibling as HTMLElement).getBoundingClientRect();
        const note = el.querySelector('.right-sidebar') as HTMLElement | null;
        const stub = getComputedStyle(el.querySelector(chipSel) as HTMLElement, '::after');
        return {
            chip: { left: chip.left, top: chip.top, right: chip.right, bottom: chip.bottom },
            blockTop: b.top,
            blockLeft: b.left,
            previousBottom: previous.bottom,
            noteLeft: note ? note.getBoundingClientRect().left : Infinity,
            stub: { style: stub.borderLeftStyle, reaches: chip.bottom + parseFloat(stub.height) > b.top },
        };
    }, CHIP);
}

/** WCAG contrast of the chip's text colour, as the page composites it, on the page behind the block `sel`. */
function chipContrast(page: puppeteer.Page, sel: string) {
    return page.$eval(sel, (el, chipSel) => {
        const s = getComputedStyle(el.querySelector(chipSel) as HTMLElement);
        const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D;
        const rgba = (css: string): number[] => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = css;
            ctx.fillRect(0, 0, 1, 1);
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return [d[0], d[1], d[2], d[3] / 255];
        };
        const over = (top: number[], under: number[]) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat([1]);
        // The page behind: the outermost background that paints, the editor's own where none does.
        const layers: number[][] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
            const c = rgba(getComputedStyle(n).backgroundColor);
            if (c[3] > 0) {
                layers.push(c);
            }
        }
        const editorBg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
        let bg = rgba(editorBg || 'white');
        bg[3] = 1;
        for (const c of layers.reverse()) {
            bg = over(c, bg);
        }
        const fg = over(rgba(s.color), bg);
        const lum = (c: number[]) => {
            const [r, g, b] = c.slice(0, 3).map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const [a, b] = [lum(fg), lum(bg)];
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }, CHIP);
}

/** A `$…$` sidebar (`span.left-sidebar`) on the first line of a source block, and on a plain paragraph to compare. */
const SIDEBAR = [
    '## A heading',
    '',
    '$10:00$ A plain paragraph with its time in the left sidebar, and words enough to wrap at a narrow width.',
    '',
    '$10:05$ A sentence with a footnote.[^1] And words enough after it to run onto a second line, so the chip and the sidebar share the first one.',
    '',
    'Outro paragraph.',
    '',
    '[^1]: The footnote body.',
    '',
].join('\n');

/** A block whose rendering starts with a box of its own (a table): a float would narrow it or push it down. */
const BOXED_FIRST = ['Before it.', '', '<table><tr><td>A cell</td><td>Another cell</td></tr></table>', '', 'After it.', ''].join('\n');

/** A tall box of footnote text, between paragraphs: its chip stays in sight while its top is scrolled away. */
function tallBoxDocument(): string {
    const notes = Array.from({ length: 40 }, (_, i) => `[^t${i + 1}]: Footnote ${i + 1}, the minutes of the review.`);
    return ['Words before.[^t1]', '', ...notes, '', 'Words after.', ''].join('\n');
}

/** A 60-item list with a footnote on each item: one tall, rendered source block, its top far above where a person reads. */
function tallListDocument(): string {
    const items = Array.from({ length: 60 }, (_, i) => `- Item ${i + 1} of the list, stating a finding.[^l${i + 1}]`);
    const notes = Array.from({ length: 60 }, (_, i) => `[^l${i + 1}]: The minutes, item ${i + 1}.`);
    return ['Words before.', '', ...items, '', 'Words after.', '', ...notes, ''].join('\n');
}

suite('Editor source block marker (e2e)', () => {
    const { state, show, open } = sourcePage({ width: 1280, height: 900, styles: ['markdown-extended.css'] });
    const page = () => state.page;

    /** The chip of the block `sel`: its word, where it stands, and that nothing reaches it. */
    const chip = (sel: string) => page().$eval(sel, (el, chipSel) => {
        const c = el.querySelector(chipSel) as HTMLElement | null;
        if (!c) {
            return null;
        }
        const s = getComputedStyle(c);
        const rail = getComputedStyle(c.parentElement as HTMLElement);
        return {
            content: getComputedStyle(c, '::before').content,
            hidden: (c.parentElement as HTMLElement).getAttribute('aria-hidden'),
            display: rail.display,
            float: rail.float,
            position: rail.position,
            userSelect: rail.userSelect,
            pointerEvents: rail.pointerEvents,
            background: s.backgroundColor,
            border: s.borderTopStyle,
        };
    }, CHIP);

    suiteSetup(async function () {
        await open(this);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, state.editor);
    });

    test('every source block names itself: a group, "source block", and as its label only why — has a footnote, definition list, footnote text', async function () {
        this.timeout(10000);
        await show(MARKED);
        const names = await page().$$eval('.ProseMirror > .mep-raw-block', els => els.map(el => [el.getAttribute('role'), el.getAttribute('aria-roledescription'), el.getAttribute('aria-label')]));
        assert.deepStrictEqual(names, [
            ['group', 'source block', 'Has a footnote'],
            ['group', 'source block', 'Definition list'],
            ['group', 'source block', 'Has a footnote'],
            ['group', 'source block', 'Footnote text'],
        ]);
    });

    test('a paragraph-like block floats the chip top-right: "source", hidden from a screen reader, not selectable, no pointer; the first line wraps around it', async function () {
        this.timeout(10000);
        await show(MARKED);
        const c = await chip(block(0));
        assert.ok(c);
        assert.deepStrictEqual(c, { ...c, content: '"source" / ""', hidden: 'true', float: 'right', userSelect: 'none', pointerEvents: 'none', border: 'dashed' });
        // The first line ends short of the chip; the second runs to the block's edge.
        const lines = await page().$eval(block(0), el => {
            const p = el.querySelector('p') as HTMLElement;
            const range = document.createRange();
            range.selectNodeContents(p);
            const rects = Array.from(range.getClientRects());
            const top = rects[0].top;
            const right = (t: number) => Math.max(...rects.filter(r => Math.abs(r.top - t) < 2).map(r => r.right));
            return { block: el.getBoundingClientRect().right, first: right(top), rest: Math.max(...rects.filter(r => r.top > top + 4).map(r => r.right)) };
        });
        assert.ok(lines.block - lines.first > 50, `the first line leaves the chip its room: ${JSON.stringify(lines)}`);
        assert.ok(lines.rest > lines.first, `a later line runs past it: ${JSON.stringify(lines)}`);
    });

    test('a copy holds no chip: the clipboard of a real copy event has neither its word nor its element', async function () {
        this.timeout(10000);
        await show(MARKED);
        await page().evaluate(() => {
            document.addEventListener('copy', e => {
                (window as unknown as { copied: unknown }).copied = { html: e.clipboardData?.getData('text/html') ?? '', text: e.clipboardData?.getData('text/plain') ?? '' };
            }, { once: true });
        });
        const box = await (await page().$('.ProseMirror > p'))?.boundingBox();
        assert.ok(box);
        await page().mouse.click(box.x + 5, box.y + box.height / 2);
        await page().keyboard.down(MOD);
        await page().keyboard.press('a', editCommand('a'));
        await page().keyboard.press('c', editCommand('c'));
        await page().keyboard.up(MOD);
        await delay(150);
        const copied = await page().evaluate(() => (window as unknown as { copied?: { html: string; text: string } }).copied);
        assert.ok(copied && copied.html.includes('A sentence with a footnote') && copied.html.includes('Term'), `the copy holds the source blocks: ${JSON.stringify(copied)}`);
        assert.ok(!/source/.test(copied.text) && !/mep-raw-chip|mep-raw-rail|>source</.test(copied.html), `and no chip: ${JSON.stringify(copied)}`);
    });

    test('a person\'s own ::after label on the first element of a source block stays theirs', async function () {
        this.timeout(10000);
        const own = await page().addStyleTag({ content: '.ProseMirror p::after { content: " (own)"; } .ProseMirror p::before { content: "» "; }' });
        try {
            await show(MARKED);
            for (const n of [0, 2]) {
                const pseudo = await page().$eval(`${block(n)} p`, el => [getComputedStyle(el, '::before').content, getComputedStyle(el, '::after').content]);
                assert.deepStrictEqual(pseudo, ['"» "', '" (own)"'], `block ${n}`);
            }
        } finally {
            await own.evaluate(el => el.remove());
        }
    });

    test('source shown as source has the chip inside its box, top-right, in room the box keeps free', async function () {
        this.timeout(10000);
        await show(MARKED);
        const c = await chip(block(3));
        assert.ok(c);
        assert.deepStrictEqual([c.content, c.position, c.float], ['"source" / ""', 'absolute', 'none']);
        const box = await page().$eval(block(3), (el, chipSel) => {
            const pre = el.querySelector('pre.mep-raw-source') as HTMLElement;
            const r = pre.getBoundingClientRect();
            const chipBox = (el.querySelector(chipSel) as HTMLElement).getBoundingClientRect();
            return { preTop: r.top, chipTop: chipBox.top, chipRight: chipBox.right, preRight: r.right, padRight: parseFloat(getComputedStyle(pre).paddingRight) };
        }, CHIP);
        assert.ok(box.chipTop >= box.preTop && box.chipRight <= box.preRight, `inside the box: ${JSON.stringify(box)}`);
        assert.ok(box.padRight >= 60, `the box keeps room for it: ${JSON.stringify(box)}`);
    });

    test('a tall box keeps its chip in sight under the toolbar while its top is scrolled away, within the box', async function () {
        this.timeout(10000);
        await page().setViewport({ width: 1280, height: 400 });
        try {
            await show(tallBoxDocument());
            const n = await page().$$eval('.ProseMirror > .mep-raw-block', els => els.findIndex(el => el.classList.contains('mep-raw-boxed')));
            const top = await page().$eval(block(n), el => el.getBoundingClientRect().top + window.scrollY);
            await page().evaluate(y => window.scrollTo(0, y), top + 200);
            await delay(100);
            const g = await page().$eval(block(n), (el, chipSel) => {
                const c = (el.querySelector(chipSel) as HTMLElement).getBoundingClientRect();
                const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
                const b = el.getBoundingClientRect();
                return { chipTop: c.top, rowBottom: row.bottom, blockTop: b.top, blockBottom: b.bottom };
            }, CHIP);
            assert.ok(g.blockTop < g.rowBottom, `the box's top is scrolled away: ${JSON.stringify(g)}`);
            assert.ok(g.chipTop >= g.rowBottom && g.chipTop <= g.rowBottom + 8, `the chip stands right under the row: ${JSON.stringify(g)}`);
        } finally {
            await page().setViewport({ width: 1280, height: 900 });
        }
    });

    /** Where the chip of block `n` stands against the toolbar row, the viewport, the block, and every rendered line of text. */
    const stickyGeometry = (n: number) => page().$eval(block(n), (el, chipSel) => {
        const c = (el.querySelector(chipSel) as HTMLElement).getBoundingClientRect();
        const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
        const b = el.getBoundingClientRect();
        let covered = 0;
        const walker = document.createTreeWalker(el.querySelector('.mep-atom-content') as HTMLElement, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(t);
            for (const r of Array.from(range.getClientRects())) {
                covered += r.left < c.right - 0.5 && r.right > c.left + 0.5 && r.top < c.bottom - 0.5 && r.bottom > c.top + 0.5 && r.width > 0 ? 1 : 0;
            }
        }
        return {
            tall: el.classList.contains('mep-raw-tall'),
            chip: { top: c.top, right: c.right, left: c.left, bottom: c.bottom },
            rowBottom: row.bottom,
            blockTop: b.top,
            blockBottom: b.bottom,
            blockRight: b.right,
            viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
            covered,
            scrollWidth: document.documentElement.scrollWidth,
        };
    }, CHIP);

    test('a tall rendered block keeps its chip in sight under the toolbar while its top is scrolled away, in a gutter that covers no text', async function () {
        this.timeout(20000);
        await page().setViewport({ width: 1280, height: 500 });
        try {
            await show(tallListDocument());
            await delay(250);
            const at = await stickyGeometry(0);
            assert.ok(at.tall, `the 60-line list is tall: ${JSON.stringify(at)}`);
            assert.ok(at.chip.top - at.blockTop < 8 && at.chip.right <= at.blockRight && at.covered === 0, `at rest the chip is at the block's top-right, over no text: ${JSON.stringify(at)}`);
            const top = await page().$eval(block(0), el => el.getBoundingClientRect().top + window.scrollY);
            for (const down of [300, 700, 1100]) {
                await page().evaluate(y => window.scrollTo(0, y), top + down);
                await delay(100);
                const g = await stickyGeometry(0);
                assert.ok(g.blockTop < g.rowBottom && g.blockBottom > g.chip.bottom, `the block's top is scrolled away, its bottom is below the chip: ${JSON.stringify(g)}`);
                assert.ok(g.chip.top >= g.rowBottom && g.chip.top <= g.rowBottom + 8, `${down}: the chip stands right under the row: ${JSON.stringify(g)}`);
                assert.ok(g.chip.bottom <= g.viewport.height && g.chip.right <= g.viewport.width && g.scrollWidth <= g.viewport.width, `${down}: within the viewport, no sideways scroll: ${JSON.stringify(g)}`);
                assert.ok(g.chip.right <= g.blockRight, `${down}: inside the block's own gutter: ${JSON.stringify(g)}`);
                assert.strictEqual(g.covered, 0, `${down}: over no line of text: ${JSON.stringify(g)}`);
            }
            await page().evaluate(() => window.scrollTo(0, 0));
        } finally {
            await page().setViewport({ width: 1280, height: 900 });
        }
    });

    test('a block that is not tall, or has a note at its right, keeps its chip as it was: not sticky', async function () {
        this.timeout(10000);
        await show(MARKED);
        for (const n of [0, 2]) {
            assert.strictEqual(await page().$eval(block(n), el => el.classList.contains('mep-raw-tall')), false, `block ${n}`);
        }
        assert.strictEqual(await page().$eval(`${block(0)} .mep-raw-chip`, el => getComputedStyle(el).position), 'relative');
        const rest = await stickyGeometry(2);
        assert.ok(rest.chip.bottom <= rest.blockTop, `the noted block's chip stays above it: ${JSON.stringify(rest)}`);
    });

    test('a block whose note floats at the right keeps the note on its line: the chip stands above the block, top-left, with a stub on its edge', async function () {
        this.timeout(10000);
        await show(MARKED);
        assert.ok(await page().$eval(block(2), el => el.classList.contains('mep-raw-above')));
        const c = await chip(block(2));
        assert.ok(c);
        assert.deepStrictEqual([c.content, c.position, c.float, c.pointerEvents, c.userSelect], ['"source" / ""', 'absolute', 'none', 'none', 'none']);
        const tops = await page().$eval(block(2), el => ({
            note: (el.querySelector('.right-sidebar') as HTMLElement).getBoundingClientRect().top,
            p: (el.querySelector('p') as HTMLElement).getBoundingClientRect().top,
        }));
        assert.ok(Math.abs(tops.note - tops.p) < 2, `the note is not pushed down: ${JSON.stringify(tops)}`);
        for (const [theme, name] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as [Theme, string][]) {
            await applyTheme(page(), theme);
            await show(MARKED);
            const g = await aboveChipGeometry(page(), block(2));
            const gap = g.blockTop - g.chip.bottom;
            assert.ok(gap >= 0 && gap <= 4, `${name}: at most 4px above the block: ${JSON.stringify(g)}`);
            assert.ok(g.chip.top - g.previousBottom >= 8, `${name}: at least 8px below the element before: ${JSON.stringify(g)}`);
            assert.ok(Math.abs(g.chip.left - g.blockLeft) < 1.5, `${name}: its left edge on the block's: ${JSON.stringify(g)}`);
            assert.deepStrictEqual(g.stub, { style: 'dashed', reaches: true }, `${name}: a dashed stub down to the block's edge`);
            assert.ok(g.chip.right <= g.noteLeft, `${name}: it stands left of the note, which it neither covers nor displaces: ${JSON.stringify(g)}`);
        }
        await applyTheme(page(), LIGHT_MODERN);
    });

    test('a block whose rendering starts with a box of its own (a table) has the chip above it, the table neither narrowed nor pushed down', async function () {
        this.timeout(10000);
        await show(BOXED_FIRST);
        assert.ok(await page().$eval(block(0), el => el.classList.contains('mep-raw-above')));
        const g = await page().$eval(block(0), el => {
            const b = el.getBoundingClientRect();
            const t = (el.querySelector('table') as HTMLElement).getBoundingClientRect();
            return { blockTop: b.top, tableTop: t.top, blockLeft: b.left, tableLeft: t.left };
        });
        assert.ok(g.tableTop - g.blockTop < 4 && g.tableLeft - g.blockLeft < 12, `the table starts at the block's top-left: ${JSON.stringify(g)}`);
        const a = await aboveChipGeometry(page(), block(0));
        assert.ok(a.chip.bottom <= a.blockTop && a.chip.top - a.previousBottom >= 8, JSON.stringify(a));
    });

    test('the chip is legible in the page\'s own colours: at least 4.5:1 in Light, Dark and High Contrast, on each placement', async function () {
        this.timeout(20000);
        const found: string[] = [];
        for (const [theme, name] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark'], [HC_DARK, 'hc']] as [Theme, string][]) {
            await applyTheme(page(), theme);
            await show(MARKED);
            for (const [n, what] of [[0, 'float'], [2, 'top-left'], [3, 'in the box']] as [number, string][]) {
                const ratio = await chipContrast(page(), block(n));
                found.push(`${name} ${what} ${ratio.toFixed(2)}`);
                assert.ok(ratio >= 4.5, `${name}, ${what}: ${ratio.toFixed(2)}:1`);
            }
        }
        console.log('chip contrast (default sheets): ' + found.join('; '));
        await applyTheme(page(), LIGHT_MODERN);
    });

    test('the chip takes no hover tint (#11: no tint on what is no control)', async function () {
        this.timeout(10000);
        await show(MARKED);
        const rest = await chip(block(0));
        const box = await (await page().$(block(0)))?.boundingBox();
        assert.ok(box && rest);
        await page().mouse.move(box.x + 30, box.y + box.height / 2);
        await delay(300);
        assert.strictEqual((await chip(block(0)))?.background, rest.background);
        await page().mouse.move(5, 5);
    });

    test('selected: the bar says "Source · has a footnote", a screen reader hears the reason and the key, nothing more is drawn', async function () {
        this.timeout(10000);
        await show(MARKED);
        const box = await (await page().$(`${block(0)} .mep-atom-content`))?.boundingBox();
        assert.ok(box);
        await page().mouse.click(box.x + 20, box.y + 8);
        await page().waitForSelector(`${SELECTED_BLOCK_BAR} .mep-object-label`);
        assert.strictEqual(await page().$eval(`${SELECTED_BLOCK_BAR} .mep-object-label`, el => el.textContent), 'Source · has a footnote');
        const said = await page().$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden, quiet: el.hasAttribute('data-quiet'), role: el.getAttribute('role'), width: el.getBoundingClientRect().width }));
        assert.deepStrictEqual(said, { text: 'Source block, has a footnote — Alt+Enter for actions', shown: true, quiet: true, role: 'status', width: 1 });

        const dl = await (await page().$(`${block(1)} .mep-atom-content`))?.boundingBox();
        assert.ok(dl);
        // Low in the list: the footnote's bar stands below its block, over the list's top.
        await page().mouse.click(dl.x + 20, dl.y + dl.height - 6);
        await delay(150);
        assert.strictEqual(await page().$eval(`${SELECTED_BLOCK_BAR} .mep-object-label`, el => el.textContent), 'Source · definition list');
        assert.strictEqual(await page().$eval('.mep-hint', el => el.textContent), 'Source block, definition list — Alt+Enter for actions');
    });

    test('an open source box has no chip over it', async function () {
        this.timeout(10000);
        await show(MARKED);
        const box = await (await page().$(`${block(0)} .mep-atom-content`))?.boundingBox();
        assert.ok(box);
        await page().mouse.click(box.x + 20, box.y + 8, { clickCount: 2 });
        await page().waitForSelector('.mep-raw-editor');
        assert.strictEqual((await chip(block(0)))?.display, 'none');
        await page().keyboard.press('Escape');
    });

    test('shots: rest, hover and caret at 1280 and 520 in light, dark and high contrast; a footnoted chapter in light and dark', async function () {
        if (!SHOTS_DIR) {
            return;
        }
        this.timeout(180000);
        const themes: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark'], [HC_DARK, 'hc']];
        try {
            for (const [theme, name] of themes) {
                await applyTheme(page(), theme);
                for (const width of [1280, 520]) {
                    await page().setViewport({ width, height: 760 });
                    await show(MARKED);
                    await shot(page(), `rest-${width}-${name}.png`);
                    const box = await (await page().$(`${block(0)} .mep-atom-content`))?.boundingBox();
                    assert.ok(box);
                    await page().mouse.move(box.x + 30, box.y + 8);
                    await delay(700);
                    await shot(page(), `hover-${width}-${name}.png`);
                    await page().mouse.click(box.x + 30, box.y + 8);
                    await delay(400);
                    await page().mouse.move(5, box.y + box.height + 300);
                    await delay(300);
                    await shot(page(), `caret-${width}-${name}.png`);
                }
            }
            for (const [theme, name] of themes.slice(0, 2)) {
                await applyTheme(page(), theme);
                await page().setViewport({ width: 1280, height: 2000 });
                await show(clutterDocument());
                await page().mouse.move(5, 5);
                await shot(page(), `clutter-1280-${name}.png`);
            }
            // A tall block, its top scrolled away: the chip stays under the toolbar row.
            for (const [theme, name] of themes.slice(0, 2)) {
                await applyTheme(page(), theme);
                await page().setViewport({ width: 1280, height: 600 });
                await show(tallListDocument());
                await delay(250);
                const top = await page().$eval(block(0), el => el.getBoundingClientRect().top + window.scrollY);
                await page().evaluate(y => window.scrollTo(0, y), top + 500);
                await page().mouse.move(5, 5);
                await delay(200);
                await shot(page(), `scroll-sticky-1280-${name}.png`);
            }
            // The refusal at the block: a character typed over a selected source block.
            for (const [theme, name] of themes) {
                await applyTheme(page(), theme);
                for (const width of [1280, 520]) {
                    await page().setViewport({ width, height: 760 });
                    await show(MARKED);
                    const box = await (await page().$(`${block(0)} .mep-atom-content`))?.boundingBox();
                    assert.ok(box);
                    await page().mouse.click(box.x + 30, box.y + 8);
                    await delay(300);
                    await page().mouse.move(5, box.y + box.height + 300);
                    await page().keyboard.type('x');
                    await delay(250);
                    await shot(page(), `refusal-${width}-${name}.png`);
                }
            }
            // What a screen reader is given, drawn in a caption: each block's role, role description and
            // label, the chip hidden, and what the status line says on selecting one.
            await applyTheme(page(), LIGHT_MODERN);
            await page().setViewport({ width: 1280, height: 900 });
            await show(MARKED);
            // The refusal of the shots before has had its time, and the caret leaves the block, so selecting it is news.
            await page().evaluate(() => { (document.querySelector('.mep-hint') as HTMLElement).hidden = true; });
            const intro = await (await page().$('.ProseMirror > p'))?.boundingBox();
            assert.ok(intro);
            await page().mouse.click(intro.x + 5, intro.y + intro.height / 2);
            await delay(200);
            const box = await (await page().$(`${block(0)} .mep-atom-content`))?.boundingBox();
            assert.ok(box);
            await page().mouse.click(box.x + 30, box.y + 8);
            await delay(300);
            await page().evaluate(() => {
                const said = document.querySelector('.mep-hint')?.textContent ?? '';
                const rows = Array.from(document.querySelectorAll('.ProseMirror > .mep-raw-block')).map(el => {
                    const rail = el.querySelector(':scope > .mep-raw-rail');
                    return `<${el.tagName.toLowerCase()} role="${el.getAttribute('role')}" aria-roledescription="${el.getAttribute('aria-roledescription')}" aria-label="${el.getAttribute('aria-label') ?? ''}"> — chip aria-hidden="${rail?.getAttribute('aria-hidden')}"`;
                });
                const caption = document.createElement('pre');
                caption.className = 'mep-test-caption';
                caption.textContent = ['What a screen reader is given (the page\'s accessibility attributes):', ...rows, '', `Status line on selecting the first block: "${said}"`].join('\n');
                caption.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;margin:0;padding:10px 12px;font:12px/18px monospace;white-space:pre-wrap;background:#fffbe6;color:#1f1f1f;border:1px solid #c8a400;border-radius:4px;z-index:100';
                document.body.append(caption);
            });
            await shot(page(), 'sr-1280-light.png');
            await page().evaluate(() => document.querySelector('.mep-test-caption')?.remove());
        } finally {
            await page().setViewport({ width: 1280, height: 900 });
            await applyTheme(page(), LIGHT_MODERN);
        }
    });
});

/**
 * The same marks under a person's own stylesheet (`MEP_USER_STYLES`, a path, loaded as `markdown.styles`
 * is), on a real document (`MEP_CLUTTER_DOC`): its notes and sidebars float at the right, and a chip must
 * never push one down or stand on it. Shots only, and only where both are given.
 */
suite('Editor source block marker under a user stylesheet (e2e)', () => {
    const userStyles = process.env.MEP_USER_STYLES;
    const realDoc = process.env.MEP_CLUTTER_DOC;
    const { state, show, open } = sourcePage({ width: 1280, height: 900, styles: ['markdown-extended.css', 'markdown-it-admonition.css', 'markdown-it-kbd.css'], userStyles: userStyles ? [userStyles] : [] });
    const page = () => state.page;

    suiteSetup(async function () {
        if (!userStyles || !fs.existsSync(userStyles)) {
            this.skip();
        }
        await open(this);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, state.editor);
    });

    test('on the person\'s own page the chip keeps 4.5:1 and a top-left chip stands clear of every note and of the text above', async function () {
        this.timeout(60000);
        const text = realDoc && fs.existsSync(realDoc) ? fs.readFileSync(realDoc, 'utf8') : clutterDocument();
        const found: string[] = [];
        try {
            for (const [theme, name] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as [Theme, string][]) {
                await applyTheme(page(), theme);
                await page().setViewport({ width: 1280, height: 2000 });
                for (const [label, doc] of [['marks', MARKED], ['real document', text]] as [string, string][]) {
                    await show(doc);
                    const count = await page().$$eval('.ProseMirror > .mep-raw-block', els => els.length);
                    let lowest = Infinity;
                    for (let n = 0; n < count; n++) {
                        lowest = Math.min(lowest, await chipContrast(page(), block(n)));
                    }
                    found.push(`${name} ${label} (${count} blocks) lowest ${lowest.toFixed(2)}`);
                    assert.ok(lowest >= 4.5, `${name}, ${label}: the lowest chip contrast is ${lowest.toFixed(2)}:1`);
                    const noted = await page().$$eval('.ProseMirror > .mep-raw-block.mep-raw-above', (els, chipSel) => els.flatMap(el => {
                        const c = el.querySelector(chipSel) as HTMLElement | null;
                        if (!c) {
                            return [];
                        }
                        const chip = c.getBoundingClientRect();
                        const meets = (r: DOMRect) => r.left < chip.right && r.right > chip.left && r.top < chip.bottom && r.bottom > chip.top;
                        const hits = Array.from(el.querySelectorAll('.sidenote, .mnote, .right-sidebar, .left-sidebar, img')).filter(n => meets(n.getBoundingClientRect())).map(n => n.outerHTML.slice(0, 60));
                        const range = document.createRange();
                        range.selectNodeContents(el.previousElementSibling as Element);
                        const above = Math.max(...Array.from(range.getClientRects()).map(r => r.bottom));
                        const covered = above > chip.top + 0.5 ? [`text above ends ${above.toFixed(1)}, chip starts ${chip.top.toFixed(1)}`] : [];
                        return [...hits, ...covered];
                    }), CHIP);
                    assert.deepStrictEqual(noted, [], `${name}, ${label}: nothing under a top-left chip`);
                }
            }
        } finally {
            await page().setViewport({ width: 1280, height: 900 });
            await applyTheme(page(), LIGHT_MODERN);
        }
        console.log('chip contrast (user stylesheet): ' + found.join('; '));
    });

    test('no note pushed down by a chip; shots of the marks and the real document in light and dark', async function () {
        if (!SHOTS_DIR) {
            this.skip();
        }
        this.timeout(180000);
        const text = realDoc && fs.existsSync(realDoc) ? fs.readFileSync(realDoc, 'utf8') : clutterDocument();
        try {
            for (const [theme, name] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as [Theme, string][]) {
                await applyTheme(page(), theme);
                for (const width of [1280, 520]) {
                    await page().setViewport({ width, height: 760 });
                    await show(MARKED);
                    await shot(page(), `user-rest-${width}-${name}.png`);
                    const box = await (await page().$(`${block(0)} .mep-atom-content`))?.boundingBox();
                    assert.ok(box);
                    await page().mouse.click(box.x + 30, box.y + 8);
                    await delay(400);
                    await page().mouse.move(5, box.y + box.height + 300);
                    await delay(300);
                    await shot(page(), `user-caret-${width}-${name}.png`);
                }
                await page().setViewport({ width: 1280, height: 2000 });
                await show(text);
                await page().mouse.move(5, 5);
                await shot(page(), `user-clutter-real-1280-${name}.png`);
                // Each note in a source block stands on its own reference's line, as it would with no chip.
                const pushed = await page().$$eval('.ProseMirror > .mep-raw-block', els => els.flatMap(el => {
                    const rail = el.querySelector(':scope > .mep-raw-rail') as HTMLElement | null;
                    if (!rail || getComputedStyle(rail).float !== 'right') {
                        return [];
                    }
                    return Array.from(el.querySelectorAll('.sidenote, .mnote, .right-sidebar, img')).filter(n => getComputedStyle(n).float === 'right').map(n => n.outerHTML.slice(0, 80));
                }));
                assert.deepStrictEqual(pushed, [], 'no floated chip shares a block with a note floating right');
                // A `$…$` sidebar on a source block's first line, beside the chip: with math off, as
                // the person has it (VS Code's math extension would read `$10:00$` as math).
                await page().setViewport({ width: 1280, height: 760 });
                const math = vscode.workspace.getConfiguration('markdown.math');
                await math.update('enabled', false, vscode.ConfigurationTarget.Global);
                try {
                    await show(SIDEBAR);
                } finally {
                    await math.update('enabled', undefined, vscode.ConfigurationTarget.Global);
                }
                await page().mouse.move(5, 5);
                await shot(page(), `user-sidebar-1280-${name}.png`);
            }
        } finally {
            await page().setViewport({ width: 1280, height: 900 });
            await applyTheme(page(), LIGHT_MODERN);
        }
    });
});
