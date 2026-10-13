import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { closeEditorPage, clickText, delay, editCommand, EditMessage, EditorPage, EXTENSION_ID, MOD, openEditorPage, settle, shot } from './pageHarness';
import { DARK_MODERN, LIGHT_MODERN, applyTheme } from './themes';

const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const FIELD_BAR = '.mep-object-toolbar[data-trigger="toolbar"]';
const BUBBLE_TOOL = '.mep-bubble [data-action="attrs-bubble"]';

/**
 * A broken image has no size of its own: a height and a fill to see and to click, as a
 * screenshot would show a picture — its width the one its `{width=…}` gives. Not
 * ProseMirror's own separator image, which stands at the end of a line holding one.
 */
const IMAGE_STYLE = '.ProseMirror img:not(.ProseMirror-separator) { display: inline-block; min-width: 120px; height: 80px; background: linear-gradient(135deg, #2f5d8a, #4f8a5b); vertical-align: middle; }';

/**
 * Attributes on every inline element, in the real page in headless Chromium,
 * in VS Code's light theme and, for the image's bar, its dark one: each state
 * the bars, the menu, `Alt+Enter` and the bubble take, held to what they show
 * — and with `MEP_SHOTS_DIR` set, saved there for review.
 */
suite('Editor inline attributes (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    const showDocument = async (text: string, marker: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
        });
        await delay(300);
    };

    const verbs = () => page.$$eval(`${BAR} button[data-verb]`, els => els.map(e => [(e as HTMLElement).dataset.verb, e.textContent]));

    const clickImage = async () => {
        const img = await (await page.$('.ProseMirror img'))?.boundingBox();
        assert.ok(img);
        await page.mouse.click(img.x + img.width / 2, img.y + img.height / 2);
        await page.waitForSelector(`${BAR}[data-object="image"]`, { timeout: 2000 });
    };

    const pressAlt = async (key: puppeteer.KeyInput) => {
        await page.keyboard.down('Alt');
        await page.keyboard.press(key);
        await page.keyboard.up('Alt');
        await delay(120);
    };

    const selectAll = async () => {
        await page.keyboard.down(MOD);
        await page.keyboard.press('a', editCommand('a'));
        await page.keyboard.up(MOD);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1000, height: 520, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await page.addStyleTag({ content: IMAGE_STYLE });
        await applyTheme(page, LIGHT_MODERN);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    teardown(async () => {
        await page.keyboard.press('Escape');
        await applyTheme(page, LIGHT_MODERN);
    });

    test('an image with attributes: its bar has Attributes…, the label carries the literal, the image is drawn with it — light and dark', async function () {
        this.timeout(20000);
        await showDocument('Screenshot of the setup: ![Screenshot](img/setup.png){.hero width=300}\n\nAfter it.\n', 'Screenshot of');
        assert.strictEqual(await page.$eval('.ProseMirror img', el => el.getAttribute('width')), '300');
        await clickImage();
        assert.deepStrictEqual(await verbs(), [['edit-image', 'Edit image…'], ['image-attributes', 'Attributes…'], ['open-image', 'Open file'], ['remove-image', 'Remove image']]);
        assert.strictEqual(await page.$eval(BAR, el => el.getAttribute('aria-label')), 'Image {.hero width=300}');
        await shot(page, 'inline-attrs-01-image-bar-light.png');
        await applyTheme(page, DARK_MODERN);
        await delay(100);
        await shot(page, 'inline-attrs-02-image-bar-dark.png');
    });

    test('the image\'s attributes field: prefilled with the literal; {src=…} refused with the field kept open', async function () {
        this.timeout(20000);
        await showDocument('Screenshot of the setup: ![Screenshot](img/setup.png){.hero width=300}\n\nAfter it.\n', 'Screenshot of');
        await clickImage();
        await page.click(`${BAR} [data-verb="image-attributes"]`);
        await page.waitForSelector(`${BAR} .mep-inline-field`, { visible: true });
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), '{.hero width=300}');
        await shot(page, 'inline-attrs-03-image-field.png');
        await selectAll();
        await page.keyboard.type('{.hero src=other.png}');
        await page.keyboard.press('Enter');
        await delay(150);
        const refused = await page.evaluate(sel => ({
            value: (document.querySelector(`${sel} .mep-inline-field`) as HTMLInputElement | null)?.value ?? null,
            refusal: document.querySelector(`${sel} .mep-field-refusal`)?.textContent ?? null,
        }), BAR);
        assert.strictEqual(refused.value, '{.hero src=other.png}');
        assert.ok(refused.refusal?.includes('src, alt or title'), refused.refusal ?? 'none');
        await shot(page, 'inline-attrs-04-image-field-refused.png');
    });

    test('code with attributes, and its bar', async function () {
        this.timeout(20000);
        await showDocument('Run it with `--flag`{.k} and press [[Ctrl]]{.key}, H~2~{.f}O, x^2^{.c}.\n\nAfter it.\n', 'Run it');
        await clickText(page, 'flag', 2);
        await page.waitForSelector(`${BAR}[data-object="styled"]`, { timeout: 2000 });
        assert.deepStrictEqual(await verbs(), [['edit-attributes', 'Attributes…'], ['remove-attributes', 'Remove attributes, keep formatting']]);
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-label`, el => el.textContent), 'Code');
        await shot(page, 'inline-attrs-05-code-bar.png');
    });

    test('the Formatting menu: Attributes of Code… enabled in code, disabled in plain text, beside Attributes of Paragraph…', async function () {
        this.timeout(20000);
        await showDocument('Run it with `--flag` to skip the cache, or plain words.\n\nAfter it.\n', 'Run it');
        const open = async () => {
            await page.click('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
            await page.waitForSelector('.mep-menu[data-menu="formatting"]:not([hidden])');
        };
        const entries = () => page.$$eval('.mep-menu[data-menu="formatting"] [data-action]', els => els.slice(-3).map(e => [
            (e as HTMLElement).dataset.action, e.querySelector('.mep-sample')?.textContent, e.getAttribute('aria-disabled'),
        ]));
        await clickText(page, 'flag', 2);
        await open();
        assert.deepStrictEqual(await entries(), [['span-class', 'span', 'true'], ['inline-attributes', 'Attributes of Code…', 'false'], ['block-attributes', 'Attributes of Paragraph…', 'false']]);
        await page.hover('.mep-menu [data-action="inline-attributes"]');
        await delay(700);
        await shot(page, 'inline-attrs-06-menu-enabled.png');
        await page.keyboard.press('Escape');
        await clickText(page, 'plain', 2);
        await open();
        assert.deepStrictEqual((await entries())[1], ['inline-attributes', 'Attributes of Code…', 'true']);
        await page.hover('.mep-menu [data-action="inline-attributes"]');
        await delay(700);
        await shot(page, 'inline-attrs-07-menu-disabled.png');
    });

    test('Alt+Enter in code without attributes: the bare bar', async function () {
        this.timeout(20000);
        await showDocument('Run it with `--flag` to skip the cache.\n\nAfter it.\n', 'Run it');
        await clickText(page, 'flag', 2);
        await delay(INLINE_DELAY_MS + 300);
        assert.strictEqual(await page.$(BAR), null, 'nothing on a caret rest');
        await pressAlt('Enter');
        assert.deepStrictEqual(await verbs(), [['edit-attributes', 'Attributes…']]);
        assert.strictEqual(await page.$eval(BAR, el => (el as HTMLElement).dataset.object), 'holder');
        await shot(page, 'inline-attrs-08-alt-enter-bare-bar.png');
    });

    test('a table\'s bar with the separated Attributes of Strong…', async function () {
        this.timeout(20000);
        await showDocument('| Name | Kind |\n| ---- | ---- |\n| **Alpha** | first |\n\nAfter it.\n', 'Alpha');
        await clickText(page, 'Alpha', 2);
        await pressAlt('Enter');
        const shown = await verbs();
        assert.deepStrictEqual(shown[shown.length - 1], ['inline-attributes', 'Attributes of Strong…']);
        assert.ok(await page.$(`${BAR} .mep-object-separator + [data-verb="inline-attributes"]`), 'after a separator');
        await shot(page, 'inline-attrs-09-table-bar-strong.png');
    });

    test('the bubble\'s {…}: within a run it names the element, across plain text a span', async function () {
        this.timeout(20000);
        await showDocument('Run it with `--flag` to skip the cache, then *restart* the server.\n\nAfter it.\n', 'Run it');
        const select = (from: string, fromAt: number, to: string, toAt: number) => page.evaluate((f, fa, t, ta) => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const texts: Text[] = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                texts.push(node as Text);
            }
            const a = texts.find(n => (n.textContent ?? '').includes(f)) as Text;
            const b = texts.find(n => (n.textContent ?? '').includes(t)) as Text;
            (document.getSelection() as Selection).setBaseAndExtent(a, (a.textContent ?? '').indexOf(f) + fa, b, (b.textContent ?? '').indexOf(t) + ta);
        }, from, fromAt, to, toAt);
        await page.focus('.ProseMirror');
        await select('--flag', 2, '--flag', 6);
        await delay(200);
        await page.hover(BUBBLE_TOOL);
        assert.ok((await page.$eval(BUBBLE_TOOL, el => (el as HTMLElement).title)).startsWith('Attributes of Code…'));
        await shot(page, 'inline-attrs-10-bubble-in-code.png');
        await select('restart', 0, ' the server', 4);
        await delay(200);
        await page.hover(BUBBLE_TOOL);
        assert.ok((await page.$eval(BUBBLE_TOOL, el => (el as HTMLElement).title)).startsWith('Span with class'));
        await shot(page, 'inline-attrs-11-bubble-across.png');
        await page.click(BUBBLE_TOOL);
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true });
        await page.keyboard.type('s');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('{.s}'), (await lastEdit())?.text);
    });
});
