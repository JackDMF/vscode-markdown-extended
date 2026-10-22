import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { EditorPage, closeEditorPage, delay, openEditorPage } from './pageHarness';
import { BAR, CRUMBS, breadcrumbPage } from './breadcrumbPage';

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
