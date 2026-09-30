import * as assert from 'assert';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as vscode from 'vscode';
import { DiagnosticEntry, HostMessage, WebviewMessage } from '../../../src/editor/protocol';

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
 * The page bundle (`dist/editor-webview.js`) loaded into headless Chromium, with
 * `acquireVsCodeApi` replaced by a recorder, and `styles/editor.css` beside it.
 *
 * `undefined` when there is no bundle or no browser — the suite then skips, as
 * the other e2e tests do: a browser already available (`MTE_E2E_CHROME`, or
 * the one Puppeteer installed) is used, and nothing is downloaded.
 */
export interface EditorPageOptions {
    /** The viewport width; 1200 unless given. */
    width?: number;
    /** The viewport height; 900 unless given. */
    height?: number;
    /** Stylesheets of this extension's `styles/` to load before `editor.css`, as the preview's cascade would. */
    styles?: readonly string[];
    /** Stylesheets by absolute path, loaded first: VS Code's own `markdown.css`, which the preview's cascade starts with. */
    stylesheets?: readonly string[];
}

/** VS Code's preview stylesheet, from the VS Code the tests run in: the first sheet of the preview's cascade. */
export function vscodeMarkdownCss(): string {
    return path.join(vscode.env.appRoot, 'extensions', 'markdown-language-features', 'media', 'markdown.css');
}

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

    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: options.width ?? 1200, height: options.height ?? 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
        + '<body class="markdown-body vscode-body vscode-light"><div id="mep-editor" class="mep-editor"></div>'
        + '<script>window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m) });</script>'
        + '</body></html>',
        { waitUntil: 'load' },
    );
    for (const sheet of options.stylesheets ?? []) {
        if (fs.existsSync(sheet)) {
            await page.addStyleTag({ path: sheet });
        }
    }
    for (const sheet of options.styles ?? []) {
        await page.addStyleTag({ path: path.join(extensionPath as string, 'styles', sheet) });
    }
    // The codicon font, before the editor's own sheet as the host links it (`html.ts`): the
    // chevrons and `$(icon)`s are drawn with it. The page has no origin to load the font file
    // from, so it is given inline.
    const codicons = codiconCss(extensionPath as string);
    if (codicons) {
        await page.addStyleTag({ content: codicons });
    }
    await page.addStyleTag({ path: path.join(extensionPath as string, 'styles', 'editor.css') });
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
        close: async () => {
            // A suite's teardown has mocha's 5 s; on a loaded machine Chromium can
            // take longer to close, and a teardown that times out fails the run
            // with every test passed. What has not closed by then is killed,
            // with its whole process tree.
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
        },
    };
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

/** How long a browser may take to close before the harness kills it: inside mocha's 5 s hook timeout. */
const CLOSE_GRACE_MS = 3500;

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
