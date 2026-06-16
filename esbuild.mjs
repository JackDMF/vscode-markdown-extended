import * as esbuild from 'esbuild';

/** @type {esbuild.BuildOptions} */
const options = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/main.js',
    // vscode is provided by VS Code at runtime, must be external
    // puppeteer/puppeteer-core JS code is bundled, binary (Chromium) is handled separately
    external: [
        'vscode',
    ],
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    minify: false,
    keepNames: true,
};

const watch = process.argv.includes('--watch');

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[watch] build finished, watching for changes...');
} else {
    await esbuild.build(options);
}
