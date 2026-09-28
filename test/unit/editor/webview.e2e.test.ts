import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { HostMessage, WebviewMessage } from '../../../src/editor/protocol';
import { EXTENSION_ID, EditorPage, openEditorPage, settle } from './pageHarness';

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

/** The object toolbar of the selected object, shown. */
const SELECTED_BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/**
 * The Visual Editor's page (`dist/editor-webview.js`) driven in headless
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
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;

    const posted = (): Promise<WebviewMessage[]> => (editor as EditorPage).posted();
    const edits = () => (editor as EditorPage).edits();
    const send = (message: HostMessage) => (editor as EditorPage).send(message);
    const pressSave = async () => {
        await page.keyboard.down('Control');
        await page.keyboard.press('s');
        await page.keyboard.up('Control');
    };
    /**
     * Listen for Ctrl+S where a webview forwards keys to VS Code: on its window,
     * in the bubble phase, registered after the page's own listeners.
     */
    const watchForwardedSave = () => page.evaluate(() => {
        const w = window as unknown as { forwardedSave?: boolean };
        w.forwardedSave = false;
        window.addEventListener('keydown', e => {
            if (e.key === 's' && e.ctrlKey) {
                w.forwardedSave = true;
            }
        });
    });
    const saveWasForwarded = () => page.evaluate(() => (window as unknown as { forwardedSave?: boolean }).forwardedSave);
    /**
     * `SOURCE` parsed, with the heading given the shape the parser leaves it
     * in when Req Explorer's badge names the artifact: the parser lifts the id
     * into `reqPrefix` only then, and Req Explorer is not in the test host.
     */
    const requirementDocument = async (): Promise<ReturnType<typeof parsedDocumentToJSON>> => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, SOURCE, {}));
        const heading = (json.doc.content as { type: string; attrs: Record<string, unknown>; content: { text: string }[] }[])
            .find(n => n.type === 'heading');
        assert.ok(heading);
        heading.attrs.reqPrefix = 'FRS-TST-001: ';
        heading.content = [{ ...heading.content[0], text: 'Page' }];
        return json;
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;

        const json = await requirementDocument();
        assert.deepStrictEqual((await posted()).map(m => m.type), ['ready']);
        await send({ type: 'document', json, version: 1, defaultWrap: 90 });
        await page.waitForSelector('.ProseMirror');
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('the document renders: front matter folded, the id read-only, the table as a raw block', async () => {
        const shape = await page.evaluate(() => ({
            frontMatter: document.querySelector('details.mep-front-matter pre')?.textContent,
            prefix: document.querySelector('h2 .mep-req-prefix')?.textContent,
            prefixEditable: document.querySelector('h2 .mep-req-prefix')?.getAttribute('contenteditable'),
            title: document.querySelector('h2 .mep-heading-text')?.textContent,
            // In the document, not the toolbar's heading sample.
            anchor: document.querySelector('.ProseMirror h2')?.id,
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
        await page.click(`${SELECTED_BAR} [data-verb="show-in-text-editor"]`);
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
        await page.click(`${SELECTED_BAR} [data-verb="edit-source"]`);
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

    test('Ctrl+S is kept from VS Code and sent as an edit that asks the host to save', async function () {
        this.timeout(10000);
        const before = (await edits()).length;
        await page.click('.ProseMirror p');
        await page.keyboard.press('End');
        await page.keyboard.type('?');
        await watchForwardedSave();
        await pressSave();
        // No settle: the edit goes at once, not after the typing delay.
        const all = await edits();
        assert.strictEqual(all.length, before + 1);
        assert.strictEqual(all[all.length - 1].save, true);
        assert.ok(all[all.length - 1].text.includes('Rewritten by another writer.?'), all[all.length - 1].text);
        assert.strictEqual(await saveWasForwarded(), false,
            'the keydown never reached the listener a webview forwards keys to VS Code from');

        await pressSave();
        const again = await edits();
        assert.strictEqual(again.length, before + 2, 'a save with nothing new to send still asks for the save');
        assert.strictEqual(again[again.length - 1].save, true);
        assert.strictEqual(again[again.length - 1].text, all[all.length - 1].text);
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
        // Each expansion selected in turn: its bar names it and lists its verbs.
        const barOf = async (index: number) => {
            const blocks = await page.$$('.mep-injected-block .mep-atom-content');
            await blocks[index].click();
            await page.waitForSelector(`${SELECTED_BAR}[data-object="injected_block"]`);
            return page.$eval(SELECTED_BAR, bar => ({
                label: bar.querySelector('.mep-object-label')?.textContent,
                verbs: Array.from(bar.querySelectorAll('[data-verb]')).map(v => (v as HTMLElement).dataset.verb),
            }));
        };
        assert.deepStrictEqual(await barOf(1), { label: 'Snippet gone (not found)', verbs: ['show-in-text-editor', 'delete-directive'] });
        assert.deepStrictEqual(await barOf(0), { label: 'Included snippet legal-notice', verbs: ['open-snippet', 'show-in-text-editor', 'delete-directive'] });
        await page.click(`${SELECTED_BAR} [data-verb="open-snippet"]`);
        const open = (await posted()).find((m): m is Extract<WebviewMessage, { type: 'openSnippet' }> => m.type === 'openSnippet');
        assert.strictEqual(open?.path, 'C:\\corpus\\snippets\\legal-notice.md');
    });

    test('the error state replaces the editor and offers the text editor', async function () {
        this.timeout(10000);
        await send({ type: 'error', message: 'the source blocks do not account for every line' });
        await page.waitForSelector('.mep-error');
        assert.strictEqual(await page.$('.ProseMirror'), null);
        await page.click('.mep-error .mep-error-button');
        const open = (await posted()).filter(m => m.type === 'openSource').pop();
        assert.deepStrictEqual(open, { type: 'openSource', line: 0 });

        // With no editor there is nothing to send: Ctrl+S stays VS Code's.
        const before = (await edits()).length;
        await watchForwardedSave();
        await pressSave();
        assert.strictEqual((await edits()).length, before);
        assert.strictEqual(await saveWasForwarded(), true, 'the error state leaves Ctrl+S to VS Code');
    });

    test('Enter inside a requirement heading starts a paragraph, so the id is written once', async function () {
        this.timeout(10000);
        await send({ type: 'document', json: await requirementDocument(), version: 11, defaultWrap: 90 });
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

    test('Ctrl+S inside a raw block\'s open source saves that source, and closing it afterwards writes nothing more', async function () {
        this.timeout(15000);
        await send({ type: 'document', json: await requirementDocument(), version: 12, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelectorAll('.mep-raw-block table td').length === 2);
        await page.click('.mep-raw-block .mep-atom-content');
        await page.click(`${SELECTED_BAR} [data-verb="edit-source"]`);
        await page.waitForSelector('.mep-raw-editor');
        await page.$eval('.mep-raw-editor', el => {
            const area = el as HTMLTextAreaElement;
            area.setSelectionRange(area.value.length, area.value.length);
        });
        await page.keyboard.type('\n| 3 | 4 |');
        const before = (await edits()).length;
        await watchForwardedSave();
        await pressSave();

        const all = await edits();
        assert.strictEqual(all.length, before + 1, 'one edit, sent at once');
        const saved = all[all.length - 1];
        assert.strictEqual(saved.save, true);
        assert.strictEqual(saved.baseVersion, 12);
        assert.strictEqual(saved.text, SOURCE.replace(TABLE, `${TABLE}| 3 | 4 |\n`), 'the save carries the source still in the textarea');
        assert.strictEqual(await saveWasForwarded(), false, 'the key was kept from VS Code');
        const open = await page.evaluate(() => ({
            focused: document.activeElement?.classList.contains('mep-raw-editor'),
            value: (document.querySelector('.mep-raw-editor') as HTMLTextAreaElement | null)?.value,
        }));
        assert.deepStrictEqual(open, { focused: true, value: '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |' }, 'the textarea stays open');

        // Leaving it commits what the save already wrote: no second edit, so
        // the document does not turn dirty again.
        await page.$eval('.mep-raw-editor', el => (el as HTMLTextAreaElement).blur());
        await settle();
        assert.strictEqual((await edits()).length, before + 1);
        assert.strictEqual(await page.$('.mep-raw-editor'), null);
    });

    test('Ctrl+S with the focus outside the editor still saves the last keystrokes', async function () {
        this.timeout(10000);
        await page.click('.ProseMirror p');
        await page.keyboard.press('End');
        await page.keyboard.type(' Moved.');
        const before = (await edits()).length;
        // What a click on the page background does: the editor loses the
        // focus to the body, and the window keeps it.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        assert.strictEqual(await page.evaluate(() => document.activeElement === document.body), true);
        // No settle: leaving the editor sends the pending edit at once.
        const left = await edits();
        assert.strictEqual(left.length, before + 1, 'focus leaving the editor sends the pending edit');
        assert.strictEqual(left[left.length - 1].save, undefined);
        assert.ok(left[left.length - 1].text.replace(/\s+/g, ' ').includes('as it was written. Moved.'), left[left.length - 1].text);

        await watchForwardedSave();
        await pressSave();
        const all = await edits();
        assert.strictEqual(all.length, before + 2);
        assert.strictEqual(all[all.length - 1].save, true, 'Ctrl+S on the body is the page\'s save too');
        assert.strictEqual(all[all.length - 1].text, left[left.length - 1].text);
        assert.strictEqual(await saveWasForwarded(), false, 'and is kept from VS Code');
    });
});

/**
 * `revealAnchor`: a followed link's fragment brought into view in the page,
 * the caret put there — by a heading's `anchor`, else by the line the host
 * resolved the fragment to.
 */
suite('Editor revealing a link\'s fragment (e2e)', () => {
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;

    const filler = Array.from({ length: 40 }, (_, k) => `Paragraph ${k} of filler.\n`).join('\n');
    const SOURCE_TEXT = `# Top\n\n${filler}\n## Far away {#far-away}\n\n${filler}\n## Slugged heading\n\n${filler}`;

    /** Where the heading with `text` stands in the window, and whether the caret is in it. */
    const headingState = (text: string) => page.evaluate(t => {
        const heading = Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror h2')).find(h => h.textContent?.includes(t));
        const anchor = window.getSelection()?.anchorNode ?? null;
        return {
            top: heading ? Math.round(heading.getBoundingClientRect().top) : null,
            caretIn: heading !== undefined && anchor !== null && heading.contains(anchor),
            focused: document.activeElement?.classList.contains('ProseMirror') ?? false,
        };
    }, text);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage();
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        await editor.send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, SOURCE_TEXT, {})), version: 1, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Slugged heading'));
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('a heading\'s anchor is scrolled to the top, below the formatting row, with the caret in it', async () => {
        assert.ok(((await headingState('Far away')).top ?? 0) > 900, 'out of view at first');
        await (editor as EditorPage).send({ type: 'revealAnchor', anchor: 'far-away', line: null });
        await delay(150);
        const state = await headingState('Far away');
        assert.ok(state.top !== null && state.top >= 40 && state.top < 120, `the heading at the top, clear of the sticky row: ${state.top}`);
        assert.strictEqual(state.caretIn, true, 'the caret in the heading');
        assert.strictEqual(state.focused, true);
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'revealing writes nothing');
    });

    test('a fragment no heading carries as its anchor lands on the block the host\'s line starts', async () => {
        const line = SOURCE_TEXT.split('\n').indexOf('## Slugged heading');
        await (editor as EditorPage).send({ type: 'revealAnchor', anchor: 'slugged-heading', line });
        await delay(150);
        const state = await headingState('Slugged heading');
        assert.ok(state.top !== null && state.top >= 40 && state.top < 120, `at the top: ${state.top}`);
        assert.strictEqual(state.caretIn, true);
    });
});
