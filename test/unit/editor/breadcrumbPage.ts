import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { EXTENSION_ID, EditMessage, EditorPage, MOD, delay, pointAt } from './pageHarness';

/** The caret's bar, shown. */
export const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
/** The breadcrumb in it (#8). */
export const CRUMBS = `${BAR} .mep-crumbs`;
/** A field bar the row's menus open. */
export const ROW_FIELD = '.mep-object-toolbar[data-trigger="toolbar"]';
/** Any open field, a bar's or the row's. */
export const ANY_FIELD = '.mep-object-toolbar .mep-inline-field';

/** What the breadcrumb suites (#8) do on the page: show a document, put the caret, read the bar, the field and the edits. */
export interface BreadcrumbPage {
    show(text: string, marker?: string): Promise<void>;
    clickAt(needle: string, index?: number): Promise<void>;
    /** The caret at `needle`, and the rest that brings its bar. */
    restAt(needle: string, index?: number): Promise<void>;
    pressAlt(key: puppeteer.KeyInput): Promise<void>;
    undo(): Promise<void>;
    lastEdit(): Promise<EditMessage | undefined>;
    openMenu(menu: 'formatting' | 'block-type'): Promise<void>;
    /** The menu opened from its face by the keyboard, the focus in it on its first entry. */
    openMenuByKeys(menu: 'formatting' | 'block-type'): Promise<void>;
    hint(): Promise<string>;
}

/** The suites' document every one shows: it ends with a marker paragraph the page is waited for. */
export const MARKER = 'The last paragraph.';

export function breadcrumbPage(editor: () => EditorPage): BreadcrumbPage {
    let version = 0;
    const page = () => editor().page;
    return {
        show: async (text: string, marker = 'last paragraph') => {
            const p = page();
            await p.mouse.move(2, 2);
            await p.evaluate(() => {
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
            const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
            version++;
            await editor().send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
            await p.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
            // Long enough that the next click is no double click with the last one.
            await delay(600);
        },
        clickAt: async (needle: string, index = 1) => {
            const at = await pointAt(page(), needle, index);
            await page().mouse.click(at.x, at.y);
            await delay(80);
        },
        restAt: async (needle: string, index = 1) => {
            const at = await pointAt(page(), needle, index);
            await page().mouse.click(at.x, at.y);
            await delay(INLINE_DELAY_MS + 250);
        },
        pressAlt: async (key: puppeteer.KeyInput) => {
            await page().keyboard.down('Alt');
            await page().keyboard.press(key);
            await page().keyboard.up('Alt');
            await delay(150);
        },
        undo: async () => {
            await page().keyboard.down(MOD);
            await page().keyboard.press('z');
            await page().keyboard.up(MOD);
            await delay(150);
        },
        lastEdit: async () => (await editor().edits()).pop(),
        openMenu: async (menu: 'formatting' | 'block-type') => {
            await page().click(`.mep-toolbar .mep-menu-face[data-menu="${menu}"]`);
            await page().waitForSelector(`.mep-menu[data-menu="${menu}"]:not([hidden])`);
        },
        openMenuByKeys: async (menu: 'formatting' | 'block-type') => {
            await page().focus(`.mep-toolbar .mep-menu-face[data-menu="${menu}"]`);
            await page().keyboard.press('ArrowDown');
            await page().waitForSelector(`.mep-menu[data-menu="${menu}"]:not([hidden])`);
        },
        hint: () => page().$eval('.mep-hint', el => ((el as HTMLElement).hidden ? '' : el.textContent ?? '')),
    };
}

/** The window's rectangle of the first element `selector` names, or of the block holding `needle` (its nearest `tag`). */
export async function rectOf(page: puppeteer.Page, selector: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
    const r = await page.$eval(selector, el => {
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    });
    assert.ok(r, selector);
    return r;
}

/** The rectangle of the nearest `tag` around the text `needle`, in the window. */
export function blockRect(page: puppeteer.Page, needle: string, tag: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
    return page.evaluate((n, t) => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if ((node.textContent ?? '').includes(n)) {
                const el = node.parentElement?.closest(t) as HTMLElement;
                const b = el.getBoundingClientRect();
                return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
            }
        }
        throw new Error(`no "${n}"`);
    }, needle, tag);
}
