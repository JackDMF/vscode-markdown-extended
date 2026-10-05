import * as assert from 'assert';
import * as vscode from 'vscode';
import MarkdownItStatic = require('markdown-it');
import { EditorState, TextSelection } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import { MarkdownIt, Token } from '../../../src/@types/markdown-it';
import { attrsReadAt, joinAttrs, parseAttrsLiteral, sameAttrs } from '../../../src/editor/attrs';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { DEFAULT_INLINE_ENGINE, createInlineEngine, definitionOf, inlineEngineDefinition } from '../../../src/editor/inlineEngine';
import { useMathStandIn } from '../../../src/editor/mathStandIn';
import { parseDocument } from '../../../src/editor/parse';
import { serializeDocument, setInlineEngine } from '../../../src/editor/serialize';
import {
    LITERAL_READ_WITH_BLOCK_REFUSAL, attributesTargetAt, commitAttributes, literalRefusal, spanLiteralRefusal,
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
});

function posIn(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(` ${needle} `)) {
            found = pos + (node.text ?? '').indexOf(` ${needle} `) + 1;
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}"`);
    return found;
}
