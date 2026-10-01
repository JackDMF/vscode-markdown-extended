import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { admonitionParams } from '../../../src/plugin/markdownItAdmonition';

// The preview's own registry, in its order: attrs and multimd read what the admonition leaves them.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

/** The box's opening tag and its title bar, as rendered. */
function head(html: string): { box: string; title: string | null } {
    const box = /<div class="admonition[^"]*"[^>]*>/.exec(html)?.[0] ?? '';
    const title = /<p[^>]*class="[^"]*admonition-title[^"]*"[^>]*>[\s\S]*?<\/p>/.exec(html)?.[0] ?? null;
    return { box, title };
}

function cells(html: string): string[] {
    return [...html.matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g)].map(([, text]) => text);
}

suite('MarkdownItAdmonition: the opening line', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('an unquoted title holding a quote is the title, not a class (qjebbs/vscode-markdown-extended#131)', () => {
        const html = md.render('!!! note <font color="red">Styled</font>\n    Body.\n');
        assert.deepStrictEqual(head(html), {
            box: '<div class="admonition note">',
            title: '<p class="admonition-title">&lt;font color=&quot;red&quot;&gt;Styled&lt;/font&gt;</p>',
        });
    });

    test('a {…} after the closing quote goes to the title bar, not into the title (qjebbs/vscode-markdown-extended#131)', () => {
        const html = md.render('!!! bug "Title" {style="color:#FF00FF"}\n    Body.\n');
        assert.deepStrictEqual(head(html), {
            box: '<div class="admonition bug">',
            title: '<p style="color:#FF00FF" class="admonition-title">Title</p>',
        });
    });

    test('an unquoted title is trimmed: no leading space in the title bar', () => {
        assert.strictEqual(head(md.render('!!! warning Mind it\n    Body.\n')).title, '<p class="admonition-title">Mind it</p>');
    });

    test('the quoted forms keep their meaning: classes before the quote, inner quotes, no title, an unknown type', () => {
        assert.deepStrictEqual(head(md.render('!!! warning big "Title"\n    Body.\n')),
            { box: '<div class="admonition warning big">', title: '<p class="admonition-title">Title</p>' });
        assert.deepStrictEqual(head(md.render('!!! bug "Ti "q" tle"\n    Body.\n')).title, '<p class="admonition-title">Ti &quot;q&quot; tle</p>');
        assert.deepStrictEqual(head(md.render('!!! tip\n    Body.\n')), { box: '<div class="admonition tip">', title: null });
        assert.deepStrictEqual(head(md.render('!!! foo "Bar"\n    Body.\n')),
            { box: '<div class="admonition note foo">', title: '<p class="admonition-title">Bar</p>' });
        assert.deepStrictEqual(head(md.render('!!! foo Bar baz\n    Body.\n')),
            { box: '<div class="admonition note">', title: '<p class="admonition-title">foo Bar baz</p>' });
    });

    test('the rule: a quote is a quoted title only after the type and its classes', () => {
        assert.deepStrictEqual(admonitionParams(' note "A title"'), { type: 'note', classes: ['note'], title: 'A title' });
        assert.deepStrictEqual(admonitionParams(' note font color="red"'), { type: 'note', classes: ['note'], title: 'font color="red"' });
        assert.deepStrictEqual(admonitionParams(' bug "T" {.x}'), { type: 'bug', classes: ['bug'], title: 'T {.x}' });
        assert.deepStrictEqual(admonitionParams(' note Say "hi" twice'), { type: 'note', classes: ['note'], title: 'Say "hi" twice' });
        assert.deepStrictEqual(admonitionParams(' note Say "hi"'), { type: 'note', classes: ['note', 'Say'], title: 'hi' });
        assert.deepStrictEqual(admonitionParams(' note "Unclosed'), { type: 'note', classes: ['note'], title: '"Unclosed' });
        assert.deepStrictEqual(admonitionParams(' note ""'), { type: 'note', classes: ['note'], title: '' });
        assert.deepStrictEqual(admonitionParams(' warning Do not run "rm -rf"'),
            { type: 'warning', classes: ['warning', 'Do', 'not', 'run'], title: 'rm -rf' }, 'a quoted phrase ending the line makes the words before it classes, as in python-markdown');
    });

    test('a class is any word without a quote, as before: non-ASCII, dotted', () => {
        assert.deepStrictEqual(admonitionParams(' warning größe "Titel"'), { type: 'warning', classes: ['warning', 'größe'], title: 'Titel' });
        assert.deepStrictEqual(admonitionParams(' note 重要 "标题"'), { type: 'note', classes: ['note', '重要'], title: '标题' });
        assert.deepStrictEqual(admonitionParams(' 注意 "标题"'), { type: 'note', classes: ['note', '注意'], title: '标题' });
        assert.deepStrictEqual(admonitionParams(' Foo "Bar"'), { type: 'note', classes: ['note', 'Foo'], title: 'Bar' });
        assert.deepStrictEqual(admonitionParams(' WARNING "Big"'), { type: 'warning', classes: ['warning'], title: 'Big' });
        assert.deepStrictEqual(admonitionParams(' note my.class "Title"'), { type: 'note', classes: ['note', 'my.class'], title: 'Title' });
    });

    test('a lone type may touch its quote, and the type is lowercased when the title is quoted too', () => {
        assert.deepStrictEqual(head(md.render('!!! warning"Careful"\n    Body.\n')),
            { box: '<div class="admonition warning">', title: '<p class="admonition-title">Careful</p>' });
        assert.deepStrictEqual(head(md.render('!!! WARNING "Big"\n    Body.\n')),
            { box: '<div class="admonition warning">', title: '<p class="admonition-title">Big</p>' });
    });

    test('a quoted title is kept as written; "" is no title, a {…} after it too', () => {
        assert.deepStrictEqual(admonitionParams(' note " padded "'), { type: 'note', classes: ['note'], title: ' padded ' });
        assert.strictEqual(head(md.render('!!! note "  "\n    Body.\n')).title, '<p class="admonition-title">  </p>', 'a blank title bar, as python-markdown draws it');
        assert.deepStrictEqual(head(md.render('!!! note "" {.x}\n    Body.\n')), { box: '<div class="admonition note">', title: null });
    });
});

