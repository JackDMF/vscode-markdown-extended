import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { EditorPage, SHOTS_DIR, delay, leaveObjects, openEditorPage } from './pageHarness';
import { BAR, BreadcrumbPage, CRUMBS, breadcrumbPage } from './breadcrumbPage';
import { contrastOf } from './refusals.e2e.test';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** A user stylesheet loaded as `markdown.styles` loads it (Daniel's petrol one): read, never copied; that set is skipped without it. */
const USER_STYLESHEET = process.env.MEP_USER_STYLESHEET;

/** Two-part bars on inline parts (#8 review 1): Quote › Link, List item › Image. */
const INLINE_DOC = [
    'Inline parts.',
    '',
    '> See the [sync guide](guide.md){.ref} before you merge anything.',
    '> {.tip}',
    '',
    '- ![diagram](diagram.png){.wide} The flow of a sync {.figure}',
    '- The second step',
    '',
    'The last paragraph.',
    '',
].join('\n');

const DOC = [
    'Sync behaviour, as the team agreed it.',
    '',
    '- Queue the edit locally {.lead}',
    '- Send the batch',
    '- Confirm the sync',
    '',
    '{.steps}',
    '',
    '> Conflicts are shown to the **user**{.term} before anything is merged.',
    '> {.warning}',
    '',
    '> ## Sync rules {#sync-rules}',
    '>',
    '> The rules the sync follows.',
    '> {.note}',
    '',
    '!!! warning',
    '    ## Before you merge {#before-merge}',
    '',
    '    Read the rules first.',
    '',
    '::: box',
    'Inside a container.',
    ':::',
    '',
    '> Notes before the list.',
    '>',
    '> - a listed note',
    '',
    '> - quoted item',
    '> - another quoted item',
    '',
    'The last paragraph.',
    '',
].join('\n');

const LONG = `A long list.\n\n${Array.from({ length: 60 }, (_, k) => `- Item number ${k + 1} of the long list`).join('\n')}\n\n{.steps}\n\nThe last paragraph.\n`;

const NARROW = [
    // A plain first line: where `leaveObjects` puts the caret, out of the last scene's dismissed object.
    'A narrow window.',
    '',
    '- Queue the edit locally {.lead data-step=1}',
    '- Send the batch',
    '',
    '{.steps .numbered data-flow=sync}',
    '',
    '!!! warning',
    '    ## Sync rules {#sync-rules .anchored}',
    '',
    '    Body text.',
    '',
    'The last paragraph.',
    '',
].join('\n');

type Step = (page: puppeteer.Page, b: BreadcrumbPage) => Promise<void>;

const part = (page: puppeteer.Page, which: 'outer' | 'current') => page.click(`${CRUMBS} [data-part="${which}"]`);
/** A verb pressed where it stands: on the bar, or — moved there at 520 px — in its "…". */
const verb = async (page: puppeteer.Page, id: string) => {
    const shown = await page.$eval(`${BAR} [data-verb="${id}"]`, el => !(el as HTMLElement).hidden).catch(() => false);
    if (shown) {
        await page.click(`${BAR} [data-verb="${id}"]`);
        return;
    }
    await page.click(`${BAR} .mep-object-more`);
    await page.waitForSelector(`${BAR} .mep-object-menu [data-entry="${id}"]`, { visible: true, timeout: 2000 });
    await page.click(`${BAR} .mep-object-menu [data-entry="${id}"]`);
};
const focusEntry = async (page: puppeteer.Page, action: string) => {
    for (let k = 0; k < 24 && !(await page.evaluate(a => (document.activeElement as HTMLElement | null)?.dataset.action === a, action)); k++) {
        await page.keyboard.press('ArrowDown');
        await delay(30);
    }
    await delay(450);
};

/** The shot list (plan section 7): each scene's step, from a document shown afresh. */
const SCENES: { name: string; doc?: string; step: Step }[] = [
    { name: 'bar-list', step: (_, b) => b.restAt('Queue the edit', 2) },
    { name: 'bar-list-bare', step: (_, b) => b.restAt('Send the batch', 2) },
    { name: 'bar-quote-bold', step: (_, b) => b.restAt('user', 2) },
    { name: 'bar-quote-heading', step: (_, b) => b.restAt('Sync rules', 2) },
    { name: 'bar-admonition-heading', step: (_, b) => b.restAt('Before you merge', 2) },
    { name: 'bar-single', step: (_, b) => b.restAt('Conflicts are', 3) },
    // #8 review 1: Link › Quote and Image › List item, two-part bars on inline parts.
    { name: 'bar-link', doc: INLINE_DOC, step: (_, b) => b.restAt('sync guide', 3) },
    {
        name: 'bar-image', doc: INLINE_DOC, step: async page => {
            await page.click('.ProseMirror img[src*="diagram"], .ProseMirror [data-src*="diagram"]');
            await delay(900);
        },
    },
    { name: 'focus-first', step: async (_, b) => { await b.clickAt('Queue the edit', 2); await b.pressAlt('Enter'); } },
    { name: 'focus-first-admonition', step: async (_, b) => { await b.clickAt('Before you merge', 2); await b.pressAlt('Enter'); } },
    {
        name: 'focus-part-outer', step: async (page, b) => {
            await b.clickAt('Queue the edit', 2);
            await b.pressAlt('Enter');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
            const box = await (await page.$(`${CRUMBS} [data-part="outer"]`))?.boundingBox();
            if (box) {
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            }
            await delay(900);
        },
    },
    { name: 'field-item', step: async (page, b) => { await b.restAt('Queue the edit', 2); await part(page, 'current'); } },
    { name: 'field-list', step: async (page, b) => { await b.restAt('Queue the edit', 2); await part(page, 'outer'); } },
    {
        name: 'field-list-scrolled', doc: LONG, step: async (page, b) => {
            await b.restAt('Item number 1 of', 3);
            await b.pressAlt('Enter');
            await page.keyboard.press('Home');
            await page.keyboard.press('Enter');
        },
    },
    { name: 'field-bold', step: async (page, b) => { await b.restAt('user', 2); await part(page, 'current'); } },
    { name: 'field-quote', step: async (page, b) => { await b.restAt('user', 2); await part(page, 'outer'); } },
    { name: 'remove-open', step: async (page, b) => { await b.restAt('Queue the edit', 2); await verb(page, 'remove-attributes'); } },
    { name: 'remove-admonition', step: async (page, b) => { await b.restAt('Before you merge', 2); await verb(page, 'remove-menu'); } },
    {
        name: 'remove-hint', step: async (page, b) => {
            await b.restAt('Queue the edit', 2);
            await verb(page, 'remove-attributes');
            await page.click(`${BAR} .mep-object-menu [data-entry="remove-current"]`);
        },
    },
    { name: 'menu-item', step: async (page, b) => { await b.clickAt('Queue the edit', 2); await b.openMenuByKeys('block-type'); await focusEntry(page, 'block-type-attributes'); } },
    { name: 'menu-list', step: async (page, b) => { await b.clickAt('Queue the edit', 2); await b.openMenuByKeys('block-type'); await focusEntry(page, 'block-type-outer-attributes'); } },
    { name: 'menu-quote', step: async (page, b) => { await b.clickAt('Conflicts are', 3); await b.openMenuByKeys('block-type'); await focusEntry(page, 'block-type-attributes'); } },
    { name: 'menu-heading-in-quote', step: async (page, b) => { await b.clickAt('Sync rules', 2); await b.openMenuByKeys('block-type'); await focusEntry(page, 'block-type-outer-attributes'); } },
    {
        name: 'menu-list-in-quote', step: async (page, b) => {
            await b.clickAt('quoted item', 3);
            await b.openMenuByKeys('block-type');
            await page.hover('.mep-menu[data-menu="block-type"] [data-action="block-type-outer-attributes"]');
            await delay(600);
        },
    },
    { name: 'refusal-admonition', step: async (page, b) => { await b.clickAt('Read the rules', 2); await b.pressAlt('Enter'); await verb(page, 'block-attributes'); } },
    { name: 'refusal-container', step: async (page, b) => { await b.clickAt('Inside a container', 2); await b.pressAlt('Enter'); await verb(page, 'block-attributes'); } },
    {
        name: 'refusal-quote-list', step: async (page, b) => {
            await b.clickAt('Notes before', 2);
            await b.openMenuByKeys('block-type');
            await page.click('.mep-menu[data-menu="block-type"] [data-action="block-type-attributes"]');
        },
    },
    { name: 'refusal-nested-list', step: async (page, b) => { await b.clickAt('quoted item', 3); await b.pressAlt('Enter'); await part(page, 'outer'); } },
];

const slug = (theme: Theme) => theme.name.toLowerCase().replace(/\s+/g, '-');

/** A computed colour as [r, g, b, a] (`rgb(…)`, `rgba(…)`, `color(srgb r g b / a)`); `null` where it is none of them. */
function rgbaOf(c: string): [number, number, number, number] | null {
    const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?/.exec(c);
    if (srgb) {
        return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    }
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
}

/** `fg` with its alpha (times `opacity`, the element's own) laid over the opaque `bg`, as the eye sees it (#8 review 1: HC's colours carry alpha). */
function composite(fg: string, bg: string, opacity = 1): string {
    const f = rgbaOf(fg);
    const b = rgbaOf(bg);
    if (f === null || b === null) {
        return fg;
    }
    const a = f[3] * opacity;
    const mix = [0, 1, 2].map(k => Math.round(f[k] * a + b[k] * (1 - a)));
    return `rgb(${mix.join(', ')})`;
}

/**
 * What the bar measures: the parts' colours against the bar's ground — each
 * alpha composited, the ground over the page's, a part's colour (and its
 * opacity) over the ground — the current name's weight, a focused control's ring.
 */
async function measure(page: puppeteer.Page): Promise<Record<string, unknown>> {
    const m = await page.evaluate(sel => {
        const bar = document.querySelector(sel) as HTMLElement | null;
        if (bar === null) {
            return null;
        }
        const back = getComputedStyle(bar).backgroundColor;
        const page = getComputedStyle(document.body).backgroundColor;
        const opacityOf = (el: HTMLElement) => {
            let o = 1;
            for (let at: HTMLElement | null = el; at !== null && at !== bar; at = at.parentElement) {
                o *= Number(getComputedStyle(at).opacity);
            }
            return o;
        };
        const colour = (q: string) => {
            const el = bar.querySelector(q) as HTMLElement | null;
            return el === null || el.offsetParent === null ? null : { color: getComputedStyle(el).color, opacity: opacityOf(el) };
        };
        const focused = document.activeElement instanceof HTMLElement && bar.contains(document.activeElement) && document.activeElement !== bar ? getComputedStyle(document.activeElement) : null;
        return {
            back,
            page,
            outer: colour('[data-part="outer"] .mep-crumb-name'),
            current: colour('[data-part="current"] .mep-crumb-name'),
            weight: (() => {
                const el = bar.querySelector('[data-part="current"] .mep-crumb-name');
                return el === null ? null : getComputedStyle(el).fontWeight;
            })(),
            ring: focused === null ? null : { color: focused.outlineColor, opacity: 1 },
            hoverOutline: getComputedStyle(document.body).getPropertyValue('--vscode-toolbar-hoverOutline').trim() || null,
        };
    }, BAR);
    if (m === null) {
        return { bar: 'none' };
    }
    // The ground as drawn: the bar's colour over the page's (itself over white where the page sets none).
    const ground = composite(m.back, composite(m.page, 'rgb(255, 255, 255)'));
    const ratio = (c: { color: string; opacity: number } | null) => (c === null ? null : Number(contrastOf(composite(c.color, ground, c.opacity), ground).toFixed(2)));
    return {
        ...m, ground, outer: m.outer?.color ?? null, current: m.current?.color ?? null, ring: m.ring?.color ?? null,
        outerContrast: ratio(m.outer), currentContrast: ratio(m.current), ringContrast: ratio(m.ring),
    };
}

/**
 * #8's shot list (plan section 7) into `MEP_SHOTS_DIR`: every scene at 1280
 * and 520 px in Light Modern, Dark Modern and High Contrast, and — with
 * `MEP_USER_STYLESHEET` — again with that stylesheet (light, dark), named
 * `<scene>-<width>-<theme>[-petrol].png`; the narrow ladder at 700…380 px.
 * What each measured is written beside them (`measure-<set>.json`). Skipped
 * without `MEP_SHOTS_DIR`.
 */
suite('Editor breadcrumb: screenshots (e2e)', () => {
    suiteSetup(function () {
        if (!SHOTS_DIR) {
            this.skip();
        }
    });

    for (const set of ['default', 'petrol'] as const) {
        test(`the shot list with the ${set} stylesheets`, async function () {
            this.timeout(1200000);
            if (set === 'petrol' && (USER_STYLESHEET === undefined || !fs.existsSync(USER_STYLESHEET))) {
                this.skip();
            }
            const editor = await openEditorPage({ width: 1280, height: 800, styles: ['markdown-extended.css'], stylesheets: set === 'petrol' ? [USER_STYLESHEET as string] : [] });
            if (!editor) {
                this.skip();
            }
            const page = (editor as EditorPage).page;
            const b = breadcrumbPage(() => editor as EditorPage);
            const only = process.env.MEP_SHOTS_ONLY;
            // A run of some scenes (`MEP_SHOTS_ONLY`) adds to what an earlier run measured.
            const file = path.join(SHOTS_DIR as string, `measure-${set}.json`);
            const results: Record<string, unknown> = only !== undefined && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
            const themes = set === 'default' ? [LIGHT_MODERN, DARK_MODERN, HC_DARK] : [LIGHT_MODERN, DARK_MODERN];
            try {
                for (const scene of SCENES.filter(s => only === undefined || s.name.startsWith(only))) {
                    for (const width of [1280, 520]) {
                        for (const theme of themes) {
                            const name = `${scene.name}-${width}-${slug(theme)}${set === 'petrol' ? '-petrol' : ''}`;
                            try {
                                await page.keyboard.press('Escape');
                                // Out of the object the last scene's Esc dismissed: a click back into it would not bring its bar.
                                if (await page.$('.ProseMirror')) {
                                    await leaveObjects(page);
                                }
                                await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
                                await applyTheme(page, theme);
                                await b.show(scene.doc ?? DOC);
                                await scene.step(page, b);
                                await delay(350);
                                results[name] = await measure(page);
                                await page.screenshot({ path: path.join(SHOTS_DIR as string, `${name}.png`) });
                            } catch (error) {
                                results[name] = { error: String(error).split('\n')[0] };
                                console.log(`shot ${name}: ${String(error).split('\n')[0]}`);
                            }
                        }
                    }
                }
                if (only === undefined || 'narrow-ladder'.startsWith(only)) {
                    // The fit ladder, each step as the bar narrows (List, Admonition › Heading).
                    for (const [what, needle] of [['list', 'Queue the edit'], ['admonition', 'Sync rules']] as const) {
                        for (const theme of themes) {
                            await page.keyboard.press('Escape');
                            if (await page.$('.ProseMirror')) {
                                await leaveObjects(page);
                            }
                            await page.setViewport({ width: 900, height: 800, deviceScaleFactor: 1 });
                            await applyTheme(page, theme);
                            await b.show(NARROW);
                            await b.restAt(needle, 2);
                            for (const width of [700, 560, 520, 440, 380]) {
                                const name = `narrow-ladder-${what}-${width}-${slug(theme)}${set === 'petrol' ? '-petrol' : ''}`;
                                await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
                                await delay(300);
                                results[name] = await measure(page);
                                await page.screenshot({ path: path.join(SHOTS_DIR as string, `${name}.png`) });
                            }
                        }
                    }
                }
            } finally {
                fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
                await (editor as EditorPage).close();
            }
        });
    }
});
