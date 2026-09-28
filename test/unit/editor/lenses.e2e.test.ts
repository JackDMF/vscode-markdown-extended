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
                    // The codicon is left out: the page has no icon font, and a stand-in reads as a broken icon.
                    { text: 'Heading lens', lens: '1.0', button: true },
                    { text: 'Second', lens: '1.1', button: true },
                ],
                text: 'Heading lens | Second',
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
        assert.deepStrictEqual((await rows()).map(r => r.text), ['Heading lens | Second', 'Table lens | Text only'], 'four blocks were parsed; the page holds five');

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

/** The summary table as Req Explorer renders it, with the row hooks of the lens contract. */
const SUMMARY_HTML = '<table class="req-summary" data-req-id="FRS-TST-001">'
    + '<tbody class="req-summary-fields">'
    + '<tr data-req-field="status"><th scope="row">Status</th><td>implemented</td></tr>'
    + '<tr data-req-field="priority"><th scope="row">Priority</th><td>high</td></tr>'
    + '</tbody><tbody class="req-summary-links">'
    + '<tr data-req-relation="verified-by"><th scope="row">Verified by</th><td><a href="TST-001.md">TST-001</a></td></tr>'
    + '</tbody></table>';

const BADGE_MARK = { rule: 'req-status-badges', kind: 'atom', artifact: 'FRS-TST-001' };

/**
 * Lenses that name their surface (`LensSurface`): placed on the element they
 * are about — the badge, a row of the summary table — or, for a verb and for
 * an element the page does not show, in the heading's object toolbar. A
 * foreign lens keeps its row, except beside hinted ones.
 */
