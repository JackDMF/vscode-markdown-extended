import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { EXTENSION_ID, EditorPage, UNDO, closeEditorPage, delay, openEditorPage, settle } from './pageHarness';
import { BAR, CRUMBS, ROW_FIELD, blockRect, breadcrumbPage, rectOf } from './breadcrumbPage';

/** The constructs the breadcrumb is drawn for (#8), and one it is not. */
export const CRUMBS_DOC = [
    '- Queue the edit locally {.lead}',
    '- Send the batch',
    '',
    '{.steps}',
    '',
    '> Conflicts are shown to the user.',
    '> {.warning}',
    '',
    '- bare one',
    '- bare two',
    '',
    '!!! warning',
    '    ## Sync rules {#sync-rules}',
    '',
    '    Body text.',
    '',
    'The last paragraph.',
    '',
].join('\n');

/** The bar's parts and verbs as the eye and a screen reader meet them. */
async function barState(page: puppeteer.Page) {
    return page.$eval(BAR, bar => ({
        label: bar.getAttribute('aria-label'),
        group: bar.querySelector('.mep-crumbs')?.getAttribute('role') ?? null,
        groupLabel: bar.querySelector('.mep-crumbs')?.getAttribute('aria-label') ?? null,
        parts: Array.from(bar.querySelectorAll('.mep-crumb')).map(p => ({
            role: (p as HTMLElement).dataset.part,
            text: p.querySelector('.mep-crumb-name')?.textContent,
            code: (p.querySelector('.mep-crumb-code') as HTMLElement | null)?.offsetWidth ? p.querySelector('.mep-crumb-code')?.textContent : null,
            name: p.getAttribute('aria-label'),
            current: p.getAttribute('aria-current'),
            tag: p.tagName.toLowerCase(),
        })),
        seps: Array.from(bar.querySelectorAll('.mep-crumb-sep')).map(s => s.getAttribute('aria-hidden')),
        verbs: Array.from(bar.querySelectorAll(':scope > button[data-verb]')).filter(b => !(b as HTMLElement).hidden).map(b => b.textContent),
        title: bar.querySelector(':scope > .mep-object-label')?.textContent ?? null,
    }));
}

/**
 * The breadcrumb bar (#8 step 5): List › List item at a list item, the
 * current part the menu's target; its parts buttons in the arrow order,
 * named for a screen reader; a one-part block bar showing its literal and
 * Remove attributes; no bar on a rest at a list of bare items.
 */
