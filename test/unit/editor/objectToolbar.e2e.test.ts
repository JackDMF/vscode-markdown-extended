import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { EXTENSION_ID, EditMessage, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
/** The pointer's, shown. */
const HOVER_BAR = '.mep-object-toolbar[data-trigger="hover"]:not([hidden])';

/**
 * The object toolbar in the real page, with the real mouse and keyboard and
 * this extension's note stylesheet loaded: every object carries its verbs the
 * same way — a note, a link, a source block — and each verb posts the text it
 * says it makes.
 */
suite('Editor object toolbar (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    const showDocument = async (text: string, marker: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90 });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        // Out of any object the last test left the caret or the pointer in.
        await page.mouse.move(2, 2);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await delay(400);
    };

    /** The point just inside the left edge of character `index` of `needle`. */
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

    /** A real click right before character `index` of `needle`; returns when it was pressed. */
    const clickBefore = async (needle: string, index = 0): Promise<number> => {
        const p = await pointAt(needle, index);
        const at = Date.now();
        await page.mouse.click(p.x, p.y);
        return at;
    };

    const clickVerb = async (verb: string, bar = BAR) => {
        const button = await page.waitForSelector(`${bar} [data-verb="${verb}"]`, { visible: true, timeout: 2000 });
        const box = await button?.boundingBox();
        assert.ok(box, `no box for ${verb}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
    };

    const barState = (selector = BAR) => page.$eval(selector, bar => ({
        object: (bar as HTMLElement).dataset.object,
        label: bar.querySelector('.mep-object-label')?.textContent,
        verbs: Array.from(bar.querySelectorAll('button[data-verb]')).map(v => (v as HTMLElement).dataset.verb),
    }));

    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent, tone: (el as HTMLElement).dataset.tone, shown: !(el as HTMLElement).hidden }));

    const pressAlt = async (key: puppeteer.KeyInput) => {
        await page.keyboard.down('Alt');
        await page.keyboard.press(key);
        await page.keyboard.up('Alt');
        await delay(80);
    };

    const active = () => page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return { verb: el?.dataset.verb ?? null, editor: el?.classList.contains('ProseMirror') ?? false, field: el?.classList.contains('mep-inline-field') ?? false };
    });

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1000, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test(`the caret in a sidenote shows no toolbar before ${INLINE_DELAY_MS} ms, then one naming it, above its line, not over the caret's`, async function () {
        this.timeout(15000);
        await showDocument('Intro.\n\nAlpha ++beta ref|the body++ gamma.\n\nSecond paragraph.\n', 'Alpha');
        const pressed = await clickBefore('body', 1);
        await delay(150);
        assert.strictEqual(await page.$(BAR), null, 'nothing yet');
        await page.waitForSelector(BAR, { timeout: 2000 });
        assert.ok(Date.now() - pressed >= INLINE_DELAY_MS, 'not before the delay');
        assert.deepStrictEqual(await barState(), { object: 'note', label: 'Sidenote', verbs: ['remove-note', 'convert-note', 'edit-source'] });
        const geometry = await page.evaluate(sel => {
            const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const range = (document.getSelection() as Selection).getRangeAt(0);
            const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();
            const ref = (document.querySelector('.ProseMirror .sn-ref') as HTMLElement).getClientRects()[0];
            return { barTop: bar.top, barBottom: bar.bottom, caretTop: caret.top, caretBottom: caret.bottom, refTop: ref.top };
        }, BAR);
        assert.ok(geometry.barBottom <= geometry.refTop, `above the note's first line: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.barBottom <= geometry.caretTop || geometry.barTop >= geometry.caretBottom, `not over the caret's line: ${JSON.stringify(geometry)}`);

        // The caret leaving the note hides it at once.
        await clickBefore('Second', 2);
        await delay(100);
        assert.strictEqual(await page.$(BAR), null);
    });

    test('on the first line, under the sticky row, the bar goes below the note, still off the caret\'s line', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body++ gamma.\n\nSecond paragraph.\n', 'Alpha');
        await clickBefore('ref', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        const geometry = await page.evaluate(sel => {
            const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
            const range = (document.getSelection() as Selection).getRangeAt(0);
            const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();
            return { barTop: bar.top, barBottom: bar.bottom, rowBottom: row.bottom, caretTop: caret.top, caretBottom: caret.bottom };
        }, BAR);
        assert.ok(geometry.barTop >= geometry.rowBottom, `not under the row: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.barTop >= geometry.caretBottom, `below the caret's line: ${JSON.stringify(geometry)}`);
    });

    test('Remove note, keep text posts the sentence with the reference in it, and says so beside the caret', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body++ gamma.\n', 'Alpha');
        await clickBefore('body', 1);
        await clickVerb('remove-note');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha beta ref gamma.\n');
        assert.deepStrictEqual(await hint(), { text: 'Note removed — Ctrl+Z', tone: 'neutral', shown: true });
        assert.strictEqual(await page.$(BAR), null, 'no object at the caret any more');
        await page.keyboard.type('!');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha beta ref! gamma.\n', 'the focus is back in the text, at the end of the kept text');
    });

    test('Convert to marginal note posts !!…!!, and the bar then offers the way back', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body++ gamma.\n', 'Alpha');
        await clickBefore('body', 1);
        await clickVerb('convert-note');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha !!beta ref|the body!! gamma.\n');
        await page.waitForFunction(sel => document.querySelector(`${sel} .mep-object-label`)?.textContent === 'Marginal note', {}, BAR);
        assert.strictEqual(await page.$eval(`${BAR} [data-verb="convert-note"]`, el => el.textContent), 'Convert to sidenote');
    });

    test('Edit source opens the field with the note\'s ++…++; Enter posts the typed text asking for a re-parse; Esc changes nothing', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body++ gamma.\n', 'Alpha');
        await clickBefore('body', 1);
        await clickVerb('edit-source');
        const field = await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value);
        assert.strictEqual(field, '++beta ref|the body++');
        assert.strictEqual((await active()).field, true, 'the field has the focus');
        const before = (await (editor as EditorPage).edits()).length;
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual((await active()).editor, true, 'Esc returns to the text');
        assert.strictEqual(await page.$(`${BAR} .mep-inline-field`), null);
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'nothing was edited');

        await clickVerb('edit-source');
        await page.keyboard.type('++beta ref|a new body++');
        await page.keyboard.press('Enter');
        // No settle: the edit goes at once, for the host to parse.
        const edit = await lastEdit();
        assert.strictEqual(edit?.reparse, true);
        assert.strictEqual(edit?.text, 'Alpha ++beta ref|a new body++ gamma.\n');
    });

    test('the caret in a link: Open, Change URL and Remove link; the new URL and the kept text are what is posted', async function () {
        this.timeout(15000);
        await showDocument('See [the spec](spec.md) here.\n', 'See');
        await clickBefore('spec', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(), { object: 'link', label: 'Link', verbs: ['open-link', 'change-url', 'remove-link'] });

        await clickVerb('change-url');
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), 'spec.md');
        await page.keyboard.type('other.md#part');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the spec](other.md#part) here.\n');

        const opened = (await (editor as EditorPage).posted()).filter(m => m.type === 'openLink').length;
        await clickVerb('open-link');
        const links = (await (editor as EditorPage).posted()).filter((m): m is Extract<WebviewMessage, { type: 'openLink' }> => m.type === 'openLink');
        assert.deepStrictEqual(links.slice(opened), [{ type: 'openLink', href: 'other.md#part' }], 'the same path as Ctrl+click');

        await clickVerb('remove-link');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See the spec here.\n');
        assert.strictEqual((await hint()).text, 'Link removed — Ctrl+Z');
    });

    test('a source block shows its bar while the pointer is on it, keeps it while the pointer crosses to it, and Delete block removes it', async function () {
        this.timeout(15000);
        await showDocument('Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n', 'Before');
        const table = await (await page.$('.mep-raw-block table'))?.boundingBox();
        assert.ok(table);
        await page.mouse.move(table.x + table.width / 2, table.y + table.height / 2);
        await page.waitForSelector(HOVER_BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(HOVER_BAR), { object: 'raw_block', label: 'Source block', verbs: ['edit-source', 'show-in-text-editor', 'delete-block'] });
        assert.strictEqual(await page.$(BAR), null, 'nothing is selected');

        const button = await (await page.$(`${HOVER_BAR} [data-verb="delete-block"]`))?.boundingBox();
        assert.ok(button);
        // Through the gap between the block and the bar, as a hand moves.
        await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2, { steps: 8 });
        assert.ok(await page.$(HOVER_BAR), 'the bar stays while the pointer crosses to it');
        await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Before.\n\nAfter.\n');
        assert.strictEqual((await hint()).text, 'Block deleted — Ctrl+Z');
        await page.mouse.move(2, 2);
        await delay(500);
        assert.strictEqual(await page.$(HOVER_BAR), null, 'the pointer gone, the bar goes');
    });

    test('Alt+Enter opens the bar at once with the focus on its first verb; the arrows move, Enter chooses, Esc returns to the text', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body++ gamma.\n', 'Alpha');
        await clickBefore('ref', 1);
        await delay(100);
        await pressAlt('Enter');
        assert.ok(await page.$(BAR), 'shown without the delay');
        assert.deepStrictEqual(await active(), { verb: 'remove-note', editor: false, field: false });
        await page.keyboard.press('ArrowRight');
        assert.strictEqual((await active()).verb, 'convert-note');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        assert.strictEqual((await active()).verb, 'edit-source', 'the arrows wrap');
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual((await active()).editor, true, 'Esc returns to the text');
        await page.keyboard.type('X');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha ++beta rXef|the body++ gamma.\n', 'the caret is where it was');

        await pressAlt('Enter');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Alpha !!beta rXef|the body!! gamma.\n', 'Enter chose Convert to marginal note');
    });
});
