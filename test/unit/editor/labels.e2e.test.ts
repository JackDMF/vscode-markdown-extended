import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { FEWER_TYPES, MORE_TYPES } from '../../../src/editor/webview/toolbar/actions';
import { ADMONITION_FAMILIES } from '../../../src/syntax/markers';
import {
    EXTENSION_ID, EditorPage, clickText, closeEditorPage, computedColour as computed, delay, describedTip, hoverTip, openEditorPage, shot as saveShot,
} from './pageHarness';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, LIGHT_PLUS, Theme, applyTheme } from './themes';

/** The sketch's document (`wave1-sketches/labels/sketch.js`, `DOC`), as Markdown, and a source block to lock the row with. */
const SOURCE = [
    '# Offline Sync',
    '',
    'The mobile client keeps a **local replica** of the user’s workspace, so edits keep working without a connection. Changes are queued and sent with `POST /sync/batch` once the device is back online; see the [API reference](api.md) for the payload.',
    '',
    '## Goals',
    '',
    '- Edits made offline are never lost.',
    '- A conflict is shown to the user, not resolved silently.',
    '- Sync completes within **5 seconds** for a typical day’s work.',
    '',
    '## Sync sequence',
    '',
    '1. The client compares its `lastSyncToken` with the server’s.',
    '2. Local changes are sent in batches of at most 200.',
    '3. Remote changes are applied in order, oldest first.',
    '',
    'Conflicts follow the server’s `last-writer-wins` rule, with an audit entry for every override.',
    '',
    '<aside>Draft — not reviewed.</aside>',
    '',
].join('\n');

const WIDE = 1280;
const NARROW = 420;

const THEMES: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark'], [HC_DARK, 'hc']];

const ROW = '.mep-toolbar';
const face = (menu: string) => `${ROW} .mep-menu-face[data-menu="${menu}"]`;
const panel = (menu: string) => `.mep-menu[data-menu="${menu}"]`;
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/**
 * Wave 1 #6 + #12 + #11 (DECISIONS.md, the sketch's v2): the row's marks named
 * by word, delimiter, element and key in the editor's hover; menus as glyph ·
 * word · syntax; the admonition submenu's "More types…"; the controls' states.
 * Each scene in Light Modern, Dark Modern and Dark High Contrast, shot with
 * MEP_SHOTS_DIR set.
 */