suite('Editor breadcrumb: the bar (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = breadcrumbPage(() => editor as EditorPage);

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
        await page.mouse.click(1270, 890);
    });

    test('fail-first: at a list item the bar\'s current part is the List item — the Block type menu\'s first attributes entry — not the list', async function () {
        // Before #8 the bar here said "List attributes" while the menu said "Attributes of List item…".
        this.timeout(15000);
        await b.show(CRUMBS_DOC);
        await b.restAt('Queue the edit', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const current = await page.$eval(`${CRUMBS} [aria-current] .mep-crumb-name`, el => el.textContent);
        assert.strictEqual(current, 'List item');
        await b.openMenu('block-type');
        const entry = await page.$eval('.mep-menu[data-menu="block-type"] [data-action="block-type-attributes"] .mep-entry-label', el => el.textContent ?? '');
        assert.strictEqual(entry.replace(/^Attributes of /, '').replace(/…$/, ''), current, 'bar and menu name the same part');
    });

    test('the parts are buttons in a group, named for a screen reader; the current name semibold, its literal regular; ←/→ go outer → current → verbs', async function () {
        this.timeout(15000);
        await b.show(CRUMBS_DOC);
        await b.restAt('Queue the edit', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const state = await barState(page);
        assert.strictEqual(state.group, 'group');
        assert.strictEqual(state.groupLabel, 'Blocks at the caret');
        assert.strictEqual(await page.$(`${BAR} nav`), null, 'no landmark');
        assert.deepStrictEqual(state.seps, ['true']);
        assert.deepStrictEqual(state.parts.map(p => [p.role, p.tag, p.text, p.code, p.name, p.current]), [
            ['outer', 'button', 'List', '{.steps}', 'Attributes of List, .steps', null],
            ['current', 'button', 'List item', '{.lead}', 'Attributes of List item, .lead', 'true'],
        ]);
        const count = (state.verbs.length + 2);
        assert.strictEqual(state.label, `List item .lead in List .steps, ${count} actions, arrow keys to choose`);
        const weights = await page.$eval(`${CRUMBS} [aria-current]`, el => [getComputedStyle(el.querySelector('.mep-crumb-name') as Element).fontWeight, getComputedStyle(el.querySelector('.mep-crumb-code') as Element).fontWeight]);
        assert.ok(Number(weights[0]) >= 600 && Number(weights[1]) === 400, JSON.stringify(weights));

        // Alt+Enter: Attributes… — then ← reaches the current part, the outer one, and → back.
        await b.pressAlt('Enter');
        const focused = () => page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            return el.dataset.part ?? el.dataset.verb ?? el.className;
        });
        assert.strictEqual(await focused(), 'block-attributes');
        await page.keyboard.press('ArrowLeft');
        assert.strictEqual(await focused(), 'current');
        await page.keyboard.press('ArrowLeft');
        assert.strictEqual(await focused(), 'outer');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        assert.strictEqual(await focused(), 'block-attributes');
    });

    test('a one-part block bar: Quote {.warning} · Attributes… · Remove attributes', async function () {
        this.timeout(15000);
        await b.show(CRUMBS_DOC);
        await b.restAt('Conflicts are', 3);
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        const state = await barState(page);
        assert.strictEqual(state.parts.length, 0, 'no breadcrumb');
        assert.strictEqual(state.title, 'Quote {.warning}');
        assert.deepStrictEqual(state.verbs, ['Attributes…', 'Remove attributes']);
        const divided = await page.$eval(`${BAR} [data-verb="remove-attributes"]`, el => el.previousElementSibling?.classList.contains('mep-object-separator'));
        assert.ok(divided, 'Remove after a divider');
    });

    test('a list of bare items: no bar on a rest; Alt+Enter draws List › List item, both bare', async function () {
        this.timeout(15000);
        await b.show(CRUMBS_DOC);
        await b.restAt('bare one', 2);
        assert.strictEqual(await page.$(BAR), null, 'no bar on a rest');
        await b.pressAlt('Enter');
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const state = await barState(page);
        assert.deepStrictEqual(state.parts.map(p => [p.text, p.code, p.name]), [['List', null, 'Attributes of List, none'], ['List item', null, 'Attributes of List item, none']]);
    });

    test('an admonition\'s heading with a literal: the admonition a title part — not focusable, no hover — then the Heading', async function () {
        this.timeout(15000);
        await b.show(CRUMBS_DOC);
        await b.restAt('Sync rules', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const state = await barState(page);
        assert.deepStrictEqual(state.parts.map(p => [p.role, p.tag, p.text]), [['outer', 'span', 'Warning admonition'], ['current', 'button', 'Heading']]);
        assert.ok(state.verbs.includes('Attributes of Heading…'), JSON.stringify(state.verbs));
        const title = await page.$(`${CRUMBS} .mep-crumb-title`);
        const box = await title?.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await delay(150);
        const look = await page.$eval(`${CRUMBS} .mep-crumb-title`, el => ({ background: getComputedStyle(el).backgroundColor, tab: (el as HTMLElement).tabIndex }));
        assert.deepStrictEqual(look, { background: 'rgba(0, 0, 0, 0)', tab: -1 });
    });

    test('fail-first: Admonition › Heading — the bar stands at the heading\'s line, not under the whole admonition; current verbs first', async function () {
        // Before, the bar was anchored at the admonition and stood under its last line.
        this.timeout(15000);
        await b.show(CRUMBS_DOC);
        await b.restAt('Sync rules', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const bar = await rectOf(page, BAR);
        const heading = await blockRect(page, 'Sync rules', 'h2');
        const box = await blockRect(page, 'Body text', 'div.admonition');
        assert.ok(bar.top >= heading.bottom - 1 && bar.top < box.bottom - 4, `bar ${bar.top}, heading ${heading.bottom}, admonition ${box.bottom}`);
        const state = await barState(page);
        assert.deepStrictEqual(state.verbs.slice(0, 1), ['Attributes of Heading…'], JSON.stringify(state.verbs));
    });

    for (const [what, text, place] of [
        ['an item starting with a heading', '- ## Head\n- b\n\n{.l}\n\nThe last paragraph.\n', 'Head'],
        ['a new empty item', '- alpha\n- b\n\n{.l}\n\nThe last paragraph.\n', 'new item'],
    ] as const) {
        test(`fail-first: ${what} — its part refused, the bar keeps List {.l} › List item`, async function () {
            // Before the fix a refused current part (no target) dropped the breadcrumb: a one-part bar, the List's literal unreachable.
            this.timeout(15000);
            await b.show(text);
            if (place === 'new item') {
                await b.clickAt('alpha', 2);
                await page.keyboard.press('End');
                await page.keyboard.press('Enter');
                await delay(150);
            } else {
                await b.clickAt(place, 2);
            }
            await b.pressAlt('Enter');
            await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
            const state = await barState(page);
            assert.deepStrictEqual(state.parts.map(p => [p.role, p.text, p.code]), [['outer', 'List', '{.l}'], ['current', 'List item', null]]);
            assert.ok(state.verbs.includes('Remove attributes of List'), JSON.stringify(state.verbs));
        });
    }
});

/** A list item with a list nested in it, the list carrying a literal; a quote with bold in the middle of a line. */
export const FIELDS_DOC = [
    '- Queue the edit locally {.lead}',
    '  - nested one',
    '  - nested two',
    '- Send the batch',
    '',
    '{.steps}',
    '',
    '> A quoted line with **term**{.term} in the middle of it, and more words after it, enough of them to wrap the paragraph onto a second line under the',
    '> bold run at any width the suites open, so the run has text above it and below it — where an inline field stands above.',
    '> {.warning}',
    '',
    'The last paragraph.',
    '',
].join('\n');

/** The rectangle of the line box of `needle`'s first character. */
function lineOf(page: puppeteer.Page, needle: string) {
    return page.evaluate(n => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(n);
            if (at >= 0) {
                const range = document.createRange();
                range.setStart(node, at);
                range.setEnd(node, at + n.length);
                const r = range.getBoundingClientRect();
                return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            }
        }
        throw new Error(`no "${n}"`);
    }, needle);
}

/** The text the caret stands in, read from the window's selection. */
const caretText = (page: puppeteer.Page) => page.evaluate(() => window.getSelection()?.anchorNode?.textContent ?? '');

/**
 * Each part's field (#8 step 6): the current part's under its own line (an
 * item's above the list nested in it), the outer part's under its block,
 * an inline part's at its run; an outer field far below the caret scrolls
 * into view and gives the scroll back on Esc; the menu's route opens the
 * same field at the same place.
 */
