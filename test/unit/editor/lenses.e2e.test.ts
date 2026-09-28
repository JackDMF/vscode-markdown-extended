import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { LensRow, WebviewMessage } from '../../../src/editor/protocol';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { EXTENSION_ID, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SOURCE = 'Intro.\n\n# Heading\n\nA paragraph.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';

/** Rows for SOURCE's blocks: 0 Intro, 1 the heading, 2 the paragraph, 3 the table. */
const ROWS: LensRow[] = [
    { blockIndex: 1, items: [{ id: '1.0', title: '$(check) Heading lens', tooltip: 'Runs the heading lens' }, { id: '1.1', title: 'Second' }] },
    { blockIndex: 3, items: [{ id: '1.2', title: 'Table lens' }, { title: 'Text only' }] },
];

/**
 * Other extensions' lens rows in the real page: drawn above the blocks the
 * host named, clickable and reachable with the keyboard, following their block
 * through a local edit until the next refresh replaces them, and never under
 * the object toolbar.
 */
suite('Editor lens rows (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const send = (rows: LensRow[], blocks = 4, forVersion = version) =>
        (editor as EditorPage).send({ type: 'lenses', version: forVersion, blocks, rows });

    /** Each row, with the text of the block element right after it. */
    const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('.ProseMirror > .mep-lens-row'), row => ({
        items: Array.from(row.querySelectorAll('.mep-lens, .mep-lens-text'), el => ({
            text: el.textContent,
            lens: (el as HTMLElement).dataset.lens ?? null,
            button: el.tagName === 'BUTTON',
        })),
        text: row.textContent,
        before: (row.nextElementSibling?.textContent ?? '').trim().split('\n')[0],
        editable: (row as HTMLElement).contentEditable,
    })));

    const runLensPosts = async () => (await (editor as EditorPage).posted()).filter(m => m.type === 'runLens');

    const showDocument = async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, SOURCE, {})), version, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Intro.'));
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1000 });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument();
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('rows render above the blocks the host named, as text-editor lenses: titles, bars, a text-only lens', async () => {
        await send(ROWS);
        await page.waitForSelector('.mep-lens-row');
        assert.deepStrictEqual(await rows(), [
            {
                items: [
                    // The codicon is drawn as a character; the page has no icon font.
                    { text: '✓ Heading lens', lens: '1.0', button: true },
                    { text: 'Second', lens: '1.1', button: true },
                ],
                text: '✓ Heading lens | Second',
                before: 'Heading',
                editable: 'false',
            },
            {
                items: [{ text: 'Table lens', lens: '1.2', button: true }, { text: 'Text only', lens: null, button: false }],
                text: 'Table lens | Text only',
                before: 'a',
                editable: 'false',
            },
        ]);
        const title = await page.$eval('[data-lens="1.0"]', el => (el as HTMLElement).title);
        assert.strictEqual(title, 'Runs the heading lens');
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'a row is not content: nothing was written');
    });

    test('a click posts runLens with the lens\'s id, and moves no caret', async () => {
        const button = await page.$('[data-lens="1.1"]');
        const box = await button?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
        assert.deepStrictEqual(await runLensPosts(), [{ type: 'runLens', id: '1.1' }]);
    });

    test('a lens is reachable with Tab and runs with Enter', async () => {
        await page.focus('.ProseMirror');
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.lens ?? null);
        assert.strictEqual(focused, '1.0', 'Tab from the text lands on the first lens');
        await page.keyboard.press('Enter');
        await delay(80);
        assert.deepStrictEqual((await runLensPosts()).map(m => (m as { id: string }).id), ['1.1', '1.0']);
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'Enter on a lens is not typed into the document');
    });

    test('a local edit before the next refresh keeps each row on its block', async function () {
        this.timeout(10000);
        // A new paragraph after "Intro.": every block after it moves one index on.
        const intro = await page.evaluateHandle(() => document.querySelector('.ProseMirror p') as HTMLElement);
        const box = await intro.asElement()?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Inserted.');
        await settle();
        const after = await rows();
        assert.deepStrictEqual(after.map(r => r.before), ['Heading', 'a'], 'the rows followed their blocks, not their indices');
        const edits = await (editor as EditorPage).edits();
        assert.ok(edits.length > 0 && edits[edits.length - 1].text.includes('Intro.\n\nInserted.\n\n# Heading'), JSON.stringify(edits.pop()?.text));
    });

    test('rows for a block count the page no longer holds are not taken; a refresh for the page\'s text replaces them all', async () => {
        await send([{ blockIndex: 0, items: [{ id: '2.0', title: 'Stale' }] }], 4);
        await delay(80);
        assert.deepStrictEqual((await rows()).map(r => r.text), ['✓ Heading lens | Second', 'Table lens | Text only'], 'four blocks were parsed; the page holds five');

        // The refresh after the edit: the host's parse of the page's text, five blocks.
        await send([{ blockIndex: 1, items: [{ id: '3.0', title: 'New on inserted' }] }, { blockIndex: 2, items: [{ id: '3.1', title: 'New on heading' }] }], 5);
        await delay(80);
        assert.deepStrictEqual((await rows()).map(r => [r.text, r.before]), [['New on inserted', 'Inserted.'], ['New on heading', 'Heading']]);

        await send([], 0);
        await delay(80);
        assert.deepStrictEqual(await rows(), [], 'empty rows clear');
    });

    test('rows for a document older than the one shown are dropped', async () => {
        await showDocument();
        await send(ROWS, 4, version - 1);
        await delay(80);
        assert.deepStrictEqual(await rows(), []);
    });

    test('the object toolbar of a block with a row sits above the row, not over it', async function () {
        this.timeout(10000);
        await send(ROWS);
        await page.waitForSelector('.mep-lens-row');
        const table = await page.$('.ProseMirror > .mep-raw-block');
        const box = await table?.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const bar = await page.waitForSelector('.mep-object-toolbar[data-trigger="hover"]:not([hidden])', { visible: true, timeout: 2000 });
        const barBox = await bar?.boundingBox();
        const rowBox = await page.$eval('.ProseMirror > .mep-raw-block', el => {
            const r = (el.previousElementSibling as HTMLElement).getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
        });
        assert.ok(barBox);
        assert.ok(barBox.y + barBox.height <= rowBox.top || barBox.y >= rowBox.bottom,
            `the bar ${JSON.stringify(barBox)} overlaps the row ${JSON.stringify(rowBox)}`);
        assert.ok(barBox.y + barBox.height <= rowBox.top, 'with room above, the bar is above the row');

        // Crossing the row on the way up to the bar keeps the bar.
        await page.mouse.move(box.x + box.width / 2, rowBox.top + 2);
        await delay(400);
        assert.ok(await page.$('.mep-object-toolbar[data-trigger="hover"]:not([hidden])'), 'the row is the block\'s, for the pointer');
    });

    test('a lens clicked while typed text still waits in the delay posts that text first', async function () {
        this.timeout(10000);
        // Just inside the text's last character: a click right of a short line may land elsewhere.
        const paragraph = await page.evaluate(() => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.textContent === 'A paragraph.') {
                    const range = document.createRange();
                    range.setStart(node, 10);
                    range.setEnd(node, 11);
                    const r = range.getBoundingClientRect();
                    return { x: r.left + 1, y: r.top + r.height / 2 };
                }
            }
            throw new Error('no "A paragraph."');
        });
        await page.mouse.click(paragraph.x, paragraph.y);
        await page.keyboard.press('End');
        await settle();
        const before = (await (editor as EditorPage).posted()).length;
        await page.keyboard.type(' Typed');
        // At once, well inside the page's 250 ms delay.
        await page.$eval('[data-lens="1.2"]', el => (el as HTMLElement).click());
        await delay(80);
        const since = (await (editor as EditorPage).posted()).slice(before);
        const edit = since.findIndex(m => m.type === 'edit' && m.text.includes('A paragraph. Typed'));
        const run = since.findIndex(m => m.type === 'runLens');
        assert.ok(edit >= 0 && run > edit, `the edit goes before the run, so the host queues the run behind it: ${JSON.stringify(since)}`);
    });
});