suite('Editor lenses on their surfaces (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 20;

    /** Blocks: 0 the requirement heading with its badge, 1 its summary table, 2 Intro, 3 a plain heading, 4 a plain paragraph. */
    const BLOCKS = 5;
    const send = (rows: LensRow[], blocks = BLOCKS) => (editor as EditorPage).send({ type: 'lenses', version, blocks, rows });
    const runs = async () => (await (editor as EditorPage).posted())
        .filter((m): m is Extract<WebviewMessage, { type: 'runLens' }> => m.type === 'runLens').map(m => m.id);
    const actionRequests = async () => (await (editor as EditorPage).posted())
        .filter((m): m is Extract<WebviewMessage, { type: 'actionsFor' }> => m.type === 'actionsFor');

    const HINTED: LensRow[] = [
        {
            blockIndex: 0, items: [
                { id: 's.0', title: 'Set status', tooltip: 'Change the status of FRS-TST-001', surface: 'status', artifact: 'FRS-TST-001' },
                { id: 'p.0', title: '$(flag) Set priority', surface: 'priority', artifact: 'FRS-TST-001' },
                { id: 'l.0', title: '1 test', surface: 'links', artifact: 'FRS-TST-001', relation: 'verified-by' },
                // The table hides this relation: no row to put it on.
                { id: 'l.1', title: '2 refinements', surface: 'links', artifact: 'FRS-TST-001', relation: 'refines' },
                { id: 'f.1', title: 'Foreign beside them' },
                { id: 'a.0', title: 'Add test', surface: 'action', artifact: 'FRS-TST-001' },
            ],
        },
        { blockIndex: 4, items: [{ id: 'f.0', title: 'Foreign lens' }] },
    ];

    const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('.ProseMirror > .mep-lens-row'), row => ({
        text: row.textContent,
        before: (row.nextElementSibling?.textContent ?? '').trim(),
    })));

    const targets = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror .mep-lens-target'), el => ({
        el: el.classList.contains('mep-inline-atom') ? 'badge' : el.tagName === 'TR' ? `tr:${el.dataset.reqField ?? el.dataset.reqRelation}` : el.tagName,
        lens: el.dataset.lens,
        title: el.title,
        tabIndex: el.tabIndex,
    })));

    const decorationOf = (selector: string) => page.$eval(selector, el => {
        const style = getComputedStyle(el);
        return { line: style.textDecorationLine, cursor: style.cursor };
    });

    const clickCentre = async (selector: string) => {
        const box = await (await page.$(selector))?.boundingBox();
        assert.ok(box, `no ${selector}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
    };

    /**
     * The bar of the heading the caret rests in, once the host answered with
     * `codeActions`. The last question is answered, whenever it was asked: a
     * `lenses` message asks again for a bar already shown, before the click.
     */
    const headingBar = async (codeActions: { id: string; title: string; kind: string }[] = []) => {
        const p = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror h1 .mep-heading-text') as HTMLElement, NodeFilter.SHOW_TEXT);
            const node = walker.nextNode() as Text;
            const range = document.createRange();
            range.setStart(node, 1);
            range.setEnd(node, 2);
            const r = range.getBoundingClientRect();
            return { x: r.left + 1, y: r.top + r.height / 2 };
        });
        await page.mouse.click(p.x, p.y);
        await delay(INLINE_DELAY_MS + 150);
        const asked = await actionRequests();
        const request = asked[asked.length - 1];
        assert.strictEqual(request?.blockIndex, 0, 'the heading\'s actions were asked for');
        // An answer to a question already answered is dropped by the page.
        await (editor as EditorPage).send({ type: 'actions', requestId: request.requestId, blockIndex: request.blockIndex, items: codeActions });
        // The bar shows the answer it held until this one is drawn.
        await delay(100);
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        return page.$eval(BAR, bar => Array.from(bar.children).map(c => (c as HTMLElement).dataset.verb ?? c.className));
    };

    const showDocument = async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, '# FRS-TST-001: Page\n\nIntro.\n\n## Plain heading\n\nA plain paragraph.\n', {}));
        const content = json.doc.content as { type: string; attrs: Record<string, unknown>; content?: Record<string, unknown>[] }[];
        // As the parser leaves a requirement heading when Req Explorer is installed
        // (it is not, in the test host): the id lifted, the badge after the title,
        // the summary table after the heading.
        const heading = content[0];
        heading.attrs.reqPrefix = 'FRS-TST-001: ';
        heading.content = [
            { type: 'text', text: 'Page ' },
            { type: 'inline_atom', attrs: { html: '<span class="req-badge req-badge-implemented">implemented</span>', mark: BADGE_MARK } },
        ];
        content.splice(1, 0, { type: 'injected_block', attrs: { kind: 'atom', mark: BADGE_MARK, html: SUMMARY_HTML, src: null, gap: null } });
        assert.strictEqual(content.length, BLOCKS);
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('A plain paragraph.'));
        await page.mouse.move(2, 2);
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

    test('status, priority and a relation go on the badge and the table\'s rows; the hinted block has no row, a foreign lens on a paragraph keeps one', async () => {
        await send(HINTED);
        await page.waitForSelector('.mep-lens-target');
        assert.deepStrictEqual(await targets(), [
            { el: 'badge', lens: 's.0', title: 'Set status\nChange the status of FRS-TST-001', tabIndex: 0 },
            // The codicon is left out of the tooltip too.
            { el: 'tr:priority', lens: 'p.0', title: 'Set priority', tabIndex: 0 },
            { el: 'tr:verified-by', lens: 'l.0', title: '1 test', tabIndex: 0 },
        ]);
        assert.deepStrictEqual(await rows(), [{ text: 'Foreign lens', before: 'A plain paragraph.' }],
            'one block, one grammar: no row on the heading; the paragraph\'s foreign lens has its row');
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'placing lenses writes nothing');
    });

    test('at rest a target looks as the preview draws it; the pointer on it underlines it', async () => {
        assert.strictEqual((await decorationOf('.mep-inline-atom.mep-lens-target')).line, 'none');
        assert.strictEqual((await decorationOf('tr[data-req-field="priority"] td')).line, 'none');
        await page.hover('.mep-inline-atom.mep-lens-target');
        assert.deepStrictEqual(await decorationOf('.mep-inline-atom.mep-lens-target'), { line: 'underline', cursor: 'pointer' });
        assert.deepStrictEqual(await decorationOf('.mep-inline-atom.mep-lens-target .req-badge'), { line: 'underline', cursor: 'pointer' });
        await page.hover('tr[data-req-field="priority"] td');
        assert.deepStrictEqual(await decorationOf('tr[data-req-field="priority"] td'), { line: 'underline', cursor: 'pointer' });
        assert.strictEqual((await decorationOf('tr[data-req-field="status"] td')).line, 'none', 'a row no lens is on stays as it is');
        await page.mouse.move(2, 2);
    });

    test('a click on the badge, the priority row, or the link in a relation row runs its lens, and selects nothing', async () => {
        const before = (await runs()).length;
        await clickCentre('.mep-inline-atom.mep-lens-target');
        const selected = await page.evaluate(() => document.querySelector('.ProseMirror-selectednode') !== null);
        assert.strictEqual(selected, false, 'the badge ran its lens instead of being selected');
        await clickCentre('tr[data-req-field="priority"] td');
        await clickCentre('tr[data-req-relation="verified-by"] a');
        assert.deepStrictEqual((await runs()).slice(before), ['s.0', 'p.0', 'l.0']);
        assert.deepStrictEqual(await (editor as EditorPage).edits(), []);
    });

    test('the badge takes the focus, and Enter runs its lens', async () => {
        const before = (await runs()).length;
        await page.focus('.mep-inline-atom.mep-lens-target');
        await page.keyboard.press('Enter');
        await delay(80);
        assert.deepStrictEqual((await runs()).slice(before), ['s.0']);
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'Enter on the badge is not typed into the heading');
    });

    test('the heading\'s bar carries the action, then the lenses with no element and the foreign one beside them, then the code actions', async function () {
        this.timeout(10000);
        const children = await headingBar([{ id: 'c.0', title: 'Quick fix', kind: 'quickfix' }]);
        assert.deepStrictEqual(children, ['mep-object-label', 'lens:a.0', 'lens:l.1', 'lens:f.1', 'mep-object-separator', 'code-action:c.0']);
        const before = (await runs()).length;
        await clickCentre(`${BAR} [data-verb="lens:a.0"]`);
        await clickCentre(`${BAR} [data-verb="lens:l.1"]`);
        assert.deepStrictEqual((await runs()).slice(before), ['a.0', 'l.1']);
    });

    test('past four lens verbs, the first three stay and the rest are behind Actions', async function () {
        this.timeout(10000);
        const actions = Array.from({ length: 6 }, (_, k) => ({ id: `x.${k}`, title: `Action ${k}`, surface: 'action' as const, artifact: 'FRS-TST-001' }));
        await send([{ blockIndex: 0, items: actions }]);
        const children = await headingBar();
        assert.deepStrictEqual(children, ['mep-object-label', 'lens:x.0', 'lens:x.1', 'lens:x.2', 'lens-overflow']);
        assert.strictEqual(await page.$eval(`${BAR} [data-verb="lens-overflow"]`, el => el.textContent), 'Actions ▾');
        await clickCentre(`${BAR} [data-verb="lens-overflow"]`);
        const options = await page.$$eval(`${BAR} select option`, os => os.map(o => (o as HTMLOptionElement).value));
        assert.deepStrictEqual(options, ['', 'x.3', 'x.4', 'x.5']);
        const before = (await runs()).length;
        await page.select(`${BAR} select`, 'x.4');
        await delay(80);
        assert.deepStrictEqual((await runs()).slice(before), ['x.4']);
    });

    test('the placement follows its blocks through an edit, and the next lenses replace it', async function () {
        this.timeout(10000);
        await send(HINTED);
        await page.waitForSelector('tr[data-req-field="priority"].mep-lens-target');
        // A new paragraph after "Intro.": every block after it moves one index on.
        const p = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.textContent === 'Intro.') {
                    const range = document.createRange();
                    range.setStart(node, 4);
                    range.setEnd(node, 5);
                    const r = range.getBoundingClientRect();
                    return { x: r.left + 1, y: r.top + r.height / 2 };
                }
            }
            throw new Error('no "Intro."');
        });
        await page.mouse.click(p.x, p.y);
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Inserted.');
        await settle();
        assert.deepStrictEqual((await targets()).map(t => t.lens), ['s.0', 'p.0', 'l.0'], 'the badge and the rows keep their lenses');
        assert.deepStrictEqual(await rows(), [{ text: 'Foreign lens', before: 'A plain paragraph.' }]);

        await send([], 0);
        await delay(80);
        assert.deepStrictEqual(await targets(), [], 'empty lenses clear the targets');
        const badge = await page.$eval('.ProseMirror .mep-inline-atom', el => ({ title: el.getAttribute('title'), tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role') }));
        assert.deepStrictEqual(badge, { title: null, tabindex: null, role: null }, 'the badge is given back its own look');
    });

    test('a status lens whose artifact has no badge on the page is a verb of the block it stands on', async function () {
        this.timeout(10000);
        await showDocument();
        await send([{ blockIndex: 0, items: [{ id: 'n.0', title: 'Status elsewhere', surface: 'status', artifact: 'FRS-TST-999' }] }]);
        await delay(80);
        assert.deepStrictEqual(await targets(), []);
        assert.deepStrictEqual(await rows(), []);
        assert.deepStrictEqual(await headingBar(), ['mep-object-label', 'lens:n.0']);
    });
});
