import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { TOOLBAR_ACTIONS } from '../../../src/editor/webview/toolbar/actions';
import { ALL_LOCK, REQUIREMENT_HEADING_LOCK } from '../../../src/editor/webview/toolbar/commands';
import { ADMONITION_TYPES } from '../../../src/syntax/markers';
import { EXTENSION_ID, EditMessage, EditorPage, openEditorPage, settle } from './pageHarness';

const SOURCE = [
    '## FRS-TST-001: Page {#frs-tst-001-1a2b3c4d}',
    '',
    'Alpha beta gamma.',
    '',
    'Second paragraph here.',
    '',
].join('\n');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The formatting toolbar and the selection bubble in the real page bundle,
 * driven in headless Chromium (see `pageHarness.ts`). Each test starts from a
 * fresh document the test posts as the host, so none depends on another.
 */
suite('Editor toolbar (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    /** Post `text` parsed, as the host does; the requirement heading shaped as Req Explorer's badge leaves it. */
    const showDocument = async (text: string, requirement = true) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, text, {}));
        if (requirement) {
            const heading = (json.doc.content as { type: string; attrs: Record<string, unknown>; content: { text: string }[] }[])
                .find(n => n.type === 'heading');
            if (heading && heading.content[0].text.startsWith('FRS-TST-001: ')) {
                heading.attrs.reqPrefix = 'FRS-TST-001: ';
                heading.content = [{ ...heading.content[0], text: heading.content[0].text.slice('FRS-TST-001: '.length) }];
            }
        }
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90 });
        await page.waitForFunction(v => document.querySelector('.ProseMirror')?.textContent?.includes(v as string), {}, text.includes('Alpha') ? 'Alpha' : '');
        await delay(50);
    };

    /** Select `needle` in the document the way the pointer would, and let ProseMirror read it. */
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

    const toolbarTool = (id: string) => `.mep-toolbar [data-action="${id}"]`;
    const openMenu = async (menu: string) => {
        await page.click(`.mep-toolbar [data-menu="${menu}"] .mep-menu-face`);
        await page.waitForSelector(`.mep-toolbar [data-menu="${menu}"] .mep-menu:not([hidden])`);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument(SOURCE);
        await page.waitForSelector('.mep-toolbar');
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('the toolbar has one tool per action, each drawn as its sample, its tooltip naming the syntax', async () => {
        const tools = await page.$$eval('.mep-toolbar [data-action]', els => els.map(el => {
            const sample = el.querySelector('.mep-sample > *') as HTMLElement;
            return { id: (el as HTMLElement).dataset.action, tag: sample.tagName.toLowerCase(), className: sample.className, title: (el as HTMLElement).title };
        }));
        assert.deepStrictEqual(tools.map(t => t.id), TOOLBAR_ACTIONS.map(a => a.id));
        for (const action of TOOLBAR_ACTIONS) {
            const tool = tools.find(t => t.id === action.id);
            assert.strictEqual(tool?.tag, action.sample.tag, action.id);
            assert.strictEqual(tool?.className, action.sample.className ?? '', action.id);
            assert.ok(tool?.title.includes(action.syntax.split('\n')[0]), `${action.id}: ${tool?.title}`);
        }
        const stickyAboveDocument = await page.evaluate(() => {
            const bar = document.querySelector('.mep-toolbar') as HTMLElement;
            return getComputedStyle(bar).position === 'sticky' && bar.nextElementSibling?.classList.contains('ProseMirror');
        });
        assert.strictEqual(stickyAboveDocument, true);
    });

    test('*i* marks the selection with *, and _em_ on it swaps the delimiter', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('beta');
        await page.click(toolbarTool('italic'));
        await settle();
        assert.ok((await lastEdit())?.text.includes('Alpha *beta* gamma.'), (await lastEdit())?.text);
        assert.strictEqual(await page.$eval('.ProseMirror p i', el => el.textContent), 'beta');
        assert.strictEqual(await page.$eval(toolbarTool('italic'), el => el.classList.contains('mep-active')), true);

        await page.click(toolbarTool('emphasis'));
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('Alpha _beta_ gamma.'), edit?.text);
        assert.strictEqual(await page.$('.ProseMirror p i'), null, 'swapped, not nested');
        assert.strictEqual(await page.$eval('.ProseMirror p em', el => el.textContent), 'beta');
        const active = await page.$$eval('.mep-toolbar .mep-active[data-action]', els => els.map(el => (el as HTMLElement).dataset.action));
        assert.deepStrictEqual(active.filter(id => id === 'italic' || id === 'emphasis'), ['emphasis']);
    });

    test('a tool is reachable by keyboard and acts on Enter', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('gamma');
        await page.focus(toolbarTool('bold'));
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('Alpha beta **gamma**.'), (await lastEdit())?.text);
    });

    test('the sidenote posts its source with reparse, the host\'s parse shows it rendered, and one undo takes it back', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        const before = (await (editor as EditorPage).edits()).length;
        await selectText('beta');
        await page.click(toolbarTool('sidenote'));
        // No settle: the edit goes at once, asking to be parsed again.
        const all = await (editor as EditorPage).edits();
        assert.strictEqual(all.length, before + 1);
        const edit = all[all.length - 1];
        assert.strictEqual(edit.reparse, true);
        assert.strictEqual(edit.text, SOURCE.replace('beta', '++beta|note++'));

        // The host's half: the edit lands, and the document comes back parsed.
        await showDocument(edit.text);
        await page.waitForSelector('.ProseMirror .mep-raw-block .sn-ref');

        await page.focus('.ProseMirror');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await settle();
        const undone = await lastEdit();
        assert.strictEqual(undone?.text, SOURCE, 'the wrap and the host\'s re-sync after it are undone as one step');
        assert.strictEqual(undone?.reparse, undefined);
        assert.strictEqual(await page.$('.ProseMirror .mep-raw-block .sn-ref'), null);
    });

    test('the block-type menu turns a paragraph into a heading, and its face shows the type', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('Second');
        assert.strictEqual(await page.$eval('.mep-toolbar [data-menu="block-type"] .mep-menu-face', el => (el as HTMLElement).dataset.shows), 'paragraph');
        await openMenu('block-type');
        await page.click(toolbarTool('heading-2'));
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('\n## Second paragraph here.\n'), edit?.text);
        const face = await page.$eval('.mep-toolbar [data-menu="block-type"] .mep-menu-face', el => ({
            shows: (el as HTMLElement).dataset.shows,
            sample: el.querySelector('.mep-sample > *')?.tagName.toLowerCase(),
        }));
        assert.deepStrictEqual(face, { shows: 'heading-2', sample: 'h2' });
        assert.strictEqual(await page.$('.mep-toolbar [data-menu="block-type"] .mep-menu:not([hidden])'), null, 'the menu closed');
    });

    test('on a requirement heading the block-type menu is disabled and says why', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('Page');
        const face = await page.$eval('.mep-toolbar [data-menu="block-type"] .mep-menu-face', el => ({
            disabled: el.getAttribute('aria-disabled'),
            title: (el as HTMLElement).title,
        }));
        assert.strictEqual(face.disabled, 'true');
        assert.ok(face.title.includes(REQUIREMENT_HEADING_LOCK), face.title);
        await page.click('.mep-toolbar [data-menu="block-type"] .mep-menu-face');
        assert.strictEqual(await page.$('.mep-toolbar [data-menu="block-type"] .mep-menu:not([hidden])'), null, 'the menu does not open');
        assert.strictEqual(await page.$eval(toolbarTool('italic'), el => el.getAttribute('aria-disabled')), 'false', 'the title can still be formatted');
    });

    test('Ctrl+A then Horizontal rule puts the rule last, never first, and the face names why it is locked', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('beta');
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await delay(100);
        const face = await page.$eval('.mep-toolbar [data-menu="block-type"] .mep-menu-face', el => ({
            disabled: el.getAttribute('aria-disabled'),
            title: (el as HTMLElement).title,
        }));
        assert.strictEqual(face.disabled, 'true');
        assert.ok(face.title.includes(ALL_LOCK), face.title);

        await page.click(toolbarTool('horizontal-rule'));
        await settle();
        const edit = await lastEdit();
        assert.strictEqual(edit?.text, `${SOURCE}\n---\n`, 'the document starts as before, and the rule is its last block');
        assert.strictEqual(await page.$eval('.ProseMirror', el => el.lastElementChild?.querySelector('hr') !== null || el.lastElementChild?.tagName === 'HR'), true);
    });

    test('one Ctrl+B removes __strong__, and one Ctrl+I removes _em_', async function () {
        this.timeout(10000);
        const written = SOURCE.replace('Alpha beta gamma.', 'Alpha __beta__ _gamma_.');
        await showDocument(written);
        await selectText('beta');
        await page.keyboard.down('Control');
        await page.keyboard.press('b');
        await page.keyboard.up('Control');
        await selectText('gamma');
        await page.keyboard.down('Control');
        await page.keyboard.press('i');
        await page.keyboard.up('Control');
        await settle();
        assert.ok((await lastEdit())?.text.includes('\nAlpha beta gamma.\n'), (await lastEdit())?.text);
    });

    test('the bubble appears above a selection, with the inline and annotation tools, and hides when it collapses', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('gamma');
        const placed = await page.evaluate(() => {
            const bubble = document.querySelector('.mep-bubble') as HTMLElement;
            const range = (document.getSelection() as Selection).getRangeAt(0).getBoundingClientRect();
            const box = bubble.getBoundingClientRect();
            return {
                hidden: bubble.hidden,
                above: box.bottom <= range.top + 1,
                overlapsHorizontally: box.left < range.right && box.right > range.left,
                groups: Array.from(bubble.querySelectorAll('.mep-toolbar-group')).map(g => (g as HTMLElement).dataset.group),
            };
        });
        assert.deepStrictEqual(placed, { hidden: false, above: true, overlapsHorizontally: true, groups: ['inline', 'annotation'] });

        await page.evaluate(() => (document.getSelection() as Selection).collapseToStart());
        await delay(150);
        assert.strictEqual(await page.$eval('.mep-bubble', el => (el as HTMLElement).hidden), true, 'a collapsed selection has no bubble');

        await selectText('gamma');
        assert.strictEqual(await page.$eval('.mep-bubble', el => (el as HTMLElement).hidden), false);
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await delay(50);
        assert.strictEqual(await page.$eval('.mep-bubble', el => (el as HTMLElement).hidden), true, 'nor does an editor without the focus');
    });

    test('the admonition menu lists exactly the plugin\'s types, and one inserts its source with the box open', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        const listed = await page.$$eval('.mep-toolbar [data-menu="admonition"] .mep-menu-item', els => els.map(el => (el as HTMLElement).dataset.action));
        assert.deepStrictEqual(listed, ADMONITION_TYPES.map(t => `admonition-${t}`));

        await selectText('beta');
        await openMenu('admonition');
        await page.click(toolbarTool('admonition-warning'));
        await page.waitForSelector('.mep-raw-editor');
        const value = await page.$eval('.mep-raw-editor', el => (el as HTMLTextAreaElement).value);
        assert.strictEqual(value, '!!! warning Warning\n    Text');
        const render = (await (editor as EditorPage).posted()).filter(m => m.type === 'render').pop();
        assert.deepStrictEqual(render && { type: render.type, src: (render as { src: string }).src }, { type: 'render', src: '!!! warning Warning\n    Text\n' });
        await page.$eval('.mep-raw-editor', el => (el as HTMLTextAreaElement).blur());
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('Alpha beta gamma.\n\n!!! warning Warning\n    Text\n\nSecond paragraph here.'), edit?.text);
    });
});