suite('Editor breadcrumb: the parts\' fields (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = breadcrumbPage(() => editor as EditorPage);
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
        await page.mouse.click(1270, 890);
    });

    const pressPart = async (part: 'outer' | 'current') => {
        await page.waitForSelector(`${CRUMBS} [data-part="${part}"]`, { visible: true, timeout: 2000 });
        await page.click(`${CRUMBS} [data-part="${part}"]`);
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        await delay(120);
    };
    const field = async () => ({
        heading: await page.$eval(`${FIELD_BAR} .mep-object-label`, el => el.textContent),
        rect: await rectOf(page, FIELD_BAR),
    });

    test('the List item part opens its field under the item\'s first line, above the list nested in it; the List part under the list', async function () {
        this.timeout(20000);
        await b.show(FIELDS_DOC);
        await b.restAt('Queue the edit', 2);
        await pressPart('current');
        const item = await field();
        const line = await lineOf(page, 'Queue the edit');
        const nested = await blockRect(page, 'nested two', 'ul');
        assert.strictEqual(item.heading, 'List item · Attributes');
        assert.ok(item.rect.top >= line.bottom + 3 && item.rect.top < nested.bottom, `under the item's line: ${JSON.stringify({ field: item.rect, line, nested })}`);
        await page.keyboard.press('Escape');
        await b.restAt('Queue the edit', 2);
        await b.pressAlt('Enter');
        await pressPart('outer');
        const list = await field();
        const ul = await blockRect(page, 'Send the batch', 'ul');
        assert.strictEqual(list.heading, 'List · Attributes');
        assert.ok(list.rect.top >= ul.bottom, `under the list: ${JSON.stringify({ field: list.rect, ul })}`);
    });

    test('Quote › Bold: the Bold part\'s field at the run, above it with text on both sides; the Quote part\'s under the quote', async function () {
        this.timeout(20000);
        await b.show(FIELDS_DOC);
        await b.restAt('term', 2);
        await pressPart('current');
        const bold = await field();
        const run = await lineOf(page, 'term');
        assert.strictEqual(bold.heading, 'Bold · Attributes');
        assert.ok(bold.rect.bottom <= run.top + 1, `above the run: ${JSON.stringify({ field: bold.rect, run })}`);
        await page.keyboard.press('Escape');
        await b.restAt('term', 2);
        await b.pressAlt('Enter');
        await pressPart('outer');
        const quote = await field();
        const box = await blockRect(page, 'quoted line', 'blockquote');
        assert.strictEqual(quote.heading, 'Quote · Attributes');
        assert.ok(quote.rect.top >= box.bottom - 1, `under the quote: ${JSON.stringify({ field: quote.rect, box })}`);
    });

    test('a long list: the List\'s field scrolls into view with the list\'s last line, the caret stays; Esc gives the scroll back exactly', async function () {
        this.timeout(20000);
        const items = Array.from({ length: 60 }, (_, k) => `- Item number ${k + 1} of the long list`).join('\n');
        await b.show(`${items}\n\n{.steps}\n\nThe last paragraph.\n`);
        await b.restAt('Item number 1 of', 3);
        const before = await page.evaluate(() => (document.scrollingElement as HTMLElement).scrollTop);
        await b.pressAlt('Enter');
        await page.keyboard.press('Home');
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.part), 'outer');
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${FIELD_BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        await delay(200);
        const rect = await rectOf(page, FIELD_BAR);
        const last = await lineOf(page, 'Item number 60');
        const height = await page.evaluate(() => window.innerHeight);
        assert.ok(rect.top >= 0 && rect.bottom <= height && last.top >= 0 && last.bottom <= height, `in view: ${JSON.stringify({ rect, last, height })}`);
        await page.keyboard.press('Escape');
        await delay(150);
        assert.strictEqual(await page.evaluate(() => (document.scrollingElement as HTMLElement).scrollTop), before, 'the scroll given back');
        assert.strictEqual(await caretText(page), 'Item number 1 of the long list', 'the caret did not move');
    });

    test('the menu\'s route opens the same field at the same place as the bar\'s part', async function () {
        this.timeout(20000);
        await b.show(FIELDS_DOC);
        await b.restAt('Send the batch', 2);
        await pressPart('outer');
        const bar = await field();
        await page.keyboard.press('Escape');
        await b.clickAt('Send the batch', 2);
        await b.openMenuByKeys('block-type');
        await page.click('.mep-menu[data-menu="block-type"] [data-action="block-type-outer-attributes"]');
        await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { visible: true, timeout: 2000 });
        await delay(200);
        const menu = { heading: await page.$eval(`${ROW_FIELD} .mep-object-label`, el => el.textContent), rect: await rectOf(page, ROW_FIELD) };
        assert.strictEqual(menu.heading, bar.heading);
        assert.ok(Math.abs(menu.rect.top - bar.rect.top) <= 1 && Math.abs(menu.rect.left - bar.rect.left) <= 1, `${JSON.stringify(menu.rect)} vs ${JSON.stringify(bar.rect)}`);
    });
});

/** Two parts with a literal each, a list carrying one alone, Quote › Bold, Admonition › Heading. */
export const REMOVE_DOC = [
    '- Queue the edit locally {.lead}',
    '- Send the batch',
    '',
    '{.steps}',
    '',
    'Between the lists.',
    '',
    '- only the list carries one',
    '- second',
    '',
    '{.plain}',
    '',
    '> A quoted line with **term**{.term} in it, and more after.',
    '> {.warning}',
    '',
    '!!! warning',
    '    ## Sync rules {#sync-rules}',
    '',
    '    Body text.',
    '',
    'The last paragraph.',
    '',
].join('\n');

