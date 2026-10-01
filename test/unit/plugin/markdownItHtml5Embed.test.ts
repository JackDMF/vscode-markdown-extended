import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { MarkdownItHtml5Embed } from '../../../src/plugin/markdownItHtml5Embed';

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
        const html = md.render('[`code` and **bold** :smile:](v.mp4)\n');
        assert.ok(html.includes('<source type="video/mp4" src="v.mp4"></source>\ncode and bold 😄\n</video>'), html);
        assert.ok(!html.includes('<b>') && !html.includes('<code>'), html);
    });

    test('two adjacent media links are both embedded', () => {
        const html = md.render('[a](a.mp3)[b](b.webm) end\n');
        assert.ok(html.includes('src="a.mp3"></source>\na\n</audio>'), html);
        assert.ok(html.includes('src="b.webm"></source>\nb\n</video> end'), html);
    });

    test('an image inside a media link gives the embed its alt text', () => {
        const html = md.render('[![poster](p.png)](v.mp4)\n');
        assert.ok(html.includes('src="v.mp4"></source>\nposter\n</video>'), html);
        assert.ok(!html.includes('<img'), html);
    });

    test('a media link holding an autolink is embedded whole, to its own close', () => {
        const html = md.render('[<https://e.com/b.mp4>](v.mp4) after\n');
        assert.ok(html.includes('<source type="video/mp4" src="v.mp4"></source>\nhttps://e.com/b.mp4\n</video> after'), html);
        assert.ok(!html.includes('<a ') && !html.includes('</a>'), html);
    });

    test('rendering the same tokens twice gives the same HTML', () => {
        const options = (md as unknown as { options: MarkdownIt.Options }).options;
        const tokens = md.parse('# [talk](t.mp3) heading\n\n[clip](v.mp4)\nafter\n', {});
        const first = md.renderer.render(tokens, options, {});
        assert.strictEqual(md.renderer.render(tokens, options, {}), first);
        assert.ok(first.includes('\ntalk\n</audio>') && first.includes('\nclip\n</video>'), first);
    });

    test('a media link\'s text is escaped, so it cannot close the player or add markup', () => {
        const html = md.render('[a<b](x.mp3) after\n\n[&lt;img src=x onerror=alert(1)&gt;](v.mp4)\n');
        assert.ok(html.includes('\na&lt;b\n</audio> after'), html);
        assert.ok(html.includes('\n&lt;img src=x onerror=alert(1)&gt;\n</video>'), html);
        assert.ok(!html.includes('<img'), html);
    });

    test('a media image\'s source and title are escaped, also when export decodes the source', () => {
        const html = md.render('![<b>v</b>](x%22%20onerror%3D%22alert(1)%22%20y.mp4)\n',
            { htmlExporter: { vsUri: 'file:///', embedImage: false } });
        assert.ok(html.includes('src="x&quot; onerror=&quot;alert(1)&quot; y.mp4"'), html);
        assert.ok(html.includes('\n&lt;b&gt;v&lt;/b&gt;\n</video>'), html);
    });

    test('a media image\'s title is what its alt reads, escaped once', () => {
        const html = md.render('![a &amp; b &lt;c&gt; **d**](v.mp4)\n');
        assert.ok(html.includes('\na &amp; b &lt;c&gt; d\n</video>'), html);
    });

    test('a link is embedded only when a browser plays its type (qjebbs/vscode-markdown-extended#177)', () => {
        for (const href of ['src/foo.ts', 'src/foo.mts', 'clip.m2ts', 'sound.dts', 'list.m3u', 'film.mkv']) {
            const html = md.render(`[file](${href})\n`);
            assert.ok(html.includes(`<a href="${href}">file</a>`), html);
            assert.ok(!html.includes('<video') && !html.includes('<audio'), html);
        }
        for (const href of ['a.mp4', 'a.webm', 'a.ogv', 'a.mp3', 'a.ogg', 'a.wav', 'a.m4a', 'a.flac', 'a.aac']) {
            assert.ok(/<(audio|video) /.test(md.render(`[file](${href})\n`)), href);
        }
    });

    test('image syntax is unchanged: alt text kept, media embedded, .ts included', () => {
        assert.ok(md.render('![A diagram](a.png)\n').includes('alt="A diagram"'));
        assert.ok(md.render('![clip](v.mp4)\n').includes('<video'));
        assert.ok(md.render('![clip](clip.ts)\n').includes('<source type="video/mp2t" src="clip.ts">'));
    });

    test('the library\'s snake_case options go through the wrapper', () => {
        const own = new MarkdownIt();
        // eslint-disable-next-line @typescript-eslint/naming-convention
        own.use(MarkdownItHtml5Embed, { html5embed: { use_link_syntax: true, is_allowed_mime_type: () => true } });
        assert.ok(own.render('[t](t.mp3)\n').includes('<audio'));
        assert.ok(own.render('[file](foo.ts)\n').includes('<a href="foo.ts">'));
        assert.ok(own.render('![t](t.mp3)\n').includes('<img'));
    });

    test('a registration that throws leaves link_open as it was', () => {
        const own = new MarkdownIt();
        const use = own.use;
        own.use = () => { throw new Error('boom'); };
        assert.throws(() => MarkdownItHtml5Embed(own, { html5embed: { useLinkSyntax: true } }));
        own.use = use;
        assert.strictEqual(own.render('[a](a.md)\n'), '<p><a href="a.md">a</a></p>\n');
    });
});
