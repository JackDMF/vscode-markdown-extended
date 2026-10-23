import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { EditorPage, EXTENSION_ID, SHOTS_DIR, closeEditorPage, clickText, delay, openEditorPage, pointAt } from './pageHarness';import { REFUSALS_DOC, contrastOf } from './refusals.e2e.test';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** Daniel's full user stylesheet (read, never copied): the page as his documents show it. */
const PETROL = process.env.MEP_USER_CSS ?? path.join(os.homedir(), 'Repositories', 'Theokratie-Archiv', 'Styles.petrol.css');

const ROW = '.mep-toolbar';
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const MENU = `${BAR} .mep-object-menu`;

/**
 * A long refusal that names a table's row (C13's family, #10 build critique F5): an edit in row 2 is refused because
 * the save would write row 1 again, whose sidebar `@x@` comes back otherwise (it spells a character as `&#116;`; a
 * `$…$` there reads as math, which makes the table a source block).
 */
const LONG_DOC = '| Name | Note |\n| ---- | ---- |\n| one | See h&#116;tp://e.com/@x@ here. |\n| edit me | two |\n\nAfter.\n';
const PROPS_DOC = '---\ntitle: Demo\nstream: UXD\n---\n\nSome words here to select.\n\nLast paragraph.\n';

type Step = (page: puppeteer.Page, show: (text: string, marker: string) => Promise<void>) => Promise<void>;

