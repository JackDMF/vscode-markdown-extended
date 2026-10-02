import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { SIDEBAR_GLUED_BEFORE } from '../../../src/editor/serialize';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { closeEditorPage, delay, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, pointAt as textPoint, settle } from './pageHarness';

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
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        // Out of any object the last test left the caret or the pointer in.
        await page.mouse.move(2, 2);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await delay(400);
    };

    /** The point just inside the left edge of character `index` of `needle`. */
    const pointAt = (needle: string, index = 0) => textPoint(page, needle, index);

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

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
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

    test('on a line just under the row, the bar goes beside the line, else below it, and never over text or the caret', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body++ gamma.\n\nSecond paragraph.\n', 'Alpha');
        // The line scrolled up to just under the row: no room above it for a bar.
        await page.evaluate(() => {
            const line = (document.querySelector('.ProseMirror > p') as HTMLElement).getBoundingClientRect();
            const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
            window.scrollBy(0, line.top - row.bottom - 6);
        });
        await delay(100);
        await clickBefore('ref', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        const geometry = await page.evaluate(sel => {
            const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
            const range = (document.getSelection() as Selection).getRangeAt(0);
            const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();
            // Every line box of the document's text the bar overlaps.
            const covered: string[] = [];
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const r = document.createRange();
                r.selectNodeContents(node);
                if ((node.textContent ?? '').trim() !== '' && Array.from(r.getClientRects()).some(b => b.left < bar.right && b.right > bar.left && b.top < bar.bottom && b.bottom > bar.top)) {
                    covered.push(node.textContent ?? '');
                }
            }
            return { barTop: bar.top, barLeft: bar.left, rowBottom: row.bottom, caretBottom: caret.bottom, caretRight: caret.right, covered };
        }, BAR);
        assert.ok(geometry.barTop >= geometry.rowBottom, `not under the row: ${JSON.stringify(geometry)}`);
        assert.deepStrictEqual(geometry.covered, [], `over no text: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.barLeft > geometry.caretRight || geometry.barTop >= geometry.caretBottom, `beside the line or below it: ${JSON.stringify(geometry)}`);
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

    test('the caret in a link: Open, Edit link… and Remove link; Edit link… is prefilled; the new URL and the kept text are what is posted', async function () {
        this.timeout(15000);
        await showDocument('See [the spec](spec.md) here.\n', 'See');
        await clickBefore('spec', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(), { object: 'link', label: 'Link', verbs: ['open-link', 'edit-link', 'remove-link'] });

        await clickVerb('edit-link');
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

    test('an Edit link… commit keeps the bar shown throughout: it does not blink out and wait for the delay again', async function () {
        this.timeout(15000);
        await showDocument('See [the spec](spec.md) here.\n', 'See');
        await clickBefore('spec', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        await clickVerb('edit-link');
        // Every state the selection's bar takes from here on.
        await page.evaluate(() => {
            const bar = document.querySelector('.mep-object-toolbar[data-trigger="selection"]') as HTMLElement;
            const w = window as unknown as { barHidden: boolean[] };
            w.barHidden = [];
            new MutationObserver(() => w.barHidden.push(bar.hidden)).observe(bar, { attributes: true, attributeFilter: ['hidden'] });
        });
        await page.keyboard.type('other.md');
        await page.keyboard.press('Enter');
        await delay(INLINE_DELAY_MS + 200);
        assert.deepStrictEqual(await page.evaluate(() => (window as unknown as { barHidden: boolean[] }).barHidden.filter(h => h)), [], 'never hidden');
        assert.deepStrictEqual(await barState(), { object: 'link', label: 'Link', verbs: ['open-link', 'edit-link', 'remove-link'] });
        assert.strictEqual((await active()).editor, true, 'the focus is back in the text');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the spec](other.md) here.\n');
    });

    test('the field survives the window losing the focus, and has it again when the window returns; a click in the page cancels it', async function () {
        this.timeout(15000);
        await showDocument('See [the spec](spec.md) here.\n', 'See');
        await clickBefore('spec', 1);
        await clickVerb('edit-link');
        await page.keyboard.type('half');
        // What Alt+Tab to another application does: the document loses the
        // focus, the field is blurred, and the window gets `blur`; later `focus`.
        await page.evaluate(() => {
            const d = document as unknown as { hasFocus(): boolean; realHasFocus?: () => boolean };
            d.realHasFocus = d.hasFocus.bind(document);
            d.hasFocus = () => false;
            (document.activeElement as HTMLElement).blur();
            window.dispatchEvent(new Event('blur'));
        });
        await delay(100);
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), 'half', 'kept, with what was typed');
        await page.evaluate(() => {
            const d = document as unknown as { hasFocus(): boolean; realHasFocus: () => boolean };
            d.hasFocus = d.realHasFocus;
            window.dispatchEvent(new Event('focus'));
        });
        await delay(80);
        assert.strictEqual((await active()).field, true, 'focused again');
        await page.keyboard.type('.md');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'See [the spec](half.md) here.\n');

        // Within the page, the focus moving elsewhere is a cancel.
        await clickVerb('edit-link');
        await page.keyboard.type('never');
        const before = (await (editor as EditorPage).edits()).length;
        await clickBefore('here', 2);
        await delay(100);
        assert.strictEqual(await page.$('.mep-inline-field'), null, 'cancelled');
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'nothing was edited');
    });

    test('after Edit image… and an undo, the image\'s bar offers the alt text and the source the document holds again', async function () {
        this.timeout(15000);
        await showDocument('An ![pic](p.png) here.\n', 'An');
        // A broken image has no size of its own; give it one to click.
        await page.addStyleTag({ content: '.ProseMirror img { display: inline-block; width: 60px; height: 30px; }' });
        const img = await (await page.$('.ProseMirror img'))?.boundingBox();
        assert.ok(img);
        await page.mouse.click(img.x + img.width / 2, img.y + img.height / 2);
        await page.waitForSelector(`${BAR}[data-object="image"]`, { timeout: 2000 });
        assert.deepStrictEqual((await barState()).verbs, ['edit-image', 'open-image', 'remove-image']);
        await clickVerb('edit-image');
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), 'pic', 'the alt text first');
        await page.keyboard.press('Enter');
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), 'p.png', 'then the path');
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.type('q.png');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'An ![pic](q.png) here.\n');

        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'An ![pic](p.png) here.\n');
        await page.waitForSelector(`${BAR}[data-object="image"]`, { timeout: 2000 });
        await clickVerb('edit-image');
        await page.keyboard.press('Enter');
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), 'p.png', 'not the undone q.png');
        await page.keyboard.press('Escape');
    });

    test('a source block shows its bar while the pointer is on it, keeps it while the pointer crosses to it, and Delete block removes it', async function () {
        this.timeout(15000);
        await showDocument('Before.\n\n| a | b |\n| = | = |\n| 1 | 2 |\n\nAfter.\n', 'Before');
        const table = await (await page.$('.mep-raw-block table'))?.boundingBox();
        assert.ok(table);
        await page.mouse.move(table.x + table.width / 2, table.y + table.height / 2);
        await page.waitForSelector(HOVER_BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(HOVER_BAR), { object: 'raw_block', label: 'Source · multimd table', verbs: ['edit-source', 'show-in-text-editor', 'delete-block'] });
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

    test('the caret in an admonition: Change type from the menu of types, Edit title; the page and the file say both', async function () {
        this.timeout(15000);
        await showDocument('Intro.\n\n!!! note "Old title"\n    Body text here.\n\nAfter.\n', 'Body');
        await clickBefore('text here', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(), { object: 'admonition', label: 'Admonition note', verbs: ['change-type', 'edit-title', 'block-attributes', 'remove-admonition'] });

        await clickVerb('change-type');
        const choice = `${BAR} select.mep-inline-choice`;
        assert.strictEqual(await page.$eval(choice, el => (el as HTMLSelectElement).value), 'note', 'the current type is chosen');
        await page.select(choice, 'danger');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Intro.\n\n!!! danger "Old title"\n    Body text here.\n\nAfter.\n');
        assert.strictEqual(await page.$eval('.ProseMirror div.admonition.danger > p.admonition-title', el => el.textContent), 'Old title');

        await clickVerb('edit-title');
        assert.strictEqual(await page.$eval(`${BAR} .mep-inline-field`, el => (el as HTMLInputElement).value), 'Old title');
        await page.keyboard.type('New title');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Intro.\n\n!!! danger "New title"\n    Body text here.\n\nAfter.\n');
        assert.strictEqual(await page.$eval('.ProseMirror div.admonition.danger > p.admonition-title', el => el.textContent), 'New title');
    });

    test('the caret in a container: Remove container, keep content posts its paragraphs where it stood, and says so', async function () {
        this.timeout(15000);
        await showDocument('Intro.\n\n::: box\nFirst kept.\n\nSecond kept.\n:::\n\nAfter.\n', 'First');
        await clickBefore('First kept', 2);
        await page.waitForSelector(BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(), { object: 'container', label: 'Container box', verbs: ['change-name', 'block-attributes', 'remove-container'] });
        await clickVerb('remove-container');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Intro.\n\nFirst kept.\n\nSecond kept.\n\nAfter.\n');
        assert.strictEqual((await hint()).text, 'Container removed — Ctrl+Z');
        assert.strictEqual(await page.$('.ProseMirror div[data-mep-container]'), null);
    });

    test('the caret in a span: Edit attributes and Remove attributes, keep text', async function () {
        this.timeout(15000);
        await showDocument('A [styled]{.old} word.\n', 'styled');
        await clickBefore('styled', 2);
        await page.waitForSelector(BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(), { object: 'span', label: 'Span', verbs: ['edit-attributes', 'remove-attributes'] });
        await clickVerb('edit-attributes');
        await page.keyboard.type('{.new #s}');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'A [styled]{.new #s} word.\n');
        assert.strictEqual(await page.$eval('.ProseMirror span.new', el => el.id), 's');
        await clickVerb('remove-attributes');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'A styled word.\n');
    });

    test('a verb that would glue a sidebar to a letter is disabled with the reason, and one the filter refuses says no success', async function () {
        this.timeout(15000);
        const verbState = (verb: string) => page.$eval(`${BAR} [data-verb="${verb}"]`, el => ({ disabled: el.getAttribute('aria-disabled'), title: (el as HTMLElement).title }));
        // Right sidebars: VS Code's math extension, on in the test instance, claims every `$` first.
        await showDocument('A [styled]{.c}@y@ word.\n', 'styled');
        await clickBefore('styled', 2);
        await page.waitForSelector(BAR, { timeout: 2000 });
        assert.deepStrictEqual(await barState(), { object: 'span', label: 'Span', verbs: ['edit-attributes', 'remove-attributes'] });
        const removeAttributes = await verbState('remove-attributes');
        assert.strictEqual(removeAttributes.disabled, 'true');
        assert.ok(removeAttributes.title.endsWith(SIDEBAR_GLUED_BEFORE), removeAttributes.title);

        await showDocument('An![pic](p.png)@y@ here.\n', 'An');
        await page.addStyleTag({ content: '.ProseMirror img { display: inline-block; width: 60px; height: 30px; }' });
        const img = await (await page.$('.ProseMirror img'))?.boundingBox();
        assert.ok(img);
        await page.mouse.click(img.x + img.width / 2, img.y + img.height / 2);
        await page.waitForSelector(`${BAR}[data-object="image"]`, { timeout: 2000 });
        const removeImage = await verbState('remove-image');
        assert.strictEqual(removeImage.disabled, 'true');
        assert.ok(removeImage.title.endsWith(SIDEBAR_GLUED_BEFORE), removeImage.title);

        // Remove note asks nothing beforehand; the filter refuses it, and the hint is its reason, not "Note removed".
        await showDocument('Alpha ++beta|the body++@y@ gamma.\n', 'Alpha');
        const edits = (await (editor as EditorPage).edits()).length;
        await clickBefore('body', 1);
        await clickVerb('remove-note');
        await settle();
        assert.deepStrictEqual(await hint(), { text: SIDEBAR_GLUED_BEFORE, tone: 'refusal', shown: true });
        assert.strictEqual((await (editor as EditorPage).edits()).length, edits, 'nothing posted');
    });
});
