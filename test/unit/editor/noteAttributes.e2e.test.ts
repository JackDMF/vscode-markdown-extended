import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { EditorPage, UNDO, closeEditorPage, delay, describedTip, leaveObjects, openEditorPage, settle } from './pageHarness';
import { BAR, BreadcrumbPage, CRUMBS, breadcrumbPage, rectOf } from './breadcrumbPage';
import { TEMPO } from './noteSample';
import { hostEngine, repoRoot } from './helpers';
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

/** The bubble while it shows. */
const BUBBLE = '.mep-bubble:not([hidden])';

/** `length` characters of the first text holding `needle` selected from its character `k` (the caret there for 0) — no click: a body floated into the margin is reached as the test means it. */
async function selectAt(page: puppeteer.Page, needle: string, k = 0, length = needle.length): Promise<void> {
    await page.focus('.ProseMirror');
    await page.evaluate((n, i, len) => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(n);
            if (at >= 0) {
                (document.getSelection() as Selection).setBaseAndExtent(node, at + i, node, at + i + len);
                return;
            }
        }
        throw new Error(`no "${n}" in the document`);
    }, needle, k, length);
}

/** The lines of text of the first note body holding `needle`, top to bottom, and its float. */
function bodyLines(page: puppeteer.Page, needle: string) {
    return page.evaluate(n => {
        const el = Array.from(document.querySelectorAll('.ProseMirror .mnote')).find(e => (e.textContent ?? '').includes(n)) as HTMLElement | undefined;
        if (!el) {
            throw new Error(`no note body holding "${n}"`);
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines: { top: number; bottom: number; left: number; right: number }[] = [];
        for (const r of Array.from(range.getClientRects())) {
            if (r.width === 0 || r.height === 0) {
                continue;
            }
            const line = lines.find(l => Math.abs(l.top - r.top) < 3);
            if (line) {
                Object.assign(line, { top: Math.min(line.top, r.top), bottom: Math.max(line.bottom, r.bottom), left: Math.min(line.left, r.left), right: Math.max(line.right, r.right) });
            } else {
                lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
            }
        }
        return { float: getComputedStyle(el).float, lines: lines.sort((a, c) => a.top - c.top) };
    }, needle);
}

/**
 * #15 review 2 (Daniel): the bubble over words of a note's body set into the
 * margin stands above the selected line, never over it or the body's text
 * below it; with no room above, below the body's last line.
 */
async function bubbleOffNoteBody(page: puppeteer.Page, b: BreadcrumbPage, what: string): Promise<void> {
    const body = 'nicht zu abrupt ändern, nicht zu schnell, ganz ruhig und gleichmäßig, mit Pausen an den richtigen Stellen und ohne Hast';
    for (const [doc, room] of [
        [`Erster Absatz mit Text.\n\nZweiter Absatz mit Text.\n\nEin Satz mit !!Tempo|${body}!!{.tipp} und mehr Worten danach.\n\nThe last paragraph.\n`, true],
        [`!!Tempo|${body}!!{.tipp} steht ganz oben.\n\nThe last paragraph.\n`, false],
    ] as const) {
        await b.show(doc);
        await selectAt(page, 'abrupt');
        await page.waitForSelector(BUBBLE, { visible: true, timeout: 3000 });
        await delay(200);
        const bubble = await rectOf(page, BUBBLE);
        const note = await bodyLines(page, 'abrupt');
        const row = await rectOf(page, '.mep-toolbar');
        const said = `${what}, ${room ? 'room above' : 'no room above'}: ${JSON.stringify({ bubble, note, row: row.bottom })}`;
        assert.notStrictEqual(note.float, 'none', `the body is in the margin: ${said}`);
        assert.ok(note.lines.length >= 2, `the body runs over lines: ${said}`);
        // "abrupt" is on the body's first line.
        const selected = note.lines[0];
        for (const line of note.lines) {
            const over = bubble.left < line.right && bubble.right > line.left && bubble.top < line.bottom && bubble.bottom > line.top;
            assert.ok(!over, `never over the selected line or the body's text below it: ${said}`);
        }
        const height = bubble.bottom - bubble.top;
        assert.strictEqual(selected.top - height - 8 >= row.bottom, room, `the room above is as the case says: ${said}`);
        if (room) {
            assert.ok(bubble.bottom <= selected.top + 0.5, `above the selected line: ${said}`);
        } else {
            assert.ok(bubble.top >= note.lines[note.lines.length - 1].bottom - 0.5, `below the body's last line: ${said}`);
        }
    }
}

/**
 * #15 review 2 (Daniel): a bar prefers below; above only where below is text
 * and above is not. A note's reference with a heading above its line and the
 * next item below: the bar keeps below, off the heading (tempo-after) — the
 * caret on the body's second line in the margin, level with the place below
 * the reference: the caret's line there is the margin's, not the column's.
 */
async function barBelowWithTextOnBothSides(page: puppeteer.Page, b: BreadcrumbPage, what: string): Promise<void> {
    await b.show('Davor ein Absatz.\n\n## Wie wir natürlich vortragen\n\n1. Gründliche !!Vorbereitung|Vorlesung, gut üben, flüssig, dazu wörtliche Rede mit Gefühl, aber kein Theater!!{.tipp} !\n   - Gebet um Konzentration und Ruhe im Kopf\n   - Hauptpunkte im Kopf haben\n\nThe last paragraph.\n');
    await selectAt(page, 'Gefühl', 3, 0);
    await delay(INLINE_DELAY_MS + 250);
    await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
    assert.strictEqual((await barOf(page)).title, 'Marginal note {.tipp}', what);
    const bar = await rectOf(page, BAR);
    const ref = await elementRect(page, '.mn-anchor', 'Vorbereitung');
    const heading = await elementRect(page, 'h2', 'Wie wir');
    const item = await elementRect(page, 'li li', 'Gebet');
    const caret = await page.evaluate(() => {
        const r = (document.getSelection() as Selection).getRangeAt(0).getClientRects()[0];
        return { left: r.left, top: r.top, bottom: r.bottom };
    });
    const said = `${what}: ${JSON.stringify({ bar, ref, heading, item, caret })}`;
    assert.ok(item.top < ref.bottom + 40 && heading.bottom > ref.top - 40, `text right above and right below the reference's line: ${said}`);
    assert.ok(caret.left > ref.right && caret.top >= ref.bottom - 2 && caret.top < ref.bottom + 36, `the caret in the margin, level with the place below the reference: ${said}`);
    assert.ok(bar.top >= ref.bottom - 0.5, `below the reference's line: ${said}`);
    assert.ok(bar.bottom <= heading.top || bar.top >= heading.bottom, `off the heading: ${said}`);
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
            // At the reference's line: under its last line box, or above its first where only below is text.
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
        // Remove attributes ▾ in the Remove slot, the destroying verb last (#15 critique).
        assert.deepStrictEqual((await barOf(page)).verbs.slice(-2), ['Remove attributes', 'Delete note']);
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

    // Last: its document leaves the page scrolled for the suite's next `show` of NOTES_DOC.
    test('fail-first (#15 review 2, below unless only below is text): text above and below a note\'s reference — its bar keeps below, off the heading (the extension\'s lane, 1280)', async function () {
        // Before: text under both sides put an inline object's bar above, over the heading.
        this.timeout(20000);
        await barBelowWithTextOnBothSides(page, b, 'the extension\'s lane');
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

    test('fail-first (#15 review 2): the bubble over words of a note\'s body in the margin stands above the selected line, never over the body\'s text; no room above, below its last line (the extension\'s lane, 1280)', async function () {
        // Before: the bubble stood below the selected line, over the body's second line.
        this.timeout(30000);
        await bubbleOffNoteBody(page, b, 'the extension\'s lane');
    });

    test('fail-first (#15 review 3): a selection from the start of paragraph A to the start of paragraph B (Shift+Down from a line start) — the bubble is not over B\'s line', async function () {
        // Before: the caret at the start of B counted as a margin caret (its right edge is left of the column's), so B's line stopped protecting the column: the bubble stood at y 72–104 over B's 89–106.
        this.timeout(30000);
        await b.show('Erste Zeile Alpha mit Text.\n\nZweite Zeile Beta mit Text.\n\nDritte Zeile Gamma mit Text.\n\nThe last paragraph.\n');
        await selectAt(page, 'Erste', 0, 0);
        await page.keyboard.down('Shift');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.up('Shift');
        await page.waitForSelector(BUBBLE, { visible: true, timeout: 3000 });
        await delay(300);
        const bubble = await rectOf(page, BUBBLE);
        const line = await elementRect(page, 'p', 'Zweite');
        const said = JSON.stringify({ bubble, line });
        assert.ok(await page.evaluate(() => (document.getSelection() as Selection).toString().length > 0), `the selection reaches into paragraph B: ${said}`);
        assert.ok(!(bubble.left < line.right && bubble.right > line.left && bubble.top < line.bottom && bubble.bottom > line.top), `the bubble is not over B's line: ${said}`);
        await page.keyboard.press('Escape');
    });

    test('fail-first (#15 review 2): the editor\'s own copy of [x]{.left-sidebar} and [y]{.sn-ref} pastes back as attribute spans, not as a sidebar or a note', async function () {
        // Before: the sidebar's and the note's rules (priority 60) read the span's element first: $x${.left-sidebar}, a sidenote with no body.
        this.timeout(20000);
        await b.show('Alpha [x]{.left-sidebar} and [y]{.sn-ref} beta.\n\nGamma.\n\nThe last paragraph.\n');
        assert.strictEqual(await page.$$eval('.ProseMirror p:first-child span[data-mep-attrs]', els => els.length), 2, 'two attribute spans drawn');
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
        assert.ok(text.includes('Gamma.Alpha [x]{.left-sidebar} and [y]{.sn-ref} beta.\n'), `${html}\n${text}`);
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

/**
 * A user stylesheet with a margin layout of its own: Daniel's petrol one
 * (`MEP_USER_STYLESHEET`, read in place), else the fixture shaped like it —
 * the margin suite runs in the default run too (#15 review 2).
 */
const USER_STYLESHEET = process.env.MEP_USER_STYLESHEET !== undefined && fs.existsSync(process.env.MEP_USER_STYLESHEET)
    ? process.env.MEP_USER_STYLESHEET
    : path.join(repoRoot, 'test', 'fixtures', 'editor', 'marginLayout.css');

/**
 * Bars reach into the margin (Daniel, #15 critique): where nothing stands in
 * the margin at the bar's height, a bar may grow past the column up to the
 * editor's edge less 16 px before its words give way; beside a note's body
 * it stops short of it. Measured at 1280 with a margin layout (`USER_STYLESHEET`:
 * its column is narrow, its notes float into the right margin), and without a margin.
 */
suite('Editor note attributes: bars reach into the margin (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = notePage(() => editor as EditorPage);
    const DOC = [
        'Erster Absatz ohne alles.',
        '',
        'Davor !!Lang|ein langer Hinweis im Rand, der über mehrere Zeilen nach unten reicht, bis neben den nächsten Punkt, und noch weiter, '
            + 'immer weiter, Zeile um Zeile, bis tief neben die Liste, und dort noch ein gutes Stück, damit er sicher neben dem Punkt hängt, '
            // Past the item's line too: its bar keeps below it where text is on both sides (#15 review 2), and the note is still there.
            + 'und weiter neben dem, was unter dem Punkt steht, Zeile um Zeile, bis er auch neben der Leiste unter dem Punkt hängt, und noch etwas!!.',
        '',
        '- Zeit $Uhrzeit${class=living} und ein ruhiger Satz, der weitergeht. {.punkt}',
        '',
        '- Ein Satz mit !!Tempo|nicht zu abrupt ändern, nicht zu schnell, ganz ruhig!!{.tipp} und mehr Worten danach. {.punkt}',
        '',
        'The last paragraph.',
        '',
    ].join('\n');

    /** The bar's box, whether "…" shows, and the window's width. */
    const barBox = () => page.$eval(BAR, el => {
        const r = el.getBoundingClientRect();
        const more = el.querySelector<HTMLElement>('.mep-object-more');
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, more: more !== null && !more.hidden && more.isConnected, edge: document.documentElement.clientWidth };
    });
    const columnRight = () => page.$eval('.ProseMirror', el => {
        const p = el.querySelector('p') as HTMLElement;
        return p.getBoundingClientRect().right;
    });

    teardown(async () => {
        if (editor !== undefined) {
            await page.keyboard.press('Escape');
            await leaveObjects(page);
        }
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('with a margin layout at 1280: the left sidebar\'s bar grows into the empty right margin, every verb on it, up to the edge less 16 px', async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css'], userStyles: [USER_STYLESHEET] });
        if (!editor) {
            this.skip();
        }
        page = (editor as EditorPage).page;
        // Without the notes: nothing in the right margin at the bar's height, whichever side of the item it takes.
        await b.show('Erster Absatz ohne alles.\n\n- Zeit $Uhrzeit${class=living} und ein ruhiger Satz, der weitergeht. {.punkt}\n\n- Ein zweiter Punkt ohne Notiz. {.punkt}\n\nThe last paragraph.\n');
        await b.restAt('Uhrzeit', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const bar = await barBox();
        const column = await columnRight();
        assert.ok(bar.right > column + 1, `past the column: ${JSON.stringify({ bar, column })}`);
        assert.ok(bar.right <= bar.edge - 16 + 0.5, `inside the edge less 16 px: ${JSON.stringify(bar)}`);
        assert.ok(!bar.more, `no word gave way: ${JSON.stringify(bar)}`);
    });

    test('with a margin layout at 1280: a sidebar floated beside a heading has its bar off the heading\'s text lines, not only off its own box', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        const words = 'Rückblick, Ausblick und ein Lied mit vielen Worten, die über mehrere Zeilen laufen und laufen';
        // Text right above and right below the heading: the bar's two sides both have text, and it keeps below (#15 review 2), under the heading's last line.
        const filler = Array.from({ length: 12 }, (_, k) => `Zeile ${k} mit etwas Text.`).join('\n\n');
        await b.show(`${filler}\n\nDavor ein Absatz mit Text, der bis an die Überschrift reicht.\n\n## ${words} $03:00\${class=living}\nDanach ein Absatz direkt darunter mit vielen Worten, die weitergehen.\n\nThe last paragraph.\n`);
        await page.focus('.ProseMirror');
        await page.evaluate(() => {
            const h = document.querySelector('.ProseMirror h2') as HTMLElement;
            h.scrollIntoView({ block: 'center' });
            const side = h.querySelector('.left-sidebar') as HTMLElement;
            (document.getSelection() as Selection).collapse(side.firstChild as globalThis.Node, 2);
        });
        await delay(INLINE_DELAY_MS + 300);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const bar = await barBox();
        const lines = await page.evaluate(() => {
            const h = document.querySelector('.ProseMirror h2') as HTMLElement;
            const out: { top: number; bottom: number; left: number; right: number }[] = [];
            const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
            const range = document.createRange();
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if ((n.parentElement as HTMLElement).closest('.left-sidebar') || (n.textContent ?? '').trim() === '') {
                    continue;
                }
                range.selectNodeContents(n);
                out.push(...Array.from(range.getClientRects()).map(r => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })));
            }
            return out;
        });
        assert.ok(lines.length > 1, `the heading wraps: ${JSON.stringify(lines)}`);
        for (const line of lines) {
            const over = bar.left < line.right && bar.right > line.left && bar.top < line.bottom && bar.bottom > line.top;
            assert.ok(!over, `never over the heading's text: ${JSON.stringify({ bar, line })}`);
        }
    });

    test('fail-first (#15 review 2), with a margin layout at 1280: the bubble over words of a note\'s body stands above the selected line, never over the body\'s text; no room above, below its last line', async function () {
        this.timeout(30000);
        if (editor === undefined) {
            this.skip();
        }
        await bubbleOffNoteBody(page, b, 'a margin layout');
        await page.keyboard.press('Escape');
    });

    test('fail-first (#15 review 3), with a margin layout at 1280: the bubble in a note stacked under another note goes below the note — never over the column\'s text or the notes', async function () {
        // Before: the other note above took the place above, the bubble was shortened to it and slid into the column (x 353, over " danach." and the next line).
        this.timeout(30000);
        if (editor === undefined) {
            this.skip();
        }
        await b.show('Ein Satz mit !!Eins|erste Notiz mit etwas Text, der über zwei Zeilen geht und weiter und weiter!! und !!Zwei|zweite Notiz abrupt mit Text, der weitergeht und weiter und weiter!! danach.\n\nThe last paragraph with more words.\n');
        await selectAt(page, 'abrupt');
        await page.waitForSelector(BUBBLE, { visible: true, timeout: 3000 });
        await delay(300);
        const bubble = await rectOf(page, BUBBLE);
        const lines = await page.evaluate(() => {
            const out: { text: string; note: boolean; top: number; bottom: number; left: number; right: number }[] = [];
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
            const range = document.createRange();
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                range.selectNodeContents(n);
                for (const r of Array.from(range.getClientRects()).filter(q => q.width > 0 && q.height > 0)) {
                    out.push({ text: (n.textContent ?? '').slice(0, 20), note: (n.parentElement as HTMLElement).closest('.mnote') !== null, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
                }
            }
            return out;
        });
        const said = JSON.stringify({ bubble, lines });
        for (const line of lines) {
            const over = bubble.left < line.right && bubble.right > line.left && bubble.top < line.bottom && bubble.bottom > line.top;
            assert.ok(!over, `never over the column's text or a note's: ${said}`);
        }
        const second = Math.max(...lines.filter(l => l.note).map(l => l.bottom));
        assert.ok(bubble.top >= second - 0.5, `below the note: ${said}`);
        await page.keyboard.press('Escape');
    });

    test('fail-first (#15 review 3), with a margin layout at 1280: the bubble over words of a right sidebar keeps the normal rule — below, in the margin, off the text — not above', async function () {
        // Before: any floated body took the bubble above its line, over the column's text.
        this.timeout(30000);
        if (editor === undefined) {
            this.skip();
        }
        await b.show('Ein erster Absatz mit Text, der lang genug ist, damit er über die Zeile läuft und weiter.\n\nZeile mit @Rechts außen@ und Text danach, der weitergeht.\n\nThe last paragraph.\n');
        await selectAt(page, 'Rechts');
        await page.waitForSelector(BUBBLE, { visible: true, timeout: 3000 });
        await delay(300);
        const bubble = await rectOf(page, BUBBLE);
        const side = await elementRect(page, '.right-sidebar', 'Rechts');
        assert.ok(bubble.top >= side.bottom - 0.5, `below the sidebar's line, not above: ${JSON.stringify({ bubble, side })}`);
        await page.keyboard.press('Escape');
    });

    test('fail-first (#15 review 2, below unless only below is text), with a margin layout at 1280: text above and below a note\'s reference — its bar keeps below, off the heading', async function () {
        this.timeout(30000);
        if (editor === undefined) {
            this.skip();
        }
        await barBelowWithTextOnBothSides(page, b, 'a margin layout');
    });

    test('with a margin layout at 1280: beside a note\'s body in the margin the bar stops short of it', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        await b.show(DOC);
        await b.restAt('Tempo', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const bar = await barBox();
        const column = await columnRight();
        for (const needle of ['abrupt', 'langer Hinweis']) {
            const body = await elementRect(page, '.mnote', needle);
            const overlaps = bar.left < body.right && bar.right > body.left && bar.top < body.bottom && bar.bottom > body.top;
            assert.ok(!overlaps, `never over a note's body: ${JSON.stringify({ bar, body, column })}`);
        }
        // The crumbs bar is wider than the column, and the long note hangs beside it: it gave way before it, not over it.
        const long = await elementRect(page, '.mnote', 'langer Hinweis');
        assert.ok(long.top < bar.bottom && long.bottom > bar.top, `the long note is at the bar's height: ${JSON.stringify({ bar, long })}`);
        assert.ok(bar.right <= long.left - 4 + 0.5, JSON.stringify({ bar, long }));
        await closeEditorPage(this, editor);
        editor = undefined;
    });

    test('without a margin (600 px, the extension\'s stylesheet): the bar keeps inside the edge less 16 px, its verbs giving way into "…"', async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 600, height: 900, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = (editor as EditorPage).page;
        await b.show(DOC);
        await b.restAt('Uhrzeit', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const bar = await barBox();
        assert.ok(bar.right <= bar.edge - 16 + 0.5, `inside the edge less 16 px: ${JSON.stringify(bar)}`);
        assert.ok(bar.more, `the verbs gave way into "…": ${JSON.stringify(bar)}`);
    });
});
