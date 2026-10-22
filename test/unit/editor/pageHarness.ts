import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as vscode from 'vscode';
import { DiagnosticEntry, HostMessage, WebviewMessage } from '../../../src/editor/protocol';
import { HOVER_DELAY_MS } from '../../../src/editor/webview/hover';
import { LIGHT_MODERN, applyTheme } from './themes';
import { WEBVIEW_DEFAULT_STYLES_ID, webviewDefaultStyles } from './webviewDefaults';

export const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

export type EditMessage = Extract<WebviewMessage, { type: 'edit' }>;

/** The editor's page in headless Chromium, with the host's half of the protocol played by the test. */
export interface EditorPage {
    page: puppeteer.Page;
    /** Everything the page posted to the host so far. */
    posted(): Promise<WebviewMessage[]>;
    edits(): Promise<EditMessage[]>;
    /** Post a message to the page as the host would. */
    send(message: HostMessage): Promise<void>;
    close(): Promise<void>;
}

/** Long enough for the page's typing delay (250 ms) to pass and its edit to be posted. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 500));

/** Wait `ms` milliseconds. */
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The caret to the start of the text, as a person leaving the object they were in: what Esc dismissed
 * there — a bar hidden until the caret leaves its object — is over. A suite whose next document holds
 * an object where the last test's did calls it before it blurs the page, so no test starts with
 * the bar of the one before still dismissed (a click back into the same object does not end it).
 */
export async function leaveObjects(page: puppeteer.Page): Promise<void> {
    const start = await page.evaluate(() => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const first = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
        if (!first) {
            return null;
        }
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(first, 1);
        const r = range.getBoundingClientRect();
        return { x: r.left + 1, y: (r.top + r.bottom) / 2 };
    });
    if (start) {
        await page.mouse.click(start.x, start.y);
        await delay(120);
    }
}

/** With `MEP_SHOTS_DIR` set, the suites save a screenshot of each state they name there; without it, none. */
export const SHOTS_DIR = process.env.MEP_SHOTS_DIR;

/** A screenshot of `page` as `name` in `MEP_SHOTS_DIR`; nothing when it is not set. */
export async function shot(page: puppeteer.Page, name: string): Promise<void> {
    if (SHOTS_DIR) {
        fs.mkdirSync(SHOTS_DIR, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS_DIR, name) });
    }
}

/** The point just inside the left edge of character `index` of the first `needle` in the document's text. */
export function pointAt(page: puppeteer.Page, needle: string, index = 0): Promise<{ x: number; y: number }> {
    return page.evaluate((n, k) => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(n);
            if (at >= 0) {
                const range = document.createRange();
                range.setStart(node, at + k);
                range.setEnd(node, at + k + 1);
                const r = range.getBoundingClientRect();
                return { x: r.left + 1, y: r.top + r.height / 2 };
            }
        }
        throw new Error(`no "${n}" in the document`);
    }, needle, index);
}

/** A real click just inside the left edge of character `index` of `needle`, given time for ProseMirror to read the selection. */
export async function clickText(page: puppeteer.Page, needle: string, index = 0): Promise<void> {
    const p = await pointAt(page, needle, index);
    await page.mouse.click(p.x, p.y);
    await delay(80);
}

/**
 * What a control's tooltip says (`tooltip.ts`): its `aria-description`, which
 * the hover shows — the reason after a newline — or `''` where it has none.
 * The one way the suites read a tooltip; no control carries a `title`.
 */
export function describedTip(page: puppeteer.Page, selector: string): Promise<string> {
    return page.$eval(selector, el => el.getAttribute('aria-description') ?? '');
}