/**
 * Remove on a two-part bar and the first focus (#8 step 7): Remove
 * attributes ▾ naming each part, current first, an inline part's saying
 * what stays; Remove attributes of List with one literal; an admonition's
 * one Remove ▾; the hint names the part; Alt+Enter lands on the verb acting
 * on the current part.
 */
suite('Editor breadcrumb: Remove and the first focus (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = breadcrumbPage(() => editor as EditorPage);
    const REMOVE = `${BAR} [data-verb="remove-attributes"]`;
    const MENU = `${BAR} .mep-object-menu`;

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
        await page.mouse.click(1270, 890);
    });

    const entries = () => page.$$eval(`${MENU} .mep-menu-item`, els => els.map(el => [
        el.querySelector('.mep-entry-label')?.textContent ?? '',
        el.querySelector('.mep-entry-code')?.textContent ?? null,
        el.querySelector('.mep-entry-syntax')?.textContent ?? null,
    ]));
    const openRemove = async (selector = REMOVE) => {
        await page.waitForSelector(selector, { visible: true, timeout: 2000 });
        await page.click(selector);
        await page.waitForSelector(MENU, { visible: true, timeout: 2000 });
    };

    test('both parts carry one: Remove attributes ▾ — List item, then List; the item\'s goes, the hint names it, the bar stays with the item bare', async function () {
        this.timeout(20000);
        await b.show(REMOVE_DOC);
        await b.restAt('Queue the edit', 2);
        const button = await page.$eval(REMOVE, el => ({ text: el.textContent, popup: el.getAttribute('aria-haspopup') }));
        assert.deepStrictEqual(button, { text: 'Remove attributes', popup: 'menu' });
        await openRemove();
        assert.deepStrictEqual(await entries(), [['List item', '{.lead}', null], ['List', '{.steps}', null]]);
        await page.click(`${MENU} [data-entry="remove-current"]`);
        await settle();
        assert.ok(!(await b.lastEdit())?.text.includes('{.lead}') && (await b.lastEdit())?.text.includes('{.steps}'), (await b.lastEdit())?.text);
        assert.strictEqual(await b.hint(), `List item attributes removed — ${UNDO}`);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        assert.strictEqual(await page.$eval(`${CRUMBS} [data-part="current"]`, el => el.classList.contains('mep-crumb-bare')), true, 'the item shows bare');
        assert.strictEqual(await page.$eval(REMOVE, el => el.textContent), 'Remove attributes of List');
    });

    test('one part carries one: Remove attributes of List', async function () {
        this.timeout(15000);
        await b.show(REMOVE_DOC);
        await b.restAt('only the list', 2);
        assert.strictEqual(await page.$eval(REMOVE, el => el.textContent), 'Remove attributes of List');
        await page.click(REMOVE);
        await settle();
        assert.ok(!(await b.lastEdit())?.text.includes('{.plain}'), (await b.lastEdit())?.text);
        assert.strictEqual(await b.hint(), `List attributes removed — ${UNDO}`);
    });

    test('Quote › Bold: "Bold {.term}" with "formatting stays", then "Quote {.warning}"', async function () {
        this.timeout(15000);
        await b.show(REMOVE_DOC);
        await b.restAt('term', 2);
        await openRemove();
        assert.deepStrictEqual(await entries(), [['Bold', '{.term}', 'formatting stays'], ['Quote', '{.warning}', null]]);
        await page.click(`${MENU} [data-entry="remove-current"]`);
        await settle();
        assert.ok((await b.lastEdit())?.text.includes('**term** in it'), (await b.lastEdit())?.text);
        assert.strictEqual(await b.hint(), `Bold attributes removed — ${UNDO}`);
    });

    test('Admonition › Heading: one Remove ▾ — the heading\'s attributes, a divider, the admonition with its content kept', async function () {
        this.timeout(15000);
        await b.show(REMOVE_DOC);
        await b.restAt('Sync rules', 2);
        await openRemove(`${BAR} [data-verb="remove-menu"]`);
        assert.deepStrictEqual(await entries(), [['Attributes of Heading', '{#sync-rules}', null], ['Admonition, keep content', null, null]]);
        assert.strictEqual(await page.$eval(`${MENU} [data-entry="remove-wrapper"]`, el => el.previousElementSibling?.classList.contains('mep-menu-separator')), true, 'a divider before it');
        await page.click(`${MENU} [data-entry="remove-wrapper"]`);
        await settle();
        const text = (await b.lastEdit())?.text ?? '';
        assert.ok(!text.includes('!!! warning') && text.includes('## Sync rules {#sync-rules}'), text);
    });

    test('Alt+Enter: the focus on Attributes… at a list item, on Attributes of Heading… in an admonition — never Type▾', async function () {
        this.timeout(15000);
        await b.show(REMOVE_DOC);
        await b.clickAt('Queue the edit', 2);
        await b.pressAlt('Enter');
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.verb), 'block-attributes');
        assert.strictEqual(await page.evaluate(() => document.activeElement?.textContent), 'Attributes…');
        await page.keyboard.press('Escape');
        await b.clickAt('Sync rules', 2);
        await b.pressAlt('Enter');
        assert.strictEqual(await page.evaluate(() => document.activeElement?.textContent), 'Attributes of Heading…');
    });

    test('the entries name the parts as they are: after the list\'s literal changed from the text side, Remove ▾ names the new one and removes exactly it', async function () {
        this.timeout(20000);
        await b.show(REMOVE_DOC);
        await b.restAt('Queue the edit', 2);
        await openRemove();
        assert.deepStrictEqual((await entries())[1], ['List', '{.steps}', null]);
        await page.keyboard.press('Escape');
        await b.show(REMOVE_DOC.replace('{.steps}', '{.other}'));
        await b.restAt('Queue the edit', 2);
        await openRemove();
        assert.deepStrictEqual((await entries())[1], ['List', '{.other}', null], 'never the stale {.steps}');
        await page.click(`${MENU} [data-entry="remove-outer"]`);
        await settle();
        const text = (await b.lastEdit())?.text ?? '';
        assert.ok(!text.includes('{.other}') && !text.includes('{.steps}') && text.includes('{.lead}'), text);
    });

    test('an entry picked after a resync changed its part: refused at Remove, nothing removed (the re-resolve path)', async function () {
        this.timeout(20000);
        await b.show(REMOVE_DOC);
        await b.restAt('Queue the edit', 2);
        await openRemove();
        const before = (await (editor as EditorPage).edits()).length;
        await b.resync(REMOVE_DOC.replace('{.steps}', '{.other}'));
        await page.waitForSelector(MENU, { visible: true, timeout: 2000 });
        // The open menu follows a resync (its entries name {.other} now, the test above): the change must come
        // between the press and the verb — the host's document dispatched from the press itself, before the entry sees it.
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, REMOVE_DOC.replace('{.steps}', '{.third}'), {}));
        await page.evaluate(m => {
            document.addEventListener('click', () => window.dispatchEvent(new MessageEvent('message', { data: m })), { capture: true, once: true });
        }, { type: 'document', json, version: 9999, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE } as unknown as Record<string, unknown>);
        await page.click(`${MENU} [data-entry="remove-outer"]`);
        await settle();
        assert.match(await b.hint(), /^Not removed: the list's attributes changed meanwhile/);
        const rect = await page.$eval('.mep-hint', el => (el as HTMLElement).dataset.at ?? '');
        assert.strictEqual(rect, 'control', 'at the Remove control');
        const edits = await (editor as EditorPage).edits();
        assert.strictEqual(edits.length, before, 'nothing written');
    });

    test('a list inside a quote carrying one: Quote {.q} › List item; Remove attributes of Quote', async function () {
        this.timeout(15000);
        await b.show('> Intro\n>\n> - Item alpha\n> - Item beta\n>\n> Outro\n> {.q}\n\nThe last paragraph.\n');
        await b.restAt('Item alpha', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        const parts = await page.$$eval(`${CRUMBS} .mep-crumb`, els => els.map(p => [(p as HTMLElement).dataset.part, p.querySelector('.mep-crumb-name')?.textContent, p.querySelector('.mep-crumb-code')?.textContent || null]));
        assert.deepStrictEqual(parts, [['outer', 'Quote', '{.q}'], ['current', 'List item', null]]);
        assert.strictEqual(await page.$eval(REMOVE, el => el.textContent), 'Remove attributes of Quote');
    });
});

