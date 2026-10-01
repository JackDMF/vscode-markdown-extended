import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { execFileSync, execSync } from 'child_process';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import nodeFs = require('fs');
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ExtensionContext } from '../../../src/services/common/extensionContext';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { MarkdownItEnv } from '../../../src/services/common/interfaces';
import { EmbedFiles, followLinks, isNetworkTarget } from '../../../src/services/common/dataUri';

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
    // base/doc holds the document and what it may embed; base/outside is the rest of the disk.
    let base: string;
    let dir: string;
    let outside: string;
    let env: MarkdownItEnv;

    suiteSetup(() => {
        base = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-export-helper-'));
        dir = path.join(base, 'doc');
        outside = path.join(base, 'outside');
        fs.mkdirSync(dir);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(dir, 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        fs.writeFileSync(path.join(dir, 'picture.webp'), 'webp');
        fs.writeFileSync(path.join(dir, 'picture.avif'), 'avif');
        fs.writeFileSync(path.join(dir, 'shot#1.tiff'), 'tiff');
        fs.writeFileSync(path.join(dir, 'font.woff2'), 'woff2');
        fs.writeFileSync(path.join(dir, 'style.css'),
            'body { color: rebeccapurple; }\n@font-face { src: url("font.woff2"); }\n');
        fs.writeFileSync(path.join(dir, 'a&b.css'), 'body { color: teal; }\n');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a stylesheet');
        fs.writeFileSync(path.join(outside, 'secret.css'), 'body { color: secret; }\n');
        fs.writeFileSync(path.join(outside, 'id_rsa'), 'PRIVATE KEY');
        // A junction needs no privilege on Windows, a symlink elsewhere.
        fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction');
    });

    suiteTeardown(() => {
        fs.rmSync(base, { recursive: true, force: true });
    });

    setup(() => {
        md = preview();
        env = {
            htmlExporter: {
                uri: vscode.Uri.file(path.join(dir, 'doc.md')),
                workspaceFolder: undefined,
                vsUri: 'vscode-resource:',
                embedImage: true,
                embedFiles: 'workspace',
            },
        };
    });

    /** The env of the same document with `markdownExtended.export.embedFiles` set to `mode`. */
    function withMode(mode: EmbedFiles, uri?: vscode.Uri): MarkdownItEnv {
        return { htmlExporter: { ...env.htmlExporter, embedFiles: mode, ...(uri ? { uri } : {}) } };
    }

    /** The CSS a `<link>` in the output carries, decoded, or undefined when it is not embedded. */
    function linkedCss(html: string): string | undefined {
        const m = /<link\b[^>]*href="data:text\/css;base64,([^"]*)"/.exec(html);
        return m ? Buffer.from(m[1], 'base64').toString() : undefined;
    }

    suite('images (qjebbs/vscode-markdown-extended#157)', () => {
        test('an image whose absolute path does not exist keeps its src', () => {
            const html = md.render('![a](/does/not/exist.png)', env);
            assert.ok(html.includes('src="/does/not/exist.png"'), html);
        });

        test('an image of a type that cannot be a data URI keeps its src as written', () => {
            const html = md.render('![a](shot%231.tiff)', env);
            assert.ok(html.includes('src="shot%231.tiff"'), html);
        });

        test('an image that exists is still embedded', () => {
            const html = md.render('![a](pixel.png)', env);
            assert.ok(html.includes('src="data:image/png;base64,'), html);
        });

        test('webp and avif images are embedded', () => {
            assert.ok(md.render('![a](picture.webp)', env).includes('src="data:image/webp;base64,'));
            assert.ok(md.render('![a](picture.avif)', env).includes('src="data:image/avif;base64,'));
        });

        test('a malformed escape in an image\'s src fails neither the image nor the export', () => {
            const html = md.render('![a](caf%E9.png)\n\n![b](pixel.png)', env);
            assert.ok(html.includes('src="caf%E9.png"'), html);
            assert.ok(html.includes('src="data:image/png;base64,'), html);
        });

        test('HTML in an image\'s alt text opens nothing: a later stylesheet is still embedded', () => {
            const html = md.render('![The <textarea> element](pixel.png) and ![<script>](pixel.png)\n\n<link rel="stylesheet" href="style.css">\n', env);
            assert.ok(html.includes('href="data:text/css;base64,'), html);
        });
    });

    suite('linked stylesheets (qjebbs/vscode-markdown-extended#162)', () => {
        /** The source renders exactly as without the exporter: nothing was embedded. */
        function unchanged(src: string) {
            assert.strictEqual(md.render(src, env), md.render(src, {}), src);
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

        test('a file: URL in the document folder is embedded', () => {
            const href = pathToFileURL(path.join(dir, 'style.css')).href;
            assert.ok(linkedCss(md.render(`<link rel="stylesheet" href="${href}">`, env))?.includes('rebeccapurple'));
        });

        test('an href is read with its character references decoded', () => {
            assert.ok(linkedCss(md.render('<link rel="stylesheet" href="a&amp;b.css">', env))?.includes('teal'));
        });

        test('web stylesheets, missing files and other links stay as written', () => {
            unchanged([
                '<link rel="stylesheet" href="https://example.com/style.css">',
                '<link rel="stylesheet" href="//example.com/style.css">',
                '<link rel="stylesheet" href="missing.css">',
                '<link rel="icon" href="style.css">',
            ].join('\n'));
        });

        test('no file outside the document folder and workspace is embedded', () => {
            const secret = path.join(outside, 'secret.css');
            unchanged(`<link rel="stylesheet" href="${secret}">`);
            unchanged(`<link rel="stylesheet" href="${secret.replace(/\\/g, '/')}">`);
            unchanged(`<link rel="stylesheet" href="${pathToFileURL(secret).href}">`);
            unchanged('<link rel="stylesheet" href="../outside/secret.css">');
            unchanged('<link rel="stylesheet" href="linked/secret.css">');
        });

        test('only a .css file is embedded', () => {
            unchanged(`<link rel="stylesheet" href="${path.join(outside, 'id_rsa').replace(/\\/g, '/')}">`);
            unchanged('<link rel="stylesheet" href="notes.txt">');
        });

        test('a link in a comment or a raw-text element is text and stays so', () => {
            unchanged('<!-- <link rel="stylesheet" href="style.css"> -->');
            unchanged('<script>\nconst s = \'<link rel="stylesheet" href="style.css">\';\n</script>');
            unchanged('<textarea>\n<link rel="stylesheet" href="style.css">\n</textarea>');
            unchanged('<style>\n/* <link rel="stylesheet" href="style.css"> */\n</style>');
            unchanged('Text <textarea><link rel="stylesheet" href="style.css"></textarea> more');
            unchanged('Text <!-- <link rel="stylesheet" href="style.css"> --> more');
        });

        test('a link after a closed raw-text element is embedded', () => {
            const html = md.render('<textarea>x</textarea>\n<link rel="stylesheet" href="style.css">', env);
            assert.ok(linkedCss(html)?.includes('rebeccapurple'), html);
        });

        test('rel and href are attributes of their own name, rel a list of tokens', () => {
            unchanged('<link data-rel="stylesheet" href="style.css">');
            unchanged('<link rel="stylesheet" data-href="style.css">');
            unchanged('<link rel=icon title=stylesheet href="style.css">');
            unchanged('<link rel="stylesheet/less" href="style.css">');
            assert.ok(linkedCss(md.render('<link rel="alternate  Stylesheet" href="style.css">', env)));
            assert.ok(linkedCss(md.render('<link data-href="x.css" rel="stylesheet" href="style.css">', env)));
        });

        test('an unquoted value runs to white space or >', () => {
            assert.ok(linkedCss(md.render('<link href=style.css?v=2 rel=stylesheet>', env))?.includes('rebeccapurple'));
            assert.ok(linkedCss(md.render('<link rel=stylesheet href=style.css?v=2>', env))?.includes('rebeccapurple'));
        });

        test('a name that only starts with .. is inside the folder', () => {
            fs.writeFileSync(path.join(dir, '..ok.css'), 'h1 { color: olive; }\n');
            assert.ok(linkedCss(md.render('<link rel="stylesheet" href="..ok.css">', env))?.includes('olive'));
        });

        test('the type is judged by the real path: a symlink', function () {
            fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
            try {
                fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'sym.css'), 'file');
            } catch {
                this.skip(); // a file symlink needs a privilege on Windows
            }
            unchanged('<link rel="stylesheet" href="sym.css">');
        });

        test('the type is judged by the real path: an 8.3 name', function () {
            const long = path.join(dir, 'secret.cssbackup');
            fs.writeFileSync(long, 'SHORTNAMESECRET');
            let short = long;
            if (process.platform === 'win32') {
                short = execSync(`cmd /c for %I in ("${long}") do @echo %~sI`).toString().trim();
            }
            if (path.basename(short).toLowerCase() === path.basename(long).toLowerCase()) {
                this.skip(); // no 8.3 names on this volume
            }
            unchanged(`<link rel="stylesheet" href="${path.basename(short)}">`);
        });

        test("a stylesheet's url()s resolve against the path it was linked by", () => {
            // doc/themes is a junction to outside/themes; the preview resolves
            // ../font.woff2 from doc/themes, so it is doc/font.woff2.
            const themes = path.join(outside, 'themes');
            fs.mkdirSync(themes, { recursive: true });
            fs.writeFileSync(path.join(themes, 'theme.css'), 'h1 { color: navy; src: url(../font.woff2); }\n');
            fs.writeFileSync(path.join(outside, 'font.woff2'), 'OUTSIDE');
            fs.symlinkSync(themes, path.join(dir, 'themes'), 'junction');
            const inWorkspace = { htmlExporter: { ...env.htmlExporter, workspaceFolder: vscode.Uri.file(base) } };
            const css = linkedCss(md.render('<link rel="stylesheet" href="themes/theme.css">', inWorkspace));
            assert.ok(css?.includes(`url("data:font/woff2;base64,${Buffer.from('woff2').toString('base64')}")`), css);
        });

        test('the preview is not touched', () => {
            const html = md.render('<link rel="stylesheet" href="style.css">', {});
            assert.ok(html.includes('href="style.css"'), html);
        });
    });

    /** `run` with `folders` as the open workspace folders. */
    function inFolders<T>(folders: string[], run: () => T): T {
        const stub = sinon.stub(vscode.workspace, 'workspaceFolders').get(() =>
            folders.map((folder, index) => ({ uri: vscode.Uri.file(folder), name: path.basename(folder), index })));
        try {
            return run();
        } finally {
            stub.restore();
        }
    }

    suite('markdownExtended.export.embedFiles decides what is embedded', () => {
        const woff2 = `url("data:font/woff2;base64,${Buffer.from('woff2').toString('base64')}")`;
        const far = `url("data:font/woff2;base64,${Buffer.from('FAR').toString('base64')}")`;
        let farPng: string;
        let tree: string;

        suiteSetup(() => {
            farPng = path.join(outside, 'far.png');
            fs.writeFileSync(farPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            fs.writeFileSync(path.join(outside, 'far.woff2'), 'FAR');
            fs.writeFileSync(path.join(outside, 'far.css'), 'h1 { color: maroon; }\n');
            fs.writeFileSync(path.join(dir, 'reach.css'), 'a { src: url(../outside/far.woff2); }\n');
            // tree/outer holds tree/outer/inner, the document's folder.
            tree = path.join(base, 'tree');
            fs.mkdirSync(path.join(tree, 'outer', 'inner'), { recursive: true });
            fs.writeFileSync(path.join(tree, 'outer', 'o.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            fs.writeFileSync(path.join(tree, 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        });

        function embedsImage(src: string, renderEnv: MarkdownItEnv, engine = md): boolean {
            return /src="data:image\/png;base64,/.test(engine.render(src, renderEnv));
        }

        function linkedFrom(href: string, renderEnv: MarkdownItEnv): string | undefined {
            return linkedCss(md.render(`<link rel="stylesheet" href="${href}">`, renderEnv));
        }

        /** Every way the tests name a file outside the document folder and workspace. */
        const outsideImages = () => [
            '![a](../outside/far.png)',
            `![a](<${farPng}>)`,
            `![a](<${farPng.replace(/\\/g, '/')}>)`,
            '![a](linked/far.png)',
        ];

        test('workspace: images, linked stylesheets and their url()s only from the folder', () => {
            const e = withMode('workspace');
            assert.ok(embedsImage('![a](pixel.png)', e), 'an image inside');
            for (const src of outsideImages()) {assert.ok(!embedsImage(src, e), src);}
            assert.ok(linkedFrom('style.css', e)?.includes(woff2), 'a stylesheet inside, its url() inside');
            assert.strictEqual(linkedFrom('../outside/far.css', e), undefined, 'a stylesheet outside');
            assert.strictEqual(linkedFrom('linked/far.css', e), undefined, 'a stylesheet outside, by a junction');
            assert.ok(linkedFrom('reach.css', e)?.includes('url(../outside/far.woff2)'), 'a url() outside stays as written');
        });

        test('an env without a known value is held to workspace', () => {
            const e = withMode(undefined as unknown as EmbedFiles);
            assert.ok(embedsImage('![a](pixel.png)', e));
            assert.ok(!embedsImage('![a](../outside/far.png)', e));
        });

        test('workspace: the workspace folder counts as the document\'s', () => {
            const e = { htmlExporter: { ...withMode('workspace').htmlExporter, workspaceFolder: vscode.Uri.file(base) } };
            assert.ok(embedsImage('![a](../outside/far.png)', e));
            assert.ok(linkedFrom('../outside/far.css', e)?.includes('maroon'));
            assert.ok(linkedFrom('reach.css', e)?.includes(far));
        });

        test('workspace in a multi-root workspace: every workspace folder counts, as in the Visual Editor', () => {
            inFolders([dir, outside], () => {
                const e = { htmlExporter: { ...withMode('workspace').htmlExporter, workspaceFolder: vscode.Uri.file(dir) } };
                assert.ok(embedsImage('![a](../outside/far.png)', e), 'an image in another workspace folder');
                assert.ok(linkedFrom('../outside/far.css', e)?.includes('maroon'), 'a stylesheet in another workspace folder');
                assert.ok(linkedFrom('reach.css', e)?.includes(far), 'a url() into another workspace folder');
                assert.ok(!embedsImage(`![a](<${path.join(tree, 'x.png')}>)`, e), 'not a file in no workspace folder');
            });
        });

        test('workspace: a document outside every workspace folder adds its own folder', () => {
            inFolders([outside], () => {
                const e = withMode('workspace');
                assert.ok(embedsImage('![a](pixel.png)', e), 'its own folder');
                assert.ok(embedsImage('![a](../outside/far.png)', e), 'a workspace folder');
                assert.ok(!embedsImage(`![a](<${path.join(tree, 'x.png')}>)`, e), 'neither');
            });
        });

        test('workspace with nested workspace folders: the outer one counts', () => {
            const outer = path.join(tree, 'outer');
            inFolders([outer, path.join(outer, 'inner')], () => {
                const e = withMode('workspace', vscode.Uri.file(path.join(outer, 'inner', 'doc.md')));
                assert.ok(embedsImage('![a](../o.png)', e), 'in the outer folder');
                assert.ok(!embedsImage('![a](../../x.png)', e), 'above both');
            });
        });

        test('machine: any local file of a type that is embedded', () => {
            const e = withMode('machine');
            assert.ok(embedsImage('![a](pixel.png)', e), 'an image inside');
            for (const src of outsideImages()) {assert.ok(embedsImage(src, e), src);}
            assert.ok(linkedFrom('style.css', e)?.includes(woff2), 'a stylesheet inside');
            assert.ok(linkedFrom('../outside/far.css', e)?.includes('maroon'), 'a stylesheet outside');
            assert.ok(linkedFrom(pathToFileURL(path.join(outside, 'far.css')).href, e)?.includes('maroon'), 'a file: URL outside');
            assert.ok(linkedFrom('reach.css', e)?.includes(far), 'a url() outside');
            assert.strictEqual(linkedFrom('notes.txt', e), undefined, 'still only a .css file');
            assert.ok(!embedsImage(`![a](<${path.join(outside, 'id_rsa')}>)`, e), 'still only a type that is embedded');
        });

        test('none: nothing local is embedded, every address stays as written', () => {
            const e = withMode('none');
            const src = '![a](pixel.png) ![b](../outside/far.png)\n\n<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="../outside/far.css">\n';
            assert.strictEqual(md.render(src, e), md.render(src, {}));
        });

        test('a web image keeps its src in every mode', () => {
            for (const mode of ['workspace', 'machine', 'none'] as const) {
                const html = md.render('![x](https://example.com/a.png)', withMode(mode));
                assert.ok(html.includes('src="https://example.com/a.png"'), `${mode}: ${html}`);
            }
        });

        test('a file: URL image is resolved as a file: stylesheet is, under the same rule', () => {
            // VS Code's engine lets a file: link through; markdown-it's default does not.
            const fileMd = preview();
            fileMd.validateLink = () => true;
            const inside = `![a](${pathToFileURL(path.join(dir, 'pixel.png')).href})`;
            const beyond = `![a](${pathToFileURL(farPng).href})`;
            assert.ok(embedsImage(inside, withMode('workspace'), fileMd), 'workspace, inside');
            assert.ok(!embedsImage(beyond, withMode('workspace'), fileMd), 'workspace, outside');
            assert.ok(embedsImage(beyond, withMode('machine'), fileMd), 'machine, outside');
            assert.ok(!embedsImage(inside, withMode('none'), fileMd), 'none');
            for (const mode of ['workspace', 'machine', 'none'] as const) {
                const html = fileMd.render('![a](file://unc.invalid/share/x.png)', withMode(mode));
                assert.ok(html.includes('src="file://unc.invalid/share/x.png"'), `${mode}: ${html}`);
            }
        });

        suite('an untitled document has no folder', () => {
            const untitled = vscode.Uri.parse('untitled:Untitled-1');

            test('workspace and none embed nothing outside a workspace folder', () => {
                for (const mode of ['workspace', 'none'] as const) {
                    const e = withMode(mode, untitled);
                    assert.ok(!embedsImage(`![a](<${path.join(dir, 'pixel.png')}>)`, e), mode);
                    assert.strictEqual(linkedFrom(path.join(dir, 'style.css'), e), undefined, mode);
                }
            });

            test('workspace embeds an absolute path in a workspace folder', () => {
                inFolders([dir], () => {
                    assert.ok(embedsImage(`![a](<${path.join(dir, 'pixel.png')}>)`, withMode('workspace', untitled)));
                });
            });

            test('machine embeds an absolute path; a relative one is looked up nowhere', () => {
                const e = withMode('machine', untitled);
                assert.ok(embedsImage(`![a](<${path.join(dir, 'pixel.png')}>)`, e));
                assert.ok(linkedFrom(path.join(dir, 'style.css'), e)?.includes(woff2));
                const cwd = process.cwd();
                process.chdir(dir);
                try {
                    assert.ok(!embedsImage('![a](pixel.png)', e), 'not from the working directory');
                } finally {
                    process.chdir(cwd);
                }
            });
        });

        suite('a document of another scheme', () => {
            test('git: a relative path is looked up in the folder its path names on the disk', () => {
                const git = vscode.Uri.file(path.join(dir, 'doc.md')).with({ scheme: 'git', query: '{"ref":"HEAD"}' });
                assert.ok(embedsImage('![a](pixel.png)', withMode('workspace', git)));
                assert.ok(!embedsImage('![a](../outside/far.png)', withMode('workspace', git)));
            });

            test('vscode-vfs: no folder on the disk, so workspace embeds nothing', () => {
                const vfs = vscode.Uri.parse('vscode-vfs://github/owner/repo/doc.md');
                assert.ok(!embedsImage(`![a](<${path.join(dir, 'pixel.png')}>)`, withMode('workspace', vfs)));
                assert.ok(embedsImage(`![a](<${path.join(dir, 'pixel.png')}>)`, withMode('machine', vfs)));
            });
        });

        suite('a file the setting refuses is said in the output panel', () => {
            let lines: string[];

            setup(() => {
                ExtensionContext._reset();
                ExtensionContext.initialize({ subscriptions: [] } as unknown as vscode.ExtensionContext);
                lines = [];
                sinon.stub(ExtensionContext.current.outputPanel, 'appendLine').callsFake(line => { lines.push(line); });
            });

            teardown(() => {
                sinon.restore();
                ExtensionContext._reset();
            });

            test('an image, a stylesheet and a url() outside, under workspace, with the remedy', () => {
                md.render('![a](../outside/far.png)\n\n<link rel="stylesheet" href="../outside/far.css">\n<link rel="stylesheet" href="reach.css">\n', withMode('workspace'));
                const why = 'it is outside the document\'s folder and the workspace folders, and markdownExtended.export.embedFiles is "workspace" (set it to "machine" to embed it)';
                assert.ok(lines.includes(`[WARNING] Image "../outside/far.png" not embedded: ${why}`), lines.join('\n'));
                assert.ok(lines.includes(`[WARNING] Stylesheet "../outside/far.css" not embedded: ${why}`), lines.join('\n'));
                // The stylesheet by its full path, as the document's uri gives its folder (a lower-case drive).
                const css = path.join(path.dirname(env.htmlExporter.uri.fsPath), 'reach.css');
                assert.ok(lines.includes(`[WARNING] url(../outside/far.woff2) in "${css}" not embedded: ${why}`), lines.join('\n'));
            });

            test('one line for the export, under none', () => {
                md.render('![a](pixel.png) ![b](../outside/far.png)\n\n<link rel="stylesheet" href="style.css">\n', withMode('none'));
                assert.deepStrictEqual(lines, ['[INFO] "doc.md" is exported without the files it names: markdownExtended.export.embedFiles is "none"']);
            });

            test('an untitled document, under workspace', () => {
                const src = path.join(dir, 'pixel.png');
                md.render(`![a](<${src}>)`, withMode('workspace', vscode.Uri.parse('untitled:Untitled-1')));
                assert.ok(lines.includes(`[WARNING] Image "${src}" not embedded: the document is untitled and has no folder, and markdownExtended.export.embedFiles is "workspace"`), lines.join('\n'));
            });

            test('a document not on the disk, under workspace', () => {
                const src = path.join(dir, 'pixel.png');
                md.render(`![a](<${src}>)`, withMode('workspace', vscode.Uri.parse('vscode-vfs://github/owner/repo/doc.md')));
                assert.ok(lines.includes(`[WARNING] Image "${src}" not embedded: the document (vscode-vfs:) is not in a folder on this machine's disk, and markdownExtended.export.embedFiles is "workspace"`), lines.join('\n'));
            });
        });
    });

    suite('network paths are refused before the disk is asked', () => {
        /** The paths the file system was asked for while `src` rendered. */
        function askedWhile(src: string, renderEnv: MarkdownItEnv): string[] {
            const asked: string[] = [];
            for (const name of ['existsSync', 'readFileSync', 'statSync', 'accessSync', 'realpathSync'] as const) {
                const original = nodeFs[name] as ((...args: unknown[]) => unknown) & { native?: unknown };
                const stub = sinon.stub(nodeFs, name).callsFake(((...args: unknown[]) => {
                    asked.push(String(args[0]));
                    return original(...args);
                }) as never);
                if (original.native) {
                    (stub as unknown as { native: unknown }).native = (...args: unknown[]) => {
                        asked.push(String(args[0]));
                        return (original.native as (...a: unknown[]) => unknown)(...args);
                    };
                }
            }
            try {
                md.render(src, renderEnv);
            } finally {
                sinon.restore();
            }
            return asked;
        }

        test('no file system call names the host', () => {
            const unc = path.join(dir, 'unc.css');
            fs.writeFileSync(unc, 'a { background: url(\\\\unc.invalid\\share\\x.png); b: url(/\\unc.invalid/share/y.png); }\n');
            const src = [
                '<link rel="stylesheet" href="\\\\unc.invalid\\share\\x.css">',
                '<link rel="stylesheet" href="//unc.invalid/share/x.css">',
                '<link rel="stylesheet" href="/\\unc.invalid/share/x.css">',
                '<link rel="stylesheet" href="file://unc.invalid/share/x.css">',
                '<link rel="stylesheet" href="unc.css">',
                '',
                '![a](//unc.invalid/share/x.png) ![b](<\\\\\\\\unc.invalid\\\\share\\\\x.png>) ![c](/\\\\unc.invalid/x.png)',
            ].join('\n');
            // Under `machine` unc.css is embedded and its url()s are asked for.
            for (const mode of ['workspace', 'machine', 'none'] as const) {
                const asked = askedWhile(src, withMode(mode));
                assert.deepStrictEqual(asked.filter(p => /unc\.invalid/i.test(p)), [], mode);
            }
        });

        // A directory symlink needs a privilege on Windows (or developer mode);
        // a junction does not, but Windows will not read one to a share back.
        // VS Code's own fs refuses a UNC host it was not told to allow, so the
        // link is made by a Node process of its own, outside the extension host.
        for (const kind of ['dir', 'junction'] as const) {
            test(`a ${kind} link to a network path is not followed`, function () {
                const netlink = path.join(dir, `net-${kind}`);
                try {
                    const script = path.join(base, 'link.js');
                    // VS Code's Electron refuses UNC hosts until told otherwise (`restrictUNCAccess`).
                    fs.writeFileSync(script, 'process.restrictUNCAccess = false;\nrequire("fs").symlinkSync(process.argv[2], process.argv[3], process.argv[4]);\n');
                    execFileSync(process.execPath, [script, '\\\\unc.invalid\\share', netlink, kind],
                        { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
                } catch {
                    this.skip(); // cannot be made here; isNetworkTarget is tested below
                }
                try {
                    const src = `![a](net-${kind}/x.png)\n\n<link rel="stylesheet" href="net-${kind}/x.css">\n`;
                    for (const mode of ['workspace', 'machine'] as const) {
                        const asked = askedWhile(src, withMode(mode));
                        assert.deepStrictEqual(asked.filter(p => /net-/i.test(p)), [], `${mode}: nothing follows the link`);
                        assert.strictEqual(md.render(src, withMode(mode)), md.render(src, {}), mode);
                    }
                    // A junction to a share is not read back: unreadable, or, where
                    // VS Code's fs refuses even to lstat it, missing. Never found.
                    const found = followLinks(path.join(netlink, 'x.png'));
                    assert.ok(kind === 'dir' ? found === 'network' : found !== 'found', found);
                } finally {
                    // A link to a folder is removed as a folder on Windows, as a file elsewhere.
                    try { fs.rmdirSync(netlink); } catch { fs.unlinkSync(netlink); }
                }
            });
        }

        test('what a link target is: a network path in each of its forms, a local one in each of its', () => {
            for (const target of ['\\\\host\\share', '//host/share', '\\\\?\\UNC\\host\\share', '\\??\\UNC\\host\\share', '\\\\?\\Volume{0}\\']) {
                assert.ok(isNetworkTarget(target), target);
            }
            for (const target of ['C:\\x', '\\\\?\\C:\\x', '\\??\\C:\\x', '\\\\.\\C:\\x', '..\\x', '/usr/x', 'x']) {
                assert.ok(!isNetworkTarget(target), target);
            }
        });

        test('followLinks follows a local junction and reports a missing path', () => {
            assert.strictEqual(followLinks(path.join(dir, 'linked', 'far.png')), 'found');
            assert.strictEqual(followLinks(path.join(dir, 'linked', 'gone.png')), 'missing');
            assert.strictEqual(followLinks(path.join(dir, 'pixel.png')), 'found');
        });
    });

    suite('a link is text where HTML reads text, across the whole document', () => {
        let md: MarkdownIt.MarkdownIt;

        setup(() => {
            md = preview();
        });

        function embeds(src: string): boolean {
            return /href="data:text\/css;base64,/.test(md.render(src, env));
        }

        const link = '<link rel="stylesheet" href="style.css">';
        test('a comment, a script or a textarea opened in one token and ended in a later one', () => {
            assert.ok(!embeds(`<div>\n<!--\n\n${link}\n\n-->\n`), 'comment in a div block');
            assert.ok(!embeds(`<div><script>\nvar x;\n\n${link}\n\nend </script> here\n`), 'script ended inline');
            assert.ok(!embeds(`Text <textarea>\n\n${link}\n\n</textarea>\n`), 'textarea across paragraphs');
            assert.ok(!embeds(`a <script> b\n\n${link}\n`), 'script left open');
            assert.ok(!embeds(`<!-- open\n\n${link}\n`), 'comment left open');
        });

        test('and the link after its end is embedded', () => {
            assert.ok(embeds(`<div><script>\nvar x;\n\nend </script> here\n\n<textarea>\n</textarea>\n\n${link}\n`));
            assert.ok(embeds(`<!-- a --!> ${link}\n`), '--!> ends a comment');
            assert.ok(embeds(`<!--> ${link} -->\n`), '<!--> is a whole comment');
            assert.ok(embeds(`<!---> ${link} -->\n`), '<!---> is a whole comment');
            assert.ok(embeds(`a <script>x</script> ${link} b\n`));
        });

        test('every raw-text element, and plaintext to the end', () => {
            for (const name of ['xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'title', 'style']) {
                assert.ok(!embeds(`<${name}>${link}</${name}>\n`), name);
            }
            assert.ok(!embeds(`<plaintext>\n\n</plaintext>\n\n${link}\n`), 'plaintext');
        });
    });

    suite('what cannot be embedded is said in the output panel', () => {
        let lines: string[];

        setup(() => {
            ExtensionContext._reset();
            ExtensionContext.initialize({ subscriptions: [] } as unknown as vscode.ExtensionContext);
            lines = [];
            sinon.stub(ExtensionContext.current.outputPanel, 'appendLine').callsFake(line => { lines.push(line); });
        });

        teardown(() => {
            sinon.restore();
            ExtensionContext._reset();
        });

        test('a folder named like a stylesheet or an image', () => {
            fs.mkdirSync(path.join(dir, 'folder.css'), { recursive: true });
            fs.mkdirSync(path.join(dir, 'folder.png'), { recursive: true });
            const src = '<link rel="stylesheet" href="folder.css">\n\n![a](folder.png)\n';
            assert.strictEqual(md.render(src, env), md.render(src, {}));
            assert.ok(lines.some(l => /^\[WARNING\] Stylesheet "folder\.css" not embedded: .*EISDIR/.test(l)), lines.join('\n'));
            assert.ok(lines.some(l => /^\[WARNING\] Image "folder\.png" not embedded: .*EISDIR/.test(l)), lines.join('\n'));
        });

        test('a stylesheet outside the document folder and workspace', () => {
            md.render('<link rel="stylesheet" href="../outside/secret.css">', env);
            assert.ok(lines.some(l => l.includes('outside the document\'s folder and the workspace folders')), lines.join('\n'));
        });

        test('a missing image, a missing stylesheet and an href that is not a stylesheet', () => {
            fs.writeFileSync(path.join(dir, 'theme.txt'), 'h1 {}');
            md.render('<link rel="stylesheet" href="gone.css">\n<link rel="stylesheet" href="theme.txt">\n\n![a](gone.png)\n', env);
            assert.ok(lines.includes('[WARNING] Stylesheet "gone.css" not embedded: not found'), lines.join('\n'));
            assert.ok(lines.includes('[WARNING] Image "gone.png" not embedded: not found'), lines.join('\n'));
            assert.ok(lines.includes('[WARNING] Stylesheet "theme.txt" not embedded: "theme.txt" is not of a type that is embedded'), lines.join('\n'));
        });

        test('a file: URL outside the document folder and workspace', () => {
            const href = pathToFileURL(path.join(outside, 'secret.css')).href;
            md.render(`<link rel="stylesheet" href="${href}">`, env);
            assert.ok(lines.some(l => l.startsWith(`[WARNING] Stylesheet "${href}" not embedded: it is outside`)), lines.join('\n'));
        });
    });
});