/** The hover the pointer brings after a rest on `selector`: its text (the parts, then the note) and where it stands; `null` where none shows. */
export async function hoverTip(page: puppeteer.Page, selector: string): Promise<{ text: string; rect: { left: number; top: number; right: number; bottom: number } } | null> {
    const box = await (await page.$(selector))?.boundingBox();
    assert.ok(box, `no ${selector}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await delay(HOVER_DELAY_MS + 100);
    return page.evaluate(() => {
        const tip = document.querySelector('.mep-tooltip') as HTMLElement | null;
        if (!tip || tip.hidden) {
            return null;
        }
        const r = tip.getBoundingClientRect();
        const note = tip.querySelector('.mep-tip-note');
        const line = Array.from(tip.childNodes).filter(n => n !== note).map(n => n.textContent ?? '').join('');
        return { text: note ? `${line}\n${note.textContent ?? ''}` : line, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
    });
}

/** A `#rrggbb` colour as the browser computes it (`rgb(r, g, b)`); anything else as given — for comparing with a computed style. */
export function computedColour(colour: string): string {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
    return hex ? `rgb(${parseInt(hex[1], 16)}, ${parseInt(hex[2], 16)}, ${parseInt(hex[3], 16)})` : colour;
}

/** Post `items` as the host's diagnostics for `version`, and wait until the page has drawn them (the row's count shows). */
export async function showDiagnostics(editor: EditorPage, version: number, items: DiagnosticEntry[]): Promise<void> {
    await editor.send({ type: 'diagnostics', version, items });
    await editor.page.waitForSelector(items.length > 0 ? '.mep-diag-count:not([hidden])' : '.mep-diag-count[hidden]');
}

/**
 * The modifier the page's `Mod-` keys and the browser's own editing commands
 * (copy, paste, select all) answer to, and a link's open-click: ⌘ on macOS, Ctrl
 * elsewhere. The browser runs on this machine, so its platform is this one's.
 */
export const MOD: puppeteer.KeyInput = process.platform === 'darwin' ? 'Meta' : 'Control';

/** How a hint names undo (`hint.ts`): `Cmd+Z` on macOS, `Ctrl+Z` elsewhere. */
export const UNDO = process.platform === 'darwin' ? 'Cmd+Z' : 'Ctrl+Z';

/**
 * The options for pressing `key` with `MOD` held where the browser's own editing
 * command should run (select all, copy, cut, paste): on macOS the protocol
 * delivers the keys but not the command they stand for, so it is named.
 */
export function editCommand(key: string, shift = false): puppeteer.KeyPressOptions | undefined {
    if (process.platform !== 'darwin') {
        return undefined;
    }
    const command = ({ a: 'SelectAll', c: 'Copy', x: 'Cut', v: shift ? 'PasteAndMatchStyle' : 'Paste' } as Record<string, string>)[key.replace(/^Key/, '').toLowerCase()];
    return command ? { commands: [command] } : undefined;
}

export interface EditorPageOptions {
    /** The viewport width; 1200 unless given. */
    width?: number;
    /** The viewport height; 900 unless given. */
    height?: number;
    /** Stylesheets of this extension's `styles/` to load before `editor.css`, as the preview's cascade would. */
    styles?: readonly string[];
    /** More stylesheets by absolute path, after the built-in Markdown extension's and before `styles`. */
    stylesheets?: readonly string[];
    /**
     * Whether VS Code's built-in Markdown extension is there, as it is unless
     * disabled: the page then starts its cascade with that extension's
     * `markdown.css` and `highlight.css` (`html.ts`). `false` is the page
     * without them — what a disabled extension, or a stylesheet undoing them,
     * leaves: the webview's defaults alone.
     */
    builtinMarkdown?: boolean;
}

/** VS Code's preview stylesheet, from the VS Code the tests run in: the first sheet of the preview's cascade, loaded by default (`builtinMarkdown`); exported for a page built without this harness (`noteStyles.e2e.test.ts`). */
export function vscodeMarkdownCss(): string {
    return path.join(vscode.env.appRoot, 'extensions', 'markdown-language-features', 'media', 'markdown.css');
}

/** VS Code's preview stylesheet for code, the second sheet of the preview's cascade. */
function vscodeHighlightCss(): string {
    return path.join(vscode.env.appRoot, 'extensions', 'markdown-language-features', 'media', 'highlight.css');
}

/**
 * The body's font variables as the host writes them with the Markdown
 * preview's settings at their defaults (`html.ts`, `fontVariables`): no
 * `fontFamily`, `fontSize` 14, `lineHeight` 1.6.
 */
const BODY_FONT_VARIABLES = '--markdown-font-size: 14px; --markdown-line-height: 1.6;';

/**
 * The page bundle (`dist/editor-webview.js`) loaded into headless Chromium, with
 * `acquireVsCodeApi` replaced by a recorder, in the page the host writes
 * (`html.ts`) as VS Code shows it: the webview's default styles at the head
 * (`webviewDefaults.ts`), Light Modern's variables (`themes.ts`), then the built-in Markdown extension's stylesheets,
 * `stylesheets` and `styles`, the codicon font and `styles/editor.css` last.
 *
 * `undefined` when there is no bundle or no browser — the suite then skips, as
 * the other e2e tests do: a browser already available (`MTE_E2E_CHROME`, or
 * the one Puppeteer installed) is used, and nothing is downloaded.
 */
export async function openEditorPage(options: EditorPageOptions = {}): Promise<EditorPage | undefined> {
    const extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
    const bundle = extensionPath ? path.join(extensionPath, 'dist', 'editor-webview.js') : '';
    if (!bundle || !fs.existsSync(bundle)) {
        return undefined;
    }
    let executablePath: string | undefined;
    const envChrome = process.env.MTE_E2E_CHROME;
    if (envChrome && fs.existsSync(envChrome)) {
        executablePath = envChrome;
    } else {
        try {
            const bundled = puppeteer.executablePath();
            executablePath = bundled && fs.existsSync(bundled) ? bundled : undefined;
        } catch {
            executablePath = undefined;
        }
    }
    if (!executablePath) {
        return undefined;
    }

    // Checked before a browser is started: a sheet that is not there is a page the host never writes, refused, not left out.
    const builtin = options.builtinMarkdown === false ? [] : [vscodeMarkdownCss(), vscodeHighlightCss()];
    const sheets = [...builtin, ...options.stylesheets ?? []];
    for (const sheet of sheets) {
        assert.ok(fs.existsSync(sheet), `no stylesheet at ${sheet}`);
    }

    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', ...FRAME_ARGS] });
    try {
        return await preparePage(browser, bundle, extensionPath as string, sheets, options);
    } catch (error) {
        // A page that failed to come up leaves no browser behind.
        await closeBrowser(browser);
        throw error;
    }
}

/**
 * Frames whatever the screen does. Headless Chromium on macOS takes its frames
 * from the display's refresh: with the display asleep — a full run left to
 * itself past the energy saver's minutes — no frame comes, no
 * `requestAnimationFrame` runs, and every layer placed once per frame
 * (`placement.ts`) stays where it was; the suites then fail by the dozen, or
 * one here and there as the display dims. Without the frame-rate limit the
 * frames come from a timer of the browser's own.
 */
export const FRAME_ARGS = ['--disable-frame-rate-limit'];

/** The page in `browser`: the host's page written, its stylesheets and the bundle loaded. */
async function preparePage(browser: puppeteer.Browser, bundle: string, extensionPath: string, sheets: readonly string[], options: EditorPageOptions): Promise<EditorPage> {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width ?? 1200, height: options.height ?? 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    // VS Code's own webview defaults first, as it prepends them to every webview's head (`webviewDefaults.ts`).
    await page.setContent(
        `<!DOCTYPE html><html><head><style id="${WEBVIEW_DEFAULT_STYLES_ID}">${webviewDefaultStyles()}</style><meta charset="UTF-8"></head>`
        + `<body class="markdown-body vscode-body vscode-light" style="${BODY_FONT_VARIABLES}"><div id="mep-editor" class="mep-editor"></div>`
        + '<script>window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m) });</script>'
        + '</body></html>',
        { waitUntil: 'load' },
    );
    // A webview always has its theme's variables: Light Modern, which the body's class names, until a test applies another.
    await applyTheme(page, LIGHT_MODERN);
    clickAsAPerson(page);
    for (const sheet of sheets) {
        await page.addStyleTag({ path: sheet });
    }
    for (const sheet of options.styles ?? []) {
        await page.addStyleTag({ path: path.join(extensionPath, 'styles', sheet) });
    }
    // The codicon font, before the editor's own sheet as the host links it (`html.ts`): the
    // chevrons and `$(icon)`s are drawn with it. The page has no origin to load the font file
    // from, so it is given inline.
    const codicons = codiconCss(extensionPath);
    if (codicons) {
        await page.addStyleTag({ content: codicons });
    }
    await page.addStyleTag({ path: path.join(extensionPath, 'styles', 'editor.css') });
    await page.addScriptTag({ path: bundle });
    assert.deepStrictEqual(errors, [], 'the bundle loads without a page error');

    const posted = async (): Promise<WebviewMessage[]> =>
        page.evaluate(() => (window as unknown as { posted: WebviewMessage[] }).posted.slice());
    return {
        page,
        posted,
        edits: async () => (await posted()).filter((m): m is EditMessage => m.type === 'edit'),
        send: async message => {
            await page.evaluate(m => window.postMessage(m, '*'), message as unknown as Record<string, unknown>);
        },
        close: () => closeBrowser(browser),
    };
}

/**
 * A floating layer that just appeared or moved ignores the pointer for
 * `INERT_MS` (`placement.ts`): a person cannot aim at it sooner, a script
 * can. `page.click` and `page.mouse.click` wait first until no layer is inert
 * — as a person would — so the suites click what they meant to. A test of the
 * inert time itself presses with `page.mouse.down`/`up`, which do not wait. A
 * layer still inert after 2 s is a layer whose inert time never ended — the
 * click fails, saying so, instead of landing on a layer a person could not use.
 */
function clickAsAPerson(page: puppeteer.Page): void {
    const settled = async () => {
        try {
            await page.waitForFunction(() => document.querySelector('.mep-layer[data-inert]') === null, { timeout: 2000, polling: 20 });
        } catch {
            throw new Error('layer still inert after 2 s');
        }
    };
    const click = page.click.bind(page);
    page.click = async (selector: string, options?: Readonly<puppeteer.ClickOptions>) => {
        await settled();
        return click(selector, options);
    };
    const mouseClick = page.mouse.click.bind(page.mouse);
    page.mouse.click = async (x: number, y: number, options?: Readonly<puppeteer.MouseClickOptions>) => {
        await settled();
        return mouseClick(x, y, options);
    };
}

/**
 * Close `browser`. On a loaded machine Chromium can take seconds to close, and
 * a teardown that times out fails the run with every test passed. A suite
 * closes through `closeEditorPage`, whose hook has CLOSE_HOOK_MS; what has not
 * closed within the grace is killed, with its whole process tree, inside that.
 */
async function closeBrowser(browser: puppeteer.Browser): Promise<void> {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        browser.close().then(() => {
            closed = true;
        }).catch(() => undefined),
        new Promise<void>(resolve => {
            timer = setTimeout(resolve, CLOSE_GRACE_MS);
        }),
    ]);
    clearTimeout(timer);
    if (!closed) {
        killTree(browser.process()?.pid);
    }
}

