import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { clickText, closeEditorPage, delay, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, pointAt, settle, shot, showDiagnostics, MOD, SHOTS_DIR, editCommand } from './pageHarness';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { LOCK_BUTTON, LOCK_PROPERTY, LOCK_SOURCE, RowBoxes, assertReasonShown, assertRowFree, assertRowLocked, rowBoxes } from './rowLock';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** A Req Explorer workshop note's front matter, as that corpus writes one, shortened. */
const FRONT = [
    '---',
    'workshop: 2026-09-29-workshop-visual-editor-next-round',
    'uid: cc43a136-8c9f-4869-bbf1-ca74829d615e',
    'date: 2026-09-29',
    'stream: UXD  # the stream the gaps go to',
    'lang: en',
    'draft: true',
    'attendees: [Daniel]',
    'sections:',
    '  - heading: A change\'s stage is a row of its summary',
    '    anchor: stage-is-a-row',
    '    uid: dff80268-0b51-432c-ba62-bbf996453aae',
    '    lang: de',
    '    edges:',
    '      - { type: proposes-new, to: NEU-UXD-009, note: \'a note, with a comma\' }',
    '  - heading: The active document is the tab',
    '    anchor: active-document-is-the-tab',
    '---',
    '',
].join('\n');
const SOURCE = `${FRONT}\n# Workshop: the Visual Editor's next round\n\nThe plan agreed on 2026-09-25 is built.\n`;

/** A table first after the front matter — where Esc out of the panel puts the caret — then words, and a source block. */
const BOXES = [
    '---',
    'title: Demo',
    'stream: UXD',
    '---',
    '',
    '| Kind | Count |',
    '| ---- | ----: |',
    '| first | 1 |',
    '| second | 2 |',
    '',
    'After the table, some words to select.',
    '',
    '| Region | Q1 | Q2 |',
    '| ------ | -- | -- |',
    '| North  | 1  | 2  |',
    '| ^^     | 3  | 4  |',
    '[Figures by region]',
    '',
    'Last paragraph.',
    '',
].join('\n');

const SELECTION_BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const HOVER_BAR = '.mep-object-toolbar[data-trigger="hover"]:not([hidden])';

/** The lines of `after` that differ from `before`'s, as `[before, after]`, when both have as many lines. */
function changedLines(before: string, after: string): [string, string][] {
    const a = before.split('\n');
    const b = after.split('\n');
    assert.strictEqual(b.length, a.length, `as many lines:\n${after}`);
    return a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]] as [string, string]]));
}

/**
 * The front matter as a properties panel in the real page, with the real
 * keyboard and mouse: collapsed by default with its count, the rows typed from
 * their values, each edit posted as the document with that line changed and no
 * other, the source box opened at a nested key, a property added and removed.
 */
