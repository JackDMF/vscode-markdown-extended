import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';

// The preview's own registry, in its order: both registrations of the plugin.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

suite('MarkdownItHtml5Embed', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('reference-style links to .ts files render as links (qjebbs/vscode-markdown-extended#154)', () => {
        const html = md.render([
            '# title',
            '',
            '[PlacesService]',
            '[Autocomplete]',
            'end',
            '',
            '[PlacesService]: src/map/map/extra/places-service.ts',
            '[Autocomplete]: src/map/map/extra/autocomplete.ts',
            '',
        ].join('\n'));
        assert.ok(html.includes('<a href="src/map/map/extra/places-service.ts">PlacesService</a>'), html);
        assert.ok(html.includes('<a href="src/map/map/extra/autocomplete.ts">Autocomplete</a>'), html);
        assert.ok(html.includes('end'), html);
    });

    test('a media link hides only its own text, and the line after it stays', () => {
        const html = md.render('[talk](t.mp3)\n[next](page.md) and **bold**\n');
        assert.ok(html.includes('<audio'), html);
        assert.ok(html.includes('<source type="audio/mpeg" src="t.mp3"></source>\ntalk\n</audio>'), html);
        assert.ok(html.includes('<a href="page.md">next</a> and <b>bold</b>'), html);
    });

    test('formatting after a media link in the same paragraph is rendered', () => {
        const html = md.render('[clip](v.mp4) is **bold**\n');
        assert.ok(html.includes('<video'), html);
        assert.ok(html.includes(' is <b>bold</b>'), html);
        assert.ok(!html.includes('</a>'), html);
    });

    test('a media link with formatted text embeds it, the text as its fallback', () => {
        const html = md.render('[`code` and **bold**](v.mp4)\n');
        assert.ok(html.includes('<source type="video/mp4" src="v.mp4"></source>\ncode and bold\n</video>'), html);
        assert.ok(!html.includes('<b>') && !html.includes('<code>'), html);
    });

    test('a link to TypeScript source is a link, not a video (qjebbs/vscode-markdown-extended#177)', () => {
        for (const href of ['src/foo.ts', 'src/foo.mts']) {
            const html = md.render(`[file](${href})\n`);
            assert.ok(html.includes(`<a href="${href}">file</a>`), html);
            assert.ok(!html.includes('<video'), html);
        }
    });

    test('image syntax is unchanged: alt text kept, media embedded, .ts included', () => {
        assert.ok(md.render('![A diagram](a.png)\n').includes('alt="A diagram"'));
        assert.ok(md.render('![clip](v.mp4)\n').includes('<video'));
        assert.ok(md.render('![clip](clip.ts)\n').includes('<source type="video/mp2t" src="clip.ts">'));
    });
});