/** Each state of #10's shot list (plan section 7): what it shows, the widths, themes and stylesheets it is taken in. */
const SHOTS: { name: string; widths: number[]; themes: Theme[]; petrol: Theme[]; step: Step }[] = [
    {
        name: 's1-caret', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN, HC_DARK], petrol: [LIGHT_MODERN, DARK_MODERN],
        step: async (page, show) => {
            await show(REFUSALS_DOC, 'Refusals');
            await clickText(page, 'ab', 1);
            await page.keyboard.type('|');
        },
    },
    {
        name: 's2-field', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN, HC_DARK], petrol: [LIGHT_MODERN],
        step: async (page, show) => {
            await show(REFUSALS_DOC, 'Refusals');
            await clickText(page, 'bold', 2);
            await openRowMenu(page, 'formatting');
            await page.click('.mep-menu[data-menu="formatting"] [data-action="inline-attributes"]');
            await page.waitForSelector('.mep-inline-field', { visible: true });
            await page.keyboard.type('width = 300');
            await page.keyboard.press('Enter');
        },
    },
    {
        name: 's3-source-lock', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN, HC_DARK], petrol: [LIGHT_MODERN, DARK_MODERN],
        step: async (page, show) => {
            await show(REFUSALS_DOC, 'Refusals');
            const raw = await pointAt(page, 'raw block', 1);
            await page.mouse.click(raw.x, raw.y, { clickCount: 2 });
            await page.waitForSelector('.mep-raw-editor');
            await delay(100);
            // At 520 the lock note stands in the tools' place: nothing to press, the box's Apply and Cancel shown.
            const bold = `${ROW} [data-action="bold"]`;
            if (await visible(page, bold)) {
                await page.click(bold);
            }
        },
    },
    {
        name: 's4-quiet-lock', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN], petrol: [],
        step: async (page, show) => {
            await show(PROPS_DOC, 'Some words');
            await page.focus('.mep-properties .mep-props-toggle');
            await delay(150);
            const bold = `${ROW} [data-action="bold"]`;
            await page.click((await visible(page, bold)) ? bold : `${ROW} .mep-more-face`);
        },
    },
    {
        name: 's5-export-busy', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN, HC_DARK], petrol: [LIGHT_MODERN],
        step: async (page, show) => {
            await show(REFUSALS_DOC, 'Refusals');
            const face = `${ROW} .mep-menu-face[data-menu="export"]`;
            const open = () => visible(page, '.mep-menu[data-menu="export"]');
            if (!(await open())) {
                await page.click(face);
            }
            await (await page.waitForSelector('.mep-menu[data-menu="export"] [data-export="pdf"]', { visible: true }))?.click();
            await delay(150);
            if (!(await open())) {
                await page.click(face);
            }
            await (await page.waitForSelector('.mep-menu[data-menu="export"] [data-export="html"]', { visible: true }))?.click();
        },
    },
    {
        name: 's6-bar-verb', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN], petrol: [LIGHT_MODERN],
        step: async (page, show) => {
            await show('Alpha ++beta|the body++@y@ gamma.\n', 'Alpha');
            await clickText(page, 'body', 1);
            await page.waitForSelector(BAR, { timeout: 2000 });
            const verb = `${BAR} [data-verb="delete-note"]:not([hidden])`;
            if (await page.$(verb)) {
                await page.click(verb);
            } else {
                await page.click(`${BAR} .mep-object-more`);
                await page.waitForSelector(MENU);
                await page.click(`${MENU} [data-entry="delete-note"]`);
            }
        },
    },
    {
        name: 's7-bar-entry', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN], petrol: [],
        step: async (page, show) => {
            await show('| Only | Row |\n| ---- | --- |\n\nAfter the table.\n', 'After');
            // The caret out of the table and in again until its bar comes (a bar left dismissed by the last state).
            for (let tries = 0; tries < 3 && (await page.$(BAR)) === null; tries++) {
                await clickText(page, 'After', 2);
                await delay(600);
                await clickText(page, 'Only', 1);
                await delay(800);
            }
            await page.waitForSelector(BAR, { timeout: 2000 });
            await page.click(`${BAR} [data-verb="row"]`);
            await page.waitForSelector(MENU);
            await page.click(`${MENU} [data-entry="delete-row"]`);
        },
    },
    {
        name: 's8-blocktype-entry', widths: [1280, 520], themes: [LIGHT_MODERN], petrol: [],
        step: async (page, show) => {
            await show(REFUSALS_DOC, 'Refusals');
            await clickText(page, 'one', 1);
            await page.click(`${ROW} .mep-menu-face[data-menu="block-type"]`);
            await page.waitForSelector('.mep-menu[data-menu="block-type"]:not([hidden])');
            await page.click('.mep-menu[data-menu="block-type"] [data-action="heading-2"]');
        },
    },
    {
        name: 's10-long', widths: [1280, 520], themes: [LIGHT_MODERN, DARK_MODERN], petrol: [LIGHT_MODERN],
        step: async (page, show) => {
            await show(LONG_DOC, 'After');
            await clickText(page, 'edit me', 4);
            await page.keyboard.type('Z');
        },
    },
    {
        name: 's11-gap-lock', widths: [1280], themes: [LIGHT_MODERN], petrol: [],
        step: async (page, show) => {
            await show('| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.\n', 'After');
            await clickText(page, 'a', 0);
            await page.keyboard.press('Home');
            await page.keyboard.press('ArrowLeft');
            await delay(120);
            await page.click(`${ROW} .mep-menu-face[data-menu="block-type"]`);
            await page.waitForSelector('.mep-menu[data-menu="block-type"]:not([hidden])');
            await page.click('.mep-menu[data-menu="block-type"] [data-action="heading-2"]');
        },
    },
];

/** Whether `selector` is drawn (laid out, not `display: none`). */
function visible(page: puppeteer.Page, selector: string): Promise<boolean> {
    return page.evaluate(sel => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el !== null && el.getClientRects().length > 0;
    }, selector);
}

/** A row menu opened by its face, or — moved into "…" at a narrow width — by its entry there. */
async function openRowMenu(page: puppeteer.Page, menu: string): Promise<void> {
    const face = `${ROW} .mep-menu-face[data-menu="${menu}"]:not([hidden])`;
    if (await page.$(face)) {
        await page.click(face);
    } else {
        await page.click(`${ROW} .mep-more-face`);
        await page.waitForSelector('.mep-menu[data-menu="more"]:not([hidden])');
        await page.hover(`.mep-menu[data-menu="more"] [data-submenu="${menu}"]`);
    }
    await page.waitForSelector(`.mep-menu[data-menu="${menu}"]:not([hidden])`);
}