suite('Editor properties panel (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();
    const editCount = async () => (await (editor as EditorPage).edits()).length;

    /** Post `text` parsed, as the host does, the panel's remembered state cleared first unless `keep`. */
    const showDocument = async (text: string, keep = false) => {
        if (!keep) {
            await page.evaluate(() => {
                try {
                    window.localStorage.clear();
                } catch {
                    // No storage on this origin: the panel opens collapsed anyway.
                }
            });
        }
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        // A fresh page state: a panel kept from the last document keeps its open state, so the test starts from a document without one.
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, 'Reset.\n', {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(() => document.querySelector('.mep-properties') === null);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('Reset.'));
        await page.mouse.move(2, 2);
        // The source box scrolls its key into view; the next test starts at the top.
        await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
        });
        await delay(50);
    };

    const centre = async (selector: string): Promise<{ x: number; y: number }> => {
        const box = await (await page.waitForSelector(selector, { visible: true }))?.boundingBox();
        assert.ok(box, `no box for ${selector}`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    const clickAt = async (selector: string) => {
        const { x, y } = await centre(selector);
        await page.mouse.click(x, y);
        await delay(80);
    };

    const expand = async () => {
        await clickAt('.mep-properties .mep-props-toggle');
        await page.waitForSelector('.mep-prop-row', { visible: true });
    };

    const row = (key: string) => `.mep-prop-row[data-key="${key}"]`;

    const selectAllAndType = async (text: string) => {
        await page.keyboard.down(MOD);
        await page.keyboard.press('a', editCommand('a'));
        await page.keyboard.up(MOD);
        await page.keyboard.type(text);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        // Without the built-in Markdown extension's stylesheets: the webview's defaults alone
        // leave the body's top at 0, so the page's own top room is all that keeps the panel's
        // header clear of the row and its lock line — what a disabled extension, or a
        // stylesheet setting `body { padding-top: 0 }`, leaves.
        editor = await openEditorPage({ width: 1280, height: 800, builtinMarkdown: false });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument(SOURCE);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('collapsed by default, with the count of its keys; no panel for a document without front matter', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        const header = await page.$eval('.mep-properties', el => ({
            toggle: el.querySelector('.mep-props-toggle')?.textContent,
            expanded: el.querySelector('.mep-props-toggle')?.getAttribute('aria-expanded'),
            rows: el.querySelectorAll('.mep-prop-row').length,
            source: el.querySelector('.mep-props-source')?.textContent,
        }));
        assert.deepStrictEqual(header, { toggle: '▸Properties8', expanded: 'false', rows: 0, source: 'Edit as source' });
        await showDocument('# No front matter\n');
        assert.strictEqual(await page.$('.mep-properties'), null);
    });

    test('expanded, each key is a row typed from its value: text, date, choice, checkbox, chips, a read-only uid, a nested row', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        const rows = await page.$$eval('.mep-prop-row[data-key]', els => els.map(el => [
            (el as HTMLElement).dataset.key,
            (el as HTMLElement).dataset.kind,
            (el.querySelector('input') as HTMLInputElement | null)?.type ?? null,
            el.querySelector('.mep-prop-value')?.textContent?.trim(),
        ]));
        assert.deepStrictEqual(rows, [
            ['workshop', 'text', 'text', '×'],
            ['uid', 'id', null, 'cc43a136-8c9f-4869-bbf1-ca74829d615e'],
            ['date', 'date', 'text', '×'],
            ['stream', 'text', 'text', '×'],
            ['lang', 'choice', 'text', '×'],
            ['draft', 'boolean', 'checkbox', '×'],
            ['attendees', 'list', null, 'Daniel×+ Add×'],
            ['sections', 'source', null, '2 items, nested · edit as source×'],
        ]);
        const values = await page.$$eval('.mep-prop-row .mep-prop-input', els => els.map(el => (el as HTMLInputElement).value));
        assert.deepStrictEqual(values.slice(0, 4), ['2026-09-29-workshop-visual-editor-next-round', '2026-09-29', 'UXD', 'en']);
        // The uid: mono, dimmed, no field, no border; and the one row without a ×.
        const uid = await page.$eval(`${row('uid')} .mep-prop-id`, el => ({
            font: getComputedStyle(el).fontFamily,
            border: getComputedStyle(el).borderTopStyle,
            removable: el.closest('.mep-prop-row')?.querySelector('.mep-prop-remove') !== null,
        }));
        assert.match(uid.font, /mono|consolas|courier/i);
        assert.strictEqual(uid.border, 'none');
        assert.strictEqual(uid.removable, false);
        // An editable value has a faint border at rest: it looks editable before the pointer finds it.
        const edge = await page.$eval(`${row('stream')} .mep-prop-input`, el => {
            const cs = getComputedStyle(el);
            return { style: cs.borderTopStyle, width: cs.borderTopWidth, color: cs.borderTopColor };
        });
        assert.deepStrictEqual([edge.style, edge.width], ['solid', '1px']);
        assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(edge.color), edge.color);
        // The × stands right after the value, not at the row's end.
        const gap = await page.$eval(row('stream'), el => {
            const input = (el.querySelector('.mep-prop-input') as HTMLElement).getBoundingClientRect();
            const remove = (el.querySelector('.mep-prop-remove') as HTMLElement).getBoundingClientRect();
            return remove.left - input.right;
        });
        assert.ok(gap >= 0 && gap < 16, `× ${gap}px after the value`);
        // Expanded is remembered for the document.
        assert.strictEqual(await page.evaluate(() => {
            try {
                return Object.entries(window.localStorage).some(([k, v]) => k.startsWith('markdownExtended.properties.expanded:') && v === '1');
            } catch {
                return true;
            }
        }), true);
        assert.deepStrictEqual(await (editor as EditorPage).edits(), [], 'showing and expanding wrote nothing');
    });

    test('a text value edited and committed with Enter changes that line only, its comment kept; the caret is none while the field has the focus', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('stream')} input`);
        await selectAllAndType('DOC');
        await delay(200);
        const carets = await (editor as EditorPage).posted();
        const caret = carets.filter(m => m.type === 'caret').pop();
        assert.ok(caret && caret.type === 'caret');
        assert.strictEqual(caret.position, null, 'a property\'s field is no place in the text');
        await page.keyboard.press('Enter');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.deepStrictEqual(changedLines(SOURCE, edit.text), [['stream: UXD  # the stream the gaps go to', 'stream: DOC  # the stream the gaps go to']]);
        // The field keeps the focus, showing what the file now holds.
        assert.deepStrictEqual(await page.evaluate(() => [(document.activeElement as HTMLInputElement).value, (document.activeElement as HTMLElement).dataset.slot]), ['DOC', 'value:3']);
    });

    test('Esc reverts a row; nothing is written', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        const before = await editCount();
        await clickAt(`${row('workshop')} input`);
        await selectAllAndType('something else');
        await page.keyboard.press('Escape');
        assert.strictEqual(await page.$eval(`${row('workshop')} input`, el => (el as HTMLInputElement).value), '2026-09-29-workshop-visual-editor-next-round');
        await page.keyboard.press('Tab');
        await settle();
        assert.strictEqual(await editCount(), before, 'the reverted value is not committed when the focus leaves');
    });

    test('Tab commits a row and moves to the next', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('stream')} input`);
        await selectAllAndType('ARC');
        await page.keyboard.press('Tab');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.deepStrictEqual(changedLines(SOURCE, edit.text), [['stream: UXD  # the stream the gaps go to', 'stream: ARC  # the stream the gaps go to']]);
        // The row's × is the next stop, named for its key; then the next row.
        assert.deepStrictEqual(await page.evaluate(() => [(document.activeElement as HTMLElement).dataset.slot, document.activeElement?.getAttribute('aria-label')]), ['remove:3', 'Remove stream']);
        await page.keyboard.press('Tab');
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.slot), 'value:4');
    });

    test('a date is its text as the file writes it: a calendar beside it, and a value that is no date refused with the reason', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        assert.ok(await page.$(`${row('date')} .mep-prop-date-pick`), 'the calendar button');
        const before = await editCount();
        await clickAt(`${row('date')} .mep-prop-input`);
        await selectAllAndType('2026-02-30');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual(await editCount(), before, 'no such day: nothing written');
        assert.strictEqual(await page.$eval('.mep-hint', el => el.textContent), 'A date is written YYYY-MM-DD — Esc keeps 2026-09-29');
        await selectAllAndType('2026-10-01');
        await page.keyboard.press('Enter');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.deepStrictEqual(changedLines(SOURCE, edit.text), [['date: 2026-09-29', 'date: 2026-10-01']]);
    });

    test('the checkbox writes the boolean in place', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('draft')} input`);
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.deepStrictEqual(changedLines(SOURCE, edit.text), [['draft: true', 'draft: false']]);
    });

    test('chips: + Add takes a value with Enter, × removes one with the hint, each in the list\'s flow style', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('attendees')} .mep-prop-chip-add`);
        await page.waitForSelector(`${row('attendees')} .mep-prop-chip-input`);
        await page.keyboard.type('Jack');
        await page.keyboard.press('Enter');
        await settle();
        let edit = await lastEdit();
        assert.ok(edit);
        assert.deepStrictEqual(changedLines(SOURCE, edit.text), [['attendees: [Daniel]', 'attendees: [Daniel, Jack]']]);
        // The field stays open for the next item.
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.slot), 'add-item:6');
        await page.keyboard.press('Escape');
        await page.mouse.move(...Object.values(await centre(`${row('attendees')} .mep-prop-chip`)) as [number, number]);
        await clickAt(`${row('attendees')} .mep-prop-chip .mep-prop-chip-remove`);
        await settle();
        edit = await lastEdit();
        assert.ok(edit);
        assert.deepStrictEqual(changedLines(SOURCE, edit.text), [['attendees: [Daniel]', 'attendees: [Jack]']]);
        assert.match(await page.$eval('.mep-hint', el => el.textContent ?? ''), /^Daniel removed — (Ctrl|Cmd)\+Z$/);
    });

    test('the uid is read-only: a click copies it, and nothing is written', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        const before = await editCount();
        assert.strictEqual(await page.$(`${row('uid')} input`), null);
        await clickAt(`${row('uid')} .mep-prop-id`);
        await settle();
        assert.strictEqual(await editCount(), before);
        assert.strictEqual(await page.$eval('.mep-hint', el => el.textContent), 'Copied uid');
    });

    test('the nested row opens the source box at its key; Esc closes it unchanged, Ctrl+Enter commits', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('sections')} .mep-prop-source-link`);
        await page.waitForSelector('.mep-properties .mep-props-editor');
        const area = await page.$eval('.mep-props-editor', el => {
            const a = el as HTMLTextAreaElement;
            return { focused: document.activeElement === a, at: a.value.slice(a.selectionStart, a.selectionStart + 9), value: a.value };
        });
        assert.strictEqual(area.focused, true);
        assert.strictEqual(area.at, 'sections:');
        // The YAML between the fences, as the file holds it.
        assert.strictEqual(area.value, FRONT.split('\n').slice(1, -2).join('\n'));
        await page.keyboard.press('Escape');
        assert.strictEqual(await page.$('.mep-props-editor'), null);
        assert.ok(await page.$(row('sections')), 'the rows are back');

        await clickAt(`${row('sections')} .mep-prop-source-link`);
        await page.waitForSelector('.mep-props-editor');
        await page.keyboard.press('End');
        await page.keyboard.type('\n  - heading: A third');
        await page.keyboard.down(MOD);
        await page.keyboard.press('Enter');
        await page.keyboard.up(MOD);
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.ok(edit.text.includes('\nsections:\n  - heading: A third\n  - heading: A change'), edit.text);
        assert.match(await page.$eval(`${row('sections')} .mep-prop-summary`, el => el.textContent ?? ''), /^3 items, nested/);
    });

    test('+ Add (a new property) asks for the name, then the value, and writes the key at the end of the YAML', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        assert.deepStrictEqual(await page.$eval('.mep-prop-add-button', el => [el.textContent, el.getAttribute('aria-label')]), ['+ Add', 'Add property'], 'the list\'s word, named for a screen reader');
        await clickAt('.mep-prop-add-button');
        await page.waitForSelector('.mep-prop-add input[data-slot="add:name"]');
        await page.keyboard.type('status');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.slot === 'add:value');
        await page.keyboard.type('open');
        await page.keyboard.press('Enter');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, SOURCE.replace('    anchor: active-document-is-the-tab\n---\n', '    anchor: active-document-is-the-tab\nstatus: open\n---\n'));
        assert.ok(await page.$(`${row('status')} input`));
        // A name already there is refused with the reason.
        await clickAt('.mep-prop-add-button');
        await page.keyboard.type('stream');
        await page.keyboard.press('Enter');
        assert.strictEqual(await page.$eval('.mep-hint', el => el.textContent), 'Already a property: stream');
        await page.keyboard.press('Escape');
        // A refusal reports no change of the document: one made elsewhere leaves it standing.
        await clickText(page, 'The plan agreed', 3);
        await page.keyboard.type('x');
        await delay(100);
        assert.deepStrictEqual(await page.$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden })), { text: 'Already a property: stream', shown: true });
    });

    test('× removes a row with its lines and says so; Ctrl+Z in the panel puts it back', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await page.mouse.move(...Object.values(await centre(`${row('lang')} .mep-prop-key`)) as [number, number]);
        await clickAt(`${row('lang')} .mep-prop-remove`);
        await settle();
        let edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, SOURCE.replace('lang: en\n', ''));
        assert.match(await page.$eval('.mep-hint', el => el.textContent ?? ''), /^lang removed — (Ctrl|Cmd)\+Z$/);
        assert.strictEqual(await page.$(row('lang')), null);
        // The focus is on the panel (its toggle, after the row went): the editor's undo.
        await page.focus('.mep-props-toggle');
        await page.keyboard.down(MOD);
        await page.keyboard.press('z');
        await page.keyboard.up(MOD);
        await settle();
        edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, SOURCE);
        assert.ok(await page.$(row('lang')));
        // The hint reports a change: the next change of the document takes it away.
        await page.mouse.move(...Object.values(await centre(`${row('lang')} .mep-prop-key`)) as [number, number]);
        await clickAt(`${row('lang')} .mep-prop-remove`);
        await delay(100);
        assert.strictEqual(await page.$eval('.mep-hint', el => (el as HTMLElement).hidden), false);
        await clickText(page, 'The plan agreed', 3);
        await page.keyboard.type('x');
        await delay(100);
        assert.strictEqual(await page.$eval('.mep-hint', el => (el as HTMLElement).hidden), true);
    });

    test('lang offers the file\'s values in the editor\'s completion list, opened on focus and narrowed as typed', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('lang')} .mep-prop-input`);
        const list = `${row('lang')} .mep-completions .mep-completion-label`;
        await page.waitForSelector(list);
        assert.deepStrictEqual(await page.$$eval(list, els => els.map(el => el.textContent)), ['en', 'de']);
        assert.strictEqual(await page.$(`${row('lang')} datalist`), null, 'one chrome: no native datalist');
        await selectAllAndType('d');
        await delay(50);
        assert.deepStrictEqual(await page.$$eval(list, els => els.map(el => el.textContent)), ['de']);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.deepStrictEqual(changedLines(SOURCE, edit.text), [['lang: en', 'lang: de']]);
        assert.strictEqual(await page.$(`${row('lang')} .mep-completions`), null, 'the list is gone once a value is set');
    });

    test('Shift+Delete on a row\'s control removes the row, with the hint', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('workshop')} .mep-prop-input`);
        await page.keyboard.down('Shift');
        await page.keyboard.press('Delete');
        await page.keyboard.up('Shift');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, SOURCE.replace('workshop: 2026-09-29-workshop-visual-editor-next-round\n', ''));
        assert.match(await page.$eval('.mep-hint', el => el.textContent ?? ''), /^workshop removed — (Ctrl|Cmd)\+Z$/);
    });

    test('typing in one row and then clicking another row\'s × commits the typing and removes that row', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('stream')} .mep-prop-input`);
        await selectAllAndType('DOC');
        await page.mouse.move(...Object.values(await centre(`${row('lang')} .mep-prop-key`)) as [number, number]);
        // As a person clicks: the button held for a moment, long enough for a blur's commit to redraw the rows.
        const { x, y } = await centre(`${row('lang')} .mep-prop-remove`);
        await page.mouse.click(x, y, { delay: 80 });
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, SOURCE.replace('stream: UXD', 'stream: DOC').replace('lang: en\n', ''));
    });

    test('each write is its own undo step: after two quick edits, Ctrl+Z undoes the last one only', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
        await clickAt(`${row('stream')} .mep-prop-input`);
        await selectAllAndType('DOC');
        await page.keyboard.press('Enter');
        await page.focus(`${row('lang')} .mep-prop-remove`);
        await page.keyboard.press('Enter');
        await delay(50);
        await page.focus('.mep-props-toggle');
        await page.keyboard.down(MOD);
        await page.keyboard.press('z');
        await page.keyboard.up(MOD);
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, SOURCE.replace('stream: UXD', 'stream: DOC'), 'lang back, the stream edit kept');
    });

    test('Insert → Properties puts `---` twice at the top and opens the panel at a new property\'s name', async function () {
        this.timeout(15000);
        await showDocument('# Title\n\nText.\n');
        await page.click('.ProseMirror p');
        await page.click('.mep-toolbar .mep-menu-face[data-menu="insert"]');
        await page.waitForSelector('.mep-menu[data-menu="insert"]:not([hidden])');
        await page.click('.mep-menu [data-action="properties"]');
        await page.waitForSelector('.mep-properties');
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.slot), 'add:name');
        await page.keyboard.type('title');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Hello');
        await page.keyboard.press('Enter');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.strictEqual(edit.text, '---\ntitle: Hello\n---\n\n# Title\n\nText.\n');
        // One front matter per document: the entry is off now.
        await page.click('.mep-toolbar .mep-menu-face[data-menu="insert"]');
        assert.strictEqual(await page.$eval('.mep-menu [data-action="properties"]', el => el.classList.contains('mep-disabled')), true);
        await page.keyboard.press('Escape');
    });

    // -- the bars while a control of the panel holds the focus ------------------------

    /** Drag over `some words` in the paragraph between the blocks. */
    const selectWords = async () => {
        const from = await pointAt(page, 'some words', 0);
        const to = await pointAt(page, 'some words', 9);
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 5 });
        await page.mouse.up();
        await delay(150);
    };

    const activeClass = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? null);

    test('the YAML box opened with the caret in a table: no bar of the hidden selection and the row refused, saying why, until the text has the focus again', async function () {
        this.timeout(20000);
        await showDocument(BOXES);
        await clickText(page, 'first', 2);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="table"]`);
        await assertRowFree(page, 'caret in the table');

        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await delay(80);
        assert.strictEqual(await activeClass(), 'mep-raw-editor mep-props-editor');
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'the table\'s bar is not offered while the box has the focus');
        await assertRowLocked(page, 'YAML box open', LOCK_SOURCE);

        // Esc gives the focus to the header's Edit as source: still a control of the panel, a button now.
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await page.$('.mep-props-editor'), null);
        assert.strictEqual(await activeClass(), 'mep-props-source');
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'nor while the header\'s button has it');
        await assertRowLocked(page, 'after Esc, the focus on the header', LOCK_BUTTON);

        // The second Esc leaves the panel for the text below: the table.
        await page.keyboard.press('Escape');
        await page.waitForSelector(`${SELECTION_BAR}[data-object="table"]`, { timeout: 2000 });
        await assertRowFree(page, 'after the second Esc');

        // A click into the text closes the box as well, and the bars are back.
        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await delay(80);
        assert.strictEqual(await page.$(SELECTION_BAR), null);
        await clickText(page, 'second', 2);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="table"]`, { timeout: 2000 });
        assert.strictEqual(await page.$('.mep-props-editor'), null);
        await assertRowFree(page, 'after a click into the table');
    });

    test('the YAML box open: no bar for the block under the pointer, and the table\'s verbs are nowhere', async function () {
        this.timeout(20000);
        await showDocument(BOXES);
        await clickText(page, 'first', 2);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="table"]`);
        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await page.mouse.move(...Object.values(await centre('.mep-raw-block .mep-atom-content table')) as [number, number]);
        await delay(300);
        assert.strictEqual(await page.$(HOVER_BAR), null, 'no bar for the block under the pointer');
        assert.strictEqual(await page.$(SELECTION_BAR), null);
        assert.strictEqual(await page.$('.mep-object-toolbar:not([hidden]) [data-verb="delete-table"]'), null, 'Delete table is not offered');
        assert.ok(await page.evaluate(() => document.querySelector('.ProseMirror')?.textContent?.includes('Kind')), 'the table is still there');
        assert.strictEqual(await activeClass(), 'mep-raw-editor mep-props-editor', 'the box keeps the focus');
        await page.keyboard.press('Escape');
    });

    test('the YAML box open over selected words: Bold in the row is refused, pointing at the reason, and Mod+B and Alt+Enter typed in the box do nothing outside it', async function () {
        this.timeout(20000);
        await showDocument(BOXES);
        await selectWords();
        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await delay(80);
        const before = await editCount();
        await clickAt('.mep-toolbar [data-action="bold"]');
        assert.strictEqual(await page.$eval('.mep-toolbar .mep-row-lock', el => el.classList.contains('mep-row-lock-flash')), true, 'the refused click points at the reason');
        await delay(300);
        assert.strictEqual(await editCount(), before, 'nothing is written');
        assert.ok(await page.$('.mep-raw-editor'), 'the box is still open');
        assert.strictEqual(await activeClass(), 'mep-raw-editor mep-props-editor', 'and keeps the focus');

        await page.keyboard.down(MOD);
        await page.keyboard.press('b');
        await page.keyboard.up(MOD);
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await delay(300);
        assert.strictEqual(await editCount(), before, 'the keys write nothing');
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'and open no bar');
        assert.strictEqual(await page.$eval('.mep-bubble', el => (el as HTMLElement).hidden), true, 'the selection\'s bubble is not offered');
        await page.keyboard.press('Escape');
    });

    test('a field of the expanded panel has the focus: the table\'s bar goes and the row is refused', async function () {
        this.timeout(20000);
        await showDocument(BOXES);
        await clickText(page, 'first', 2);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="table"]`);
        await expand();
        await clickAt(`${row('stream')} input`);
        await delay(80);
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.slot), 'value:1');
        assert.strictEqual(await page.$(SELECTION_BAR), null, 'no bar of the hidden selection');
        await assertRowLocked(page, 'a property\'s field has the focus', LOCK_PROPERTY);
        await clickText(page, 'second', 2);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="table"]`, { timeout: 2000 });
        await assertRowFree(page, 'back in the table');
    });

    /** The block-type face's name, as the row shows it. */
    const faceName = () => page.$eval('.mep-toolbar .mep-menu-face[data-menu="block-type"] .mep-face-label', el => el.textContent);

    test('while the row is refused, the block-type face keeps the name it has for the same selection', async function () {
        this.timeout(20000);
        // A caret in a table cell: the face names no type there.
        await showDocument(BOXES);
        await clickText(page, 'first', 2);
        await page.waitForSelector(`${SELECTION_BAR}[data-object="table"]`);
        const inCell = await faceName();
        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await delay(80);
        assert.strictEqual(await faceName(), inCell, 'a cell\'s caret behind the box');
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await faceName(), inCell, 'and behind the header\'s button');

        // Words selected in a paragraph: the face names the paragraph.
        await showDocument(BOXES);
        await selectWords();
        const inWords = await faceName();
        assert.strictEqual(inWords, 'Paragraph');
        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await delay(80);
        assert.strictEqual(await faceName(), inWords, 'selected words behind the box');
        await page.keyboard.press('Escape');
    });

    /** Each of the three reasons, in turn, at the page's width now: `each` is called with the reason the row shows, and the row's tools and count as they stood unlocked. */
    const walkReasons = async (each: (reason: string, state: string, before: RowBoxes) => Promise<void>) => {
        await showDocument(BOXES);
        await showDiagnostics(editor as EditorPage, version, [
            { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 'warning', message: 'A warning, for the count' },
        ]);
        // No caret in the table first: on a narrow page its bar would stand over the header's button.
        await clickText(page, 'some words', 2);
        const before = await rowBoxes(page);
        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await delay(120);
        await each(LOCK_SOURCE, 'source', before);
        await page.keyboard.press('Escape');
        await delay(120);
        await each(LOCK_BUTTON, 'button', before);
        await page.keyboard.press('Escape');
        await delay(80);
        await expand();
        await clickAt(`${row('stream')} input`);
        await delay(120);
        await each(LOCK_PROPERTY, 'property', before);
        await page.keyboard.press('Escape');
    };

    test('a press whose release never reaches the page does not hold the room back: a window blur or a move with no button frees it, and a right press never holds it', async function () {
        this.timeout(30000);
        try {
            await page.setViewport({ width: 420, height: 800 });
            await showDocument(BOXES);
            await clickText(page, 'some words', 2);
            // A press the page sees go down and never come up: the webview's context menu on
            // macOS, Alt-Tab while it is held, take the release.
            const lostPress = (button: number) => page.evaluate(b => {
                document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: b, buttons: b === 0 ? 1 : 2 }));
            }, button);
            const layout = () => page.evaluate(() => {
                const line = document.querySelector('.mep-toolbar.mep-row-lock-below > .mep-row-lock:not([hidden])');
                const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
                return {
                    line: line !== null,
                    // `:not([hidden])` holds for a line waiting unseen for its room too: shown is visible.
                    visible: line !== null && getComputedStyle(line).visibility === 'visible',
                    chrome: line ? line.getBoundingClientRect().bottom : row.bottom,
                    panel: (document.querySelector('.mep-properties') as HTMLElement).getBoundingClientRect().top,
                    room: getComputedStyle(document.querySelector('.mep-editor') as HTMLElement).paddingTop,
                    focus: (document.activeElement as HTMLElement).className,
                };
            });

            // A lost left press, then a lock by key (Tab from the text to the panel's toggle): the line comes; the room once the window blurs.
            await lostPress(0);
            await page.keyboard.press('Tab');
            await delay(150);
            let at = await layout();
            assert.ok(at.line && at.visible && at.focus === 'mep-props-toggle', JSON.stringify(at));
            await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            await delay(100);
            at = await layout();
            assert.ok(at.panel >= at.chrome - 0.5, `after a blur nothing is under the line: ${JSON.stringify(at)}`);

            // A lost press again, then the lock ends by key (Esc into the text): no empty band once the pointer moves with no button held.
            await lostPress(0);
            await page.keyboard.press('Escape');
            await delay(150);
            await page.mouse.move(5, 400);
            await delay(100);
            at = await layout();
            assert.ok(!at.line, JSON.stringify(at));
            assert.strictEqual(at.room, '35px', `no band where the line was: ${JSON.stringify(at)}`);

            // A right press — its menu may take the release — never holds the room back.
            // (From the words again: Esc left the caret in the table, where Tab goes to the next cell.)
            await clickText(page, 'some words', 2);
            await lostPress(2);
            await page.keyboard.press('Tab');
            await delay(150);
            at = await layout();
            assert.ok(at.line && at.panel >= at.chrome - 0.5, `the room comes at once after a right press: ${JSON.stringify(at)}`);
            await page.keyboard.press('Escape');
        } finally {
            await page.setViewport({ width: 1280, height: 800 });
        }
    });

    test('on a narrow page the line under the row gets room once the click is done: the header uncovered, its focus ring after Esc visible, the clicks still land', async function () {
        this.timeout(40000);
        try {
            for (const width of [600, 420]) {
                await page.setViewport({ width, height: 800 });
                await showDocument(BOXES);
                await clickText(page, 'some words', 2);
                // Counted as the page receives them: a click lands only where press and release meet one element.
                await page.evaluate(() => {
                    const w = window as unknown as { clicks: string[] };
                    w.clicks = [];
                    for (const cls of ['mep-props-toggle', 'mep-props-source']) {
                        document.querySelector(`.mep-properties .${cls}`)?.addEventListener('click', () => w.clicks.push(cls));
                    }
                });
                const clicks = () => page.evaluate(() => (window as unknown as { clicks: string[] }).clicks);
                const headerAgainst = () => page.evaluate(() => {
                    const header = (document.querySelector('.mep-properties .mep-props-header') as HTMLElement).getBoundingClientRect();
                    const active = (document.activeElement as HTMLElement).getBoundingClientRect();
                    const line = document.querySelector('.mep-toolbar.mep-row-lock-below > .mep-row-lock:not([hidden])');
                    const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect();
                    return { header: header.top, active: active.top, chrome: line ? line.getBoundingClientRect().bottom : row.bottom, below: line !== null };
                });

                // The toggle, pressed and released as a person does: the line and its room come after the release.
                const toggle = await centre('.mep-properties .mep-props-toggle');
                // While held: the line waits unseen, and nothing under the row moves — the header, nor a bar or the bubble.
                const held = () => page.evaluate(() => {
                    const line = document.querySelector('.mep-toolbar.mep-row-lock-below > .mep-row-lock:not([hidden])');
                    const floating = Array.from(document.querySelectorAll<HTMLElement>('.mep-object-toolbar, .mep-bubble'))
                        .filter(el => !el.hidden && el.getClientRects().length > 0)
                        .map(el => `${el.className}@${el.getBoundingClientRect().top}`);
                    return {
                        line: line ? getComputedStyle(line).visibility : 'none',
                        header: (document.querySelector('.mep-properties .mep-props-header') as HTMLElement).getBoundingClientRect().top,
                        floating,
                    };
                });
                await page.mouse.move(toggle.x, toggle.y);
                const unpressed = await held();
                await page.mouse.down();
                await delay(60);
                await shot(page, `lockroom-${width}-held.png`);
                const during = await held();
                assert.deepStrictEqual(during, { ...unpressed, line: 'hidden' }, `${width}px: held, the line waits unseen and nothing under the row moves`);
                await page.mouse.up();
                await delay(150);
                await shot(page, `lockroom-${width}-released.png`);
                assert.deepStrictEqual(await clicks(), ['mep-props-toggle'], `${width}px: the toggle's click landed`);
                let at = await headerAgainst();
                assert.ok(at.below, `${width}px: the reason on its own line`);
                assert.ok(at.header >= at.chrome - 0.5, `${width}px, the toggle focused: the header is not covered (${at.header} < ${at.chrome})`);

                await clickAt('.mep-properties .mep-props-source');
                await page.waitForSelector('.mep-props-editor');
                await delay(150);
                assert.deepStrictEqual(await clicks(), ['mep-props-toggle', 'mep-props-source'], `${width}px: Edit as source's click landed`);
                at = await headerAgainst();
                assert.ok(at.header >= at.chrome - 0.5, `${width}px, the YAML box open: the header is not covered`);

                // After Esc the focus is on Edit as source: its ring (outside the button) is below the line.
                await page.keyboard.press('Escape');
                await delay(150);
                assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).className), 'mep-props-source');
                at = await headerAgainst();
                assert.ok(at.active - 2 >= at.chrome - 0.5, `${width}px: Edit as source's focus ring shows (${at.active} vs ${at.chrome})`);

                // Back in the text: the room goes, and the page does not jump under the row.
                const before = await page.evaluate(() => (document.querySelector('.mep-properties') as HTMLElement).getBoundingClientRect().top - (document.querySelector('.mep-toolbar.mep-row-lock-below > .mep-row-lock') as HTMLElement).getBoundingClientRect().bottom);
                await page.keyboard.press('Escape');
                await delay(150);
                const after = await page.evaluate(() => ({
                    gap: (document.querySelector('.mep-properties') as HTMLElement).getBoundingClientRect().top - (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect().bottom,
                    room: getComputedStyle(document.querySelector('.mep-editor') as HTMLElement).paddingTop,
                }));
                assert.ok(Math.abs(after.gap - before) < 1, `${width}px: what stood under the line stands under the row (${before} -> ${after.gap})`);
                assert.strictEqual(after.room, '35px', `${width}px: the room is given back`);
            }
        } finally {
            await page.setViewport({ width: 1280, height: 800 });
        }
    });

    test('a modifier held from before the press does not show the waiting line: its repeats are no key; a real key shows it, and the release places the bars once', async function () {
        this.timeout(30000);
        try {
            await page.setViewport({ width: 600, height: 800 });
            await showDocument(BOXES);
            await clickText(page, 'some words', 2);
            const state = () => page.evaluate(() => {
                const line = document.querySelector('.mep-toolbar.mep-row-lock-below > .mep-row-lock:not([hidden])');
                return {
                    line: line ? getComputedStyle(line).visibility : 'none',
                    header: (document.querySelector('.mep-properties .mep-props-header') as HTMLElement).getBoundingClientRect().top,
                };
            });
            // What keeps clear of the chrome is placed again on each of these.
            await page.evaluate(() => {
                const w = window as unknown as { chromeMoved: number };
                w.chromeMoved = 0;
                document.querySelector('.mep-editor')?.addEventListener('mep-chrome-moved', () => w.chromeMoved++);
            });
            const moved = () => page.evaluate(() => (window as unknown as { chromeMoved: number }).chromeMoved);

            const toggle = await centre('.mep-properties .mep-props-toggle');
            await page.mouse.move(toggle.x, toggle.y);
            const unpressed = await state();
            // Shift held from before the press (a Shift-click); the keyboard repeats it while the button is down.
            await page.keyboard.down('Shift');
            await page.mouse.down();
            await delay(60);
            for (let i = 0; i < 3; i++) {
                await page.keyboard.down('Shift');
                await delay(30);
            }
            assert.deepStrictEqual(await state(), { ...unpressed, line: 'hidden' }, 'a modifier\'s repeats leave the line waiting and the page where it was');
            assert.strictEqual(await moved(), 0, 'nothing is placed against a waiting line');

            // A real key during the press: the key acts, and the line shows.
            await page.keyboard.press('KeyX');
            await delay(60);
            assert.strictEqual((await state()).line, 'visible', 'a real key shows the line');
            const beforeRelease = await moved();
            await page.mouse.up();
            await page.keyboard.up('Shift');
            await delay(150);
            assert.strictEqual(await moved() - beforeRelease, 1, 'the release places the bars once, with the line\'s room');
        } finally {
            // Nothing held over into the next test, whatever failed.
            await page.mouse.up().catch(() => undefined);
            await page.keyboard.up('Shift').catch(() => undefined);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page.setViewport({ width: 1280, height: 800 });
        }
    });

    test('the reason stands beside the tools where it fits, else on its own line under the row: whole, covering no tool, nothing moved', async function () {
        this.timeout(60000);
        try {
            for (const [width, where] of [[1280, 'beside'], [600, 'below'], [400, 'below']] as const) {
                await page.setViewport({ width, height: 800 });
                await walkReasons(async (reason, state, before) => {
                    const when = `${width}px, ${state}`;
                    const shown = await page.$eval('.mep-toolbar', el => ({ description: el.getAttribute('aria-description'), text: el.querySelector('.mep-row-lock')?.textContent }));
                    assert.deepStrictEqual(shown, { description: reason, text: reason }, `${when}: the reason, whole`);
                    await assertReasonShown(page, when, where, before);
                });
                // Unlocked again: no line under the row.
                await clickText(page, 'Last paragraph', 2);
                await delay(120);
                assert.strictEqual(await page.$eval('.mep-toolbar .mep-row-lock', el => (el as HTMLElement).hidden), true, `${width}px: the line goes with the lock`);
            }
        } finally {
            await page.setViewport({ width: 1280, height: 800 });
        }
    });

    test('the refused row, shot in light, dark and high contrast at full width, ~600 and ~400 px: the YAML box, after Esc, a property\'s field, the flash after a press on Bold', async function () {
        if (!SHOTS_DIR) {
            return;
        }
        this.timeout(180000);
        const themes: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark'], [HC_DARK, 'hc']];
        try {
            for (const [theme, name] of themes) {
                await applyTheme(page, theme);
                for (const width of [1280, 600, 400]) {
                    await page.setViewport({ width, height: 800 });
                    const at = `${name}-${width}`;
                    await walkReasons(async (_reason, state) => {
                        await shot(page, `A1-${at}-${state}.png`);
                    });

                    await showDocument(BOXES);
                    await selectWords();
                    await clickAt('.mep-properties .mep-props-source');
                    await page.waitForSelector('.mep-props-editor');
                    await clickAt('.mep-toolbar [data-action="bold"]');
                    assert.ok(await page.$('.mep-props-editor'), 'the refused click leaves the box open');
                    await shot(page, `A6-${at}-flash.png`);
                    await page.keyboard.press('Escape');
                }
            }
        } finally {
            await page.setViewport({ width: 1280, height: 800 });
            await applyTheme(page, LIGHT_MODERN);
        }
    });
});
