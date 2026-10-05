import * as assert from 'assert';
import * as vscode from 'vscode';
import MarkdownItStatic = require('markdown-it');
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import { MarkdownIt, Token } from '../../../src/@types/markdown-it';
import { attrsReadAt, joinAttrs, parseAttrsLiteral, sameAttrs } from '../../../src/editor/attrs';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { DEFAULT_INLINE_ENGINE, createInlineEngine, definitionOf, inlineEngineDefinition } from '../../../src/editor/inlineEngine';
import { useMathStandIn } from '../../../src/editor/mathStandIn';
import { parseDocument } from '../../../src/editor/parse';
import { literalLostReason, literalRewritten, serializeDocument, setInlineEngine } from '../../../src/editor/serialize';
import { editorSchema } from '../../../src/editor/schema';
import { noteRefusal } from '../../../src/editor/webview/notes';
import {
    LITERAL_READ_WITH_BLOCK_REFUSAL, attributesTargetAt, commitAttributes, literalAlreadyLostRefusal, literalRefusal, spanLiteralRefusal,
} from '../../../src/editor/webview/objects';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine, topChildren } from './helpers';

type MathApi = { extendMarkdownIt(md: MarkdownIt): MarkdownIt };

/** VS Code's own math extension, activated as VS Code ships it (`markdown.math.enabled` on). */
async function realMath(): Promise<(md: MarkdownIt) => MarkdownIt> {
    const math = vscode.extensions.getExtension<MathApi>('vscode.markdown-math');
    assert.ok(math, 'VS Code ships its math extension');
    const api = await math.activate();
    return md => api.extendMarkdownIt(md);
}

/** Every token, children after their parent, as the facts the stand-in must reproduce. */
function stream(tokens: readonly Token[]): string {
    return tokens.flatMap(t => [t, ...(t.children ?? [])]).map(t => [t.type, t.content, t.markup, t.map?.join(',') ?? ''].join('|')).join('\n');
}

/** The math tokens read, in order. */
function mathOf(tokens: readonly Token[]): string {
    return tokens.flatMap(t => [t, ...(t.children ?? [])]).filter(t => t.type.startsWith('math')).map(t => `${t.type}:${t.content}`).join(' ');
}

/** `count` strings of up to 14 pieces from an alphabet of `$` and what stands around one, the same on every run. */
function dollarStrings(count: number): string[] {
    const pieces = ['$', '$', '$', '$$', 'a', '1', ' ', '\\', '{', '}', '"', '=', '<b>', '<i x="1">', '\n', '\n\n', '`', '*', 'x', '.', '-', '> ', '- ', '_', '\t', 'é', '€'];
    let seed = 17;
    const next = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % n;
    };
    const out = ['$x$', '$5 - $10', 'US$ 5 and US$ 6', '$a$b', '$$', 'a$ b$', '\\$x$', '$x\\$', '$$x$$', 'a $$x$$ b', '$$\nx\n$$', '<span class="a">$x$</span>', '$ a $'];
    for (let i = 0; i < count; i++) {
        let s = '';
        const length = 1 + next(14);
        for (let k = 0; k < length; k++) {
            s += pieces[next(pieces.length)];
        }
        out.push(s);
    }
    return out;
}

