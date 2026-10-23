import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { EditorPage, SHOTS_DIR, delay, leaveObjects, openEditorPage } from './pageHarness';
import { BAR, breadcrumbPage } from './breadcrumbPage';
import { contrastOf } from './refusals.e2e.test';
import { NOTES_DOC } from './noteAttributes.e2e.test';
import { hostEngine } from './helpers';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** A user stylesheet loaded as `markdown.styles` loads it (Daniel's petrol one): read in place, never copied; skipped without it. */
const USER_STYLESHEET = process.env.MEP_USER_STYLESHEET;
/** Daniel's Tempo block (06-30, copied to a temp fixture outside the repository), and the same parsed by the build before #15 (JSON). */
const FIXTURE = process.env.MEP_NOTE_FIXTURE;
const FIXTURE_BEFORE = process.env.MEP_NOTE_FIXTURE_BEFORE;

/** R2 and R4's documents, and a plain paragraph's. */
const REFUSAL_DOC = 'A plain first line.\n\nTimes @Owner Mia@ and @b@ here.\n\nPrice $Status${.l}5 here.\n\nThe last paragraph.\n';

type Doc = string | { json: unknown };
type Step = (page: puppeteer.Page, b: ReturnType<typeof breadcrumbPage>) => Promise<void>;

/** The caret at character `k` of `needle` without a click (a note floated into the margin), and the rest that brings its bar. */
async function caretIn(page: puppeteer.Page, needle: string, k: number): Promise<void> {
    await page.focus('.ProseMirror');
    // First out of whatever the last scene's Esc dismissed a bar in: the document's first text.
    await page.evaluate(() => {
        const first = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT).nextNode();
        if (first) {
            (document.getSelection() as Selection).collapse(first, 1);
        }
    });
    await delay(200);
    await page.evaluate((n, i) => {
        const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(n);
            if (at >= 0) {
                node.parentElement?.scrollIntoView({ block: 'center' });
                (document.getSelection() as Selection).collapse(node, at + i);
                return;
            }
        }
        throw new Error(`no "${n}"`);
    }, needle, k);
    await delay(INLINE_DELAY_MS + 250);
}

async function selectWord(page: puppeteer.Page, needle: string): Promise<void> {
    await page.focus('.ProseMirror');
    await page.evaluate(n => {
        const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(n);
            if (at >= 0) {
                node.parentElement?.scrollIntoView({ block: 'center' });
                (document.getSelection() as Selection).setBaseAndExtent(node, at, node, at + n.length);
                return;
            }
        }
        throw new Error(`no "${n}"`);
    }, needle);
    await delay(700);
}

const press = async (page: puppeteer.Page, id: string) => {
    await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
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

const fixtureText = () => (FIXTURE && fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, 'utf8') : null);

