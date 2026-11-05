import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { judgeInsertion } from '../../../src/editor/host/insertCheck';
import { refusalMs } from '../../../src/editor/refusal';
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
    const insert = async (src: string, focus = false): Promise<BlockInserted> => {
        const requestId = ++requestSeq;
        await (editor as EditorPage).send({ type: 'insertBlock', requestId, src, focus });
        await page.waitForFunction(id => (window as unknown as { posted: { type: string; requestId?: number }[] }).posted
            .some(m => m.type === 'blockInserted' && m.requestId === id), { timeout: 2000 }, requestId);
        return (await posted()).find((m): m is BlockInserted => m.type === 'blockInserted' && m.requestId === requestId) as BlockInserted;
    };

    /**
     * The host's half after an inserting edit, as `applyEdit` plays it: the
     * blocks judged (`judgeInsertion`), the text written — the edit's, or the
     * edit's without them, the page told first (`insertBlockRefused`) — and its
     * parse posted.
     */
    const hostTakes = async (): Promise<{ written: string | undefined; refused: string | undefined }> => {
        const edit = await lastEdit();
        assert.ok(edit?.reparse, 'the insertion asks for a re-parse');
        assert.ok(edit.insert, 'and says where the blocks are');
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const verdict = judgeInsertion(md, edit.text, edit.insert);
        if (verdict.refused !== undefined) {
            await (editor as EditorPage).send({ type: 'insertBlockRefused', requestId: edit.insert.requestId, reason: verdict.refused });
        }
        assert.ok(verdict.text !== undefined, 'something to write');
        await showDocument(verdict.text);
        return { written: verdict.text, refused: verdict.refused };
    };

    /** The host's half after an inserting edit whose blocks stand alone: the edit applied, its parse posted. */
    const hostReparses = async (): Promise<string> => {
        const { written, refused } = await hostTakes();
        assert.strictEqual(refused, undefined, 'the blocks stand alone in the host\'s parse');
        return written as string;
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

    test('a withdrawal the page has not seen the request for is answered cancelled, once, and the request never written; one after the insertion is ignored', async function () {
        this.timeout(20000);
        await clickText(page, 'Second');
        const answers = async (id: number) => (await posted()).filter((m): m is BlockInserted => m.type === 'blockInserted' && m.requestId === id);
        // A page loaded again since: the withdrawal comes, the request never did.
        await (editor as EditorPage).send({ type: 'insertBlockCancel', requestId: 900 });
        await delay(100);
        assert.deepStrictEqual(await answers(900), [{ type: 'blockInserted', requestId: 900, inserted: false, reason: 'cancelled' }]);
        await (editor as EditorPage).send({ type: 'insertBlock', requestId: 900, src: QUOTE, focus: false });
        await settle();
        assert.strictEqual((await answers(900)).length, 1, 'answered once');
        assert.strictEqual((await (editor as EditorPage).edits()).length, 0, 'nothing written for it');

        // A busy page inserted first, and reads the withdrawal after: its answer stands.
        const answer = await insert(QUOTE);
        assert.strictEqual(answer.inserted, true);
        await (editor as EditorPage).send({ type: 'insertBlockCancel', requestId: answer.requestId });
        await delay(100);
        assert.strictEqual((await answers(answer.requestId)).length, 1, 'no second answer');
        assert.strictEqual(await hostReparses(), WITH_QUOTE);
    });

    for (const empty of ['', '\n'] as const) {
        test(`into an empty file (${JSON.stringify(empty)}): the block is its first, and Ctrl+Z after the host's parse gives back the empty file, Ctrl+Y the block (M1)`, async function () {
            this.timeout(20000);
            await showDocument(empty);
            await page.focus('.ProseMirror');
            await delay(80);
            const answer = await insert(QUOTE);
            assert.strictEqual(answer.inserted, true);
            const written = await hostReparses();
            assert.strictEqual(written, `${QUOTE}\n${empty}`);
            await page.waitForSelector('.ProseMirror > blockquote');
            await undoKey();
            await settle();
            assert.strictEqual((await lastEdit())?.text, empty, 'Ctrl+Z: the file as it was');
            assert.strictEqual(await page.$('.ProseMirror > blockquote'), null);
            await redoKey();
            await settle();
            assert.strictEqual((await lastEdit())?.text, written, 'Ctrl+Y: the block again');
        });
    }

    test('at the end of a file without a final line break: the block goes after it, the file still ends without one, and Ctrl+Z after the host\'s parse gives back the bytes', async function () {
        this.timeout(20000);
        const open = SOURCE.replace(/\n$/, '');
        await showDocument(open);
        await clickText(page, 'Last');
        await insert(QUOTE);
        assert.strictEqual(await hostReparses(), `${open}\n\n${QUOTE}`);
        await page.waitForSelector('.ProseMirror > blockquote');
        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, open, 'no line break left behind');
        await redoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, `${open}\n\n${QUOTE}`);
    });

    /** The page's hint: shown, its tone and text, and its box. */
    const hint = () => page.$eval('.mep-hint', el => {
        const r = el.getBoundingClientRect();
        return { shown: !(el as HTMLElement).hidden, tone: (el as HTMLElement).dataset.tone, text: el.textContent ?? '', rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } };
    });
    type Box = { left: number; right: number; top: number; bottom: number };
    const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const NOT_SEPARATE_HINT = 'Block not inserted — it would not stand on its own here (for example, an open code fence would take it in).';
    const SOURCE_OPEN_HINT = `Block not inserted — this source has changes not applied. Apply them (${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Enter) or cancel (Esc), then insert again.`;

    /** The table's source box opened as a person opens it: the table selected, **Edit source** on its bar. */
    const openTableBox = async () => {
        const cell = await page.waitForSelector('.mep-raw-block .mep-atom-content table');
        const box = await cell?.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
        const button = await page.waitForSelector('.mep-object-toolbar[data-trigger="selection"][data-object="raw_block"]:not([hidden]) [data-verb="edit-source"]', { visible: true });
        const at = await button?.boundingBox();
        assert.ok(at);
        await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
        await page.waitForSelector('.mep-raw-editor');
    };
    const TABLE = '| a | b |\n| = | = |\n| 1 | 2 |\n';
    const WITH_TABLE = `Intro paragraph.\n\n${TABLE}\nLast paragraph.\n`;
    /** What the open box holds, and whether it has the keyboard; `null` when no box is open. */
    const openBox = () => page.evaluate(() => {
        const area = document.querySelector<HTMLTextAreaElement>('.mep-raw-editor');
        return area === null ? null : { value: area.value, focused: document.activeElement === area };
    });

    test('a source box opened and nothing typed is committed with the block, with focus: one edit with the block alone, the box closes as the editor takes the keyboard, Ctrl+Z takes the block', async function () {
        this.timeout(30000);
        await showDocument(WITH_TABLE);
        await openTableBox();

        const answer = await insert(QUOTE, true);
        assert.strictEqual(answer.inserted, true);
        const edits = await (editor as EditorPage).edits();
        assert.strictEqual(edits.length, 1, 'one edit carries the block');
        assert.strictEqual(await hostReparses(), WITH_TABLE.replace('| 1 | 2 |\n', `| 1 | 2 |\n\n${QUOTE}\n`));
        await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror'), { timeout: 2000 });
        await settle();
        assert.strictEqual(await openBox(), null, 'the box closed as the focus left it');
        assert.strictEqual((await (editor as EditorPage).edits()).length, 1, 'and committed nothing more');

        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, WITH_TABLE, 'Ctrl+Z: the block, and nothing else');
    });

    test('a source box holding typed text not yet applied refuses the block (source-open), also with focus: nothing is written, the box stays open with its text and the keyboard; applied, it is written as typed', async function () {
        this.timeout(30000);
        await showDocument(WITH_TABLE);
        await openTableBox();
        await page.keyboard.type('\n| 3 | 4 |');

        const answer = await insert(QUOTE, true);
        assert.deepStrictEqual(answer, { type: 'blockInserted', requestId: answer.requestId, inserted: false, reason: 'source-open' });
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, 0, 'nothing written: not the block, not the box\'s text');
        assert.deepStrictEqual(await openBox(), { value: '| a | b |\n| = | = |\n| 1 | 2 |\n| 3 | 4 |', focused: true }, 'the box as it was');
        assert.strictEqual((await page.$$('.ProseMirror > .mep-raw-block')).length, 1, 'no source block for the quote on the page');
        // The page says why, under the box's block: never over the box or its Apply and Cancel.
        const said = await hint();
        assert.deepStrictEqual([said.shown, said.tone, said.text], [true, 'refusal', SOURCE_OPEN_HINT]);
        const block = await page.$eval('.ProseMirror > .mep-raw-block', el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        });
        assert.ok(!overlaps(said.rect, block), `the hint keeps off the box: ${JSON.stringify({ hint: said.rect, block })}`);
        // And goes as every refusal does, after its time.
        await delay(refusalMs(SOURCE_OPEN_HINT) + 300);
        assert.strictEqual((await hint()).shown, false);

        await page.keyboard.down(MOD);
        await page.keyboard.press('Enter');
        await page.keyboard.up(MOD);
        await settle();
        assert.strictEqual((await lastEdit())?.text, WITH_TABLE.replace('| 1 | 2 |\n', '| 1 | 2 |\n| 3 | 4 |\n'));
    });

    test('a source box whose typed text leaves a code fence open refuses the block (source-open): the block never lands in the fence, and the box keeps what was typed', async function () {
        this.timeout(30000);
        const withRaw = 'First paragraph.\n\n<div>raw block</div>\n\nLast paragraph.\n';
        await showDocument(withRaw);
        const box = await (await page.waitForSelector('.mep-raw-block .mep-atom-content'))?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + 10, box.y + box.height / 2, { clickCount: 2 });
        await page.waitForSelector('.mep-raw-editor');
        await delay(80);
        await page.keyboard.type('\n\n```js\nlet a = 1;');

        const answer = await insert(QUOTE);
        assert.strictEqual(answer.inserted, false, 'not reported inserted');
        assert.strictEqual(answer.reason, 'source-open');
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, 0, 'nothing written');
        assert.deepStrictEqual(await openBox(), { value: '<div>raw block</div>\n\n```js\nlet a = 1;', focused: true });
    });

    test('after a code fence left open at the file\'s end, the caret in it: the block would be code — not written (not-separate), the page shows the file with the typing before it, the caret stays, and one Ctrl+Z takes that typing: the refused insertion left no step behind (L2)', async function () {
        this.timeout(20000);
        const open = 'Intro paragraph.\n\n```js\nlet a = 1;\n';
        await showDocument(open);
        await clickText(page, 'Intro');
        await page.keyboard.type('E');
        await clickText(page, 'let a', 3);
        const answer = await insert(QUOTE, true);
        assert.strictEqual(answer.inserted, true, 'the page put it in its edit');
        const typed = open.replace('Intro', 'EIntro');
        assert.deepStrictEqual(await hostTakes(), { written: typed, refused: 'not-separate' });
        await delay(250);
        assert.deepStrictEqual(await page.$$eval('.ProseMirror > *', els => els.length), 2, 'the paragraph and the fence, no source block');
        assert.ok(!(await page.$eval('.ProseMirror', el => el.textContent ?? '')).includes('Römer'));
        assert.deepStrictEqual((await carets()).pop()?.position, { line: 3, character: 3 }, 'the caret where it was, in the fence');
        // The page says why, at the caret, off its line.
        const said = await hint();
        assert.deepStrictEqual([said.shown, said.tone, said.text], [true, 'refusal', NOT_SEPARATE_HINT]);
        const line = await page.evaluate(() => {
            const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
            return r ? { left: r.left, right: r.right + 1, top: r.top, bottom: r.bottom } : null;
        });
        assert.ok(line !== null && !overlaps(said.rect, line), `the hint keeps off the caret: ${JSON.stringify({ hint: said.rect, line })}`);

        await undoKey();
        await settle();
        assert.strictEqual((await lastEdit())?.text, open, 'one Ctrl+Z: the letter typed before');
        assert.ok((await page.$eval('.ProseMirror', el => el.textContent ?? '')).includes('let a = 1;'));
    });

    for (const [what, file, word] of [
        ['an admonition', 'Intro paragraph.\n\n!!! note "Title"\n    body text here\n\nLast paragraph.\n', 'body'],
        ['a list item', 'Intro paragraph.\n\n- item one\n- item two\n\nLast paragraph.\n', 'two'],
    ] as const) {
        test(`typed in ${what}, then a block inserted after the first paragraph: inserted, and Ctrl+Z after the host's parse takes out the quote only (H1)`, async function () {
            this.timeout(20000);
            await showDocument(file);
            await clickText(page, word);
            await page.keyboard.type('XY');
            await settle();
            const typed = (await lastEdit())?.text;
            assert.strictEqual(typed, file.replace(word, `XY${word}`));
            await clickText(page, 'Intro', 3);
            const answer = await insert(QUOTE);
            assert.strictEqual(answer.inserted, true);
            assert.strictEqual(await hostReparses(), (typed as string).replace('Intro paragraph.\n', `Intro paragraph.\n\n${QUOTE}\n`));
            await page.waitForSelector('.ProseMirror > blockquote');
            await undoKey();
            await settle();
            assert.strictEqual((await lastEdit())?.text, typed, 'Ctrl+Z: the quote out, the typing kept');
        });
    }

    test('Markdown that leaves a fence open itself would take the paragraph after it in: not written (not-separate); two letters typed just before are', async function () {
        this.timeout(20000);
        await clickText(page, 'Second');
        await page.keyboard.press('Home');
        await page.keyboard.type('AB');
        const answer = await insert('```\nnot closed');
        assert.strictEqual(answer.inserted, true);
        const typed = SOURCE.replace('Second', 'ABSecond');
        assert.deepStrictEqual(await hostTakes(), { written: typed, refused: 'not-separate' });
        await delay(250);
        assert.deepStrictEqual(await page.$$eval('.ProseMirror > *', els => els.map(el => el.tagName)), ['P', 'P', 'P'], 'the three paragraphs, nothing else');
        assert.strictEqual(await page.$eval('.ProseMirror', el => (el.textContent ?? '').includes('ABSecond')), true);
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
