import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { EXTENSION_ID, EditMessage, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Posted<T extends WebviewMessage['type']> = Extract<WebviewMessage, { type: T }>;

/** The bar an action opened its field in (Ctrl+K, Insert → Link…, an image's alt text). */
const FIELD_BAR = '.mep-object-toolbar[data-trigger="toolbar"]';
/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/**
 * Links and images in the real page, the host's half played by the test:
 * `Ctrl+K` and **Insert → Link…** ask for the address in the inline field,
 * which completes from the host's `linkChoices`; **Insert → Image…**, a
 * dropped file and a pasted bitmap insert what the host answers; an image is
 * shown from the address the host resolves while the text keeps its path.
 */
suite('Editor links and images (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const posted = () => (editor as EditorPage).posted();
    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();
    const send = (message: Parameters<EditorPage['send']>[0]) => (editor as EditorPage).send(message);

    /** The last message of `type` the page posted, waited for when `after` of them were there before. */
    const lastPosted = async <T extends WebviewMessage['type']>(type: T, after = 0): Promise<Posted<T>> => {
        await page.waitForFunction((t, n) => (window as unknown as { posted: { type: string }[] }).posted.filter(m => m.type === t).length > n, { timeout: 3000 }, type, after);
        return (await posted()).filter((m): m is Posted<T> => m.type === type).pop() as Posted<T>;
    };
    const count = async (type: WebviewMessage['type']) => (await posted()).filter(m => m.type === type).length;

    const showDocument = async (text: string, marker: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await page.mouse.move(2, 2);
        await delay(150);
    };

    const pointAt = async (needle: string, index = 0): Promise<{ x: number; y: number }> => page.evaluate((n, k) => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(n);
            if (at >= 0) {
                const range = document.createRange();
                range.setStart(node, at + k);
                range.setEnd(node, at + k + 1);
                const r = range.getBoundingClientRect();
                return { x: r.left + 1, y: r.top + r.height / 2 };
            }
        }
        throw new Error(`no "${n}" in the document`);
    }, needle, index);

    const clickBefore = async (needle: string, index = 0) => {
        const p = await pointAt(needle, index);
        await page.mouse.click(p.x, p.y);
        await delay(80);
    };

    /** Select `length` characters from the start of `needle`, with the keyboard. */
    const select = async (needle: string, length: number) => {
        await clickBefore(needle, 0);
        await page.keyboard.down('Shift');
        for (let i = 0; i < length; i++) {
            await page.keyboard.press('ArrowRight');
        }
        await page.keyboard.up('Shift');
        await delay(80);
    };

    const ctrl = async (key: puppeteer.KeyInput) => {
        await page.keyboard.down('Control');
        await page.keyboard.press(key);
        await page.keyboard.up('Control');
        await delay(80);
    };

    const field = () => page.$eval(`${FIELD_BAR} .mep-inline-field`, el => ({ value: (el as HTMLInputElement).value, label: el.getAttribute('aria-label') }));
    const listed = () => page.$$eval(`${FIELD_BAR} .mep-completion`, els => els.map(el => ({
        label: el.querySelector('.mep-completion-label')?.textContent,
        chosen: el.classList.contains('mep-chosen'),
    })));

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
        await page.keyboard.press('Escape');
        await page.mouse.click(980, 880);
    });

    test('Ctrl+K on selected text asks for the address and links the text to what is typed; the key does not reach VS Code', async function () {
        this.timeout(15000);
        await showDocument('See the spec here.\n', 'See');
        await page.evaluate(() => {
            const w = window as unknown as { chords: string[] };
            w.chords = [];
            // Where VS Code's webview forwards keys to the workbench from: the window, bubbling.
            window.addEventListener('keydown', e => {
                if (e.ctrlKey && e.key.toLowerCase() === 'k') {
                    w.chords.push(e.key);
                }
            });
        });
        await select('the spec', 8);
        const asked = await count('linkChoices');
        await ctrl('k');
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { timeout: 2000 });
        assert.deepStrictEqual(await field(), { value: '', label: 'Address' }, 'selected text: the address only');
        assert.strictEqual((await lastPosted('linkChoices', asked)).query, '', 'completion is asked as the field opens');
        assert.deepStrictEqual(await page.evaluate(() => (window as unknown as { chords: string[] }).chords), [], 'kept from VS Code\'s chord');
        await page.keyboard.type('docs/spec.md');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the spec](docs/spec.md) here.\n');
        assert.strictEqual(await page.$(FIELD_BAR), null, 'the field is gone');
    });

    test('the address field lists the host\'s files and headings; # asks for anchors; an older answer is not shown; ↓ and Enter take a choice', async function () {
        this.timeout(15000);
        await showDocument('See here.\n', 'See');
        await clickBefore('here', 0);
        await ctrl('k');
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { timeout: 2000 });
        assert.deepStrictEqual(await field(), { value: '', label: 'Text' }, 'at a caret: the text first');
        await page.keyboard.type('the part');
        const before = await count('linkChoices');
        await page.keyboard.press('Enter');
        assert.deepStrictEqual(await field(), { value: '', label: 'Address' }, 'then the address');
        const first = await lastPosted('linkChoices', before);
        await send({
            type: 'linkChoicesResult', requestId: first.requestId, items: [
                { value: 'docs/other%20file.md', label: 'docs/other file.md', kind: 'file' },
                { value: 'z.txt', label: 'z.txt', kind: 'file' },
            ],
        });
        await page.waitForSelector(`${FIELD_BAR} .mep-completion`, { timeout: 2000 });
        assert.deepStrictEqual((await listed()).map(l => l.label), ['docs/other file.md', 'z.txt']);

        await page.keyboard.type('#');
        const anchors = await lastPosted('linkChoices', before + 1);
        assert.strictEqual(anchors.query, '#');
        await send({
            type: 'linkChoicesResult', requestId: anchors.requestId, items: [
                { value: '#intro', label: '#intro', detail: 'Intro', kind: 'heading' },
                { value: '#scope-id', label: '#scope-id', detail: 'Scope', kind: 'heading' },
            ],
        });
        await page.waitForFunction(() => document.querySelector('.mep-completion-label')?.textContent === '#intro');
        // The answer to the first question, late: not shown over the newer one.
        await send({ type: 'linkChoicesResult', requestId: first.requestId, items: [{ value: 'late.md', label: 'late.md', kind: 'file' }] });
        await delay(100);
        assert.deepStrictEqual((await listed()).map(l => l.label), ['#intro', '#scope-id']);
        assert.strictEqual(await page.$eval(`${FIELD_BAR} .mep-completion-detail`, el => el.textContent), 'Intro');

        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.deepStrictEqual((await listed()).map(l => l.chosen), [false, true]);
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the part](#scope-id)here.\n');
    });

    test('Tab takes a file into the field and asks again, for its headings once # follows', async function () {
        this.timeout(15000);
        await showDocument('See the spec here.\n', 'See');
        await select('the spec', 8);
        const before = await count('linkChoices');
        await ctrl('k');
        const first = await lastPosted('linkChoices', before);
        await send({ type: 'linkChoicesResult', requestId: first.requestId, items: [{ value: 'docs/other%20file.md', label: 'docs/other file.md', kind: 'file' }] });
        await page.waitForSelector(`${FIELD_BAR} .mep-completion`, { timeout: 2000 });
        await page.keyboard.press('Tab');
        assert.strictEqual((await field()).value, 'docs/other%20file.md', 'taken into the field, the field kept');
        assert.strictEqual((await lastPosted('linkChoices', before + 1)).query, 'docs/other%20file.md');
        await page.keyboard.type('#');
        assert.strictEqual((await lastPosted('linkChoices', before + 2)).query, 'docs/other%20file.md#');
        await page.keyboard.type('x');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the spec](docs/other%20file.md#x) here.\n');
    });

    test('Edit link… is prefilled with the link\'s address and completes like Ctrl+K', async function () {
        this.timeout(15000);
        await showDocument('See [the spec](spec.md) here.\n', 'See');
        await clickBefore('spec', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        const before = await count('linkChoices');
        await page.click(`${BAR} [data-verb="edit-link"]`);
        await delay(80);
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), 'spec.md');
        const asked = await lastPosted('linkChoices', before);
        assert.strictEqual(asked.query, 'spec.md');
        await send({ type: 'linkChoicesResult', requestId: asked.requestId, items: [{ value: 'docs/spec.md', label: 'docs/spec.md', kind: 'file' }] });
        await page.waitForSelector(`${BAR} .mep-completion`, { timeout: 2000 });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the spec](docs/spec.md) here.\n');
    });

    test('Insert → Image… asks the host for the file, inserts it by the path it answers, and asks for the alt text, the file\'s name prefilled', async function () {
        this.timeout(15000);
        await showDocument('Before after.\n', 'Before');
        await clickBefore('after', 0);
        const before = await count('pickImage');
        await page.click('.mep-toolbar .mep-menu-face[data-menu="insert"]');
        await page.waitForSelector('.mep-menu[data-menu="insert"]:not([hidden])');
        await page.click('.mep-menu [data-action="image"]');
        const pick = await lastPosted('pickImage', before);
        await send({ type: 'filesChosen', requestId: pick.requestId, files: [{ src: 'pictures/my%20pic.png', alt: 'my pic', image: true }] });
        await page.waitForSelector(`${FIELD_BAR}[data-object="image"] .mep-inline-field`, { timeout: 2000 });
        assert.deepStrictEqual(await field(), { value: 'my pic', label: 'Alt text' });
        await page.keyboard.type('The overview');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Before ![The overview](pictures/my%20pic.png)after.\n', 'the relative, encoded path the host answered');

        // A dismissed dialog, and an answer to nothing asked, write nothing.
        const edits = (await (editor as EditorPage).edits()).length;
        await send({ type: 'filesChosen', requestId: pick.requestId, files: [{ src: 'again.png', alt: 'again', image: true }] });
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, edits);
    });

    test('a file dropped from VS Code\'s explorer is inserted where it was dropped, by the relative path the host answers', async function () {
        this.timeout(15000);
        await showDocument('Before after.\n', 'Before');
        const before = await count('insertFiles');
        const at = await pointAt('after', 0);
        await page.evaluate((x, y) => {
            const data = new DataTransfer();
            data.setData('resourceurls', JSON.stringify(['file:///d%3A/ws/pictures/my%20pic.png']));
            const target = document.elementFromPoint(x, y) as HTMLElement;
            target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        }, at.x - 1, at.y);
        const asked = await lastPosted('insertFiles', before);
        assert.deepStrictEqual(asked.uris, ['file:///d%3A/ws/pictures/my%20pic.png']);
        await send({ type: 'filesChosen', requestId: asked.requestId, files: [{ src: 'pictures/my%20pic.png', alt: 'my pic', image: true }] });
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Before ![my pic](pictures/my%20pic.png)after.\n');
    });

    test('a pasted bitmap goes to the host as saveImage, and the path it was saved at is inserted, its name the alt text', async function () {
        this.timeout(15000);
        await showDocument('Before after.\n', 'Before');
        await clickBefore('after', 0);
        const before = await count('saveImage');
        await page.evaluate(() => {
            const data = new DataTransfer();
            data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' }));
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        });
        const asked = await lastPosted('saveImage', before);
        assert.strictEqual(asked.suggestedName, 'image.png');
        assert.strictEqual(asked.bytes, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
        await send({ type: 'imageSaved', requestId: asked.requestId, path: 'images/doc-20260929-101010.png' });
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Before ![doc-20260929-101010](images/doc-20260929-101010.png)after.\n');
    });

    test('a relative image is shown from the address the host resolves, the text keeps its path; a web address is shown as written', async function () {
        this.timeout(15000);
        const before = await count('resolveImages');
        await showDocument('An ![pic](images/p.png) and ![web](https://example.com/w.png) here.\n\n| ![t](images/t.png) |\n| - |\n| x |\n', 'An');
        const asked = await lastPosted('resolveImages', before);
        assert.deepStrictEqual([...asked.srcs].sort(), ['https://example.com/w.png', 'images/p.png', 'images/t.png']);
        const shown = () => page.$$eval('.ProseMirror img', els => els.map(el => [el.getAttribute('data-mep-src'), el.getAttribute('src')]));
        assert.deepStrictEqual(await shown(), [['images/p.png', null], ['https://example.com/w.png', null], ['images/t.png', null]], 'nothing is loaded before the host says from where');

        const webview = 'https://file%2B.vscode-resource.vscode-cdn.net/d%3A/ws/images';
        await send({ type: 'imagesResolved', requestId: asked.requestId, sources: { 'images/p.png': `${webview}/p.png`, 'images/t.png': `${webview}/t.png` } });
        await delay(100);
        assert.deepStrictEqual(await shown(), [
            ['images/p.png', `${webview}/p.png`],
            ['https://example.com/w.png', 'https://example.com/w.png'],
            ['images/t.png', `${webview}/t.png`],
        ]);

        // The round trip: an edit beside the image writes the path the file holds.
        await clickBefore('here', 0);
        await page.keyboard.type('X');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'An ![pic](images/p.png) and ![web](https://example.com/w.png) Xhere.\n\n| ![t](images/t.png) |\n| - |\n| x |\n');
        const again = await count('resolveImages');
        await delay(100);
        assert.strictEqual(await count('resolveImages'), again, 'a src the host answered for is not asked again');
    });
});
