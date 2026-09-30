import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import type { WebviewMessage } from '../../../src/editor/protocol';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { EXTENSION_ID, EditorPage, openEditorPage, vscodeMarkdownCss } from './pageHarness';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** With `MEP_SHOTS_DIR` set, the suite saves a screenshot of each state it names there; without it, none. */
const SHOTS = process.env.MEP_SHOTS_DIR;

const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/** A requirement document, as the sketch of 2026-09-30 drew one. */
const SOURCE = [
    '## FRS-RXE-007: Configurable requirement states {#frs-rxe-007}',
    '',
    'Requirement states are configurable. The built-in `implemented / partial / gap / proposed` remain the **default**; a workspace may add *states* of its own in its profile, and every surface reads the ordered list from there.',
    '',
    '| State | Meaning | Counts as done |',
    '| :---- | :------ | :------------: |',
    '| implemented | Delivered and verified | yes |',
    '| partial | Delivered in part, the residue named | no |',
    '| gap | Not delivered | no |',
    '',
    'The core resolves the effective vocabulary and threads it through `buildIndex`, so the editor, the CLI and the report agree.',
    '',
].join('\n');

const PREFIX = 'FRS-RXE-007: ';

/** `#rrggbb` or `rgba(r, g, b, a)` as the browser computes it, for comparing with a computed style. */
function computed(colour: string): string {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
    return hex ? `rgb(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)})` : colour;
}

/**
 * The formatting row, its menus, the object bars and the bubble are VS Code
 * chrome (Daniel, 2026-09-30): every colour one of the workbench's variables,
 * so the page follows the theme — checked here in Light Modern, Dark Modern and
 * Dark High Contrast, the variables supplied as VS Code supplies them
 * (`themes.ts`). The row is full width at the editor's top, its controls 22px,
 * its dropdowns the codicon chevron.
 */
