import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { BUBBLE_OVERFLOW, ROW_OVERFLOW } from '../../../src/editor/webview/toolbar/actions';
import { moreName } from '../../../src/editor/webview/overflow';
import { GAP, LAYER_GUTTER } from '../../../src/editor/webview/placement';
import { EXTENSION_ID, EditorPage, clickText, closeEditorPage, delay, describedTip, hoverTip, openEditorPage, shot as saveShot, showDiagnostics } from './pageHarness';
import { LOCK_BUTTON, LOCK_PROPERTY, LOCK_SOURCE, MOD_NAME, assertReasonShown, assertRowLocked, inRowForm, narrowestWidth, noteRoom, rowBoxes } from './rowLock';
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

    test('l3 down to where it fits (Segoe UI 420, the system font on macOS wider) the whole reason in the row; narrower its short form, whole, keys kept, its hover and the row\'s description the whole reason; Esc gives the row back; a property\'s field the same', async function () {
        this.timeout(120000);
        // Where the whole reason stops fitting is the font's: found, and the row checked to have had no room to spare there.
        const fitsWhole = async (width: number) => {
            await resize(width, 640);
            await showDocument();
            await clickText(page, 'Plain', 2);
            await openYaml();
            const text = await page.$eval(`${ROW} .mep-row-lock-text`, el => el.textContent);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await delay(150);
            return text === LOCK_SOURCE;
        };
        const whole = await narrowestWidth(340, 520, fitsWhole);
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            for (const [width, where] of [[whole, 'inrow'], [340, 'short']] as const) {
                await resize(width, 640);
                await showDocument();
                await clickText(page, 'Plain', 2);
                const moved = (await rowState()).moved;
                const before = await rowBoxes(page);
                await openYaml();
                await assertReasonShown(page, `${width} ${t}`, LOCK_SOURCE, where, before);
                // The form the room calls for: at the edge the whole reason left less than a pixel and a half; narrower the whole would not fit.
                assert.strictEqual(await inRowForm(page, LOCK_SOURCE), where, `${width} ${t}: the form the room calls for`);
                if (where === 'inrow') {
                    assert.ok((await noteRoom(page) as number) < 1.5, `${width} ${t}: the whole reason went at the last width it fit (${await noteRoom(page)} px to spare)`);
                }
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

    test('l4 a button\'s lock: at 900 and 860 "Outside the text" beside the tools; at 800, 640 and 520 the refused tools give way into the disabled "…" and it stands in the row; the whole reason its hover', async function () {
        this.timeout(120000);
        for (const width of [900, 860, 800, 640, 520]) {
            await resize(width);
            await showDocument();
            await clickText(page, 'Plain', 2);
            const before = await rowBoxes(page);
            const idle = (await rowState()).moved;
            await openYaml();
            await page.keyboard.press('Escape');
            await delay(150);
            await assertReasonShown(page, `${width}, a button`, LOCK_BUTTON, 'short', before);
            assert.strictEqual(await describedTip(page, `${ROW} .mep-row-lock`), LOCK_BUTTON, `${width}: the short form's hover is the whole reason`);
            const s = await rowState();
            if (width < 860) {
                assert.ok(s.moved.length > idle.length, `${width}: tools gave way into "…" for it: ${idle} -> ${s.moved}`);
                assert.deepStrictEqual([...s.moved].sort(), prefix(s.moved.length), `${width}: a prefix of ROW_OVERFLOW`);
                assert.strictEqual(await page.$eval(MORE, el => el.getAttribute('aria-disabled')), 'true', `${width}: "…" is disabled under the lock`);
            }
            await shot(`lock-button-${width}-light.png`);
            await page.keyboard.press('Escape');
            await delay(150);
            assert.deepStrictEqual((await rowState()).moved, idle, `${width}: the lock gone, the row is as it was`);
        }
    });

    test('l7 a button\'s lock still shows "Outside the text" down to the last width it fits (Segoe UI about 380, the system font on macOS wider); below it, and at 340, no note — the tools only dim, the row describes itself with the whole reason', async function () {
        this.timeout(120000);
        const buttonLock = async (width: number) => {
            await resize(width);
            await showDocument();
            await clickText(page, 'Plain', 2);
            await openYaml();
            await page.keyboard.press('Escape');
            await delay(150);
        };
        // Where even the short form stops fitting is the font's: found, and the row checked to have had no room to spare there.
        const last = await narrowestWidth(340, 520, async width => {
            await buttonLock(width);
            const shown = await page.$eval(`${ROW} .mep-row-lock`, el => !(el as HTMLElement).hidden && el.getClientRects().length > 0);
            await page.keyboard.press('Escape');
            return shown;
        });
        for (const [width, where] of [[last, 'short'], [last - 1, 'hidden'], [340, 'hidden']] as const) {
            await buttonLock(width);
            await assertReasonShown(page, `${width}, a button`, LOCK_BUTTON, where);
            if (where === 'short') {
                assert.ok((await noteRoom(page) as number) < 1.5, `${width}: the note went at the last width it fit (${await noteRoom(page)} px to spare)`);
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
                assert.deepStrictEqual(await face(), { label, spins: true, busy: 'true', title: 'Exporting HTML…\nOne export at a time — HTML is running' }, `${width} ${t}`);
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
                    assert.deepStrictEqual(entries.slice(1, 4).map(e => e.note), ['PDF', 'PNG image', 'JPEG image'].map(f => `${f} waits for HTML — choose it again when HTML is done.`));
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

    /**
     * The caret at `needle` (+`at`), and its bar shown for `kind`. The caret goes
     * through plain text first: what Esc dismissed stays dismissed until the
     * caret has left the object (placement review 2), also across a document
     * sent again, so an earlier test's Esc would keep this bar away.
     */
    const barAt = async (needle: string, at: number, kind: string) => {
        // At the top: a page an earlier test left scrolled has "Plain" out of the window, where no click reaches it.
        await page.evaluate(() => window.scrollTo(0, 0));
        await clickText(page, 'Plain', 2);
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

    test('b3 at 520 each bar shows "…" only where its verbs do not fit, and its title whole, short or hidden as the room allows (measured); at 1280 the admonition\'s "Warning admonition"', async function () {
        this.timeout(60000);
        // What the bar needs, measured on a copy without the room's cap — every verb on it, its title (the form it took) shown
        // whole or left out — against the room it may take, worked out here and not read from the product's own max-width: from
        // its column's left edge to the editor's right edge less the gutter (a bar may go past the column), but `GAP` short of
        // the notes where the stylesheet reserves a margin lane for them (the page's right padding; the lane begins at the
        // column plus the nearer of the note and sidebar gaps), and never less than the column. Where that falls is the font's.
        const needs = () => page.$eval(BAR, (bar, gutter, gap) => {
            const mount = (bar.parentElement as HTMLElement).getBoundingClientRect();
            let edge = document.documentElement.clientWidth - gutter;
            if (parseFloat(getComputedStyle(document.documentElement).paddingRight) > 0) {
                const body = getComputedStyle(document.body);
                const column = document.body.getBoundingClientRect().right - (parseFloat(body.paddingRight) || 0);
                const gaps = ['--md-note-gap', '--md-sidebar-gap'].map(n => parseFloat(body.getPropertyValue(n))).filter(n => !isNaN(n));
                edge = Math.min(edge, column + (gaps.length > 0 ? Math.min(...gaps) : 0) - gap);
            }
            const room = Math.max(mount.right, edge) - mount.left;
            const width = (title: boolean) => {
                const copy = bar.cloneNode(true) as HTMLElement;
                copy.querySelector(':scope > .mep-object-more')?.remove();
                for (const hidden of Array.from(copy.querySelectorAll<HTMLElement>(':scope > [data-verb], :scope > .mep-object-separator'))) {
                    hidden.hidden = false;
                }
                const label = copy.querySelector(':scope > .mep-object-label') as HTMLElement;
                label.hidden = !title;
                Object.assign(copy.style, { maxWidth: 'none', left: '0px', visibility: 'hidden' });
                (bar.parentElement as HTMLElement).append(copy);
                const need = { bar: copy.getBoundingClientRect().width, label: title ? label.getBoundingClientRect().width : 0 };
                copy.remove();
                return need;
            };
            const bare = width(false);
            const titled = width(true);
            return {
                // "…" only where the verbs do not fit even with the title gone.
                more: bare.bar > room + 1,
                // The title whole where it fits; cut where it does not; hidden where what is left of it is under the stub (42 px).
                title: titled.bar <= room + 1 ? 'whole' : room - (titled.bar - titled.label) < 42 ? 'hidden' : 'cut',
            };
        }, LAYER_GUTTER, GAP);
        for (const [theme, t] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as const) {
            await applyTheme(page, theme);
            await resize(520);
            await showDocument();
            for (const [needle, at, kind] of [['bold docs', 3, 'link'], ['Alpha', 2, 'table'], ['Admonition body', 3, 'admonition'], ['Inside the container', 3, 'container']] as const) {
                await barAt(needle, at, kind);
                const s = await barState();
                const need = await needs();
                assert.strictEqual(s.more !== null, need.more, `520 ${t}: ${kind} has ${need.more ? '' : 'no '}"…" (measured): ${JSON.stringify(s)}`);
                if (need.more) {
                    assert.ok(s.moved.length > 0 && s.title === null && s.inside && !s.spills, `520 ${t}: ${kind}: ${JSON.stringify(s)}`);
                    continue;
                }
                assert.deepStrictEqual(s.moved, [], `520 ${t}: ${kind}`);
                assert.strictEqual(s.title === null, need.title === 'hidden', `520 ${t}: ${kind}'s title ${need.title} (measured): ${JSON.stringify(s)}`);
                if (kind === 'admonition') {
                    if (s.title !== null) {
                        assert.strictEqual(s.title, 'Warning', `520 ${t}: the short title`);
                    }
                    await shot(`bars-520-${t}.png`);
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
        assert.strictEqual(await page.$eval(`${EXPORT}`, el => el.getAttribute('aria-description')), 'Exporting PDF…\nOne export at a time — PDF is running');
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

    // -- review round 3: focus, the menus a layout leaves open, a redrawn bar ------------

    /** The row narrowed to `width` with the window as it is: the observer lays it out, no `resize` is fired (which would close every menu). */
    const narrowRow = async (width: number) => {
        await page.$eval(ROW, (row, w) => { (row as HTMLElement).style.right = `${document.documentElement.clientWidth - w}px`; }, width);
        await delay(120);
    };
    const widenRow = () => page.$eval(ROW, row => (row as HTMLElement).style.removeProperty('right'));

    test('f1 the focus on a row control that a layout moves into "…" goes to "…", not to the body', async function () {
        this.timeout(30000);
        await resize(1280, 640);
        await showDocument();
        await clickText(page, 'Plain', 2);
        const INSERT = `${ROW} .mep-menu-face[data-menu="insert"]`;
        await page.focus(INSERT);
        assert.ok(await focused(INSERT), 'Insert has the focus');
        await resize(420, 640);
        await delay(100);
        assert.ok((await rowState()).moved.includes('insert'), 'Insert moved into "…"');
        assert.ok(await focused(MORE), 'the focus is on "…"');
    });

    /** What a font that loaded late does: the row, the bubble and the bars measure again, with no change of size or content. */
    const refit = () => page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')));

    test('f2 "…" with the focus keeps it through a fit — in the bubble, on a bar, in the row', async function () {
        this.timeout(60000);
        // The bubble: taken out of it and put back by the measurement.
        await resize(420, 640);
        await showDocument();
        await selectAndBubble('words, then', 5);
        const bubbleFace = `${BUBBLE} .mep-more-face`;
        await page.focus(bubbleFace);
        assert.ok(await focused(bubbleFace), 'the bubble "…" has the focus');
        await delay(300);
        assert.ok(await page.$(BUBBLE) && await focused(bubbleFace), 'the bubble stays with the focus on its "…" before any fit');
        await refit();
        await delay(250);
        assert.ok(await page.$(BUBBLE), `the bubble stays: ${await page.evaluate(() => { const a = document.activeElement as HTMLElement; const b = document.querySelector('.mep-bubble') as HTMLElement | null; return `active ${a.tagName}.${a.className}; bubble ${b === null ? 'none' : `hidden=${b.hidden} ${b.innerHTML.length}`}`; })}`);
        assert.ok(await focused(bubbleFace), 'the bubble "…" still has the focus after the fit');
        // A bar.
        await resize(420, 640);
        await showDocument();
        await barAt('Alpha', 2, 'table');
        await page.focus(barMore);
        assert.ok(await focused(barMore), 'the bar "…" has the focus');
        await refit();
        await delay(300);
        assert.ok(await page.$(BAR), 'the bar stays');
        assert.ok(await focused(barMore), 'the bar "…" still has the focus after the fit');
        // The row.
        await showDocument();
        await clickText(page, 'Plain', 2);
        await page.focus(MORE);
        assert.ok(await focused(MORE), 'the row "…" has the focus');
        await refit();
        await delay(150);
        assert.ok(await focused(MORE), 'the row "…" still has the focus after the layout');
    });

    test('f3 a layout that changes what "…" holds closes the menus whose trigger moved — and no other: a menu read in the row stays open', async function () {
        this.timeout(60000);
        await resize(1280, 640);
        await showDocument();
        await clickText(page, 'Plain', 2);
        try {
            const FORMATTING = `${ROW} .mep-menu-face[data-menu="formatting"]`;
            const open = (menu: string) => page.$eval(panel(menu), el => !(el as HTMLElement).hidden);
            await narrowRow(1000);
            assert.deepStrictEqual((await rowState()).moved, [], 'nothing moved at 1000');
            // By the keys, so the focus is in the menu (a press leaves it in the text).
            await page.focus(FORMATTING);
            await page.keyboard.press('ArrowDown');
            await page.waitForSelector(`${panel('formatting')}:not([hidden])`);
            assert.ok(await page.evaluate(sel => document.querySelector(sel)!.contains(document.activeElement), panel('formatting')), 'the focus is in the menu');
            // Ten pixels at a time: Annotation leaves first and Formatting is still in the row, its menu read; then it leaves too.
            let annotationOnly = 0;
            for (let width = 1000; width > 200; width -= 10) {
                await narrowRow(width);
                const moved = (await rowState()).moved;
                if (moved.includes('formatting')) {
                    assert.strictEqual(await open('formatting'), false, `${width}: Formatting itself moved, its menu is closed`);
                    assert.ok(await focused(MORE), `${width}: the focus it held is on "…"`);
                    break;
                }
                assert.strictEqual(await open('formatting'), true, `${width}: Formatting is in the row still, its menu stays open (moved: ${moved})`);
                if (moved.includes('annotation')) {
                    annotationOnly = width;
                }
            }
            assert.ok(annotationOnly > 0, 'a width where Annotation alone had moved was met');
            // A menu opened through "…" closes when what "…" holds changes under it.
            await widenRow();
            await narrowRow(annotationOnly);
            await page.focus(MORE);
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${panel('more')}:not([hidden])`);
            // The count beside Export changes: the row is laid out again with its entries shown and hidden — and the focus is not dropped out of the menu it is in.
            await showDiagnostics(editor as EditorPage, version, [{ range: { start: { line: 7, character: 0 }, end: { line: 7, character: 5 } }, severity: 'warning', message: 'One' }]);
            await delay(150);
            const inMenu = await page.evaluate(sel => document.querySelector(sel)!.contains(document.activeElement), panel('more'));
            assert.ok(inMenu ? await open('more') : await focused(MORE), `the focus is in the open menu or, the menu closed, on "…" (open: ${await open('more')})`);
            if (!(await open('more'))) {
                await page.focus(MORE);
                await page.keyboard.press('Enter');
                await page.waitForSelector(`${panel('more')}:not([hidden])`);
            }
            await narrowRow(annotationOnly - 200);
            assert.strictEqual(await open('more'), false, '"…" holds more now: its open menu is stale and closed');
            assert.ok(await focused(MORE), 'the focus is on "…"');
        } finally {
            await widenRow();
        }
    });

    test('f4 "…"\'s list open when the bar is drawn again is open again, where "…" is still in the bar', async function () {
        this.timeout(60000);
        await resize(240, 640);
        // A table no earlier test asked about: the page asks once for a block it still holds as it was.
        await showDocument(SOURCE.replace('| Alpha | 1 |', '| Alpha | f4 |'));
        const asked = async () => (await (editor as EditorPage).posted()).filter(m => m.type === 'actionsFor');
        const before = (await asked()).length;
        await barAt('Alpha', 2, 'table');
        await page.click(barMore);
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        for (let i = 0; i < 30 && (await asked()).length === before; i++) {
            await delay(100);
        }
        const request = (await asked()).pop() as { requestId: number; blockIndex: number } | undefined;
        assert.ok(request && (await asked()).length > before, 'the page asked for the table\'s actions');
        // The person is on the list's second entry when the bar is drawn again.
        await page.keyboard.press('ArrowDown');
        const onEntry = () => page.evaluate(() => (document.activeElement as HTMLElement).dataset.entry ?? null);
        const was = await onEntry();
        assert.ok(was !== null, 'the focus is on an entry of the list');
        await (editor as EditorPage).send({ type: 'actions', requestId: request.requestId, blockIndex: request.blockIndex, items: [{ id: 'f4.0', title: 'Fix the table (f4)', kind: 'quickfix' }] });
        await page.waitForSelector(`${BAR} [data-verb="code-action:f4.0"]`, { timeout: 3000 });
        await delay(300);
        assert.strictEqual(await onEntry(), was, 'the reopened list has the focus on the entry it was on');
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-menu`, el => el.getAttribute('aria-label')), 'More actions', 'its list is open again');
        assert.strictEqual(await page.$eval(barMore, el => el.getAttribute('aria-expanded')), 'true');
        assert.ok((await moreMenu()).some(e => e.startsWith('code-action:f4.0')), 'with the verb the bar drew since');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
    });

    test('f5 the running export\'s spinner in its menu entry is drawn once: an update keeps the node, so the animation runs on', async function () {
        this.timeout(30000);
        await resize(1280, 640);
        await showDocument();
        await clickText(page, 'Plain', 2);
        const EXPORT = `${ROW} .mep-menu-face[data-menu="export"]`;
        await page.click(EXPORT);
        await page.waitForSelector(`${panel('export')}:not([hidden])`);
        await page.click(`${panel('export')} [data-export="html"]`);
        await delay(120);
        const SPIN = `${panel('export')} [data-export="html"] > .mep-entry-busy`;
        await page.$eval(SPIN, el => { (el as HTMLElement & { drawnOnce?: boolean }).drawnOnce = true; });
        // Updates: the caret moves, the face and the entries are read again.
        await clickText(page, 'words', 2);
        await clickText(page, 'Plain', 2);
        await delay(100);
        assert.strictEqual(await page.$eval(SPIN, el => (el as HTMLElement & { drawnOnce?: boolean }).drawnOnce === true), true, 'the same spinner node');
        await (editor as EditorPage).send({ type: 'exportDone', outcome: 'settled' });
        await delay(120);
        assert.strictEqual(await page.$(SPIN), null, 'done: no spinner');
    });

    test('f6 the row never scrolls — not by a script, nor by a control focused past its edge', async function () {
        this.timeout(30000);
        await resize(1280, 640);
        await showDocument();
        await clickText(page, 'Plain', 2);
        try {
            // So narrow that even "…" with everything in it leaves the row too wide: its content stands past the box.
            await narrowRow(150);
            const scrollLeft = () => page.$eval(ROW, row => (row as HTMLElement).scrollLeft);
            await page.focus(`${ROW} .mep-menu-face[data-menu="export"]`);
            await delay(100);
            assert.strictEqual(await scrollLeft(), 0, 'a control focused past the edge did not scroll the row');
            await page.$eval(ROW, row => { (row as HTMLElement).scrollLeft = 40; });
            await delay(100);
            assert.strictEqual(await scrollLeft(), 0, 'a script that scrolled it is undone');
        } finally {
            await widenRow();
        }
    });

    test('f7 an entry of "…" is the same thing at its birth and after each update: role, check, refusal, description', async function () {
        this.timeout(30000);
        await resize(420, 640);
        const entries = () => page.$$eval(`${panel('more')} [data-action]`, els => els.map(el => ({
            id: (el as HTMLElement).dataset.action as string,
            role: el.getAttribute('role'),
            checked: el.getAttribute('aria-checked'),
            active: el.classList.contains('mep-active'),
            disabled: el.getAttribute('aria-disabled'),
            dimmed: el.classList.contains('mep-disabled'),
            description: el.getAttribute('aria-description'),
        })));
        // In bold code the entry of Code is checked, offered, and says nothing; away from it, unchecked.
        await showDocument();
        await clickText(page, 'code', 2);
        await delay(150);
        assert.deepStrictEqual((await entries()).find(e => e.id === 'code'), { id: 'code', role: 'menuitemcheckbox', checked: 'true', active: true, disabled: 'false', dimmed: false, description: null });
        await clickText(page, 'Plain', 2);
        await delay(150);
        assert.deepStrictEqual((await entries()).find(e => e.id === 'code'), { id: 'code', role: 'menuitemcheckbox', checked: 'false', active: false, disabled: 'false', dimmed: false, description: null });
        // A code block refuses the marks: the entry is disabled and dimmed together.
        await showDocument('# Overflow\n\n```js\nconst x = 1;\n```\n');
        await clickText(page, 'const', 2);
        await delay(150);
        const refused = (await entries()).filter(e => e.disabled === 'true');
        assert.ok(refused.length > 0, 'a code block refuses a mark');
        assert.ok(refused.every(e => e.dimmed), 'refused is dimmed');
        // The row locked by a button: every entry is refused and says why, to a screen reader.
        await showDocument();
        await openYaml();
        await page.keyboard.press('Escape');
        await delay(150);
        const locked = await entries();
        assert.ok(locked.length > 0 && locked.every(e => e.disabled === 'true' && e.dimmed && e.description === LOCK_BUTTON), `refused with the reason: ${JSON.stringify(locked.slice(0, 2))}`);
        await page.keyboard.press('Escape');
        await delay(150);
        assert.ok((await entries()).every(e => e.disabled === 'false' && !e.dimmed && e.description === null), 'the lock gone: offered, and nothing said');
    });

    test('f8 a keyboard Enter on an entry of the bubble\'s "…" applies it and the bubble stays', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument();
        await selectAndBubble('words, then', 5);
        await page.focus(`${BUBBLE} .mep-more-face`);
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${panel('bubble-more')}:not([hidden])`);
        await delay(150);
        const entry = await page.evaluate(() => (document.activeElement as HTMLElement).dataset.action ?? null);
        assert.ok(entry !== null, 'the focus is on an entry of the menu');
        await page.keyboard.press('Enter');
        await delay(300);
        assert.strictEqual(await page.$(`${panel('bubble-more')}:not([hidden])`), null, 'the menu closed');
        assert.ok(await page.$(BUBBLE), 'the bubble stays');
        assert.ok(await page.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement).textContent?.includes('words, then')), 'the text is still there');
    });

    test('f9 a caret in the text, the row laid out again — narrower, then wider: the focus stays in the text', async function () {
        this.timeout(30000);
        await resize(1280, 640);
        await showDocument();
        await clickText(page, 'Plain', 2);
        const inText = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.ProseMirror') !== null && document.activeElement !== document.body);
        assert.ok(await inText(), 'the caret is in the text');
        await resize(420, 640);
        await delay(150);
        assert.ok((await rowState()).moved.length > 0, 'the row moved controls into "…"');
        assert.ok(await inText(), 'narrower: the focus stays in the text');
        await resize(1280, 640);
        await delay(150);
        assert.deepStrictEqual((await rowState()).moved, [], 'everything back in the row');
        assert.ok(await inText(), 'wider: the focus stays in the text');
        await refit();
        await delay(150);
        assert.ok(await inText(), 'a measurement alone: the focus stays in the text');
    });

    test('f10 the focus on a bubble control that a fit hides goes to the bubble\'s "…" — the bubble stays', async function () {
        this.timeout(60000);
        const first = BUBBLE_OVERFLOW[0];
        await resize(900, 640);
        await showDocument();
        await selectAndBubble('words, then', 5);
        const control = `${BUBBLE} [data-action="${first}"]`;
        const face = `${BUBBLE} .mep-more-face`;
        assert.ok((await bubbleState()).moved.length === 0 && await page.$(control), 'at 900 nothing has left the bubble');
        await page.focus(control);
        assert.ok(await focused(control), 'the control has the focus');
        await resize(420, 640);
        await delay(300);
        const s = await page.evaluate(() => {
            const a = document.activeElement as HTMLElement;
            return { tag: a.tagName, className: a.className, data: a.dataset.action ?? null, bubble: document.querySelector('.mep-bubble:not([hidden])') !== null };
        });
        assert.ok(s.bubble, `the bubble stays: ${JSON.stringify(s)}`);
        assert.ok((await bubbleState()).moved.includes(first as string), `the control moved into "…": ${JSON.stringify(await bubbleState())}`);
        assert.ok(await focused(face), `the focus is on the bubble's "…": ${JSON.stringify(s)}`);
    });

    test('f11 "…" with the focus, nothing left in it after a layout: the focus goes to a control of the row, not to the body', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument();
        await clickText(page, 'Plain', 2);
        await page.focus(MORE);
        assert.ok(await focused(MORE), 'the row "…" has the focus');
        await resize(1280, 640);
        await delay(200);
        const s = await page.evaluate(() => {
            const a = document.activeElement as HTMLElement;
            return { tag: a.tagName, menu: a.dataset.menu ?? null, inRow: a.closest('.mep-toolbar') !== null };
        });
        assert.ok(s.inRow && s.menu === 'block-type', `the focus is on Block type: ${JSON.stringify(s)}`);
    });

    test('f12 Esc on the bubble\'s "…" with its menu open closes the menu and no more: the bubble stays', async function () {
        this.timeout(30000);
        await resize(420, 640);
        await showDocument();
        await selectAndBubble('words, then', 5);
        const face = `${BUBBLE} .mep-more-face`;
        // The menu opened by a press, the focus on the face (the keys' own opening puts it in the menu).
        await page.focus(face);
        await page.click(face);
        await page.waitForSelector(`${panel('bubble-more')}:not([hidden])`);
        assert.ok(await focused(face), 'the focus is on the face, the menu open');
        await page.keyboard.press('Escape');
        await delay(200);
        assert.strictEqual(await page.$(`${panel('bubble-more')}:not([hidden])`), null, 'the menu closed');
        assert.ok(await page.$(BUBBLE), 'the bubble stays');
    });
});
