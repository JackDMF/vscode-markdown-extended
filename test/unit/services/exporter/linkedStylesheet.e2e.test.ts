import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as puppeteer from 'puppeteer';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../../src/plugin/plugins';

/**
 * A stylesheet the document links relatively applies to the page the PDF is
 * printed from (qjebbs/vscode-markdown-extended#162), and a `#fragment` link
 * on that page still names the page itself.
 *
 * The page is handed to Puppeteer exactly as the PDF exporter does it — through
 * `page.setContent`, where a relative href resolves against about:blank — but
 * not printed: what matters is the HTML the exporter passes on. Skips, never
 * fails, without a browser (`MTE_E2E_CHROME`, or the one Puppeteer installed);
 * nothing is downloaded.
 */
suite('Linked stylesheet (e2e)', () => {
    let executablePath: string | undefined;
    let dir: string;

    suiteSetup(function () {
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
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-linked-css-'));
        fs.writeFileSync(path.join(dir, 'style.css'), 'h1 { color: rebeccapurple; }\n');
    });

    suiteTeardown(() => {
        if (dir) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the linked stylesheet applies, and a fragment link stays on the page', async function () {
        this.timeout(180000);
        const md = new MarkdownIt({ html: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plugins.forEach(p => md.use(p.plugin as any, ...p.args));
        const body = md.render('<link rel="stylesheet" href="style.css">\n\n# Title\n\n[top](#title)\n', {
            htmlExporter: {
                uri: vscode.Uri.file(path.join(dir, 'doc.md')),
                workspaceFolder: undefined,
                vsUri: 'vscode-resource:',
                embedImage: true,
                embedFiles: 'workspace',
            },
        });
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${body}</body></html>`;

        const browser = await puppeteer.launch({
            executablePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'load' });
            const m = await page.evaluate(() => {
                const a = document.querySelector('a') as HTMLAnchorElement;
                return {
                    color: getComputedStyle(document.querySelector('h1') as HTMLElement).color,
                    samePage: a.href.split('#')[0] === location.href.split('#')[0],
                };
            });
            assert.strictEqual(m.color, 'rgb(102, 51, 153)', 'the linked stylesheet did not apply');
            assert.ok(m.samePage, 'a #fragment link must name the page itself');
        } finally {
            await browser.close();
        }
    });
});