/** `dist/codicons/codicon.css` with its font as a `data:` URI; `undefined` before a build copied it there. */
function codiconCss(extensionPath: string): string | undefined {
    const dir = path.join(extensionPath, 'dist', 'codicons');
    const css = path.join(dir, 'codicon.css');
    const font = path.join(dir, 'codicon.ttf');
    if (!fs.existsSync(css) || !fs.existsSync(font)) {
        return undefined;
    }
    const data = `data:font/ttf;base64,${fs.readFileSync(font).toString('base64')}`;
    return fs.readFileSync(css, 'utf8').replace(/url\(["']?\.\/codicon\.ttf[^"')]*["']?\)/g, `url("${data}")`);
}

/** How long a browser may take to close before the harness kills it: well inside CLOSE_HOOK_MS, leaving the kill its time. */
const CLOSE_GRACE_MS = 10000;

/** The teardown hook's timeout when it closes the page: mocha's 5 s is not enough for a slow close and the kill after it. */
const CLOSE_HOOK_MS = 20000;

/**
 * Close a suite's page from its `suiteTeardown`, given the hook's context (a
 * `function`, not an arrow): the hook gets CLOSE_HOOK_MS, so a slow close
 * never fails a suite whose tests all passed.
 */
export async function closeEditorPage(hook: Mocha.Context, editor: EditorPage | undefined): Promise<void> {
    hook.timeout(CLOSE_HOOK_MS);
    await editor?.close();
}

/**
 * Kill a browser and every process it started. Killing the launcher alone
 * orphans Chromium's renderers on Windows; `taskkill /T` takes the tree there,
 * and on POSIX Puppeteer starts the browser as a process group's leader, so the
 * group's id is its pid.
 */
function killTree(pid: number | undefined): void {
    if (pid === undefined) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            childProcess.execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(-pid, 'SIGKILL');
        }
    } catch {
        // Gone already.
    }
}