suite('Editor chrome (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const shot = async (name: string) => {
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, name) });
        }
    };

    const showDocument = async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, SOURCE, {}));
        // As the parser leaves a requirement heading when Req Explorer is installed: the id lifted.
        const heading = (json.doc.content as { type: string; attrs: Record<string, unknown>; content: { text: string }[] }[])[0];
        heading.attrs.reqPrefix = PREFIX;
        heading.content = [{ ...heading.content[0], text: heading.content[0].text.slice(PREFIX.length) }];
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('buildIndex'));
        await (editor as EditorPage).send({
            type: 'diagnostics', version, items: [
                { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 11 } }, severity: 'error', message: 'Unknown requirement state' },
                { range: { start: { line: 2, character: 90 }, end: { line: 2, character: 97 } }, severity: 'warning', message: 'Unknown word' },
                { range: { start: { line: 10, character: 4 }, end: { line: 10, character: 8 } }, severity: 'warning', message: 'Unknown word' },
            ],
        });
        await page.waitForSelector('.mep-diag-count:not([hidden])');
        await page.mouse.move(640, 700);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await delay(200);
    };

    /** A real click on character `index` of `needle`. */
    const clickAt = async (needle: string, index = 1) => {
        const p = await page.evaluate((n, k) => {
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
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
        await page.mouse.click(p.x, p.y);
        await delay(80);
    };

    const style = (selector: string, ...properties: string[]) => page.$eval(selector, (el, props) => {
        const cs = getComputedStyle(el);
        return Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)]));
    }, properties);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({
            width: 1280, height: 800,
            stylesheets: [vscodeMarkdownCss()],
            styles: ['markdown-extended.css', 'markdown-it-admonition.css', 'markdown-it-kbd.css'],
        });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    const themes: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']];

    test('the row is chrome: full width at the top, the tab strip\'s colours, 22px controls, the codicon chevron, the count at its right end', async function () {
        this.timeout(20000);
        for (const [theme, suffix] of [...themes, [HC_DARK, 'hc'] as [Theme, string]]) {
            await applyTheme(page, theme);
            await showDocument();
            const row = await page.$eval('.mep-toolbar', el => {
                const r = el.getBoundingClientRect();
                return { left: r.left, top: r.top, right: r.right, height: r.height, width: document.documentElement.clientWidth };
            });
            assert.deepStrictEqual(row, { left: 0, top: 0, right: row.width, height: 27, width: row.width }, `${theme.name}: the row spans the editor at its top`);
            const look = await style('.mep-toolbar', 'background-color', 'border-bottom-color', 'font-size', 'border-radius', 'box-shadow');
            const tabs = theme.variables['editorGroupHeader-tabsBackground'] ?? theme.variables['editor-background'];
            const edge = theme.variables['editorGroupHeader-tabsBorder'] ?? theme.variables['editorGroupHeader-border'];
            assert.deepStrictEqual(look, {
                'background-color': computed(tabs), 'border-bottom-color': computed(edge), 'font-size': '12px', 'border-radius': '0px', 'box-shadow': 'none',
            }, theme.name);
            const heights = await page.$$eval('.mep-toolbar .mep-tool', els => els.map(e => e.getBoundingClientRect().height));
            assert.ok(heights.length >= 9 && heights.every(h => h === 22), `every control 22px: ${heights.join(', ')}`);
            const chevrons = await page.$$eval('.mep-toolbar .mep-menu-face', els => els.map(e => e.querySelector(':scope > .mep-menu-caret > .codicon-chevron-down') !== null));
            assert.deepStrictEqual(chevrons, [true, true, true, true], 'each menu face ends in the codicon chevron');
            const samples = await page.$$eval('.mep-toolbar .mep-mark-tool .mep-sample > *', els => els.map(e => e.tagName.toLowerCase()));
            assert.deepStrictEqual(samples, ['i', 'em', 'b', 'strong', 'code'], 'the marks are their real elements');
            const last = await page.$eval('.mep-toolbar', el => (el.lastElementChild as HTMLElement).className);
            assert.strictEqual(last, 'mep-row-status', 'the count keeps its slot at the right end');
            // The caret in a paragraph, so the block-type face reads as the row does while one writes.
            await clickAt('workspace', 2);
            await page.mouse.move(640, 700);
            await delay(100);
            await shot(`01-row-${suffix}.png`);
        }
        await applyTheme(page, LIGHT_MODERN);
    });

    test('the Insert menu is the workbench\'s context menu: its colours, 5px corners, the selection on the entry under the pointer', async function () {
        this.timeout(20000);
        for (const [theme, suffix] of themes) {
            await applyTheme(page, theme);
            await showDocument();
            await clickAt('configurable', 3);
            const faceBox = await (await page.$('.mep-toolbar .mep-menu-face[data-menu="insert"]'))?.boundingBox();
            assert.ok(faceBox);
            await page.mouse.click(faceBox.x + faceBox.width / 2, faceBox.y + faceBox.height / 2);
            await page.waitForSelector('.mep-menu[data-menu="insert"]:not([hidden])');
            assert.strictEqual(await page.$eval('.mep-menu-face[data-menu="insert"]', el => el.getAttribute('aria-expanded')), 'true');
            const menu = await style('.mep-menu[data-menu="insert"]', 'background-color', 'border-top-left-radius', 'color');
            assert.deepStrictEqual(menu, {
                'background-color': computed(theme.variables['menu-background']), 'border-top-left-radius': '5px', 'color': computed(theme.variables['menu-foreground']),
            }, theme.name);
            const item = await (await page.$('.mep-menu[data-menu="insert"] .mep-menu-item:nth-child(2)'))?.boundingBox();
            assert.ok(item);
            await page.mouse.move(item.x + 40, item.y + item.height / 2);
            await delay(120);
            const hovered = await style('.mep-menu[data-menu="insert"] .mep-menu-item:nth-child(2)', 'background-color', 'color');
            assert.deepStrictEqual(hovered, {
                'background-color': computed(theme.variables['menu-selectionBackground']), 'color': computed(theme.variables['menu-selectionForeground']),
            }, `${theme.name}: the entry under the pointer is selected`);
            await shot(`02-insert-menu-${suffix}.png`);
            await page.keyboard.press('Escape');
            await delay(80);
        }
        await applyTheme(page, LIGHT_MODERN);
    });

    test('a heading\'s bar and the table\'s bar are editor widgets with the row\'s 22px controls; a set-verb carries the chevron', async function () {
        this.timeout(20000);
        for (const [theme, suffix] of themes) {
            await applyTheme(page, theme);
            await showDocument();
            // The heading's bar shows for the code actions other extensions offer on it.
            await clickAt('Configurable', 3);
            await delay(INLINE_DELAY_MS + 150);
            const asked = (await (editor as EditorPage).posted()).filter((m): m is Extract<WebviewMessage, { type: 'actionsFor' }> => m.type === 'actionsFor');
            const request = asked[asked.length - 1];
            assert.ok(request, 'the heading\'s actions were asked for');
            await (editor as EditorPage).send({
                type: 'actions', requestId: request.requestId, blockIndex: request.blockIndex, items: [
                    { id: 'a1', title: '$(add) Add verified-by link…', kind: 'refactor' },
                    { id: 'a2', title: 'Set status…', kind: 'refactor' },
                ],
            });
            await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
            await delay(100);
            const bar = await style(BAR, 'background-color', 'border-top-color', 'font-size');
            assert.deepStrictEqual(bar, {
                'background-color': computed(theme.variables['editorWidget-background']), 'border-top-color': computed(theme.variables['editorWidget-border']), 'font-size': '12px',
            }, theme.name);
            const verbs = await page.$$eval(`${BAR} .mep-object-verb`, els => els.map(e => e.getBoundingClientRect().height));
            assert.ok(verbs.length === 2 && verbs.every(h => h === 22), `22px verbs: ${verbs.join(', ')}`);
            await shot(`03-heading-bar-${suffix}.png`);

            await clickAt('Delivered and', 3);
            await page.waitForFunction(sel => document.querySelector(sel)?.getAttribute('data-object') === 'table', { timeout: 2000 }, BAR);
            await delay(100);
            const chevrons = await page.$$eval(`${BAR} .mep-object-verb`, els => els.map(e => [(e as HTMLElement).dataset.verb, e.textContent, e.querySelector('.mep-menu-caret .codicon-chevron-down') !== null]));
            assert.deepStrictEqual(chevrons, [
                ['row', 'Row', true], ['column', 'Column', true], ['align', 'Align', true], ['edit-source', 'Edit source', false], ['delete-table', 'Delete table', false],
            ]);
            const heights = await page.$$eval(`${BAR} .mep-object-verb`, els => els.map(e => e.getBoundingClientRect().height));
            assert.ok(heights.every(h => h === 22), `22px verbs: ${heights.join(', ')}`);
            await shot(`04-table-bar-${suffix}.png`);
            const row = await (await page.$(`${BAR} [data-verb="row"]`))?.boundingBox();
            assert.ok(row);
            await page.mouse.click(row.x + row.width / 2, row.y + row.height / 2);
            await page.waitForSelector(`${BAR} .mep-object-menu`, { visible: true, timeout: 2000 });
            const menu = await style(`${BAR} .mep-object-menu`, 'background-color', 'border-top-left-radius');
            assert.deepStrictEqual(menu, { 'background-color': computed(theme.variables['menu-background']), 'border-top-left-radius': '5px' }, 'the Row menu is the same menu');
            await shot(`04-table-row-menu-${suffix}.png`);
            await page.keyboard.press('Escape');
            await delay(80);
        }
        await applyTheme(page, LIGHT_MODERN);
    });

    test('the selection bubble is an editor widget holding the five marks at 22px', async function () {
        this.timeout(20000);
        for (const [theme, suffix] of themes) {
            await applyTheme(page, theme);
            await showDocument();
            await page.focus('.ProseMirror');
            await page.evaluate(() => {
                const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    const at = (node.textContent ?? '').indexOf('resolves the effective');
                    if (at >= 0) {
                        (document.getSelection() as Selection).setBaseAndExtent(node, at, node, at + 'resolves the effective'.length);
                        return;
                    }
                }
            });
            await page.waitForSelector('.mep-bubble:not([hidden])', { timeout: 2000 });
            await delay(100);
            const bubble = await style('.mep-bubble', 'background-color', 'border-top-color');
            assert.deepStrictEqual(bubble, {
                'background-color': computed(theme.variables['editorWidget-background']), 'border-top-color': computed(theme.variables['editorWidget-border']),
            }, theme.name);
            const heights = await page.$$eval('.mep-bubble .mep-tool', els => els.map(e => e.getBoundingClientRect().height));
            assert.ok(heights.length >= 5 && heights.every(h => h === 22), `22px controls: ${heights.join(', ')}`);
            await shot(`05-bubble-${suffix}.png`);
        }
        await applyTheme(page, LIGHT_MODERN);
    });
});
