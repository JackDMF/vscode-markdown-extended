import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { ROW_OVERFLOW } from '../../../src/editor/webview/toolbar/actions';
import { moreName } from '../../../src/editor/webview/overflow';
import { EXTENSION_ID, EditorPage, clickText, closeEditorPage, delay, describedTip, openEditorPage, shot as saveShot, showDiagnostics } from './pageHarness';
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

    const showDocument = async (text = SOURCE) => {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
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

    test('l4 a button\'s lock: at 900 "Focus is outside the text" beside the tools, which dim; at 520 no note, Bold\'s tooltip says the whole reason', async function () {
        this.timeout(40000);
        for (const width of [900, 520]) {
            await resize(width);
            await showDocument();
            await clickText(page, 'Plain', 2);
            const before = await rowBoxes(page);
            await openYaml();
            await page.keyboard.press('Escape');
            await delay(150);
            if (width === 900) {
                await assertReasonShown(page, '900, a button', LOCK_BUTTON, 'short', before);
            } else {
                await assertReasonShown(page, '520, a button', LOCK_BUTTON, 'hidden', before);
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
});
