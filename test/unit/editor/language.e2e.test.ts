import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { HostMessage, WebviewMessage } from '../../../src/editor/protocol';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { EditorPage, EXTENSION_ID, openEditorPage, settle, showDiagnostics } from './pageHarness';

const LINE_2 = 'The installer checks the prerequisites before it copies anything.';
const SOURCE = [
    '# Release notes',
    '',
    LINE_2,
    '',
    'A paragraph with a stylesheeet typo.',
    '',
    '<div class="box">',
    '  <b>raw</b> html',
    '</div>',
    '',
].join('\n');

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

type Posted<T extends WebviewMessage['type']> = Extract<WebviewMessage, { type: T }>;

/**
 * Completion, diagnostics and hover in the real page (`webview/completion.ts`,
 * `diagnostics.ts`, `hover.ts`), with the host's half played by the test: a
 * list opening on a trigger and accepting through the source, a squiggle and
 * the toolbar's count, the cards and their links, `Esc` closing each.
 */
suite('Editor completion, diagnostics and hover (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let md: MarkdownIt;
    let version = 1;

    const posted = (): Promise<WebviewMessage[]> => (editor as EditorPage).posted();
    const last = async <T extends WebviewMessage['type']>(type: T): Promise<Posted<T> | undefined> =>
        (await posted()).filter((m): m is Posted<T> => m.type === type).pop();
    const waitFor = async <T extends WebviewMessage['type']>(type: T, after: number, timeoutMs = 3000): Promise<Posted<T>> => {
        const end = Date.now() + timeoutMs;
        for (;;) {
            const found = (await posted()).slice(after).filter((m): m is Posted<T> => m.type === type).pop();
            if (found || Date.now() > end) {
                assert.ok(found, `the page posts ${type}: ${JSON.stringify((await posted()).slice(after).map(m => m.type))}`);
                return found;
            }
            await delay(25);
        }
    };
    const count = async () => (await posted()).length;
    const send = (m: HostMessage) => (editor as EditorPage).send(m);
    const showText = async (text: string) => {
        version++;
        await send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false });
    };
    /** The centre of `word`'s first occurrence in the editor's text, in viewport coordinates. */
    const centreOf = (word: string) => page.evaluate(w => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = (n.nodeValue ?? '').indexOf(w);
            if (at >= 0) {
                const range = document.createRange();
                range.setStart(n, at);
                range.setEnd(n, at + w.length);
                const r = range.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
        }
        return null;
    }, word);
    const rest = async (word: string) => {
        await page.mouse.move(5, 5);
        await delay(50);
        const at = await centreOf(word);
        assert.ok(at, `the page shows ${word}`);
        await page.mouse.move(at.x - 3, at.y);
        await page.mouse.move(at.x, at.y);
        await delay(700);
    };
    const cardVisible = () => page.$eval('.mep-language-card', el => !(el as HTMLElement).hidden);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        await send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, SOURCE, {})), version, defaultWrap: 90, includes: false });
        await page.waitForSelector('.ProseMirror');
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('a trigger character asks behind the edit; the list opens under the caret, filters, and accepting goes through the source', async function () {
        this.timeout(20000);
        await page.click('.ProseMirror > p');
        await page.keyboard.press('End');
        const before = await count();
        // Req Explorer's case: an id's prefix, whose `-` is the trigger; the letters before it ask nothing.
        await page.keyboard.type(' FRS-');
        const asked = await waitFor('complete', before);
        assert.strictEqual(asked.triggerCharacter, '-');
        assert.strictEqual(asked.baseVersion, version);
        assert.deepStrictEqual(asked.position, { line: 2, character: LINE_2.length + 5 });
        const types = (await posted()).slice(before).map(m => m.type);
        assert.strictEqual(types.filter(t => t === 'complete').length, 1, `one question: ${JSON.stringify(types)}`);
        assert.ok(types.indexOf('edit') >= 0 && types.indexOf('edit') < types.indexOf('complete'), `the typing went first: ${JSON.stringify(types)}`);

        const r = { start: { line: 2, character: LINE_2.length + 1 }, end: { line: 2, character: LINE_2.length + 5 } };
        await send({
            type: 'completions', requestId: asked.requestId, version, incomplete: false, items: [
                { label: 'FRS-RXE-057', detail: 'Generated requirement summary', kind: 'reference', insertText: 'FRS-RXE-057', range: r },
                { label: 'FRS-RXE-058', detail: 'Composed deliverable', kind: 'reference', insertText: 'FRS-RXE-058', range: r },
                { label: 'FRS-API-001', detail: 'Public interface', kind: 'reference', insertText: 'FRS-API-001', range: r },
                { label: 'NFR-RXE-001', detail: 'Startup time', kind: 'reference', insertText: 'NFR-RXE-001', range: r },
            ],
        });
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        const rows = () => page.$$eval('.mep-caret-completions .mep-completion-label', els => els.map(el => el.textContent));
        assert.deepStrictEqual(await rows(), ['FRS-RXE-057', 'FRS-RXE-058', 'FRS-API-001'], 'filtered by what the range holds: FRS-');
        assert.strictEqual(await page.$eval('.mep-caret-completions .mep-completion.mep-chosen .mep-completion-label', el => el.textContent), 'FRS-RXE-057', 'the first row chosen');
        assert.strictEqual(await page.$eval('.mep-caret-completions .mep-completions-keys', el => el.textContent), '↹ ↵ accept · Esc close');

        await page.keyboard.type('R');
        await page.waitForFunction(() => document.querySelectorAll('.mep-caret-completions .mep-completion').length === 2);
        assert.deepStrictEqual(await rows(), ['FRS-RXE-057', 'FRS-RXE-058'], 'a letter filters, and asks nothing');
        assert.strictEqual((await posted()).slice(before).filter(m => m.type === 'complete').length, 1);

        await page.keyboard.press('ArrowDown');
        const beforeAccept = await count();
        await page.keyboard.press('Enter');
        const accepted = await waitFor('applyCompletion', beforeAccept);
        assert.deepStrictEqual([accepted.requestId, accepted.index, accepted.baseVersion], [asked.requestId, 1, version], 'the host\'s index of the chosen row');
        assert.deepStrictEqual(accepted.position, { line: 2, character: LINE_2.length + 6 });
        assert.strictEqual(await page.$('.mep-caret-completions'), null, 'the list closes');
        assert.ok(!(await page.$eval('.ProseMirror > p', el => el.textContent ?? '')).includes('RXE'), 'the page writes nothing itself');

        // The host applies the item to the source and posts the document, then the caret.
        const applied = SOURCE.replace(LINE_2, `${LINE_2} FRS-RXE-058`);
        await showText(applied);
        await send({ type: 'completionApplied', requestId: asked.requestId, version, caret: { line: 2, character: `${LINE_2} FRS-RXE-058`.length } });
        await page.waitForFunction(t => document.querySelector('.ProseMirror > p')?.textContent === t, {}, `${LINE_2} FRS-RXE-058`);
        await page.keyboard.type('!');
        await settle();
        assert.ok((await last('edit'))?.text.includes('FRS-RXE-058!'), 'the caret stands where the host said the insertion ends');
    });

    test('Ctrl+Space asks with no trigger; Esc closes the list and accepts nothing', async function () {
        this.timeout(20000);
        // The `!` typed above asked too: answered, as the host always answers, so no question is in flight.
        const pending = await last('complete');
        if (pending) {
            await send({ type: 'completions', requestId: pending.requestId, version, incomplete: false, items: [] });
        }
        await showText(SOURCE);
        await page.click('.ProseMirror > p');
        await page.keyboard.press('End');
        const before = await count();
        await page.keyboard.down('Control');
        await page.keyboard.press('Space');
        await page.keyboard.up('Control');
        const asked = await waitFor('complete', before);
        assert.strictEqual(asked.triggerCharacter, undefined);
        const at = { line: 2, character: LINE_2.length };
        await send({ type: 'completions', requestId: asked.requestId, version, incomplete: false, items: [{ label: 'one', insertText: 'one', range: { start: at, end: at } }] });
        await page.waitForSelector('.mep-caret-completions');
        await page.keyboard.press('Escape');
        assert.strictEqual(await page.$('.mep-caret-completions'), null);
        await delay(100);
        assert.ok(!(await posted()).slice(before).some(m => m.type === 'applyCompletion'));
    });

    test('an answer to an older question, or for another document, opens nothing', async function () {
        this.timeout(20000);
        await page.click('.ProseMirror > p');
        await page.keyboard.press('End');
        const before = await count();
        await page.keyboard.type(':');
        const asked = await waitFor('complete', before);
        const at = { line: 2, character: LINE_2.length + 1 };
        const items = [{ label: 'stale', insertText: 'stale', range: { start: at, end: at } }];
        await send({ type: 'completions', requestId: asked.requestId - 1, version, incomplete: false, items });
        await send({ type: 'completions', requestId: asked.requestId, version: version - 1, incomplete: false, items });
        await delay(150);
        assert.strictEqual(await page.$('.mep-caret-completions'), null);
        await page.keyboard.press('Backspace');
        await settle();
    });

    test('diagnostics: a squiggle on the mapped range, a source block marked whole, one marker per block, the count at the toolbar\'s end', async function () {
        this.timeout(20000);
        await showText(SOURCE);
        await settle();
        await showDiagnostics(editor as EditorPage, version, [
            { range: { start: { line: 4, character: 19 }, end: { line: 4, character: 30 } }, severity: 'warning', message: 'Unknown word: stylesheeet', code: 'cSpell', source: 'Spelling' },
            { range: { start: { line: 7, character: 2 }, end: { line: 7, character: 3 } }, severity: 'error', message: 'Raw HTML is not checked', source: 'Lint' },
        ]);
        await page.waitForSelector('.mep-diag-warning');
        assert.strictEqual(await page.$eval('.mep-diag-warning', el => el.textContent), 'stylesheeet');
        assert.strictEqual(await page.$$eval('.mep-diag-block-error', els => els.length), 1);
        assert.ok(await page.$eval('.mep-diag-block-error', el => !!el.querySelector('.box') || el.classList.contains('box')), 'the source block');
        assert.deepStrictEqual(await page.$$eval('.mep-diag-marker', els => els.map(el => el.getAttribute('aria-label'))), ['1 warning', '1 error']);
        const parts = await page.$$eval('.mep-toolbar .mep-row-status .mep-diag-count .mep-diag-count-part', els => els.map(el => el.textContent));
        assert.deepStrictEqual(parts, ['1', '1'], 'one error, one warning, at the row\'s right end');
        assert.deepStrictEqual(await page.$$eval('.mep-diag-count .codicon', els => els.map(el => el.className)), ['codicon codicon-error', 'codicon codicon-warning']);
        assert.strictEqual(await page.$eval('.mep-diag-count', el => el.getAttribute('title')), 'Open Problems', 'the count says what a click does');
        const before = await count();
        await page.click('.mep-diag-count');
        await waitFor('showProblems', before);
    });

    test('resting on a squiggle shows its card, asks for its quick fixes, and a fix runs through the host; Esc closes the card', async function () {
        this.timeout(20000);
        const before = await count();
        await rest('stylesheeet');
        assert.ok(await cardVisible(), 'the card shows at once, with what the page knows');
        assert.ok((await page.$eval('.mep-language-card', el => el.textContent ?? '')).includes('Unknown word: stylesheeet'));
        const asked = await waitFor('quickFixesFor', before);
        assert.deepStrictEqual(asked.range, { start: { line: 4, character: 19 }, end: { line: 4, character: 30 } });
        await send({ type: 'quickFixes', requestId: asked.requestId, items: [{ id: 'q9.0', title: 'Change to "stylesheet"', kind: 'quickfix' }] });
        await page.waitForSelector('.mep-language-card .mep-card-action');
        const beforeRun = await count();
        await page.click('.mep-language-card .mep-card-action');
        const run = await waitFor('runAction', beforeRun);
        assert.strictEqual(run.id, 'q9.0');
        assert.strictEqual(await cardVisible(), false, 'the card goes once a fix is chosen');

        await rest('stylesheeet');
        assert.ok(await cardVisible());
        await page.keyboard.press('Escape');
        assert.strictEqual(await cardVisible(), false);
    });

    test('after an edit before a squiggle, its quick fixes are asked for where the squiggle now is', async function () {
        this.timeout(20000);
        const at = await centreOf('A paragraph');
        assert.ok(at);
        await page.mouse.click(at.x, at.y);
        await page.keyboard.press('Home');
        await page.keyboard.type('X');
        await settle();
        const before = await count();
        await rest('stylesheeet');
        const asked = await waitFor('quickFixesFor', before);
        assert.deepStrictEqual(asked.range, { start: { line: 4, character: 20 }, end: { line: 4, character: 31 } }, 'moved with the typed X, not the range the host sent');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Backspace');
        await settle();
    });

    test('resting on text asks the hover providers; the card\'s command links post to the host; Esc closes it', async function () {
        this.timeout(20000);
        const before = await count();
        await rest('installer');
        const asked = await waitFor('hover', before);
        assert.strictEqual(asked.baseVersion, version);
        assert.strictEqual(asked.position.line, 2);
        await send({
            type: 'hoverResult', requestId: asked.requestId,
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 13 } },
            html: '<div class="mep-hover-part"><p><strong>installer</strong> — the setup program</p>'
                + '<p><a href="#" data-mep-command="7.0">Read</a> · <a href="#" data-mep-command="7.1">Show in graph</a> · <a href="command:sneaky">Sneaky</a></p></div>',
        });
        await page.waitForFunction(() => {
            const card = document.querySelector('.mep-language-card') as HTMLElement | null;
            return card !== null && !card.hidden && card.textContent?.includes('the setup program');
        });
        assert.strictEqual(await page.$$eval('.mep-language-card a[href^="command:"]', els => els.length), 0, 'a command link the host did not register has no target');
        const beforeRun = await count();
        await page.click('.mep-language-card a[data-mep-command="7.1"]');
        const run = await waitFor('runHoverCommand', beforeRun);
        assert.strictEqual(run.id, '7.1');

        await rest('prerequisites');
        const again = await waitFor('hover', beforeRun);
        await send({ type: 'hoverResult', requestId: again.requestId, html: '<div class="mep-hover-part"><p>Prerequisites</p></div>' });
        await page.waitForFunction(() => !(document.querySelector('.mep-language-card') as HTMLElement).hidden);
        await page.keyboard.press('Escape');
        assert.strictEqual(await cardVisible(), false);
        await send({ type: 'hoverResult', requestId: asked.requestId, html: '<div class="mep-hover-part"><p>Late</p></div>' });
        await delay(100);
        assert.strictEqual(await cardVisible(), false, 'an answer for a card no longer shown is dropped');
    });

    test('a squiggle inside a table cell is drawn on the cell\'s text, the table carrying one marker', async function () {
        this.timeout(20000);
        const table = ['| Field | Value |', '| - | - |', '| Status | implemnted |', ''].join('\n');
        await showText(table);
        await settle();
        await showDiagnostics(editor as EditorPage, version, [
            { range: { start: { line: 2, character: 11 }, end: { line: 2, character: 21 } }, severity: 'warning', message: 'Unknown word: implemnted' },
        ]);
        await page.waitForSelector('td .mep-diag-warning');
        assert.strictEqual(await page.$eval('td .mep-diag-warning', el => el.textContent), 'implemnted');
        assert.strictEqual(await page.$$eval('.mep-diag-marker', els => els.length), 1);
        assert.strictEqual(await page.$$eval('.mep-diag-block', els => els.length), 0, 'an exact range in a cell is no whole-block mark');
    });
});
