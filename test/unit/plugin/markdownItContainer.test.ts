import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import * as vscode from 'vscode';
import { plugins } from '../../../src/plugin/plugins';
import { containerClass } from '../../../src/editor/schema';

// The preview's own registry, in its order: markdown-it-attrs reads the `{…}` and the container renders it.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

/** The opening tag of the first `div` in `html`. */
function openingDiv(html: string): string {
    const m = /<div[^>]*>/.exec(html);
    assert.ok(m, `no <div> in ${html}`);
    return m[0];
}

suite('MarkdownItContainer', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('the info is the container\'s class', () => {
        assert.strictEqual(md.render('::: warning big\nInside.\n:::\n'), '<div class="warning big">\n<p>Inside.</p>\n</div>\n');
    });

    test('a {…} alone on the ::: line gives the container its classes (qjebbs/vscode-markdown-extended#126)', () => {
        assert.strictEqual(openingDiv(md.render('::: { .admonition .note }\nThis is a note\n:::\n')), '<div class="admonition note">');
    });

    test('a {…} after the info adds its classes after the info\'s, and its id and attributes', () => {
        assert.strictEqual(openingDiv(md.render('::: note {#id .c}\nInside.\n:::\n')), '<div class="note c" id="id">');
        assert.strictEqual(openingDiv(md.render('::: note {data-x="a b" lang=de}\nInside.\n:::\n')), '<div class="note" data-x="a b" lang="de">');
    });

    test('a container with no info keeps an empty class, as before', () => {
        assert.strictEqual(openingDiv(md.render(':::\nInside.\n:::\n')), '<div class="">');
    });

    test('the info is escaped once', () => {
        assert.strictEqual(openingDiv(md.render('::: a"b <c> &d\nInside.\n:::\n')), '<div class="a&quot;b &lt;c&gt; &amp;d">');
    });

    test('a brace of the text\'s own ending the info is no class, and no attribute', () => {
        assert.strictEqual(openingDiv(md.render('::: note {a = b}\nInside.\n:::\n')), '<div class="note">');
        // The editor draws the container with the same class.
        assert.strictEqual(containerClass('note', ' {a = b}'), 'note');
    });

    test('a literal glued to the info is read as markdown-it-attrs reads it', () => {
        assert.strictEqual(openingDiv(md.render('::: note x{.c}\nInside.\n:::\n')), '<div class="note x c">');
    });

    test('a second render gives the same div', () => {
        const tokens = md.parse('::: note {.c}\nInside.\n:::\n', {});
        const first = md.renderer.render(tokens, {}, {});
        assert.strictEqual(md.renderer.render(tokens, {}, {}), first);
        assert.strictEqual(openingDiv(first), '<div class="note c">');
    });
});

/**
 * VS Code's preview marks every block it renders from a token with its source
 * line (`code-line`, `data-line`) and `dir="auto"`. The hand-written `div` had
 * none of them; rendered from its token the container has them too, which is
 * kept: scroll sync then finds the container's own line, as it finds its
 * paragraphs'.
 */
suite('MarkdownItContainer in VS Code\'s preview', () => {
    test('the container\'s div carries its line, its classes first and the literal\'s attributes', async () => {
        await vscode.extensions.getExtension('jackdmf.markdown-extended-pro')?.activate();
        const html = await vscode.commands.executeCommand<string>('markdown.api.render', '::: note {#x .c}\nInside.\n:::\n\n::: warning\nText.\n:::\n');
        assert.ok(html.includes('<div class="note c code-line" id="x" data-line="0" dir="auto">'), html);
        assert.ok(html.includes('<div class="warning code-line" data-line="4" dir="auto">'), html);
    });
});