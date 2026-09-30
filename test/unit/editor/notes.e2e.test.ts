import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { hostEngine } from './helpers';
import { closeEditorPage, delay, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, pointAt as textPoint, settle } from './pageHarness';

/** Narrower than the notes' 1280px breakpoint: the notes render stacked, in the text flow, where a click reaches them. */
const NARROW = 1000;
/** Wider than it: the notes float into the margin, as in a wide preview. */
const WIDE = 1400;

type OpenLink = Extract<WebviewMessage, { type: 'openLink' }>;

/**
 * Notes, sidebars and links in the real page, with the real mouse and keyboard
 * and this extension's note stylesheet loaded, as the preview's cascade would
 * load it. Each test posts its own document as the host.
 */
suite('Editor notes and links (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();
    const openLinks = async (): Promise<OpenLink[]> =>
        (await (editor as EditorPage).posted()).filter((m): m is OpenLink => m.type === 'openLink');

    /** Post `text` parsed by the host's engine — or by this extension's alone, where VS Code's math would claim `$…$`. */
    const showDocument = async (text: string, marker: string, extensionOnly = false) => {
        const md = extensionOnly ? hostEngine() : await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await delay(80);
    };

    /** The point just inside the left edge of character `index` of the first `needle` in the document. */
    const pointAt = (needle: string, index = 0) => textPoint(page, needle, index);

    /** A click with the real mouse right before character `index` of `needle`, given time for ProseMirror to read the selection. */
    const clickBefore = async (needle: string, index = 0) => {
        const p = await pointAt(needle, index);
        await page.mouse.click(p.x, p.y);
        await delay(150);
    };

    const selectText = async (needle: string) => {
        await page.focus('.ProseMirror');
        await page.evaluate(n => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf(n);
                if (at >= 0) {
                    (document.getSelection() as Selection).setBaseAndExtent(node, at, node, at + n.length);
                    return;
                }
            }
            throw new Error(`no "${n}" in the document`);
        }, needle);
        await delay(150);
    };

    /** Count clicks on links that reach the window, where VS Code's webview follows them. */
    const watchWindowClicks = () => page.evaluate(() => {
        const w = window as unknown as { linkClicks: number };
        w.linkClicks = 0;
        window.addEventListener('click', e => {
            if ((e.target as Element).closest?.('a[href]')) {
                w.linkClicks++;
            }
        });
    });
    const windowClicks = () => page.evaluate(() => (window as unknown as { linkClicks: number }).linkClicks);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: NARROW, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await watchWindowClicks();
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('Daniel\'s sequence: set a sidenote, then keep typing — in the note, after it, in the paragraph', async function () {
        this.timeout(20000);
        const source = 'Alpha beta gamma.\n\nSecond paragraph.\n';
        await showDocument(source, 'Alpha');
        await selectText('beta');
        await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
        await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden])');
        await page.click('.mep-menu [data-action="sidenote"]');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha ++beta|note++ gamma.\n\nSecond paragraph.\n');
        assert.strictEqual(await page.$('.ProseMirror .mep-raw-block'), null, 'the paragraph is still rich text');

        // The body's placeholder is selected: typing writes the note.
        await page.keyboard.type('the body');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha ++beta|the body++ gamma.\n\nSecond paragraph.\n');

        // Esc leaves the note; typing goes on in the paragraph.
        await page.keyboard.press('Escape');
        await page.keyboard.type(' and more');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha ++beta|the body++ and more gamma.\n\nSecond paragraph.\n');

        // A click elsewhere in the paragraph, and in the next one.
        await clickBefore('gamma.', 5);
        await page.keyboard.type('!');
        await clickBefore('Second', 0);
        await page.keyboard.type('A ');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha ++beta|the body++ and more gamma!.\n\nA Second paragraph.\n');
    });

    test('a click in the paragraph, in the reference and in the body types there, and only there', async function () {
        this.timeout(20000);
        const source = 'Fidelity is ++a property of blocks|the source-position note++ of this editor.\n';
        await showDocument(source, 'Fidelity');
        await clickBefore('Fidelity', 3);
        await page.keyboard.type('1');
        await clickBefore('property', 0);
        await page.keyboard.type('2');
        await clickBefore('source-position', 7);
        await page.keyboard.type('3');
        await clickBefore('editor.', 0);
        await page.keyboard.type('4');
        await settle();
        assert.strictEqual((await lastEdit())?.text,
            'Fid1elity is ++a 2property of blocks|the source-3position note++ of this 4editor.\n');
    });

    test('Tab moves from the reference to the body, Esc leaves; typing right after a note that ends the paragraph stays outside it', async function () {
        this.timeout(15000);
        await showDocument('End with a note ++ref|body++\n', 'End with');
        await clickBefore('ref', 1);
        await page.keyboard.press('Tab');
        await page.keyboard.type('X');
        await page.keyboard.press('Escape');
        await page.keyboard.type('Y');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'End with a note ++ref|bodyX++Y\n');
    });

    test('a | typed into inline code in a reference is refused, the hint says why, and the Code button over it is disabled', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++the `ab` ref|body++ gamma.\n', 'Alpha');
        const before = (await (editor as EditorPage).edits()).length;
        await clickBefore('ab', 1);
        await page.keyboard.type('|');
        await page.waitForSelector('.mep-hint:not([hidden])', { timeout: 2000 });
        assert.ok((await page.$eval('.mep-hint', el => el.textContent ?? '')).includes('"|"'));
        await page.keyboard.type('x');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha ++the `axb` ref|body++ gamma.\n', 'the | was not typed; the x was');
        assert.strictEqual((await (editor as EditorPage).edits()).length, before + 1);

        await showDocument('Mail @ write user&#64;host now @ end.\n', 'Mail');
        await page.focus('.ProseMirror');
        await page.evaluate(() => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf('user@host');
                if (at >= 0) {
                    (document.getSelection() as Selection).setBaseAndExtent(node, at, node, at + 'user@host'.length);
                    return;
                }
            }
        });
        await delay(150);
        const button = await page.$eval('.mep-toolbar [data-action="code"]', el => ({ disabled: el.getAttribute('aria-disabled'), title: (el as HTMLElement).title }));
        assert.strictEqual(button.disabled, 'true');
        assert.ok(button.title.includes('"@"'), button.title);
    });

    test('a click into a note and the Sidenote entry again removes the note, the reference text in its place', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body++ gamma.\n', 'Alpha');
        await clickBefore('body', 1);
        await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
        await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden])');
        assert.strictEqual(await page.$eval('.mep-menu [data-action="sidenote"]', el => el.classList.contains('mep-active')), true, 'shown active inside a sidenote');
        assert.strictEqual(await page.$eval('.mep-menu [data-action="marginal-note"]', el => el.getAttribute('aria-disabled')), 'true');
        await page.click('.mep-menu [data-action="sidenote"]');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha beta ref gamma.\n');
        assert.strictEqual(await page.$('.ProseMirror .sn-ref'), null);
        await page.keyboard.type('!');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha beta ref! gamma.\n', 'the caret is at the end of the kept text');
    });

    test('Backspace through an emptied reference removes the whole note', async function () {
        this.timeout(15000);
        await showDocument('Keep ++ab|body++ this.\n', 'Keep');
        await clickBefore('ab', 1);
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Backspace');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Keep this.\n');
        assert.strictEqual(await page.$('.ProseMirror .sn-ref'), null, 'no husk');
    });

    test(`at ${WIDE}px the note in the editor floats into the margin exactly as the engine's rendering does: the reference's own span changes nothing`, async function () {
        this.timeout(15000);
        try {
            await page.setViewport({ width: WIDE, height: 900 });
            // This extension's engine alone: VS Code's built-in math extension,
            // in the host's engine, reads `$…$` as a formula before the
            // sidebar rule sees it — as the preview does, with math enabled.
            await showDocument('Alpha ++beta|note body++ gamma !!mref|mbody!! delta $ left $ @right@.\n', 'Alpha', true);
            const md = hostEngine();
            const html = md.render('Alpha ++beta|note body++ gamma !!mref|mbody!! delta $ left $ @right@.');
            const styles = await page.evaluate(rendered => {
                const reference = document.createElement('div');
                reference.id = 'mep-reference';
                reference.innerHTML = rendered;
                (document.getElementById('mep-editor') as HTMLElement).before(reference);
                const props = ['float', 'display', 'width', 'margin-right', 'margin-left', 'font-size', 'font-weight', 'font-style', 'opacity', 'position'];
                const read = (root: Element, selector: string) => {
                    const el = root.querySelector(selector);
                    if (!el) {
                        throw new Error(`no ${selector} in ${root.innerHTML}`);
                    }
                    const style = getComputedStyle(el);
                    return Object.fromEntries(props.map(p => [p, style.getPropertyValue(p)]));
                };
                const editorRoot = document.querySelector('.ProseMirror') as Element;
                const out: Record<string, unknown> = {};
                for (const selector of ['.sn-ref', '.sn-ref .sidenote', '.mn-ref', '.mn-ref .mnote', '.left-sidebar', '.right-sidebar']) {
                    out[selector] = { editor: read(editorRoot, selector), engine: read(reference, selector) };
                }
                reference.remove();
                return out;
            }, html);
            for (const [selector, pair] of Object.entries(styles)) {
                const { editor: inEditor, engine } = pair as { editor: Record<string, string>; engine: Record<string, string> };
                assert.deepStrictEqual(inEditor, engine, selector);
            }
            assert.strictEqual((styles['.sn-ref .sidenote'] as { editor: Record<string, string> }).editor.float, 'right', 'in the margin');
        } finally {
            await page.setViewport({ width: NARROW, height: 900 });
        }
    });

    test('in a rendered table a plain click on a link selects the block; Ctrl+click posts openLink; VS Code\'s listener sees neither', async function () {
        this.timeout(15000);
        const source = 'Before.\n\n| Doc | b |\n| = | = |\n| [the spec](spec.md#part) | 2 |\n';
        await showDocument(source, 'Before');
        await page.waitForSelector('.mep-raw-block table a');
        const clicksBefore = await windowClicks();
        const linksBefore = (await openLinks()).length;
        const editsBefore = (await (editor as EditorPage).edits()).length;

        await page.click('.mep-raw-block table a');
        await delay(150);
        assert.ok(await page.$('.mep-raw-block.ProseMirror-selectednode'), 'the block is selected');
        assert.strictEqual((await openLinks()).length, linksBefore, 'a plain click follows nothing');

        await page.keyboard.down('Control');
        await page.click('.mep-raw-block table a');
        await page.keyboard.up('Control');
        await delay(100);
        const posted = await openLinks();
        assert.deepStrictEqual(posted.slice(linksBefore), [{ type: 'openLink', href: 'spec.md#part' }], 'as written, for the host to resolve');
        assert.strictEqual(await windowClicks(), clicksBefore, 'no click reached the window, where VS Code would resolve the href against the page');
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, editsBefore, 'nothing was edited');
    });

    test('in rich text a plain click on a link places the caret; Ctrl+click posts openLink; hovering names the target', async function () {
        this.timeout(15000);
        const source = 'See [the spec](spec.md) here.\n';
        await showDocument(source, 'See');
        const clicksBefore = await windowClicks();
        const linksBefore = (await openLinks()).length;
        assert.strictEqual(await page.$eval('.ProseMirror p a', el => el.getAttribute('title')), 'spec.md');

        await clickBefore('spec', 0);
        await page.keyboard.type('X');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the Xspec](spec.md) here.\n', 'the click placed the caret in the link text');
        assert.strictEqual((await openLinks()).length, linksBefore);

        const p = await pointAt('Xspec', 2);
        await page.keyboard.down('Control');
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up('Control');
        await delay(100);
        assert.deepStrictEqual((await openLinks()).slice(linksBefore), [{ type: 'openLink', href: 'spec.md' }]);
        assert.strictEqual(await windowClicks(), clicksBefore, 'no click reached VS Code\'s listener');
    });

    test('Ctrl+click on a link to a heading of the document scrolls to it, and asks the host for nothing', async function () {
        this.timeout(15000);
        const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i}.`).join('\n\n');
        await showDocument(`Jump to [the end](#the-end).\n\n${filler}\n\n## The end {#the-end}\n`, 'Jump');
        const linksBefore = (await openLinks()).length;
        await page.evaluate(() => window.scrollTo(0, 0));
        const p = await pointAt('the end', 1);
        await page.keyboard.down('Control');
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up('Control');
        await delay(150);
        assert.strictEqual((await openLinks()).length, linksBefore);
        assert.ok(await page.evaluate(() => window.scrollY > 0), 'the page scrolled');
    });
});
