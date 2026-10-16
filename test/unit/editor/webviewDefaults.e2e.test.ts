import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { closeEditorPage, computedColour, delay, EditorPage, EXTENSION_ID, openEditorPage, shot } from './pageHarness';
import { DARK_MODERN, LIGHT_MODERN, applyTheme } from './themes';
import { installedWebviewDefaultStyles, WEBVIEW_DEFAULT_STYLES, WEBVIEW_DEFAULT_STYLES_ID } from './webviewDefaults';

/** A link, a footnote reference and the footnote's back-link: all three are `<a>`, the reference inside `sup.footnote-ref`. */
const LINKS = 'A [link](https://example.com) and a claim that needs a source.[^1]\n\n[^1]: The source.\n';

/** CSS with its whitespace collapsed, so a re-indented copy compares equal to its original. */
const squeeze = (css: string) => css.replace(/\s+/g, ' ').trim();

/**
 * The page harness gives the editor's page what VS Code gives every webview
 * before the page's own stylesheets (`webviewDefaults.ts`), so a test and its
 * screenshot see the colours VS Code shows: a link, a footnote reference `[1]`
 * and its back-link `↩` in the theme's `textLink-foreground`, not the
 * browser's own blue.
 */
suite('Editor webview defaults (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ styles: ['markdown-extended.css'] });
        if (editor) {
            page = editor.page;
        }
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('the copy is the default stylesheet of the VS Code the tests run in', function () {
        const installed = installedWebviewDefaultStyles();
        if (installed === undefined) {
            this.skip();
        }
        assert.strictEqual(squeeze(WEBVIEW_DEFAULT_STYLES), squeeze(installed as string));
    });

    test('the defaults are the head\'s first element, as VS Code prepends them', async function () {
        if (!editor) {
            this.skip();
        }
        const first = await page.evaluate(() => {
            const element = document.head.firstElementChild;
            return { tag: element?.tagName, id: element?.id, text: element?.textContent ?? '' };
        });
        assert.deepStrictEqual({ tag: first.tag, id: first.id }, { tag: 'STYLE', id: WEBVIEW_DEFAULT_STYLES_ID });
        assert.strictEqual(squeeze(first.text), squeeze(WEBVIEW_DEFAULT_STYLES));
    });

    test('a link, a footnote reference and its back-link take the theme\'s link colour', async function () {
        this.timeout(30000);
        if (!editor) {
            this.skip();
        }
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, LINKS, {})), version: 1, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(() => document.querySelector('.ProseMirror .footnote-backref') !== null);
        // Every theme drawn before any is judged, so a failing run still leaves both screenshots.
        const seen: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        for (const theme of [LIGHT_MODERN, DARK_MODERN]) {
            await applyTheme(page, theme);
            await delay(80);
            await shot(page, `links-${theme.bodyClass}.png`);
            seen[theme.name] = await page.evaluate(() => {
                const colour = (selector: string) => {
                    const element = document.querySelector(`.ProseMirror ${selector}`);
                    return element ? getComputedStyle(element).color : `no ${selector}`;
                };
                return { link: colour('a[href^="https:"]'), reference: colour('sup.footnote-ref > a'), backLink: colour('a.footnote-backref') };
            });
            const link = computedColour(theme.variables['textLink-foreground']);
            expected[theme.name] = { link, reference: link, backLink: link };
        }
        assert.deepStrictEqual(seen, expected);
    });
});
