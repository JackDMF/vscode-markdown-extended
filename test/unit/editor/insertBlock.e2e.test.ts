import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { MOD, EXTENSION_ID, EditMessage, EditorPage, clickText, closeEditorPage, delay, editCommand, openEditorPage, settle } from './pageHarness';

type BlockInserted = Extract<WebviewMessage, { type: 'blockInserted' }>;
type CaretMessage = Extract<WebviewMessage, { type: 'caret' }>;

const SOURCE = 'Intro paragraph.\n\nSecond paragraph here.\n\nLast paragraph.\n';
/** A Bible quote block as the Studienhilfe writes it. */
const QUOTE = '> ## Römer 12:2 {.nwtsty}\n> Text';
const WITH_QUOTE = 'Intro paragraph.\n\nSecond paragraph here.\n\n> ## Römer 12:2 {.nwtsty}\n> Text\n\nLast paragraph.\n';

/**
 * `visualEditor.insertBlock` in the real page (MR 2 of the Studienhilfe plan,
 * step 7): the host's `insertBlock` is sent as the session sends it, and the
 * test plays the host's half after — it applies the edit and posts its parse,
 * as `applyEdit` does for an edit with `reparse`. Risk 1 of the plan: Ctrl+Z
 * after that parse takes the block out again, although the parse put other
 * nodes in place of the source block, outside the history. Each case on a page
 * of its own. Skips without a browser, as every e2e suite.
 */
