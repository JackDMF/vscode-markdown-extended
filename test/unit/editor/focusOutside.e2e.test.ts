import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { ParsedDocumentJSON, parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { clickText, closeEditorPage, delay, EditorPage, EXTENSION_ID, openEditorPage, shot, MOD, SHOTS_DIR } from './pageHarness';
import { assertRowFree } from './rowLock';
import { DARK_MODERN, LIGHT_MODERN, Theme, applyTheme } from './themes';

const SELECTION_BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/**
 * Only the controls a node view declares — an open source box, the properties
 * panel — hold the bars and the formatting row (`focusPlace.ts`). Whatever
 * else in the text can take the focus — another extension's lens, a status
 * badge, a summary table's cell, a link in a rendering — leaves them as they
 * were before there was a model: the row offered, the selection's bar the
 * selection's. Driven with the real keyboard, as a person tabs through.
 */
suite('Editor focus outside the declared controls (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const parse = async (text: string) => parsedDocumentToJSON(parseDocument(await buildEditorEngine(EXTENSION_ID, () => undefined), text, {}));

    /** Post `text`, or a document built from a parse, as the host does, the focus taken out of any box first. */
    const showDocument = async (doc: string | ParsedDocumentJSON) => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const json = typeof doc === 'string' ? await parse(doc) : doc;
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await delay(150);
    };

    const tab = async () => {
        await page.keyboard.press('Tab');
        await delay(150);
    };

    const active = () => page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a ? { tag: a.tagName.toLowerCase(), lens: a.dataset.lens ?? null } : null;
    });

    const verbsOf = (selector: string) => page.$eval(selector, el => Array.from(el.querySelectorAll('[data-verb]')).map(v => (v as HTMLElement).dataset.verb));

    const LENSED = 'Intro.\n\n# Heading\n\nA paragraph.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';

    /** LENSED with another extension's lens rows over the heading and the table. */
    const showLensed = async () => {
        await showDocument(LENSED);
        await (editor as EditorPage).send({
            type: 'lenses', version, blocks: 4, rows: [
                { blockIndex: 1, items: [{ id: '1.0', title: 'Heading lens' }, { id: '1.1', title: 'Second' }] },
                { blockIndex: 3, items: [{ id: '1.2', title: 'Table lens' }] },
            ],
        });
        await page.waitForSelector('.mep-lens-row');
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('Tab from the text onto a lens: the row stays offered, no bar comes', async function () {
        this.timeout(15000);
        await showLensed();
        await clickText(page, 'Intro', 2);
        await tab();
        assert.deepStrictEqual(await active(), { tag: 'button', lens: '1.0' });
        await assertRowFree(page, 'a lens has the focus');
        assert.strictEqual(await page.$(SELECTION_BAR), null);
    });

    test('Tab onto a status badge and a summary table\'s cell: the row stays offered, no bar comes', async function () {
        this.timeout(15000);
        const mark = { rule: 'req-status-badges', kind: 'atom', artifact: 'FRS-TST-001' };
        const summary = '<table class="req-summary" data-req-id="FRS-TST-001"><tbody class="req-summary-fields">'
            + '<tr data-req-field="priority"><th scope="row">Priority</th><td>high</td></tr></tbody></table>';
        const json = await parse('# FRS-TST-001: Page\n\nIntro.\n\n## Plain heading\n\nA plain paragraph.\n');
        const content = (json.doc as { content: Record<string, unknown>[] }).content;
        (content[0].attrs as Record<string, unknown>).reqPrefix = 'FRS-TST-001: ';
        content[0].content = [{ type: 'text', text: 'Page ' }, { type: 'inline_atom', attrs: { html: '<span class="req-badge req-badge-implemented">implemented</span>', mark } }];
        content.splice(1, 0, { type: 'injected_block', attrs: { kind: 'atom', mark, html: summary, src: null, gap: null } });
        await showDocument(json);
        await (editor as EditorPage).send({
            type: 'lenses', version, blocks: 5, rows: [{
                blockIndex: 0, items: [
                    { id: 's.0', title: 'Set status', surface: 'status', artifact: 'FRS-TST-001' },
                    { id: 'p.0', title: 'Set priority', surface: 'priority', artifact: 'FRS-TST-001' },
                ],
            }],
        });
        await page.waitForSelector('.mep-lens-target');
        await clickText(page, 'plain paragraph', 2);
        await tab();
        assert.deepStrictEqual(await active(), { tag: 'span', lens: 's.0' });
        await assertRowFree(page, 'the badge has the focus');
        assert.strictEqual(await page.$(SELECTION_BAR), null);
        await tab();
        assert.deepStrictEqual(await active(), { tag: 'td', lens: 'p.0' });
        await assertRowFree(page, 'the summary\'s cell has the focus');
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'no bar of the summary');
    });

    test('Tab into a rendered link and summary of a source block: the row stays offered; a selected block keeps Edit source', async function () {
        this.timeout(15000);
        await showDocument('Para one.\n\n<div class="x"><a href="https://example.com">a link</a> and <details><summary>More</summary>hidden</details></div>\n\nPara two.\n');
        await page.waitForSelector('.mep-raw-block a');
        await clickText(page, 'Para one', 3);
        await tab();
        assert.deepStrictEqual(await active(), { tag: 'a', lens: null });
        await assertRowFree(page, 'a rendered link has the focus');
        assert.strictEqual(await page.$(SELECTION_BAR), null);
        await tab();
        assert.deepStrictEqual(await active(), { tag: 'summary', lens: null });
        await assertRowFree(page, 'a rendered summary has the focus');

        // The block selected, then Tab onto its link: no box is open, so its bar is as it was.
        const block = await (await page.$('.mep-raw-block'))?.boundingBox();
        assert.ok(block);
        await page.mouse.click(block.x + block.width - 4, block.y + block.height / 2);
        await delay(150);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="raw_block"]`);
        await tab();
        assert.deepStrictEqual(await active(), { tag: 'a', lens: null });
        assert.deepStrictEqual(await verbsOf(`${SELECTION_BAR}[data-object="raw_block"]`), ['edit-source', 'show-in-text-editor', 'delete-block']);
    });

    test('Ctrl+K: while the row\'s own link field has the focus, the selection\'s bar is not shown beside it', async function () {
        this.timeout(15000);
        await showDocument('Some [linked text](https://x.y) here.\n');
        await clickText(page, 'linked', 2);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="link"]`, { timeout: 2000 });
        await page.keyboard.down(MOD);
        await page.keyboard.press('k');
        await page.keyboard.up(MOD);
        await page.waitForSelector('.mep-object-toolbar[data-trigger="toolbar"] .mep-inline-field');
        await delay(500);
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'one bar: the field\'s');
        await page.keyboard.press('Escape');
    });

    test('Tab onto a lens, shot in light and dark', async function () {
        if (!SHOTS_DIR) {
            return;
        }
        this.timeout(60000);
        const themes: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']];
        try {
            for (const [theme, name] of themes) {
                await applyTheme(page, theme);
                await showLensed();
                await clickText(page, 'Intro', 2);
                await tab();
                await assertRowFree(page, 'a lens has the focus');
                await shot(page, `lens-${name}-tab-onto-lens.png`);
            }
        } finally {
            await applyTheme(page, LIGHT_MODERN);
        }
    });
});
