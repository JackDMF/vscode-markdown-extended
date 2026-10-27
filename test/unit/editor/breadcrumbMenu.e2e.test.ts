import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { EditorPage, closeEditorPage, delay, openEditorPage, settle } from './pageHarness';
import { ROW_FIELD, blockRect, breadcrumbPage, rectOf } from './breadcrumbPage';

const LIST_DOC = [
    'A paragraph above the list.',
    '',
    '- Queue the edit locally',
    '- Send the batch',
    '- Confirm the sync',
    '',
    'The last paragraph.',
    '',
].join('\n');

const MENU = '.mep-menu[data-menu="block-type"]';
const CURRENT = `${MENU} [data-action="block-type-attributes"]`;
const OUTER = `${MENU} [data-action="block-type-outer-attributes"]`;

/**
 * The Block type menu's two attribute entries (#8 step 4): at a list item
 * "Attributes of List item…" and "Attributes of List…", each with its own
 * card; the List's field opens under the list and writes `{.x}` there.
 */
suite('Editor breadcrumb: the Block type menu (e2e)', () => {
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

    test('at a list item: both entries, the List\'s card, its field under the list; Enter writes {.x} under it, undo takes it back', async function () {
        this.timeout(20000);
        await b.show(LIST_DOC);
        await b.clickAt('Queue the edit', 2);
        await b.openMenuByKeys('block-type');
        const labels = await page.$$eval(`${MENU} .mep-menu-item:not([hidden]) .mep-entry-label`, els => els.map(e => e.textContent));
        const at = labels.indexOf('Attributes of List item…');
        assert.ok(at >= 0 && labels[at + 1] === 'Attributes of List…', JSON.stringify(labels));
        assert.deepStrictEqual(await page.$eval(CURRENT, el => el.querySelector('.mep-entry-syntax')?.textContent), '- text {.class}');
        assert.deepStrictEqual(await page.$eval(OUTER, el => el.querySelector('.mep-entry-syntax')?.textContent), '{.class} under it');

        // ↓ to the List's entry: its card shows the list with its literal on a line under it.
        for (let k = 0; k < 20 && !(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action === 'block-type-outer-attributes')); k++) {
            await page.keyboard.press('ArrowDown');
            await delay(40);
        }
        await page.waitForSelector('.mep-preview-card[data-action="block-type-outer-attributes"]:not([hidden])', { timeout: 2000 });
        const card = await page.$eval('.mep-preview-card .mep-preview-syntax', el => el.textContent ?? '');
        assert.ok(card.split('\n').includes('{.steps}'), card);
        assert.ok(await page.$('.mep-preview-card ul.steps'), 'drawn as the list with the class');

        await page.keyboard.press('Enter');
        await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { visible: true });
        assert.strictEqual(await page.$eval(`${ROW_FIELD} .mep-object-label`, el => el.textContent), 'List · Attributes');
        const field = await rectOf(page, ROW_FIELD);
        const list = await blockRect(page, 'Confirm the sync', 'ul');
        // A block's field stands above the block (Daniel, 2026-10-27).
        assert.ok(field.bottom <= list.top + 1, `above the list: field ${JSON.stringify(field)}, list ${JSON.stringify(list)}`);

        await page.keyboard.type('.x');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await b.lastEdit())?.text.includes('- Confirm the sync\n{.x}\n'), (await b.lastEdit())?.text);
        assert.ok(await page.$('.ProseMirror ul.x'), 'the page draws the class');
        await b.undo();
        await settle();
        assert.ok(!(await b.lastEdit())?.text.includes('{.x}'), (await b.lastEdit())?.text);
    });

    test('in a plain paragraph the List\'s entry is not drawn; in a list inside a quote it is, refused with why', async function () {
        this.timeout(15000);
        await b.show('A paragraph above the list.\n\nAnother paragraph.\n\n> - quoted item\n> - another\n\nThe last paragraph.\n');
        await b.clickAt('A paragraph above', 3);
        await b.openMenuByKeys('block-type');
        assert.strictEqual(await page.$eval(OUTER, el => (el as HTMLElement).hidden), true);
        await page.keyboard.press('Escape');
        await b.clickAt('quoted item', 3);
        await b.openMenuByKeys('block-type');
        const outer = await page.$eval(OUTER, el => ({ hidden: (el as HTMLElement).hidden, disabled: el.getAttribute('aria-disabled'), label: el.querySelector('.mep-entry-label')?.textContent }));
        assert.deepStrictEqual(outer, { hidden: false, disabled: 'true', label: 'Attributes of List…' });
    });
});