suite('MarkdownItAdmonition: the body', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('a tab-indented body keeps a multimd table\'s first column whole (qjebbs/vscode-markdown-extended#110)', () => {
        const tab = md.render('!!! hint\n\tsome text\n\n\t|First|Second|\n\t|---|---|\n\t|First|Second|\n');
        const spaces = md.render('!!! hint\n    some text\n\n    |First|Second|\n    |---|---|\n    |First|Second|\n');
        assert.deepStrictEqual(cells(tab), ['First', 'Second', 'First', 'Second']);
        assert.strictEqual(tab, spaces, 'a tab indents the body as four spaces do');
    });

    test('a nested admonition indented by tabs reads its own table whole', () => {
        const html = md.render('!!! hint\n\t!!! warning "In"\n\t\t|A|B|\n\t\t|-|-|\n\t\t|1|2|\n');
        assert.deepStrictEqual(cells(html), ['A', 'B', '1', '2']);
    });

    test('a tab past the body\'s indentation still counts: code stays code, a fence keeps its inner tab', () => {
        assert.ok(md.render('!!! hint\n\t\tcode\n').includes('<pre><code>code\n</code></pre>'));
        assert.ok(md.render('!!! hint\n\t```\n\tx\n\t\ty\n\t```\n').includes('<pre><code>x\n\ty\n</code></pre>'));
    });

    test('a tab the body\'s indentation ends inside keeps its remaining columns: a list item\'s admonition reads tabs as spaces', () => {
        // The list's content starts at column 2, the body at 6: the second tab (columns 4 to 8) straddles it.
        const tabs = md.render('- !!! hint\n\t\t```\n\t\tx\n\t\t\ty\n\t\t```\n');
        const spaces = md.render('- !!! hint\n        ```\n        x\n        \ty\n        ```\n');
        assert.ok(tabs.includes('<pre><code>x\n\ty\n</code></pre>'), tabs);
        assert.strictEqual(tabs, spaces);
    });

    test('the lines after the box are read as before: the offsets the body changed are put back', () => {
        const html = md.render('!!! hint\n\tInside.\n\n|A|B|\n|-|-|\n|1|2|\n');
        assert.ok(html.includes('<p>Inside.</p>\n</div>\n<table>'));
        assert.deepStrictEqual(cells(html), ['A', 'B', '1', '2']);
    });
});