/** The shot list (plan section 7): each scene's document, widths and step. */
const SCENES: { name: string; doc: () => Doc | null; widths?: number[]; step: Step }[] = [
    { name: 'tempo-before', doc: () => (FIXTURE_BEFORE && fs.existsSync(FIXTURE_BEFORE) ? { json: JSON.parse(fs.readFileSync(FIXTURE_BEFORE, 'utf8')) } : null), step: async () => { await delay(300); } },
    { name: 'tempo-after', doc: fixtureText, step: page => caretIn(page, 'wörtliche Rede', 3) },
    { name: 'bar-marginal', doc: () => NOTES_DOC, step: page => caretIn(page, 'abrupt', 2) },
    { name: 'bar-marginal-inline', doc: () => NOTES_DOC, widths: [900], step: page => caretIn(page, 'abrupt', 2) },
    { name: 'bar-sidebar-heading', doc: fixtureText, step: page => caretIn(page, '03:00', 2) },
    { name: 'focus-first', doc: () => NOTES_DOC, step: async (page, b) => { await caretIn(page, 'abrupt', 2); await b.pressAlt('Enter'); } },
    { name: 'field-marginal', doc: () => NOTES_DOC, step: async page => { await caretIn(page, 'abrupt', 2); await press(page, 'note-attributes'); } },
    { name: 'field-sidebar', doc: fixtureText, step: async page => { await caretIn(page, 'Daniel Fahsig', 2); await press(page, 'note-attributes'); } },
    { name: 'remove-hint', doc: () => NOTES_DOC, step: async page => { await caretIn(page, 'abrupt', 2); await press(page, 'remove-attributes'); } },
    { name: 'crumbs-item-note', doc: () => NOTES_DOC, step: async page => { await caretIn(page, 'kurze Notiz', 2); await press(page, 'remove-attributes'); } },
    { name: 'crumbs-heading-sidebar', doc: () => NOTES_DOC, step: page => caretIn(page, '10:00', 2) },
    {
        // Formatting is in the row's "…" at 520 px: the menus at 1280 only.
        name: 'menu-note', doc: () => NOTES_DOC, widths: [1280], step: async (page, b) => {
            await caretIn(page, 'abrupt', 2);
            await b.openMenuByKeys('formatting');
            await focusEntry(page, 'inline-attributes');
        },
    },
    {
        // Formatting open, the disabled entry pressed: its reason at the row (critique: the menu stays in the shot).
        name: 'menu-resting', doc: () => NOTES_DOC, widths: [1280], step: async (page, b) => {
            await caretIn(page, 'last paragraph', 3);
            await b.openMenu('formatting');
            const entry = '.mep-menu[data-menu="formatting"] [data-action="inline-attributes"]';
            await page.waitForSelector(entry, { visible: true, timeout: 2000 });
            await page.click(entry);
            await delay(300);
        },
    },
    {
        // The bubble's tip on {…}, and — where the bubble holds one (520 px) — its "…" open.
        // The note on the page's first lines: no room above the selected line, the bubble below the note, its tip below the bubble — never over the note (#15 review 3).
        name: 'bubble-note', doc: () => NOTES_DOC.replace('3. Der Ablauf\n   - Punkt', '- Punkt').replace('\n   - Schneller', '\n- Schneller'), step: async page => {
            await selectWord(page, 'abrupt');
            const face = await page.$('.mep-bubble:not([hidden]) .mep-more-face:not([hidden])');
            if (face !== null) {
                await face.click();
                await delay(400);
                return;
            }
            const box = await (await page.$('.mep-bubble:not([hidden]) [data-action="attrs-bubble"]'))?.boundingBox();
            if (box) {
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            }
            await delay(900);
        },
    },
    {
        name: 'refusal-r2', doc: () => REFUSAL_DOC, step: async page => {
            await caretIn(page, 'Owner', 2);
            await press(page, 'note-attributes');
            await page.keyboard.type('data-x="@"');
            await page.keyboard.press('Enter');
        },
    },
    { name: 'refusal-r4', doc: () => REFUSAL_DOC, step: async page => { await caretIn(page, 'Status', 2); await press(page, 'remove-attributes'); } },
    { name: 'narrow-520', doc: () => NOTES_DOC, widths: [520], step: page => caretIn(page, 'abrupt', 2) },
];

const slug = (theme: Theme) => theme.name.toLowerCase().replace(/\s+/g, '-');

function rgbaOf(c: string): [number, number, number, number] | null {
    const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?/.exec(c);
    if (srgb) {
        return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
    }
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null;
}

function composite(fg: string, bg: string, opacity = 1): string {
    const f = rgbaOf(fg);
    const b = rgbaOf(bg);
    if (f === null || b === null) {
        return fg;
    }
    const a = f[3] * opacity;
    return `rgb(${[0, 1, 2].map(k => Math.round(f[k] * a + b[k] * (1 - a))).join(', ')})`;
}

/** The bar's title and its code literal against the bar's ground (alpha composited); the crumb parts' too. */
async function measure(page: puppeteer.Page): Promise<Record<string, unknown>> {
    const m = await page.evaluate(sel => {
        const bar = document.querySelector(sel) as HTMLElement | null;
        if (bar === null) {
            return null;
        }
        const colour = (q: string) => {
            const el = bar.querySelector(q) as HTMLElement | null;
            if (el === null || el.offsetParent === null) {
                return null;
            }
            let o = 1;
            for (let at: HTMLElement | null = el; at !== null && at !== bar; at = at.parentElement) {
                o *= Number(getComputedStyle(at).opacity);
            }
            return { color: getComputedStyle(el).color, opacity: o };
        };
        return {
            back: getComputedStyle(bar).backgroundColor,
            page: getComputedStyle(document.body).backgroundColor,
            title: colour(':scope > .mep-object-label'),
            code: colour(':scope > .mep-object-label .mep-object-label-code'),
            crumbCode: colour('[data-part="current"] .mep-crumb-code'),
        };
    }, BAR);
    if (m === null) {
        return { bar: 'none' };
    }
    const ground = composite(m.back, composite(m.page, 'rgb(255, 255, 255)'));
    const ratio = (c: { color: string; opacity: number } | null) => (c === null ? null : Number(contrastOf(composite(c.color, ground, c.opacity), ground).toFixed(2)));
    return { ground, title: m.title?.color ?? null, code: m.code?.color ?? null, titleContrast: ratio(m.title), codeContrast: ratio(m.code), crumbCodeContrast: ratio(m.crumbCode) };
}

