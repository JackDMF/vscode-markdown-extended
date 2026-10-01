import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { WIKI_EMBED_META } from '../../../src/syntax/markers';

// The preview's own registry, in its order: the embed is read by one plugin,
// its `[[` by another.
function use(md: MarkdownIt.MarkdownIt): MarkdownIt.MarkdownIt {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

function preview(options: MarkdownIt.Options = {}): MarkdownIt.MarkdownIt {
    return use(new MarkdownIt(options));
}

interface CoreState { tokens: { type: string; children: { type: string; content: string }[] | null }[] }

/** Foam's embed rule as markdown-it-regex registers it: a core rule, pushed last, that searches every `text` token. */
function foamEmbeds(md: MarkdownIt.MarkdownIt): string[] {
    const found: string[] = [];
    md.core.ruler.push('foam_embed', (state: CoreState) => {
        for (const block of state.tokens) {
            for (const child of block.type === 'inline' ? block.children ?? [] : []) {
                const m = child.type === 'text' ? /!\[\[([^[\]]+?)\]\]/.exec(child.content) : null;
                if (m) { found.push(m[1]); }
            }
        }
    });
    return found;
}

suite('MarkdownItWikiEmbed: a wiki embed is no key (qjebbs/vscode-markdown-extended#168)', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('a key is still a key', () => {
        assert.strictEqual(md.renderInline('Press [[Ctrl+S]] to save.'), 'Press <kbd>Ctrl+S</kbd> to save.');
        assert.strictEqual(md.renderInline('[[Ctrl]]+[[/]] and [[a *b*]]'), '<kbd>Ctrl</kbd>+<kbd>/</kbd> and <kbd>a <i>b</i></kbd>');
    });

    test('an embed is the literal text it was written as, whatever its name holds', () => {
        for (const embed of [
            '![[path/to/img.png]]', '![[note]]', '![[img.png|300]]', '![[note#^block-id]]',
            '![[assets/_img.png]]', '![[C++ notes]]', '![[a@b $x$ ^y^ ~z~ ==m==]]', '![[:smile: <b>]]',
        ]) {
            assert.strictEqual(md.renderInline(`See ${embed} here.`), `See ${md.utils.escapeHtml(embed)} here.`, embed);
        }
    });

    test('typographer and linkify leave an embed\'s name alone', () => {
        const typo = preview({ typographer: true, linkify: true });
        assert.strictEqual(typo.renderInline('![[it\'s -- (c) https://x.org]]'), '![[it\'s -- (c) https://x.org]]');
    });

    test('Foam\'s embed rule still finds the embed in the text, registered after this extension or before it', () => {
        const after = preview();
        const late = foamEmbeds(after);
        after.render('See ![[path/to/img.png]] and [[Ctrl]].\n');
        assert.deepStrictEqual(late, ['path/to/img.png']);
        const before = new MarkdownIt();
        const early = foamEmbeds(before);
        use(before).render('![[img.png]]\n');
        assert.deepStrictEqual(early, ['img.png']);
    });

    test('the inline token holding an embed carries the flag the Visual Editor reads', () => {
        const flagged = (src: string) => md.parse(src, {}).filter(t => t.type === 'inline')
            .map(t => !!(t.meta as Record<string, unknown> | null)?.[WIKI_EMBED_META]);
        assert.deepStrictEqual(flagged('A ![[x]] b\n\nNo [[Ctrl]] here\n\n![alt ![[y]]](z.png)\n'), [true, false, true]);
    });

    test('a ! a backslash escapes opens no embed; an escaped backslash leaves the ! bare', () => {
        assert.strictEqual(md.renderInline('Wow\\![[Ctrl]]'), 'Wow!<kbd>Ctrl</kbd>');
        assert.strictEqual(md.renderInline('a\\\\![[b]]'), 'a\\![[b]]');
        // Escaped brackets are text: no embed, and no key.
        assert.strictEqual(md.renderInline('!\\[\\[note\\]\\]'), '![[note]]');
    });

    test('![[x]](y) and ![[x]][ref] are the embed and the text after it, not an image', () => {
        assert.strictEqual(md.renderInline('![[x]](y)'), '![[x]](y)');
        assert.strictEqual(md.render('![[x]][ref]\n\n[ref]: /u\n'), '<p>![[x]]<a href="/u">ref</a></p>\n');
        // An image is still an image.
        assert.ok(md.renderInline('![alt](y.png)').startsWith('<img src="y.png" alt="alt"'));
    });

    test('a key right after a marginal note\'s closing !! stays a key', () => {
        const html = md.renderInline('!!ref|note!![[Ctrl]]');
        assert.ok(html.endsWith('<kbd>Ctrl</kbd>'), html);
        assert.ok(html.includes('mnote'), html);
    });

    test('![[x [[Ctrl]] y]] is no embed — a name holds no bracket, as in Foam — so it is a ! and a key', () => {
        assert.strictEqual(md.renderInline('![[x [[Ctrl]] y]]'), '!<kbd>x <kbd>Ctrl</kbd> y</kbd>');
        // An embed inside a key's text is still literal.
        assert.strictEqual(md.renderInline('[[a ![[b]] c]]'), '<kbd>a ![[b]] c</kbd>');
    });

    test('an embed holds no line break and no empty name', () => {
        assert.strictEqual(md.renderInline('![[]]'), '!<kbd></kbd>');
        assert.strictEqual(md.render('![[a\nb]]\n'), '<p>![[a\nb]]</p>\n');
    });

    test('[[TOC]] on its own line is still the table of contents', () => {
        const html = md.render('[[TOC]]\n\n# One\n\n## Two\n');
        assert.ok(!html.includes('<kbd>'), html);
        assert.ok(html.includes('table-of-contents'), html);
    });
});
