import * as assert from 'assert';
import * as fs from 'fs';
import * as puppeteer from 'puppeteer';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { launchOptions } from '../../../../src/services/exporter/puppeteer';

/**
 * End-to-end test for the PDF footer's `<span class='date'>`: Chrome fills it in the language
 * it was started with, so the export's launch options must carry the locale. Uses the same
 * `launchOptions` the exporter does, and reads the printed text back from the PDF.
 *
 * CI-safe like the other e2e tests: skips unless a browser is already available
 * (`MTE_E2E_CHROME`, or the one Puppeteer installed), and never downloads one.
 */
suite('PDF date locale (e2e)', () => {
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

    /**
     * Reads the PDF's text in a plain Node process: pdf-parse needs `DOMMatrix`, which
     * the extension host's Electron does not provide.
     */
    async function pdfText(pdf: Uint8Array): Promise<string> {
        const file = path.join(os.tmpdir(), `mep-pdf-date-${process.pid}-${Date.now()}.pdf`);
        fs.writeFileSync(file, pdf);
        const script = "const {PDFParse}=require(process.argv[1]);"
            + "new PDFParse({data:new Uint8Array(require('fs').readFileSync(process.argv[2]))})"
            + ".getText().then(r=>process.stdout.write(r.text));";
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        try {
            return await new Promise<string>((resolve, reject) => {
                execFile('node', ['-e', script, require.resolve('pdf-parse'), file], { env, encoding: 'utf8' },
                    (err, stdout) => (err ? reject(err) : resolve(stdout)));
            });
        } finally {
            fs.rmSync(file, { force: true });
        }
    }

    async function footerText(locale: string): Promise<string> {
        const browser = await puppeteer.launch(launchOptions(executablePath, locale) as puppeteer.LaunchOptions);
        try {
            const page = await browser.newPage();
            await page.setContent('<html><body><p>Body.</p></body></html>');
            const pdf = await page.pdf({
                displayHeaderFooter: true,
                headerTemplate: '<span></span>',
                footerTemplate: '<div style="font-size: 9px; margin: 0 auto;">[<span class=\'date\'></span>]</div>',
                margin: { top: '1cm', bottom: '2cm' },
            });
            return await pdfText(pdf);
        } finally {
            await browser.close();
        }
    }

    test('de-DE prints dd.mm.yy, en-US prints m/d/yy', async function () {
        this.timeout(60000);
        const de = await footerText('de-DE');
        const en = await footerText('en-US');
        assert.match(de, /\[\d{2}\.\d{2}\.\d{2}, \d{2}:\d{2}\]/, `German footer: ${JSON.stringify(de)}`);
        assert.match(en, /\[\d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2}\s?[AP]M\]/, `English footer: ${JSON.stringify(en)}`);
    });
});
