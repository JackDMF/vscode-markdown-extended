import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { LensRow, WebviewMessage } from '../../../src/editor/protocol';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { EXTENSION_ID, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SOURCE = 'Intro.\n\n# Heading\n\nA paragraph.\n\n| a | b |\n| = | = |\n| 1 | 2 |\n';

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
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, SOURCE, {})), version, defaultWrap: 90, includes: false });
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
                    // The codicon is a span before the text; `text` is the text content, which has none of it.
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

    test('a row\'s icons: a span before the text on a lens and on a text-only one, the plain name when only an icon, an escape kept as text', async () => {
        await send([{ blockIndex: 1, items: [
            { title: '$(info) Only text', tooltip: 'Provider tip' },
            { title: '$(warning)' },
            { id: 'r.0', title: '$(refresh)' },
            { id: 'r.1', title: '$(add) Add reference…' },
            { id: 'r.2', title: '\\$(x) literal' },
        ] }]);
        await page.waitForFunction(() => document.querySelectorAll('.mep-lens-row .mep-lens').length === 3);
        const items = await page.$$eval('.mep-lens-row .mep-lens, .mep-lens-row .mep-lens-text', els => els.map(el => ({
            tag: el.tagName,
            kids: Array.from(el.childNodes, n => n.nodeType === Node.TEXT_NODE ? `#text ${n.textContent}` : (n as HTMLElement).className),
            title: (el as HTMLElement).title,
            name: el.getAttribute('aria-label'),
        })));
        assert.deepStrictEqual(items, [
            { tag: 'SPAN', kids: ['codicon codicon-info', '#text Only text'], title: 'Provider tip', name: null },
            { tag: 'SPAN', kids: ['codicon codicon-warning'], title: 'warning', name: null },
            { tag: 'BUTTON', kids: ['codicon codicon-refresh'], title: 'refresh', name: 'refresh' },
            { tag: 'BUTTON', kids: ['codicon codicon-add', '#text Add reference…'], title: 'Add reference…', name: 'Add reference…' },
            { tag: 'BUTTON', kids: ['#text $(x) literal'], title: '$(x) literal', name: '$(x) literal' },
        ]);
        await send(ROWS);
        await page.waitForFunction(() => document.querySelectorAll('.mep-lens-row .mep-lens').length === 3);
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
        const json = parsedDocumentToJSON(parseDocument(md, '# FRS-TST-001: Page\n\nText.\n\n## Plain heading\n\n| a |\n| = |\n| 1 |\n', {}));
        // The shape the parser gives it when Req Explorer's badge names the id; Req Explorer is not in the test host.
        const heading = (json.doc.content as { attrs: Record<string, unknown>; content: { text: string }[] }[])[0];
        heading.attrs.reqPrefix = 'FRS-TST-001: ';
        heading.content = [{ ...heading.content[0], text: 'Page' }];
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
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

/** The status row of a summary table, where Req Explorer shows the status (and draws no badge). */
const STATUS_ROW = '<tr data-req-field="status"><th scope="row">Status</th><td><span class="req-badge req-badge-implemented">implemented</span></td></tr>';

/**
 * The summary table as Req Explorer renders it, with the row hooks of the lens
 * contract — without a status row, so the status lens goes to the badge;
 * `withStatusRow` adds it.
 */
const SUMMARY_HTML = '<table class="req-summary" data-req-id="FRS-TST-001">'
    + '<tbody class="req-summary-fields">'
    + '<tr data-req-field="priority"><th scope="row">Priority</th><td>high</td></tr>'
    + '</tbody><tbody class="req-summary-links">'
    + '<tr data-req-relation="verified-by" data-req-direction="out"><th scope="row">Verified by</th><td><a href="TST-001.md">TST-001</a></td></tr>'
    // A symmetric relation: one row per side under one key, the incoming one collapsed.
    + '<tr data-req-relation="conflicts-with" data-req-direction="out"><th scope="row">Conflicts with</th><td><a href="FRS-TST-002.md">FRS-TST-002</a></td></tr>'
    + '<tr data-req-relation="conflicts-with" data-req-direction="in"><th scope="row">Conflicted by</th><td>'
    + '<details class="req-summary-more"><summary>3 requirements</summary><ul><li>FRS-TST-003</li><li>FRS-TST-004</li><li>FRS-TST-005</li></ul></details>'
    + '</td></tr>'
    + '</tbody></table>';

const withStatusRow = (html: string) => html.replace('<tbody class="req-summary-fields">', `<tbody class="req-summary-fields">${STATUS_ROW}`);

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
                // No side named, as an older Req Explorer sends it: the relation's first row.
                { id: 'l.0', title: '1 test', surface: 'links', artifact: 'FRS-TST-001', relation: 'verified-by' },
                { id: 'c.out', title: 'Conflicts with 1', surface: 'links', artifact: 'FRS-TST-001', relation: 'conflicts-with', direction: 'out' },
                { id: 'c.in', title: 'Conflicted by 3', surface: 'links', artifact: 'FRS-TST-001', relation: 'conflicts-with', direction: 'in' },
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
        el: el.classList.contains('mep-inline-atom') ? 'badge'
            : (tr => (tr ? `${el.tagName.toLowerCase()}:${tr.dataset.reqField ?? `${tr.dataset.reqRelation}/${tr.dataset.reqDirection}`}` : el.tagName))(el.closest('tr')),
        kind: el.dataset.lensKind,
        lens: el.dataset.lens,
        title: el.title,
        tabIndex: el.tabIndex,
    })));

    /**
     * A requirement heading (with its badge, or without) and its summary table `html`, sent as the
     * document. `tag` goes into the paragraph, so the wait is for *this* document and not for one an
     * earlier case already rendered; `rowSelector` matching `rowCount` rows says the table is there.
     */
    const showRequirement = async (o: { html: string; badge?: boolean; tag: string; rowSelector: string; rowCount: number }) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const paragraph = `A plain paragraph ${o.tag}.`;
        const json = parsedDocumentToJSON(parseDocument(md, `# FRS-TST-001: Page\n\n${paragraph}\n`, {}));
        const content = json.doc.content as { type: string; attrs: Record<string, unknown>; content?: Record<string, unknown>[] }[];
        content[0].attrs.reqPrefix = 'FRS-TST-001: ';
        content[0].content = o.badge
            ? [{ type: 'text', text: 'Page ' }, { type: 'inline_atom', attrs: { html: '<span class="req-badge req-badge-implemented">implemented</span>', mark: BADGE_MARK } }]
            : [{ type: 'text', text: 'Page' }];
        content.splice(1, 0, { type: 'injected_block', attrs: { kind: 'atom', mark: BADGE_MARK, html: o.html, src: null, gap: null } });
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
        await page.waitForFunction((text, selector, n) => document.querySelector('.ProseMirror')?.textContent?.includes(text)
            && document.querySelectorAll(`.ProseMirror ${selector}`).length === n, {}, paragraph, o.rowSelector, o.rowCount);
    };

    const decorationOf = (selector: string) => page.$eval(selector, el => {
        const style = getComputedStyle(el);
        return { line: style.textDecorationLine, cursor: style.cursor };
    });

    /** How a set target shows itself: the `▾` after its value, and its surface. */
    const dropdownOf = (selector: string) => page.$eval(selector, el => ({
        after: getComputedStyle(el, '::after').content,
        line: getComputedStyle(el).textDecorationLine,
        surface: getComputedStyle(el).boxShadow !== 'none' || getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)',
    }));

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
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
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
            { el: 'badge', kind: 'set', lens: 's.0', title: 'Set status\nChange the status of FRS-TST-001', tabIndex: 0 },
            // The codicon is left out of the tooltip too.
            { el: 'td:priority', kind: 'set', lens: 'p.0', title: 'Set priority', tabIndex: 0 },
            { el: 'th:verified-by/out', kind: 'go', lens: 'l.0', title: '1 test', tabIndex: 0 },
            // Each side of the symmetric relation its own lens.
            { el: 'th:conflicts-with/out', kind: 'go', lens: 'c.out', title: 'Conflicts with 1', tabIndex: 0 },
            { el: 'th:conflicts-with/in', kind: 'go', lens: 'c.in', title: 'Conflicted by 3', tabIndex: 0 },
        ]);
        assert.deepStrictEqual(await rows(), [{ text: 'Foreign lens', before: 'A plain paragraph.' }],
            'one block, one grammar: no row on the heading; the paragraph\'s foreign lens has its row');
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'placing lenses writes nothing');
    });

    test('at rest a target looks as the preview draws it; a set verb shows a dropdown, a go verb an underline', async () => {
        const BADGE = '.mep-inline-atom.mep-lens-target';
        const PRIORITY = 'tr[data-req-field="priority"] td';
        const LINKS = 'tr[data-req-relation="verified-by"] th';
        for (const selector of [BADGE, PRIORITY]) {
            assert.deepStrictEqual(await dropdownOf(selector), { after: 'none', line: 'none', surface: false }, `${selector} at rest`);
        }
        assert.strictEqual((await decorationOf(LINKS)).line, 'none');

        await page.hover(BADGE);
        assert.deepStrictEqual(await dropdownOf(BADGE), { after: '" ▾"', line: 'none', surface: true }, 'the badge sets: a dropdown');
        assert.strictEqual((await decorationOf(`${BADGE} .req-badge`)).line, 'none');
        assert.strictEqual((await decorationOf(BADGE)).cursor, 'pointer');
        await page.hover(PRIORITY);
        assert.deepStrictEqual(await dropdownOf(PRIORITY), { after: '" ▾"', line: 'none', surface: true }, 'the priority value sets: a dropdown');
        assert.strictEqual((await decorationOf('tr[data-req-field="priority"] th')).line, 'none', 'the label of a set row is not the lens\'s');
        await page.hover(LINKS);
        assert.deepStrictEqual(await decorationOf(LINKS), { line: 'underline', cursor: 'pointer' }, 'the relation label goes: an underline');
        assert.strictEqual((await dropdownOf(LINKS)).after, 'none', 'and no ▾');
        await page.mouse.move(2, 2);
    });

    test('the keyboard\'s focus on a set target shows the same dropdown', async () => {
        await page.focus('tr[data-req-field="priority"] td');
        // `:focus-visible` follows a keyboard focus; a Tab from the previous element makes one.
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.lens ?? null);
        assert.strictEqual(focused, 'p.0');
        assert.strictEqual((await dropdownOf('tr[data-req-field="priority"] td')).after, '" ▾"');
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    });

    test('in the summary a plain click opens a target link, Ctrl+click too, and runs no lens; the label cell runs the group\'s lens', async () => {
        const ROW = 'tr[data-req-relation="verified-by"]';
        await page.hover(`${ROW} a`);
        const link = await page.$eval(`${ROW} a`, a => ({
            cursor: getComputedStyle(a).cursor,
            inTarget: a.closest('.mep-lens-target') !== null,
            tooltip: a.closest('[title]')?.getAttribute('title') ?? null,
        }));
        assert.deepStrictEqual(link, { cursor: 'pointer', inTarget: false, tooltip: null }, 'a link shows its own affordance, not the verb');
        await page.hover(`${ROW} th`);
        assert.strictEqual(await page.$eval(`${ROW} th`, th => (th as HTMLElement).title), '1 test', 'the label names the verb');

        const opens = async () => (await (editor as EditorPage).posted()).filter(m => m.type === 'openLink');
        const beforeRuns = (await runs()).length;
        const beforeOpens = (await opens()).length;
        await clickCentre(`${ROW} a`);
        const box = await (await page.$(`${ROW} a`))?.boundingBox();
        assert.ok(box);
        await page.keyboard.down('Control');
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.keyboard.up('Control');
        await delay(80);
        assert.deepStrictEqual((await opens()).slice(beforeOpens), [{ type: 'openLink', href: 'TST-001.md' }, { type: 'openLink', href: 'TST-001.md' }]);
        assert.deepStrictEqual((await runs()).slice(beforeRuns), [], 'a link click is not the lens\'s');
        assert.strictEqual(await page.evaluate(() => document.querySelector('.mep-injected-block.ProseMirror-selectednode') !== null), false,
            'the click opened the link instead of selecting the table');

        await clickCentre(`${ROW} th`);
        assert.deepStrictEqual((await runs()).slice(beforeRuns), ['l.0']);
        assert.deepStrictEqual(await (editor as EditorPage).edits(), []);
        await page.mouse.move(2, 2);
    });

    test('a collapsed list\'s summary in a row promises no lens: no underline, no tooltip, and a click opens the list', async () => {
        const IN = 'tr[data-req-relation="conflicts-with"][data-req-direction="in"]';
        /** The underline of each part of the row, and the tooltip the pointer on the summary would show. */
        const state = () => page.$eval(IN, row => {
            const line = (el: Element | null) => (el ? getComputedStyle(el).textDecorationLine : null);
            const summary = row.querySelector('summary') as HTMLElement;
            return {
                row: line(row), th: line(row.querySelector('th')), td: line(row.querySelector('td')),
                details: line(row.querySelector('details')), summary: line(summary), list: line(row.querySelector('ul')),
                summaryCursor: getComputedStyle(summary).cursor,
                tooltip: summary.closest('[title]')?.getAttribute('title') ?? null,
                label: (row.querySelector('th') as HTMLElement).title,
            };
        });
        await page.hover(`${IN} summary`);
        assert.deepStrictEqual(await state(), {
            row: 'none', th: 'none', td: 'none', details: 'none', summary: 'none', list: 'none', summaryCursor: 'auto', tooltip: null, label: 'Conflicted by 3',
        }, 'the pointer on the summary shows nothing of the lens');
        await page.hover(`${IN} th`);
        const onHeader = await state();
        assert.deepStrictEqual({ th: onHeader.th, td: onHeader.td, details: onHeader.details, summary: onHeader.summary, list: onHeader.list },
            { th: 'underline', td: 'none', details: 'none', summary: 'none', list: 'none' },
            'on the label cell, the label alone is underlined');

        const before = (await runs()).length;
        await clickCentre(`${IN} summary`);
        assert.deepStrictEqual((await runs()).slice(before), [], 'the summary ran no lens');
        assert.strictEqual(await page.$eval(`${IN} details`, d => (d as HTMLDetailsElement).open), true, 'it opened its list');
        await clickCentre(`${IN} th`);
        assert.deepStrictEqual((await runs()).slice(before), ['c.in'], 'the label runs the incoming side\'s lens');
        await page.mouse.move(2, 2);
    });

    test('a click on the badge or a row\'s label cell runs its lens, and selects nothing', async () => {
        const before = (await runs()).length;
        await clickCentre('.mep-inline-atom.mep-lens-target');
        const selected = await page.evaluate(() => document.querySelector('.mep-inline-atom.ProseMirror-selectednode') !== null);
        assert.strictEqual(selected, false, 'the badge ran its lens instead of being selected');
        await clickCentre('tr[data-req-field="priority"] td');
        await clickCentre('tr[data-req-relation="verified-by"] th');
        await clickCentre('tr[data-req-relation="conflicts-with"][data-req-direction="out"] th');
        assert.deepStrictEqual((await runs()).slice(before), ['s.0', 'p.0', 'l.0', 'c.out']);
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
        assert.deepStrictEqual(await page.$eval(`${BAR} [data-verb="lens-overflow"]`, el => [el.textContent, el.querySelector('.mep-menu-caret .codicon-chevron-down') !== null]), ['Actions', true]);
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
        await page.waitForSelector('tr[data-req-field="priority"] td.mep-lens-target');
        // Out of the heading first: its bar, open since the last test, is not in the way of the click below.
        await page.mouse.click(2, 2);
        await delay(100);
        // A new paragraph after "Intro.": every block after it moves one index on.
        const p = await page.evaluate(() => {
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.textContent === 'Intro.') {
                    const range = document.createRange();
                    range.setStart(node, 5);
                    range.setEnd(node, 6);
                    const r = range.getBoundingClientRect();
                    return { x: r.right - 1, y: r.top + r.height / 2 };
                }
            }
            throw new Error('no "Intro."');
        });
        await page.mouse.click(p.x, p.y);
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Inserted.');
        await settle();
        const typed = (await (editor as EditorPage).edits()).pop()?.text ?? '';
        assert.ok(typed.includes('Intro.\n\nInserted.\n'), `the paragraph went after Intro.: ${JSON.stringify(typed)}`);
        assert.deepStrictEqual((await targets()).map(t => t.lens), ['s.0', 'p.0', 'l.0', 'c.out', 'c.in'],
            `the badge and the rows keep their lenses: ${await page.$eval('.ProseMirror h1', h => h.outerHTML)}`);
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

    test('a title\'s $(icon) is a codicon span before the text; a title without one is text only; a modifier is ignored; the tooltip is plain text', async function () {
        this.timeout(10000);
        await showDocument();
        await send([{ blockIndex: 0, items: [
            { id: 'i.0', title: '$(add) Add reference\u2026', surface: 'action', artifact: 'FRS-TST-001' },
            { id: 'i.1', title: 'Plain verb', surface: 'action', artifact: 'FRS-TST-001' },
            { id: 'i.2', title: '$(sync~spin) Syncing', surface: 'action', artifact: 'FRS-TST-001' },
        ] }]);
        await delay(80);
        assert.deepStrictEqual(await headingBar(), ['mep-object-label', 'lens:i.0', 'lens:i.1', 'lens:i.2']);
        const verb = (id: string) => page.$eval(`${BAR} [data-verb="lens:${id}"]`, el => ({
            nodes: Array.from(el.childNodes, n => n.nodeType === Node.TEXT_NODE ? `#text ${n.textContent}` : (n as HTMLElement).className),
            text: el.textContent,
            title: (el as HTMLElement).title,
        }));
        const add = await verb('i.0');
        assert.deepStrictEqual(add.nodes, ['codicon codicon-add', '#text Add reference\u2026']);
        assert.strictEqual(add.text, 'Add reference\u2026');
        assert.strictEqual(add.title, 'Add reference\u2026 (from another extension)', 'the tooltip has no icon syntax');
        assert.deepStrictEqual((await verb('i.1')).nodes, ['#text Plain verb'], 'no icon, one text node');
        const spin = await verb('i.2');
        assert.deepStrictEqual(spin.nodes, ['codicon codicon-sync', '#text Syncing']);
        assert.strictEqual(spin.title, 'Syncing (from another extension)', 'the tooltip is the plain text of the title');
    });

    test('a code action\'s $(icon) is drawn in the bar; an icon-only one is named by the icon', async function () {
        this.timeout(10000);
        await showDocument();
        await send([{ blockIndex: 0, items: [{ id: 'k.0', title: 'A lens', surface: 'action', artifact: 'FRS-TST-001' }] }]);
        await delay(80);
        const children = await headingBar([
            { id: 'c.0', title: '$(lightbulb) Quick fix', kind: 'quickfix' },
            { id: 'c.1', title: '$(x)', kind: '' },
            { id: 'c.2', title: '\\$(y) escaped', kind: '' },
        ]);
        assert.deepStrictEqual(children, ['mep-object-label', 'lens:k.0', 'mep-object-separator', 'code-action:c.0', 'code-action:c.1', 'code-action:c.2']);
        const verb = (id: string) => page.$eval(`${BAR} [data-verb="code-action:${id}"]`, el => ({
            kids: Array.from(el.childNodes, n => n.nodeType === Node.TEXT_NODE ? `#text ${n.textContent}` : (n as HTMLElement).className),
            title: (el as HTMLElement).title,
            name: el.getAttribute('aria-label'),
        }));
        assert.deepStrictEqual(await verb('c.0'), { kids: ['codicon codicon-lightbulb', '#text Quick fix'], title: 'Quick fix (quickfix, from another extension)', name: null });
        assert.deepStrictEqual(await verb('c.1'), { kids: ['codicon codicon-x'], title: 'x (from another extension)', name: 'x' });
        assert.deepStrictEqual(await verb('c.2'), { kids: ['#text $(y) escaped'], title: '$(y) escaped (from another extension)', name: null });
    });

    test('lenses naming no side take a relation\'s first row, one each: a second for the same row is a verb, not unreachable', async function () {
        this.timeout(10000);
        await send([{
            blockIndex: 0, items: [
                { id: 'o.0', title: 'Conflicts (old)', surface: 'links', artifact: 'FRS-TST-001', relation: 'conflicts-with' },
                { id: 'o.1', title: 'Conflicted by (old)', surface: 'links', artifact: 'FRS-TST-001', relation: 'conflicts-with' },
            ],
        }]);
        await page.waitForSelector('th.mep-lens-target');
        assert.deepStrictEqual((await targets()).map(t => [t.el, t.lens]), [['th:conflicts-with/out', 'o.0']]);
        assert.deepStrictEqual(await headingBar(), ['mep-object-label', 'lens:o.1']);
    });

    test('two headings with one readable id: each heading\'s lenses go on its own badge and table', async function () {
        this.timeout(10000);
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, '# FRS-TST-001: First\n\n# FRS-TST-001: Second\n\nA plain paragraph.\n', {}));
        const content = json.doc.content as { type: string; attrs: Record<string, unknown>; content?: Record<string, unknown>[] }[];
        const badge = (value: string) => ({ type: 'inline_atom', attrs: { html: `<span class="req-badge req-badge-${value}">${value}</span>`, mark: BADGE_MARK } });
        const table = (priority: string) => ({
            type: 'injected_block',
            attrs: { kind: 'atom', mark: BADGE_MARK, html: SUMMARY_HTML.replace('<td>high</td>', `<td>${priority}</td>`), src: null, gap: null },
        });
        for (const [k, title] of [[0, 'First'], [1, 'Second']] as const) {
            content[k].attrs.reqPrefix = 'FRS-TST-001: ';
            content[k].content = [{ type: 'text', text: `${title} ` }, badge(k === 0 ? 'implemented' : 'draft')];
        }
        // Blocks: 0 first heading, 1 its table, 2 second heading, 3 its table, 4 the paragraph.
        content.splice(2, 0, table('low'));
        content.splice(1, 0, table('high'));
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .mep-injected-block').length === 2);
        const lenses = (n: string) => [
            { id: `s.${n}`, title: `Status ${n}`, surface: 'status' as const, artifact: 'FRS-TST-001' },
            { id: `p.${n}`, title: `Priority ${n}`, surface: 'priority' as const, artifact: 'FRS-TST-001' },
        ];
        await send([{ blockIndex: 0, items: lenses('first') }, { blockIndex: 2, items: lenses('second') }]);
        await page.waitForSelector('.mep-lens-target');
        const placed = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror .mep-lens-target'), el => ({
            lens: el.dataset.lens,
            text: el.textContent,
        })));
        assert.deepStrictEqual(placed, [
            { lens: 's.first', text: 'implemented' },
            { lens: 'p.first', text: 'high' },
            { lens: 's.second', text: 'draft' },
            { lens: 'p.second', text: 'low' },
        ]);
        assert.deepStrictEqual(await rows(), [], 'nothing left over for a row');
    });

    test('a status lens goes on the table\'s status row first, and on the badge only where the table has none', async function () {
        this.timeout(15000);
        /** A requirement heading — with or without its badge — and its table, with or without a status row. */
        const show = async (badge: boolean, statusRow: boolean) => {
            await showRequirement({ html: statusRow ? withStatusRow(SUMMARY_HTML) : SUMMARY_HTML, badge, tag: `badge-${badge}-row-${statusRow}`, rowSelector: 'tr[data-req-field="status"]', rowCount: statusRow ? 1 : 0 });
            await send([{ blockIndex: 0, items: [{ id: 'st', title: 'Set status', surface: 'status', artifact: 'FRS-TST-001' }] }], 3);
            // The message is taken asynchronously; the last document's target may still be marked until then.
            await delay(150);
            return (await targets()).map(t => [t.el, t.lens]);
        };
        assert.deepStrictEqual(await show(false, true), [['span:status', 'st']], 'a status row and no badge: the row\'s chip');
        assert.deepStrictEqual(await show(true, false), [['badge', 'st']], 'a badge and no status row: the badge');
        assert.deepStrictEqual(await show(true, true), [['span:status', 'st']], 'both: the row, and the badge stays as it is');
        assert.strictEqual(await page.$eval('.ProseMirror .mep-inline-atom', el => el.classList.contains('mep-lens-target')), false);
        assert.deepStrictEqual(await rows(), []);
    });

    test('a requirement heading with its table and no badge: the status lens on the Status row, the actions in the heading\'s bar', async function () {
        this.timeout(15000);
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        // As the parser leaves it when Req Explorer injects the table alone
        // (`injection.test.ts`): the id lifted by the table's mark, no badge.
        const json = parsedDocumentToJSON(parseDocument(md, '# FRS-TST-001: Page\n\nA plain paragraph.\n', {}));
        const content = json.doc.content as { type: string; attrs: Record<string, unknown>; content?: Record<string, unknown>[] }[];
        content[0].attrs.reqPrefix = 'FRS-TST-001: ';
        content[0].content = [{ type: 'text', text: 'Page' }];
        content.splice(1, 0, { type: 'injected_block', attrs: { kind: 'atom', mark: BADGE_MARK, html: withStatusRow(SUMMARY_HTML), src: null, gap: null } });
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror tr[data-req-field="status"]').length === 1
            && document.querySelector('.ProseMirror .mep-inline-atom') === null);
        await send([{
            blockIndex: 0, items: [
                { id: 'st', title: 'Set status', surface: 'status', artifact: 'FRS-TST-001' },
                { id: 'a.1', title: 'Add test', surface: 'action', artifact: 'FRS-TST-001' },
                { id: 'a.2', title: '+ ref', surface: 'action', artifact: 'FRS-TST-001' },
            ],
        }], 3);
        await delay(150);
        assert.deepStrictEqual((await targets()).map(t => [t.el, t.lens]), [['span:status', 'st']]);
        // The chip in the status row sets: a dropdown, no underline.
        const CHIP = 'tr[data-req-field="status"] .req-badge';
        await page.hover(CHIP);
        assert.deepStrictEqual(await dropdownOf(CHIP), { after: '"\u00a0\u25be"', line: 'none', surface: true });
        await page.mouse.move(2, 2);
        assert.deepStrictEqual(await headingBar(), ['mep-object-label', 'lens:a.1', 'lens:a.2']);
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-label`, el => el.textContent), 'Requirement FRS-TST-001');
        assert.deepStrictEqual(await rows(), []);
    });

    /**
     * The status lens on the standing row of the table (`data-req-standing`, whatever field states it),
     * with `data-req-field="status"` as the fallback for a Req Explorer older than the attribute.
     */
    const withRows = (rowsHtml: string[]) => SUMMARY_HTML.replace('<tbody class="req-summary-fields">', `<tbody class="req-summary-fields">${rowsHtml.join('')}`);
    const standingRow = (field: string, standing: 'authored' | 'derived' | null) =>
        `<tr data-req-field="${field}"${standing ? ` data-req-standing="${standing}"` : ''}><th scope="row">${field}</th><td><span class="req-badge req-badge-implemented">implemented</span></td></tr>`;
    const standingCases: [string, string[], string][] = [
        ['a Stage row that carries data-req-standing is the status lens\'s row', [standingRow('stage', 'derived')], 'span:stage'],
        ['a status row that carries data-req-standing still resolves', [standingRow('status', 'authored')], 'span:status'],
        ['no row carries data-req-standing: the row of the field status, as before', [standingRow('status', null)], 'span:status'],
        ['a status row without the attribute loses to the row that carries it', [standingRow('status', null), standingRow('stage', 'derived')], 'span:stage'],
    ];
    for (const [title, rowsHtml, expected] of standingCases) {
        test(`the status lens goes on the standing row: ${title}`, async function () {
            this.timeout(15000);
            await showRequirement({ html: withRows(rowsHtml), tag: title, rowSelector: 'tr[data-req-field="stage"], .ProseMirror tr[data-req-field="status"]', rowCount: rowsHtml.length });
            await send([{ blockIndex: 0, items: [{ id: 'st', title: 'Set status', surface: 'status', artifact: 'FRS-TST-001' }] }], 3);
            await delay(150);
            assert.deepStrictEqual((await targets()).map(t => [t.el, t.lens]), [[expected, 'st']]);
            assert.deepStrictEqual(await rows(), []);
        });
    }

    test('the lens on a derived standing row goes (underlined, no dropdown), on an authored one it sets', async function () {
        this.timeout(15000);
        const show = async (rowHtml: string, field: string) => {
            await showRequirement({ html: withRows([rowHtml]), tag: `go-${field}`, rowSelector: `tr[data-req-field="${field}"]`, rowCount: 1 });
            await send([{ blockIndex: 0, items: [{ id: 'st', title: 'Show stage', surface: 'status', artifact: 'FRS-TST-001' }] }], 3);
            await delay(150);
            const chip = `tr[data-req-field="${field}"] .req-badge`;
            await page.hover(chip);
            return { kinds: (await targets()).map(t => t.kind), chip: await dropdownOf(chip), line: (await decorationOf(chip)).line };
        };
        const derived = await show(standingRow('stage', 'derived'), 'stage');
        assert.deepStrictEqual(derived.kinds, ['go']);
        assert.strictEqual(derived.chip.after, 'none', 'no dropdown affordance on a derived row');
        assert.strictEqual(derived.chip.surface, false, 'and no ring: one signifier, not both');
        assert.strictEqual(derived.line, 'underline');
        assert.deepStrictEqual((await show(standingRow('status', 'authored'), 'status')).kinds, ['set']);
    });
});
