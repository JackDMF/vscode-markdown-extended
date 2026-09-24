import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as vscode from 'vscode';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { HostMessage, WebviewMessage } from '../../../src/editor/protocol';

const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

const FRONT_AND_HEADING = [
    '---',
    'id: FRS-TST-001',
    'title: Page',
    '---',
    '',
    '## FRS-TST-001: Page {#frs-tst-001-1a2b3c4d}',
    '',
    '',
].join('\n');
const PARAGRAPH = 'A paragraph that stays\nwrapped as it was written.\n';
const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n';
const SOURCE = `${FRONT_AND_HEADING}${PARAGRAPH}\n${TABLE}`;

/**
 * The WYSIWYG editor's page (`dist/editor-webview.js`) driven in headless
 * Chromium, with `acquireVsCodeApi` replaced by a recorder: the host's half of
 * the protocol is played by the test.
 *
 * This is the only place the page runs outside a real webview, and it covers
 * what the extension-host smoke test cannot see: that the document renders,
 * that typing and a raw block's source edit come back as the right text, and
 * that undo returns the file to its exact bytes.
 *
 * CI-safe in the same way as the other e2e tests: it skips unless a browser is
 * already available (`MTE_E2E_CHROME`, or the one Puppeteer installed), and
 * never triggers a download.
 */