suite('Editor labels, menus and states (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const shot = (name: string) => saveShot(page, name);

    const showDocument = async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, SOURCE, {}));
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('last-writer-wins'));
        await page.mouse.move(WIDE - 10, 790);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await delay(150);
    };

    /** The pointer on the centre of `selector`. */
    const pointTo = async (selector: string, wait = 120) => {
        const box = await (await page.$(selector))?.boundingBox();
        assert.ok(box, `no ${selector}`);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await delay(wait);
    };

    const style = (selector: string, ...properties: string[]) => page.$eval(selector, (el, props) => {
        const cs = getComputedStyle(el);
        return Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)]));
    }, properties);

    /** A row menu whose face moved into "…" (a narrow row): opened from its entry there, by click or by keys. True when it was. */
    const openFromMore = async (menu: string, keys: boolean): Promise<boolean> => {
        if (!(await page.$eval(face(menu), el => (el as HTMLElement).hidden))) {
            return false;
        }
        if (keys) {
            await page.focus(`${ROW} .mep-more-face`);
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${panel('more')}:not([hidden])`);
            await page.focus(`${panel('more')} [data-submenu="${menu}"]`);
            await page.keyboard.press('ArrowRight');
        } else {
            await page.click(`${ROW} .mep-more-face`);
            await page.waitForSelector(`${panel('more')}:not([hidden])`);
            await page.click(`${panel('more')} [data-submenu="${menu}"]`);
        }
        await page.waitForSelector(`${panel(menu)}:not([hidden])`);
        await delay(80);
        return true;
    };

    const openByClick = async (menu: string) => {
        if (await openFromMore(menu, false)) {
            return;
        }
        await page.click(face(menu));
        await page.waitForSelector(`${panel(menu)}:not([hidden])`);
        await delay(80);
    };

    const closeMenus = async () => {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await page.mouse.click(WIDE - 10, 790);
        await delay(80);
    };

    /** Per theme: the document fresh, the caret where `scene` puts it, and the shot `name-{t}.png` after it. */
    const eachTheme = async (name: string, scene: (theme: Theme, t: string) => Promise<void>) => {
        for (const [theme, t] of THEMES) {
            await applyTheme(page, theme);
            await showDocument();
            await scene(theme, t);
            await shot(`${name}-${t}.png`);
            await closeMenus();
        }
    };

    /** The admonition submenu, opened from the keyboard, the focus on `type`. */
    const openAdmonitions = async (focusOn: string) => {
        await clickText(page, 'payload', 2);
        // The pointer off the menus: an entry under it would take the focus (`followPointer`).
        await page.mouse.move(WIDE - 10, 790);
        if (!(await openFromMore('insert', true))) {
            await page.focus(face('insert'));
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${panel('insert')}:not([hidden])`);
        }
        await page.focus(`${panel('insert')} [data-submenu="admonition"]`);
        await page.keyboard.press('ArrowRight');
        await page.waitForSelector(`${panel('admonition')}:not([hidden])`);
        await page.focus(`${panel('admonition')} [data-action="admonition-${focusOn}"]`);
        await delay(400);
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action), `admonition-${focusOn}`);
    };

    /** The shown entries of a menu panel, and the more-item's text. */
    const shownEntries = (menu: string) => page.$eval(panel(menu), p => Array.from(p.querySelectorAll<HTMLElement>('.mep-menu-item')).filter(i => !i.hidden).map(i => i.dataset.action ?? i.dataset.more ?? ''));

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: WIDE, height: 800, styles: ['markdown-extended.css', 'markdown-it-admonition.css', 'markdown-it-kbd.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        if (page) {
            await page.setViewport({ width: WIDE, height: 800 });
            await applyTheme(page, LIGHT_MODERN);
        }
        await closeEditorPage(this, editor);
    });

    test('01 the row\'s mark says its word, delimiter, element and key in the editor\'s hover, and no control of the row, bubble or bars has a title', async function () {
        this.timeout(40000);
        await eachTheme('01-row-tooltip-1280', async theme => {
            await clickText(page, 'local replica', 2);
            assert.strictEqual(await page.$eval(`${ROW} [data-action="bold"]`, el => el.classList.contains('mep-active')), true, 'b is on');
            // Hovered, the on control keeps its fill.
            await pointTo(`${ROW} [data-action="bold"]`);
            assert.strictEqual((await style(`${ROW} [data-action="bold"]`, 'background-color'))['background-color'],
                computed(theme.variables['inputOption-activeBackground'] ?? 'rgba(0, 0, 0, 0)'), `${theme.name}: on keeps its fill under the pointer`);
            await page.mouse.move(WIDE - 10, 790);
            await delay(100);
            const shown = await hoverTip(page, `${ROW} [data-action="italic"]`);
            assert.ok(shown, 'the hover shows after the rest');
            const description = await describedTip(page, `${ROW} [data-action="italic"]`);
            assert.strictEqual(description, 'Italic (*, <i>)', 'the key is aria-keyshortcuts\' to say');
            assert.strictEqual(shown.text, `${description} — ${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+I`, 'the hover says what the description says, and the key');
            const drawn = await page.$eval('.mep-tooltip', el => ({
                code: Array.from(el.querySelectorAll('code')).map(c => c.textContent),
                keys: Array.from(el.querySelectorAll('.mep-key')).map(k => k.textContent),
                pointer: getComputedStyle(el).pointerEvents,
                role: el.getAttribute('role'),
            }));
            assert.deepStrictEqual(drawn, { code: ['*', '<i>'], keys: [process.platform === 'darwin' ? 'Cmd' : 'Ctrl', 'I'], pointer: 'none', role: 'tooltip' });
            const italic = await page.$eval(`${ROW} [data-action="italic"]`, el => [el.getAttribute('aria-label'), el.getAttribute('aria-keyshortcuts')]);
            assert.deepStrictEqual(italic, ['Italic, asterisk', process.platform === 'darwin' ? 'Meta+I' : 'Control+I']);
            assert.deepStrictEqual(await page.$$eval('.mep-toolbar [title], .mep-bubble [title], .mep-object-toolbar [title]', els => els.map(e => e.outerHTML.slice(0, 80))), [], 'no title on the row, the bubble or the bars');
        });
    });

    test('02 Tab onto b: the focus ring outside the control, the on border kept, the hover at once; a key hides it', async function () {
        this.timeout(40000);
        await eachTheme('02-row-focus-1280', async theme => {
            await clickText(page, 'local replica', 2);
            await page.focus(`${ROW} [data-action="emphasis"]`);
            await page.keyboard.press('Tab');
            await delay(100);
            assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action), 'bold');
            const ring = await style(`${ROW} [data-action="bold"]`, 'outline-style', 'outline-offset', 'outline-color', 'border-top-color');
            assert.deepStrictEqual(ring, {
                'outline-style': 'solid', 'outline-offset': '1px', 'outline-color': computed(theme.variables['focusBorder']),
                'border-top-color': computed(theme.variables['inputOption-activeBorder']),
            }, theme.name);
            // The ring fits the row: the control stands 2px clear of the row's inside, top and bottom.
            const clear = await page.$eval(`${ROW} [data-action="bold"]`, el => {
                const r = el.getBoundingClientRect();
                const row = (el.closest('.mep-toolbar') as HTMLElement).getBoundingClientRect();
                return [r.top - row.top, row.bottom - 1 - r.bottom];
            });
            assert.ok(clear.every(c => c >= 2 - 0.01), `the ring inside the row: ${clear.join(', ')}`);
            assert.strictEqual(await page.$eval('.mep-tooltip', el => (el as HTMLElement).hidden), false, 'keyboard focus shows the hover at once');
            assert.ok((await page.$eval('.mep-tooltip', el => el.textContent ?? '')).startsWith('Bold (**, <b>)'));
            if (theme === HC_DARK) {
                await page.keyboard.press('a');
                assert.strictEqual(await page.$eval('.mep-tooltip', el => (el as HTMLElement).hidden), true, 'a key hides the hover');
                await page.focus(`${ROW} [data-action="emphasis"]`);
                await page.keyboard.press('Tab');
                await delay(100);
            }
        });
    });

    test('03 a locked row: every control at 40 %, and the pointer paints nothing on one', async function () {
        this.timeout(40000);
        await eachTheme('03-row-disabled-1280', async () => {
            await pointTo('.ProseMirror > .mep-raw-block .mep-atom-content', 50);
            await page.mouse.down();
            await page.mouse.up();
            await page.waitForSelector(`${BAR}[data-object="raw_block"] [data-verb="edit-source"]`);
            await page.click(`${BAR} [data-verb="edit-source"]`);
            await page.waitForSelector('.mep-raw-editor');
            await delay(150);
            const opacities = await page.$$eval(`${ROW} .mep-tool:not([data-scope="document"])`, els => els.map(e => getComputedStyle(e).opacity));
            assert.ok(opacities.length >= 9 && opacities.every(o => o === '0.4'), opacities.join(', '));
            await pointTo(`${ROW} [data-action="strong"]`);
            assert.deepStrictEqual(await style(`${ROW} [data-action="strong"]`, 'background-color', 'outline-style'), { 'background-color': 'rgba(0, 0, 0, 0)', 'outline-style': 'none' });
        });
    });

    test('04 the bubble over bold text: {…} is no toggle, never drawn on; its name says what it targets', async function () {
        this.timeout(40000);
        await eachTheme('04-bubble-1280', async () => {
            await page.focus('.ProseMirror');
            await page.evaluate(() => {
                const root = document.querySelector('.ProseMirror') as HTMLElement;
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                    const at = (node.textContent ?? '').indexOf('local replica');
                    if (at >= 0) {
                        (document.getSelection() as Selection).setBaseAndExtent(node, at + 1, node, at + 10);
                        return;
                    }
                }
            });
            await page.waitForSelector('.mep-bubble:not([hidden])');
            await delay(200);
            const tool = await page.$eval('.mep-bubble [data-action="attrs-bubble"]', el => [el.classList.contains('mep-active'), el.getAttribute('aria-label')]);
            assert.deepStrictEqual(tool, [false, 'Attributes of Bold…']);
            assert.strictEqual(await describedTip(page, '.mep-bubble [data-action="attrs-bubble"]'), 'Attributes of Bold… — **text**{.class}');
            assert.strictEqual((await style('.mep-bubble', 'padding-top'))['padding-top'], '4px');
            await pointTo('.mep-bubble [data-action="attrs-bubble"]', 700);
        });
    });

    test('the bubble hidden by an update takes its hover with it', async function () {
        this.timeout(20000);
        await applyTheme(page, LIGHT_MODERN);
        await showDocument();
        await page.focus('.ProseMirror');
        await page.evaluate(() => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf('local replica');
                if (at >= 0) {
                    (document.getSelection() as Selection).setBaseAndExtent(node, at + 1, node, at + 10);
                    return;
                }
            }
        });
        // Pointed at once its inert time is over (`placement.ts`): before, the pointer passes through it.
        await page.waitForSelector('.mep-bubble:not([hidden]):not([data-inert])');
        await pointTo('.mep-bubble [data-action="attrs-bubble"]', 700);
        assert.strictEqual(await page.$eval('.mep-tooltip', el => (el as HTMLElement).hidden), false, 'the hover shows');
        // No key, no press: the selection collapses, the update hides the bubble.
        await page.evaluate(() => (document.getSelection() as Selection).collapseToStart());
        await delay(250);
        assert.deepStrictEqual(await page.evaluate(() => [(document.querySelector('.mep-bubble') as HTMLElement).hidden, (document.querySelector('.mep-tooltip') as HTMLElement).hidden]), [true, true]);
        await page.mouse.move(WIDE - 10, 790);
    });

    test('05 a bar\'s title is a small muted label with a divider after it; Alt+Enter focuses Edit…', async function () {
        this.timeout(40000);
        await eachTheme('05-bar-1280', async theme => {
            await clickText(page, 'API reference', 3);
            await page.keyboard.down('Alt');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Alt');
            await page.waitForSelector(`${BAR}[data-object="link"]`);
            await delay(150);
            const title = await page.$eval(`${BAR} .mep-object-label`, el => ({
                size: getComputedStyle(el).fontSize, colour: getComputedStyle(el).color, cursor: getComputedStyle(el).cursor,
                next: el.nextElementSibling?.className, focusable: (el as HTMLElement).tabIndex,
            }));
            assert.deepStrictEqual({ ...title, colour: undefined }, { size: '11px', colour: undefined, cursor: 'default', next: 'mep-object-separator', focusable: -1 });
            assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.verb), 'edit-link');
            assert.strictEqual((await style(`${BAR} [data-verb="edit-link"]`, 'outline-offset'))['outline-offset'], '1px');
            // Alt+Enter's focus is the keyboard's: the verb's hover shows at once, ring or no `:focus-visible`.
            const tip = () => page.$eval('.mep-tooltip', el => ({
                shown: !(el as HTMLElement).hidden, text: el.textContent ?? '', fits: el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= window.innerWidth,
            }));
            const edit = await tip();
            assert.ok(edit.shown && edit.text.startsWith('Link the text to another address'), JSON.stringify(edit));
            // The bar's longest tip, Attributes…: wrapped inside its box, inside the window.
            await page.keyboard.press('ArrowRight');
            await delay(80);
            assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.verb), 'link-attributes');
            const attributes = await tip();
            assert.ok(attributes.shown && attributes.text.length > 80 && attributes.fits, JSON.stringify(attributes));
            // Muted, and still clearly darker than a refused verb.
            const [titleColour, verbColour] = await page.$eval(BAR, bar => [
                getComputedStyle(bar.querySelector('.mep-object-label') as HTMLElement).color,
                getComputedStyle(bar.querySelector('.mep-object-verb') as HTMLElement).color,
            ]);
            assert.notStrictEqual(titleColour, verbColour, `${theme.name}: the title is not drawn as a verb`);
            const ratios = await titleRatios();
            assert.ok(ratios.title >= 4.5 && ratios.title > ratios.refused, `${theme.name}: ${JSON.stringify(ratios)}`);
        });
        // Light+, whose description colour is muted already: drawn as it is, not mixed further.
        await applyTheme(page, LIGHT_PLUS);
        await showDocument();
        await clickText(page, 'API reference', 3);
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await page.waitForSelector(`${BAR}[data-object="link"]`);
        await delay(150);
        const plus = await titleRatios();
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-label`, el => getComputedStyle(el).color), 'rgb(113, 113, 113)', 'Light+: the description colour as the theme gives it, not mixed');
        // The theme's own pair, #717171 on #f3f3f3, is 4.40:1 — the 4.5:1 an 11px label needs is not the mix's to give back (open: Daniel).
        assert.ok(plus.title >= 4.39 && plus.title > plus.refused, `Light+: ${JSON.stringify(plus)}`);
        await closeMenus();
        // Light Modern under the id VS Code gave it before 1.142: mixed all the same.
        await applyTheme(page, { ...LIGHT_MODERN, id: 'Default Light Modern' });
        await showDocument();
        await clickText(page, 'API reference', 3);
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await page.waitForSelector(`${BAR}[data-object="link"]`);
        await delay(150);
        const [oldTitle, oldVerb] = await page.$eval(BAR, bar => [
            getComputedStyle(bar.querySelector('.mep-object-label') as HTMLElement).color,
            getComputedStyle(bar.querySelector('.mep-object-verb') as HTMLElement).color,
        ]);
        assert.notStrictEqual(oldTitle, oldVerb, 'Default Light Modern: the title is mixed, not the verbs\' colour');
        await closeMenus();
        await applyTheme(page, LIGHT_MODERN);
    });

    /** The bar's title against the widget's ground, and a refused verb's (its colour at 40 %): 11px needs 4.5:1, and more than the refused verb. */
    const titleRatios = () => page.$eval(BAR, bar => {
        const rgb = (c: string): number[] => {
            const m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(c);
            return m ? [1, 2, 3].map(i => Number(m[i]) * 255) : (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        };
        const lum = (c: number[]) => {
            const [r, g, b] = c.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        const ground = rgb(getComputedStyle(bar).backgroundColor);
        const title = rgb(getComputedStyle(bar.querySelector('.mep-object-label') as HTMLElement).color);
        const verb = rgb(getComputedStyle(bar.querySelector('.mep-object-verb') as HTMLElement).color);
        const refused = verb.map((v, i) => v * 0.4 + ground[i] * 0.6);
        return { title: contrast(title, ground), refused: contrast(refused, ground) };
    });

    test('06 Block type keeps its drawn labels without the heading rules; the code block reads at its own size', async function () {
        this.timeout(40000);
        await eachTheme('06-menu-block-type-1280', async theme => {
            await clickText(page, 'payload', 2);
            await openByClick('block-type');
            if (theme === HC_DARK) {
                assert.deepStrictEqual(await style(face('block-type'), 'outline-style', 'outline-color'), {
                    'outline-style': 'solid', 'outline-color': computed(theme.variables['inputOption-activeBorder']),
                }, 'HC: an open face is marked solid, as a toggle that is on');
            }
            const h1 = await style(`${panel('block-type')} [data-action="heading-1"] h1`, 'border-bottom-width');
            assert.strictEqual(h1['border-bottom-width'], '0px', 'no heading rule');
            const code = await page.$eval(`${panel('block-type')} [data-action="code-block"] pre`, el => ({
                zoom: Number((el as HTMLElement).style.zoom || '1'), padding: getComputedStyle(el).paddingTop, label: el.textContent,
            }));
            assert.ok(code.zoom >= 0.75, `zoomed no lower than 0.75: ${code.zoom}`);
            assert.deepStrictEqual([code.padding, code.label], ['1px', 'Code block']);
            assert.ok(await page.$eval(panel('block-type'), el => getComputedStyle(el).backgroundImage.includes('linear-gradient')), 'the scroll sign is drawn');
        });
    });

    test('07 Formatting: glyph · word · syntax; the highlighted entry is the UI font at 400; the groups divided', async function () {
        this.timeout(40000);
        await eachTheme('07-menu-formatting-1280', async () => {
            await clickText(page, 'sync/batch', 2);
            await openByClick('formatting');
            const entries = await page.$eval(panel('formatting'), p => Array.from(p.children).map(c => (c as HTMLElement).dataset.action ?? (c.getAttribute('role') === 'separator' ? '—' : '?')));
            assert.deepStrictEqual(entries, ['mark', 'superscript', 'subscript', 'strikethrough', 'kbd', '—', 'span-class', 'inline-attributes', 'block-attributes']);
            const look = await page.$$eval(`${panel('formatting')} .mep-menu-item`, items => items.map(i => {
                const glyph = i.querySelector('.mep-entry-glyph') as HTMLElement;
                const label = i.querySelector('.mep-entry-label') as HTMLElement;
                const r = glyph.getBoundingClientRect();
                return { w: r.width, h: r.height, clip: getComputedStyle(glyph).overflow, whole: label.scrollWidth <= label.clientWidth };
            }));
            assert.ok(look.every(l => l.w === 40 && l.h === 22 && l.clip === 'clip' && l.whole), JSON.stringify(look));
            await pointTo(`${panel('formatting')} [data-action="inline-attributes"]`, 400);
            const word = await page.$eval(`${panel('formatting')} [data-action="inline-attributes"] .mep-entry-label`, el => ({ text: el.textContent, weight: getComputedStyle(el).fontWeight, family: getComputedStyle(el).fontFamily }));
            const ui = await page.$eval(ROW, el => getComputedStyle(el).fontFamily);
            assert.deepStrictEqual(word, { text: 'Attributes of Code…', weight: '400', family: ui });
        });
    });

    test('08 Annotation: the notes, then the footnote after a divider', async function () {
        this.timeout(40000);
        await eachTheme('08-menu-annotation-1280', async theme => {
            await clickText(page, 'payload', 2);
            await openByClick('annotation');
            const entries = await page.$eval(panel('annotation'), p => Array.from(p.children).map(c => (c as HTMLElement).dataset.action ?? (c.getAttribute('role') === 'separator' ? '—' : '?')));
            assert.deepStrictEqual(entries, ['sidenote', 'marginal-note', 'left-sidebar', 'right-sidebar', '—', 'footnote-reference']);
            assert.deepStrictEqual(await page.$$eval(`${panel('annotation')} .mep-entry-label`, els => els.map(e => e.textContent)), ['Sidenote', 'Marginal note', 'Left sidebar', 'Right sidebar', 'Footnote']);
            await pointTo(`${panel('annotation')} [data-action="sidenote"]`, 400);
            if (theme === HC_DARK) {
                const card = await page.$eval('.mep-preview-card:not([hidden])', el => {
                    const note = getComputedStyle(el.querySelector('.sidenote') as HTMLElement);
                    return [note.color === getComputedStyle(el).color, note.backgroundColor];
                });
                assert.deepStrictEqual(card, [true, 'rgba(0, 0, 0, 0)'], 'HC: the note is the card\'s text on the card\'s ground');
            }
        });
    });

    test('09 Insert: every entry a word, the groups divided, the syntax column cut first', async function () {
        this.timeout(40000);
        await eachTheme('09-menu-insert-1280', async () => {
            await clickText(page, 'payload', 2);
            await openByClick('insert');
            const entries = await page.$eval(panel('insert'), p => Array.from(p.children).map(c => (c as HTMLElement).dataset.action ?? (c as HTMLElement).dataset.submenu ?? (c.getAttribute('role') === 'separator' ? '—' : '?')));
            assert.deepStrictEqual(entries, [
                'link', 'image', '—', 'horizontal-rule', 'admonition', 'table', 'container', '—', 'task-list', 'definition-list', 'abbreviation', 'table-of-contents', '—', 'include', 'properties',
            ]);
            const words = await page.$$eval(`${panel('insert')} .mep-entry-label`, els => els.map(e => [e.textContent, e.scrollWidth <= e.clientWidth]));
            assert.ok(words.every(([, whole]) => whole), JSON.stringify(words));
            assert.deepStrictEqual(words.map(([w]) => w).slice(0, 4), ['Link…', 'Image…', 'Horizontal rule', 'Admonition']);
            await pointTo(`${panel('insert')} [data-action="link"]`, 400);
        });
    });

    test('10 Insert › Admonition: the eleven canonical types, then "More types… (16)"', async function () {
        this.timeout(40000);
        await eachTheme('10-admonition-1280', async () => {
            await openAdmonitions('warning');
            assert.deepStrictEqual(await shownEntries('admonition'), [...ADMONITION_FAMILIES.map(f => `admonition-${f.type}`), 'collapsed']);
            assert.strictEqual(await page.$eval(`${panel('admonition')} .mep-more-item .mep-entry-label`, el => el.textContent), MORE_TYPES(16));
        });
    });

    test('11 More types… pressed: the aliases in place, the focus on Abstract "as Summary", the list scrolls; closed and opened again, collapsed', async function () {
        this.timeout(40000);
        await eachTheme('11-admonition-more-1280', async () => {
            await openAdmonitions('quote');
            await page.keyboard.press('ArrowDown');
            assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.more), 'collapsed');
            await page.keyboard.press('Enter');
            await delay(150);
            assert.strictEqual(await page.$eval(panel('admonition'), el => !(el as HTMLElement).hidden), true, 'the menu stays open');
            const focus = await page.evaluate(() => {
                const el = document.activeElement as HTMLElement;
                return [el.dataset.action, el.querySelector('.mep-entry-alias')?.textContent, el.querySelector('.mep-entry-label')?.textContent];
            });
            assert.deepStrictEqual(focus, ['admonition-abstract', 'as Summary', 'Abstract as Summary'], 'read as one phrase, a space before the alias');
            const scroll = await page.$eval(panel('admonition'), el => {
                const r = el.getBoundingClientRect();
                const f = (document.activeElement as HTMLElement).getBoundingClientRect();
                return [el.scrollHeight > el.clientHeight, f.top >= r.top && f.bottom <= r.bottom];
            });
            assert.deepStrictEqual(scroll, [true, true], 'it scrolls, and the first alias is in view');
            assert.strictEqual(await page.$eval(`${panel('admonition')} .mep-more-item .mep-entry-label`, el => el.textContent), FEWER_TYPES);
            await page.keyboard.press('Escape');
            await delay(80);
            await page.keyboard.press('ArrowRight');
            await page.waitForSelector(`${panel('admonition')}:not([hidden])`);
            assert.ok((await shownEntries('admonition')).includes('collapsed'), 'opened again, the aliases are behind "More types…"');
            assert.strictEqual((await shownEntries('admonition')).length, 12);
            // The shot shows the expanded state, as the sketch does.
            await page.focus(`${panel('admonition')} .mep-more-item`);
            await page.keyboard.press('Enter');
            await delay(400);
        });
    });

    test('a hover shown by the focus stays; a rest the pointer broke off shows nothing later', async function () {
        this.timeout(20000);
        await applyTheme(page, LIGHT_MODERN);
        await showDocument();
        await clickText(page, 'payload', 2);
        await page.focus(`${ROW} [data-action="emphasis"]`);
        await page.keyboard.press('Tab');
        await delay(80);
        assert.ok((await page.$eval('.mep-tooltip', el => el.textContent ?? '')).startsWith('Bold'), 'the focus shows Bold');
        // The pointer crosses Strong and leaves before its rest is over.
        await pointTo(`${ROW} [data-action="strong"]`, 150);
        await page.mouse.move(WIDE - 10, 790);
        await delay(800);
        const shown = await page.$eval('.mep-tooltip', el => [(el as HTMLElement).hidden, el.textContent ?? '']);
        assert.ok(!String(shown[1]).startsWith('Strong'), `no stray hover: ${JSON.stringify(shown)}`);
    });

    test('15 a row control\'s hover at 420 px, under it; 16 a set-verb entry\'s hover stands beside the entry', async function () {
        this.timeout(30000);
        await applyTheme(page, LIGHT_MODERN);
        await page.setViewport({ width: NARROW, height: 640 });
        try {
            await showDocument();
            await clickText(page, 'payload', 2);
            await page.focus(`${ROW} [data-action="emphasis"]`);
            await page.keyboard.press('Tab');
            await delay(80);
            // The row never scrolls (wave 2 #2): the hover stands under its control, inside the window.
            const before = await page.$eval('.mep-tooltip', el => [(el as HTMLElement).hidden, el.getBoundingClientRect().left, el.getBoundingClientRect().right]);
            const faceLeft = await page.$eval(`${ROW} [data-action="bold"]`, el => el.getBoundingClientRect().left);
            assert.strictEqual(before[0], false, 'the focus shows Bold\'s hover');
            assert.ok(Math.abs(Number(before[1]) - faceLeft) < 1 && Number(before[2]) <= NARROW + 0.5, `under Bold, inside the window: ${JSON.stringify([before, faceLeft])}`);
            await shot('15-hover-row-420-light.png');
        } finally {
            await page.setViewport({ width: WIDE, height: 800 });
        }
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({
            type: 'document', json: parsedDocumentToJSON(parseDocument(md, '| Name | Value |\n| ---- | ----- |\n| Alpha | 1 |\n| Beta | 2 |\n', {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE,
        });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Alpha'));
        await clickText(page, 'Alpha', 2);
        await page.keyboard.down('Alt');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Alt');
        await page.waitForSelector(`${BAR}[data-object="table"]`);
        await delay(100);
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await delay(150);
        const placed = await page.evaluate(() => {
            const entry = (document.activeElement as HTMLElement).getBoundingClientRect();
            const tip = document.querySelector('.mep-tooltip') as HTMLElement;
            return { shown: !tip.hidden, beside: tip.getBoundingClientRect().left >= entry.right - 0.5 || tip.getBoundingClientRect().right <= entry.left + 0.5, top: Math.round(tip.getBoundingClientRect().top - entry.top) };
        });
        assert.deepStrictEqual(placed, { shown: true, beside: true, top: 0 }, 'beside the entry, at its top');
        await shot('16-set-verb-entry-hover-1280-light.png');
        // The pointer crossing the menu moves the focus (`followPointer`): that focus is the pointer's, no hover before the rest.
        const second = await (await page.$(`${BAR} .mep-object-menu .mep-menu-item:nth-child(2)`))?.boundingBox();
        assert.ok(second);
        await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2, { steps: 3 });
        await delay(100);
        const crossed = await page.evaluate(() => [(document.activeElement as HTMLElement).dataset.entry, (document.querySelector('.mep-tooltip') as HTMLElement).hidden]);
        assert.deepStrictEqual(crossed[1], true, `no hover at once under the pointer: ${JSON.stringify(crossed)}`);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
    });

    test('12-14 at 420 px: the menus stay inside the window', async function () {
        this.timeout(60000);
        await page.setViewport({ width: NARROW, height: 640 });
        try {
            const inside = async (menu: string) => {
                const r = await page.$eval(panel(menu), el => el.getBoundingClientRect().toJSON() as DOMRect);
                assert.ok(r.left >= 0 && r.right <= NARROW + 0.5 && r.top >= 0 && r.bottom <= 640.5, `${menu} inside the window: ${JSON.stringify(r)}`);
            };
            await eachTheme('12-420-block-type', async () => {
                await clickText(page, 'payload', 2);
                await openByClick('block-type');
                await pointTo(`${panel('block-type')} [data-action="blockquote"]`, 400);
                await inside('block-type');
            });
            await eachTheme('13-420-formatting', async () => {
                await clickText(page, 'payload', 2);
                // At 420 Formatting is in "…" (wave 2 #2): `openByClick` opens it from there.
                await openByClick('formatting');
                await pointTo(`${panel('formatting')} [data-action="block-attributes"]`, 400);
                await inside('formatting');
            });
            await eachTheme('14-420-insert-admonition', async () => {
                await openAdmonitions('warning');
                await inside('insert');
                await inside('admonition');
            });
        } finally {
            await page.setViewport({ width: WIDE, height: 800 });
            await applyTheme(page, LIGHT_MODERN);
        }
    });
});
