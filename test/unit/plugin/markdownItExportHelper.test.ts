import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { MarkdownItEnv } from '../../../src/services/common/interfaces';

// The preview's own registry, in its order, with HTML on as in VS Code's
// engine: html5-embed sits between the export helper and the output.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt({ html: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

suite('MarkdownItExportHelper', () => {
    let md: MarkdownIt.MarkdownIt;
    let dir: string;
    let env: MarkdownItEnv;

    suiteSetup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-export-helper-'));
        fs.writeFileSync(path.join(dir, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        fs.writeFileSync(path.join(dir, 'font.woff2'), 'woff2');
        fs.writeFileSync(path.join(dir, 'style.css'),
            'body { color: rebeccapurple; }\n@font-face { src: url("font.woff2"); }\n');
    });

    suiteTeardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    setup(() => {
        md = preview();
        env = {
            htmlExporter: {
                uri: vscode.Uri.file(path.join(dir, 'doc.md')),
                workspaceFolder: undefined,
                vsUri: 'vscode-resource:',
                embedImage: true,
            },
        };
    });

    suite('images (qjebbs/vscode-markdown-extended#157)', () => {
        test('an image whose absolute path does not exist keeps its src', () => {
            const html = md.render('![a](/does/not/exist.png)', env);
            assert.ok(html.includes('src="/does/not/exist.png"'), html);
        });

        test('an image of a type that cannot be a data URI keeps its src', () => {
            fs.writeFileSync(path.join(dir, 'picture.webp'), 'webp');
            const html = md.render('![a](picture.webp)', env);
            assert.ok(html.includes('src="picture.webp"'), html);
        });

        test('an image that exists is still embedded', () => {
            const html = md.render('![a](pixel.png)', env);
            assert.ok(html.includes('src="data:image/png;base64,'), html);
        });
    });

    suite('linked stylesheets (qjebbs/vscode-markdown-extended#162)', () => {
        /** The CSS a `<link>` in the output carries, decoded, or undefined when it is not embedded. */
        function linkedCss(html: string): string | undefined {
            const m = /<link\b[^>]*href="data:text\/css;base64,([^"]*)"/.exec(html);
            return m ? Buffer.from(m[1], 'base64').toString() : undefined;
        }

        test('a relative stylesheet is embedded, its url()s with it', () => {
            const html = md.render('<link rel="stylesheet" type="text/css" href="style.css"/>\n\n# Title\n', env);
            const css = linkedCss(html);
            assert.ok(css && css.includes('rebeccapurple'), html);
            assert.ok(css.includes('url("data:font/woff2;base64,'), css);
            assert.ok(html.includes('type="text/css"'), 'the other attributes stay');
        });

        test('a stylesheet linked inside a paragraph is embedded', () => {
            const html = md.render("Text <link href='./style.css' rel=stylesheet> more", env);
            assert.ok(linkedCss(html)?.includes('rebeccapurple'), html);
        });

        test('web stylesheets, missing files and other links stay as written', () => {
            const src = [
                '<link rel="stylesheet" href="https://example.com/style.css">',
                '<link rel="stylesheet" href="missing.css">',
                '<link rel="icon" href="style.css">',
            ].join('\n');
            assert.strictEqual(md.render(src, env), md.render(src, {}));
        });

        test('the preview is not touched', () => {
            const html = md.render('<link rel="stylesheet" href="style.css">', {});
            assert.ok(html.includes('href="style.css"'), html);
        });
    });
});
