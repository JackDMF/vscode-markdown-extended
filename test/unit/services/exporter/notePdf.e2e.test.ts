import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import * as puppeteer from 'puppeteer';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../../src/plugin/plugins';
import { NOTE_SAMPLE_TWO_SIDED } from '../../editor/noteSample';

const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

/**
 * A note in a PDF printed with background graphics off, as a reader prints an
 * export: the sentence around it reads unbroken — reference, note, the rest —
 * because print keeps the inline run (`styles/markdown-extended.css`).
 *
 * Skips, never fails, where the host cannot run it, as `pdfDate.e2e.test.ts`
 * does: no browser, no `node` on PATH, or a Node pdf-parse does not support.
 * With `MEP_SHOTS_DIR` set the PDF is kept there.
 */
suite('Note PDF (e2e)', () => {
    const SKIP_EXIT = 3;
    // pdf-parse's own engines range: >=20.16.0 <21 || >=22.3.0
    const childScript = "const [maj,min]=process.versions.node.split('.').map(Number);"
        + "if(!((maj===20&&min>=16)||(maj===22&&min>=3)||maj>22))process.exit(" + SKIP_EXIT + ");"
        + "const {PDFParse}=require(process.argv[1]);"
        + "new PDFParse({data:new Uint8Array(require('fs').readFileSync(process.argv[2]))})"
        + ".getText().then(r=>process.stdout.write(r.text));";
    const SOURCE = NOTE_SAMPLE_TWO_SIDED;
    let executablePath: string | undefined;
    let styles: string;

    suiteSetup(function () {
        const extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
        const sheets = extensionPath ? ['markdown-extended.css', 'markdown-extended-default.css'].map(f => path.join(extensionPath, 'styles', f)) : [];
        if (sheets.length === 0 || !sheets.every(f => fs.existsSync(f))) {
            this.skip();
        }
        styles = sheets.map(f => `<style>${fs.readFileSync(f, 'utf8')}</style>`).join('\n');
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
    async function pdfText(file: string): Promise<string | undefined> {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        return new Promise<string | undefined>((resolve, reject) => {
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
    }

    test('printed A4 without backgrounds, the whole document prints and a sentence reads reference, note, the rest — in order', async function () {
        this.timeout(60000);
        const md = new MarkdownIt({ html: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plugins.forEach(p => md.use(p.plugin as any, ...p.args));
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">${styles}</head>`
            + `<body class="markdown-body vscode-body vscode-light">${md.render(SOURCE)}</body></html>`;
        const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const shots = process.env.MEP_SHOTS_DIR;
        const file = shots ? path.join(shots, 'print-a4-backgrounds-off.pdf') : path.join(os.tmpdir(), `mep-note-pdf-${process.pid}-${Date.now()}.pdf`);
        try {
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'load' });
            if (shots) {
                fs.mkdirSync(shots, { recursive: true });
            }
            fs.writeFileSync(file, await page.pdf({ format: 'A4', printBackground: false, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } }));
            const text = await pdfText(file);
            if (text === undefined) {
                this.skip();
            }
            // The text the PDF holds: every part of the sentence, none clipped away.
            // (Its text runs are stored in paint order — the paragraph's own text,
            // then the reference's and the note's — so the reading order is read
            // from the print layout below, the one the PDF was printed from.)
            const folded = (text as string).replace(/\s+/g, ' ');
            for (const part of ['Offline Sync', 'Status', 'Reviews are booked for week 44.', 'Owner: Mia', 'Open tasks', 'keeps both versions', 'and asks the user', 'The conflict dialog lists both versions', 'can be undone.', 'which one to keep.']) {
                assert.ok(folded.includes(part), `"${part}" is in the PDF: ${folded}`);
            }
            await page.emulateMediaType('print');
            await page.setViewport({ width: 680, height: 1000 });
            const starts = await page.evaluate(() => {
                const firstRect = (node: globalThis.Node, offset: number) => {
                    const range = document.createRange();
                    range.setStart(node, offset);
                    range.setEnd(node, offset + 1);
                    const r = range.getClientRects()[0];
                    return { top: Math.round(r.top), left: r.left };
                };
                const anchor = Array.from(document.querySelectorAll('.sn-anchor')).find(a => a.textContent === 'and asks the user') as HTMLElement;
                const note = (anchor.parentElement as HTMLElement).querySelector('.sidenote') as HTMLElement;
                const after = (anchor.parentElement as HTMLElement).nextSibling as globalThis.Node;
                return {
                    float: getComputedStyle(note).float,
                    parts: [firstRect(anchor.firstChild as globalThis.Node, 0), firstRect(note.firstChild as globalThis.Node, 0), firstRect(after, 1)],
                };
            });
            assert.strictEqual(starts.float, 'none', 'print keeps the note in its sentence');
            for (let i = 1; i < starts.parts.length; i++) {
                const [a, b] = [starts.parts[i - 1], starts.parts[i]];
                assert.ok(b.top > a.top || (b.top === a.top && b.left > a.left), `part ${i} follows part ${i - 1}: ${JSON.stringify(starts.parts)}`);
            }
        } finally {
            await browser.close();
            if (!shots) {
                fs.rmSync(file, { force: true });
            }
        }
    });
});
