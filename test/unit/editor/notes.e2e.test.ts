import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { hostEngine } from './helpers';
import { EXTENSION_ID, EditMessage, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Narrower than the notes' 1280px breakpoint: the notes render stacked, in the text flow, where a click reaches them. */
const NARROW = 1000;
/** Wider than it: the notes float into the margin, as in a wide preview. */
const WIDE = 1400;

/**
 * Notes and sidebars in the real page, with the real mouse and keyboard
 * and this extension's note stylesheet loaded, as the preview's cascade would
 * load it. Each test posts its own document as the host.
 */
suite('Editor notes (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    /** Post `text` parsed by the host's engine — or by this extension's alone, where VS Code's math would claim `$…$`. */
    const showDocument = async (text: string, marker: string, extensionOnly = false) => {
        const md = extensionOnly ? hostEngine() : await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90 });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await delay(80);
    };

    /** The point just inside the left edge of character `index` of the first `needle` in the document. */
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

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: NARROW, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async () => {
        await editor?.close();
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
});
