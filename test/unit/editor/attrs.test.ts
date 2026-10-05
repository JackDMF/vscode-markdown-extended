import * as assert from 'assert';
import { Mark, Node } from 'prosemirror-model';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { attrsReadAt, domAttrsOf, endLiteralOf, joinAttrs, normalizedLiteral, parseAttrsLiteral, sameAttrs, withoutId } from '../../../src/editor/attrs';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { createEditorEngine } from '../../../src/editor/engine';
import { DEFAULT_INLINE_ENGINE, currentInlineDefinition, definitionOf, setCurrentInlineDefinition } from '../../../src/editor/inlineEngine';
import { parseDocument } from '../../../src/editor/parse';
import { serializeDocument } from '../../../src/editor/serialize';
import { literalRefusal } from '../../../src/editor/webview/objects';
import { plugins } from '../../../src/plugin/plugins';
import { hostEngine, topChildren, touched } from './helpers';

/** The attributes of the first `<tag …>` in `html`, in order. */
function attrsOfFirst(html: string, tag: string): [string, string][] {
    const m = new RegExp(`<${tag}((?:\\s+[^\\s=>]+(?:="[^"]*")?)*)\\s*>`).exec(html);
    assert.ok(m, `no <${tag}> in ${html}`);
    return Array.from(m[1].matchAll(/([^\s=]+)(?:="([^"]*)")?/g), a => [a[1], (a[2] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')] as [string, string]);
}

function spanMarks(node: Node): Mark[] {
    const found: Mark[] = [];
    node.descendants(child => {
        for (const mark of child.marks) {
            if (mark.type.name === 'attr_span' && !found.some(m => m.eq(mark))) {
                found.push(mark);
            }
        }
    });
    return found;
}

/**
 * markdown-it-attrs' `{…}` literal, as the editor reads it without the engine
 * (`attrs.ts`): the port is held to the plugin by rendering each literal through
 * the real engine, and the literal a span or a block was written with is
 * recovered from the source verbatim.
 */
suite('Editor attribute literals: the port reads a literal as the plugin does', () => {
    const md = hostEngine();

    for (const literal of [
        '{.a}', '{.a .b}', '{#x}', '{#x .a style="color:red"}', '{class="a b"}', '{.a class="b"}', '{data-x=1 .c}',
        '{ .spaced  #id }', '{title="with } brace"}', '{..module}', '{lang=de dir=rtl}', '{a}',
    ]) {
        test(`[x]${literal} renders a span with the attributes the port gives`, () => {
            const html = md.renderInline(`[x]${literal}`);
            assert.ok(html.startsWith('<span'), html);
            const rendered = attrsOfFirst(html, 'span');
            const pairs = parseAttrsLiteral(literal);
            assert.ok(pairs, `the port accepts ${literal}`);
            assert.deepStrictEqual(joinAttrs(pairs), rendered, 'the same attributes in the same order');
            assert.deepStrictEqual(Object.entries(domAttrsOf(literal)), rendered, 'and the editor draws exactly those');
        });
    }

    test('what the plugin does not take as attributes, the port refuses', () => {
        for (const literal of ['{}', '{.}', '{#}', '{ }', 'x', '{.a', '{.a}}', '{.a}\n']) {
            assert.strictEqual(parseAttrsLiteral(literal), null, JSON.stringify(literal));
        }
    });

    test('a spaced = is no attribute list, to the port as to the preview (qjebbs/vscode-markdown-extended#146)', () => {
        for (const literal of ['{height = 65}', '{a= b}', '{a =b}', '{.c a = b}']) {
            assert.strictEqual(parseAttrsLiteral(literal), null, literal);
            assert.strictEqual(md.render(`text ${literal}`), `<p>text ${literal}</p>\n`, literal);
        }
        assert.deepStrictEqual(parseAttrsLiteral('{title="a = b"}'), [['title', 'a = b']]);
    });

    test('an = inside a value is the value\'s, to the port as to the preview', () => {
        for (const [literal, pairs] of [
            ['{data-h=YQ== .wide}', [['data-h', 'YQ=='], ['class', 'wide']]],
            ['{integrity=sha256-abc= crossorigin=anonymous}', [['integrity', 'sha256-abc='], ['crossorigin', 'anonymous']]],
        ] as const) {
            assert.deepStrictEqual(parseAttrsLiteral(literal), pairs, literal);
            const html = md.render(`text ${literal}`);
            assert.ok(!html.includes('{'), html);
        }
    });

    // `taken`: the port finds an end literal, and the engine renders the
    // paragraph's text without it. The escaped and the entity forms are what
    // the editor writes for a changed paragraph, and must stay text too.
    for (const [text, taken] of [
        ['@{height = 65}', false], ['a {b = c}', false], ['\\@{height = 65}', false], ['\\${VAR = 1}', false], ['&amp;{x = 1}', false],
        ['text {.a}', true], ['{.a}', true], ['**b**{.a}', true], ['`c`{.a}', true], ['[l](u){.a}', true], ['==m=={.a}', true],
        ['x{.a}', true], ['@{height=65}', true],
    ] as const) {
        test(`${text} ends in a literal ${taken ? 'as' : 'neither for the port nor for'} the plugin`, () => {
            const literal = endLiteralOf(text);
            assert.strictEqual(literal !== null, taken);
            const html = md.render(`${text}\n`);
            assert.strictEqual(!html.includes('}'), taken, html);
        });
    }

    test('the editor draws no event handler and nothing that changes how an element is edited', () => {
        assert.deepStrictEqual(domAttrsOf('{onclick="x()" contenteditable=true .ok tabindex=1}'), { class: 'ok' });
    });

    test('a literal without its id gives every other attribute the plugin read, and nothing when the id was all', () => {
        for (const [literal, kept] of [
            ['{.wide #w}', '{.wide}'], ['{#w}', null], ['{id=w}', null], ['{#x .a style="color:red"}', '{.a style=color:red}'],
            ['{.a}', '{.a}'], ['{ .spaced  #id }', '{.spaced}'], ['{title="a b" #x}', '{title="a b"}'], ['{.a}}', '{.a}}'],
        ] as [string, string | null][]) {
            assert.strictEqual(withoutId(literal, 'span'), kept, literal);
            const before = parseAttrsLiteral(literal);
            if (before) {
                const rendered = kept === null ? [] : attrsOfFirst(md.renderInline(`[x]${kept}`), 'span');
                assert.deepStrictEqual(rendered, joinAttrs(before).filter(([n]) => n !== 'id'), `${literal}: the plugin reads the rest as it read it`);
            }
        }
    });

    test('the normalized form reads as the same attributes', () => {
        for (const literal of ['{#x .a .b key="v"}', '{class="a b" data-x=1}', '{title="two words" #id}', '{..m .c}']) {
            const pairs = joinAttrs(parseAttrsLiteral(literal) ?? []);
            const normalized = normalizedLiteral(pairs) ?? '';
            assert.ok(sameAttrs(joinAttrs(parseAttrsLiteral(normalized) ?? []), pairs), `${literal} → ${normalized}`);
        }
        assert.strictEqual(normalizedLiteral(joinAttrs(parseAttrsLiteral('{#x .a .b key="v"}') ?? [])), '{#x .a .b key=v}');
    });

    /**
     * A source in which the host's engine — the preview's — reads a literal on
     * each element the editor keeps one on, the token it gives it to, and the
     * node the editor judges it for (`attrsReadAt`). `line` is a paragraph's
     * literal on a line of its own.
     */
    const HOST_SHAPES: Record<string, [(literal: string) => string, string, string]> = {
        paragraph: [l => `Text. ${l}`, 'paragraph_open', 'paragraph'],
        line: [l => `Text.\n${l}`, 'paragraph_open', 'paragraph'],
        heading: [l => `# Head ${l}`, 'heading_open', 'heading'],
        'list_item': [l => `- one ${l}\n- two`, 'list_item_open', 'list_item'],
        span: [l => `A [x]${l} b.`, 'span_open', 'span'],
        fence: [l => `\`\`\`js ${l}\ncode\n\`\`\``, 'fence', 'code_block'],
        table: [l => `| a |\n| - |\n| b |\n\n${l}`, 'table_open', 'table'],
        hr: [l => `Intro.\n\n--- ${l}`, 'hr', 'horizontal_rule'],
        quote: [l => `> q\n> ${l}`, 'blockquote_open', 'blockquote'],
    };
    /** The shapes whose literal markdown-it-attrs reads off raw text: a fence's info string, the paragraph under a table. */
    const RAW_TEXT = new Set(['fence', 'table']);
    /** The attributes the host's engine gives the token of `shape` for `literal`, or `null` when any of it is left as text. */
    const hostRead = (literal: string, shape: string, engine = md): [string, string][] | null => {
        const [source, type] = HOST_SHAPES[shape];
        const all = engine.parse(source(literal), {}).flatMap(t => [t, ...(t.children ?? [])]);
        if (all.some(t => t.type === 'text' && /[{}]/.test(t.content))) {
            return null;
        }
        const token = all.find(t => t.type === type);
        return (token?.attrs ?? []).map(([n, v]) => [n, v] as [string, string]);
    };

    test('a copy\'s literal reads in the preview as the original\'s attributes minus the id, on every block, or is dropped', () => {
        const literals = [
            '{title="a{b" #w}', '{title="a}b" #w}', '{title="a{b}"}', "{title='x'}", "{k='a b'}", '{k="a=b"}', '{k=a=b}', '{k="a b=c"}',
            '{title="a b" .c #w}', '{k=""}', '{class=".m"}', '{.a=b}', '{id="a b" .c}', '{#w title="x{y" key="z}" .c .d}',
            '{k=a"b" #w}', '{k=a"b" c #w}', '{title="a "b"" #w}', '{title="é ü" #w}', '{title=日本 #w}', '{class="" #w}', '{k=1 k=2 #w}',
            '{id=w .c}', '{#w #v .c}', '{class=".x" #w}', '{.c}', '{ .c }', '{key="v"}', '{title="#x" .c #w}', '{k="a_b_ c" #w}',
        ];
        // The rest of these holds a value with a space and a `"`: no literal reads back as it, so a copy has none.
        const unwritable = new Set(['{title="a "b"" #w}']);
        // A space beside the `=` that separates a key makes a brace the text's own (`isTextBrace`): no literal to copy.
        assert.strictEqual(parseAttrsLiteral('{k= #w}'), null, 'a text brace');
        for (const literal of literals) {
            const pairs = parseAttrsLiteral(literal);
            assert.ok(pairs, `the port accepts ${literal}`);
            for (const [shape, [, , holder]] of Object.entries(HOST_SHAPES)) {
                const original = hostRead(literal, shape);
                const kept = withoutId(literal, holder);
                const where = `${literal} on a ${shape} → ${kept}`;
                if (pairs.every(([n]) => n !== 'id')) {
                    assert.strictEqual(kept, literal, `${where}: a literal with no id is kept byte for byte`);
                } else if (original === null) {
                    // After a span the plugin cuts at the first `}`: the original is text there, and so would a copy be.
                    assert.strictEqual(kept, null, `${where}: the preview shows the original as text there`);
                } else if (kept === null) {
                    // After a rule the plugin reads from the last `{`: other attributes than the literal says, which no node holds.
                    const readAsWritten = sameAttrs(original, joinAttrs(pairs));
                    assert.ok(unwritable.has(literal) || original.every(([n]) => n === 'id') || !readAsWritten, `${where}: dropped only when nothing else is left or nothing reads back`);
                } else {
                    assert.ok(!kept.includes('\\'), `${where}: nothing is escaped`);
                    const read = hostRead(kept, shape);
                    assert.ok(read !== null, `${where}: the preview reads the copy's literal as attributes`);
                    assert.ok(sameAttrs(read, original.filter(([n]) => n !== 'id')), `${where}: as the original's, less the id`);
                }
            }
        }
        for (const [literal, kept] of [
            ['{title="a{b" #w}', '{title="a{b"}'], ['{k=a"b" #w}', '{k=a"b"}'], ['{class=".x" #w}', '{class=.x}'],
            // A text brace (`isTextBrace`) parses as no literal, and is returned as it is.
            ['{k= #w}', '{k= #w}'],
            ['{id=w .c}', '{.c}'], ['{k=1 k=2 #w}', '{k=1 k=2}'], ['{title="a "b"" #w}', null],
        ] as [string, string | null][]) {
            assert.strictEqual(withoutId(literal, 'paragraph'), kept, literal);
        }
    });

    test('a literal is judged where the preview reads it: text where the inline rules cut it, attributes off a fence\'s info and under a table', () => {
        for (const literal of [
            '{k="a\\"b" #w}', '{data-x="a\\"b"}', '{k="\\"q\\""}', '{k=a\\ #w}', '{k=a\\}', '{k="x\\\\"}', '{k="a\\b" #w}',
            '{title="a b*c*" #w}', '{k="<b>" #w}', '{k="a&amp;b" #w}', '{k="a&amp;b"}', '{k="a`b`c d" #w}', '{k="a^b^" #w}',
            '{k="==m==" #w}', '{href="http://x.org" #w}', '{title="C:\\x"}', '{title="__init__.py"}', '{title="[[Ctrl]]"}',
            '{data-u=http://x.org}', '{title="a *b*"}',
        ]) {
            const pairs = parseAttrsLiteral(literal);
            assert.ok(pairs, `the port parses ${literal}; where it is read is not its question`);
            for (const [shape, [, , holder]] of Object.entries(HOST_SHAPES)) {
                const host = hostRead(literal, shape);
                const at = attrsReadAt(literal, holder);
                if (shape === 'fence' && literal.includes('`')) {
                    // A backtick fence's info holds no backtick: the line opens no fence at all.
                    continue;
                }
                if (RAW_TEXT.has(shape)) {
                    assert.ok(host !== null && sameAttrs(host, joinAttrs(pairs)), `${literal} on a ${shape}: the host reads it off raw text`);
                    assert.ok(at !== null && sameAttrs(at, host), `${literal} on a ${shape}: and so does the editor`);
                    assert.strictEqual(literalRefusal(literal, holder), null, `${literal} on a ${shape}: the Attributes field takes it`);
                } else {
                    assert.strictEqual(host, null, `${literal} on a ${shape}: the host shows it as text`);
                    assert.strictEqual(at, null, `${literal} on a ${shape}: the editor takes it for none`);
                    assert.match(literalRefusal(literal, holder) ?? '', /the preview would show it as text/, `${literal} on a ${shape}: the field refuses it, with the reason`);
                    const kept = pairs.some(([n]) => n === 'id') ? null : literal;
                    assert.strictEqual(withoutId(literal, holder), kept, `${literal} on a ${shape}: a copy carries no id the preview does not read`);
                }
            }
        }
    });

    test('the host\'s parse keeps a literal exactly where the host\'s engine reads it as written, in every block, under any settings', () => {
        const corpus = [
            '{.c}', '{#id-1}', '{k=a_b}', '{title="a -- b"}', '{title="(c) (tm)"}', "{title='it\\'s'}", '{data-x=1:2}', '{title=":smile:"}',
            '{title="[[Ctrl]]"}', '{href=www.x.com}', '{data-u=http://x.org}', '{title="see http://x.org"}', '{title="mail a@b.de"}',
            '{k=a*b}', '{title="a *b*"}', '{title="a **b**"}', '{title="a ~~b~~"}', '{title="a ~b~"}', '{title="a ^b^"}', '{title="a ==b=="}',
            '{title="a&b"}', '{title="a&amp;b"}', '{title="a < b"}', '{title="<b>"}', '{title="C:\\x"}', '{title="a\\b"}', '{title="50%"}',
            '{title="a $b$"}', '{title="[b](c)"}', '{title="![i](s)"}', '{style="color: red;"}', '{.a .b #c}', '{#REQ-1 .unnumbered}',
            '{title="Übersicht – Teil 2"}', '{title="a | b"}', '{title="__init__.py"}', '{title=_a_}', '{title="*.ts"}', '{title="a{b"}',
            '{title="a}b"}', '{k="a=b"}', '{title="H~2~O"}', '{title="x^2^"}', '{.c data-href=https://a.b/c?d=e&f=g}', '{k="a\\"b" #w}',
            '{k=a\\}', '{x\\}', '{k="x\\\\"}', '{k=a"b" #w}', '{title="a b" .c #w}',
            '{title="a`b"}', '{k=a`b}', '{title="a```b"}', '{title="a{b" #h}', '{data-price="$5 - $10"}',
        ];
        const shapes: Record<string, [(l: string) => string, string]> = {
            para: [l => `Text. ${l}\n`, 'paragraph_open'],
            line: [l => `Text.\n${l}\n`, 'paragraph_open'],
            head: [l => `# H ${l}\n`, 'heading_open'],
            item: [l => `- one ${l}\n- two\n`, 'list_item_open'],
            fence: [l => `\`\`\`js ${l}\ncode\n\`\`\`\n`, 'fence'],
            tilde: [l => `~~~js ${l}\ncode\n~~~\n`, 'fence'],
            span: [l => `A [x]${l} b.\n`, 'span_open'],
            hr: [l => `Intro.\n\n--- ${l}\n`, 'hr'],
            table: [l => `| a |\n| - |\n| b |\n\n${l}\n`, 'table_open'],
            quote: [l => `> q\n> ${l}\n`, 'blockquote_open'],
        };
        const engines: [string, MarkdownIt][] = [
            ['the defaults', md],
            ['linkify off', createEditorEngine({ linkify: false, typographer: false, plugins, extend: [] })],
            ['sup, sub, kbd, mark and sidenote off', createEditorEngine({
                linkify: true, typographer: false, extend: [],
                plugins: plugins.filter(p => !['markdown-it-sup-alt', 'markdown-it-sub-alt', 'markdown-it-kbd', 'markdown-it-mark', 'markdown-it-sidenote'].includes(p.name)),
            })],
        ];
        for (const [settings, engine] of engines) {
            for (const literal of corpus) {
                const pairs = parseAttrsLiteral(literal);
                assert.ok(pairs, literal);
                for (const [shape, [source, type]] of Object.entries(shapes)) {
                    const src = source(literal);
                    const all = engine.parse(src, {}).flatMap(t => [t, ...(t.children ?? [])]);
                    const attrs = (all.find(t => t.type === type)?.attrs ?? []).map(([n, v]) => [n, v] as [string, string]);
                    const reads = attrs.length > 0 && !all.some(t => t.type === 'text' && /[{}]/.test(t.content)) && sameAttrs(attrs, joinAttrs(pairs));
                    const kept = groupSourceBlocks(engine.parse(src, {}), splitLines(src), definitionOf(engine)).blocks
                        .some(b => b.attrs?.suffix === literal || b.spanLiterals.includes(literal) || b.itemLiterals.includes(literal));
                    const where = `${literal} in a ${shape}, ${settings}`;
                    assert.strictEqual(kept, reads, `${where}: ${reads ? 'the host reads it, the editor must keep it' : 'the host shows it as text, the editor must not take it'}`);
                }
            }
        }
        // What stands before a literal on its line: markdown-it-attrs reads the last text token, so a `"`
        // in another token (an escaped delimiter splits them) opens no quote; one in the same token does.
        // And a line the wrap left a literal alone on, or a `"` on, is read so too.
        const lines: string[] = [];
        for (const [plain, escaped] of [['* b', '\\* b'], ['_b', '\\_b'], ['~ b', '\\~ b'], ['== b', '\\== b'], ['^ b', '\\^ b'], [', 3* b', ', 3\\* b']]) {
            lines.push(`A 5" display ${plain} {.spec}\n`, `A 5" display ${escaped} {.spec}\n`, `- A 5" display ${escaped} {.spec}\n- two\n`, `# A 5" display ${escaped} {.spec}\n`);
        }
        lines.push(
            'Both screens ship this year: the 5" and 7" models {.spec}\n', 'Both screens ship this year: the 5" and\n7" models {.spec}\n',
            'Both screens ship this year: the 5" and "seven" {.spec}\n', 'Both screens ship this year: the 5" and\n"seven" {.spec}\n',
            'Both screens ship this year: the 5" and\n"seven"\n{.spec}\n', '# Size [w]{.wide} of 5"$x$5" {#spec}\n',
        );
        for (const [settings, engine] of engines) {
            for (const src of lines) {
                const reads = engine.parse(src, {}).some(t => (t.type === 'paragraph_open' || t.type === 'list_item_open' || t.type === 'heading_open') && (t.attrs ?? []).some(([n]) => n === 'class' || (n === 'id' && t.type === 'heading_open')));
                const kept = groupSourceBlocks(engine.parse(src, {}), splitLines(src), definitionOf(engine)).blocks
                    .some(b => (b.attrs?.suffix ?? '').endsWith('spec}') || b.itemLiterals.includes('{.spec}'));
                assert.strictEqual(kept, reads, `${JSON.stringify(src)}, ${settings}: ${reads ? 'the host reads it, the editor must keep it' : 'the host shows it as text, the editor must not take it'}`);
            }
        }
        const paragraph = topChildren(parseDocument(engines[1][1], 'Text. {data-u=http://x.org}\n').doc)[0];
        assert.strictEqual(paragraph.attrs.attrsSuffix, '{data-u=http://x.org}', 'the parse judges with the engine that read the file, linkify off');
    });

    test('with VS Code\'s math on, a $…$ in a literal is text wherever the inline rules read it', () => {
        const plain = { ...DEFAULT_INLINE_ENGINE, plugins: DEFAULT_INLINE_ENGINE.plugins.filter(p => p.name !== 'markdown-it-sidenote') };
        const math = { ...plain, math: true };
        for (const literal of ['{title="a $b$"}', '{data-f=$x$ .c}']) {
            for (const holder of ['paragraph', 'heading', 'list_item', 'span', 'blockquote', 'bullet_list', 'horizontal_rule']) {
                assert.ok(attrsReadAt(literal, holder, plain), `${literal} on a ${holder}: without math the plugin reads it`);
                assert.strictEqual(attrsReadAt(literal, holder, math), null, `${literal} on a ${holder}: math reads $…$ first`);
            }
            for (const holder of ['code_block', 'table']) {
                assert.ok(attrsReadAt(literal, holder, math), `${literal} on a ${holder}: read off raw text, math or not`);
            }
        }
        const before = currentInlineDefinition();
        try {
            setCurrentInlineDefinition(math);
            assert.match(literalRefusal('{title="a $b$"}') ?? '', /math/);
            assert.strictEqual(literalRefusal('{title="a $b$"}', 'code_block'), null);
        } finally {
            setCurrentInlineDefinition(before);
        }
    });

    test('a malformed literal is refused as no attribute list, whatever it holds', () => {
        for (const literal of ['{.}', '{ }', 'x', '{.a}}']) {
            assert.match(literalRefusal(literal) ?? '', /is no attribute list/, literal);
        }
        // One whose `}` stands inside a quote it never closes is named as unclosed.
        assert.match(literalRefusal('{k="a\\"b') ?? '', /is not closed/);
    });

    test('no value is written with a backslash, and one that needs quotes and holds a quote is not written at all', () => {
        assert.strictEqual(normalizedLiteral([['k', 'a"b']]), null, 'an odd quote in a bare value opens a quote past the }');
        assert.strictEqual(normalizedLiteral([['k', 'a"b"']]), '{k=a"b"}');
        assert.strictEqual(normalizedLiteral([['k', 'a"b c']]), null, 'a space and a quote');
        assert.strictEqual(normalizedLiteral([['k', '"a']]), null, 'a quote first would open one');
        assert.strictEqual(normalizedLiteral([['k', 'a{b\\']]), null, 'a trailing backslash');
        assert.strictEqual(normalizedLiteral([['k', 'a\\b']]), null, 'a backslash');
        assert.strictEqual(normalizedLiteral([['id', 'a\\b']]), null, 'an id with a backslash');
    });
});

suite('Editor attribute spans: the literal is recovered from the source', () => {
    const md = hostEngine();
    const paragraph = (source: string) => topChildren(parseDocument(md, source).doc)[0];

    for (const literal of ['{.a}', '{class="a b"}', '{#x .a style="color:red"}']) {
        test(`[word]${literal} is a span whose literal is ${literal}, written back verbatim when the paragraph changes`, () => {
            const source = `Some [word]${literal} here.\n`;
            const p = paragraph(source);
            assert.strictEqual(p.type.name, 'paragraph');
            assert.deepStrictEqual(spanMarks(p).map(m => m.attrs.literal), [literal]);
            const parsed = parseDocument(md, source);
            const doc = parsed.doc.type.create(null, [touched(p)]);
            assert.strictEqual(serializeDocument({ ...parsed, doc }, { defaultWrap: 90 }), source);
        });
    }

    test('a paragraph ending in a brace of its own text keeps it as text, its braces written back unescaped', () => {
        // `@` is escaped when a changed paragraph is written, for the sidebars'
        // sake; the escaped form is what the preview then reads.
        for (const [source, written] of [
            ['Set it to {height = 65}\n', 'Set it to {height = 65}\n'],
            ['Set it to @{height = 65}\n', 'Set it to \\@{height = 65}\n'],
        ]) {
            const p = paragraph(source);
            assert.strictEqual(p.type.name, 'paragraph', source);
            assert.strictEqual(p.attrs.attrsSuffix, null, source);
            assert.strictEqual(p.textContent, source.trim());
            const parsed = parseDocument(md, source);
            const doc = parsed.doc.type.create(null, [touched(p)]);
            assert.strictEqual(serializeDocument({ ...parsed, doc }, { defaultWrap: 90 }), written);
            assert.strictEqual(md.render(written), `<p>${source.trim()}</p>\n`, 'and the preview shows it whole');
            assert.strictEqual(paragraph(written).textContent, source.trim(), 'and the editor reads it back');
        }
    });

    test('a heading ending in a text brace, given an id by another extension, writes the brace once', () => {
        // Another extension's extendMarkdownIt giving every heading an id (engine.ts).
        const withIds = hostEngine([m => {
            m.core.ruler.push('test_heading_ids', state => {
                state.tokens.filter(t => t.type === 'heading_open').forEach(t => t.attrSet('id', 'given'));
                return true;
            });
        }]);
        const source = '## Title {a = b}\n';
        const parsed = parseDocument(withIds, source);
        const heading = topChildren(parsed.doc)[0];
        // The id is on no literal the line holds, so the heading stays a source block, written as it is.
        assert.strictEqual(heading.type.name, 'raw_block');
        assert.strictEqual(serializeDocument(parsed, { defaultWrap: 90 }), source);
    });

    test('a bracketed span whose literal is text is an editable paragraph of that text', () => {
        const p = paragraph('A [x]{a = b} c.\n');
        assert.strictEqual(p.type.name, 'paragraph');
        assert.strictEqual(p.textContent, 'A [x]{a = b} c.');
        assert.deepStrictEqual(spanMarks(p), []);
    });

    test('a paragraph ending in a literal after a text brace keeps both, written back byte for byte', () => {
        const source = 'x {y = {a=b}\n';
        const p = paragraph(source);
        assert.deepStrictEqual([p.type.name, p.attrs.attrsSuffix, p.textContent], ['paragraph', '{a=b}', 'x {y =']);
        const parsed = parseDocument(md, source);
        const doc = parsed.doc.type.create(null, [touched(p)]);
        assert.strictEqual(serializeDocument({ ...parsed, doc }, { defaultWrap: 90 }), source);
    });

    test('an admonition whose only extra is a text brace is an admonition of that type', () => {
        const node = paragraph('!!! note {a = b} "T"\n    Body.\n');
        assert.deepStrictEqual([node.type.name, node.attrs.type], ['admonition', 'note']);
    });

    test('a normalized literal quotes a value holding =', () => {
        assert.strictEqual(normalizedLiteral([['k', 'v='], ['class', 'y']]), '{k="v=" .y}');
        assert.ok(sameAttrs(joinAttrs(parseAttrsLiteral('{k="v=" .y}') ?? []), [['k', 'v='], ['class', 'y']]));
    });

    test('two spans in one paragraph each keep their own literal, in order', () => {
        const p = paragraph('A [one]{ .x  #first } and [two]{.x} and [three]{data-n="3"}.\n');
        assert.deepStrictEqual(spanMarks(p).map(m => m.attrs.literal), ['{ .x  #first }', '{.x}', '{data-n="3"}']);
    });

    test('a ]{…} that reads as other attributes (in a code span) is passed over', () => {
        const p = paragraph('Code `a]{.y}` then [b]{.z}.\n');
        assert.deepStrictEqual(spanMarks(p).map(m => m.attrs.literal), ['{.z}']);
    });

    test('a span in a note is rich text; one whose literal holds a note marker stays a source block', () => {
        assert.strictEqual(paragraph('Text ++ref|a [b]{.c} body++ end.\n').type.name, 'paragraph');
        assert.strictEqual(paragraph('Text ++ref|a [b]{title="x|y"} body++ end.\n').type.name, 'raw_block');
    });

    test('a bracketed span with no attributes, and a span inside a span, stay source blocks', () => {
        assert.strictEqual(paragraph('A [b]{ } c.\n').type.name, 'raw_block');
        assert.strictEqual(paragraph('A [[b]{.x} c]{.y} d.\n').type.name, 'raw_block');
    });

    test('the span is drawn with the attributes the engine renders, inside the paragraph', () => {
        const source = 'A [styled]{#s1 .accent style="color: red"} word.';
        const html = md.renderInline(source);
        const p = paragraph(`${source}\n`);
        const mark = spanMarks(p)[0];
        const spec = mark.type.spec.toDOM?.(mark, true) as unknown as [string, Record<string, string>];
        const drawn = Object.entries(spec[1]).filter(([n]) => !n.startsWith('data-mep-'));
        assert.strictEqual(spec[0], 'span');
        assert.deepStrictEqual(drawn, attrsOfFirst(html, 'span'));
    });
});