/** What the refusal on screen measures: its colours' contrast against its own surface, and where it stands. */
function measure(page: puppeteer.Page) {
    return page.evaluate(() => {
        const hint = document.querySelector('.mep-hint:not([hidden])') as HTMLElement | null;
        const field = document.querySelector('.mep-field-refusal-text') as HTMLElement | null;
        const el = hint ?? field;
        if (el === null) {
            return null;
        }
        const s = getComputedStyle(el);
        let back = s.backgroundColor;
        for (let p: HTMLElement | null = el; p && /rgba\(0, 0, 0, 0\)|transparent/.test(back); p = p.parentElement) {
            back = getComputedStyle(p).backgroundColor;
        }
        const code = el.querySelector('code');
        const r = el.getBoundingClientRect();
        return {
            kind: hint ? `hint ${hint.dataset.at}` : 'field',
            text: el.textContent,
            colour: s.color,
            bar: s.borderLeftColor,
            barWidth: s.borderLeftWidth,
            back,
            code: code ? getComputedStyle(code).color : null,
            font: s.fontFamily,
            rect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        };
    });
}

/** A state's `show` for `editor`: what was open put away, then `text` posted as the host does, `marker` waited for. */
function shower(editor: EditorPage): (text: string, marker: string) => Promise<void> {
    const page = editor.page;
    let version = 0;
    return async (text, marker) => {
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            for (const menu of Array.from(document.querySelectorAll('.mep-menu:not([hidden])'))) {
                menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
        });
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await editor.send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await editor.send({ type: 'exportDone', outcome: 'settled' });
        // Long enough that the step's first click is no double click with the last one.
        await delay(600);
    };
}

/**
 * #10 build critique F1: Daniel's stylesheet narrows the body at 520 px, and
 * the hints and the field's bar shrank with it to 64–139 px. Standing beside
 * the body (the hint) or as wide as what they hold (a bar), they keep their
 * width now: the caret's hint, a bar verb's and the field's bar, each at least
 * 200 px and inside the window. Skipped where the stylesheet is not
 * (`MEP_USER_CSS`, else its place in Theokratie-Archiv), as the shots are.
 */
suite('Editor refusals: a user stylesheet that narrows the body, at 520 px (e2e)', () => {
    let editor: EditorPage | undefined;

    suiteSetup(async function () {
        this.timeout(60000);
        if (!fs.existsSync(PETROL)) {
            this.skip();
        }
        editor = await openEditorPage({ width: 520, height: 800, styles: ['markdown-extended.css'], stylesheets: [PETROL] });
        if (!editor) {
            this.skip();
        }
        await applyTheme((editor as EditorPage).page, LIGHT_MODERN);
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('the caret\'s hint, a bar verb\'s hint and the field\'s bar keep their width', async function () {
        this.timeout(60000);
        const page = (editor as EditorPage).page;
        const show = shower(editor as EditorPage);
        const box = (sel: string) => page.$eval(sel, el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width };
        });
        const wide = (what: string, r: { left: number; right: number; width: number }) => {
            assert.ok(r.width >= 200, `${what} ${Math.round(r.width)} px wide`);
            assert.ok(r.left >= 0 && r.right <= 520, `${what} inside the window: ${JSON.stringify(r)}`);
        };
        await (SHOTS.find(s => s.name === 's2-field') as (typeof SHOTS)[number]).step(page, show);
        await page.waitForSelector('.mep-field-refusal-text', { timeout: 2000 });
        wide('the field\'s bar', await box('.mep-object-toolbar.mep-field-bar'));
        await page.keyboard.press('Escape');
        for (const name of ['s1-caret', 's6-bar-verb']) {
            await (SHOTS.find(s => s.name === name) as (typeof SHOTS)[number]).step(page, show);
            await page.waitForSelector('.mep-hint:not([hidden])', { timeout: 2000 });
            wide(name, await box('.mep-hint'));
        }
    });
});

/**
 * #10's screenshots (plan section 7): with `MEP_SHOTS_DIR` set, each state of
 * the shot list in its widths and themes, with the default stylesheets and
 * with Daniel's user stylesheet (Styles.petrol.css, where it is), and what
 * each refusal measures — text, bar and value colours against the surface
 * they stand on — written beside them (`measure.json`). Without it, skipped.
 */
