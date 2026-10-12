import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { clickText, closeEditorPage, delay, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, settle, shot, MOD, editCommand } from './pageHarness';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { CONTROL_LOCK } from '../../../src/editor/webview/focusPlace';
import { DARK_MODERN, LIGHT_MODERN, Theme, applyTheme } from './themes';

const TABLE = '| a | b |\n| = | = |\n| 1 | 2 |\n';
const SOURCE = [
    '---',
    'title: Page',
    '---',
    '',
    'Alpha beta gamma.',
    '',
    TABLE,
    '- [ ] open task',
    '',
].join('\n');

/** An editable table, words, and a source block (a multimd table, for its caption and span); words between, or multimd reads one table with two bodies. */
const BOXES = [
    'Alpha beta gamma.',
    '',
    '| Kind | Count |',
    '| ---- | ----: |',
    '| first | 1 |',
    '| second | 2 |',
    '',
    'Between the tables.',
    '',
    '| Region | Q1 | Q2 |',
    '| ------ | -- | -- |',
    '| North  | 1  | 2  |',
    '| ^^     | 3  | 4  |',
    '[Figures by region]',
    '',
    'Last paragraph.',
    '',
].join('\n');

/** The object toolbar showing the selected source block's verbs. */
const SELECTED_BLOCK_BAR = '.mep-object-toolbar[data-trigger="selection"][data-object="raw_block"]:not([hidden])';
const SELECTION_BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const HOVER_BAR = '.mep-object-toolbar[data-trigger="hover"]:not([hidden])';

/**
 * The atoms — a raw block with its source editor, the front matter — driven
 * with the real mouse in headless Chromium: press, move and release at page
 * coordinates, as a person does, never `element.focus()` or a value set from a
 * script. The other page tests reach these views by script; what only the
 * pointer path shows (who takes a mousedown, whether a caret can be seen) is
 * checked here.
 */
