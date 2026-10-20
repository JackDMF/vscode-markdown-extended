import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { BUBBLE_OVERFLOW, ROW_OVERFLOW } from '../../../src/editor/webview/toolbar/actions';
import { moreName } from '../../../src/editor/webview/overflow';
import { EXTENSION_ID, EditorPage, clickText, closeEditorPage, delay, describedTip, hoverTip, openEditorPage, shot as saveShot, showDiagnostics } from './pageHarness';
import { LOCK_BUTTON, LOCK_PROPERTY, LOCK_SOURCE, MOD_NAME, assertReasonShown, assertRowLocked, rowBoxes } from './rowLock';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** The plan's document (wave2-overflow-plan.md, section 9): bold code, a sidenote, a table, a container, an admonition, a link in bold. */
const SOURCE = [
    '---',
    'title: Demo',
    'stream: UXD',
    '---',
    '',
    '# Overflow',
    '',
    'Plain words, then **bold `code` here** and more plain words.',
    '',
    'A sentence with a ++sidenote|the note++ in it.',
    '',
    '| Name | Value |',
    '| ---- | ----- |',
    '| Alpha | 1 |',
    '',
    '::: warning-box',
    'Inside the container.',
    ':::',
    '',
    '!!! warning "Check the inputs"',
    '    Admonition body.',
    '',
    'See the **[bold docs](docs/api.md)** here.',
    '',
].join('\n');

const WIDTHS = [1280, 900, 640, 520, 420];
const THEMES: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark'], [HC_DARK, 'hc']];
const ROW = '.mep-toolbar';
const MORE = `${ROW} .mep-more-face`;
const panel = (menu: string) => `.mep-menu[data-menu="${menu}"]`;

/** What the row shows: what moved into "…", whether it scrolls, and where its controls stand. */
interface RowState {
    moved: string[];
    scrolls: boolean;
    controls: { id: string; left: number; right: number; top: number; height: number }[];
    more: { shown: boolean; label: string | null; hasOn: boolean; dividerBefore: boolean; nextIsStatusOrLock: boolean };
    viewport: number;
}

/**
 * Wave 2 #2 (DECISIONS.md "Wave 2 · #2", the plan's section 9): the row never
 * scrolls; what does not fit moves into "…" in `ROW_OVERFLOW`'s order, and
 * "…" holds it in the row's order. With MEP_SHOTS_DIR set, the states are
 * saved there.
 */
