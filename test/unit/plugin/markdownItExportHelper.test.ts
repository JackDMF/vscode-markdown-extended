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
});
