import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { WebviewMessage } from '../../../src/editor/protocol';
import { closeEditorPage, delay, EditorPage, EXTENSION_ID, MOD, openEditorPage, settle, shot } from './pageHarness';
import { DARK_MODERN, applyTheme } from './themes';

const SOURCE = [
    'First paragraph.',
    '',
    '<div>raw block</div>',
    '',
    'Last paragraph.',
    '',
].join('\n');

const FRONT = [
    '---',
    'title: Page',
    'tags: a',
    '---',
    '',
    'Some text.',
    '',
].join('\n');

const NOT_APPLIED = 'Not applied — the block changed outside the editor. Your text is on the clipboard.';
const CLOSED = 'Source closed — the block changed outside the editor.';

type CopyText = Extract<WebviewMessage, { type: 'copyText' }>;

/**
 * An open source box while the file changes outside the editor (#23): Find/Replace
 * in the text editor, another extension, Claude — the host posts the changed
 * document while the box is open. A change to the box's block closes it
 * unapplied, its typing on the clipboard; a change elsewhere leaves it open.
 * Each case on a page of its own.
 */
suite('Editor source box and a change from outside (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const showDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await delay(150);
    };

    /** A page of `width` px with `text` shown. */
    const open = async (text: string, width?: number) => {
        editor = await openEditorPage(width === undefined ? {} : { width });
        if (!editor) {
            return false;
        }
        page = editor.page;
        version = 0;
        await showDocument(text);
        return true;
    };

    /** Open the raw block's source box as a person does: a double click on its rendering. */
    const openBox = async () => {
        const box = await (await page.waitForSelector('.mep-raw-block .mep-atom-content'))?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + 10, box.y + box.height / 2, { clickCount: 2 });
        await page.waitForSelector('.mep-raw-editor');
        await delay(80);
    };

    const apply = async () => {
        await page.keyboard.down(MOD);
        await page.keyboard.press('Enter');
        await page.keyboard.up(MOD);
        await settle();
    };

    const edits = async () => (editor as EditorPage).edits();
    const copied = async () => (await (editor as EditorPage).posted()).filter((m): m is CopyText => m.type === 'copyText').map(m => m.text);
    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent ?? '', tone: (el as HTMLElement).dataset.tone, shown: !(el as HTMLElement).hidden }));
    const boxOpen = async () => (await page.$('.mep-raw-editor')) !== null;
    /** What has the focus: the editor with its block selected, a box, the panel's button. */
    const focus = () => page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return {
            inEditor: el?.classList.contains('ProseMirror') ?? false,
            blockSelected: document.querySelector('.mep-raw-block.ProseMirror-selectednode') !== null,
            className: el?.className ?? '',
        };
    });

    teardown(async function () {
        await closeEditorPage(this, editor);
        editor = undefined;
    });

    test('typing in the box, then the block changed outside: the box closes unapplied, the typing on the clipboard, a refusal at the block, which keeps the keyboard', async function () {
        this.timeout(30000);
        if (!await open(SOURCE)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        const before = (await edits()).length;
        await showDocument(SOURCE.replace('raw block', 'changed outside'));
        assert.strictEqual(await boxOpen(), false, 'the box is closed');
        assert.ok((await page.$eval('.mep-raw-block', el => el.textContent ?? '')).includes('changed outside'), 'the block shows the change from outside');
        assert.deepStrictEqual(await copied(), ['<div>raw block</div> typed'], 'what the box held, on the clipboard');
        const said = await hint();
        assert.deepStrictEqual([said.shown, said.tone], [true, 'refusal']);
        assert.ok(said.text.startsWith(NOT_APPLIED), said.text);
        assert.deepStrictEqual(await focus(), { inEditor: true, blockSelected: true, className: (await focus()).className });

        // Typing on: the selected source block refuses a character, as ever; the file keeps the change from outside.
        await page.keyboard.type('x');
        await settle();
        const after = (await edits()).slice(before);
        assert.ok(after.every(e => e.text.includes('<div>changed outside</div>') && !e.text.includes('raw block')), JSON.stringify(after));
    });

    test('the box opened, nothing typed, the block changed outside: closed, nothing copied, a neutral word; a click elsewhere writes nothing over the change', async function () {
        this.timeout(30000);
        if (!await open(SOURCE)) {
            this.skip();
        }
        await openBox();
        const before = (await edits()).length;
        await showDocument(SOURCE.replace('raw block', 'changed outside'));
        assert.strictEqual(await boxOpen(), false);
        assert.deepStrictEqual(await copied(), []);
        const said = await hint();
        assert.deepStrictEqual([said.shown, said.tone, said.text], [true, 'neutral', CLOSED]);
        const p = await page.$eval('.ProseMirror p', el => { const r = el.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2 }; });
        await page.mouse.click(p.x, p.y);
        await settle();
        const after = (await edits()).slice(before);
        assert.ok(after.every(e => !e.text.includes('raw block')), JSON.stringify(after));
    });

    test('a change elsewhere in the file leaves the box open with its typing and the focus; Apply writes both', async function () {
        this.timeout(30000);
        if (!await open(SOURCE)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await showDocument(SOURCE.replace('First paragraph.', 'First paragraph, replaced outside.').replace('Last paragraph.', 'Last one, replaced too.'));
        assert.strictEqual(await boxOpen(), true, 'the box stays open');
        assert.deepStrictEqual(await page.$eval('.mep-raw-editor', el => ({ value: (el as HTMLTextAreaElement).value, focused: document.activeElement === el })),
            { value: '<div>raw block</div> typed', focused: true });
        assert.deepStrictEqual(await copied(), []);
        await page.keyboard.type('!');
        await apply();
        const last = (await edits()).pop();
        assert.strictEqual(last?.text, 'First paragraph, replaced outside.\n\n<div>raw block</div> typed!\n\nLast one, replaced too.\n');
    });

    test('blocks added before the block and changed after it, the block itself untouched: the box stays open with its typing', async function () {
        this.timeout(30000);
        if (!await open(SOURCE)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await showDocument(SOURCE.replace('First paragraph.', 'New one.\n\n- an item\n\nFirst paragraph, changed.').replace('Last paragraph.', 'Last, changed.\n\nAnd more.'));
        assert.strictEqual(await page.$eval('.mep-raw-editor', el => (el as HTMLTextAreaElement).value), '<div>raw block</div> typed');
        assert.deepStrictEqual(await copied(), []);
        await page.keyboard.press('ArrowLeft');
        await showDocument('<div>raw block</div>\n');
        // Every other block gone: ProseMirror draws the block anew, and the page opens its box again as it was.
        assert.deepStrictEqual(await page.$eval('.mep-raw-editor', el => {
            const a = el as HTMLTextAreaElement;
            return { value: a.value, focused: document.activeElement === a, start: a.selectionStart, end: a.selectionEnd };
        }), { value: '<div>raw block</div> typed', focused: true, start: 25, end: 25 });
        assert.deepStrictEqual(await copied(), []);
        assert.strictEqual((await hint()).shown, false, 'nothing to say');
        await page.keyboard.type('!');
        await apply();
        assert.strictEqual((await edits()).pop()?.text, '<div>raw block</div> type!d\n');
    });

    test('two blocks of the same source, much changed around them: the box stays on its own block; that block removed closes it, never moving it to the other', async function () {
        this.timeout(30000);
        const twice = 'Intro.\n\n<div>same</div>\n\nMiddle.\n\n<div>same</div>\n\nEnd.\n';
        if (!await open(twice)) {
            this.skip();
        }
        // The second block's box.
        const blocks = await page.$$('.mep-raw-block .mep-atom-content');
        const second = await blocks[1].boundingBox();
        assert.ok(second);
        await page.mouse.click(second.x + 10, second.y + second.height / 2, { clickCount: 2 });
        await page.waitForSelector('.mep-raw-editor');
        await page.keyboard.type(' two');
        await showDocument('New.\n\n<div>same</div>\n\nMiddle, changed.\n\n<div>same</div>\n');
        assert.deepStrictEqual(await page.$$eval('.mep-raw-block', els => els.map(el => (el.querySelector('.mep-raw-editor') as HTMLTextAreaElement | null)?.value ?? null)),
            [null, '<div>same</div> two'], 'the box is on the second block still');
        await showDocument('New.\n\n<div>same</div>\n\nMiddle, changed.\n');
        assert.strictEqual(await page.$('.mep-raw-editor'), null, 'its block removed: closed, not moved to the other one');
        assert.deepStrictEqual(await copied(), ['<div>same</div> two']);
    });

    test('the block removed outside while the box holds typing: the typing on the clipboard, the hint at the caret', async function () {
        this.timeout(30000);
        if (!await open(SOURCE)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await showDocument('First paragraph.\n\nLast paragraph.\n');
        assert.strictEqual(await page.$('.mep-raw-block'), null);
        assert.deepStrictEqual(await copied(), ['<div>raw block</div> typed']);
        const said = await hint();
        assert.ok(said.shown && said.text.startsWith(NOT_APPLIED), said.text);
        assert.strictEqual((await focus()).inEditor, true, 'the keyboard stays in the page');
    });

    test('Delete block with the box open is the person\'s own: nothing copied, no hint of a change from outside', async function () {
        this.timeout(30000);
        if (!await open(SOURCE)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        const button = await page.waitForSelector('.mep-object-toolbar[data-trigger="selection"][data-object="raw_block"]:not([hidden]) [data-verb="delete-block"]', { visible: true });
        const box = await button?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await settle();
        assert.strictEqual(await page.$('.mep-raw-block'), null);
        assert.deepStrictEqual(await copied(), []);
        // The host's parse of the page's own edit: the same text, no change from outside.
        const last = (await edits()).pop();
        assert.ok(last);
        await showDocument(last.text);
        assert.deepStrictEqual(await copied(), []);
        const said = await hint();
        assert.ok(!said.text.includes('outside the editor'), said.text);
    });

    test('in a narrow window the refusal stands inside the window, at the block', async function () {
        this.timeout(30000);
        if (!await open(SOURCE, 420)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await showDocument(SOURCE.replace('raw block', 'changed outside'));
        const placed = await page.evaluate(() => {
            const r = (document.querySelector('.mep-hint') as HTMLElement).getBoundingClientRect();
            const block = (document.querySelector('.mep-raw-block') as HTMLElement).getBoundingClientRect();
            return { left: r.left, right: r.right, width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, nearBlock: Math.abs(r.top - block.bottom) < 80 || Math.abs(r.bottom - block.top) < 80 };
        });
        await shot(page, 'source-box-changed-outside-light-420.png');
        assert.ok(placed.left >= 0 && placed.right <= placed.width, JSON.stringify(placed));
        assert.ok(placed.scrollWidth <= placed.width, 'no horizontal scroll');
        assert.ok(placed.nearBlock, JSON.stringify(placed));
        await applyTheme(page, DARK_MODERN);
        await shot(page, 'source-box-changed-outside-dark-420.png');
    });

    test('the front matter\'s source box: its YAML changed outside closes it unapplied, the typing on the clipboard, Edit as source keeps the keyboard', async function () {
        this.timeout(30000);
        if (!await open(FRONT)) {
            this.skip();
        }
        const source = await (await page.waitForSelector('.mep-properties .mep-props-source'))?.boundingBox();
        assert.ok(source);
        await page.mouse.click(source.x + source.width / 2, source.y + source.height / 2);
        await page.waitForSelector('.mep-props-editor');
        await page.keyboard.type('\nauthor: me');
        const before = (await edits()).length;
        await showDocument(FRONT.replace('tags: a', 'tags: b'));
        assert.strictEqual(await page.$('.mep-props-editor'), null, 'the box is closed');
        assert.deepStrictEqual(await copied(), ['title: Page\ntags: a\nauthor: me']);
        const said = await hint();
        assert.ok(said.shown && said.text.startsWith('Not applied — the front matter changed outside the editor.'), said.text);
        assert.strictEqual((await focus()).className, 'mep-props-source', 'Edit as source has the focus');
        await page.keyboard.press('Tab');
        await settle();
        assert.ok((await edits()).slice(before).every(e => e.text.includes('tags: b') && !e.text.includes('author: me')));
    });

    test('the front matter\'s box with a change elsewhere stays open; a save from it writes both and leaves it open', async function () {
        this.timeout(30000);
        if (!await open(FRONT)) {
            this.skip();
        }
        await page.click('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await page.keyboard.type('\nauthor: me');
        await showDocument(FRONT.replace('Some text.', 'Some text, changed outside.'));
        assert.strictEqual(await page.$eval('.mep-props-editor', el => (el as HTMLTextAreaElement).value), 'title: Page\ntags: a\nauthor: me');
        await page.keyboard.down(MOD);
        await page.keyboard.press('s');
        await page.keyboard.up(MOD);
        const saved = (await edits()).pop();
        assert.strictEqual(saved?.text, '---\ntitle: Page\ntags: a\nauthor: me\n---\n\nSome text, changed outside.\n');
        await showDocument(saved.text);
        assert.notStrictEqual(await page.$('.mep-props-editor'), null, 'the host\'s parse of the save leaves the box open');
        assert.deepStrictEqual(await copied(), []);
        // Saved and confirmed: a change to the YAML from outside now loses nothing of the person's.
        await showDocument(saved.text.replace('tags: a', 'tags: b'));
        assert.strictEqual(await page.$('.mep-props-editor'), null);
        assert.deepStrictEqual(await copied(), []);
        assert.strictEqual((await hint()).tone, 'neutral');
    });

    // -- review 1: a save the host dropped (M1), a source block inserted before the box's (M2) -----------

    const save = async () => {
        await page.keyboard.down(MOD);
        await page.keyboard.press('s');
        await page.keyboard.up(MOD);
        await delay(200);
    };

    /** Open the box of the `index`th source block. */
    const openBoxAt = async (index: number) => {
        const at = await page.evaluate((i: number) => {
            const r = (document.querySelectorAll('.mep-raw-block .mep-atom-content')[i] as HTMLElement).getBoundingClientRect();
            return { x: r.left + 10, y: r.top + r.height / 2 };
        }, index);
        await page.mouse.click(at.x, at.y, { clickCount: 2 });
        await page.waitForSelector('.mep-raw-editor');
        await delay(80);
    };

    /** The value of each source block's open box, `null` where none is open. */
    const boxes = () => page.$$eval('.mep-raw-block', els => els.map(el => (el.querySelector('.mep-raw-editor') as HTMLTextAreaElement | null)?.value ?? null));

    test('a save from the box the host dropped (the file changed meanwhile, elsewhere): the typing is on the clipboard, a refusal says so', async function () {
        this.timeout(30000);
        const text = 'First.\n\n<div>raw</div>\n\nLast.\n';
        if (!await open(text)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await save();
        assert.strictEqual((await edits()).pop()?.text, 'First.\n\n<div>raw</div> typed\n\nLast.\n', 'the save carries the box');
        // The host did not write it: the file had changed elsewhere, and that is what it posts.
        await showDocument(text.replace('Last.', 'Last, changed outside.'));
        assert.strictEqual(await boxOpen(), false);
        assert.deepStrictEqual(await copied(), ['<div>raw</div> typed']);
        const said = await hint();
        assert.ok(said.shown && said.tone === 'refusal' && said.text.startsWith(NOT_APPLIED), said.text);
    });

    test('a block another extension inserts while the box holds typing is refused (source-open): nothing committed, and a change elsewhere from outside leaves the box open with its typing, nothing on the clipboard', async function () {
        this.timeout(30000);
        const text = 'First.\n\n<div>raw</div>\n\nLast.\n';
        if (!await open(text)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await (editor as EditorPage).send({ type: 'insertBlock', requestId: 1, src: '> Quote', focus: false });
        await settle();
        const answers = (await (editor as EditorPage).posted()).filter(m => m.type === 'blockInserted');
        assert.deepStrictEqual(answers, [{ type: 'blockInserted', requestId: 1, inserted: false, reason: 'source-open' }]);
        assert.deepStrictEqual(await edits(), [], 'the box was not committed');
        await showDocument(text.replace('First.', 'First, changed outside.'));
        assert.deepStrictEqual(await boxes(), ['<div>raw</div> typed']);
        assert.deepStrictEqual(await copied(), []);
    });

    test('the front matter: a save from the box the host dropped, then a change elsewhere: the YAML typed is on the clipboard', async function () {
        this.timeout(30000);
        if (!await open(FRONT)) {
            this.skip();
        }
        await page.click('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await page.keyboard.type('\nauthor: me');
        await save();
        await showDocument(FRONT.replace('Some text.', 'Some text, changed outside.'));
        assert.deepStrictEqual(await copied(), ['title: Page\ntags: a\nauthor: me']);
        const said = await hint();
        assert.ok(said.shown && said.tone === 'refusal' && said.text.startsWith('Not applied — the front matter changed outside the editor.'), said.text);
    });

    test('a source block inserted right before the box\'s: the box stays open on its own block, its typing and the focus kept; Apply writes it there', async function () {
        this.timeout(30000);
        if (!await open('First.\n\n<div>raw</div>\n\nLast.\n')) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await showDocument('First.\n\n<div>new</div>\n\n<div>raw</div>\n\nLast.\n');
        assert.deepStrictEqual(await boxes(), [null, '<div>raw</div> typed']);
        assert.strictEqual(await page.evaluate(() => document.activeElement?.className), 'mep-raw-editor');
        assert.deepStrictEqual(await copied(), []);
        assert.strictEqual((await hint()).shown, false);
        await apply();
        assert.strictEqual((await edits()).pop()?.text, 'First.\n\n<div>new</div>\n\n<div>raw</div> typed\n\nLast.\n');
    });

    test('a source block before the box\'s removed, or changed, or blank lines added before it: the box stays open with its typing', async function () {
        this.timeout(30000);
        const text = 'First.\n\n<div>other</div>\n\n<div>raw</div>\n\nLast.\n';
        if (!await open(text)) {
            this.skip();
        }
        await openBoxAt(1);
        await page.keyboard.type(' typed');
        await showDocument(text.replace('other', 'other changed'));
        assert.deepStrictEqual(await boxes(), [null, '<div>raw</div> typed'], 'the block before changed');
        await showDocument('First.\n\n<div>raw</div>\n\nLast.\n');
        assert.deepStrictEqual(await boxes(), ['<div>raw</div> typed'], 'the block before removed');
        await showDocument('First.\n\n\n\n<div>raw</div>\n\nLast.\n');
        assert.deepStrictEqual(await boxes(), ['<div>raw</div> typed'], 'blank lines added before it');
        assert.deepStrictEqual(await copied(), []);
        assert.strictEqual(await page.evaluate(() => document.activeElement?.className), 'mep-raw-editor');
    });

    test('nothing typed, the source block before the box\'s removed: the box stays open on its block', async function () {
        this.timeout(30000);
        if (!await open('First.\n\n<div>other</div>\n\n<div>raw</div>\n\nLast.\n')) {
            this.skip();
        }
        await openBoxAt(1);
        await showDocument('First.\n\n<div>raw</div>\n\nLast.\n');
        assert.deepStrictEqual(await boxes(), ['<div>raw</div>']);
        assert.deepStrictEqual(await copied(), []);
    });

    test('a CRLF file: a change elsewhere, a save from the box and its echo, another change elsewhere — the box stays open throughout', async function () {
        this.timeout(30000);
        const text = 'First.\r\n\r\n<div>\r\nraw\r\n</div>\r\n\r\nLast.\r\n';
        if (!await open(text)) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await showDocument(text.replace('Last.', 'Last, changed.'));
        assert.deepStrictEqual(await boxes(), ['<div>\nraw\n</div> typed']);
        await save();
        const saved = (await edits()).pop();
        assert.strictEqual(saved?.text, 'First.\r\n\r\n<div>\r\nraw\r\n</div> typed\r\n\r\nLast, changed.\r\n');
        await showDocument(saved.text);
        await page.keyboard.type('!');
        await showDocument(saved.text.replace('First.', 'First, changed.'));
        assert.deepStrictEqual(await boxes(), ['<div>\nraw\n</div> typed!']);
        assert.deepStrictEqual(await copied(), []);
    });

    test('the block turned into a paragraph outside, with typing: the typing on the clipboard', async function () {
        this.timeout(30000);
        if (!await open('First.\n\n<div>raw</div>\n\nLast.\n')) {
            this.skip();
        }
        await openBox();
        await page.keyboard.type(' typed');
        await showDocument('First.\n\nraw\n\nLast.\n');
        assert.strictEqual(await page.$('.mep-raw-block'), null);
        assert.deepStrictEqual(await copied(), ['<div>raw</div> typed']);
        assert.ok((await hint()).text.startsWith(NOT_APPLIED));
    });
});
