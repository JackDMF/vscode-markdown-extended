import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cssFileToDataUri, cssFileToDataUriAsync } from '../../../../src/services/common/dataUri';

/** The CSS a `data:text/css;base64,` URI carries. */
function cssOf(dataUri: string): string {
    return Buffer.from(dataUri.replace('data:text/css;base64,', ''), 'base64').toString();
}

suite('cssFileToDataUri', () => {
    let dir: string;
    let cssFile: string;

    suiteSetup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-data-uri-'));
        fs.writeFileSync(path.join(dir, 'font.woff2'), 'woff2');
        cssFile = path.join(dir, 'style.css');
        fs.writeFileSync(cssFile, [
            '@import url("https://example.com/theme.css");',
            'rect { fill: url(#grad); }',
            '@font-face { src: url("font.woff2?v=4.7.0"); }',
            '@font-face { src: url(\'font.woff2?#iefix\'); }',
            '@font-face { src: url(missing.woff2); }',
            'a { background: url(data:image/png;base64,AAAA); }',
        ].join('\n'));
    });

    suiteTeardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    for (const [name, convert] of [
        ['sync', async (f: string) => cssFileToDataUri(f)],
        ['async', cssFileToDataUriAsync],
    ] as const) {
        test(`${name}: what it cannot embed stays as written, a font's query does not reach its file`, async () => {
            const css = cssOf(await convert(cssFile));
            assert.ok(css.includes('url("https://example.com/theme.css")'), css);
            assert.ok(css.includes('url(#grad)'), css);
            assert.ok(css.includes('url(missing.woff2)'), css);
            assert.ok(css.includes('url(data:image/png;base64,AAAA)'), css);
            assert.ok(!css.includes('null'), css);
            const fonts = css.match(/url\("data:font\/woff2;base64,([^"]*)"\)/g) ?? [];
            assert.strictEqual(fonts.length, 2, css);
            assert.ok(fonts.every(f => f === `url("data:font/woff2;base64,${Buffer.from('woff2').toString('base64')}")`), css);
        });

        test(`${name}: a local @import url() is embedded one level deep, a network path not at all`, async () => {
            fs.writeFileSync(path.join(dir, 'base.css'), 'b { src: url(font.woff2); }');
            const importing = path.join(dir, 'importing.css');
            fs.writeFileSync(importing, '@import url("base.css");\n@import "plain.css";\na { src: url(//unc.invalid/x.woff2); }\n');
            const css = cssOf(await convert(importing));
            const imported = /@import url\("data:text\/css;base64,([^"]*)"\)/.exec(css);
            assert.strictEqual(imported && Buffer.from(imported[1], 'base64').toString(), 'b { src: url(font.woff2); }');
            assert.ok(css.includes('@import "plain.css"'), css);
            assert.ok(css.includes('url(//unc.invalid/x.woff2)'), css);
        });
    }
});
