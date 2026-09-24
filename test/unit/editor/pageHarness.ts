import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as vscode from 'vscode';
import { HostMessage, WebviewMessage } from '../../../src/editor/protocol';

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
    /** Stylesheets of this extension's `styles/` to load before `editor.css`, as the preview's cascade would. */
    styles?: readonly string[];
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
    await page.setViewport({ width: options.width ?? 1200, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
        + '<body class="markdown-body vscode-body vscode-light"><div id="mep-editor" class="mep-editor"></div>'
        + '<script>window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m) });</script>'
        + '</body></html>',
        { waitUntil: 'load' },
    );
    for (const sheet of [...(options.styles ?? []), 'editor.css']) {
        await page.addStyleTag({ path: path.join(extensionPath as string, 'styles', sheet) });
    }
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
        close: () => browser.close(),
    };
}
