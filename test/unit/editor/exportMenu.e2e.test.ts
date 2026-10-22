import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { WebviewMessage } from '../../../src/editor/protocol';
import { closeEditorPage, delay, EditorPage, EXTENSION_ID, openEditorPage, shot, showDiagnostics } from './pageHarness';
import { LOCK_SOURCE, assertRowLocked } from './rowLock';
import { DARK_MODERN, LIGHT_MODERN, applyTheme } from './themes';

const SOURCE = [
    'Alpha beta gamma.',
    '',
    '<div>first block</div>',
    '',
    'Outro.',
    '',
].join('\n');

const WIDTH = 1200;

/** The object toolbar showing the selected source block's verbs. */
const SELECTED_BLOCK_BAR = '.mep-object-toolbar[data-trigger="selection"][data-object="raw_block"]:not([hidden])';
const FACE = '.mep-toolbar .mep-menu-face[data-menu="export"]';
const PANEL = '.mep-menu[data-menu="export"]';

/**
 * **Export ▾** at the formatting row's right end, in the real page bundle in
 * headless Chromium (`pageHarness.ts`): where it stands, with and without the
 * diagnostics count and in a narrow row; its menu, by the pointer and the
 * keyboard; that the row's lock leaves it offered; and that a format pressed
 * with an open source box commits the box, sends the edit and only then asks
 * the host to export. With `MEP_SHOTS_DIR` set, the states are saved there.
 */
