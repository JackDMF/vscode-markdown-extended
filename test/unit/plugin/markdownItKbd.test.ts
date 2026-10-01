import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';

// The preview's own registry, in its order: the embed's `!` is read by one
// plugin, its `[[` by another.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

suite('MarkdownItKbd and wiki embeds (qjebbs/vscode-markdown-extended#168)', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('a key is still a key', () => {
        assert.strictEqual(md.renderInline('Press [[Ctrl+S]] to save.'), 'Press <kbd>Ctrl+S</kbd> to save.');
        assert.strictEqual(md.renderInline('[[Ctrl]]+[[/]] and [[a *b*]]'), '<kbd>Ctrl</kbd>+<kbd>/</kbd> and <kbd>a <i>b</i></kbd>');
    });

    test('Foam\'s wiki embed ![[path/to/img.png]] is not a key, and is left as written', () => {
        assert.strictEqual(md.renderInline('See ![[path/to/img.png]] here.'), 'See ![[path/to/img.png]] here.');
        assert.strictEqual(md.renderInline('![[note]]'), '![[note]]');
        assert.strictEqual(md.renderInline('![[img.png|300]]'), '![[img.png|300]]');
    });

    test('a ! a backslash escapes is no embed\'s: the key after it stays a key', () => {
        assert.strictEqual(md.renderInline('Wow\\![[Ctrl]]'), 'Wow!<kbd>Ctrl</kbd>');
        // An escaped backslash leaves the `!` unescaped.
        assert.strictEqual(md.renderInline('a\\\\![[b]]'), 'a\\![[b]]');
    });

    test('a key inside an embed\'s text, and an embed beside a key', () => {
        assert.strictEqual(md.renderInline('[[Ctrl]] ![[x]] [[Esc]]'), '<kbd>Ctrl</kbd> ![[x]] <kbd>Esc</kbd>');
    });

    test('[[TOC]] on its own line is still the table of contents', () => {
        const html = md.render('[[TOC]]\n\n# One\n\n## Two\n');
        assert.ok(!html.includes('<kbd>'), html);
        assert.ok(html.includes('table-of-contents'), html);
        assert.ok(html.includes('href="#one"') || html.includes('One</a>'), html);
    });
});
