import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { EditorPage, UNDO, closeEditorPage, delay, describedTip, leaveObjects, openEditorPage, settle } from './pageHarness';
import { BAR, BreadcrumbPage, CRUMBS, breadcrumbPage, rectOf } from './breadcrumbPage';
import { TEMPO } from './noteSample';
import { hostEngine } from './helpers';
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
function notePage(editor: () => EditorPage): BreadcrumbPage {
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
