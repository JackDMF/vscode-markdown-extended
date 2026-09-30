import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as puppeteer from 'puppeteer';
import { applyPrintDate, exportLocale } from '../../../../src/services/exporter/puppeteer';

/**
 * The one test that proves the feature: a PDF printed through `page.pdf` with a `date` footer,
 * prepared by the exporter's own `applyPrintDate`, reads back with the date in the export locale.
 * (Chrome overwrites any element with class `date`, which is why the template is rewritten.)
 *
 * Skips, never fails, when the host cannot run it: no browser (`MTE_E2E_CHROME`, or the one
 * Puppeteer installed; nothing is downloaded), no `node` on PATH, or a Node that pdf-parse
 * does not support. pdf-parse runs in a child `node` process because it needs `DOMMatrix`,
 * which the extension host's Electron does not provide.
 */
suite('PDF date locale (e2e)', () => {
    const SKIP_EXIT = 3;
    // pdf-parse's own engines range: >=20.16.0 <21 || >=22.3.0
    const childScript = "const [maj,min]=process.versions.node.split('.').map(Number);"
        + "if(!((maj===20&&min>=16)||(maj===22&&min>=3)||maj>22))process.exit(" + SKIP_EXIT + ");"
        + "const {PDFParse}=require(process.argv[1]);"
        + "new PDFParse({data:new Uint8Array(require('fs').readFileSync(process.argv[2]))})"
        + ".getText().then(r=>process.stdout.write(r.text));";
    // A fixed time long before the test runs, so Chrome's own date can never match it.
    const printTime = new Date(2020, 0, 15, 15, 5);
    let executablePath: string | undefined;

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
    });

    /** The PDF's text, or undefined when this host cannot read it back. */
    async function pdfText(pdf: Uint8Array): Promise<string | undefined> {
        const file = path.join(os.tmpdir(), `mep-pdf-date-${process.pid}-${Date.now()}.pdf`);
        fs.writeFileSync(file, pdf);
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        try {
            return await new Promise<string | undefined>((resolve, reject) => {
                execFile('node', ['-e', childScript, require.resolve('pdf-parse'), file], { env, encoding: 'utf8' },
                    (err, stdout) => {
                        if (!err) {
                            resolve(stdout);
                        } else if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as { code?: unknown }).code === SKIP_EXIT) {
                            resolve(undefined);
                        } else {
                            reject(err);
                        }
                    });
            });
        } finally {
            fs.rmSync(file, { force: true });
        }
    }

    async function footerText(setting: string, test: Mocha.Context): Promise<string> {
        const options = {
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: '<div style="font-size: 9px; margin: 0 auto;">[<span class=\'date\'></span>]</div>',
            margin: { top: '1cm', bottom: '2cm' },
        };
        applyPrintDate(options, exportLocale(setting, 'en'), printTime);
        const browser = await puppeteer.launch({
            executablePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        try {
            const page = await browser.newPage();
            await page.setContent('<html><body><p>Body.</p></body></html>');
            const text = await pdfText(await page.pdf(options));
            if (text === undefined) {
                test.skip();
            }
            return text as string;
        } finally {
            await browser.close();
        }
    }

    test('de-DE prints dd.mm.yy, hh:mm; en-US prints m/d/yy, h:mm AM/PM', async function () {
        this.timeout(60000);
        const fold = (s: string) => s.replace(/[\s ]+/g, ' ');
        assert.ok(fold(await footerText('de-DE', this)).includes('[15.01.20, 15:05]'));
        assert.ok(fold(await footerText('en-US', this)).includes('[1/15/20, 3:05 PM]'));
    });
});
