import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { EditorPage, UNDO, closeEditorPage, delay, describedTip, leaveObjects, openEditorPage, settle } from './pageHarness';
import { BAR, BreadcrumbPage, CRUMBS, breadcrumbPage, rectOf } from './breadcrumbPage';
import { TEMPO } from './noteSample';
import { hostEngine } from './helpers';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';

/** Daniel's line in a list, a sidebar with a literal in a heading, an item carrying one, and the last paragraph. */
export const NOTES_DOC = [
    '3. Der Ablauf',
    `   - Punkt ${TEMPO}`,
    '   - Schneller',
    '',
    '## Kopf @10:00@{.r} {.h}',
    '',
    `- Eintrag !!Hinweis|eine kurze Notiz!!{.tipp} {.i}`,
    '',
    'Text with $Zeit${.l} and a bare !!Ref|plain note!! here.',
    '',
    'The last paragraph.',
    '',
].join('\n');

/**
 * The breadcrumb suites' page, its documents read by the host's engine without
 * other extensions' plugins: VS Code's math, on by default in the test
 * window, claims `$…$`, and a left sidebar is no sidebar there (X6).
 */
export function notePage(editor: () => EditorPage): BreadcrumbPage {
    let version = 0;
    return {
        ...breadcrumbPage(editor),
        show: async (text: string, marker = 'last paragraph') => {
            const p = editor().page;
            await p.mouse.move(2, 2);
            await p.evaluate(() => {
                for (const menu of Array.from(document.querySelectorAll('.mep-menu:not([hidden])'))) {
                    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                }
                (document.activeElement as HTMLElement | null)?.blur();
                const hint = document.querySelector('.mep-hint') as HTMLElement | null;
                if (hint) {
                    hint.hidden = true;
                }
                window.scrollTo(0, 0);
            });
            version++;
            await editor().send({ type: 'document', json: parsedDocumentToJSON(parseDocument(hostEngine(), text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
            await p.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
            await delay(600);
        },
    };
}

/** The bar's title, its code literal and its verbs as drawn. */
async function barOf(page: puppeteer.Page) {
    return page.$eval(BAR, bar => ({
        title: bar.querySelector(':scope > .mep-object-label')?.textContent ?? null,
        verbs: Array.from(bar.querySelectorAll(':scope > button[data-verb]')).filter(b => !(b as HTMLElement).hidden).map(b => b.textContent),
        ids: Array.from(bar.querySelectorAll(':scope > button[data-verb]')).filter(b => !(b as HTMLElement).hidden).map(b => (b as HTMLElement).dataset.verb),
    }));
}

/** The rectangle of the first element `selector` names inside the document whose text holds `needle`. */
function elementRect(page: puppeteer.Page, selector: string, needle: string) {
    return page.evaluate((s, n) => {
        const el = Array.from(document.querySelectorAll(`.ProseMirror ${s}`)).find(e => (e.textContent ?? '').includes(n)) as HTMLElement | undefined;
        if (!el) {
            throw new Error(`no ${s} holding "${n}"`);
        }
        const rects = Array.from(el.getClientRects());
        const last = rects[rects.length - 1];
        return { top: rects[0].top, bottom: last.bottom, left: rects[0].left, right: last.right };
    }, selector, needle);
}

/**
 * Notes and sidebars as attribute holders (#15 step 3): Daniel's line opens
 * as rich text with `span.mn-ref.tipp`; the bar reads `Marginal note {.tipp}`
 * · Convert · Attributes… · Edit source · Remove attributes, keep note ·
 * Delete note; Alt+Enter on Attributes…; the field at the reference.
 */
suite('Editor note attributes: the note bar (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = notePage(() => editor as EditorPage);
    const FIELD_BAR = '.mep-object-toolbar:has(.mep-inline-field)';

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    teardown(async () => {
        await page.keyboard.press('Escape');
        await page.setViewport({ width: 1280, height: 900 });
        // Out of the note the Escape dismissed its bar in: the next document holds one at the same place.
        await leaveObjects(page);
        await page.mouse.click(1270, 890);
    });

    test('fail-first: Daniel\'s line opens as rich text — no source chip, span.mn-ref.tipp — and its bar reads Marginal note {.tipp}', async function () {
        // Before #15 the whole list was a source block: "attributes on marginal_note_open".
        this.timeout(20000);
        await b.show(NOTES_DOC);
        assert.strictEqual(await page.$('.ProseMirror .mep-raw-block'), null, 'no source block');
        assert.ok(await page.$('.ProseMirror span.mn-ref.tipp'), 'the note drawn with its class');
        assert.strictEqual(await page.$eval('.ProseMirror span.mn-ref.tipp', el => el.getAttribute('class')), 'mn-ref tipp');
        await b.restAt('abrupt', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        const bar = await barOf(page);
        assert.strictEqual(bar.title, 'Marginal note {.tipp}');
        assert.strictEqual(await page.$eval(`${BAR} > .mep-object-label .mep-object-label-code`, el => el.textContent), '{.tipp}');
        assert.deepStrictEqual(bar.verbs, ['Convert to sidenote', 'Attributes…', 'Edit source', 'Remove attributes, keep note', 'Delete note']);
        await b.pressAlt('Enter');
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.verb), 'note-attributes');
        assert.strictEqual(await describedTip(page, `${BAR} [data-verb="convert-note"]`), 'Make it a sidenote; its text and attributes stay.');
    });

    for (const width of [1280, 900]) {
        test(`Attributes… opens "Marginal note · Attributes" at the reference, never at the body (${width} px)`, async function () {
            this.timeout(20000);
            await page.setViewport({ width, height: 900 });
            await b.show(NOTES_DOC);
            await b.restAt('abrupt', 2);
            await page.waitForSelector(`${BAR} [data-verb="note-attributes"]`, { visible: true, timeout: 2000 });
            await page.click(`${BAR} [data-verb="note-attributes"]`);
            await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
            await delay(200);
            assert.strictEqual(await page.$eval(`${FIELD_BAR} .mep-object-label`, el => el.textContent), 'Marginal note · Attributes');
            assert.strictEqual(await page.$eval(`${FIELD_BAR} input`, el => (el as HTMLInputElement).value), '.tipp');
            const field = await rectOf(page, FIELD_BAR);
            const ref = await elementRect(page, '.mn-anchor', 'Tempo');
            const body = await elementRect(page, '.mnote', 'abrupt');
            // At the reference's line: under its last line box, or above its first with text on both sides.
            const atRef = (field.top >= ref.bottom - 1 && field.top <= ref.bottom + 40) || (field.bottom <= ref.top + 1 && field.bottom >= ref.top - 40);
            assert.ok(atRef, `at the reference: ${JSON.stringify({ field, ref, body })}`);
            if (width === 1280) {
                assert.ok(body.left > ref.right, `the body is in the margin: ${JSON.stringify({ ref, body })}`);
                assert.ok(field.left < body.left, `not at the margin body: ${JSON.stringify({ field, body })}`);
            }
        });
    }

    test('typing " .x" and Enter writes !!{.tipp .x}; undo restores the bytes', async function () {
        this.timeout(20000);
        await b.show(NOTES_DOC);
        await b.restAt('abrupt', 2);
        await page.click(`${BAR} [data-verb="note-attributes"]`);
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        await page.keyboard.press('End');
        await page.keyboard.type(' .x');
        await page.keyboard.press('Enter');
        await settle();
        const text = (await b.lastEdit())?.text ?? '';
        assert.ok(text.includes('nicht zu schnell!!{.tipp .x}'), text);
        assert.ok(await page.$('.ProseMirror span.mn-ref.tipp.x'));
        // The editor's own undo (MOD+Z through its keymap), not the browser's.
        await b.undo();
        await settle();
        assert.ok(((await b.lastEdit())?.text ?? '').includes(`   - Punkt ${TEMPO}\n`), (await b.lastEdit())?.text);
    });

    test('Remove attributes, keep note: the hint names it, the note stays bare with no Remove; undo restores', async function () {
        this.timeout(20000);
        await b.show(NOTES_DOC);
        await b.restAt('abrupt', 2);
        await page.click(`${BAR} [data-verb="remove-attributes"]`);
        await settle();
        const text = (await b.lastEdit())?.text ?? '';
        assert.ok(text.includes('nicht zu schnell!!\n'), text);
        assert.strictEqual(await b.hint(), `Marginal note attributes removed — ${UNDO}`);
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        const bar = await barOf(page);
        assert.strictEqual(bar.title, 'Marginal note');
        assert.ok(!bar.ids.includes('remove-attributes'), JSON.stringify(bar));
        await b.undo();
        await settle();
        assert.ok(((await b.lastEdit())?.text ?? '').includes(`   - Punkt ${TEMPO}\n`), (await b.lastEdit())?.text);
    });

    test('a sidebar in a heading: Heading {.h} › Right sidebar {.r}; a bare one: Remove attributes, keep sidebar', async function () {
        this.timeout(20000);
        await b.show(NOTES_DOC);
        await b.restAt('10:00', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const parts = await page.$$eval(`${CRUMBS} .mep-crumb`, els => els.map(p => [p.querySelector('.mep-crumb-name')?.textContent, p.querySelector('.mep-crumb-code')?.textContent ?? null]));
        assert.deepStrictEqual(parts, [['Heading', '{.h}'], ['Right sidebar', '{.r}']]);
        await page.keyboard.press('Escape');
        await b.restAt('Zeit', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        const bar = await barOf(page);
        assert.strictEqual(bar.title, 'Left sidebar {.l}');
        assert.deepStrictEqual(bar.verbs, ['Move to right', 'Attributes…', 'Edit source', 'Remove attributes, keep sidebar', 'Remove sidebar, keep text']);
    });

    test('crumbs: List item {.i} › Marginal note {.tipp}; Remove ▾ says "marginal note stays"', async function () {
        this.timeout(20000);
        await b.show(NOTES_DOC);
        await b.restAt('kurze Notiz', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const parts = await page.$$eval(`${CRUMBS} .mep-crumb`, els => els.map(p => [p.querySelector('.mep-crumb-name')?.textContent, p.querySelector('.mep-crumb-code')?.textContent ?? null]));
        assert.deepStrictEqual(parts, [['List item', '{.i}'], ['Marginal note', '{.tipp}']]);
        await page.click(`${BAR} [data-verb="remove-attributes"]`);
        await page.waitForSelector(`${BAR} .mep-object-menu`, { visible: true, timeout: 2000 });
        const entries = await page.$$eval(`${BAR} .mep-object-menu .mep-menu-item`, els => els.map(el => [
            el.querySelector('.mep-entry-label')?.textContent ?? '',
            el.querySelector('.mep-entry-code')?.textContent ?? null,
            el.querySelector('.mep-entry-syntax')?.textContent ?? null,
        ]));
        assert.deepStrictEqual(entries, [['Marginal note', '{.tipp}', 'marginal note stays'], ['List item', '{.i}', 'item stays']]);
        await page.click(`${BAR} .mep-object-menu [data-entry="remove-current"]`);
        await settle();
        const text = (await b.lastEdit())?.text ?? '';
        assert.ok(text.includes('- Eintrag !!Hinweis|eine kurze Notiz!! {.i}'), text);
        assert.strictEqual(await b.hint(), `Marginal note attributes removed — ${UNDO}`);
    });
});

/**
 * Formatting, the bubble and the refusals for notes (#15 steps 4–5): the
 * menu names the note at a caret in it; plain text rests on "Inline
 * attributes…", disabled with its reason; the bubble's {…} over words of a
 * note's body targets the note (F2); R2 in the field, R4 at the control.
 */
suite('Editor note attributes: menu, bubble and refusals (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = notePage(() => editor as EditorPage);
    const ENTRY = '.mep-menu[data-menu="formatting"] [data-action="inline-attributes"]';
    const BUBBLE_TOOL = '.mep-bubble:not([hidden]) [data-action="attrs-bubble"]';
    const FIELD_BAR = '.mep-object-toolbar:has(.mep-inline-field)';

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    teardown(async () => {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await leaveObjects(page);
        await page.mouse.click(1270, 890);
    });

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
        await delay(300);
    };

    /** The caret at character `k` of `needle` — a sidebar floated into the margin, where a click is a person's aim, not the test's — and the rest that brings its bar. */
    const caretIn = async (needle: string, k: number) => {
        await page.focus('.ProseMirror');
        await page.evaluate((n, i) => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf(n);
                if (at >= 0) {
                    (document.getSelection() as Selection).collapse(node, at + i);
                    return;
                }
            }
            throw new Error(`no "${n}" in the document`);
        }, needle, k);
        await delay(INLINE_DELAY_MS + 250);
    };

    test('Formatting at a caret in a note: "Attributes of Marginal note…", written !!text|note!!{.class}; its field writes the note\'s literal', async function () {
        this.timeout(20000);
        await b.show(NOTES_DOC);
        await b.clickAt('abrupt', 2);
        await b.openMenu('formatting');
        const entry = await page.$eval(ENTRY, el => ({
            label: el.querySelector('.mep-entry-label')?.textContent,
            syntax: el.querySelector('.mep-entry-syntax')?.textContent,
            disabled: el.getAttribute('aria-disabled'),
        }));
        assert.deepStrictEqual(entry, { label: 'Attributes of Marginal note…', syntax: '!!text|note!!{.class}', disabled: 'false' });
        await page.click(ENTRY);
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        assert.strictEqual(await page.$eval(`${FIELD_BAR} .mep-object-label`, el => el.textContent), 'Marginal note · Attributes');
        assert.strictEqual(await page.$eval(`${FIELD_BAR} input`, el => (el as HTMLInputElement).value), '.tipp');
    });

    test('in plain text the entry rests as "Inline attributes…", disabled, and says why on press (R5)', async function () {
        this.timeout(20000);
        await b.show(NOTES_DOC);
        await b.clickAt('last paragraph', 3);
        await b.openMenu('formatting');
        const entry = await page.$eval(ENTRY, el => ({
            label: el.querySelector('.mep-entry-label')?.textContent,
            disabled: el.getAttribute('aria-disabled'),
            reason: el.getAttribute('aria-description') ?? '',
        }));
        assert.strictEqual(entry.label, 'Inline attributes…');
        assert.strictEqual(entry.disabled, 'true');
        const lock = 'Plain text takes no attributes — put the caret in formatted text, a link, a span or a note, or select an image.';
        assert.ok(entry.reason.includes(lock), entry.reason);
        await page.click(ENTRY);
        await delay(150);
        const said = await page.evaluate(() => Array.from(document.querySelectorAll('.mep-hint, .mep-menu-hint, [data-at="menu-row"]')).map(el => el.textContent ?? '').join(' | '));
        assert.ok(said.includes(lock), said);
    });

    test('the bubble\'s {…} over words of a note\'s body names the marginal note (F2), and its field sets the note\'s literal', async function () {
        this.timeout(20000);
        await b.show(NOTES_DOC);
        await selectText('abrupt');
        await page.waitForSelector(BUBBLE_TOOL, { timeout: 3000 });
        const tip = await describedTip(page, BUBBLE_TOOL);
        assert.strictEqual(tip, 'Attributes of Marginal note… — !!text|note!!{.class}\nOver plain text: Span with class… — [text]{.class}');
        await delay(400);
        await page.click(BUBBLE_TOOL);
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        assert.strictEqual(await page.$eval(`${FIELD_BAR} .mep-object-label`, el => el.textContent), 'Marginal note · Attributes');
        await page.keyboard.press('End');
        await page.keyboard.type(' .y');
        await page.keyboard.press('Enter');
        await settle();
        const text = (await b.lastEdit())?.text ?? '';
        assert.ok(text.includes('schnell!!{.tipp .y}') && !text.includes('[abrupt]'), text);
    });

    test('fail-first: on italic words of a note without a {…} of their own the bar, Formatting and the bubble all name the note; with one, Italic wins', async function () {
        // Daniel (review 1): a mark without its own literal inside a note does not count. Before the fix
        // Formatting read "Attributes of Italic…" and the bubble "Attributes of Italic…" here.
        this.timeout(40000);
        // With its own literal the italic run is the holder, named by its delimiter's name.
        for (const [src, bar, name] of [
            ['Tempo !!Tempo|nicht zu *abrupt* ändern!!{.tipp} hier.\n\nThe last paragraph.\n', 'Marginal note {.tipp}', 'Marginal note'],
            ['Tempo !!Tempo|nicht zu *abrupt*{.k} ändern!!{.tipp} hier.\n\nThe last paragraph.\n', 'Italic {.k}', 'Italic'],
        ]) {
            await b.show(src);
            await selectText('abrupt');
            await page.waitForSelector(BUBBLE_TOOL, { timeout: 3000 });
            const tip = await describedTip(page, BUBBLE_TOOL);
            assert.ok(tip.startsWith(`Attributes of ${name}…`), `${src}: ${tip}`);
            await page.keyboard.press('Escape');
            await caretIn('abrupt', 2);
            await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
            assert.strictEqual((await barOf(page)).title, bar, src);
            await b.openMenu('formatting');
            assert.strictEqual(await page.$eval(ENTRY, el => el.querySelector('.mep-entry-label')?.textContent), `Attributes of ${name}…`, src);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await leaveObjects(page);
        }
    });

    test('the editor\'s own copy of a note and a sidebar pasted back keeps their literals (data-mep-attrs)', async function () {
        this.timeout(20000);
        await b.show('Alpha !!r|n!!{.tipp} and $s${#i .l} beta.\n\nGamma.\n\nThe last paragraph.\n');
        await page.focus('.ProseMirror');
        await page.evaluate(() => {
            const p = document.querySelector('.ProseMirror p') as HTMLElement;
            const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            const texts: globalThis.Node[] = [];
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                texts.push(node);
            }
            const last = texts[texts.length - 1];
            (document.getSelection() as Selection).setBaseAndExtent(texts[0], 0, last, (last.textContent ?? '').length);
        });
        await delay(200);
        const html = await page.evaluate(() => {
            const data = new DataTransfer();
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
            return data.getData('text/html');
        });
        assert.ok(html.includes('data-mep-attrs="{.tipp}"') && html.includes('data-mep-attrs="{#i .l}"'), html);
        await page.evaluate(() => {
            const gamma = Array.from(document.querySelectorAll('.ProseMirror p')).find(p => p.textContent === 'Gamma.') as HTMLElement;
            (document.getSelection() as Selection).collapse(gamma.firstChild as globalThis.Node, 'Gamma.'.length);
        });
        await delay(200);
        await page.evaluate(h => {
            const data = new DataTransfer();
            data.setData('text/html', h);
            data.setData('text/plain', 'Alpha');
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, html);
        await settle();
        const text = (await b.lastEdit())?.text ?? '';
        assert.ok(text.includes('Gamma.Alpha !!r|n!!{.tipp} and $s${#i .l} beta.\n'), text);
    });

    test('R2 in the field: a literal whose "@" would pair with a later sidebar is refused there, aria-invalid, nothing written', async function () {
        this.timeout(20000);
        await b.show('Times @Owner Mia@ and @b@ here.\n\nThe last paragraph.\n');
        await caretIn('Owner', 2);
        await page.waitForSelector(`${BAR} [data-verb="note-attributes"]`, { visible: true, timeout: 2000 });
        await page.click(`${BAR} [data-verb="note-attributes"]`);
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        const before = (await (editor as EditorPage).edits()).length;
        await page.keyboard.type('data-x="@"');
        await page.keyboard.press('Enter');
        await delay(150);
        const field = await page.evaluate(sel => {
            const el = document.querySelector(`${sel} .mep-inline-field`) as HTMLInputElement | null;
            return { invalid: el?.getAttribute('aria-invalid') ?? null, reason: document.querySelector(`${sel} .mep-field-refusal-text`)?.textContent ?? null };
        }, FIELD_BAR);
        assert.deepStrictEqual(field, { invalid: 'true', reason: 'Not set: "@" in these attributes would end the right sidebar early or start another one. Remove it.' });
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'nothing written');
    });

    test('R4 at the control: removing the literal that keeps a left sidebar apart from a digit says why at Remove', async function () {
        this.timeout(20000);
        await b.show('Price $Status${.l}5 here.\n\nThe last paragraph.\n');
        await caretIn('Status', 2);
        const verb = `${BAR} [data-verb="remove-attributes"]`;
        await page.waitForSelector(verb, { visible: true, timeout: 2000 });
        assert.strictEqual(await page.$eval(verb, el => el.getAttribute('aria-disabled')), 'true');
        const before = (await (editor as EditorPage).edits()).length;
        await page.click(verb);
        await delay(100);
        const hint = await page.$eval('.mep-hint', el => ({ text: el.textContent, at: (el as HTMLElement).dataset.at, hidden: (el as HTMLElement).hidden }));
        assert.deepStrictEqual(hint, { text: 'Not removed: without its attributes, the left sidebar would run into the "5" after it and stop being a sidebar. Type a space after the sidebar first.', at: 'control', hidden: false });
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'nothing posted');
    });
});

