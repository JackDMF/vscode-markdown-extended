import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { CELL_BREAK_REFUSAL } from '../../../src/editor/serialize';
import { closeEditorPage, clickText, delay, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, settle, shot as saveShot, vscodeMarkdownCss } from './pageHarness';
import { LIGHT_MODERN, applyTheme } from './themes';

/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const HOVER_BAR = '.mep-object-toolbar[data-trigger="hover"]:not([hidden])';
const MENU = `${BAR} .mep-object-menu`;

/** A pipe table in the tidy form, so every edit below is a diff of the lines it changed. */
const TABLE = [
    '| Name  |  Kind  | Count |',
    '| :---- | :----: | ----: |',
    '| Alpha | first  |     1 |',
    '| Beta  | second |    22 |',
].join('\n');
const DOC = `Intro paragraph.\n\n${TABLE}\n\nAfter the table.\n`;

/**
 * Pipe tables in the real page, with the real keyboard and mouse: the keys
 * that move between cells, Insert → Table, the table's bar with its three
 * set-verb menus, and the text each of them posts — a tidy table.
 */
suite('Editor pipe tables (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    const shot = (name: string) => saveShot(page, name);

    const showDocument = async (text: string, marker: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            // A hint the last test left is about a document no longer shown.
            const hint = document.querySelector('.mep-hint') as HTMLElement | null;
            if (hint) {
                hint.hidden = true;
            }
            // Each test starts at the page's top, whatever the last one scrolled to.
            window.scrollTo(0, 0);
        });
        await delay(300);
    };

    /** A real click just inside the left edge of character `index` of `needle`. */
    const clickAt = (needle: string, index = 0) => clickText(page, needle, index);

    /** A real click at the end of the cell holding `needle`, past its text. */
    const clickCellEnd = async (needle: string) => {
        const p = await page.evaluate(n => {
            const cell = Array.from(document.querySelectorAll('.ProseMirror td, .ProseMirror th')).find(c => c.textContent === n) as HTMLElement;
            const r = cell.getBoundingClientRect();
            return { x: r.right - 4, y: r.top + r.height / 2 };
        }, needle);
        await page.mouse.click(p.x, p.y);
        await delay(80);
    };

    const selected = () => page.evaluate(() => (document.getSelection() as Selection).toString());
    const press = async (key: puppeteer.KeyInput, modifier?: puppeteer.KeyInput) => {
        if (modifier) {
            await page.keyboard.down(modifier);
        }
        await page.keyboard.press(key);
        if (modifier) {
            await page.keyboard.up(modifier);
        }
        await delay(60);
    };
    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden }));
    const cells = () => page.$$eval('.ProseMirror table tr', rows => rows.map(r => Array.from(r.children).map(c => `${c.tagName.toLowerCase()}:${c.textContent}`)));

    const barState = (selector = BAR) => page.$eval(selector, bar => ({
        object: (bar as HTMLElement).dataset.object,
        label: bar.querySelector('.mep-object-label')?.textContent,
        verbs: Array.from(bar.querySelectorAll('button[data-verb]')).map(v => (v as HTMLElement).dataset.verb),
    }));

    /** The text the element `selector` covers: every line box of the document's text it overlaps, as that text. */
    const coveredText = (selector: string, scope = '.ProseMirror') => page.evaluate((sel, within) => {
        const bar = document.querySelector(sel) as HTMLElement | null;
        if (!bar) {
            return [] as string[];
        }
        const b = bar.getBoundingClientRect();
        const covered: string[] = [];
        const root = document.querySelector(within) as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if ((node.textContent ?? '').trim() === '' || (node.parentElement?.closest('.mep-object-toolbar, .mep-bubble'))) {
                continue;
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const r of Array.from(range.getClientRects())) {
                if (r.width > 0 && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) {
                    covered.push(node.textContent ?? '');
                    break;
                }
            }
        }
        return covered;
    }, selector, scope);

    /** Whether the bubble stands just right of the table (within 20px of its edge), on the selection's line, overlapping none of it. */
    const besideTheTable = () => page.evaluate(() => {
        const bubble = (document.querySelector('.mep-bubble:not([hidden])') as HTMLElement | null)?.getBoundingClientRect();
        const table = (document.querySelector('.ProseMirror > table') as HTMLElement).getBoundingClientRect();
        const line = (document.getSelection() as Selection).getRangeAt(0).getBoundingClientRect();
        return !!bubble && bubble.left >= table.right && bubble.left - table.right <= 20 && Math.abs(bubble.top - line.top) < 2;
    });

    /** The text of the cell the caret is in. */
    const caretCell = () => page.evaluate(() => {
        const anchor = (document.getSelection() as Selection).anchorNode;
        const el = anchor instanceof Element ? anchor : anchor?.parentElement;
        return el?.closest('td, th')?.textContent ?? null;
    });

    /** The caret in the cell holding `needle`, and the table's bar shown. */
    const barFor = async (needle: string, index = 1) => {
        await clickAt(needle, index);
        await page.waitForSelector(BAR, { timeout: 2000 });
    };

    const openMenu = async (verb: string) => {
        const button = await page.waitForSelector(`${BAR} [data-verb="${verb}"]`, { visible: true, timeout: 2000 });
        const box = await button?.boundingBox();
        assert.ok(box, `no box for ${verb}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(MENU, { visible: true, timeout: 2000 });
    };

    const menuState = () => page.$eval(MENU, menu => Array.from(menu.querySelectorAll('.mep-menu-item')).map(item => ({
        entry: (item as HTMLElement).dataset.entry,
        label: item.querySelector('.mep-entry-label')?.textContent,
        keys: item.querySelector('.mep-entry-syntax')?.textContent ?? null,
        checked: item.getAttribute('aria-checked'),
        disabled: item.getAttribute('aria-disabled') === 'true',
    })));

    const choose = async (verb: string, entry: string) => {
        await openMenu(verb);
        const item = await page.$(`${MENU} [data-entry="${entry}"]`);
        const box = await item?.boundingBox();
        assert.ok(box, `no entry ${entry}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({
            width: 1280, height: 800,
            stylesheets: [vscodeMarkdownCss()],
            styles: ['markdown-extended.css', 'markdown-it-admonition.css', 'markdown-it-kbd.css'],
        });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        // What VS Code gives every webview: its theme's colours as variables — here
        // the default light theme's (Light Modern) — and the body painted with them.
        await applyTheme(page, LIGHT_MODERN);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('Tab selects the next cell\'s text and Shift+Tab the previous; Tab in the last cell adds a row and goes into it', async function () {
        this.timeout(15000);
        await showDocument(DOC, 'Alpha');
        await clickAt('Alpha', 2);
        await shot('01-table-caret.png');
        assert.strictEqual(await page.$(BAR), null, `no bar before ${INLINE_DELAY_MS} ms`);
        assert.ok(await page.$('.ProseMirror table.mep-table-active'), 'the table is outlined while the caret is in it, before its bar');
        await press('Tab');
        assert.strictEqual(await selected(), 'first');
        await press('Tab');
        assert.strictEqual(await selected(), '1');
        await press('Tab', 'Shift');
        await press('Tab', 'Shift');
        assert.strictEqual(await selected(), 'Alpha');

        await clickAt('22', 1);
        await press('Tab');
        await page.keyboard.type('Gamma');
        await settle();
        assert.deepStrictEqual((await cells()).pop(), ['td:Gamma', 'td:', 'td:']);
        assert.strictEqual((await lastEdit())?.text, `Intro paragraph.\n\n${TABLE}\n| Gamma |        |       |\n\nAfter the table.\n`);
    });

    test('Enter goes to the cell below; in the last row it adds one; in an empty last row it leaves the table; Shift+Enter is refused', async function () {
        this.timeout(15000);
        await showDocument(DOC, 'Alpha');
        await clickCellEnd('first');
        await press('Enter');
        await page.keyboard.type('!');
        await press('Enter');
        await page.keyboard.type('third');
        await press('Enter', 'Shift');
        assert.deepStrictEqual(await hint(), { text: CELL_BREAK_REFUSAL, shown: true });
        await settle();
        assert.strictEqual((await lastEdit())?.text, [
            'Intro paragraph.',
            '',
            '| Name  |  Kind   | Count |',
            '| :---- | :-----: | ----: |',
            '| Alpha |  first  |     1 |',
            '| Beta  | second! |    22 |',
            '|       |  third  |       |',
            '',
            'After the table.',
            '',
        ].join('\n'));

        await press('Enter');
        await press('Enter');
        await page.keyboard.type('Below it.');
        await settle();
        const text = (await lastEdit())?.text ?? '';
        assert.ok(text.includes('|       |  third  |       |\n\nBelow it.\n\nAfter the table.\n'), text);
    });

    test('Insert → Table puts a header row and two empty rows after the block, the first header cell selected', async function () {
        this.timeout(15000);
        await showDocument('A paragraph.\n\nThe last one.\n', 'paragraph');
        await clickAt('paragraph', 3);
        await page.click('.mep-toolbar .mep-menu-face[data-menu="insert"]');
        await page.waitForSelector('.mep-menu[data-menu="insert"]:not([hidden])');
        await page.click('.mep-menu [data-action="table"]');
        await delay(100);
        assert.strictEqual(await selected(), 'Column 1');
        assert.deepStrictEqual(await coveredText('.mep-bubble:not([hidden])'), [], 'the bubble covers no text');
        assert.ok(await besideTheTable(), 'nor the table\'s cells, empty as they are: it stands just right of the table, on the selection\'s line');
        const empty = await page.$$eval('.ProseMirror td', cells => cells.map(c => {
            const r = c.getBoundingClientRect();
            return { height: r.height, width: r.width, line: getComputedStyle(c).boxShadow !== 'none' };
        }));
        assert.strictEqual(empty.length, 6);
        assert.ok(empty.every(c => c.height >= 16 && c.width >= 16 && c.line), `every empty cell can be seen: ${JSON.stringify(empty)}`);
        await shot('06-insert-table.png');
        await page.keyboard.type('Key');
        await press('Tab');
        await page.keyboard.type('Value');
        await settle();
        assert.strictEqual((await lastEdit())?.text, [
            'A paragraph.',
            '',
            '| Key | Value | Column 3 |',
            '| --- | ----- | -------- |',
            '|     |       |          |',
            '|     |       |          |',
            '',
            'The last one.',
            '',
        ].join('\n'));
    });

    test('the table\'s bar: Row ▾, Column ▾, Align ▾, a gap, Attributes…, Edit source and Delete table; the caret\'s column tinted while it shows', async function () {
        this.timeout(15000);
        await showDocument(DOC, 'Alpha');
        await barFor('first');
        assert.deepStrictEqual(await barState(), { object: 'table', label: 'Table', verbs: ['row', 'column', 'align', 'block-attributes', 'edit-source', 'delete-table'] });
        const layout = await page.$eval(BAR, bar => Array.from(bar.children).map(c => (c as HTMLElement).dataset.verb ?? c.className));
        assert.deepStrictEqual(layout, ['mep-object-label', 'row', 'column', 'align', 'mep-object-separator', 'block-attributes', 'edit-source', 'delete-table']);
        await page.waitForSelector('.mep-table-column', { timeout: 1000 });
        const tinted = await page.$$eval('.ProseMirror .mep-table-column', els => els.map(e => e.textContent));
        assert.deepStrictEqual(tinted, ['Kind', 'first', 'second'], 'the caret\'s column, every row of it');
        assert.deepStrictEqual(await coveredText(BAR), [], 'the bar covers no text');
        const beside = await page.evaluate(sel => {
            const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const table = (document.querySelector('.ProseMirror table') as HTMLElement).getBoundingClientRect();
            return { left: bar.left, right: table.right, top: bar.top, tableTop: table.top };
        }, BAR);
        assert.ok(beside.left > beside.right && Math.abs(beside.top - beside.tableTop) < 2, `beside the table's first line, top-aligned: ${JSON.stringify(beside)}`);
        await shot('02-table-bar.png');

        await clickAt('After', 2);
        await delay(100);
        assert.strictEqual(await page.$('.mep-table-column'), null, 'the tint goes with the bar');
        assert.strictEqual(await page.$('.ProseMirror table.mep-table-active'), null, 'and the outline with the caret');
    });

    test('a block with text in every place its bar could go shows it above, right-aligned, over the line above; nothing moves', async function () {
        this.timeout(15000);
        // Text at the column's right edge above the container, below it, and in its own first line.
        const long = 'Inside the container, a first line of prose long enough to run across the whole width of the column and on past its right edge, so its first line is full.';
        await showDocument(`Right-aligned text above. {style="text-align: right"}\n\n::: note\n${long}\n:::\n\nRight-aligned text below. {style="text-align: right"}\n`, 'Inside');
        const layout = () => page.evaluate(() => ({
            block: (document.querySelector('.ProseMirror div[data-mep-container]') as HTMLElement).getBoundingClientRect().top,
            caret: (document.getSelection() as Selection).rangeCount > 0 ? (document.getSelection() as Selection).getRangeAt(0).getBoundingClientRect().top : null,
            scroll: window.scrollY,
        }));
        await clickAt('Inside', 2);
        const before = await layout();
        await page.waitForSelector(BAR, { timeout: 2000 });
        await delay(100);
        assert.strictEqual((await barState()).object, 'container');
        assert.deepStrictEqual(await layout(), before, 'showing the bar moved nothing: the block, the caret\'s line and the scroll are where they were');
        const where = await page.evaluate(sel => {
            const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const block = (document.querySelector('.ProseMirror div[data-mep-container]') as HTMLElement).getBoundingClientRect();
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const column = root.getBoundingClientRect().right - (parseFloat(getComputedStyle(root).paddingRight) || 0);
            return { bottom: bar.bottom, top: block.top, right: bar.right, column };
        }, BAR);
        assert.ok(where.bottom <= where.top && Math.abs(where.right - where.column) < 2, `above the block, right-aligned to the column: ${JSON.stringify(where)}`);
        assert.strictEqual(await page.$('.mep-bar-room'), null, 'no room is made for it');

        // A block with a free place for its bar takes it, and nothing moves either: a short line ends far from it.
        await showDocument('Short line.\n\n::: note\nInside the container.\n:::\n', 'Inside');
        await clickAt('Inside', 2);
        const shortBefore = await layout();
        await page.waitForSelector(BAR, { timeout: 2000 });
        await delay(100);
        assert.deepStrictEqual(await layout(), shortBefore);
        assert.deepStrictEqual(await coveredText(BAR), []);
    });

    test('with no place free and above it under the row, a block\'s bar goes below the block, where it can be seen; nothing moves', async function () {
        this.timeout(15000);
        const long = 'Inside the container, a first line of prose long enough to run across the whole width of the column and on past its right edge, so its first line is full.';
        const filler = Array.from({ length: 12 }, (_, k) => `Filler paragraph ${k + 1}, to give the page something to scroll.`).join('\n\n');
        await showDocument(`${filler}\n\nRight-aligned text above. {style="text-align: right"}\n\n::: note\n${long}\n:::\n\nRight-aligned text below. {style="text-align: right"}\n\n${filler}\n`, 'Inside');
        // The container's top just under the row: above it is under the row.
        await page.evaluate(() => {
            const block = (document.querySelector('.ProseMirror div[data-mep-container]') as HTMLElement).getBoundingClientRect();
            const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
            window.scrollBy(0, block.top - row.bottom - 6);
        });
        await delay(100);
        await clickAt('Inside', 2);
        const before = await page.evaluate(() => ({
            block: (document.querySelector('.ProseMirror div[data-mep-container]') as HTMLElement).getBoundingClientRect().top,
            scroll: window.scrollY,
        }));
        await page.waitForSelector(BAR, { timeout: 2000 });
        await delay(100);
        const where = await page.evaluate(sel => ({
            bar: (document.querySelector(sel) as HTMLElement).getBoundingClientRect().top,
            row: (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect().bottom,
            below: (document.querySelector('.ProseMirror div[data-mep-container]') as HTMLElement).getBoundingClientRect().bottom,
            block: (document.querySelector('.ProseMirror div[data-mep-container]') as HTMLElement).getBoundingClientRect().top,
            scroll: window.scrollY,
        }), BAR);
        assert.ok(before.block - where.row < 40, `the block's top is just under the row: ${JSON.stringify(where)}`);
        assert.ok(where.bar >= where.row && where.bar >= where.below, `the bar is below the block, clear of the row: ${JSON.stringify(where)}`);
        assert.deepStrictEqual({ block: where.block, scroll: where.scroll }, before, 'and nothing moved');
    });

    test('a full-width table under a paragraph: its bar shows above it and the table does not move', async function () {
        this.timeout(15000);
        const wide = [
            '| Requirement | Statement | Verification |',
            '| :---------- | :-------- | :----------- |',
            '| FRS-001 | The editor shows the document as the preview renders it, block for block, with nothing added and nothing taken away, whatever the width of the window it is shown in. | Inspection of every construct |',
            '| FRS-002 | A bar that appears for an object never moves the text around it, so the reader keeps their place. | Page test |',
        ].join('\n');
        // Short, so the end of its line leaves the bar a free place above the table.
        const intro = 'The table below is as wide as the column; nothing beside it is free.';
        await showDocument(`${intro}\n\n${wide}\n\nAfter the table, a closing paragraph that also runs across most of the column so the place below is taken as well.\n`, 'FRS-001');
        const tableTop = () => page.evaluate(() => ({
            table: (document.querySelector('.ProseMirror > table') as HTMLElement).getBoundingClientRect().top,
            scroll: window.scrollY,
        }));
        const widths = await page.evaluate(() => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const column = root.getBoundingClientRect().right - (parseFloat(getComputedStyle(root).paddingRight) || 0);
            return { table: (document.querySelector('.ProseMirror > table') as HTMLElement).getBoundingClientRect().right, column };
        });
        assert.ok(widths.column - widths.table < 40, `the table fills the column: ${JSON.stringify(widths)}`);
        await clickAt('FRS-002', 2);
        const before = await tableTop();
        await page.waitForSelector(BAR, { timeout: 2000 });
        await page.waitForSelector('.mep-table-column', { timeout: 1000 });
        await delay(100);
        assert.deepStrictEqual(await tableTop(), before, 'the table\'s top and the scroll are where they were before its bar showed');
        const where = await page.evaluate(sel => ({
            bar: (document.querySelector(sel) as HTMLElement).getBoundingClientRect().bottom,
            table: (document.querySelector('.ProseMirror > table') as HTMLElement).getBoundingClientRect().top,
        }), BAR);
        assert.ok(where.bar <= where.table, `the bar stands above the table: ${JSON.stringify(where)}`);
        await shot('02-table-bar-fullwidth.png');
    });

    test('Row ▾ inserts above and below and deletes, Column ▾ inserts left and right and deletes: each a tidy table', async function () {
        this.timeout(20000);
        await showDocument(DOC, 'Alpha');
        await barFor('first');
        await openMenu('row');
        assert.deepStrictEqual(await menuState(), [
            { entry: 'insert-row-above', label: 'Insert above', keys: null, checked: null, disabled: false },
            { entry: 'insert-row-below', label: 'Insert below', keys: 'Tab at end', checked: null, disabled: false },
            { entry: 'delete-row', label: 'Delete row', keys: null, checked: null, disabled: false },
        ]);
        await press('Escape');
        await choose('row', 'insert-row-below');
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-cell-new', els => els.length), 3, 'the new row\'s cells are highlighted');
        await delay(700);
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-cell-new', els => els.length), 0, 'for 600 ms');
        // Typing ends a flash at once rather than carrying it along; the typed text is taken back.
        await choose('row', 'insert-row-below');
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-cell-new', els => els.length), 3);
        await page.keyboard.type('z');
        await delay(30);
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-cell-new', els => els.length), 0, 'a keystroke ends the flash');
        await press('Backspace');
        await choose('row', 'delete-row');
        await delay(50);
        await barFor('first');
        // The shot while the new column still shows its highlight: the animation, held.
        await page.addStyleTag({ content: '.ProseMirror .mep-cell-new { animation-play-state: paused !important; }' });
        await choose('column', 'insert-column-right');
        await page.waitForSelector('.ProseMirror .mep-cell-new', { timeout: 500 });
        await page.waitForSelector(BAR, { timeout: 2000 });
        await shot('04-after-insert.png');
        await page.addStyleTag({ content: '.ProseMirror .mep-cell-new { animation-play-state: running !important; }' });
        await settle();
        assert.strictEqual((await lastEdit())?.text, [
            'Intro paragraph.',
            '',
            '| Name  |  Kind  |   | Count |',
            '| :---- | :----: | - | ----: |',
            '| Alpha | first  |   |     1 |',
            '|       |        |   |       |',
            '| Beta  | second |   |    22 |',
            '',
            'After the table.',
            '',
        ].join('\n'), 'a row under the caret\'s, a column right of it, aligned as their neighbours');

        // Each verb leaves the caret in what it made, so the next acts there.
        await barFor('Beta');
        await choose('row', 'insert-row-above');
        await choose('column', 'insert-column-left');
        await choose('column', 'delete-column');
        assert.strictEqual((await hint()).text, 'Column deleted — Ctrl+Z');
        assert.strictEqual(await caretCell(), '', 'the caret in the cell now standing where the deleted one stood: the new row\'s first');
        await barFor('Beta');
        await choose('row', 'delete-row');
        assert.strictEqual(await caretCell(), '', 'the caret in the row before, the last one having gone');
        await settle();
        assert.strictEqual((await lastEdit())?.text, [
            'Intro paragraph.',
            '',
            '| Name  | Kind  |   | Count |',
            '| :---- | :---: | - | ----: |',
            '| Alpha | first |   |     1 |',
            '|       |       |   |       |',
            '|       |       |   |       |',
            '',
            'After the table.',
            '',
        ].join('\n'), 'the column made and taken away again, Beta\'s row gone (and "second" with it, so the column is narrower), the rows inserted kept');
        assert.strictEqual((await hint()).text, 'Row deleted — Ctrl+Z');

        await barFor('Name');
        await choose('row', 'delete-row');
        await settle();
        assert.deepStrictEqual((await cells())[0], ['th:Alpha', 'th:first', 'th:', 'th:1'], 'the next row is the header');
        assert.strictEqual(await caretCell(), 'Alpha', 'the caret in the cell below the deleted one');
    });

    test('Align ▾ marks the current alignment, sets another into the delimiter row, and the marked one again is the default', async function () {
        this.timeout(15000);
        await showDocument(DOC, 'Alpha');
        await barFor('first');
        await openMenu('align');
        assert.deepStrictEqual((await menuState()).map(e => [e.entry, e.label, e.keys, e.checked]), [
            ['align-left', 'Left', ':--', 'false'],
            ['align-center', 'Center', ':-:', 'true'],
            ['align-right', 'Right', '--:', 'false'],
        ]);
        const marks = await page.$$eval(`${MENU} .mep-menu-item`, items => items.map(i => getComputedStyle(i, '::before').content));
        assert.deepStrictEqual(marks, ['""', '"✓"', '""'], 'the current value is a check, apart from the focus ring');
        await shot('03-align-menu.png');
        await press('Escape');
        await choose('align', 'align-right');
        await settle();
        assert.ok((await lastEdit())?.text.includes('| :---- | -----: | ----: |\n| Alpha |  first |     1 |'), (await lastEdit())?.text);
        await barFor('first');
        await choose('align', 'align-right');
        await settle();
        assert.ok((await lastEdit())?.text.includes('| :---- | ------ | ----: |\n| Alpha | first  |     1 |'), (await lastEdit())?.text);
    });

    test('the menus answer the keyboard: Alt+Enter to the bar, arrows to a verb, Enter opens, arrows and Enter choose, Esc closes back', async function () {
        this.timeout(15000);
        await showDocument(DOC, 'Alpha');
        await clickAt('Alpha', 1);
        await press('Enter', 'Alt');
        await page.waitForSelector(BAR, { timeout: 2000 });
        const focused = () => page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return el?.dataset.verb ?? el?.dataset.entry ?? null;
        });
        assert.strictEqual(await focused(), 'row');
        await press('ArrowRight');
        assert.strictEqual(await focused(), 'column');
        await press('Enter');
        assert.strictEqual(await focused(), 'insert-column-left');
        await press('ArrowDown');
        assert.strictEqual(await focused(), 'insert-column-right');
        await press('Escape');
        assert.strictEqual(await focused(), 'column', 'Esc closes the menu, back on its verb');
        assert.strictEqual(await page.$(MENU), null);
        await press('Enter');
        await press('ArrowUp');
        assert.strictEqual(await focused(), 'delete-column');
        await press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('|  Kind  | Count |\n| :----: | ----: |'), (await lastEdit())?.text);
    });

    test('Edit source makes the table a source block holding its text; Delete table removes it', async function () {
        this.timeout(15000);
        await showDocument(DOC, 'Alpha');
        await barFor('first');
        const button = await page.$(`${BAR} [data-verb="edit-source"]`);
        await button?.click();
        const box = await page.waitForSelector('.mep-raw-editor', { visible: true, timeout: 2000 });
        assert.strictEqual(await box?.evaluate(el => (el as HTMLTextAreaElement).value), TABLE);
        await press('Escape');

        await showDocument(DOC, 'Alpha');
        await barFor('first');
        await (await page.$(`${BAR} [data-verb="delete-table"]`))?.click();
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Intro paragraph.\n\nAfter the table.\n');
        assert.strictEqual((await hint()).text, 'Table deleted — Ctrl+Z');
    });

    test('a multimd table is a source block that says so, beside a native one', async function () {
        this.timeout(15000);
        // A rowspan (`^^`) and a caption: two of multimd's extensions.
        const multimd = '| Region | Q1 | Q2 |\n| ------ | -- | -- |\n| North  | 1  | 2  |\n| ^^     | 3  | 4  |\n[Figures by region]\n';
        await showDocument(`${DOC}\n${multimd}`, 'Region');
        await barFor('first');
        const raw = await (await page.$('.mep-raw-block table'))?.boundingBox();
        assert.ok(raw);
        await page.mouse.move(raw.x + raw.width / 2, raw.y + raw.height / 2);
        await page.waitForSelector(HOVER_BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(HOVER_BAR), { object: 'raw_block', label: 'Source · multimd table', verbs: ['edit-source', 'show-in-text-editor', 'delete-block'] });
        assert.strictEqual((await barState()).label, 'Table', 'the native table keeps its own bar');
        await delay(100);
        assert.deepStrictEqual(await coveredText(HOVER_BAR), [], 'the source block\'s bar covers no text');
        assert.deepStrictEqual(await coveredText(BAR), [], 'nor does the table\'s');
        await shot('05-multimd-raw.png');
    });

    test('a cell is edited as text: a mark applied in it is written inside the cell', async function () {
        this.timeout(15000);
        await showDocument(DOC, 'Alpha');
        await page.evaluate(() => {
            const cell = Array.from(document.querySelectorAll('.ProseMirror td')).find(c => c.textContent === 'second') as HTMLElement;
            const text = cell.firstChild as Text;
            (document.querySelector('.ProseMirror') as HTMLElement).focus();
            (document.getSelection() as Selection).setBaseAndExtent(text, 0, text, 3);
        });
        await delay(100);
        await press('b', 'Control');
        await delay(INLINE_DELAY_MS + 100);
        assert.ok(await page.$('.mep-bubble:not([hidden])'), 'the bubble shows over the selected text');
        assert.strictEqual(await page.$(BAR), null, 'and no block\'s bar beside it: one thing at a time');
        assert.deepStrictEqual(await coveredText('.mep-bubble:not([hidden])', '.ProseMirror table'), [], 'the bubble covers no row of the table');
        assert.ok(await besideTheTable(), 'and stands just right of the table, close to the cell it acts on');
        await shot('07-cell-mark.png');
        await settle();
        assert.ok((await lastEdit())?.text.includes('| Beta  | **sec**ond |    22 |'), (await lastEdit())?.text);
    });
});