suite('Editor overflow: the row\'s "…" (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const shot = (name: string) => saveShot(page, name);

    /** The host's document for `text`; the focus is let go first unless `keepFocus` (a menu that holds it stays open). */
    const showDocument = async (text = SOURCE, keepFocus = false) => {
        if (!keepFocus) {
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        }
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Overflow'));
        await showDiagnostics(editor as EditorPage, version, [
            { range: { start: { line: 7, character: 0 }, end: { line: 7, character: 5 } }, severity: 'warning', message: 'A warning' },
            { range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } }, severity: 'warning', message: 'Another' },
        ]);
        await delay(100);
    };

    const resize = async (width: number, height = 700) => {
        await page.setViewport({ width, height });
        await delay(150);
    };

    const rowState = (): Promise<RowState> => page.$eval(ROW, bar => {
        const row = bar as HTMLElement;
        const shown = (el: HTMLElement) => el.offsetParent !== null;
        const tools = Array.from(row.querySelectorAll<HTMLElement>('.mep-tool, .mep-diag-count'));
        const more = row.querySelector<HTMLElement>('.mep-more-face') as HTMLElement;
        const group = more.parentElement as HTMLElement;
        const divider = getComputedStyle(group, '::before');
        const next = group.nextElementSibling as HTMLElement | null;
        return {
            moved: Array.from(row.querySelectorAll<HTMLElement>('.mep-mark-tool[hidden], .mep-menu-face[hidden]:not(.mep-more-face)')).map(c => c.dataset.action ?? c.dataset.menu ?? '?'),
            scrolls: row.scrollWidth > row.clientWidth,
            controls: tools.filter(shown).map(c => {
                const r = c.getBoundingClientRect();
                return { id: c.dataset.action ?? c.dataset.menu ?? c.className, left: r.left, right: r.right, top: Math.round(r.top), height: r.height };
            }),
            more: {
                shown: shown(more),
                label: more.getAttribute('aria-label'),
                hasOn: more.classList.contains('mep-has-on'),
                dividerBefore: divider.content !== 'none' && divider.display !== 'none',
                nextIsStatusOrLock: next !== null && (next.classList.contains('mep-row-lock') || next.classList.contains('mep-row-status')),
            },
            viewport: document.documentElement.clientWidth,
        };
    });

    /** The order "moved" must be: the first `n` of ROW_OVERFLOW, as a set. */
    const prefix = (n: number) => ROW_OVERFLOW.slice(0, n).map(String).sort();

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280 });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument();
        await page.waitForSelector(ROW);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    teardown(async () => {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await resize(1280);
        await applyTheme(page, LIGHT_MODERN);
    });

    test('r1 at 1280 / 900 / 640 / 520 / 420 the row never scrolls: every control whole on one line, a prefix of ROW_OVERFLOW in "…", Export and the count at the right end', async function () {
        this.timeout(120000);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            for (const width of WIDTHS) {
                await resize(width);
                await showDocument();
                await clickText(page, 'code', 2);
                await delay(100);
                const s = await rowState();
                assert.strictEqual(s.scrolls, false, `${width}: never scrolls`);
                for (const c of s.controls) {
                    assert.ok(c.left >= 0 && c.right <= s.viewport + 0.5, `${width}: ${c.id} whole inside the window (${c.left}–${c.right})`);
                    assert.strictEqual(c.height, 22, `${width}: ${c.id} 22px`);
                }
                assert.strictEqual(new Set(s.controls.map(c => c.top)).size, 1, `${width}: one line`);
                assert.deepStrictEqual([...s.moved].sort(), prefix(s.moved.length), `${width}: a prefix of ROW_OVERFLOW: ${s.moved}`);
                assert.ok(!s.moved.includes('block-type'), 'Block type never moves');
                assert.strictEqual(s.more.shown, s.moved.length > 0, `${width}: "…" shown exactly when something moved`);
                if (width >= 900) {
                    assert.deepStrictEqual(s.moved, [], `${width}: nothing moved`);
                }
                if (width === 420) {
                    for (const menu of ['annotation', 'formatting', 'insert']) {
                        assert.ok(s.moved.includes(menu), `420: ${menu} in "…"`);
                    }
                }
                if (s.more.shown) {
                    assert.strictEqual(s.more.dividerBefore, false, `${width}: no divider before "…"`);
                    assert.strictEqual(s.more.nextIsStatusOrLock, true, `${width}: "…" is the last control before the lock and the status`);
                }
                const last = s.controls.slice(-2).map(c => c.id);
                assert.ok(last[1] === 'export' && /mep-diag-count/.test(last[0]), `${width}: the count, then Export at the right end: ${last}`);
                await shot(`row-${width}-${t}.png`);
            }
        }
    });

    test('r2 "…" open at 420, by click and by keys: the moved marks with glyph, word, syntax and key, a divider, the menus as submenus; Annotation opens its own panel', async function () {
        this.timeout(90000);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            await resize(420, 640);
            await showDocument();
            await clickText(page, 'code', 2);
            await delay(100);
            await page.click(MORE);
            await page.waitForSelector(`${panel('more')}:not([hidden])`);
            await delay(80);
            const open = await page.$eval(panel('more'), (el, moreSel) => {
                const items = Array.from(el.children).filter(c => (c as HTMLElement).offsetParent !== null) as HTMLElement[];
                const face = (document.querySelector(moreSel) as HTMLElement).getBoundingClientRect();
                const r = el.getBoundingClientRect();
                return {
                    entries: items.map(i => i.classList.contains('mep-menu-separator') ? '---' : (i.dataset.action ?? `menu:${i.dataset.submenu}`)),
                    code: (() => {
                        const c = el.querySelector<HTMLElement>('[data-action="code"]') as HTMLElement;
                        const key = c.querySelector<HTMLElement>('.mep-entry-key');
                        return {
                            role: c.getAttribute('role'), checked: c.getAttribute('aria-checked'), active: c.classList.contains('mep-active'),
                            glyph: c.querySelector('.mep-entry-glyph .mep-sample > code') !== null, word: c.querySelector('.mep-entry-label')?.textContent,
                            syntax: c.querySelector('.mep-entry-syntax')?.textContent, key: key?.textContent, keyWhole: key !== null && key.scrollWidth <= key.clientWidth,
                        };
                    })(),
                    chevrons: items.filter(i => i.dataset.submenu).every(i => i.querySelector('.codicon-chevron-right') !== null),
                    inside: r.left >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
                    rightAtFace: Math.abs(r.right - face.right) <= 1 || r.left === 0,
                };
            }, MORE);
            assert.deepStrictEqual(open.entries, ['strong', 'code', '---', 'menu:formatting', 'menu:annotation', 'menu:insert'], 'row order: marks, a divider, menus');
            assert.deepStrictEqual(open.code, { role: 'menuitemcheckbox', checked: 'true', active: true, glyph: true, word: 'Code', syntax: '`text`', key: open.code.key, keyWhole: true });
            assert.match(String(open.code.key), /^(Ctrl|Cmd)\+`$/);
            assert.ok(open.chevrons, 'each menu entry has a chevron');
            assert.ok(open.inside && open.rightAtFace, `inside the window, hung from the face's right: ${JSON.stringify(open)}`);
            await shot(`more-open-420-${t}.png`);
            // The keyboard: Annotation opens the row's own panel, inside the window; ArrowLeft back to the entry, Esc back to "…".
            await page.keyboard.press('Escape');
            await page.focus(MORE);
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${panel('more')}:not([hidden])`);
            await page.focus(`${panel('more')} [data-submenu="annotation"]`);
            await page.keyboard.press('ArrowRight');
            await page.waitForSelector(`${panel('annotation')}:not([hidden])`);
            await delay(80);
            const sub = await page.$eval(panel('annotation'), el => {
                const r = el.getBoundingClientRect();
                const entry = (document.querySelector('.mep-menu[data-menu="more"] [data-submenu="annotation"]') as HTMLElement).getBoundingClientRect();
                return {
                    inside: r.left >= 0 && r.right <= window.innerWidth + 0.5 && r.top >= 0 && r.bottom <= window.innerHeight + 0.5,
                    focus: el.contains(document.activeElement),
                    entryInSight: r.top >= entry.bottom - 0.5 || r.left >= entry.right - 0.5 || r.right <= entry.left + 0.5,
                };
            });
            assert.deepStrictEqual(sub, { inside: true, focus: true, entryInSight: true });
            await shot(`more-annotation-420-${t}.png`);
            await page.keyboard.press('ArrowLeft');
            await delay(50);
            assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.submenu), 'annotation', 'ArrowLeft returns to the entry');
            await page.keyboard.press('Escape');
            await delay(50);
            assert.ok(await page.evaluate(sel => document.activeElement === document.querySelector(sel), MORE), 'Esc returns the focus to "…"');
        }
        // A pick runs and closes everything: Code, from "…", with the caret in plain text.
        await applyTheme(page, LIGHT_MODERN);
        await clickText(page, 'Plain');
        await page.click(MORE);
        await page.waitForSelector(`${panel('more')}:not([hidden])`);
        await page.click(`${panel('more')} [data-action="code"]`);
        await delay(150);
        assert.strictEqual(await page.$$eval('.mep-menu:not([hidden])', els => els.length), 0, 'every menu closed');
    });

    test('r3 the dot: a mark in "…" that is on puts a dot on it, and its name says so', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument();
        await clickText(page, 'code', 2);
        await delay(100);
        const on = await rowState();
        assert.strictEqual(on.more.hasOn, true);
        assert.strictEqual(on.more.label, moreName('row', ['Strong', 'Code', 'Formatting', 'Annotation', 'Insert'], ['Code']));
        await clickText(page, 'Plain');
        await delay(100);
        const off = await rowState();
        assert.strictEqual(off.more.hasOn, false);
        assert.ok(!String(off.more.label).includes('(on)'), String(off.more.label));
        const dot = await page.$eval(MORE, el => getComputedStyle(el, '::after').content);
        assert.strictEqual(dot, 'none');
    });

    test('r4 420 → 1280 → 420: everything back in the row, Annotation a top-level menu again, then the same moved set', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument();
        await clickText(page, 'code', 2);
        const narrow = (await rowState()).moved;
        await resize(1280);
        const wide = await rowState();
        assert.deepStrictEqual(wide.moved, []);
        assert.strictEqual(wide.more.shown, false);
        await page.click(`${ROW} .mep-menu-face[data-menu="annotation"]`);
        await page.waitForSelector(`${panel('annotation')}:not([hidden])`);
        const top = await page.$eval(panel('annotation'), el => {
            const face = (document.querySelector('.mep-toolbar .mep-menu-face[data-menu="annotation"]') as HTMLElement).getBoundingClientRect();
            return Math.abs(el.getBoundingClientRect().left - face.left) <= 1;
        });
        assert.ok(top, 'under its face, as a top-level menu');
        await page.keyboard.press('Escape');
        await resize(420, 640);
        assert.deepStrictEqual((await rowState()).moved, narrow);
    });

    // -- the lock's note in the row (section 3C, l1-l5) --------------------------

    const clickAt = async (selector: string) => {
        const box = await (await page.waitForSelector(selector, { visible: true }))?.boundingBox();
        assert.ok(box, `no box for ${selector}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(120);
    };

    /** The YAML box of the properties opened: the row locked by a source box. */
    const openYaml = async () => {
        await clickText(page, 'Plain', 2);
        await clickAt('.mep-properties .mep-props-source');
        await page.waitForSelector('.mep-props-editor');
        await delay(150);
    };

    /** Where the page stands: what would move were the lock to make room for itself. */
    const pageAt = () => page.evaluate(() => ({
        scroll: document.scrollingElement?.scrollTop ?? 0,
        // The panel stands first: what is under it grows with the YAML box, which is no move of the page.
        first: Math.round((document.querySelector('.mep-properties') as HTMLElement).getBoundingClientRect().top),
        room: getComputedStyle(document.querySelector('.mep-editor') as HTMLElement).paddingTop,
    }));

    test('l1 at 1280 a source box\'s reason stands beside the tools, whole; the tools refused, Export offered', async function () {
        this.timeout(30000);
        await showDocument();
        await openYaml();
        await assertRowLocked(page, '1280', LOCK_SOURCE);
        await assertReasonShown(page, '1280', LOCK_SOURCE, 'beside');
        await page.keyboard.press('Escape');
    });

    test('l2 at 520 the reason takes the refused tools\' place, whole: Export, the count and the page stay where they were', async function () {
        this.timeout(60000);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            await resize(520);
            await showDocument();
            await clickText(page, 'Plain', 2);
            const before = await rowBoxes(page);
            const unlocked = await pageAt();
            await openYaml();
            await assertReasonShown(page, `520 ${t}`, LOCK_SOURCE, 'inrow', before);
            assert.deepStrictEqual(await pageAt(), unlocked, `520 ${t}: the page did not move`);
            await shot(`lock-520-${t}.png`);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
        }
    });

    test('l3 at 420 the whole reason in the row; narrower its short form, whole, keys kept, its hover and the row\'s description the whole reason; Esc gives the row back; a property\'s field the same', async function () {
        this.timeout(90000);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            for (const [width, where] of [[420, 'inrow'], [340, 'short']] as const) {
                await resize(width, 640);
                await showDocument();
                await clickText(page, 'Plain', 2);
                const moved = (await rowState()).moved;
                const before = await rowBoxes(page);
                await openYaml();
                await assertReasonShown(page, `${width} ${t}`, LOCK_SOURCE, where, before);
                if (where === 'short') {
                    assert.strictEqual(await page.$eval(`${ROW} .mep-row-lock-text`, el => el.textContent), `Source · ${MOD_NAME}+Enter · Esc`);
                    assert.strictEqual(await describedTip(page, `${ROW} .mep-row-lock`), LOCK_SOURCE, 'its hover: the whole reason');
                }
                await shot(`lock-${width}-${t}.png`);
                await page.keyboard.press('Escape');
                await page.keyboard.press('Escape');
                await delay(150);
                const back = await rowState();
                assert.strictEqual(await page.$eval(ROW, el => el.classList.contains('mep-row-lock-inrow')), false, 'the tools are back');
                assert.deepStrictEqual(back.moved, moved, '"…" holds what it held');
            }
        }
        await applyTheme(page, LIGHT_MODERN);
        await clickAt('.mep-properties .mep-props-toggle');
        await page.waitForSelector('.mep-prop-row', { visible: true });
        await clickAt('.mep-prop-row[data-key="stream"] input');
        await delay(150);
        await assertReasonShown(page, '340, a property\'s field', LOCK_PROPERTY, 'short');
        assert.strictEqual(await page.$eval(`${ROW} .mep-row-lock-text`, el => el.textContent), 'Property · Enter · Esc');
        await shot('lock-property-340-light.png');
        await page.keyboard.press('Escape');
    });

    test('l4 a button\'s lock: at 900 and 860 "Outside the text" beside the tools, which dim, the whole reason its hover; where it does not fit beside them (800, 640, 520) no note, Bold\'s tooltip says the whole reason', async function () {
        this.timeout(90000);
        for (const width of [900, 860, 800, 640, 520]) {
            await resize(width);
            await showDocument();
            await clickText(page, 'Plain', 2);
            const before = await rowBoxes(page);
            await openYaml();
            await page.keyboard.press('Escape');
            await delay(150);
            if (width >= 860) {
                await assertReasonShown(page, `${width}, a button`, LOCK_BUTTON, 'short', before);
                assert.strictEqual(await describedTip(page, `${ROW} .mep-row-lock`), LOCK_BUTTON, `${width}: the short form's hover is the whole reason`);
            } else {
                await assertReasonShown(page, `${width}, a button`, LOCK_BUTTON, 'hidden', before);
                assert.ok((await describedTip(page, `${ROW} [data-action="bold"]`)).endsWith(`\n${LOCK_BUTTON}`), 'Bold\'s tooltip carries the whole reason');
                // A press on Bold: the flash has no note to point at — the limit #10 lifts.
                await clickAt(`${ROW} [data-action="bold"]`);
                assert.strictEqual(await page.$eval(`${ROW} .mep-row-lock`, el => (el as HTMLElement).hidden), true, 'nothing shows');
            }
            await shot(`lock-button-${width}-light.png`);
            await page.keyboard.press('Escape');
        }
    });

    test('l5 the lock comes and goes at 520 with the page scrolled: the scroll and the first visible block stay', async function () {
        this.timeout(30000);
        const filler = Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i}.`).join('\n\n');
        await resize(520);
        const above = Array.from({ length: 10 }, (_, i) => `Above ${i}.`).join('\n\n');
        await showDocument(`# Overflow\n\n${above}\n\n<div>raw block</div>\n\n${filler}\n`);
        await page.evaluate(() => {
            document.scrollingElement!.scrollTop = 300;
        });
        await delay(100);
        const at = () => page.evaluate(() => {
            const row = (document.querySelector('.mep-toolbar') as HTMLElement).getBoundingClientRect().bottom;
            const first = Array.from(document.querySelectorAll<HTMLElement>('.ProseMirror > p')).find(p => p.getBoundingClientRect().top >= row);
            return { scroll: document.scrollingElement?.scrollTop ?? 0, first: first?.textContent, top: Math.round(first?.getBoundingClientRect().top ?? -1) };
        });
        const before = await at();
        const block = await (await page.$('.ProseMirror > .mep-raw-block'))?.boundingBox();
        assert.ok(block);
        await page.mouse.click(block.x + block.width / 2, block.y + block.height / 2, { clickCount: 2, delay: 40 });
        await page.waitForSelector('.mep-raw-editor');
        await delay(200);
        assert.strictEqual(await page.$eval(`${ROW} .mep-row-lock`, el => (el as HTMLElement).hidden), false, 'locked');
        assert.deepStrictEqual(await at(), before, 'locked: nothing moved');
        await page.keyboard.press('Escape');
        await delay(200);
        assert.deepStrictEqual(await at(), before, 'unlocked: nothing moved');
    });

    // -- Export busy names the format (section 6, e1) -----------------------------

    test('e1 Export → HTML at 1280, 520 and 420: the face names the format as the room allows and spins, the tooltip says it whole, no tool moved; the menu; reduced motion; done', async function () {
        this.timeout(120000);
        const EXPORT = `${ROW} .mep-menu-face[data-menu="export"]`;
        const face = () => page.$eval(EXPORT, el => ({
            label: (el.querySelector('.mep-face-label') as HTMLElement).textContent,
            spins: el.querySelector(':scope > .mep-face-icon > .codicon-loading.codicon-modifier-spin') !== null,
            busy: el.getAttribute('aria-busy'),
            title: el.getAttribute('aria-description'),
        }));
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            for (const [width, label] of [[1280, 'Exporting HTML…'], [520, 'HTML…'], [420, 'HTML…']] as const) {
                await resize(width, 640);
                await showDocument();
                await clickText(page, 'Plain', 2);
                const idle = (await rowState()).moved;
                await page.click(EXPORT);
                await page.waitForSelector(`${panel('export')}:not([hidden])`);
                await page.click(`${panel('export')} [data-export="html"]`);
                await delay(120);
                assert.deepStrictEqual(await face(), { label, spins: true, busy: 'true', title: 'Exporting HTML…\nExporting HTML — the other formats wait for it' }, `${width} ${t}`);
                assert.deepStrictEqual((await rowState()).moved, idle, `${width} ${t}: the busy label moved no tool`);
                await shot(`export-busy-${width}-${t}.png`);
                if (width === 520 && t === 'light') {
                    await page.click(EXPORT);
                    await page.waitForSelector(`${panel('export')}:not([hidden])`);
                    await delay(80);
                    const entries = await page.$$eval(`${panel('export')} [data-export]`, els => els.map(el => ({
                        id: (el as HTMLElement).dataset.export,
                        disabled: el.getAttribute('aria-disabled'),
                        spins: el.querySelector(':scope > .mep-entry-busy > .codicon-modifier-spin') !== null,
                        detail: el.querySelector('.mep-entry-detail')?.textContent ?? null,
                        note: el.getAttribute('aria-description'),
                    })));
                    assert.deepStrictEqual(entries.map(e => [e.id, e.disabled, e.spins]), [['html', 'true', true], ['pdf', 'true', false], ['png', 'true', false], ['jpg', 'true', false], ['settings', null, false]]);
                    assert.strictEqual(entries[0].detail, 'exporting…');
                    assert.deepStrictEqual(entries.slice(1, 4).map(e => e.note), Array(3).fill('Exporting HTML — the other formats wait for it'));
                    await shot('export-menu-busy-520-light.png');
                    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
                    await delay(50);
                    const still = await page.$eval(`${EXPORT} .codicon-modifier-spin`, el => getComputedStyle(el).animationName);
                    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
                    assert.strictEqual(still, 'none', 'reduced motion: the spinner holds still');
                    await page.keyboard.press('Escape');
                }
                await (editor as EditorPage).send({ type: 'exportDone', outcome: 'settled' });
                await delay(120);
                assert.deepStrictEqual(await face(), { label: 'Export', spins: false, busy: 'false', title: 'Export' }, `${width} ${t}: done`);
                assert.ok(await page.$(`${EXPORT} > .mep-face-icon > .codicon-export`), 'the export codicon back');
            }
        }
    });

    // -- the bars' "…" (section 5, b1-b5) -----------------------------------------

    const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
    const barMore = `${BAR} .mep-object-more`;

    /** The caret at `needle` (+`at`), and its bar shown for `kind`. */
    const barAt = async (needle: string, at: number, kind: string) => {
        await clickText(page, needle, at);
        await page.waitForSelector(`${BAR}[data-object="${kind}"]`, { timeout: 5000 });
        await delay(150);
    };

    /** What the bar shows: its title, the verbs on it, the verbs hidden, and "…". */
    const barState = () => page.$eval(BAR, el => {
        const label = el.querySelector<HTMLElement>('.mep-object-label');
        const verbs = Array.from(el.querySelectorAll<HTMLElement>('[data-verb]'));
        const more = el.querySelector<HTMLElement>('.mep-object-more');
        const r = el.getBoundingClientRect();
        return {
            title: label && !label.hidden ? label.textContent : null,
            shown: verbs.filter(v => !v.hidden).map(v => v.dataset.verb),
            moved: verbs.filter(v => v.hidden).map(v => v.dataset.verb),
            more: more !== null && !more.hidden ? more.getAttribute('aria-label') : null,
            moreLast: more !== null && el.lastElementChild === more,
            inside: r.left >= 0 && r.right <= window.innerWidth + 0.5,
            spills: el.scrollWidth > el.clientWidth + 0.5,
            description: el.getAttribute('aria-description'),
        };
    });

    /** The open "…" menu's entries: label, role, and a divider as `---`. */
    const moreMenu = () => page.$eval(`${BAR} .mep-object-menu`, panel => Array.from(panel.children).map(c => c.classList.contains('mep-menu-separator')
        ? '---'
        : `${(c as HTMLElement).dataset.entry}:${c.querySelector('.mep-entry-label')?.textContent}:${c.getAttribute('role')}${c.querySelector('.codicon-chevron-right') ? ':>' : ''}`));

    test('b1 a link in bold at 420: the title hidden, Remove and then Attributes of Bold… moved into "…", which names them; its entry removes the link with the undo hint; the bar still names its object on a rest', async function () {
        this.timeout(60000);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            await resize(420, 640);
            await showDocument();
            await barAt('bold docs', 3, 'link');
            const s = await barState();
            assert.strictEqual(s.title, null, `${t}: the title hidden`);
            // `overflowOrder`: Remove first, then from the right — Attributes of Bold… (measured: both leave at 420).
            assert.deepStrictEqual(s.moved, ['inline-attributes', 'remove-link'], `${t}: ${JSON.stringify(s)}`);
            assert.deepStrictEqual(s.shown, ['open-link', 'edit-link', 'link-attributes'], 'Edit… (first focus) stays');
            assert.strictEqual(s.more, 'More actions: Attributes of Bold…, Remove link, keep text');
            assert.ok(s.moreLast && s.inside && !s.spills, JSON.stringify(s));
            assert.ok(String(s.description).includes('Link'), `${t}: a rest on the bar names the object: ${s.description}`);
            await page.click(barMore);
            await page.waitForSelector(`${BAR} .mep-object-menu`);
            await delay(80);
            assert.deepStrictEqual(await moreMenu(), ['inline-attributes:Attributes of Bold…:menuitem', '---', 'remove-link:Remove link, keep text:menuitem']);
            await shot(`bars-420-link-open-${t}.png`);
            if (t === 'light') {
                await page.focus(`${BAR} .mep-object-menu [data-entry="remove-link"]`);
                await page.keyboard.press('Enter');
                await delay(200);
                assert.strictEqual(await page.$('.ProseMirror a'), null, 'the link removed');
                assert.match(await page.$eval('.mep-hint', el => el.textContent ?? ''), /^Link removed — (Ctrl|Cmd)\+Z$/);
            } else {
                await page.keyboard.press('Escape');
            }
        }
    });

    test('b2 a table at 420: Delete table, then Edit source, moved; "…" lists Edit source, a divider, Delete table; Alt+Enter focuses Row, End "…", Enter opens it, Esc returns', async function () {
        this.timeout(60000);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            await resize(420, 640);
            await showDocument();
            await barAt('Alpha', 2, 'table');
            const s = await barState();
            assert.deepStrictEqual([...s.moved].sort(), ['delete-table', 'edit-source'], `${t}: ${JSON.stringify(s)}`);
            assert.deepStrictEqual(s.shown, ['row', 'column', 'align', 'block-attributes']);
            assert.strictEqual(s.more, 'More actions: Edit source, Delete table');
            await page.keyboard.down('Alt');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Alt');
            await delay(100);
            assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.verb), 'row', 'Alt+Enter focuses Row');
            await page.keyboard.press('End');
            assert.ok(await page.evaluate(sel => document.activeElement === document.querySelector(sel), barMore), 'End focuses "…", never a hidden verb');
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${BAR} .mep-object-menu`);
            await delay(80);
            assert.deepStrictEqual(await moreMenu(), ['edit-source:Edit source:menuitem', '---', 'delete-table:Delete table:menuitem']);
            await shot(`bars-420-table-open-${t}.png`);
            await page.keyboard.press('Escape');
            await delay(50);
            assert.ok(await page.evaluate(sel => document.activeElement === document.querySelector(sel), barMore), 'Esc returns to "…"');
            await page.keyboard.press('Escape');
        }
    });

    test('b3 at 520 no bar needs "…"; the admonition\'s title is its short form "Warning", at 1280 "Warning admonition"; the link\'s title hidden', async function () {
        this.timeout(60000);
        for (const [theme, t] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as const) {
            await applyTheme(page, theme);
            await resize(520);
            await showDocument();
            for (const [needle, at, kind] of [['bold docs', 3, 'link'], ['Alpha', 2, 'table'], ['Admonition body', 3, 'admonition'], ['Inside the container', 3, 'container']] as const) {
                await barAt(needle, at, kind);
                const s = await barState();
                assert.strictEqual(s.more, null, `520 ${t}: ${kind} has no "…": ${JSON.stringify(s)}`);
                assert.deepStrictEqual(s.moved, [], `520 ${t}: ${kind}`);
                if (kind === 'admonition') {
                    assert.strictEqual(s.title, 'Warning', `520 ${t}: the short title`);
                    await shot(`bars-520-${t}.png`);
                }
                if (kind === 'link') {
                    assert.strictEqual(s.title, null, `520 ${t}: the link's title hidden`);
                }
            }
        }
        await applyTheme(page, LIGHT_MODERN);
        await resize(1280);
        await barAt('Admonition body', 3, 'admonition');
        assert.strictEqual((await barState()).title, 'Warning admonition');
    });

    test('b4 420 → 1280: every verb back on the bar, "…" hidden, full labels', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        assert.ok((await barState()).moved.length > 0);
        await resize(1280);
        await delay(200);
        const s = await barState();
        assert.deepStrictEqual(s.moved, []);
        assert.strictEqual(s.more, null);
        assert.ok(await page.$eval(`${BAR} [data-verb="delete-table"]`, el => el.textContent === 'Delete table'), 'the full label');
    });

    test('b5 at 240 a set-verb in "…": its entry has a chevron; Enter closes "…" and opens its menu under "…"; Esc returns to "…"', async function () {
        this.timeout(30000);
        await resize(240, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        const s = await barState();
        assert.ok(s.moved.includes('align'), `Align moved at 240: ${JSON.stringify(s)}`);
        await page.click(barMore);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await delay(80);
        const entries = await moreMenu();
        assert.ok(entries.includes('align:Align:menuitem:>'), `Align's entry has a chevron: ${entries}`);
        await page.focus(`${BAR} .mep-object-menu [data-entry="align"]`);
        await page.keyboard.press('Enter');
        await delay(120);
        const opened = await page.$eval(`${BAR} .mep-object-menu`, (panel, sel) => {
            const more = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const r = panel.getBoundingClientRect();
            return { entries: Array.from(panel.querySelectorAll<HTMLElement>('[data-entry]')).map(e => e.dataset.entry), under: r.top >= more.bottom - 0.5 || r.bottom <= more.top + 0.5 };
        }, barMore);
        assert.ok(!opened.entries.includes('align') && opened.under, `Align's own menu, under "…": ${JSON.stringify(opened)}`);
        await shot('bars-240-table-align-light.png');
        await page.keyboard.press('Escape');
        await delay(50);
        assert.ok(await page.evaluate(sel => document.activeElement === document.querySelector(sel), barMore), 'Esc returns to "…"');
        await page.keyboard.press('Escape');
    });

    // -- the bubble's "…" (Daniel, 2026-10-20) -------------------------------------

    const BUBBLE = '.mep-bubble:not([hidden])';

    /** A selection over `needle`'s first `length` characters, and the bubble shown for it. */
    const selectAndBubble = async (needle: string, length: number) => {
        await page.focus('.ProseMirror');
        await page.evaluate((n, len) => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf(n);
                if (at >= 0) {
                    (document.getSelection() as Selection).setBaseAndExtent(node, at, node, at + len);
                    return;
                }
            }
        }, needle, length);
        await page.waitForSelector(BUBBLE, { timeout: 5000 });
        await delay(150);
    };

    const bubbleState = () => page.$eval(BUBBLE, el => {
        const r = el.getBoundingClientRect();
        const more = el.querySelector<HTMLElement>('.mep-more-face');
        return {
            moved: Array.from(el.querySelectorAll<HTMLElement>('[data-action][hidden]')).map(b => b.dataset.action as string),
            more: more ? more.getAttribute('aria-label') : null,
            moreLast: more !== null && el.lastElementChild === more,
            inside: r.left >= 0 && r.right <= window.innerWidth + 0.5,
            spills: el.scrollWidth > el.clientWidth + 0.5,
        };
    });

    test('u1 the bubble at 1280 / 520 / 420 never spills past the window: what does not fit is in its "…", a prefix of BUBBLE_OVERFLOW', async function () {
        this.timeout(90000);
        for (const [theme, t] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as const) {
            await applyTheme(page, theme);
            for (const width of [1280, 520, 420]) {
                await resize(width, 640);
                await showDocument();
                await selectAndBubble('words, then', 5);
                const s = await bubbleState();
                assert.ok(s.inside && !s.spills, `${width} ${t}: inside the window: ${JSON.stringify(s)}`);
                assert.deepStrictEqual([...s.moved].sort(), BUBBLE_OVERFLOW.slice(0, s.moved.length).map(String).sort(), `${width} ${t}: a prefix of BUBBLE_OVERFLOW: ${s.moved}`);
                assert.strictEqual(s.more !== null, s.moved.length > 0, `${width} ${t}: "…" exactly when something moved`);
                if (width === 1280) {
                    assert.deepStrictEqual(s.moved, [], '1280: nothing moved');
                } else {
                    assert.ok(s.moved.length > 0 && s.moreLast, `${width}: something moved, "…" last`);
                }
                await shot(`bubble-${width}-${t}.png`);
            }
        }
    });

    test('u2 the bubble\'s "…" at 420 opens under it and leaves it shown; its entries in the bubble\'s order; one applies to the selection and closes it', async function () {
        this.timeout(60000);
        for (const [theme, t] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as const) {
            await applyTheme(page, theme);
            await resize(420, 640);
            await showDocument();
            await selectAndBubble('words, then', 5);
            const s = await bubbleState();
            await page.click(`${BUBBLE} .mep-more-face`);
            await page.waitForSelector(`${panel('bubble-more')}:not([hidden])`);
            await delay(100);
            const open = await page.$eval(panel('bubble-more'), (el, moreSel) => {
                const items = Array.from(el.children).filter(c => (c as HTMLElement).offsetParent !== null) as HTMLElement[];
                const face = (document.querySelector(moreSel) as HTMLElement).getBoundingClientRect();
                const r = el.getBoundingClientRect();
                return {
                    entries: items.map(i => (i.classList.contains('mep-menu-separator') ? '---' : i.dataset.action as string)),
                    inside: r.left >= 0 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5,
                    clearOfFace: r.top >= face.bottom - 0.5 || r.bottom <= face.top + 0.5,
                };
            }, `${BUBBLE} .mep-more-face`);
            assert.deepStrictEqual(open.entries.filter(e => e !== '---').sort(), [...s.moved].sort(), `${t}: every moved control has its entry`);
            assert.ok(open.inside && open.clearOfFace, `${t}: inside the window, clear of "…": ${JSON.stringify(open)}`);
            assert.ok(await page.$(BUBBLE), `${t}: the bubble stays shown while its "…" is open`);
            await shot(`bubble-more-420-${t}.png`);
            await page.keyboard.press('Escape');
            await page.mouse.click(5, 630);
            await delay(80);
        }
        // An entry applies to the selection: the first moved one, then everything closes.
        await applyTheme(page, LIGHT_MODERN);
        await showDocument();
        await selectAndBubble('words, then', 5);
        const first = (await bubbleState()).moved.find(id => id === 'strike') ?? (await bubbleState()).moved[0];
        await page.click(`${BUBBLE} .mep-more-face`);
        await page.waitForSelector(`${panel('bubble-more')}:not([hidden])`);
        await page.click(`${panel('bubble-more')} [data-action="${first}"]`);
        await delay(150);
        assert.strictEqual(await page.$eval(panel('bubble-more'), el => (el as HTMLElement).hidden), true, 'the menu closed');
        assert.ok(await page.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement).innerHTML.includes('words')), 'the text is still there');
    });

    test('r5 the row\'s "…" and a menu hosted in it hide the link\'s bar while open; it is back on close without a new rest', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument();
        const bar = '.mep-object-toolbar[data-trigger="selection"][data-object="link"]';
        await clickText(page, 'bold docs', 3);
        await page.waitForSelector(`${bar}:not([hidden])`, { timeout: 5000 });
        await page.focus(MORE);
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${panel('more')}:not([hidden])`);
        await delay(80);
        assert.ok(await page.$eval(bar, el => (el as HTMLElement).hidden), '"…" open: the bar hidden');
        await page.focus(`${panel('more')} [data-submenu="insert"]`);
        await page.keyboard.press('ArrowRight');
        await page.waitForSelector(`${panel('insert')}:not([hidden])`);
        await delay(80);
        assert.ok(await page.$eval(bar, el => (el as HTMLElement).hidden), 'a hosted menu open: the bar hidden still');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await delay(120);
        assert.ok(await page.$eval(bar, el => !(el as HTMLElement).hidden), 'closed: the bar is back');
    });

    // -- code review 1 of the build (fix round 1) -----------------------------------

    const focused = (selector: string) => page.evaluate(sel => document.activeElement === document.querySelector(sel), selector);

    test('r6 a resize alone — no transaction — names the row\'s "…" for what it holds now, and the dot follows', async function () {
        this.timeout(30000);
        await resize(1280, 640);
        await showDocument();
        await clickText(page, 'code', 2);
        await delay(100);
        assert.strictEqual((await rowState()).more.shown, false, 'nothing moved at 1280');
        await resize(420, 640);
        const narrow = await rowState();
        assert.strictEqual(narrow.more.shown, true);
        assert.strictEqual(narrow.more.label, moreName('row', ['Strong', 'Code', 'Formatting', 'Annotation', 'Insert'], ['Code']), 'named by the layout, not by the next transaction');
        assert.strictEqual(narrow.more.hasOn, true, 'the dot');
        await resize(1280, 640);
        assert.strictEqual((await rowState()).more.shown, false);
    });

    test('r7 a menu moved into "…" is refused by its entry as by its face: it opens nothing, pressed or hovered', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument('# Overflow\n\n```js\nconst x = 1;\n```\n');
        await clickText(page, 'const', 2);
        await delay(150);
        await page.click(MORE);
        await page.waitForSelector(`${panel('more')}:not([hidden])`);
        const disabled = await page.$$eval(`${panel('more')} [data-submenu]`, els => els.filter(e => e.getAttribute('aria-disabled') === 'true').map(e => (e as HTMLElement).dataset.submenu as string));
        assert.ok(disabled.length > 0, 'a code block refuses at least one whole menu');
        for (const id of disabled) {
            const entry = `${panel('more')} [data-submenu="${id}"]`;
            const box = await (await page.$(entry))?.boundingBox();
            assert.ok(box);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await delay(120);
            assert.strictEqual(await page.$eval(panel(id), el => (el as HTMLElement).hidden), true, `${id}: hover opens nothing`);
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            await delay(120);
            assert.strictEqual(await page.$eval(panel(id), el => (el as HTMLElement).hidden), true, `${id}: a press opens nothing`);
        }
    });

    test('u3 the bubble\'s "…": a second press on its face closes the menu; opened with the keyboard the bubble stays, Esc returns to the face', async function () {
        this.timeout(60000);
        await resize(420, 640);
        await showDocument();
        await selectAndBubble('words, then', 5);
        const face = `${BUBBLE} .mep-more-face`;
        const menu = `${panel('bubble-more')}:not([hidden])`;
        await page.click(face);
        await page.waitForSelector(menu);
        await page.click(face);
        await delay(120);
        assert.strictEqual(await page.$(menu), null, 'the second press closed it');
        assert.ok(await page.$(BUBBLE), 'the bubble stays');
        await page.focus(face);
        await page.keyboard.press('Enter');
        await page.waitForSelector(menu);
        await delay(150);
        assert.ok(await page.$(BUBBLE) && await page.$(menu), 'the keyboard opened it and the bubble is still up');
        assert.ok(await page.evaluate(() => document.querySelector('.mep-menu[data-menu="bubble-more"]')!.contains(document.activeElement)), 'the focus is in the menu');
        await page.keyboard.press('Escape');
        await delay(100);
        assert.strictEqual(await page.$(menu), null, 'Esc closed the menu');
        assert.ok(await focused(face), 'Esc returned the focus to "…"');
        assert.ok(await page.$(BUBBLE), 'the bubble is still there');
        // The focus leaving the menu for nowhere takes the bubble with it.
        await page.keyboard.press('Enter');
        await page.waitForSelector(menu);
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await delay(200);
        assert.strictEqual(await page.$(`${BUBBLE}`), null, 'the focus left: the bubble and its menu are gone');
        assert.strictEqual(await page.$(menu), null);
    });

    test('u4 the bubble\'s "…" entries draw the glyph their control draws in the bubble — sub, strike, the notes — not the Formatting menu\'s', async function () {
        this.timeout(60000);
        for (const [theme, t] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as const) {
            await applyTheme(page, theme);
            await resize(420, 640);
            await showDocument();
            await selectAndBubble('words, then', 5);
            await page.click(`${BUBBLE} .mep-more-face`);
            await page.waitForSelector(`${panel('bubble-more')}:not([hidden])`);
            await delay(100);
            const glyphs = await page.evaluate((ids, bubbleSel, menuSel) => ids.map(id => {
                const button = document.querySelector(`${bubbleSel} [data-action="${id}"]`) as HTMLElement;
                const entry = document.querySelector(`${menuSel} [data-action="${id}"]`) as HTMLElement;
                return {
                    id,
                    entry: entry.querySelector('.mep-entry-glyph .mep-sample')?.innerHTML ?? null,
                    face: button.querySelector('.mep-sample')?.innerHTML ?? null,
                    shown: entry.offsetParent !== null,
                };
            }), [...BUBBLE_OVERFLOW] as string[], BUBBLE, panel('bubble-more'));
            for (const g of glyphs) {
                assert.ok(g.face !== null && g.face !== '', `${g.id}: the face draws a glyph`);
                assert.strictEqual(g.entry, g.face, `${t} ${g.id}: the entry draws the face's glyph`);
            }
            assert.ok(glyphs.some(g => g.shown), 'some entries are in the menu');
            await shot(`bubble-more-glyphs-420-${t}.png`);
            await page.keyboard.press('Escape');
            await page.mouse.click(5, 630);
            await delay(80);
        }
    });

    test('b6 a bar\'s "…" menu is named "More actions"; inside "…" no entry has a hover, what it would add is its description; a set-verb through it keeps its label, its entries no hover either; a direct set-verb menu keeps its hovers', async function () {
        this.timeout(90000);
        await resize(420, 640);
        await showDocument();
        await barAt('bold docs', 3, 'link');
        await page.click(barMore);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await delay(100);
        const named = await page.$eval(`${BAR} .mep-object-menu`, el => ({ label: el.getAttribute('aria-label'), role: el.getAttribute('role') }));
        assert.deepStrictEqual(named, { label: 'More actions', role: 'menu' });
        const entry = `${BAR} .mep-object-menu [data-entry="remove-link"]`;
        assert.strictEqual(await page.$eval(entry, el => el.getAttribute('aria-description')), 'The link goes; its text stays.', 'the hover\'s text is the description');
        assert.strictEqual(await hoverTip(page, entry), null, 'no floating tooltip inside "…"');
        await shot('bars-420-link-open-notip-light.png');
        await page.keyboard.press('Escape');
        // A set-verb through "…" at 240: its menu is named by the verb, its entries have no hover.
        await resize(240, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        await page.click(barMore);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await page.focus(`${BAR} .mep-object-menu [data-entry="align"]`);
        await page.keyboard.press('Enter');
        await delay(120);
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-menu`, el => el.getAttribute('aria-label')), 'Align', 'named by the verb it opened');
        assert.strictEqual(await hoverTip(page, `${BAR} .mep-object-menu .mep-menu-item:not(.mep-disabled)`), null, 'its entries have no hover');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        // The same set-verb on the bar itself: named by the verb, its hovers kept.
        await resize(1280, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        await page.click(`${BAR} [data-verb="align"]`);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await delay(100);
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-menu`, el => el.getAttribute('aria-label')), 'Align');
        assert.ok(await hoverTip(page, `${BAR} .mep-object-menu .mep-menu-item:not(.mep-disabled)`), 'a direct menu\'s entries keep their hover');
        await page.keyboard.press('Escape');
    });

    test('b7 a bar\'s menu open when the bar is fitted again closes where its button is gone, or what "…" holds changed under it', async function () {
        this.timeout(60000);
        await resize(420, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        await page.click(barMore);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await resize(240, 640);
        await delay(300);
        assert.strictEqual(await page.$(`${BAR} .mep-object-menu`), null, '"…" grew: its open menu is stale and closed');
        // A set-verb menu on the bar whose verb then moves into "…": closed, not hanging from a hidden button.
        await resize(1280, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        await page.click(`${BAR} [data-verb="align"]`);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await resize(240, 640);
        await delay(300);
        assert.strictEqual(await page.$(`${BAR} .mep-object-menu`), null, 'its verb left the bar: the menu closed');
    });

    test('b8 a set-verb menu open through "…" opens again, still through "…", when the bar is drawn again', async function () {
        this.timeout(60000);
        await resize(240, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        await page.click(barMore);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await page.focus(`${BAR} .mep-object-menu [data-entry="align"]`);
        await page.keyboard.press('Enter');
        await delay(120);
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-menu`, el => el.getAttribute('aria-label')), 'Align');
        // Another extension's code action arrives for the table: the bar is drawn again with one verb more under the open menu.
        const request = (await (editor as EditorPage).posted()).filter(m => m.type === 'actionsFor').pop() as { requestId: number; blockIndex: number } | undefined;
        assert.ok(request, 'the page asked for the table\'s actions');
        await (editor as EditorPage).send({ type: 'actions', requestId: request.requestId, blockIndex: request.blockIndex, items: [{ id: 'b.0', title: 'Fix table', kind: 'quickfix' }] });
        await page.waitForSelector(`${BAR} [data-verb="code-action:b.0"]`, { timeout: 3000 });
        await delay(300);
        const again = await page.$eval(`${BAR} .mep-object-menu`, (el, sel) => ({
            label: el.getAttribute('aria-label'),
            underMore: (document.querySelector(sel) as HTMLElement).getAttribute('aria-expanded'),
        }), barMore);
        assert.deepStrictEqual(again, { label: 'Align', underMore: 'true' });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
    });

    // -- Export names the running format; Export in the narrowest row ----------------

    test('e2 Export busy answered `busy` names the format that runs — the host\'s, not the one the page asked for', async function () {
        this.timeout(30000);
        await resize(1280, 640);
        await showDocument();
        await clickText(page, 'Plain', 2);
        const EXPORT = `${ROW} .mep-menu-face[data-menu="export"]`;
        await page.click(EXPORT);
        await page.waitForSelector(`${panel('export')}:not([hidden])`);
        await page.click(`${panel('export')} [data-export="png"]`);
        await delay(120);
        assert.strictEqual(await page.$eval(`${EXPORT} .mep-face-label`, el => el.textContent), 'Exporting PNG image…', 'the page shows what it asked for');
        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'busy', format: 'pdf' });
        await delay(120);
        assert.strictEqual(await page.$eval(`${EXPORT} .mep-face-label`, el => el.textContent), 'Exporting PDF…', 'busy: the host\'s running format');
        assert.strictEqual(await page.$eval(`${EXPORT}`, el => el.getAttribute('aria-description')), 'Exporting PDF…\nExporting PDF — the other formats wait for it');
        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'settled' });
        await delay(120);
    });

    test('e3 below the width where everything fits Export shows its icon alone — its name its accessible name — and is never cut; wider, its name', async function () {
        this.timeout(120000);
        const EXPORT = `${ROW} .mep-menu-face[data-menu="export"]`;
        const face = () => page.$eval(EXPORT, (el, rowSel) => {
            const row = document.querySelector(rowSel) as HTMLElement;
            const r = el.getBoundingClientRect();
            const label = el.querySelector('.mep-face-label') as HTMLElement;
            const count = document.querySelector('.mep-toolbar .mep-diag-count:not([hidden])') as HTMLElement | null;
            return {
                labelShown: label.offsetParent !== null,
                name: el.getAttribute('aria-label'),
                inside: r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5,
                scrolls: row.scrollWidth > row.clientWidth,
                chevron: el.querySelector('.mep-menu-caret') !== null && (el.querySelector('.mep-menu-caret') as HTMLElement).offsetParent !== null,
                icon: el.querySelector(':scope > .mep-face-icon .codicon-export') !== null,
                countWhole: count === null || count.scrollWidth <= count.clientWidth + 1,
                tip: el.getAttribute('aria-description'),
            };
        }, ROW);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            await resize(420, 640);
            await showDocument();
            const wide = await face();
            assert.deepStrictEqual([wide.labelShown, wide.name, wide.inside], [true, null, true], `${t} 420: the name`);
            for (const width of [280, 240, 200]) {
                await resize(width, 640);
                await showDocument();
                const s = await face();
                assert.ok(s.inside && !s.scrolls && s.countWhole, `${t} ${width}: Export and the count whole, the row not scrolling: ${JSON.stringify(s)}`);
                if (!s.labelShown) {
                    assert.deepStrictEqual([s.name, s.chevron, s.icon, s.tip], ['Export', true, true, 'Export'], `${t} ${width}: icon alone, named`);
                }
                if (width === 240) {
                    assert.strictEqual(s.labelShown, false, `${t} 240: icon alone`);
                    await shot(`export-240-${t}.png`);
                }
            }
            // Busy at 240: the icon spins, the name of the format is the face's name.
            await page.click(EXPORT);
            await page.waitForSelector(`${panel('export')}:not([hidden])`);
            await page.click(`${panel('export')} [data-export="html"]`);
            await delay(150);
            const busy = await face();
            assert.deepStrictEqual([busy.labelShown, busy.name, busy.inside], [false, 'Exporting HTML…', true], `${t} busy at 240`);
            await (editor as EditorPage).send({ type: 'exportDone', outcome: 'settled' });
            await delay(120);
        }
    });

    test('l6 at 380 the source lock stands whole in the row, its keys kept — the whole reason, else its short form — and Export and the count are not cut', async function () {
        this.timeout(60000);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            await resize(380, 640);
            await showDocument();
            await clickText(page, 'Plain', 2);
            await openYaml();
            const text = await page.$eval(`${ROW} .mep-row-lock-text`, el => el.textContent);
            assert.ok(text === LOCK_SOURCE || text === `Source · ${MOD_NAME}+Enter · Esc`, `${t}: a form of the reason: ${text}`);
            // Not compared with where Export stood: it may give its name up for the reason's room.
            await assertReasonShown(page, `380 ${t}`, LOCK_SOURCE, text === LOCK_SOURCE ? 'inrow' : 'short');
            assert.ok(await page.$eval(`${ROW} .mep-menu-face[data-menu="export"]`, el => el.getBoundingClientRect().right <= document.documentElement.clientWidth + 0.5), `${t}: Export inside the window`);
            await shot(`lock-source-380-${t}.png`);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
        }
    });
});
