import * as assert from 'assert';
import { Mark, Node } from 'prosemirror-model';
import { domAttrsOf, endLiteralOf, joinAttrs, normalizedLiteral, parseAttrsLiteral, sameAttrs } from '../../../src/editor/attrs';
import { parseDocument } from '../../../src/editor/parse';
import { serializeDocument } from '../../../src/editor/serialize';
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

    test('the normalized form reads as the same attributes', () => {
        for (const literal of ['{#x .a .b key="v"}', '{class="a b" data-x=1}', '{title="two words" #id}', '{..m .c}']) {
            const pairs = joinAttrs(parseAttrsLiteral(literal) ?? []);
            const normalized = normalizedLiteral(pairs);
            assert.ok(sameAttrs(joinAttrs(parseAttrsLiteral(normalized) ?? []), pairs), `${literal} → ${normalized}`);
        }
        assert.strictEqual(normalizedLiteral(joinAttrs(parseAttrsLiteral('{#x .a .b key="v"}') ?? [])), '{#x .a .b key=v}');
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