/** Long literals, as the sketch's narrow frames (#8 narrow-light.png). */
export const NARROW_DOC = [
    '- Queue the edit locally {.lead data-step=1}',
    '- Send the batch',
    '',
    '{.steps .numbered data-flow=sync}',
    '',
    '> Conflicts are shown to the user.',
    '> {.warning}',
    '',
    '!!! warning',
    '    ## Sync rules {#sync-rules .anchored}',
    '',
    '    Body text.',
    '',
    'The last paragraph.',
    '',
].join('\n');

/** Where a bar's fit ladder stands (#8 section 4.6), read off its parts and verbs. */
async function ladder(page: puppeteer.Page) {
    return page.$eval(BAR, bar => {
        const outer = bar.querySelector('[data-part="outer"]') as HTMLElement | null;
        const current = bar.querySelector('[data-part="current"]') as HTMLElement | null;
        const verbs = Array.from(bar.querySelectorAll(':scope > button[data-verb]')) as HTMLElement[];
        const more = bar.querySelector(':scope > .mep-object-more') as HTMLElement | null;
        const names = Array.from(bar.querySelectorAll('.mep-crumb-name')) as HTMLElement[];
        const title = outer?.classList.contains('mep-crumb-title') ?? false;
        const code = current?.querySelector('.mep-crumb-code') as HTMLElement | null;
        return {
            // (1) outer literal cut, (2) hidden / title short, (3) current literal cut, (4) outer part into "…",
            // (5) verbs into "…", (6) current literal hidden, (7) a title part hidden (#8 review 1).
            steps: [
                outer?.classList.contains('mep-crumb-cut') ?? false,
                title ? (outer?.hidden || outer?.querySelector('.mep-crumb-name')?.textContent === 'Warning') : outer?.classList.contains('mep-crumb-bare') ?? false,
                current?.classList.contains('mep-crumb-cut') ?? false,
                !title && (outer?.hidden ?? false),
                verbs.some(v => v.hidden),
                current?.classList.contains('mep-crumb-bare') ?? false,
                title && (outer?.hidden ?? false),
            ],
            /** The current literal's width in characters of its font while shown (cut: six and the ellipsis), else null. */
            currentChars: (() => {
                if (code === null || code.offsetWidth === 0) {
                    return null;
                }
                const probe = document.createElement('span');
                probe.style.font = getComputedStyle(code).font;
                probe.style.position = 'absolute';
                probe.textContent = '0000000000';
                document.body.append(probe);
                const ch = probe.offsetWidth / 10;
                probe.remove();
                return Math.round((code.clientWidth / ch) * 10) / 10;
            })(),
            inside: bar.scrollWidth <= bar.clientWidth + 1 && (more === null || more.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5),
            more: more !== null,
            hiddenVerbs: verbs.filter(v => v.hidden).map(v => v.dataset.verb),
            shownLabels: verbs.filter(v => !v.hidden).map(v => v.textContent),
            namesCut: names.some(n => n.offsetParent !== null && n.scrollWidth > n.clientWidth + 1),
            currentName: current?.querySelector('.mep-crumb-name')?.textContent ?? null,
            right: bar.getBoundingClientRect().right,
            width: window.innerWidth,
        };
    });
}