/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/**
 * Other extensions' code actions as object verbs: the object toolbar of a whole
 * top-level block asks the host for them, and draws them after its own verbs.
 * A heading is an object for that alone, and shows a bar only with actions.
 */
suite('Editor code actions as object verbs (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 10;

    const actionRequests = async () => (await (editor as EditorPage).posted())
        .filter((m): m is Extract<WebviewMessage, { type: 'actionsFor' }> => m.type === 'actionsFor');

    const barState = () => page.$eval(BAR, bar => ({
        object: (bar as HTMLElement).dataset.object,
        label: bar.querySelector('.mep-object-label')?.textContent,
        children: Array.from(bar.children).map(c => (c as HTMLElement).dataset.verb ?? c.className),
    }));

    const clickText = async (needle: string) => {
        const p = await page.evaluate(n => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf(n);
                if (at >= 0) {
                    const range = document.createRange();
                    range.setStart(node, at + 1);
                    range.setEnd(node, at + 2);
                    const r = range.getBoundingClientRect();
                    return { x: r.left + 1, y: r.top + r.height / 2 };
                }
            }
            throw new Error(`no "${n}"`);
        }, needle);
        await page.mouse.click(p.x, p.y);
    };

    const showDocument = async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, '# FRS-TST-001: Page\n\nText.\n\n## Plain heading\n\n| a |\n| - |\n| 1 |\n', {}));
        // The shape the parser gives it when Req Explorer's badge names the id; Req Explorer is not in the test host.
        const heading = (json.doc.content as { attrs: Record<string, unknown>; content: { text: string }[] }[])[0];
        heading.attrs.reqPrefix = 'FRS-TST-001: ';
        heading.content = [{ ...heading.content[0], text: 'Page' }];
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Plain heading'));
        await page.mouse.move(2, 2);
        await delay(100);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1000 });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument();
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('the caret resting in a requirement heading asks for its actions; the bar shows them, labelled with the id, and runs one', async function () {
        this.timeout(10000);
        await clickText('Page');
        await delay(INLINE_DELAY_MS + 150);
        const [request] = await actionRequests();
        assert.deepStrictEqual(request && { blockIndex: request.blockIndex, blocks: request.blocks }, { blockIndex: 0, blocks: 4 });
        assert.strictEqual(await page.$(BAR), null, 'no bar while the heading has no verbs');

        await (editor as EditorPage).send({
            type: 'actions', requestId: request.requestId, blockIndex: 0,
            items: [{ id: 'a.0', title: 'Add reference', kind: 'quickfix' }, { id: 'a.1', title: 'Not here', kind: '', refusal: 'Nothing to fix' }],
        });
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        assert.deepStrictEqual(await barState(), {
            object: 'heading',
            label: 'Requirement FRS-TST-001',
            // No own verbs, so no separator before the first action.
            children: ['mep-object-label', 'code-action:a.0', 'code-action:a.1'],
        });
        assert.strictEqual(await page.$eval(`${BAR} [data-verb="code-action:a.1"]`, el => el.getAttribute('aria-disabled')), 'true');

        const button = await page.$(`${BAR} [data-verb="code-action:a.0"]`);
        const box = await button?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
        const runs = (await (editor as EditorPage).posted()).filter(m => m.type === 'runAction');
        assert.deepStrictEqual(runs, [{ type: 'runAction', id: 'a.0' }]);
        assert.strictEqual((await actionRequests()).length, 1, 'the answer is kept for the node: not asked again');
    });

    test('a heading without actions shows no bar', async function () {
        this.timeout(10000);
        await clickText('Plain heading');
        await delay(INLINE_DELAY_MS + 150);
        const request = (await actionRequests()).pop();
        assert.strictEqual(request?.blockIndex, 2);
        await (editor as EditorPage).send({ type: 'actions', requestId: (request as { requestId: number }).requestId, blockIndex: 2, items: [] });
        await delay(100);
        assert.strictEqual(await page.$(BAR), null);
    });

    test('a source block\'s bar has its own verbs, a separator, then the actions', async function () {
        this.timeout(10000);
        const table = await page.$('.ProseMirror > .mep-raw-block');
        const box = await table?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(150);
        const request = (await actionRequests()).pop();
        assert.strictEqual(request?.blockIndex, 3);
        await (editor as EditorPage).send({ type: 'actions', requestId: (request as { requestId: number }).requestId, blockIndex: 3, items: [{ id: 'b.0', title: 'Fix table', kind: 'quickfix' }] });
        await page.waitForSelector(`${BAR} [data-verb="code-action:b.0"]`, { visible: true, timeout: 2000 });
        assert.deepStrictEqual((await barState()).children, [
            'mep-object-label', 'edit-source', 'show-in-text-editor', 'delete-block', 'mep-object-separator', 'code-action:b.0',
        ]);
    });

    test('invalidateActions makes the bar shown ask again, the old verbs kept until the answer; with refused, the page says why', async function () {
        this.timeout(10000);
        const before = (await actionRequests()).length;
        await (editor as EditorPage).send({ type: 'invalidateActions' });
        await delay(100);
        const asked = await actionRequests();
        assert.strictEqual(asked.length, before + 1, 'asked again, without a document or a lens message');
        assert.strictEqual(asked[asked.length - 1].blockIndex, 3);
        assert.ok(await page.$(`${BAR} [data-verb="code-action:b.0"]`), 'no blink while asking');

        await (editor as EditorPage).send({ type: 'invalidateActions', refused: 'Fix table' });
        const hint = await page.waitForFunction(() => {
            const el = document.querySelector('.mep-hint') as HTMLElement | null;
            return el && !el.hidden && el.textContent?.includes('Fix table') ? el.dataset.tone : undefined;
        }, { timeout: 2000 });
        assert.strictEqual(await hint.jsonValue(), 'refusal');
    });

    test('an action clicked while typed text still waits in the delay posts that text first', async function () {
        this.timeout(10000);
        await clickText('Text.');
        await page.keyboard.press('End');
        // The table's bar, by the pointer; the caret stays in the paragraph.
        const table = await page.$('.ProseMirror > .mep-raw-block');
        const box = await table?.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const hover = '.mep-object-toolbar[data-trigger="hover"]:not([hidden])';
        await page.waitForSelector(`${hover} [data-verb="code-action:b.0"]`, { visible: true, timeout: 2000 });
        await settle();
        const before = (await (editor as EditorPage).posted()).length;
        await page.keyboard.type(' Typed');
        // At once, well inside the page's 250 ms delay.
        await page.$eval(`${hover} [data-verb="code-action:b.0"]`, el => (el as HTMLElement).click());
        await delay(80);
        const since = (await (editor as EditorPage).posted()).slice(before);
        const edit = since.findIndex(m => m.type === 'edit' && m.text.includes('Text. Typed'));
        const run = since.findIndex(m => m.type === 'runAction');
        assert.ok(edit >= 0 && run > edit, `the edit goes before the run, so the host queues the run behind it: ${JSON.stringify(since.map(m => m.type))}`);
    });
});
