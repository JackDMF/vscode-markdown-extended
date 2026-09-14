import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as puppeteer from 'puppeteer';

const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

/**
 * End-to-end test for the sidenote/sidebar stylesheet as it is actually applied
 * to an export: `styles/markdown-extended.css` (contributed via
 * `markdown.previewStyles`) followed by `styles/markdown-extended-default.css`
 * (the built-in export theme), on a body carrying the resolved `vscode-light` /
 * `vscode-dark` class that `renderPage` writes.
 *
 * It pins the three defects fixed in v3.1.2, all of which only appear when the
 * two stylesheets meet — nothing in either file alone is wrong:
 *   1. dark-theme PDF: notes were painted on a hardcoded light surface (~1.1:1)
 *   2. HTML export: percentage offsets overflowed the centered column
 *   3. the stacking breakpoint sat exactly on the image-export viewport width
 *
 * CI-safe in the same way as the mermaid e2e test: it skips unless a browser is
 * already available (`MTE_E2E_CHROME`, or the one Puppeteer installed), and never
 * triggers a download.
 */
suite('Note Styles (e2e)', () => {
    const MIN_CONTRAST = 4.5;
    let executablePath: string | undefined;
    let page: string;

    suiteSetup(function () {
        const extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
        const noteCss = extensionPath && path.join(extensionPath, 'styles', 'markdown-extended.css');
        const themeCss = extensionPath && path.join(extensionPath, 'styles', 'markdown-extended-default.css');
        if (!noteCss || !themeCss || !fs.existsSync(noteCss) || !fs.existsSync(themeCss)) {
            this.skip();
        }

        // Resolve a browser without touching BrowserManager: its singleton is
        // reset by other suites, and going through it would also risk a download.
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
            this.skip();
        }

        // Mirrors renderPage(): contributed styles first, built-in theme second.
        const styles = [noteCss, themeCss]
            .map(f => `<style>${fs.readFileSync(f, 'utf8')}</style>`)
            .join('\n');
        page = `<!DOCTYPE html><html><head><meta charset="UTF-8">${styles}</head>`
            + `<body class="markdown-body vscode-body vscode-THEME"><div class="content">`
            + `<p>Body text.<span class="sn-ref">1<span class="sidenote">A sidenote.</span></span> after.</p>`
            + `<p>More.<span class="mn-ref">*<span class="mnote">A marginal note.</span></span></p>`
            + `<p><span class="left-sidebar">Left.</span>Text.<span class="right-sidebar">Right.</span></p>`
            + `</div></body></html>`;
    });

    /** Measure the note in one theme / viewport / media combination. */
    async function measure(theme: 'light' | 'dark', width: number, media: 'screen' | 'print') {
        const browser = await puppeteer.launch({
            executablePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
            const p = await browser.newPage();
            await p.setViewport({ width, height: 900 });
            await p.emulateMediaType(media);
            await p.setContent(page.replace('vscode-THEME', `vscode-${theme}`), { waitUntil: 'load' });
            return await p.evaluate(() => {
                const el = document.querySelector('.sidenote') as HTMLElement;
                const cs = getComputedStyle(el);
                // Walk up for the first opaque background the note is painted on.
                let bg = cs.backgroundColor;
                for (let n = el.parentElement; n && /,\s*0\)$/.test(bg); n = n.parentElement) {
                    bg = getComputedStyle(n).backgroundColor;
                }
                return {
                    float: cs.float,
                    color: cs.color,
                    background: bg,
                    overflow: document.documentElement.scrollWidth - window.innerWidth,
                };
            });
        } finally {
            await browser.close();
        }
    }

    /** WCAG 2.1 relative luminance contrast of two opaque `rgb(...)` strings. */
    function contrast(fg: string, bg: string): number {
        const luminance = (colour: string) => {
            const [r, g, b] = colour.match(/[\d.]+/g)!.slice(0, 3).map(Number)
                .map(c => {
                    const s = c / 255;
                    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
    }

    test('notes stay readable in print, in both export themes', async function () {
        this.timeout(180000);
        for (const theme of ['light', 'dark'] as const) {
            const m = await measure(theme, 1280, 'print');
            assert.strictEqual(m.float, 'none', `${theme}: notes must not float in print`);
            const ratio = contrast(m.color, m.background);
            assert.ok(
                ratio >= MIN_CONTRAST,
                `${theme}: note contrast ${ratio.toFixed(2)}:1 (${m.color} on ${m.background}) is below ${MIN_CONTRAST}:1`,
            );
        }
    });

    test('the margin layout never forces a horizontal scrollbar', async function () {
        this.timeout(180000);
        for (const theme of ['light', 'dark'] as const) {
            const m = await measure(theme, 1280, 'screen');
            assert.strictEqual(m.float, 'right', `${theme}: notes should move into the margin at 1280px`);
            assert.strictEqual(m.overflow, 0, `${theme}: notes overflow the viewport by ${m.overflow}px`);
        }
    });

    test('notes stack below the breakpoint, including the image-export viewport', async function () {
        this.timeout(180000);
        // Puppeteer's default viewport — the width PNG/JPG export renders at.
        const m = await measure('light', 800, 'screen');
        assert.strictEqual(m.float, 'none', 'notes should stack at 800px');
        assert.strictEqual(m.overflow, 0, `notes overflow the viewport by ${m.overflow}px`);
    });
});
