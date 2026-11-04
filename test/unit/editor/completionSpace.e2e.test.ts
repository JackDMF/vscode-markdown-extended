import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { EXTENSION_ID, EditorPage, closeEditorPage, delay, openEditorPage, settle } from './pageHarness';

type Posted<T extends WebviewMessage['type']> = Extract<WebviewMessage, { type: T }>;

/**
 * A space held for the completion list (`webview/completion.ts`) and the
 * documents the host posts after it, with the host's half played by the test:
 * a document parsed from a text that held the space has the space taken out
 * of the block it was typed in — and of no other block, however alike (review
 * 2 of #29, S1–S5). Each case on a page of its own.
 */
suite('Editor completion: a held space and the host\'s documents (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let md: MarkdownIt;
    let version = 0;

    const posted = (): Promise<WebviewMessage[]> => (editor as EditorPage).posted();
    const count = async () => (await posted()).length;
    const edits = async (after = 0) => (await posted()).slice(after).filter((m): m is Posted<'edit'> => m.type === 'edit').map(m => m.text);
    const show = async (text: string) => {
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await delay(150);
    };
    const waitFor = async <T extends WebviewMessage['type']>(type: T, after: number): Promise<Posted<T>> => {
        const end = Date.now() + 3000;
        for (;;) {
            const found = (await posted()).slice(after).filter((m): m is Posted<T> => m.type === type).pop();
            if (found) {
                return found;
            }
            assert.ok(Date.now() < end, `the page posts ${type}`);
            await delay(20);
        }
    };
    /** The caret to the end of the paragraph `selector` names. */
    const toEndOf = async (selector: string) => {
        await page.click(selector);
        await page.keyboard.press('End');
        await delay(60);
    };
    /** A space typed there: the question it asks, and the text the page sent with it. */
    const space = async () => {
        const before = await count();
        await page.keyboard.type(' ');
        const asked = await waitFor('complete', before);
        const sent = (await edits(before)).pop();
        assert.ok(sent !== undefined, 'the edit before the question');
        return { asked, sent };
    };

    setup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ builtinMarkdown: false });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        md ??= await buildEditorEngine(EXTENSION_ID, () => undefined);
        version = 0;
    });

    teardown(async function () {
        await closeEditorPage(this, editor);
        editor = undefined;
    });

    /**
     * S1–S3: a space let go long ago (nobody answered, more was typed); a
     * later document from the host, whatever brought it, leaves an untouched
     * block alone that reads like the typed one and has a space at its end.
     */
    for (const [name, source] of [
        ['S1 a paragraph', 'Siehe\n\nSiehe \n\nEnde.\n'],
        ['S2 a list item, the list written loosely', 'Siehe\n\n*   Siehe \n*   zwei\n    weiter\n\nEnde.\n'],
        ['S3 a quote', 'Siehe\n\n>Siehe \n>zweite Zeile\n\nEnde.\n'],
    ] as const) {
        test(`${name}: a later document leaves an untouched twin with a space at its end as written`, async function () {
            this.timeout(20000);
            await show(source);
            await page.waitForSelector('.ProseMirror');
            await toEndOf('.ProseMirror > p');
            const { asked } = await space();
            await (editor as EditorPage).send({ type: 'completions', requestId: asked.requestId, version, incomplete: false, items: [] });
            await delay(150);
            await page.keyboard.type('x');
            await settle();
            const host = (await edits()).pop() as string;
            assert.ok(host.startsWith('Siehe x\n\n'), JSON.stringify(host));
            assert.strictEqual(host.slice('Siehe x'.length), source.slice('Siehe'.length), 'the twin as written');
            const before = await count();
            await show(host);
            await settle();
            assert.deepStrictEqual(await edits(before), [], 'nothing rewritten');
        });
    }

    /** S4, S5: a document while the question is on its way, its text holding the space; an untouched twin elsewhere keeps its own. */
    for (const [name, source, typed, expected] of [
        ['S4 the twin before it', 'Lies 1. \n\nMitte.\n\nLies 1.\n', '.ProseMirror > p:last-of-type', 'Lies 1. \n\nMitte.\n\nLies 1.\n'],
        ['S5 the twin after it', 'Lies 1.\n\nMitte.\n\nLies 1. \n', '.ProseMirror > p', 'Lies 1.\n\nMitte.\n\nLies 1. \n'],
    ] as const) {
        test(`${name}: a document parsed with the held space drops it from the typed paragraph only`, async function () {
            this.timeout(20000);
            await show(source);
            await page.waitForSelector('.ProseMirror');
            await toEndOf(typed);
            const { asked, sent } = await space();
            assert.strictEqual(sent, 'Lies 1. \n\nMitte.\n\nLies 1. \n', 'the space held in the edit');
            const before = await count();
            await show(sent);
            await (editor as EditorPage).send({ type: 'completions', requestId: asked.requestId, version: version - 1, incomplete: false, items: [] });
            await settle();
            assert.deepStrictEqual(await edits(before), [expected]);
        });
    }
});