/**
 * The fit at narrow widths (#8 step 8): the outer literal cut, then hidden,
 * then the outer part into the bar's "…" (first there), then the current
 * literal cut, then the verbs into "…" — in that order, at any width; the
 * verbs keep their nouns, no part's name is cut, Alt+Enter's verb never
 * leaves, the bar never passes the window.
 */
suite('Editor breadcrumb: the fit at narrow widths (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = breadcrumbPage(() => editor as EditorPage);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 520, height: 900, styles: ['markdown-extended.css'] });
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
        await page.setViewport({ width: 520, height: 900 });
        await page.mouse.click(510, 890);
    });

    for (const [what, needle, first] of [['List › List item', 'Queue the edit', 'block-attributes'], ['Admonition › Heading', 'Sync rules', 'block-attributes']] as const) {
        test(`${what}: each step in order from 900 px down to 340 px`, async function () {
            this.timeout(30000);
            await page.setViewport({ width: 900, height: 900 });
            await b.show(NARROW_DOC);
            await b.restAt(needle, 2);
            await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
            const seen: number[] = [];
            for (const width of [900, 760, 640, 560, 520, 470, 420, 380, 340]) {
                await page.setViewport({ width, height: 900 });
                await delay(250);
                const state = await ladder(page);
                // A title part never moves into "…" (step 4) — it is hidden last (step 7); a control part is never hidden (no step 7).
                const order = what === 'List › List item' ? state.steps.filter((_, k) => k !== 6) : state.steps.filter((_, k) => k !== 3);
                const reached = order.lastIndexOf(true) + 1;
                assert.ok(order.slice(0, reached).every(Boolean), `${width}: the steps in order: ${JSON.stringify(state.steps)}`);
                assert.ok(!state.namesCut, `${width}: no part's name is cut`);
                assert.ok(!state.hiddenVerbs.includes(first), `${width}: Alt+Enter's verb never leaves`);
                assert.ok(state.shownLabels.every(l => l !== 'Remove' || what === 'Admonition › Heading') && !state.shownLabels.includes('Edit…'), `${width}: verbs keep their nouns: ${JSON.stringify(state.shownLabels)}`);
                assert.ok(state.right <= state.width, `${width}: inside the window: ${state.right}`);
                assert.ok(state.inside, `${width}: nothing past the bar's edge, its "…" inside it`);
                assert.ok(state.currentChars === null || state.currentChars >= 6.9, `${width}: a cut current literal shows six characters: ${state.currentChars}`);
                if (what === 'Admonition › Heading') {
                    assert.strictEqual(state.steps[3], false, `${width}: a title part never moves`);
                }
                seen.push(reached);
            }
            assert.ok(seen.every((s, k) => k === 0 || s >= seen[k - 1]), `narrower never undoes a step: ${JSON.stringify(seen)}`);
            assert.ok(seen[seen.length - 1] >= 2, `at 340 px the ladder is well down: ${JSON.stringify(seen)}`);
        });
    }

    test('fail-first: a user stylesheet\'s margin lane narrows the column — the field keeps a hint\'s width, min(44ch, window − 32 px), inside the window', async function () {
        // Before, the field took the room up to the lane (petrol at 520 px: 150 px, its keys line wrapped in three).
        this.timeout(20000);
        await b.show(NARROW_DOC);
        const style = await page.addStyleTag({ content: ':root { padding-right: 300px !important; --md-page-gutter: 0px; }' });
        try {
            await delay(200);
            await b.restAt('Queue the edit', 2);
            await page.waitForSelector(`${CRUMBS} [data-part="current"]`, { visible: true, timeout: 2000 });
            await page.click(`${CRUMBS} [data-part="current"]`);
            await page.waitForSelector(`${BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
            await delay(200);
            const r = await page.$eval('.mep-object-toolbar:has(.mep-inline-field)', el => {
                const box = el.getBoundingClientRect();
                const ch = parseFloat(getComputedStyle(el).fontSize) * 0.55;
                return { width: box.width, right: box.right, left: box.left, floor: Math.min(44 * ch, document.documentElement.clientWidth - 32), window: document.documentElement.clientWidth };
            });
            assert.ok(r.width >= r.floor - 1, JSON.stringify(r));
            assert.ok(r.right <= r.window - 16 + 0.5 && r.left >= 16 - 0.5, JSON.stringify(r));
        } finally {
            await page.keyboard.press('Escape');
            await style.evaluate(el => el.remove());
        }
    });

    test('narrow, the outer part moved into "…" is its first entry: "Attributes of List… {.steps …}", opening the List\'s field', async function () {
        this.timeout(20000);
        await page.setViewport({ width: 420, height: 900 });
        await b.show(NARROW_DOC);
        await b.restAt('Queue the edit', 2);
        await page.waitForSelector(CRUMBS, { visible: true, timeout: 2000 });
        await delay(250);
        const state = await ladder(page);
        assert.ok(state.steps[2], `the outer part moved: ${JSON.stringify(state.steps)}`);
        await page.click(`${BAR} .mep-object-more`);
        await page.waitForSelector(`${BAR} .mep-object-menu`, { visible: true, timeout: 2000 });
        const first = await page.$eval(`${BAR} .mep-object-menu .mep-menu-item`, el => [el.querySelector('.mep-entry-label')?.textContent, el.querySelector('.mep-entry-code')?.textContent]);
        assert.deepStrictEqual(first, ['Attributes of List…', '{.steps .numbered data-flow=sync}']);
        const name = await page.$eval(`${BAR} .mep-object-more`, el => el.getAttribute('aria-label') ?? '');
        assert.ok(name.startsWith('More actions: Attributes of List…'), name);
        await page.click(`${BAR} .mep-object-menu .mep-menu-item`);
        await page.waitForSelector(`${BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-label`, el => el.textContent), 'List · Attributes');
    });
});

const RESYNC_DOC = 'An intro paragraph.\n\n- Queue the edit locally\n- Send the batch\n\nThe last paragraph.\n';

/**
 * An open field and a host resync (#8 step 9, F7 — the wave-2 follow-up):
 * a change made elsewhere above the field's block keeps the field open with
 * what was typed, and Enter writes to the same block — on the outer part's
 * route, the current part's and the Formatting menu's; a resync that deletes
 * the block closes the field and writes nothing.
 */
suite('Editor breadcrumb: an open field through a host resync (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = breadcrumbPage(() => editor as EditorPage);
    const FIELD = '.mep-object-toolbar .mep-inline-field';

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
        await page.mouse.click(1270, 890);
    });

    const open = async (route: 'outer' | 'current' | 'formatting') => {
        await b.show(RESYNC_DOC);
        if (route === 'formatting') {
            await b.clickAt('Queue the edit', 2);
            await b.openMenuByKeys('formatting');
            await page.click('.mep-menu[data-menu="formatting"] [data-action="block-attributes"]');
        } else {
            await b.clickAt('Queue the edit', 2);
            await b.pressAlt('Enter');
            await page.click(`${CRUMBS} [data-part="${route}"]`);
        }
        await page.waitForSelector(FIELD, { visible: true, timeout: 2000 });
        await delay(100);
    };

    for (const [route, heading, typed, written] of [
        ['outer', 'List · Attributes', '.abc', '- Send the batch\n{.abc}\n'],
        ['current', 'List item · Attributes', '.def', '- Queue the edit locally {.def}\n'],
        ['formatting', 'List item · Attributes', '.ghi', '- Queue the edit locally {.ghi}\n'],
    ] as const) {
        test(`fail-first, ${route} route: a paragraph inserted above by the host keeps "${heading}" open with what was typed; Enter writes to the same block`, async function () {
            // Before #8 step 9 the resync closed the field and what was typed was lost (PLAN.md follow-up, attributes-field review 3).
            this.timeout(20000);
            await open(route);
            assert.strictEqual(await page.$eval('.mep-object-toolbar:has(.mep-inline-field) .mep-object-label', el => el.textContent), heading);
            await page.keyboard.type(typed);
            await b.resync(`Inserted at the top by another writer.\n\n${RESYNC_DOC}`);
            assert.ok(await page.$(FIELD), 'the field is still open');
            assert.strictEqual(await page.$eval(FIELD, el => (el as HTMLInputElement).value), typed);
            assert.ok(await page.evaluate(sel => document.activeElement === document.querySelector(sel), FIELD), 'and has the focus');
            await page.keyboard.press('Enter');
            await settle();
            const text = (await b.lastEdit())?.text ?? '';
            assert.ok(text.startsWith('Inserted at the top') && text.includes(written), text);
        });
    }

    test('a resync that deletes the list closes its field and writes nothing', async function () {
        this.timeout(20000);
        await open('outer');
        await page.keyboard.type('.zzz');
        const before = (await (editor as EditorPage).edits()).length;
        await b.resync('An intro paragraph.\n\nThe last paragraph.\n');
        await delay(150);
        assert.strictEqual(await page.$(FIELD), null, 'the field is gone');
        await page.keyboard.press('Enter');
        await settle();
        const after = await (editor as EditorPage).edits();
        assert.ok(after.slice(before).every(e => !e.text.includes('.zzz')), 'nothing written');
    });

    /** The field of `needle`'s block opened by `route`, `typed` typed into it. */
    const openOn = async (text: string, needle: string, route: 'outer' | 'formatting' | 'block-type', typed: string) => {
        await b.show(text);
        await b.clickAt(needle, 1);
        if (route === 'block-type') {
            await b.openMenuByKeys('block-type');
            await page.click('.mep-menu[data-menu="block-type"] [data-action="block-type-attributes"]');
        } else if (route === 'formatting') {
            await b.openMenuByKeys('formatting');
            await page.click('.mep-menu[data-menu="formatting"] [data-action="block-attributes"]');
        } else {
            await b.pressAlt('Enter');
            await page.click(`${CRUMBS} [data-part="outer"]`);
        }
        await page.waitForSelector(FIELD, { visible: true, timeout: 2000 });
        await delay(100);
        await page.keyboard.type(typed);
    };

    for (const [what, text, needle, route, after] of [
        ['a paragraph', 'Alpha {.a}\n\nBeta\n\nGamma\n\nThe last paragraph.\n', 'Alpha', 'formatting', 'Beta\n\nGamma\n\nThe last paragraph.\n'],
        ['a paragraph (Block type)', 'Alpha {.a}\n\nBeta\n\nGamma\n\nThe last paragraph.\n', 'Alpha', 'block-type', 'Beta\n\nGamma\n\nThe last paragraph.\n'],
        ['a paragraph before one with a literal', 'Alpha {.a}\n\nBeta {.b}\n\nGamma\n\nThe last paragraph.\n', 'Alpha', 'formatting', 'Beta {.b}\n\nGamma\n\nThe last paragraph.\n'],
        ['a list', '- one\n- two\n\n{.steps}\n\n* three\n* four\n\nThe last paragraph.\n', 'one', 'outer', '* three\n* four\n\nThe last paragraph.\n'],
        ['a list before one with a literal', '- one\n- two\n\n{.steps}\n\n* three\n* four\n\n{.next}\n\nThe last paragraph.\n', 'one', 'outer', '* three\n* four\n\n{.next}\n\nThe last paragraph.\n'],
    ] as const) {
        test(`fail-first: ${what} deleted elsewhere while its field is open closes the field with a hint; the next block of its kind is never written`, async function () {
            // Before the fix the field followed onto the next block of the same kind, and Enter gave it the typed literal.
            this.timeout(20000);
            await openOn(text, needle, route, '.typed');
            const before = (await (editor as EditorPage).edits()).length;
            await b.resync(after);
            await delay(150);
            assert.strictEqual(await page.$(FIELD), null, 'the field is gone');
            assert.match(await b.hint(), /changed or removed elsewhere/);
            await page.keyboard.press('Enter');
            await settle();
            const edits = await (editor as EditorPage).edits();
            assert.ok(edits.slice(before).every(e => !e.text.includes('.typed')), 'nothing written');
        });
    }

    test('fail-first: the list\'s literal changed elsewhere while its field is open — Enter refuses in the field, what was typed kept, nothing written', async function () {
        // Before the fix Enter overwrote the other writer's {.other} with the typed literal.
        this.timeout(20000);
        await openOn('- one\n- two\n\n{.steps}\n\nThe last paragraph.\n', 'one', 'outer', '.mine');
        const before = (await (editor as EditorPage).edits()).length;
        await b.resync('- one\n- two\n\n{.other}\n\nThe last paragraph.\n');
        assert.ok(await page.$(FIELD), 'the field is still open');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok(await page.$(FIELD), 'the field stays open');
        assert.strictEqual(await page.$eval(FIELD, el => (el as HTMLInputElement).value), '.mine');
        const refusal = await page.$eval('.mep-object-toolbar .mep-field-refusal-text', el => el.textContent ?? '').catch(() => '');
        assert.match(refusal, /This list changed meanwhile/);
        const edits = await (editor as EditorPage).edits();
        assert.ok(edits.slice(before).every(e => !e.text.includes('.mine')), 'nothing written');
    });
});

/**
 * What a key costs in a long list (#8 step 10): the breadcrumb's resolver is
 * O(depth), once per state (`crumbsAt`), and no fit runs while typing — so
 * typing in the first item of a 1000-item list with a literal costs, key for
 * key from keydown to the next painted frame, no more than 1.15× typing in the
 * same list where the engine reads no `{…}` (no breadcrumb, no part entries,
 * no list literal). Typing in 1000 paragraphs is measured beside it: a list
 * item's key costs more than a paragraph's before #8 already (the changed
 * top-level block, the whole list, is written again; 1.34× at 818b1d1).
 */
suite('Editor breadcrumb: the cost of a key (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = breadcrumbPage(() => editor as EditorPage);

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

    /** The mean time from each of 50 keydowns in `needle`'s block to the frame painted after it, in ms. */
    const perKey = async (text: string, needle: string, inline = DEFAULT_INLINE_ENGINE): Promise<number> => {
        await b.show(text, 'last paragraph', inline);
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

    test('typing in a 1000-item list with a literal costs no more than 1.15× the same list where no {…} is read', async function () {
        this.timeout(240000);
        const items = Array.from({ length: 1000 }, (_, k) => `- Item ${k + 1} of the list`).join('\n');
        const list = `${items}\n\n{.steps}\n\nThe last paragraph.\n`;
        const plain = `${items}\n\nThe last paragraph.\n`;
        const paragraphs = `${Array.from({ length: 1000 }, (_, k) => `Paragraph ${k + 1} of the document.`).join('\n\n')}\n\nThe last paragraph.\n`;
        const off = { ...DEFAULT_INLINE_ENGINE, attrs: false };
        // Twice each, interleaved: the better run of each, so a busy moment of the machine is not the editor's.
        const runs = { list: [] as number[], off: [] as number[], paragraphs: [] as number[] };
        for (let k = 0; k < 2; k++) {
            runs.off.push(await perKey(plain, 'Item 1 of', off));
            runs.list.push(await perKey(list, 'Item 1 of'));
            runs.paragraphs.push(await perKey(paragraphs, 'Paragraph 1 of'));
        }
        const best = (xs: number[]) => Math.min(...xs);
        const ratio = best(runs.list) / best(runs.off);
        console.log(`#8 cost per key (ms, best of 2): list ${best(runs.list).toFixed(2)}, list with no {…} read ${best(runs.off).toFixed(2)}, 1000 paragraphs ${best(runs.paragraphs).toFixed(2)}; `
            + `list/no-{…} ${ratio.toFixed(3)}, list/paragraphs ${(best(runs.list) / best(runs.paragraphs)).toFixed(3)}`);
        assert.ok(ratio <= 1.15, `per key in the list ${best(runs.list).toFixed(2)} ms vs ${best(runs.off).toFixed(2)} ms with no {…} read: ${ratio.toFixed(3)}×`);
    });
});
