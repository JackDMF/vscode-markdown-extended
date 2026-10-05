import * as assert from 'assert';
import { Mark, Node } from 'prosemirror-model';
import { domAttrsOf, joinAttrs, normalizedLiteral, parseAttrsLiteral, sameAttrs, withoutId } from '../../../src/editor/attrs';
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

    test('the editor draws no event handler and nothing that changes how an element is edited', () => {
        assert.deepStrictEqual(domAttrsOf('{onclick="x()" contenteditable=true .ok tabindex=1}'), { class: 'ok' });
    });

    test('a literal without its id gives every other attribute the plugin read, and nothing when the id was all', () => {
        for (const [literal, kept] of [
            ['{.wide #w}', '{.wide}'], ['{#w}', null], ['{id=w}', null], ['{#x .a style="color:red"}', '{.a style=color:red}'],
            ['{.a}', '{.a}'], ['{ .spaced  #id }', '{.spaced}'], ['{title="a b" #x}', '{title="a b"}'], ['{.a}}', '{.a}}'],
        ] as [string, string | null][]) {
            assert.strictEqual(withoutId(literal), kept, literal);
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
            const normalized = normalizedLiteral(pairs);
            assert.ok(sameAttrs(joinAttrs(parseAttrsLiteral(normalized) ?? []), pairs), `${literal} → ${normalized}`);
        }
        assert.strictEqual(normalizedLiteral(joinAttrs(parseAttrsLiteral('{#x .a .b key="v"}') ?? [])), '{#x .a .b key=v}');
    });

    test('a value the plugin would not read back bare is quoted, and the form reads as the attributes it was made from', () => {
        const literals = [
            '{title="a{b" #w}', '{title="a}b" #w}', '{title="a{b}"}', "{title='x'}", "{k='a b'}", '{data-x="a\\"b"}', '{k="\\"q\\""}',
            '{k="a=b"}', '{k=a=b}', '{k="a b=c"}', '{title="a b" .c #w}', '{k=""}', '{k=a\\}', '{k="x\\\\"}', '{class=".m"}', '{.a=b}',
            '{id="a b" .c}', '{#w title="x{y" key="z}" .c .d}',
        ];
        for (const literal of literals) {
            const pairs = parseAttrsLiteral(literal);
            assert.ok(pairs, `the port accepts ${literal}`);
            const normalized = normalizedLiteral(joinAttrs(pairs));
            assert.ok(sameAttrs(joinAttrs(parseAttrsLiteral(normalized) ?? []), joinAttrs(pairs)), `${literal} → ${normalized}: read back as the port reads it`);
            assert.ok(sameAttrs(attrsOfFirst(md.renderInline(`[x]${normalized}`), 'span'), attrsOfFirst(md.renderInline(`[x]${literal}`), 'span')), `${literal} → ${normalized}: and as the plugin does`);
            const kept = withoutId(literal);
            const rest = joinAttrs(pairs).filter(([n]) => n !== 'id');
            assert.deepStrictEqual(joinAttrs(kept === null ? [] : parseAttrsLiteral(kept) ?? []), rest, `${literal} → ${kept}: without its id`);
        }
    });

    test('a value no literal can hold is written so that it stays an attribute list', () => {
        // A trailing backslash would escape the closing quote: it is doubled, and a bare `"` is escaped.
        assert.ok(parseAttrsLiteral(normalizedLiteral([['k', 'a{b\\']])), 'a trailing backslash');
        assert.ok(parseAttrsLiteral(normalizedLiteral([['k', 'a"b']])), 'a bare quote');
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