/**
 * What a note's literal costs a key (#15 step 6): typing 50 characters in a
 * note of 1000 paragraphs that each end in `!!a|b!!{.tipp}` costs, key for key
 * from keydown to the next painted frame, no more than 1.15× the same
 * paragraphs whose notes carry none. The holder lookup is one O(depth)
 * `noteContextAt` per state, cached; the literal draws no decoration.
 */
suite('Editor note attributes: the cost of a key (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = notePage(() => editor as EditorPage);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    /** The mean time from each of 50 keydowns in `needle`'s note to the frame painted after it, in ms. */
    const perKey = async (text: string, needle: string): Promise<number> => {
        await b.show(text);
        await b.clickAt(needle, 3);
        await page.evaluate(() => {
            const w = window as unknown as { keyTimes: number[] };
            w.keyTimes = [];
            document.addEventListener('keydown', () => {
                const start = performance.now();
                requestAnimationFrame(() => setTimeout(() => w.keyTimes.push(performance.now() - start), 0));
            }, { capture: true });
        });
        for (const ch of 'the quick brown fox jumps over the lazy dog again!') {
            await page.keyboard.type(ch);
            await delay(40);
        }
        await delay(300);
        const times = await page.evaluate(() => (window as unknown as { keyTimes: number[] }).keyTimes);
        assert.ok(times.length >= 50, `${times.length} keys measured`);
        return times.reduce((a, t) => a + t, 0) / times.length;
    };

    test('typing in a note of 1000 paragraphs whose notes carry {.tipp} costs no more than 1.15× the same without', async function () {
        this.timeout(300000);
        const doc = (literal: string) => `${Array.from({ length: 1000 }, (_, k) => (k === 0
            ? `Paragraph 1 !!ref|first note body!!${literal}`
            : `Paragraph ${k + 1} of the document !!a|b!!${literal}`)).join('\n\n')}\n\nThe last paragraph.\n`;
        // Twice each, interleaved: the better run of each, so a busy moment of the machine is not the editor's.
        const runs = { literal: [] as number[], bare: [] as number[] };
        for (let k = 0; k < 2; k++) {
            runs.bare.push(await perKey(doc(''), 'first note body'));
            runs.literal.push(await perKey(doc('{.tipp}'), 'first note body'));
        }
        const best = (xs: number[]) => Math.min(...xs);
        const ratio = best(runs.literal) / best(runs.bare);
        console.log(`#15 cost per key (ms, best of 2): notes with {.tipp} ${best(runs.literal).toFixed(2)}, without ${best(runs.bare).toFixed(2)}; ratio ${ratio.toFixed(3)}`);
        assert.ok(ratio <= 1.15, `per key ${best(runs.literal).toFixed(2)} ms vs ${best(runs.bare).toFixed(2)} ms: ${ratio.toFixed(3)}×`);
    });
});
