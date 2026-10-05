import * as assert from 'assert';
import { Mark, Node } from 'prosemirror-model';
import { domAttrsOf, joinAttrs, normalizedLiteral, parseAttrsLiteral, readsAsOneText, sameAttrs, withoutId } from '../../../src/editor/attrs';
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
     * The smallest source in which the host's engine — the preview's — reads a
     * literal on each element a copy keeps one on, and the token it gives it to.
     */
    const HOST_SHAPES: Record<string, [(literal: string) => string, string]> = {
        paragraph: [l => `Text. ${l}`, 'paragraph_open'],
        heading: [l => `# Head ${l}`, 'heading_open'],
        'list_item': [l => `- one ${l}\n- two`, 'list_item_open'],
        span: [l => `A [x]${l} b.`, 'span_open'],
    };
    /** The attributes the host's engine gives `holder` for `literal`, or `null` when any of it is left as text. */
    const hostRead = (literal: string, holder: string): [string, string][] | null => {
        const [source, type] = HOST_SHAPES[holder];
        const all = md.parse(source(literal), {}).flatMap(t => [t, ...(t.children ?? [])]);
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
            '{id=w .c}', '{#w #v .c}', '{k= #w}', '{class=".x" #w}', '{.c}', '{ .c }', '{key="v"}', '{title="#x" .c #w}', '{k="a_b_ c" #w}',
        ];
        // The rest of these holds a value with a space and a `"`: no literal reads back as it, so a copy has none.
        const unwritable = new Set(['{title="a "b"" #w}']);
        for (const literal of literals) {
            const pairs = parseAttrsLiteral(literal);
            assert.ok(pairs, `the port accepts ${literal}`);
            for (const holder of Object.keys(HOST_SHAPES)) {
                const original = hostRead(literal, holder);
                const kept = withoutId(literal, holder);
                const where = `${literal} on a ${holder} → ${kept}`;
                if (pairs.every(([n]) => n !== 'id')) {
                    assert.strictEqual(kept, literal, `${where}: a literal with no id is kept byte for byte`);
                } else if (original === null) {
                    // After a span the plugin cuts at the first `}`: the original is text there, and so would a copy be.
                    assert.strictEqual(kept, null, `${where}: the preview shows the original as text there`);
                } else if (kept === null) {
                    assert.ok(unwritable.has(literal) || original.every(([n]) => n === 'id'), `${where}: dropped only when nothing else is left or nothing reads back`);
                } else {
                    assert.ok(!kept.includes('\\'), `${where}: nothing is escaped`);
                    const read = hostRead(kept, holder);
                    assert.ok(read !== null, `${where}: the preview reads the copy's literal as attributes`);
                    assert.ok(sameAttrs(read, original.filter(([n]) => n !== 'id')), `${where}: as the original's, less the id`);
                }
            }
        }
        for (const [literal, kept] of [
            ['{title="a{b" #w}', '{title="a{b"}'], ['{k=a"b" #w}', '{k=a"b"}'], ['{class=".x" #w}', '{class=.x}'], ['{k= #w}', '{k=""}'],
            ['{id=w .c}', '{.c}'], ['{k=1 k=2 #w}', '{k=1 k=2}'], ['{title="a "b"" #w}', null],
        ] as [string, string | null][]) {
            assert.strictEqual(withoutId(literal, 'paragraph'), kept, literal);
        }
    });

    test('a literal the preview shows as text is none to the editor: the port refuses what the engine leaves in pieces', () => {
        for (const literal of [
            '{k="a\\"b" #w}', '{data-x="a\\"b"}', '{k="\\"q\\""}', '{k=a\\ #w}', '{k=a\\}', '{k="x\\\\"}', '{k="a\\b" #w}',
            '{title="a b*c*" #w}', '{k="<b>" #w}', '{k="a&amp;b" #w}', '{k="a&amp;b"}', '{k="a`b`c d" #w}', '{k="a^b^" #w}',
            '{k="==m==" #w}', '{href="http://x.org" #w}',
        ]) {
            assert.strictEqual(parseAttrsLiteral(literal), null, `the port refuses ${literal}`);
            assert.strictEqual(readsAsOneText(literal), false, literal);
            assert.deepStrictEqual(domAttrsOf(literal), {}, `${literal}: the editor draws nothing of it`);
            for (const holder of Object.keys(HOST_SHAPES)) {
                assert.strictEqual(hostRead(literal, holder), null, `${literal} on a ${holder}: the host shows it as text`);
                assert.strictEqual(withoutId(literal, holder), literal, `${literal} on a ${holder}: a copy keeps the text as it is`);
            }
        }
    });

    test('no value is written with a backslash, and one that needs quotes and holds a quote is not written at all', () => {
        assert.strictEqual(normalizedLiteral([['k', 'a"b']]), '{k=a"b}');
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