suite('Editor math: the page reads $ as VS Code\'s math does', () => {
    let extend: (md: MarkdownIt) => MarkdownIt;
    suiteSetup(async function () {
        this.timeout(30000);
        extend = await realMath();
    });
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));

    test('the stand-in tokenizes as VS Code\'s markdown-math over a fuzzed corpus of $ strings, alone and in the editor\'s engines', function () {
        this.timeout(60000);
        const real = extend(MarkdownItStatic({ html: true }) as unknown as MarkdownIt);
        const standIn = useMathStandIn(MarkdownItStatic({ html: true }) as unknown as MarkdownIt);
        const host = hostEngine([extend]);
        const definition = inlineEngineDefinition(host);
        assert.strictEqual(definition.math, true);
        const page = createInlineEngine(JSON.parse(JSON.stringify(definition)));
        let math = 0;
        const differ: string[] = [];
        for (const s of dollarStrings(20000)) {
            const tokens = real.parse(s, {});
            math += mathOf(tokens) === '' ? 0 : 1;
            if (stream(tokens) !== stream(standIn.parse(s, {}))) {
                differ.push(`markdown-it alone: ${JSON.stringify(s)}`);
            }
            if (mathOf(host.parseInline(s, {})) !== mathOf(page.parseInline(s, {}))) {
                differ.push(`the host's engine and the page's: ${JSON.stringify(s)}`);
            }
        }
        assert.deepStrictEqual(differ.slice(0, 5), [], `${differ.length} strings read otherwise`);
        assert.ok(math > 2000, `the corpus holds math (${math} strings)`);
    });

    test('a literal is text where math reads a $…$ in it, and a literal whose $ math passes over is read', () => {
        const definition = inlineEngineDefinition(hostEngine([extend]));
        for (const holder of ['paragraph', 'heading', 'list_item', 'span', 'blockquote', 'bullet_list', 'horizontal_rule']) {
            for (const literal of ['{data-price="$5 - $10"}', '{title="US$ 5 and US$ 6"}', '{title="$a$b"}', '{title="x$"}', '{title="$$"}']) {
                assert.ok(attrsReadAt(literal, holder, definition), `${literal} on a ${holder}: math passes over its $`);
            }
            for (const literal of ['{title="$x$"}', '{title="$ a $"}', '{.c data-a="$a" data-b="b$"}']) {
                assert.strictEqual(attrsReadAt(literal, holder, definition), null, `${literal} on a ${holder}: math reads $…$ first`);
            }
        }
        const paragraph = topChildren(parseDocument(hostEngine([extend]), 'Text. {data-price="$5 - $10"}\n').doc)[0];
        assert.strictEqual(paragraph.type.name, 'paragraph');
        assert.strictEqual(paragraph.attrs.attrsSuffix, '{data-price="$5 - $10"}', 'the paragraph is editable and keeps it');
        setInlineEngine(definition);
        assert.strictEqual(literalRefusal('{data-price="$5 - $10"}'), null, 'the Attributes field takes it');
    });

    test('the parse keeps a literal holding $ exactly where the host, its math run, reads it', () => {
        const host = hostEngine([extend]);
        const definition = definitionOf(host);
        const literals = [
            '{title="$5 - $10"}', '{data-price="$5 - $10"}', '{title="$5 and $10"}', '{title="$x$"}', '{title="$ a $"}', '{title="a$ b$"}',
            '{title="$a$b"}', '{title="$1$2"}', '{title="$5"}', '{title="x$"}', '{title="$$"}', '{title="cost $5, or $6"}',
            '{.c data-a="$a" data-b="b$"}', '{title="US$ 5 and US$ 6"}', '{title="$$x$$"}', '{k=$x$ .c}',
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
        let read = 0;
        let text = 0;
        for (const literal of literals) {
            const pairs = parseAttrsLiteral(literal);
            assert.ok(pairs, literal);
            for (const [shape, [source, type]] of Object.entries(shapes)) {
                const src = source(literal);
                const all = host.parse(src, {}).flatMap(t => [t, ...(t.children ?? [])]);
                const attrs = (all.find(t => t.type === type)?.attrs ?? []).map(([n, v]) => [n, v] as [string, string]);
                const reads = attrs.length > 0 && !all.some(t => t.type === 'text' && /[{}]/.test(t.content)) && sameAttrs(attrs, joinAttrs(pairs));
                const kept = groupSourceBlocks(host.parse(src, {}), splitLines(src), definition).blocks
                    .some(b => b.attrs?.suffix === literal || b.spanLiterals.includes(literal) || b.itemLiterals.includes(literal));
                assert.strictEqual(kept, reads, `${literal} in a ${shape}: ${reads ? 'the host reads it, the editor must keep it' : 'the host shows it as text, the editor must not take it'}`);
                read += reads ? 1 : 0;
                text += reads ? 0 : 1;
            }
        }
        assert.ok(read > 0 && text > 0, `both kinds met (${read} read, ${text} text)`);
    });

    test('a literal is judged with the block it is written in: two $ in two literals pair as math', () => {
        const host = hostEngine([extend]);
        setInlineEngine(inlineEngineDefinition(host));
        const source = 'A [x]{title="a $b"} c y d.\n';
        let state = EditorState.create({ doc: parseDocument(host, source, {}).doc, plugins: editorPlugins() });
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
        const target = attributesTargetAt(state);
        assert.ok(!('refusal' in target));
        assert.strictEqual(literalRefusal('{title="d$ e"}'), null, 'alone the literal reads');
        assert.deepStrictEqual(commitAttributes(state, target, '{title="d$ e"}'), { refusal: LITERAL_READ_WITH_BLOCK_REFUSAL }, 'with the span, its $ pairs as math');
        const made = commitAttributes(state, target, '{title="d e"}');
        assert.ok(made !== null && 'tr' in made);
        const saved = serializeDocument({ doc: state.apply(made.tr).doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
        const read = host.parse(saved, {}).flatMap(t => [t, ...(t.children ?? [])]).filter(t => (t.attrs ?? []).length > 0).map(t => [t.type, t.attrs]);
        assert.deepStrictEqual(read, [['paragraph_open', [['title', 'd e']]], ['span_open', [['title', 'a $b']]]]);

        // A span's field asks the same of the selection's block.
        const y = posIn(state.doc, 'y');
        const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, y, y + 1)));
        assert.strictEqual(spanLiteralRefusal(selected, '{title="d$ e"}'), LITERAL_READ_WITH_BLOCK_REFUSAL);
        assert.strictEqual(spanLiteralRefusal(selected, '{title="d e"}'), null);

        // Without math the sidebar rule pairs the same two `$` as a left sidebar: the preview reads
        // `$b"} c y d. {title="d$` as one, and the field asks the same engine.
        setInlineEngine(DEFAULT_INLINE_ENGINE);
        let plain = EditorState.create({ doc: parseDocument(hostEngine(), source, {}).doc, plugins: editorPlugins() });
        plain = plain.apply(plain.tr.setSelection(TextSelection.create(plain.doc, 2)));
        const plainTarget = attributesTargetAt(plain);
        assert.ok(!('refusal' in plainTarget));
        assert.match(hostEngine().render('A [x]{title="a $b"} c y d. {title="d$ e"}\n'), /left-sidebar/);
        assert.deepStrictEqual(commitAttributes(plain, plainTarget, '{title="d$ e"}'), { refusal: LITERAL_READ_WITH_BLOCK_REFUSAL });
        assert.ok(commitAttributes(plain, plainTarget, '{title="d e"}') !== null);
    });

    test('the edit filter reads every literal of a textblock it checks with the textblock: an edit that loses one is refused, naming it', () => {
        const host = hostEngine([extend]);
        setInlineEngine(inlineEngineDefinition(host));
        const stateOf = (source: string) => EditorState.create({ doc: parseDocument(host, source, {}).doc, plugins: editorPlugins() });
        const span = '{title="a $b"}';

        // Inline code typed after a span: math reads `$b"} and \`$` and the span is lost.
        const coded = stateOf('[x]{title="a $b"} and Q\n');
        const q = posIn(coded.doc, 'Q', '');
        const code = coded.tr.replaceWith(q, q + 1, editorSchema.text('$(pwd)', [editorSchema.marks.code.create()]));
        assert.strictEqual(noteRefusal(code), literalLostReason({ literal: span }));
        assert.ok(noteRefusal(code)?.includes(span));
        assert.ok(coded.apply(code).doc === coded.doc, 'the filter drops it');

        // A span pasted before a paragraph's own literal: their two `$` pair as math, and both are lost.
        const para = stateOf('Para {title="d$ e"}\n');
        const pasted = para.tr.insert(1, [editorSchema.text('x', [editorSchema.marks.attr_span.create({ literal: span })]), editorSchema.text(' ')]);
        assert.strictEqual(noteRefusal(pasted), literalLostReason({ literal: span }));
        assert.ok(para.apply(pasted).doc === para.doc, 'the filter drops it');

        // Prose `$` beside a literal is written escaped and reads as text: typed, applied, and every literal kept.
        for (const [source, typed, expected] of [
            ['[x]{title="a $b"} costs Q\n', '5$ now.', [['span_open', [['title', 'a $b']]]]],
            ['Para Q {title="d$ e"}\n', 'costs 5$', [['paragraph_open', [['title', 'd$ e']]]]],
            ['Pay Q [x]{title="d$ e"}\n', '$5 now', [['span_open', [['title', 'd$ e']]]]],
            ['- one [s]{title="a $b"} Q\n', 'and $5', [['span_open', [['title', 'a $b']]]]],
        ] as [string, string, unknown][]) {
            const state = stateOf(source);
            const at = posIn(state.doc, 'Q', '');
            const tr = state.tr.insertText(typed, at, at + 1);
            assert.strictEqual(noteRefusal(tr), null, source);
            const saved = serializeDocument({ doc: state.apply(tr).doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
            assert.ok(saved.includes(typed.replace('$', '\\$')), `${source}: the $ is written escaped (${saved})`);
            const tokens = host.parse(saved, {}).flatMap(t => [t, ...(t.children ?? [])]);
            assert.strictEqual(mathOf(host.parse(saved, {})), '', `${source}: no math`);
            assert.deepStrictEqual(tokens.filter(t => (t.attrs ?? []).length > 0).map(t => [t.type, t.attrs]), expected, `${source}: the literal reads back`);
        }
    });

    test('a copied list item keeps its literal without the id only where the list reads it back', () => {
        const host = hostEngine([extend]);
        setInlineEngine(inlineEngineDefinition(host));
        const block = '- one [s]{title="a $b"} {#x$y title="c$ d"}';
        const source = `${block}\n\nEnd.\n`;
        const original = host.parse(block, {}).flatMap(t => [t, ...(t.children ?? [])]).filter(t => (t.attrs ?? []).length > 0).map(t => [t.type, t.attrs]);
        assert.deepStrictEqual(original, [['list_item_open', [['id', 'x$y'], ['title', 'c$ d']]], ['span_open', [['title', 'a $b']]]], 'the host reads both');
        const state = EditorState.create({ doc: parseDocument(host, source, {}).doc, plugins: editorPlugins() });
        assert.strictEqual(state.doc.child(0).type.name, 'bullet_list');
        // A drag-copy of the whole list, dropped at the end: its slice carries the same node object.
        const tr = state.tr.replaceRange(state.doc.content.size, state.doc.content.size, NodeSelection.create(state.doc, 0).content());
        assert.strictEqual(noteRefusal(tr), null);
        const saved = serializeDocument({ doc: state.apply(tr).doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
        // Without its id the item's literal, `{title="c$ d"}`, would pair with the span's `$` as math: the copy drops it.
        assert.strictEqual(saved, `${source}\n- one [s]{title="a $b"}\n`);
        const copy = host.parse(saved.slice(source.length + 1), {}).flatMap(t => [t, ...(t.children ?? [])]);
        assert.deepStrictEqual(copy.filter(t => (t.attrs ?? []).length > 0).map(t => [t.type, t.attrs]), [['span_open', [['title', 'a $b']]]], 'the copy\'s span reads back');
    });

    test('in a block whose literal already does not read back, removing a literal applies and changing one names the existing one', () => {
        // Read without math the span reads back; with math the page reads `$b"} and \`$` as math.
        const source = '[x]{title="a $b"} and `$(pwd)` {.k}\n';
        assert.deepStrictEqual(hostEngine().parse(source, {}).flatMap(t => [t, ...(t.children ?? [])]).filter(t => (t.attrs ?? []).length > 0).map(t => t.type), ['paragraph_open', 'span_open']);
        let state = EditorState.create({ doc: parseDocument(hostEngine(), source, {}).doc, plugins: editorPlugins() });
        assert.strictEqual(state.doc.child(0).attrs.attrsSuffix, '{.k}');
        setInlineEngine(inlineEngineDefinition(hostEngine([extend])));
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
        const target = attributesTargetAt(state);
        assert.ok(!('refusal' in target));
        const existing = { literal: '{title="a $b"}' };
        assert.deepStrictEqual(commitAttributes(state, target, '{.c}'), { refusal: literalAlreadyLostRefusal(existing) }, 'the cause named is the span, not the literal typed');
        assert.strictEqual(noteRefusal(state.tr.insertText('Z', 2)), literalRewritten(existing), 'typing in it is refused, naming the span');
        const removed = commitAttributes(state, target, '');
        assert.ok(removed !== null && 'tr' in removed && removed.removed, 'removing the block\'s literal is a change');
        const after = state.apply(removed.tr);
        assert.strictEqual(after.doc.child(0).attrs.attrsSuffix, null, 'the filter lets it through');
    });
});

/** Where `needle`, standing between two `pad`s (spaces unless said), starts in the first text node holding it. */
function posIn(doc: Node, needle: string, pad = ' '): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(`${pad}${needle}${pad}`)) {
            found = pos + (node.text ?? '').indexOf(`${pad}${needle}${pad}`) + pad.length;
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}"`);
    return found;
}
