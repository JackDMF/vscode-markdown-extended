const esbuild = require('esbuild');
const { visualizer } = require('esbuild-visualizer');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const analyze = process.argv.includes('--analyze');

/**
 * Bundle analysis plugin
 * Generates visualizations using esbuild-visualizer
 * @type {import('esbuild').Plugin}
 */
const bundleAnalyzerPlugin = {
    name: 'bundle-analyzer',
    setup(build) {
        build.onEnd(async (result) => {
            if (!analyze || !result.metafile) {
                return;
            }

            try {
                // Generate visualizer HTML using esbuild-visualizer
                const html = await visualizer(result.metafile, {
                    title: 'Markdown Extended Pro - Bundle Analysis',
                    template: 'treemap' // 'sunburst', 'treemap', 'network'
                });
                
                // Write the HTML to file
                await fs.promises.writeFile('dist/bundle-stats.html', html);

                // Also generate simple text analysis
                const inputs = result.metafile.inputs;
                const analysis = {
                    bundleSize: 0,
                    modules: []
                };

                for (const [file, data] of Object.entries(inputs)) {
                    analysis.modules.push({
                        file,
                        bytes: data.bytes
                    });
                    analysis.bundleSize += data.bytes;
                }

                analysis.modules.sort((a, b) => b.bytes - a.bytes);

                console.log('\n✅ Bundle analysis complete!');
                console.log(`📊 Interactive visualization: dist/bundle-stats.html`);
                console.log(`📦 Total bundle size: ${formatBytes(analysis.bundleSize)}`);
                console.log(`🗂️  Modules: ${analysis.modules.length}`);
                console.log(`\n🔝 Top 10 largest modules:`);
                analysis.modules.slice(0, 10).forEach((mod, i) => {
                    console.log(`   ${(i + 1).toString().padStart(2)}. ${formatBytes(mod.bytes).padStart(10)} - ${mod.file}`);
                });
            } catch (error) {
                console.error('❌ Bundle analysis failed:', error.message);
            }
        });
    }
};

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
    if (bytes === 0) {
        return '0 B';
    }
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',

    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd(result => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    }
};

/**
 * esbuild plugin that redirects Node.js built-ins to browser-safe stubs
 * for the web extension bundle. Only active during the web build.
 */
const webNodeShimPlugin = {
    name: 'web-node-shim',
    setup(build) {
        // Redirect 'fs' to a no-op stub
        build.onResolve({ filter: /^fs$/ }, () => ({
            path: path.resolve(__dirname, 'src/stubs/fs.ts'),
        }));
        // Redirect 'path' to path-browserify (pure-JS reimplementation)
        build.onResolve({ filter: /^path$/ }, () => ({
            path: require.resolve('path-browserify'),
        }));
    }
};

/**
 * esbuild plugin for the Visual Editor's page: `markdown-it` imported by
 * prosemirror-markdown resolves to a stub, so its unused default parser is not
 * built as the page loads; every other import of it — the page's own engine —
 * gets the real one (see the stub's header).
 */
const prosemirrorMarkdownParserStub = {
    name: 'prosemirror-markdown-parser-stub',
    setup(build) {
        build.onResolve({ filter: /^markdown-it$/ }, args => (
            /[\\/]node_modules[\\/]prosemirror-markdown[\\/]/.test(args.importer)
                ? { path: path.resolve(__dirname, 'src/editor/webview/stubs/markdown-it.ts') }
                : undefined
        ));
    }
};

/**
 * The codicon font for the Visual Editor's page (`$(icon)` in a lens title).
 * Copied out of node_modules, which the package leaves out, into dist/, which it
 * keeps; the page links the stylesheet, which finds the font beside it.
 */
function copyCodicons() {
    const from = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
    const to = path.join(__dirname, 'dist', 'codicons');
    fs.mkdirSync(to, { recursive: true });
    for (const file of ['codicon.css', 'codicon.ttf']) {
        fs.copyFileSync(path.join(from, file), path.join(to, file));
    }
}

async function main() {
    copyCodicons();
    const sharedPlugins = [
        esbuildProblemMatcherPlugin,
        ...(analyze ? [bundleAnalyzerPlugin] : [])
    ];

    // Desktop bundle — full Node.js environment, includes puppeteer/export
    const desktopCtx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'dist/extension.js',
        external: ['vscode'],
        logLevel: 'silent',
        metafile: analyze,
        plugins: sharedPlugins,
        define: {
            'process.env.NODE_ENV': production ? '"production"' : '"development"'
        },
        banner: {
            js: `
// VS Code Extension Bundled Entry
// This file was generated by esbuild
`.trim()
        }
    });

    // Web bundle — browser environment, excludes puppeteer/export commands
    const webCtx = await esbuild.context({
        entryPoints: ['src/extension.web.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outfile: 'dist/extension.web.js',
        external: ['vscode'],
        logLevel: 'silent',
        metafile: analyze,
        plugins: [...sharedPlugins, webNodeShimPlugin],
        define: {
            'process.env.NODE_ENV': production ? '"production"' : '"development"',
            'process.platform': '"web"',
        },
        banner: {
            js: `
// VS Code Web Extension Bundled Entry
// This file was generated by esbuild
`.trim()
        }
    });

    // Mermaid browser harness — a self-contained IIFE that exposes the mermaid
    // library on `globalThis.__mteMermaid`. It is loaded into the bundled headless
    // Chromium at export time to render mermaid diagrams to inline SVG. It is NOT
    // part of the Node extension bundle and is never written into exported files.
    const mermaidCtx = await esbuild.context({
        entryPoints: ['src/services/exporter/mermaidBrowserEntry.ts'],
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: false,
        platform: 'browser',
        outfile: 'dist/mermaid-browser.js',
        logLevel: 'silent',
        plugins: sharedPlugins,
        define: {
            'process.env.NODE_ENV': production ? '"production"' : '"development"',
        },
    });

    // The Visual Editor's page — the ProseMirror view that runs inside the
    // custom editor's webview. A browser IIFE loaded by a <script> tag; it talks
    // to the extension host by postMessage only, so it shares no module
    // instance with the desktop bundle.
    const editorWebviewCtx = await esbuild.context({
        entryPoints: ['src/editor/webview/main.ts'],
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outfile: 'dist/editor-webview.js',
        logLevel: 'silent',
        metafile: analyze,
        // markdown-it is bundled: the page reads the textblocks an edit
        // touches with the registry's inline plugins (src/editor/inlineEngine.ts).
        // prosemirror-markdown's default parser gets a stub in its place.
        plugins: [...sharedPlugins, prosemirrorMarkdownParserStub],
        define: {
            'process.env.NODE_ENV': production ? '"production"' : '"development"',
        },
    });

    const contexts = [desktopCtx, webCtx, mermaidCtx, editorWebviewCtx];
    if (watch) {
        await Promise.all(contexts.map(ctx => ctx.watch()));
        console.log('Watching for changes...');
    } else {
        await Promise.all(contexts.map(ctx => ctx.rebuild()));
        await Promise.all(contexts.map(ctx => ctx.dispose()));
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
