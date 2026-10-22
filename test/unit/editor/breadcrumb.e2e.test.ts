import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { EditorPage, UNDO, closeEditorPage, delay, openEditorPage, settle } from './pageHarness';
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
        return {
            steps: [
                outer?.classList.contains('mep-crumb-cut') ?? false,
                outer?.classList.contains('mep-crumb-title') ? outer.querySelector('.mep-crumb-name')?.textContent === 'Warning' : outer?.classList.contains('mep-crumb-bare') ?? false,
                outer?.hidden ?? false,
                current?.classList.contains('mep-crumb-cut') ?? false,
                verbs.some(v => v.hidden),
            ],
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
                // A title part has no step 3: it never moves.
                const order = what === 'List › List item' ? state.steps : state.steps.filter((_, k) => k !== 2);
                const reached = order.lastIndexOf(true) + 1;
                assert.ok(order.slice(0, reached).every(Boolean), `${width}: the steps in order: ${JSON.stringify(state.steps)}`);
                assert.ok(!state.namesCut, `${width}: no part's name is cut`);
                assert.ok(!state.hiddenVerbs.includes(first), `${width}: Alt+Enter's verb never leaves`);
                assert.ok(state.shownLabels.every(l => l !== 'Remove' || what === 'Admonition › Heading') && !state.shownLabels.includes('Edit…'), `${width}: verbs keep their nouns: ${JSON.stringify(state.shownLabels)}`);
                assert.ok(state.right <= state.width, `${width}: inside the window: ${state.right}`);
                if (what === 'Admonition › Heading') {
                    assert.strictEqual(state.steps[2], false, `${width}: a title part never moves`);
                }
                seen.push(reached);
            }
            assert.ok(seen.every((s, k) => k === 0 || s >= seen[k - 1]), `narrower never undoes a step: ${JSON.stringify(seen)}`);
            assert.ok(seen[seen.length - 1] >= 2, `at 340 px the ladder is well down: ${JSON.stringify(seen)}`);
        });
    }

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
