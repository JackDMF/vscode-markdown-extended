import * as assert from 'assert';
import * as fs from 'fs';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { closeEditorPage, delay, EditorPage, EXTENSION_ID, openEditorPage, settle, shot, SHOTS_DIR } from './pageHarness';
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
        assert.ok(await page.$('.ProseMirror > .mep-raw-block.ProseMirror-selectednode'), 'the click selected the block');    };

    /** After the key: no edit changed the file, the block still stands, the refusal stands at it. */
    const assertRefused = async (before: number, what: string) => {
        await settle();
        const edits = await (editor as EditorPage).edits();
        const changed = edits.slice(before).filter(e => e.text !== FOOTNOTE);
        assert.deepStrictEqual(changed.map(e => e.text), [], `${what}: the file is not changed`);
        assert.strictEqual(await page.$$eval('.ProseMirror > .mep-raw-block', els => els.length), 2, `${what}: both source blocks stand`);
        const hint = await page.$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden, tone: (el as HTMLElement).dataset.tone }));
        assert.deepStrictEqual(hint, { text: 'This paragraph is source (footnote) — Edit source to change it', shown: true, tone: 'refusal' }, `${what}: the refusal says why`);
    };

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

/** Source blocks of each placement: a footnote paragraph (float), a definition list, one with a right sidebar (after the last line), the footnotes' text (in its box). */
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

suite('Editor source block marker (e2e)', () => {
    const { state, show, open } = sourcePage({ width: 1280, height: 900, styles: ['markdown-extended.css'] });
    const page = () => state.page;

    /** The chip's computed style on the block `sel` (`::before`, or `::after` of its last child when a note floats there). */
    const chip = (sel: string, pseudo: '::before' | '::after' = '::before', inner = '') => page().$eval(sel + inner, (el, p) => {
        const s = getComputedStyle(el, p);
        return { content: s.content, float: s.float, position: s.position, userSelect: s.userSelect, pointerEvents: s.pointerEvents, background: s.backgroundColor, border: s.borderTopStyle };
    }, pseudo);

    suiteSetup(async function () {
        await open(this);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, state.editor);
    });

    test('every source block names itself: a group, "source block", and why — footnote, definition list, footnote text', async function () {
        this.timeout(10000);
        await show(MARKED);
        const names = await page().$$eval('.ProseMirror > .mep-raw-block', els => els.map(el => [el.getAttribute('role'), el.getAttribute('aria-roledescription'), el.getAttribute('aria-label')]));
        assert.deepStrictEqual(names, [
            ['group', 'source block', 'Source block: footnote'],
            ['group', 'source block', 'Source block: definition list'],
            ['group', 'source block', 'Source block: footnote'],
            ['group', 'source block', 'Source block: footnote text'],
        ]);
    });

    test('a paragraph-like block floats the chip top-right: "source", no alt text, not selectable, no pointer; the first line wraps around it', async function () {
        this.timeout(10000);
        await show(MARKED);
        const c = await chip(block(0));
        assert.deepStrictEqual(c, { ...c, content: '"source" / ""', float: 'right', userSelect: 'none', pointerEvents: 'none', border: 'dashed' });
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
        assert.ok(!(await page().$eval('.ProseMirror', el => (el as HTMLElement).innerText)).includes('source'), 'the chip is no text of the page: not copied, not found');
    });

    test('source shown as source has the chip inside its box, top-right, in room the box keeps free', async function () {
        this.timeout(10000);
        await show(MARKED);
        const c = await chip(block(3));
        assert.deepStrictEqual([c.content, c.position, c.float], ['"source" / ""', 'absolute', 'none']);
        const box = await page().$eval(block(3), el => {
            const pre = el.querySelector('pre.mep-raw-source') as HTMLElement;
            const b = el.getBoundingClientRect();
            const r = pre.getBoundingClientRect();
            const s = getComputedStyle(el, '::before');
            const chipRight = b.right - parseFloat(s.right) - 1;
            return { preTop: r.top, blockTop: b.top, chipTop: b.top + parseFloat(s.top), chipRight, preRight: r.right, padRight: parseFloat(getComputedStyle(pre).paddingRight) };
        });
        assert.ok(box.chipTop >= box.preTop && box.chipRight <= box.preRight, `inside the box: ${JSON.stringify(box)}`);
        assert.ok(box.padRight >= 60, `the box keeps room for it: ${JSON.stringify(box)}`);
    });

    test('a block whose note floats at the right keeps the note on its line: the chip follows the last line instead', async function () {
        this.timeout(10000);
        await show(MARKED);
        assert.ok(await page().$eval(block(2), el => el.classList.contains('mep-raw-noted')));
        assert.strictEqual((await chip(block(2))).content, 'none');
        assert.strictEqual((await chip(block(2), '::after', ' > .mep-atom-content > :last-child')).content, '"source" / ""');
        const tops = await page().$eval(block(2), el => ({
            note: (el.querySelector('.right-sidebar') as HTMLElement).getBoundingClientRect().top,
            p: (el.querySelector('p') as HTMLElement).getBoundingClientRect().top,
            float: getComputedStyle(el.querySelector('.right-sidebar') as HTMLElement).float,
        }));
        assert.ok(Math.abs(tops.note - tops.p) < 2, `the note is not pushed down: ${JSON.stringify(tops)}`);
    });

    test('the chip takes no hover tint (#11: no tint on what is no control)', async function () {
        this.timeout(10000);
        await show(MARKED);
        const rest = await chip(block(0));
        const box = await (await page().$(block(0)))?.boundingBox();
        assert.ok(box);
        await page().mouse.move(box.x + 30, box.y + box.height / 2);
        await delay(300);
        assert.strictEqual((await chip(block(0))).background, rest.background);
        await page().mouse.move(5, 5);
    });

    test('selected: the bar says "Source · footnote", a screen reader hears the reason and the key, nothing more is drawn', async function () {
        this.timeout(10000);
        await show(MARKED);
        const box = await (await page().$(`${block(0)} .mep-atom-content`))?.boundingBox();
        assert.ok(box);
        await page().mouse.click(box.x + 20, box.y + 8);
        await page().waitForSelector(`${SELECTED_BLOCK_BAR} .mep-object-label`);
        assert.strictEqual(await page().$eval(`${SELECTED_BLOCK_BAR} .mep-object-label`, el => el.textContent), 'Source · footnote');
        const said = await page().$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden, quiet: el.hasAttribute('data-quiet'), role: el.getAttribute('role'), width: el.getBoundingClientRect().width }));
        assert.deepStrictEqual(said, { text: 'Source block, footnote — Alt+Enter for actions', shown: true, quiet: true, role: 'status', width: 1 });

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
        assert.strictEqual((await chip(block(0))).content, 'none');
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
        if (!userStyles || !fs.existsSync(userStyles) || !SHOTS_DIR) {
            this.skip();
        }
        await open(this);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, state.editor);
    });

    test('no note pushed down by a chip; shots of the marks and the real document in light and dark', async function () {
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
                    const before = getComputedStyle(el, '::before');
                    if (before.content === 'none' || before.float !== 'right') {
                        return [];
                    }
                    return Array.from(el.querySelectorAll('.sidenote, .mnote, .right-sidebar, img')).filter(n => getComputedStyle(n).float === 'right').map(n => n.outerHTML.slice(0, 80));
                }));
                assert.deepStrictEqual(pushed, [], 'no floated chip shares a block with a note floating right');
            }
        } finally {
            await page().setViewport({ width: 1280, height: 900 });
            await applyTheme(page(), LIGHT_MODERN);
        }
    });
});