/**
 * #15's shot list (plan section 7) into `MEP_SHOTS_DIR`: each scene at 1280
 * and 520 px (or its own widths) in Light Modern, Dark Modern and High
 * Contrast, and — with `MEP_USER_STYLESHEET` — again with that stylesheet
 * (light, dark), named `<scene>-<width>-<theme>[-petrol].png`, scale 1. The
 * contrast of the title's code literal in `measure-<set>.json`. Skipped
 * without `MEP_SHOTS_DIR`; Daniel's scenes without `MEP_NOTE_FIXTURE`.
 */
suite('Editor note attributes: screenshots (e2e)', () => {
    suiteSetup(function () {
        if (!SHOTS_DIR) {
            this.skip();
        }
    });

    for (const set of ['default', 'petrol'] as const) {
        test(`the shot list with the ${set} stylesheets`, async function () {
            this.timeout(1800000);
            if (set === 'petrol' && (USER_STYLESHEET === undefined || !fs.existsSync(USER_STYLESHEET))) {
                this.skip();
            }
            // The petrol sheet as `markdown.styles` links it: after the extension's styles (`userStyles`).
            const editor = await openEditorPage({ width: 1280, height: 800, styles: ['markdown-extended.css', 'markdown-it-admonition.css', 'markdown-it-kbd.css'], userStyles: set === 'petrol' ? [USER_STYLESHEET as string] : [] });
            if (!editor) {
                this.skip();
            }
            const page = (editor as EditorPage).page;
            const b = breadcrumbPage(() => editor as EditorPage);
            let version = 0;
            const show = async (doc: Doc) => {
                await page.mouse.move(2, 2);
                await page.evaluate(() => {
                    for (const menu of Array.from(document.querySelectorAll('.mep-menu:not([hidden])'))) {
                        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    }
                    (document.activeElement as HTMLElement | null)?.blur();
                    const hint = document.querySelector('.mep-hint') as HTMLElement | null;
                    if (hint) {
                        hint.hidden = true;
                    }
                    window.scrollTo(0, 0);
                });
                version++;
                const json = typeof doc === 'string' ? parsedDocumentToJSON(parseDocument(hostEngine(), doc, {})) : doc.json;
                await (editor as EditorPage).send({ type: 'document', json: json as never, version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
                await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('last paragraph'));
                await delay(600);
            };
            const only = process.env.MEP_SHOTS_ONLY;
            const file = path.join(SHOTS_DIR as string, `measure-${set}.json`);
            const results: Record<string, unknown> = only !== undefined && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
            const themes = set === 'default' ? [LIGHT_MODERN, DARK_MODERN, HC_DARK] : [LIGHT_MODERN, DARK_MODERN];
            try {
                for (const scene of SCENES.filter(s => only === undefined || s.name.startsWith(only))) {
                    const doc = scene.doc();
                    if (doc === null) {
                        console.log(`shot ${scene.name}: no fixture, skipped`);
                        continue;
                    }
                    for (const width of scene.widths ?? [1280, 520]) {
                        for (const theme of themes) {
                            const name = `${scene.name}-${width}-${slug(theme)}${set === 'petrol' ? '-petrol' : ''}`;
                            try {
                                await page.keyboard.press('Escape');
                                if (await page.$('.ProseMirror')) {
                                    await leaveObjects(page);
                                }
                                await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
                                await applyTheme(page, theme);
                                await show(doc);
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
            } finally {
                fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
                await (editor as EditorPage).close();
            }
        });
    }
});
