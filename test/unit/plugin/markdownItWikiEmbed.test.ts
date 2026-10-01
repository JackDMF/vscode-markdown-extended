import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { MarkdownItWikiEmbed, readsWikiEmbeds } from '../../../src/plugin/markdownItWikiEmbed';
import { WIKI_EMBED_TOKENS_OPTION } from '../../../src/syntax/markers';

// The preview's own registry, in its order: the embed is read by one plugin,
// its `[[` by another.
function use(md: MarkdownIt.MarkdownIt): MarkdownIt.MarkdownIt {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

function preview(options: Record<string, unknown> = {}): MarkdownIt.MarkdownIt {
    return use(new MarkdownIt(options as MarkdownIt.Options));
}

interface CoreToken { type: string; content: string; children: CoreToken[] | null; meta?: { source?: string } | null }
interface CoreState { tokens: CoreToken[] }

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

/** What Foam's rule finds in `source`, rendered by `md`. */
function foamFinds(md: MarkdownIt.MarkdownIt, source: string): string[] {
    const found = foamEmbeds(md);
    md.render(source);
    return found;
}

/** Every token of the parse, nested ones included. */
function allTokens(tokens: CoreToken[]): CoreToken[] {
    return tokens.flatMap(t => [t, ...allTokens(t.children ?? [])]);
}

suite('MarkdownItWikiEmbed: a wiki embed is no key (qjebbs/vscode-markdown-extended#168)', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('a key is still a key', () => {
        assert.strictEqual(md.renderInline('Press [[Ctrl+S]] to save.'), 'Press <kbd>Ctrl+S</kbd> to save.');
        assert.strictEqual(md.renderInline('[[Ctrl]]+[[/]] and [[a *b*]]'), '<kbd>Ctrl</kbd>+<kbd>/</kbd> and <kbd>a <i>b</i></kbd>');
        assert.ok(readsWikiEmbeds(md));
        assert.ok(!readsWikiEmbeds(new MarkdownIt()));
    });

    test('an embed is literal text: nothing in its name is read as syntax', () => {
        for (const embed of [
            '![[path/to/img.png]]', '![[note]]', '![[img.png|300]]', '![[note#^block-id]]',
            '![[assets/_img.png]]', '![[C++ notes]]', '![[a@b $x$ ^y^ ~z~ ==m==]]', '![[:smile: <b>]]',
        ]) {
            assert.strictEqual(md.renderInline(`See ${embed} here.`), `See ${md.utils.escapeHtml(embed)} here.`, embed);
        }
    });

    test('Foam\'s rule reads the text plain markdown-it gives it: escapes and references resolved', () => {
        for (const source of [
            'See ![[path/to/img.png]] here.\n',
            '![[img.png\\_a]]\n',
            '![[a&amp;b]]\n',
            '| a |\n| - |\n| ![[img.png\\|300]] |\n',
        ]) {
            assert.deepStrictEqual(foamFinds(preview(), source), foamFinds(new MarkdownIt(), source), source);
        }
        assert.deepStrictEqual(foamFinds(preview(), '![[img.png\\_a]]\n'), ['img.png_a']);
    });

    test('Foam\'s rule finds an embed when registered before this extension, and inside a note', () => {
        const before = new MarkdownIt();
        const early = foamEmbeds(before);
        use(before).render('![[img.png]]\n');
        assert.deepStrictEqual(early, ['img.png']);
        const texts = allTokens(md.parse('A ++ref|![[in-note.png]]++ b\n', {}) as unknown as CoreToken[])
            .filter(t => t.type === 'text').map(t => t.content);
        assert.ok(texts.includes('![[in-note.png]]'), texts.join(' | '));
    });

    test('typographer and linkify leave an embed\'s name alone', () => {
        const typo = preview({ typographer: true, linkify: true });
        assert.strictEqual(typo.renderInline('![[it\'s -- (c) https://x.org]]'), '![[it\'s -- (c) https://x.org]]');
    });

    test('an engine with the option keeps each embed a token carrying its source, a note\'s too', () => {
        const editor = preview({ [WIKI_EMBED_TOKENS_OPTION]: true });
        const embeds = allTokens(editor.parse('A ![[a\\_b.png]] and ++ref|![[x]]++ b\n', {}) as unknown as CoreToken[])
            .filter(t => t.type === 'wiki_embed');
        assert.deepStrictEqual(embeds.map(t => [t.content, t.meta?.source]), [['![[a_b.png]]', '![[a\\_b.png]]'], ['![[x]]', '![[x]]']]);
        assert.strictEqual(editor.renderInline('![[a&amp;b]]'), '![[a&amp;b]]');
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
        assert.ok(md.renderInline('![alt](y.png)').startsWith('<img src="y.png" alt="alt"'));
    });

    test('a {…} right after an embed stays text; attributes elsewhere still apply', () => {
        assert.strictEqual(md.render('![[x]]{.cls}\n'), '<p>![[x]]{.cls}</p>\n');
        assert.strictEqual(md.render('a ![[x]]{.cls} b\n'), '<p>a ![[x]]{.cls} b</p>\n');
        assert.strictEqual(md.render('**b**{.cls}\n'), '<p><b class="cls">b</b></p>\n');
    });

    test('a key right after a marginal note\'s closing !! stays a key', () => {
        const html = md.renderInline('!!ref|note!![[Ctrl]]');
        assert.ok(html.endsWith('<kbd>Ctrl</kbd>'), html);
        assert.ok(html.includes('mnote'), html);
    });

    test('![[x [[Ctrl]] y]] is no embed — a name holds no bracket, as in Foam — so it is a ! and a key', () => {
        assert.strictEqual(md.renderInline('![[x [[Ctrl]] y]]'), '!<kbd>x <kbd>Ctrl</kbd> y</kbd>');
        assert.strictEqual(md.renderInline('[[a ![[b]] c]]'), '<kbd>a ![[b]] c</kbd>');
    });

    test('an embed holds no line break and no empty name', () => {
        assert.strictEqual(md.renderInline('![[]]'), '!<kbd></kbd>');
        assert.strictEqual(md.render('![[a\nb]]\n'), '<p>![[a\nb]]</p>\n');
    });

    test('the rule reads a long line of unclosed embeds, and one of closed ones, in linear time', function () {
        this.timeout(20000);
        // On its own: markdown-it-kbd's scan of an unclosed `[[` is its own (and quadratic).
        const alone = new MarkdownIt().use(MarkdownItWikiEmbed as unknown as MarkdownIt.PluginSimple);
        for (const source of ['![[a '.repeat(100000) + '\n', '![[a]] '.repeat(100000) + '\n']) {
            const t0 = Date.now();
            alone.render(source);
            assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
        }
        const t1 = Date.now();
        md.render('![[a]] '.repeat(100000) + '\n');
        assert.ok(Date.now() - t1 < 3000, `${Date.now() - t1} ms`);
    });

    test('[[TOC]] on its own line is still the table of contents', () => {
        const html = md.render('[[TOC]]\n\n# One\n\n## Two\n');
        assert.ok(!html.includes('<kbd>'), html);
        assert.ok(html.includes('table-of-contents'), html);
    });
});
