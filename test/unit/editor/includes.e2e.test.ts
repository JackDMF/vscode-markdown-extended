import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { NO_INCLUDES_REFUSAL } from '../../../src/editor/webview/toolbar/actions';
import { EXTENSION_ID, EditMessage, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type PickIncludeMessage = Extract<WebviewMessage, { type: 'pickInclude' }>;

/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/** A directive as a provider would offer it. The page never reads it: it is test data standing for Req Explorer's syntax. */
const LEGAL = '<!-- include: legal-notice -->';
const GLOSSARY = '<!-- include: glossary -->';

/**
 * Include insertion in the real page: **Insert → Include…** and an
 * expansion's **Change snippet…** ask the host (`pickInclude`), whose answer
 * (`includeChosen`) the test gives as the host would after the person chose in
 * VS Code's QuickPick; the page writes the line it is given and asks for a
 * reparse. Neither is offered while the host says no extension offers includes.
 */
suite('Editor includes (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const posted = () => (editor as EditorPage).posted();
    const picks = async () => (await posted()).filter((m): m is PickIncludeMessage => m.type === 'pickInclude');
    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    const showText = async (text: string, includes: boolean) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Alpha'));
        await delay(100);
    };

    /** A document holding one expansion between two paragraphs, as the parser leaves it with Req Explorer's plugin (not in the test host). */
    const showExpansion = async (includes: boolean) => {
        version++;
        const doc = {
            type: 'doc',
            content: [
                { type: 'paragraph', attrs: { src: 'Before.\n', gap: '' }, content: [{ type: 'text', text: 'Before.' }] },
                {
                    type: 'injected_block',
                    attrs: {
                        kind: 'expansion',
                        mark: { rule: 'req-includes', kind: 'expansion', snippet: 'legal-notice', line: 2, path: 'C:\\corpus\\snippets\\legal-notice.md' },
                        html: '<p>Snippet body.</p>',
                        src: `${LEGAL}\n`,
                        gap: '\n',
                    },
                },
                { type: 'paragraph', attrs: { src: 'After.\n', gap: '\n' }, content: [{ type: 'text', text: 'After.' }] },
            ],
        };
        await (editor as EditorPage).send({ type: 'document', json: { doc, eol: '\n', tail: '' }, version, defaultWrap: 90, includes });
        await page.waitForFunction(() => document.querySelector('.ProseMirror .mep-injected-block')?.textContent?.includes('Snippet body.'));
        await delay(100);
    };

    const clickIn = async (needle: string) => {
        const point = await page.evaluate(n => {
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
            throw new Error(`no "${n}" in the document`);
        }, needle);
        await page.mouse.click(point.x, point.y);
        await delay(100);
    };

    const openInsert = async () => {
        await page.click('.mep-toolbar .mep-menu-face[data-menu="insert"]');
        await page.waitForSelector('.mep-menu[data-menu="insert"]:not([hidden])');
    };
    const includeEntry = '.mep-menu [data-action="include"]';
    const entryState = () => page.$eval(includeEntry, el => ({ disabled: el.getAttribute('aria-disabled'), title: (el as HTMLElement).title }));

    /** Select the expansion with a click, and wait for its bar. */
    const selectExpansion = async () => {
        await page.click('.mep-injected-block .mep-atom-content');
        await page.waitForSelector(`${BAR}[data-object="injected_block"]`, { timeout: 2000 });
    };
    const verbState = (verb: string) => page.$eval(`${BAR} [data-verb="${verb}"]`, el => ({ disabled: el.getAttribute('aria-disabled'), title: (el as HTMLElement).title }));

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1000 });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    teardown(async () => {
        // No menu left open for the next test.
        await page.mouse.click(980, 880);
    });

    test('Insert → Include… is disabled, saying why, while no extension offers includes; enabled when one does', async function () {
        this.timeout(10000);
        await showText('Alpha.\n\nOmega.\n', false);
        await clickIn('Alpha');
        await openInsert();
        const off = await entryState();
        assert.strictEqual(off.disabled, 'true');
        assert.ok(off.title.includes(NO_INCLUDES_REFUSAL), off.title);
        const before = (await picks()).length;
        await page.click(includeEntry);
        await delay(100);
        assert.strictEqual((await picks()).length, before, 'a disabled entry asks nothing');

        await page.mouse.click(980, 880);
        await showText('Alpha.\n\nOmega.\n', true);
        await clickIn('Alpha');
        await openInsert();
        const on = await entryState();
        assert.strictEqual(on.disabled, 'false');
        assert.ok(!on.title.includes(NO_INCLUDES_REFUSAL), on.title);
    });

    test('choosing Include… asks the host; the line it answers with goes after the current block, sent with reparse', async function () {
        this.timeout(10000);
        await showText('Alpha.\n\nOmega.\n', true);
        await clickIn('Alpha');
        const edits = (await (editor as EditorPage).edits()).length;
        await openInsert();
        await page.click(includeEntry);
        await delay(100);
        const pick = (await picks()).pop();
        assert.ok(pick, 'pickInclude posted');
        assert.strictEqual(pick.replace, undefined, 'a new include replaces nothing');
        assert.strictEqual((await (editor as EditorPage).edits()).length, edits, 'nothing is written before the host answers');

        await (editor as EditorPage).send({ type: 'includeChosen', requestId: pick.requestId, insert: LEGAL });
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, `Alpha.\n\n${LEGAL}\n\nOmega.\n`, 'written as given, after the paragraph the caret is in');
        assert.strictEqual(edit.reparse, true, 'the host parses it into the expansion');
        assert.strictEqual(edit.baseVersion, version);
    });

    test('a dismissed pick writes nothing, and an answer to no request is ignored', async function () {
        this.timeout(10000);
        await showText('Alpha.\n\nOmega.\n', true);
        await clickIn('Omega');
        await openInsert();
        await page.click(includeEntry);
        await delay(100);
        const pick = (await picks()).pop();
        assert.ok(pick);
        const edits = (await (editor as EditorPage).edits()).length;
        await (editor as EditorPage).send({ type: 'includeChosen', requestId: pick.requestId });
        await (editor as EditorPage).send({ type: 'includeChosen', requestId: pick.requestId + 1000, insert: LEGAL });
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, edits);
    });

    test('Change snippet… on an expansion asks for its block and replaces its directive line with the answer, sent with reparse', async function () {
        this.timeout(10000);
        await showExpansion(true);
        await selectExpansion();
        assert.strictEqual((await verbState('change-snippet')).disabled, 'false');
        await page.click(`${BAR} [data-verb="change-snippet"]`);
        await delay(100);
        const pick = (await picks()).pop();
        assert.ok(pick);
        assert.deepStrictEqual(pick.replace, { blockIndex: 1 });

        await (editor as EditorPage).send({ type: 'includeChosen', requestId: pick.requestId, insert: GLOSSARY });
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, `Before.\n\n${GLOSSARY}\n\nAfter.\n`, 'only the directive line changed, its gap and terminator kept');
        assert.strictEqual(edit.reparse, true);
    });

    test('Change snippet… is disabled, saying why, while no extension offers includes', async function () {
        this.timeout(10000);
        await showExpansion(false);
        await selectExpansion();
        const verb = await verbState('change-snippet');
        assert.strictEqual(verb.disabled, 'true');
        assert.ok(verb.title.includes(NO_INCLUDES_REFUSAL), verb.title);
    });
});