suite('Editor atoms with the real mouse (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    /** Post `text` parsed, as the host does. */
    const showDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await delay(100);
    };

    /** The centre of the first element matching `selector`, in page coordinates. */
    const centre = async (selector: string): Promise<{ x: number; y: number }> => {
        const box = await (await page.waitForSelector(selector))?.boundingBox();
        assert.ok(box, `no box for ${selector}`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    const clickAt = async (point: { x: number; y: number }, clickCount = 1) => {
        await page.mouse.click(point.x, point.y, { clickCount });
        await delay(80);
    };

    /** Open the table's Edit source box the way a person does: hover the block, click the button. */
    const openTableSource = async () => {
        await page.mouse.move(...Object.values(await centre('.mep-raw-block .mep-atom-content table')) as [number, number]);
        await clickAt(await centre('.mep-raw-block .mep-atom-content table'));
        const button = await page.waitForSelector(`${SELECTED_BLOCK_BAR} [data-verb="edit-source"]`, { visible: true });
        const box = await button?.boundingBox();
        assert.ok(box);
        await clickAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        await page.waitForSelector('.mep-raw-editor');
    };

    const area = () => page.$eval('.mep-raw-editor', el => {
        const a = el as HTMLTextAreaElement;
        return { focused: document.activeElement === a, start: a.selectionStart, end: a.selectionEnd, value: a.value };
    });

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument(SOURCE);
        await page.waitForSelector('.mep-raw-block table');
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('Edit source focuses the textarea with the caret at the end, and the caret and a selection are visible', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await openTableSource();
        const opened = await area();
        assert.deepStrictEqual(opened, { focused: true, start: TABLE.length - 1, end: TABLE.length - 1, value: TABLE.replace(/\n$/, '') });
        // While a node is selected ProseMirror hides its own selection with a
        // class on the root, and takes it off only when a later selectionchange
        // moves the DOM selection's anchor — timing, not a guarantee. The
        // textarea must be readable while the class is there.
        const paint = await page.$eval('.mep-raw-editor', el => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            root.classList.add('ProseMirror-hideselection');
            const hidingRules: string[] = [];
            for (const sheet of Array.from(document.styleSheets)) {
                for (const rule of Array.from(sheet.cssRules)) {
                    const style = (rule as CSSStyleRule).style;
                    const selector = (rule as CSSStyleRule).selectorText ?? '';
                    if (!style || !selector.includes('::selection') || !/transparent|rgba\(0, 0, 0, 0\)/.test(style.background + style.backgroundColor)) {
                        continue;
                    }
                    for (const part of selector.split(',')) {
                        if (el.matches(part.replace(/::selection/g, '').trim())) {
                            hidingRules.push(part.trim());
                        }
                    }
                }
            }
            const caret = getComputedStyle(el).caretColor;
            root.classList.remove('ProseMirror-hideselection');
            return { caret, hidingRules };
        });
        assert.notStrictEqual(paint.caret, 'rgba(0, 0, 0, 0)', 'the caret is painted under a hidden node selection');
        assert.deepStrictEqual(paint.hidingRules, [], 'no rule paints the textarea\'s text selection transparent');
        await page.keyboard.press('Escape');
    });

    test('a click in the textarea places the caret there, a drag selects, and typing lands at the caret', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await openTableSource();
        const box = await (await page.$('.mep-raw-editor'))?.boundingBox();
        assert.ok(box);
        // Into the first line, left of its end.
        const line = { x: box.x + 30, y: box.y + 12 };
        await clickAt(line);
        const clicked = await area();
        assert.strictEqual(clicked.focused, true, 'the textarea keeps the focus the click gave it');
        assert.ok(clicked.start === clicked.end && clicked.start > 0 && clicked.start < '| a | b |'.length, `caret on the first line: ${JSON.stringify(clicked)}`);

        await page.mouse.move(line.x, line.y);
        await page.mouse.down();
        await page.mouse.move(line.x + 40, line.y + 20, { steps: 5 });
        await page.mouse.up();
        await delay(80);
        const dragged = await area();
        assert.strictEqual(dragged.focused, true);
        assert.notStrictEqual(dragged.start, dragged.end, 'a drag selects text');

        await clickAt(line);
        const at = (await area()).start;
        await page.keyboard.type('Z');
        const typed = await area();
        assert.strictEqual(typed.value.charAt(at), 'Z', 'typed at the caret');
        assert.strictEqual(typed.value.length, TABLE.length);
        await page.keyboard.press('Escape');
        assert.strictEqual(await page.$('.mep-raw-editor'), null);
    });

    test('a double click on a source block opens its source', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await clickAt(await centre('.mep-raw-block .mep-atom-content table'), 2);
        await page.waitForSelector('.mep-raw-editor', { timeout: 2000 });
        assert.strictEqual((await area()).focused, true);
        await page.keyboard.press('Escape');
    });

    test('a click on a checkbox in a rendered block does not toggle it, since the file would not change', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        const box = await page.waitForSelector('.mep-atom-content input[type="checkbox"]');
        assert.ok(box);
        await clickAt(await centre('.mep-atom-content input[type="checkbox"]'));
        assert.strictEqual(await page.$eval('.mep-atom-content input[type="checkbox"]', el => (el as HTMLInputElement).checked), false);
    });

    test('a click opens the properties, and the Show in text editor button still works', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        const expanded = () => page.$eval('.mep-properties .mep-props-toggle', el => el.getAttribute('aria-expanded'));
        await clickAt(await centre('.mep-properties .mep-props-toggle'));
        assert.strictEqual(await expanded(), 'true');
        await clickAt(await centre('.mep-properties .mep-props-toggle'));
        assert.strictEqual(await expanded(), 'false');

        await clickAt(await centre('.mep-raw-block .mep-atom-content table'));
        const show = await page.waitForSelector(`${SELECTED_BLOCK_BAR} [data-verb="show-in-text-editor"]`, { visible: true });
        const box = await show?.boundingBox();
        assert.ok(box);
        await clickAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const open = (await (editor as EditorPage).posted()).filter(m => m.type === 'openSource').pop();
        assert.deepStrictEqual(open, { type: 'openSource', line: SOURCE.split('\n').indexOf('| a | b |') });
    });

    test('a source commit asks to be parsed again: markup removed, the block comes back as a paragraph with a caret', async function () {
        this.timeout(15000);
        // Authored inline HTML: what still makes a paragraph a source block.
        const wrapped = SOURCE.replace('Alpha beta gamma.', 'Alpha <kbd>beta</kbd> gamma.');
        await showDocument(wrapped);
        await page.waitForSelector('.mep-raw-block kbd');
        await page.mouse.move(...Object.values(await centre('.mep-raw-block kbd')) as [number, number]);
        await clickAt(await centre('.mep-raw-block kbd'));
        assert.ok(await page.$('.mep-raw-block.ProseMirror-selectednode'), 'the click selected the block');
        const button = await page.waitForSelector(`${SELECTED_BLOCK_BAR} [data-verb="edit-source"]`, { visible: true });
        const box = await button?.boundingBox();
        assert.ok(box);
        await clickAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        await page.waitForSelector('.mep-raw-editor');
        assert.strictEqual((await area()).value, 'Alpha <kbd>beta</kbd> gamma.');

        await page.keyboard.down(MOD);
        await page.keyboard.press('a', editCommand('a'));
        await page.keyboard.up(MOD);
        await page.keyboard.type('Alpha beta gamma.');
        await page.keyboard.down(MOD);
        await page.keyboard.press('Enter');
        await page.keyboard.up(MOD);
        // No settle: the commit goes at once, asking to be parsed again.
        const edit = await lastEdit();
        assert.strictEqual(edit?.reparse, true);
        assert.strictEqual(edit?.text, SOURCE);

        // The host's half: it applies the edit and posts its parse.
        await showDocument(edit.text);
        await page.waitForFunction(() => Array.from(document.querySelectorAll('.ProseMirror > p')).some(p => p.textContent === 'Alpha beta gamma.'));
        assert.strictEqual(await page.$('.ProseMirror kbd'), null);
        const paragraph = await page.evaluateHandle(() => Array.from(document.querySelectorAll('.ProseMirror > p')).find(p => p.textContent === 'Alpha beta gamma.'));
        const p = await (paragraph as puppeteer.ElementHandle<Element>).boundingBox();
        assert.ok(p);
        await clickAt({ x: p.x + 5, y: p.y + p.height / 2 });
        await page.keyboard.type('X');
        await settle();
        assert.ok((await lastEdit())?.text.includes('XAlpha beta gamma.') || (await lastEdit())?.text.includes('AXlpha beta gamma.'),
            'the paragraph is edited as text again');
    });

    test('a save from an open source box asks for a re-parse, and the re-post leaves the box open with its text', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await openTableSource();
        await page.keyboard.type('\n| 3 | 4 |');
        const before = (await (editor as EditorPage).edits()).length;
        await page.keyboard.down(MOD);
        await page.keyboard.press('s');
        await page.keyboard.up(MOD);
        const all = await (editor as EditorPage).edits();
        assert.strictEqual(all.length, before + 1, 'one edit, the save');
        const saved = all[all.length - 1];
        assert.strictEqual(saved.save, true);
        assert.strictEqual(saved.reparse, true);
        assert.ok(saved.text.includes('| 1 | 2 |\n| 3 | 4 |\n'), saved.text);

        await showDocument(saved.text);
        const still = await area();
        assert.strictEqual(still.focused, true, 'the box keeps the focus through the host\'s re-post');
        assert.strictEqual(still.value, '| a | b |\n| = | = |\n| 1 | 2 |\n| 3 | 4 |');
        await page.keyboard.type('!');
        assert.ok((await area()).value.endsWith('| 3 | 4 |!'));
        await page.keyboard.press('Escape');
    });

    // -- the bars while a source box holds the focus ------------------------------------

    /** The verbs of the bar `selector`, in order. */
    const verbsOf = (selector: string) => page.$eval(selector, el => Array.from(el.querySelectorAll('[data-verb]')).map(v => (v as HTMLElement).dataset.verb));

    const rowState = () => page.$$eval('.mep-toolbar [aria-disabled]', els => els.map(el => ({
        id: (el as HTMLElement).dataset.action ?? (el as HTMLElement).dataset.menu ?? el.className,
        disabled: el.getAttribute('aria-disabled') === 'true',
        title: (el as HTMLElement).title,
    })));

    const assertRowLocked = async (when: string) => {
        const state = await rowState();
        assert.ok(state.length > 0, 'the row has controls');
        assert.deepStrictEqual(state.filter(s => !s.disabled || !s.title.includes(CONTROL_LOCK)), [], `${when}: every control of the row refused with the reason`);
    };

    const assertRowFree = async (when: string) => {
        const state = await rowState();
        assert.deepStrictEqual(state.filter(s => s.title.includes(CONTROL_LOCK)), [], `${when}: no control says a box holds the focus`);
        assert.strictEqual(state.find(s => s.id === 'bold')?.disabled, false, `${when}: Bold is offered`);
    };

    /** BOXES, with no box left open by a test before: an open box outlives a re-post. */
    const showBoxes = async () => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await showDocument(BOXES);
    };

    /** The editable table's Edit source: the table becomes a source block, its box open. */
    const openEditableTableSource = async () => {
        await clickText(page, 'first', 2);
        const button = await page.waitForSelector(`${SELECTION_BAR}[data-object="table"] [data-verb="edit-source"]`, { visible: true });
        const box = await button?.boundingBox();
        assert.ok(box);
        await clickAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        await page.waitForSelector('.mep-raw-editor');
        await delay(80);
    };

    test('a table\'s Edit source: its bar offers what still applies — not Edit source — no other block has a bar, the row is refused; Esc, no bar', async function () {
        this.timeout(15000);
        await showBoxes();
        await openEditableTableSource();
        assert.strictEqual((await area()).focused, true);
        assert.deepStrictEqual(await verbsOf(SELECTED_BLOCK_BAR), ['show-in-text-editor', 'delete-block']);
        await assertRowLocked('the box open');

        await page.mouse.move(...Object.values(await centre('.mep-raw-editor')) as [number, number]);
        await delay(300);
        assert.strictEqual(await page.$(HOVER_BAR), null, 'no bar for the box under the pointer');
        await page.mouse.move(...Object.values(await centre('.mep-raw-block:not(.mep-editing) .mep-atom-content table')) as [number, number]);
        await delay(300);
        assert.strictEqual(await page.$(HOVER_BAR), null, 'nor for another block');
        assert.deepStrictEqual(await verbsOf(SELECTED_BLOCK_BAR), ['show-in-text-editor', 'delete-block'], 'the box\'s own bar stays');

        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await page.$('.mep-raw-editor'), null);
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'no bar after Esc');
    });

    test('Delete block with the box open removes the block', async function () {
        this.timeout(15000);
        await showBoxes();
        await openEditableTableSource();
        const button = await page.waitForSelector(`${SELECTED_BLOCK_BAR} [data-verb="delete-block"]`, { visible: true });
        const box = await button?.boundingBox();
        assert.ok(box);
        await clickAt({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        await settle();
        assert.strictEqual(await page.$('.mep-raw-editor'), null);
        const edit = await lastEdit();
        assert.ok(edit && !edit.text.includes('| Kind |'), `the table is gone: ${edit?.text}`);
    });

    test('a source block\'s Edit source: its bar without Edit source, labelled as before; no other bar; the row refused', async function () {
        this.timeout(15000);
        await showBoxes();
        await openTableSource();
        assert.deepStrictEqual(await verbsOf(SELECTED_BLOCK_BAR), ['show-in-text-editor', 'delete-block']);
        assert.strictEqual(await page.$eval(`${SELECTED_BLOCK_BAR} .mep-object-label`, el => el.textContent), 'Source · multimd table');
        await page.mouse.move(...Object.values(await centre('.mep-raw-editor')) as [number, number]);
        await delay(300);
        assert.strictEqual(await page.$(HOVER_BAR), null);
        await assertRowLocked('the box open');
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'no bar after Esc');
    });

    test('a click into the text closes the box with what was typed: no bar there, the row offered again', async function () {
        this.timeout(15000);
        await showBoxes();
        await openTableSource();
        await page.keyboard.type('\n| South | 5 | 6 |');
        await clickText(page, 'Last paragraph', 3);
        await settle();
        assert.strictEqual(await page.$('.mep-raw-editor'), null);
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'a paragraph has no bar');
        await assertRowFree('after the click');
        assert.ok((await lastEdit())?.text.includes('| South | 5 | 6 |'), 'the typing is in the document');
    });

    test('a source box\'s bar, shot in light and dark', async function () {
        this.timeout(60000);
        const themes: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']];
        for (const [theme, name] of themes) {
            await applyTheme(page, theme);
            await showBoxes();
            await openEditableTableSource();
            assert.deepStrictEqual(await verbsOf(SELECTED_BLOCK_BAR), ['show-in-text-editor', 'delete-block']);
            await shot(page, `B1-${name}-after-open.png`);
            await page.keyboard.press('Escape');
        }
        await applyTheme(page, LIGHT_MODERN);
    });
});
