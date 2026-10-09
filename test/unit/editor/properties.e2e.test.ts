import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { clickText, closeEditorPage, delay, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, settle } from './pageHarness';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';

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
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.type(text);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 800 });
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
            ['attendees', 'list', null, 'Daniel×+ add×'],
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

    test('chips: + add takes a value with Enter, × removes one with the hint, each in the list\'s flow style', async function () {
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
        assert.match(await page.$eval('.mep-hint', el => el.textContent ?? ''), /^Removed Daniel — (Ctrl|Cmd)\+Z$/);
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
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit);
        assert.ok(edit.text.includes('\nsections:\n  - heading: A third\n  - heading: A change'), edit.text);
        assert.match(await page.$eval(`${row('sections')} .mep-prop-summary`, el => el.textContent ?? ''), /^3 items, nested/);
    });

    test('+ Add property asks for the name, then the value, and writes the key at the end of the YAML', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await expand();
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
        assert.match(await page.$eval('.mep-hint', el => el.textContent ?? ''), /^Removed lang — (Ctrl|Cmd)\+Z$/);
        assert.strictEqual(await page.$(row('lang')), null);
        // The focus is on the panel (its toggle, after the row went): the editor's undo.
        await page.focus('.mep-props-toggle');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
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
        assert.match(await page.$eval('.mep-hint', el => el.textContent ?? ''), /^Removed workshop — (Ctrl|Cmd)\+Z$/);
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
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
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
});