suite('Editor refusals: screenshots (e2e)', () => {
    suiteSetup(function () {
        if (!SHOTS_DIR) {
            this.skip();
        }
    });

    for (const set of ['default', 'petrol'] as const) {
        test(`the shot list with the ${set} stylesheets`, async function () {
            this.timeout(600000);
            // A run of some states (`MEP_SHOTS_ONLY`) adds to what an earlier run measured.
            const file = path.join(SHOTS_DIR as string, `measure-${set}.json`);
            const results: Record<string, unknown> = process.env.MEP_SHOTS_ONLY !== undefined && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
            if (set === 'petrol' && !fs.existsSync(PETROL)) {
                this.skip();
            }
            const editor: EditorPage | undefined = await openEditorPage({
                width: 1280, height: 800, styles: ['markdown-extended.css'], stylesheets: set === 'petrol' ? [PETROL] : [],
            });
            if (!editor) {
                this.skip();
            }
            const page = (editor as EditorPage).page;
            const show = shower(editor as EditorPage);
            try {
                for (const shot of SHOTS.filter(s => process.env.MEP_SHOTS_ONLY === undefined || s.name.startsWith(process.env.MEP_SHOTS_ONLY))) {
                    const themes = set === 'default' ? shot.themes : shot.petrol;
                    for (const width of shot.widths) {
                        for (const theme of themes) {
                            const name = `${shot.name}-${width}-${theme.name.toLowerCase().replace(/\s+/g, '-')}${set === 'petrol' ? '-petrol' : ''}`;
                            try {
                                await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
                                await applyTheme(page, theme);
                                await delay(200);
                                await shot.step(page, show);
                                await delay(250);
                                const m = await measure(page);
                                results[name] = m === null ? { missing: 'no refusal shown' } : {
                                    ...m,
                                    textContrast: Number(contrastOf(m.colour, m.back).toFixed(2)),
                                    barContrast: Number(contrastOf(m.bar, m.back).toFixed(2)),
                                    codeContrast: m.code === null ? null : Number(contrastOf(m.code, m.back).toFixed(2)),
                                };
                                await page.screenshot({ path: path.join(SHOTS_DIR as string, `${name}.png`) });
                            } catch (error) {
                                results[name] = { error: String(error).split('\n')[0] };
                                console.log(`shot ${name}: ${String(error).split('\n')[0]}`);
                            }
                        }
                    }
                }
                if (set === 'default') {
                    // s9: the dismiss rule — a) shown, b) gone after a click, c) said again at a new place.
                    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
                    await applyTheme(page, LIGHT_MODERN);
                    await show(REFUSALS_DOC, 'Refusals');
                    await clickText(page, 'ab', 1);
                    await page.keyboard.type('|');
                    await delay(250);
                    await page.screenshot({ path: path.join(SHOTS_DIR as string, 's9-dismiss-a-shown-1280-light-modern.png') });
                    await clickText(page, 'Last paragraph', 2);
                    await delay(250);
                    await page.screenshot({ path: path.join(SHOTS_DIR as string, 's9-dismiss-b-gone-1280-light-modern.png') });
                    await delay(500);
                    await clickText(page, 'cd', 1);
                    await page.keyboard.type('|');
                    await delay(250);
                    await page.screenshot({ path: path.join(SHOTS_DIR as string, 's9-dismiss-c-again-1280-light-modern.png') });
                    // The source box's Apply and Cancel, at rest.
                    await show(REFUSALS_DOC, 'Refusals');
                    const raw = await pointAt(page, 'raw block', 1);
                    await page.mouse.click(raw.x, raw.y, { clickCount: 2 });
                    await page.waitForSelector('.mep-raw-editor');
                    for (const theme of [LIGHT_MODERN, DARK_MODERN, HC_DARK]) {
                        await applyTheme(page, theme);
                        await delay(150);
                        await page.screenshot({ path: path.join(SHOTS_DIR as string, `s3-source-box-1280-${theme.name.toLowerCase().replace(/\s+/g, '-')}.png`) });
                    }
                    await page.keyboard.press('Escape');
                }
            } finally {
                fs.writeFileSync(path.join(SHOTS_DIR as string, `measure-${set}.json`), `${JSON.stringify(results, null, 2)}\n`);
                // Not `closeEditorPage`: that sets this test's timeout to the hook's.
                await (editor as EditorPage).close();
            }
        });
    }
});
