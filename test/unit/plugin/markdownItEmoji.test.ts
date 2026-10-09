import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { full as markdownItEmojiAlone } from 'markdown-it-emoji';
import { plugins } from '../../../src/plugin/plugins';
import { MarkdownItEmoji, readsEmoji } from '../../../src/plugin/markdownItEmoji';

interface EmojiToken { type: string; markup: string; content: string; children: EmojiToken[] | null; meta?: { source?: string | null } | null }

/** The preview's engine: the registry, in its order. */
function preview(registry = plugins): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt({ html: true, linkify: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registry.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

/** Every emoji token `md` reads in `source`, nested ones (a note's) included, in order. */
function emojisOf(md: MarkdownIt.MarkdownIt, source: string): EmojiToken[] {
    const out: EmojiToken[] = [];
    const walk = (tokens: EmojiToken[] | null) => {
        for (const t of tokens ?? []) {
            if (t.type === 'emoji') {
                out.push(t);
            }
            walk(t.children);
        }
    };
    walk(md.parse(source, {}) as unknown as EmojiToken[]);
    return out;
}

const BS = '\\';
const NL = '\n';

/** Each source, with the spelling of every emoji the preview reads in it, in order. */
const CASES: [string, string[]][] = [
    ['Hello :smile: there', [':smile:']],
    ['Hello :) there', [':)']],
    ['Hello :-) there', [':-)']],
    ['Hello <3 there', ['<3']],
    ['Hello </3 there', ['</3']],
    [`Hello <${BS}3 there`, []],
    ['a:smile:b', [':smile:']],
    [':) hi', [':)']],
    ['hi :)', [':)']],
    ['hi!:)', [':)']],
    [`hi ${BS}:) there`, []],
    [`hi ${BS}:smile: there`, []],
    [':+1::+1:', [':+1:', ':+1:']],
    [':):smile:', [':)', ':smile:']],
    [':):)', [':)', ':)']],
    [':):-)', [':)', ':-)']],
    [':-):)', [':-)', ':)']],
    // A rejected shortcut is still consumed: the `:)` is text, the `8-)` an emoji.
    [':)8-)', ['8-)']],
    // At a line start `>` is a quote's.
    ['>:(:(', [':(', ':(']],
    ['x >:(:(', ['>:(', ':(']],
    // `>` is a math symbol, no punctuation: the `:(` before it is text.
    [':(>:(', ['>:(']],
    [':notanemoji:', []],
    ['# Title :) :tada:', [':)', ':tada:']],
    ['- item :)', [':)']],
    ['> quoted :)', [':)']],
    [`| a | b |${NL}|---|---|${NL}| x :) | y |`, [':)']],
    ['[see :) here](http://e.com/)', [':)']],
    ['a **x :smile: y** b', [':smile:']],
    ['a [x :)]{.c} b', [':)']],
    ['a ==x :) y== b', [':)']],
    ['a [[Ctrl :)]] b', [':)']],
    ['a ++ref :)|note :smile: body++ b', [':)', ':smile:']],
    ['a !!ref|note :) body!! b', [':)']],
    ['a @x :) y@ b', [':)']],
    ['a <b>:)</b> b', [':)']],
    [`a :)${NL}b :smile:`, [':)', ':smile:']],
    ['a &#58;) b', []],
    ['x :) :) :) y', [':)', ':)', ':)']],
    [':smile::smile::smile:', [':smile:', ':smile:', ':smile:']],
    ['see http://e.com/ :) and `:)` and ![:)](x.png)', [':)']],
];

suite('MarkdownItEmoji: every emoji the host reads carries its spelling', () => {
    test('each emoji token carries its source as written, which read alone in prose is that one emoji', () => {
        const md = preview();
        for (const [source, spelled] of CASES) {
            const found = emojisOf(md, source + NL);
            assert.deepStrictEqual(found.map(t => t.meta?.source), spelled, source);
            for (const token of found) {
                // In prose, between spaces: at a line start `>:(` is a quote's.
                const alone = emojisOf(md, `x ${token.meta?.source as string} y${NL}`);
                assert.deepStrictEqual(alone.map(t => t.markup), [token.markup], `${source}: ${token.meta?.source as string} alone`);
            }
        }
    });

    test('an emoji whose spelling the plugin\'s table cannot tell carries none: source null', () => {
        // Other shortcuts than the package's, which the spelling is read by.
        const md = new MarkdownIt().use(MarkdownItEmoji, { shortcuts: { smiley: ['=)'] } });
        const found = emojisOf(md, 'hi =) there :smiley:' + NL);
        assert.deepStrictEqual(found.map(t => [t.markup, t.meta?.source]), [['smiley', null], ['smiley', ':smiley:']]);
    });

    test('the preview renders as the plugin alone does', () => {
        const alone = new MarkdownIt().use(markdownItEmojiAlone);
        const wrapped = new MarkdownIt().use(MarkdownItEmoji);
        for (const [source] of CASES) {
            assert.strictEqual(wrapped.render(source), alone.render(source), source);
        }
    });

    test('readsEmoji is the rule as the engine was built: off with plugins.disabled or an extender', () => {
        assert.ok(readsEmoji(preview()));
        const disabled = preview(plugins.filter(p => p.name !== 'markdown-it-emoji'));
        assert.ok(!readsEmoji(disabled));
        assert.deepStrictEqual(emojisOf(disabled, 'hi :) there' + NL), []);
        const off = preview();
        off.core.ruler.disable('emoji');
        assert.ok(!readsEmoji(off));
        assert.deepStrictEqual(emojisOf(off, 'hi :) there' + NL), []);
    });
});

suite('MarkdownItEmoji: every emoji the host reads carries where it stands', () => {
    /** Each emoji of `source` with its recorded place, and what the inline token's text holds there. */
    const placed = (md: MarkdownIt.MarkdownIt, source: string) => {
        const out: { source: unknown; at: unknown; there: string | null }[] = [];
        for (const inline of md.parse(source, {}) as unknown as { type: string; content: string; children: EmojiToken[] | null }[]) {
            if (inline.type !== 'inline') {
                continue;
            }
            const walk = (tokens: EmojiToken[] | null) => {
                for (const t of tokens ?? []) {
                    if (t.type === 'emoji') {
                        const meta = t.meta as { source?: string | null; at?: number | null } | null;
                        const at = meta?.at ?? null;
                        const spelled = meta?.source ?? '';
                        out.push({ source: meta?.source, at, there: typeof at === 'number' ? inline.content.slice(at, at + spelled.length) : null });
                    }
                    walk(t.children);
                }
            };
            walk(inline.children);
        }
        return out;
    };

    test('its offset in the inline text it was read from, where its spelling stands', () => {
        const md = preview();
        for (const [source, spelled] of CASES) {
            const found = placed(md, source + NL);
            assert.deepStrictEqual(found.map(f => f.source), spelled, source);
            for (const f of found) {
                assert.strictEqual(f.there, f.source, `${source}: ${String(f.source)} at ${String(f.at)}`);
            }
        }
        // Equal spellings apart: each its own place.
        assert.deepStrictEqual(placed(md, 'x :) y :) z\n').map(f => f.at), [2, 7]);
        assert.deepStrictEqual(placed(md, 'a ++r|x :) y++ b ++s|z :) w++ c\n').map(f => f.at), [8, 23]);
        assert.deepStrictEqual(placed(md, 'see http://e.com/ :) and :)\n').map(f => f.at), [18, 25]);
    });
});
