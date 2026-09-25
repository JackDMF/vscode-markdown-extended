import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { LensRow } from '../../../src/editor/protocol';
import { EXTENSION_ID, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const SOURCE = 'Intro.\n\n# Heading\n\nA paragraph.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';

/** Rows for SOURCE's blocks: 0 Intro, 1 the heading, 2 the paragraph, 3 the table. */
const ROWS: LensRow[] = [
    { blockIndex: 1, items: [{ id: '1.0', title: '$(check) Heading lens', tooltip: 'Runs the heading lens' }, { id: '1.1', title: 'Second' }] },
    { blockIndex: 3, items: [{ id: '1.2', title: 'Table lens' }, { title: 'Text only' }] },
];

/**
 * Other extensions' lens rows in the real page: drawn above the blocks the
 * host named, clickable and reachable with the keyboard, following their block
 * through a local edit until the next refresh replaces them, and never under
 * the object toolbar.
 */
suite('Editor lens rows (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const send = (rows: LensRow[], blocks = 4, forVersion = version) =>
        (editor as EditorPage).send({ type: 'lenses', version: forVersion, blocks, rows });

    /** Each row, with the text of the block element right after it. */
    const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('.ProseMirror > .mep-lens-row'), row => ({
        items: Array.from(row.querySelectorAll('.mep-lens, .mep-lens-text'), el => ({
            text: el.textContent,
            lens: (el as HTMLElement).dataset.lens ?? null,
            button: el.tagName === 'BUTTON',
        })),
        text: row.textContent,
        before: (row.nextElementSibling?.textContent ?? '').trim().split('\n')[0],
        editable: (row as HTMLElement).contentEditable,
    })));

    const runLensPosts = async () => (await (editor as EditorPage).posted()).filter(m => m.type === 'runLens');

    const showDocument = async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, SOURCE, {})), version, defaultWrap: 90 });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Intro.'));
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1000 });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument();
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    test('rows render above the blocks the host named, as text-editor lenses: titles, bars, a text-only lens', async () => {
        await send(ROWS);
        await page.waitForSelector('.mep-lens-row');
        assert.deepStrictEqual(await rows(), [
            {
                items: [
                    // The codicon is drawn as a character; the page has no icon font.
                    { text: '✓ Heading lens', lens: '1.0', button: true },
                    { text: 'Second', lens: '1.1', button: true },
                ],
                text: '✓ Heading lens | Second',
                before: 'Heading',
                editable: 'false',
            },
            {
                items: [{ text: 'Table lens', lens: '1.2', button: true }, { text: 'Text only', lens: null, button: false }],
                text: 'Table lens | Text only',
                before: 'a',
                editable: 'false',
            },
        ]);
        const title = await page.$eval('[data-lens="1.0"]', el => (el as HTMLElement).title);
        assert.strictEqual(title, 'Runs the heading lens');
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'a row is not content: nothing was written');
    });

    test('a click posts runLens with the lens\'s id, and moves no caret', async () => {
        const button = await page.$('[data-lens="1.1"]');
        const box = await button?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
        assert.deepStrictEqual(await runLensPosts(), [{ type: 'runLens', id: '1.1' }]);
    });

    test('a lens is reachable with Tab and runs with Enter', async () => {
        await page.focus('.ProseMirror');
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.lens ?? null);
        assert.strictEqual(focused, '1.0', 'Tab from the text lands on the first lens');
        await page.keyboard.press('Enter');
        await delay(80);
        assert.deepStrictEqual((await runLensPosts()).map(m => (m as { id: string }).id), ['1.1', '1.0']);
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'Enter on a lens is not typed into the document');
    });

    test('a local edit before the next refresh keeps each row on its block', async function () {
        this.timeout(10000);
        // A new paragraph after "Intro.": every block after it moves one index on.
        const intro = await page.evaluateHandle(() => document.querySelector('.ProseMirror p') as HTMLElement);
        const box = await intro.asElement()?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Inserted.');
        await settle();
        const after = await rows();
        assert.deepStrictEqual(after.map(r => r.before), ['Heading', 'a'], 'the rows followed their blocks, not their indices');
        const edits = await (editor as EditorPage).edits();
        assert.ok(edits.length > 0 && edits[edits.length - 1].text.includes('Intro.\n\nInserted.\n\n# Heading'), JSON.stringify(edits.pop()?.text));
    });

    test('rows for a block count the page no longer holds are not taken; a refresh for the page\'s text replaces them all', async () => {
        await send([{ blockIndex: 0, items: [{ id: '2.0', title: 'Stale' }] }], 4);
        await delay(80);
        assert.deepStrictEqual((await rows()).map(r => r.text), ['✓ Heading lens | Second', 'Table lens | Text only'], 'four blocks were parsed; the page holds five');

        // The refresh after the edit: the host's parse of the page's text, five blocks.
        await send([{ blockIndex: 1, items: [{ id: '3.0', title: 'New on inserted' }] }, { blockIndex: 2, items: [{ id: '3.1', title: 'New on heading' }] }], 5);
        await delay(80);
        assert.deepStrictEqual((await rows()).map(r => [r.text, r.before]), [['New on inserted', 'Inserted.'], ['New on heading', 'Heading']]);

        await send([], 0);
        await delay(80);
        assert.deepStrictEqual(await rows(), [], 'empty rows clear');
    });

    test('rows for a document older than the one shown are dropped', async () => {
        await showDocument();
        await send(ROWS, 4, version - 1);
        await delay(80);
        assert.deepStrictEqual(await rows(), []);
    });

    test('the object toolbar of a block with a row sits above the row, not over it', async function () {
        this.timeout(10000);
        await send(ROWS);
        await page.waitForSelector('.mep-lens-row');
        const table = await page.$('.ProseMirror > .mep-raw-block');
        const box = await table?.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        const bar = await page.waitForSelector('.mep-object-toolbar[data-trigger="hover"]:not([hidden])', { visible: true, timeout: 2000 });
        const barBox = await bar?.boundingBox();
        const rowBox = await page.$eval('.ProseMirror > .mep-raw-block', el => {
            const r = (el.previousElementSibling as HTMLElement).getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
        });
        assert.ok(barBox);
        assert.ok(barBox.y + barBox.height <= rowBox.top || barBox.y >= rowBox.bottom,
            `the bar ${JSON.stringify(barBox)} overlaps the row ${JSON.stringify(rowBox)}`);
        assert.ok(barBox.y + barBox.height <= rowBox.top, 'with room above, the bar is above the row');

        // Crossing the row on the way up to the bar keeps the bar.
        await page.mouse.move(box.x + box.width / 2, rowBox.top + 2);
        await delay(400);
        assert.ok(await page.$('.mep-object-toolbar[data-trigger="hover"]:not([hidden])'), 'the row is the block\'s, for the pointer');
    });
});