suite('Editor webview (e2e)', () => {
    let executablePath: string | undefined;
    let bundle: string;
    let browser: puppeteer.Browser | undefined;
    let page: puppeteer.Page;

    const posted = async (): Promise<WebviewMessage[]> =>
        page.evaluate(() => (window as unknown as { posted: WebviewMessage[] }).posted.slice());
    const edits = async () => (await posted()).filter((m): m is Extract<WebviewMessage, { type: 'edit' }> => m.type === 'edit');
    const send = (message: HostMessage) => page.evaluate(m => window.postMessage(m, '*'), message as unknown as Record<string, unknown>);
    const settle = () => new Promise(resolve => setTimeout(resolve, 500));

    suiteSetup(async function () {
        this.timeout(60000);
        const extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
        bundle = extensionPath ? path.join(extensionPath, 'dist', 'editor-webview.js') : '';
        if (!bundle || !fs.existsSync(bundle)) {
            this.skip();
        }
        const envChrome = process.env.MTE_E2E_CHROME;
        if (envChrome && fs.existsSync(envChrome)) {
            executablePath = envChrome;
        } else {
            try {
                const bundled = puppeteer.executablePath();
                executablePath = bundled && fs.existsSync(bundled) ? bundled : undefined;
            } catch {
                executablePath = undefined;
            }
        }
        if (!executablePath) {
            this.skip();
        }

        browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 900 });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(String(error)));
        await page.setContent(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
            + '<body class="markdown-body vscode-body vscode-light"><div id="mep-editor" class="mep-editor"></div>'
            + '<script>window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m) });</script>'
            + '</body></html>',
            { waitUntil: 'load' },
        );
        await page.addStyleTag({ path: path.join(extensionPath as string, 'styles', 'editor.css') });
        await page.addScriptTag({ path: bundle });
        assert.deepStrictEqual(errors, []);

        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, SOURCE, {}));
        // The parser lifts the id into `reqPrefix` only when Req Explorer's
        // badge names the artifact, and Req Explorer is not in the test host;
        // the heading is given the shape the parser leaves with it.
        const heading = (json.doc.content as { type: string; attrs: Record<string, unknown>; content: { text: string }[] }[])
            .find(n => n.type === 'heading');
        assert.ok(heading);
        heading.attrs.reqPrefix = 'FRS-TST-001: ';
        heading.content = [{ ...heading.content[0], text: 'Page' }];
        assert.deepStrictEqual((await posted()).map(m => m.type), ['ready']);
        await send({ type: 'document', json, version: 1, defaultWrap: 90 });
        await page.waitForSelector('.ProseMirror');
    });

    suiteTeardown(async () => {
        await browser?.close();
    });

    test('the document renders: front matter folded, the id read-only, the table as a raw block', async () => {
        const shape = await page.evaluate(() => ({
            frontMatter: document.querySelector('details.mep-front-matter pre')?.textContent,
            prefix: document.querySelector('h2 .mep-req-prefix')?.textContent,
            prefixEditable: document.querySelector('h2 .mep-req-prefix')?.getAttribute('contenteditable'),
            title: document.querySelector('h2 .mep-heading-text')?.textContent,
            anchor: document.querySelector('h2')?.id,
            table: document.querySelectorAll('.mep-raw-block table td').length,
        }));
        // The block exactly as the file holds it, fences included.
        assert.strictEqual(shape.frontMatter, '---\nid: FRS-TST-001\ntitle: Page\n---\n');
        assert.strictEqual(shape.prefix, 'FRS-TST-001: ');
        assert.strictEqual(shape.prefixEditable, 'false');
        assert.strictEqual(shape.title, 'Page');
        assert.strictEqual(shape.anchor, 'frs-tst-001-1a2b3c4d');
        assert.strictEqual(shape.table, 2);
        assert.deepStrictEqual(await edits(), [], 'showing the document wrote nothing');
    });

    test('"Show in text editor" names the line the raw block starts on', async function () {
        this.timeout(10000);
        await page.click('.mep-raw-block .mep-atom-content');
        const [, show] = await page.$$('.mep-raw-block .mep-atom-button');
        await show.click();
        const open = (await posted()).filter(m => m.type === 'openSource').pop();
        assert.deepStrictEqual(open, { type: 'openSource', line: SOURCE.split('\n').indexOf('| a | b |') });
        assert.deepStrictEqual(await edits(), [], 'selecting a block wrote nothing');
    });

    test('typing re-serializes only the changed paragraph', async function () {
        this.timeout(10000);
        await page.click('.ProseMirror p');
        await page.keyboard.press('End');
        await page.keyboard.type(' Extra.');
        await settle();
        const all = await edits();
        assert.strictEqual(all.length, 1);
        const text = all[0].text;
        assert.strictEqual(all[0].baseVersion, 1);
        assert.ok(text.startsWith(FRONT_AND_HEADING), text);
        assert.ok(text.endsWith(`\n${TABLE}`), text);
        const paragraph = text.slice(FRONT_AND_HEADING.length, text.length - TABLE.length - 1);
        assert.strictEqual(paragraph.replace(/\s+/g, ' ').trim(), 'A paragraph that stays wrapped as it was written. Extra.');
    });

    test('a raw block\'s source edit asks the host to render it and writes the new source', async function () {
        this.timeout(10000);
        await page.click('.mep-raw-block .mep-atom-content');
        await page.click('.mep-raw-block .mep-atom-button');
        await page.waitForSelector('.mep-raw-editor');
        const value = await page.$eval('.mep-raw-editor', el => (el as HTMLTextAreaElement).value);
        assert.strictEqual(value, TABLE.replace(/\n$/, ''));
        await page.$eval('.mep-raw-editor', el => {
            (el as HTMLTextAreaElement).value = '| a | b |\n| - | - |\n| 9 | 9 |';
        });
        await page.focus('.mep-raw-editor');
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');

        const render = (await posted()).find((m): m is Extract<WebviewMessage, { type: 'render' }> => m.type === 'render');
        assert.ok(render, 'no render request');
        assert.strictEqual(render.src, '| a | b |\n| - | - |\n| 9 | 9 |\n');
        await send({ type: 'rendered', requestId: render.requestId, html: '<p class="mep-test-rendered">rendered</p>' });
        await page.waitForSelector('.mep-raw-block .mep-test-rendered');

        await settle();
        const last = (await edits()).pop();
        assert.ok(last?.text.endsWith('\n| a | b |\n| - | - |\n| 9 | 9 |\n'), last?.text);
    });

    test('undo returns the file to its exact bytes', async function () {
        this.timeout(10000);
        await page.focus('.ProseMirror');
        for (let i = 0; i < 2; i++) {
            await page.keyboard.down('Control');
            await page.keyboard.press('z');
            await page.keyboard.up('Control');
        }
        await settle();
        const last = (await edits()).pop();
        assert.strictEqual(last?.text, SOURCE);
    });

    test('a new document from the host is taken in place: edits go against its version, and undo still reaches earlier ones', async function () {
        this.timeout(15000);
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const next = `${FRONT_AND_HEADING}Rewritten by another writer.\n`;
        await send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, next, {})), version: 5, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelector('.ProseMirror p')?.textContent === 'Rewritten by another writer.');
        const before = (await edits()).length;
        await page.click('.ProseMirror p');
        await page.keyboard.press('End');
        await page.keyboard.type('!');
        await settle();
        let all = await edits();
        assert.strictEqual(all.length, before + 1);
        assert.strictEqual(all[all.length - 1].baseVersion, 5);
        const typed = `${FRONT_AND_HEADING}Rewritten by another writer.!\n`;
        assert.strictEqual(all[all.length - 1].text, typed);

        // Another writer appends a paragraph (or a save trims the file): the
        // host posts the text it now holds.
        const appended = `${typed}\nAppended elsewhere.\n`;
        await send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, appended, {})), version: 6, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelectorAll('.ProseMirror p').length === 2);
        await settle();
        assert.strictEqual((await edits()).length, before + 1, 'taking the host\'s document wrote nothing back');

        await page.focus('.ProseMirror');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await settle();
        all = await edits();
        assert.strictEqual(all.length, before + 2);
        assert.strictEqual(all[all.length - 1].baseVersion, 6);
        assert.strictEqual(all[all.length - 1].text, `${FRONT_AND_HEADING}Rewritten by another writer.\n\nAppended elsewhere.\n`,
            'the "!" typed before the host\'s document is undone; the other writer\'s paragraph stays');
    });

    test('an include expansion offers its snippet file; a missing one offers nothing', async function () {
        this.timeout(10000);
        // Req Explorer is not installed in the test host, so the expansions are
        // written as the parser would leave them (SPEC §10.2 marks).
        const expansion = (mark: Record<string, unknown>, html: string) => ({
            type: 'injected_block',
            attrs: { kind: 'expansion', mark, html, src: `<!-- include: ${String(mark.snippet)} -->\n`, gap: '\n' },
        });
        const doc = {
            type: 'doc',
            content: [
                { type: 'paragraph', attrs: { src: 'Before.\n', gap: '' }, content: [{ type: 'text', text: 'Before.' }] },
                expansion({ rule: 'req-includes', kind: 'expansion', snippet: 'legal-notice', line: 2, path: 'C:\\corpus\\snippets\\legal-notice.md' }, '<p>Snippet body.</p>'),
                expansion({ rule: 'req-includes', kind: 'expansion', snippet: 'gone', line: 4, missing: true }, '<p>Snippet not found.</p>'),
            ],
        };
        await send({ type: 'document', json: { doc, eol: '\n', tail: '' }, version: 9, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelectorAll('.mep-injected-block').length === 2);
        const buttons = await page.$$eval('.mep-injected-block', blocks => blocks.map(b => b.querySelectorAll('.mep-atom-button').length));
        assert.deepStrictEqual(buttons, [1, 0]);
        await page.click('.mep-injected-block .mep-atom-button');
        const open = (await posted()).find((m): m is Extract<WebviewMessage, { type: 'openSnippet' }> => m.type === 'openSnippet');
        assert.strictEqual(open?.path, 'C:\\corpus\\snippets\\legal-notice.md');
    });

    test('the error state replaces the editor and offers the text editor', async function () {
        this.timeout(10000);
        await send({ type: 'error', message: 'the source blocks do not account for every line' });
        await page.waitForSelector('.mep-error');
        assert.strictEqual(await page.$('.ProseMirror'), null);
        await page.click('.mep-error .mep-atom-button');
        const open = (await posted()).filter(m => m.type === 'openSource').pop();
        assert.deepStrictEqual(open, { type: 'openSource', line: 0 });
    });

    test('Enter inside a requirement heading starts a paragraph, so the id is written once', async function () {
        this.timeout(10000);
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, SOURCE, {}));
        const heading = (json.doc.content as { type: string; attrs: Record<string, unknown>; content: { text: string }[] }[])
            .find(n => n.type === 'heading');
        assert.ok(heading);
        heading.attrs.reqPrefix = 'FRS-TST-001: ';
        heading.content = [{ ...heading.content[0], text: 'Page' }];
        await send({ type: 'document', json, version: 11, defaultWrap: 90 });
        await page.waitForSelector('.ProseMirror h2 .mep-heading-text');

        const before = (await edits()).length;
        // A click in the middle of the title puts the caret inside it, and
        // ProseMirror takes it over on the selectionchange that follows, which
        // is given time to arrive: a key pressed at once would act on the
        // selection before the click. (Arrow keys are no use for placing the
        // caret here: in headless Chromium their moves did not reach the state.)
        await page.click('.ProseMirror h2 .mep-heading-text');
        await new Promise(resolve => setTimeout(resolve, 150));
        await page.keyboard.press('Enter');
        await settle();
        const all = await edits();
        assert.strictEqual(all.length, before + 1);
        const text = all[all.length - 1].text;
        const lines = text.split('\n');
        const at = lines.findIndex(l => l.startsWith('## FRS-TST-001: '));
        const match = /^## FRS-TST-001: (.+) \{#frs-tst-001-1a2b3c4d\}$/.exec(lines[at]);
        assert.ok(match, text);
        assert.strictEqual(lines[at + 1], '', text);
        assert.ok(match[1].length > 0 && match[1].length < 'Page'.length, 'the caret was inside the title');
        assert.strictEqual(match[1] + lines[at + 2], 'Page', 'the text after the caret is the paragraph below');
        assert.strictEqual(text.split('FRS-TST-001:').length, 2, 'the id is written once');
        assert.strictEqual(text.split('{#frs-tst-001-1a2b3c4d}').length, 2, 'the anchor is written once');
    });
});
