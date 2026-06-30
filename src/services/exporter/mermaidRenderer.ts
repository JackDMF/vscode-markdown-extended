import * as path from 'path';
import { promises as fsPromises } from 'fs';
import * as puppeteer from 'puppeteer-core';
import { ExtensionContext } from '../common/extensionContext';
import { BrowserManager } from '../browser/browserManager';

/**
 * Matches a mermaid placeholder block as produced by VS Code's built-in
 * `vscode.mermaid-markdown-features` markdown-it plugin: `<pre class="mermaid">…</pre>`.
 * Case-insensitive and tolerant of extra classes/attributes.
 */
const MERMAID_DETECT_RE = /<pre[^>]*\bclass\s*=\s*"[^"]*\bmermaid\b[^"]*"/i;

/**
 * Returns true when the rendered HTML contains at least one mermaid placeholder.
 * Pure and side-effect free so it can gate the (expensive) browser launch.
 */
export function hasMermaid(html: string): boolean {
    return MERMAID_DETECT_RE.test(html);
}

/**
 * A function that turns export HTML containing `<pre class="mermaid">` placeholders
 * into HTML with inline `<svg>`. Injectable so the orchestration can be unit-tested
 * without launching a browser.
 */
export type MermaidPageRender = (html: string) => Promise<string>;

/**
 * Renders mermaid diagrams contained in already-rendered export HTML into inline SVG.
 *
 * Mermaid itself is bundled with the extension (see `dist/mermaid-browser.js`) and is
 * only ever executed inside the bundled headless Chromium — it is never written into
 * the exported file, so the output stays small (inline SVG, zero JavaScript).
 *
 * The browser is launched lazily and only when the document actually contains a
 * mermaid diagram. Any failure degrades gracefully: the original `<pre class="mermaid">`
 * placeholders are kept so an export never hard-fails because of mermaid.
 */
export class MermaidRenderer {
    private static _instance?: MermaidRenderer;

    private constructor() {}

    static get instance(): MermaidRenderer {
        if (!MermaidRenderer._instance) {
            MermaidRenderer._instance = new MermaidRenderer();
        }
        return MermaidRenderer._instance;
    }

    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        MermaidRenderer._instance = undefined;
    }

    /**
     * Convert mermaid placeholders in the given export HTML into inline SVG.
     *
     * @param html The rendered export HTML.
     * @param pageRender Optional override for the rendering step (used by tests).
     * @returns HTML with mermaid diagrams inlined as SVG, or the original html when
     *          there are no diagrams or rendering is unavailable.
     */
    async process(html: string, pageRender?: MermaidPageRender): Promise<string> {
        if (!hasMermaid(html)) {
            return html;
        }
        const render = pageRender ?? ((h: string) => this.renderInBrowser(h));
        try {
            return await render(html);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (ExtensionContext.isInitialized) {
                ExtensionContext.current.outputPanel.appendLine(
                    `[WARN] Mermaid rendering failed; exporting diagram source instead: ${message}`
                );
            }
            return html;
        }
    }

    /**
     * Default rendering step: run the bundled mermaid library inside the bundled
     * headless Chromium and replace each `<pre class="mermaid">` with the rendered SVG.
     */
    private async renderInBrowser(html: string): Promise<string> {
        const mermaidSource = await fsPromises.readFile(this.mermaidHarnessPath(), 'utf8');
        const executablePath = await BrowserManager.instance.ensureBrowser();

        const browser = await puppeteer.launch({
            executablePath: executablePath || undefined,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'load' });

            // Define the mermaid global without leaving a <script> node in the DOM,
            // so the multi-megabyte library is never serialized into the output.
            await page.evaluate((src: string) => {
                // indirect eval executes the IIFE bundle in global scope
                (0, eval)(src);
            }, mermaidSource);

            return await page.evaluate(async (theme: string) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mermaid = (globalThis as any).__mteMermaid;
                if (!mermaid || typeof mermaid.render !== 'function') {
                    throw new Error('mermaid global was not initialized');
                }
                mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'loose' });

                const blocks = Array.from(
                    document.querySelectorAll('pre.mermaid')
                ) as HTMLElement[];

                for (let i = 0; i < blocks.length; i++) {
                    const el = blocks[i];
                    const source = (el.textContent || '').trim();
                    if (!source) {
                        continue;
                    }
                    try {
                        const { svg } = await mermaid.render('mte-mermaid-' + i, source);
                        const wrapper = document.createElement('div');
                        wrapper.className = 'mermaid';
                        wrapper.innerHTML = svg;
                        el.replaceWith(wrapper);
                    } catch {
                        // Leave this diagram's <pre> source in place as a graceful fallback.
                    }
                }

                return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
            }, this.theme());
        } finally {
            await browser.close();
        }
    }

    /**
     * Path to the bundled, browser-ready mermaid harness that exposes
     * `globalThis.__mteMermaid`. Produced by the esbuild `mermaid-browser` target.
     */
    private mermaidHarnessPath(): string {
        return path.join(
            ExtensionContext.current.vsContext.extensionPath,
            'dist',
            'mermaid-browser.js'
        );
    }

    /**
     * Mermaid theme to use for export. Defaults to the light "default" theme to match
     * the light export body class.
     */
    private theme(): string {
        return 'default';
    }
}