suite('Editor insertBlock (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;
    let requestSeq = 0;

    const posted = (): Promise<WebviewMessage[]> => (editor as EditorPage).posted();
    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();
    const carets = async () => (await posted()).filter((m): m is CaretMessage => m.type === 'caret');

    /** The host posts `text`, parsed by the editor's engine, as the next version. */
    const showDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await delay(100);
    };

    /** The host's `insertBlock`, as the session posts it; the page's answer. */
    const insert = async (src: string, focus = false, expires = Date.now() + 1000): Promise<BlockInserted> => {
        const requestId = ++requestSeq;
        await (editor as EditorPage).send({ type: 'insertBlock', requestId, src, focus, expires });
        await page.waitForFunction(id => (window as unknown as { posted: { type: string; requestId?: number }[] }).posted
            .some(m => m.type === 'blockInserted' && m.requestId === id), { timeout: 2000 }, requestId);
        return (await posted()).find((m): m is BlockInserted => m.type === 'blockInserted' && m.requestId === requestId) as BlockInserted;
    };

    /** The host's half after an inserting edit: it applies it and posts its parse (`applyEdit` with `reparse`). */
    const hostReparses = async (): Promise<string> => {
        const edit = await lastEdit();
        assert.ok(edit?.reparse, 'the insertion asks for a re-parse');
        await showDocument(edit.text);
        return edit.text;
    };

    const undoKey = async () => {
        await page.keyboard.down(MOD);
        await page.keyboard.press('z');
        await page.keyboard.up(MOD);
    };

    const redoKey = async () => {
        await page.keyboard.down(MOD);
        await page.keyboard.down('Shift');
        await page.keyboard.press('z');
        await page.keyboard.up('Shift');
        await page.keyboard.up(MOD);
    };

    setup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1000 });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        version = 0;
        await showDocument(SOURCE);
        await page.waitForSelector('.ProseMirror');
    });

    teardown(async function () {
        await closeEditorPage(this, editor);
        editor = undefined;
    });

    test('the block goes after the paragraph with the caret, one edit with a blank line before it; Ctrl+Z after the host\'s parse takes it out byte for byte, redo brings it back', async function () {
        this.timeout(20000);
        await clickText(page, 'Second', 3);
        const answer = await insert(QUOTE);
        assert.strictEqual(answer.inserted, true);
        const messages = await posted();
        const types = messages.map(m => m.type);
        assert.ok(types.lastIndexOf('edit') < types.lastIndexOf('blockInserted'), `the answer goes behind the edit: ${JSON.stringify(types)}`);
        assert.strictEqual(await hostReparses(), WITH_QUOTE);
        await page.waitForSelector('.ProseMirror > blockquote');
        assert.strictEqual(await page.$('.ProseMirror > .mep-raw-block'), null, 'the parse put a quote in place of the source block');

        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, SOURCE, 'Ctrl+Z took the block out, and nothing else');
        assert.strictEqual(await page.$('.ProseMirror > blockquote'), null);

        await redoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, WITH_QUOTE, 'redo brings it back as the parse had it');
    });

    test('two letters typed and the block inserted at once: both letters and the block reach the host, in one edit; one Ctrl+Z takes the block only', async function () {
        this.timeout(20000);
        await clickText(page, 'Second');
        await page.keyboard.press('Home');
        await page.keyboard.type('AB');
        // Still in the page's 250 ms delay: no edit has gone yet.
        assert.strictEqual((await (editor as EditorPage).edits()).length, 0);
        const answer = await insert(QUOTE);
        assert.strictEqual(answer.inserted, true);
        const edits = await (editor as EditorPage).edits();
        assert.strictEqual(edits.length, 1, 'one edit carries both');
        const typed = SOURCE.replace('Second', 'ABSecond');
        assert.strictEqual(await hostReparses(), WITH_QUOTE.replace('Second', 'ABSecond'));

        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, typed, 'the letters stay');
        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, SOURCE);
    });

    test('the caret stands right after the block once the host\'s parse is shown, and typing goes there — undone on its own', async function () {
        this.timeout(20000);
        await clickText(page, 'Second', 3);
        await insert(QUOTE);
        await hostReparses();
        await delay(250);
        // The paragraph after the quote starts on line 7 of WITH_QUOTE.
        assert.deepStrictEqual((await carets()).pop(), { type: 'caret', baseVersion: version, position: { line: 7, character: 0 } });
        await page.keyboard.type('Z');
        await settle();
        assert.strictEqual((await lastEdit())?.text, WITH_QUOTE.replace('Last', 'ZLast'));
        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, WITH_QUOTE, 'Ctrl+Z took the letter, not the block with it');
    });

    test('after the last block the caret is at the quote\'s end; with focus the page takes the keyboard', async function () {
        this.timeout(20000);
        await clickText(page, 'Last');
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await insert(QUOTE, true);
        assert.strictEqual(await hostReparses(), `${SOURCE}\n${QUOTE}\n`);
        await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'), { timeout: 2000 });
        await delay(250);
        assert.deepStrictEqual((await carets()).pop()?.position, { line: 7, character: '> Text'.length });
    });

    test('a block right after a list is written after the whole list, a blank line on either side — the heading held tight to the list is no longer its neighbour — and reads back as the quote', async function () {
        this.timeout(20000);
        const list = 'Intro paragraph.\n\n- one\n- two\n## Heading\n\nLast paragraph.\n';
        await showDocument(list);
        await clickText(page, 'two');
        await insert(QUOTE);
        const written = await hostReparses();
        // Only lines added: the gap is a fact about a pair (`fidelity.ts`), and the heading's new neighbour is the quote.
        assert.strictEqual(written, 'Intro paragraph.\n\n- one\n- two\n\n> ## Römer 12:2 {.nwtsty}\n> Text\n\n## Heading\n\nLast paragraph.\n');
        await page.waitForSelector('.ProseMirror > blockquote');
        assert.strictEqual(await page.$eval('.ProseMirror > ul', ul => ul.querySelectorAll('li').length), 2, 'the list keeps its two items');
        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, list);
    });

    test('a CRLF document gets the block in CRLF, and Ctrl+Z gives back its bytes', async function () {
        this.timeout(20000);
        const crlf = SOURCE.replace(/\n/g, '\r\n');
        await showDocument(crlf);
        await clickText(page, 'Second', 3);
        await insert(QUOTE);
        assert.strictEqual(await hostReparses(), WITH_QUOTE.replace(/\n/g, '\r\n'));
        await page.waitForSelector('.ProseMirror > blockquote');
        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, crlf);
    });

    test('in a narrow window, scrolled away from the caret, the inserted block\'s end is brought into view', async function () {
        this.timeout(30000);
        await closeEditorPage(this, editor);
        editor = await openEditorPage({ width: 420, height: 360 });
        page = (editor as EditorPage).page;
        version = 0;
        const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} with a few more words, so that it wraps in a narrow window.`).join('\n\n') + '\n';
        await showDocument(long);
        await page.waitForSelector('.ProseMirror');
        await clickText(page, 'Paragraph 3 ');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await delay(100);
        await insert(QUOTE);
        await hostReparses();
        await page.waitForSelector('.ProseMirror > blockquote');
        await delay(150);
        const where = await page.evaluate(() => {
            const sel = window.getSelection();
            const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;
            const quote = document.querySelector('.ProseMirror > blockquote')?.getBoundingClientRect();
            return { caret: r ? r.top : null, quoteBottom: quote?.bottom ?? null, height: window.innerHeight, wide: document.documentElement.scrollWidth <= window.innerWidth };
        });
        assert.ok(where.caret !== null && where.caret >= 0 && where.caret < where.height, `the caret is in view: ${JSON.stringify(where)}`);
        assert.ok(where.quoteBottom !== null && where.quoteBottom > 0 && where.quoteBottom <= where.height, `the quote's end is in view: ${JSON.stringify(where)}`);
        assert.ok(where.wide, 'no horizontal scroll');
    });

    test('a request the page reaches after it expired is answered without the block, and nothing is sent', async function () {
        this.timeout(20000);
        await clickText(page, 'Second');
        const answer = await insert(QUOTE, false, Date.now() - 1);
        assert.strictEqual(answer.inserted, false);
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, 0);
        assert.strictEqual(await page.$('.ProseMirror > .mep-raw-block'), null);
    });

    test('Cmd+Z sent with the browser\'s own Undo command (macOS) is still the page\'s history: the block goes, nothing else', async function () {
        this.timeout(20000);
        await clickText(page, 'Second', 3);
        await insert(QUOTE);
        await hostReparses();
        await page.keyboard.down(MOD);
        await page.keyboard.press('z', editCommand('z'));
        await page.keyboard.up(MOD);
        await settle();
        assert.strictEqual((await lastEdit())?.text, SOURCE);
    });
});