suite('Editor toolbar: Export (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const showDocument = async (text: string) => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Alpha'));
        await delay(100);
    };

    const centre = async (selector: string): Promise<{ x: number; y: number }> => {
        const box = await (await page.waitForSelector(selector))?.boundingBox();
        assert.ok(box, `no box for ${selector}`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    const clickAt = async (point: { x: number; y: number }) => {
        await page.mouse.click(point.x, point.y);
        await delay(80);
    };

    /** Where the right end stands: the row, the count (when shown), the divider before Export, and Export's face. */
    const rightEnd = () => page.$eval('.mep-toolbar', row => {
        const box = (el: Element | null) => {
            if (!el) {
                return null;
            }
            const r = el.getBoundingClientRect();
            // Whole pixels: a scrolled row lays its sticky end out a few hundredths off.
            return r.width > 0 ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null;
        };
        const status = row.querySelector(':scope > .mep-row-status') as HTMLElement;
        const group = status.querySelector(':scope > .mep-row-export') as HTMLElement;
        const face = group.querySelector('.mep-menu-face') as HTMLElement;
        const divider = getComputedStyle(group, '::before');
        return {
            row: box(row),
            last: (row.lastElementChild as HTMLElement).className,
            order: Array.from(status.children).map(c => c.className),
            count: box(status.querySelector('.mep-diag-count:not([hidden])')),
            divider: divider.content !== 'none' && divider.width === '1px',
            face: box(face),
            label: (face.querySelector('.mep-face-label') as HTMLElement).textContent,
            icon: face.querySelector(':scope > .mep-face-icon > .codicon-export') !== null,
            chevron: face.querySelector(':scope > .mep-menu-caret > .codicon-chevron-down') !== null,
            height: face.getBoundingClientRect().height,
            scrolls: row.scrollWidth > row.clientWidth,
            viewport: document.documentElement.clientWidth,
        };
    });

    const posted = async (): Promise<WebviewMessage[]> => (editor as EditorPage).posted();

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: WIDTH });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument(SOURCE);
        await page.waitForSelector('.mep-toolbar');
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    teardown(async () => {
        // The host's answer to any export a test asked for: Export is offered again.
        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'settled' });
        await page.keyboard.press('Escape');
        await page.mouse.click(WIDTH - 20, 880);
        await page.setViewport({ width: WIDTH, height: 900 });
    });

    test('Export stands at the row\'s right end, after the count and a divider, alone without a count, and stays there in a narrow row, which never scrolls', async function () {
        this.timeout(20000);
        await applyTheme(page, LIGHT_MODERN);
        await showDocument(SOURCE);
        await showDiagnostics(editor as EditorPage, version, []);
        const bare = await rightEnd();
        assert.strictEqual(bare.last, 'mep-row-status', 'the right end is the row\'s last');
        assert.deepStrictEqual(bare.order, ['mep-row-said', 'mep-row-export'], 'what is said, then Export');
        assert.strictEqual(bare.count, null, 'no count');
        assert.strictEqual(bare.divider, false, 'no divider without a count');
        assert.ok(bare.face && bare.row, 'Export is shown without a count');
        assert.ok(Math.abs(bare.row.right - 8 - bare.face.right) <= 1, `at the row's right end: ${bare.face.right} / ${bare.row.right}`);
        assert.deepStrictEqual({ label: bare.label, icon: bare.icon, chevron: bare.chevron, height: bare.height }, { label: 'Export', icon: true, chevron: true, height: 22 },
            'a menu face as the others: the export codicon, the label, the chevron, 22px');

        await showDiagnostics(editor as EditorPage, version, [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 'warning', message: 'A warning' },
            { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 5 } }, severity: 'warning', message: 'Another' },
        ]);
        const counted = await rightEnd();
        assert.ok(counted.count && counted.face, 'the count and Export');
        assert.ok(counted.count.right <= counted.face.left, 'the count before Export');
        assert.strictEqual(counted.divider, true, 'a divider between them');
        assert.deepStrictEqual(counted.face, bare.face, 'Export did not move');
        await shot(page, 'export-1-rest-light.png');
        await applyTheme(page, DARK_MODERN);
        await delay(50);
        await shot(page, 'export-1-rest-dark.png');

        await page.setViewport({ width: 520, height: 900 });
        await delay(150);
        const narrow = await rightEnd();
        assert.ok(!narrow.scrolls, 'the narrow row never scrolls: what does not fit is in "…"');
        assert.ok(narrow.face && narrow.face.right <= narrow.viewport && narrow.face.left >= 0, 'Export is whole in the window');
        await shot(page, 'export-4-narrow-dark.png');
        assert.ok(narrow.face && Math.abs(narrow.row.right - 8 - narrow.face.right) <= 1, 'Export at the right end, nothing scrolled under it');
        await applyTheme(page, LIGHT_MODERN);
        await showDiagnostics(editor as EditorPage, version, []);
    });

    test('the menu opens right-aligned under its face: the four formats as text, a separator, the settings; each entry posts its request', async function () {
        this.timeout(20000);
        await applyTheme(page, DARK_MODERN);
        await showDocument(SOURCE);
        await page.click(FACE);
        await page.waitForSelector(`${PANEL}:not([hidden])`);
        const menu = await page.$eval(PANEL, (panel, faceSelector) => {
            const face = (document.querySelector(faceSelector) as HTMLElement).getBoundingClientRect();
            const p = panel.getBoundingClientRect();
            return {
                entries: Array.from(panel.children).map(c => (c.getAttribute('role') === 'separator' ? '—' : `${c.querySelector('.mep-entry-label')?.textContent}|${c.querySelector('.mep-entry-detail')?.textContent ?? ''}`)),
                samples: panel.querySelectorAll('.mep-sample').length,
                expanded: document.querySelector(faceSelector)?.getAttribute('aria-expanded'),
                right: Math.round(p.right - face.right),
                below: p.top >= face.bottom,
                inside: p.left >= 0 && p.right <= document.documentElement.clientWidth,
            };
        }, FACE);
        assert.deepStrictEqual(menu, {
            entries: ['HTML|self-contained', 'PDF|via Chromium', 'PNG image|via Chromium', 'JPEG image|via Chromium', '—', 'Export settings…|'],
            samples: 0,
            expanded: 'true',
            right: 0,
            below: true,
            inside: true,
        });
        await page.hover(`${PANEL} [data-export="html"]`);
        await shot(page, 'export-2-menu-open-dark.png');

        const before = (await posted()).length;
        await page.click(`${PANEL} [data-export="png"]`);
        await delay(80);
        assert.strictEqual(await page.$eval(PANEL, el => (el as HTMLElement).hidden), true, 'the menu closes');
        await page.click(FACE);
        await page.click(`${PANEL} [data-export="settings"]`);
        await delay(80);
        const sent = (await posted()).slice(before).filter(m => m.type === 'export' || m.type === 'exportSettings');
        assert.deepStrictEqual(sent, [{ type: 'export', format: 'png' }, { type: 'exportSettings' }]);
        await applyTheme(page, LIGHT_MODERN);
    });

    test('the keyboard: Enter opens the menu at its first entry, the arrows move and wrap, Escape closes it back to the face, Enter runs an entry', async function () {
        this.timeout(20000);
        await showDocument(SOURCE);
        await page.focus(FACE);
        const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.export ?? (document.activeElement as HTMLElement | null)?.dataset.menu ?? null);
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${PANEL}:not([hidden])`);
        assert.strictEqual(await focused(), 'html');
        await page.keyboard.press('ArrowDown');
        assert.strictEqual(await focused(), 'pdf');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowUp');
        assert.strictEqual(await focused(), 'settings', 'up from the first wraps to the last');
        await page.keyboard.press('Escape');
        assert.strictEqual(await page.$eval(PANEL, el => (el as HTMLElement).hidden), true, 'Escape closes the menu');
        assert.strictEqual(await focused(), 'export', 'and gives the focus back to the face');

        const before = (await posted()).length;
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector(`${PANEL}:not([hidden])`);
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.strictEqual(await focused(), 'png');
        await page.keyboard.press('Enter');
        await delay(80);
        assert.deepStrictEqual((await posted()).slice(before).filter(m => m.type === 'export'), [{ type: 'export', format: 'png' }]);
        assert.strictEqual(await page.$eval(PANEL, el => (el as HTMLElement).hidden), true, 'the menu closes');
        assert.strictEqual(await focused(), 'export', 'the focus back on the face');
    });

    test('with a source box open the row is locked but Export is offered; PDF commits the box, sends the edit, and only then asks for the export', async function () {
        this.timeout(20000);
        await showDocument(SOURCE);
        await clickAt(await centre('.ProseMirror > .mep-raw-block .mep-atom-content'));
        await clickAt(await centre(`${SELECTED_BLOCK_BAR} [data-verb="edit-source"]`));
        await page.waitForSelector('.mep-raw-editor');
        await page.keyboard.press('End');
        await page.keyboard.type('X');
        await delay(80);
        assert.strictEqual(await page.$eval('.mep-raw-editor', el => document.activeElement === el && (el as HTMLTextAreaElement).value), '<div>first block</div>X', 'the box holds unapplied text');
        await assertRowLocked(page, 'the box open', LOCK_SOURCE);
        assert.strictEqual((await rightEnd()).divider, true, 'a divider between the lock\'s reason and Export');
        await shot(page, 'export-3-locked-source-box-light.png');
        await showDiagnostics(editor as EditorPage, version, [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 'warning', message: 'A warning' },
        ]);
        const counted = await rightEnd();
        assert.ok(counted.count && counted.face && counted.divider, 'the count, the divider, Export');
        await assertRowLocked(page, 'the box open, with a count', LOCK_SOURCE);
        await shot(page, 'export-3-locked-diagnostics-light.png');
        await applyTheme(page, DARK_MODERN);
        await delay(50);
        await shot(page, 'export-3-locked-diagnostics-dark.png');
        await applyTheme(page, LIGHT_MODERN);

        const before = (await posted()).length;
        await page.click(FACE);
        await page.waitForSelector(`${PANEL}:not([hidden])`);
        await page.click(`${PANEL} [data-export="pdf"]`);
        await delay(100);
        const sent = (await posted()).slice(before).filter(m => m.type === 'edit' || m.type === 'export');
        assert.deepStrictEqual(sent.map(m => m.type), ['edit', 'export'], 'the edit first, then the export');
        const edit = sent[0] as Extract<WebviewMessage, { type: 'edit' }>;
        assert.strictEqual(edit.text, SOURCE.replace('</div>', '</div>X'), 'the edit carries the box\'s text');
        assert.deepStrictEqual(sent[1], { type: 'export', format: 'pdf' });
        await page.keyboard.press('Escape');
        await showDiagnostics(editor as EditorPage, version, []);
    });

    test('one export at a time: from the press until the host answers, the face names the running format and spins; the other formats are refused saying what they wait for; the settings are not', async function () {
        this.timeout(20000);
        await showDocument(SOURCE);
        const face = () => page.$eval(FACE, el => ({
            label: (el.querySelector('.mep-face-label') as HTMLElement).textContent,
            busy: el.getAttribute('aria-busy'),
            disabled: el.getAttribute('aria-disabled'),
            title: (el.getAttribute('aria-description') ?? ''),
        }));
        const entries = () => page.$$eval(`${PANEL} [data-export]`, els => els.map(el => ({
            id: (el as HTMLElement).dataset.export,
            disabled: el.getAttribute('aria-disabled'),
            title: (el.getAttribute('aria-description') ?? ''),
        })));
        const before = (await posted()).length;
        await page.click(FACE);
        await page.click(`${PANEL} [data-export="html"]`);
        await delay(80);
        const reason = 'One export at a time — HTML is running';
        assert.deepStrictEqual(await face(), { label: 'Exporting HTML…', busy: 'true', disabled: 'false', title: `Exporting HTML…\n${reason}` });
        assert.ok(await page.$(`${FACE} > .mep-face-icon > .codicon-loading.codicon-modifier-spin`), 'the face spins');
        await page.click(FACE);
        await page.waitForSelector(`${PANEL}:not([hidden])`);
        assert.deepStrictEqual(await entries(), [
            { id: 'html', disabled: 'true', title: 'Exporting HTML…' },
            ...[['pdf', 'PDF'], ['png', 'PNG image'], ['jpg', 'JPEG image']].map(([id, label]) => ({ id, disabled: 'true', title: `${label} waits for HTML — choose it again when HTML is done.` })),
            { id: 'settings', disabled: null, title: '' },
        ]);
        assert.strictEqual(await page.$eval(`${PANEL} .mep-menu-caption`, el => el.textContent), reason, 'said once atop the menu');
        assert.deepStrictEqual(await page.$eval(`${PANEL} [data-export="html"]`, el => [el.querySelector(':scope > .mep-entry-busy > .codicon-modifier-spin') !== null, el.querySelector('.mep-entry-detail')?.textContent]), [true, 'exporting…'], 'the running format spins');
        await shot(page, 'export-5-busy-light.png');
        await page.click(`${PANEL} [data-export="pdf"]`);
        await delay(80);
        assert.deepStrictEqual((await posted()).slice(before).filter(m => m.type === 'export'), [{ type: 'export', format: 'html' }], 'a second export is not asked for');

        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'busy', format: 'html' });
        await delay(80);
        assert.strictEqual((await face()).label, 'Exporting HTML…', 'answered busy: the one running is still shown');
        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'settled' });
        await delay(80);
        assert.deepStrictEqual(await face(), { label: 'Export', busy: 'false', disabled: 'false', title: 'Export' });
        await page.keyboard.press('Escape');
    });

    test('a page loaded while an export runs shows it running, from the document the host posts, until its exportDone', async function () {
        this.timeout(20000);
        await showDocument(SOURCE);
        assert.strictEqual(await page.$eval(`${FACE} .mep-face-label`, el => el.textContent), 'Export');
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({
            type: 'document', json: parsedDocumentToJSON(parseDocument(md, SOURCE, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE, exporting: 'pdf',
        });
        await delay(100);
        assert.deepStrictEqual(await page.$eval(FACE, el => [(el.querySelector('.mep-face-label') as HTMLElement).textContent, el.getAttribute('aria-busy')]), ['Exporting PDF…', 'true'], 'the format the host names');
        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'settled' });
        await delay(80);
        assert.deepStrictEqual(await page.$eval(FACE, el => [(el.querySelector('.mep-face-label') as HTMLElement).textContent, el.getAttribute('aria-busy')]), ['Export', 'false']);
    });

    test('an export the host refused — a format it does not make — is said on the page, and Export is offered again', async function () {
        this.timeout(20000);
        await showDocument(SOURCE);
        await page.click(FACE);
        await page.click(`${PANEL} [data-export="pdf"]`);
        await delay(80);
        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'refused' });
        await delay(80);
        assert.deepStrictEqual(await page.$eval('.mep-hint', el => ({ text: el.textContent, shown: !(el as HTMLElement).hidden })),
            { text: 'Not exported: this format is not offered.', shown: true });
        assert.strictEqual(await page.$eval(`${FACE} .mep-face-label`, el => el.textContent), 'Export');
    });

    test('a document from the host says whether an export runs: one without it clears a busy face whose exportDone was lost', async function () {
        this.timeout(20000);
        await showDocument(SOURCE);
        await page.click(FACE);
        await page.click(`${PANEL} [data-export="pdf"]`);
        await delay(80);
        assert.strictEqual(await page.$eval(`${FACE} .mep-face-label`, el => el.textContent), 'Exporting PDF…');
        await showDocument(SOURCE);
        assert.deepStrictEqual(await page.$eval(FACE, el => [(el.querySelector('.mep-face-label') as HTMLElement).textContent, el.getAttribute('aria-busy')]), ['Export', 'false']);
    });
});
