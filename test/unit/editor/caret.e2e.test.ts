import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { EXTENSION_ID, EditorPage, openEditorPage, settle } from './pageHarness';

const SOURCE = 'Intro paragraph.\n\nSecond *paragraph* here.\n\n| a | b |\n| = | = |\n| 1 | 2 |\n';

type CaretMessage = Extract<WebviewMessage, { type: 'caret' }>;

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * The caret the real page reports (`webview/caret.ts` over `positions.ts`):
 * where a click and the keyboard put it, in the text the host holds, and
 * behind the edit that carries it. Skips without a browser, as every e2e suite.
 */
suite('Editor caret (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;

    const posted = (): Promise<WebviewMessage[]> => (editor as EditorPage).posted();
    const carets = async () => (await posted()).filter((m): m is CaretMessage => m.type === 'caret');
    const lastCaret = async () => (await carets()).pop();

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        await editor.send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, SOURCE, {})), version: 1, defaultWrap: 90, includes: false });
        await page.waitForSelector('.ProseMirror');
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('a click and the keys put the caret where the source has it; typing reports it behind the edit', async function () {
        this.timeout(20000);
        await page.click('.ProseMirror > p:nth-of-type(2)');
        await page.keyboard.press('Home');
        await delay(250);
        assert.deepStrictEqual(await lastCaret(), { type: 'caret', baseVersion: 1, position: { line: 2, character: 0 } });

        await page.keyboard.type('X');
        await delay(150);
        assert.deepStrictEqual((await lastCaret())?.position, { line: 2, character: 0 }, 'held while the edit waits in its delay');
        await settle();
        const messages = await posted();
        const lastEdit = messages.map(m => m.type).lastIndexOf('edit');
        const last = messages.map(m => m.type).lastIndexOf('caret');
        assert.ok(lastEdit >= 0 && last > lastEdit, `the caret goes after the edit: ${JSON.stringify(messages.map(m => m.type))}`);
        assert.deepStrictEqual((messages[last] as CaretMessage).position, { line: 2, character: 1 });

        await page.keyboard.press('End');
        await delay(250);
        assert.deepStrictEqual((await lastCaret())?.position, { line: 2, character: 'XSecond *paragraph* here.'.length });
    });

    test('a map request is answered from the page\'s own document, after the edit it was typing', async function () {
        this.timeout(20000);
        // The page now reads `XSecond *paragraph* here.` on line 2; its paragraph's text starts at 19.
        await page.click('.ProseMirror > p:nth-of-type(2)');
        await page.keyboard.press('Home');
        await page.keyboard.type('Y');
        await editor?.send({ type: 'map', id: 7, toSource: [22, 10_000], toPage: [{ line: 2, character: 3 }, { line: 2, character: 99 }] });
        await delay(100);
        const messages = await posted();
        const answer = messages.find((m): m is Extract<WebviewMessage, { type: 'mapped' }> => m.type === 'mapped' && m.id === 7);
        assert.deepStrictEqual(answer, {
            type: 'mapped',
            id: 7,
            baseVersion: 1,
            toSource: [{ line: 2, character: 3, approximate: false }, null],
            toPage: [{ pos: 22, approximate: false }, { pos: 19 + 'YXSecond paragraph here.'.length, approximate: true }],
        });
        const types = messages.map(m => (m.type === 'mapped' ? `mapped:${m.id}` : m.type));
        assert.ok(types.lastIndexOf('edit') >= 0 && types.lastIndexOf('edit') < types.indexOf('mapped:7'),
            `the typed Y went to the host before the answer: ${JSON.stringify(types)}`);
    });

    test('a selected source block is no caret', async function () {
        this.timeout(20000);
        await page.click('.mep-raw-block');
        await delay(250);
        assert.deepStrictEqual((await lastCaret())?.position, null);
    });
});
