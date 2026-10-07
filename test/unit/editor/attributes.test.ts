import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { splitListItem } from 'prosemirror-schema-list';
import { splitBlock } from 'prosemirror-commands';
import { parseDocument, serializeDocument } from '../../../src/editor';
import { withoutId } from '../../../src/editor/attrs';
import { editorSchema } from '../../../src/editor/schema';
import {
    ADMONITION_ATTRS_REFUSAL, AttributesTarget, CONTAINER_ATTRS_REFUSAL, INDENTED_CODE_ATTRS_REFUSAL, QUOTE_ATTRS_REFUSAL, attributesTargetAt,
    commitAttributes, literalOf,
} from '../../../src/editor/webview/objects';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine } from './helpers';

const options = { defaultWrap: 90 };

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: editorPlugins() });
}

function text(state: EditorState): string {
    return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, options);
}

function posOf(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(needle)) {
            found = pos + (node.text ?? '').indexOf(needle);
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}" in the document`);
    return found;
}

function caretAt(state: EditorState, needle: string, offset = 0): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, needle) + offset)));
}

function targetAt(state: EditorState): AttributesTarget {
    const found = attributesTargetAt(state);
    assert.ok(!('refusal' in found), 'refusal' in found ? found.refusal : '');
    return found;
}

function refusalAt(state: EditorState): string {
    const found = attributesTargetAt(state);
    assert.ok('refusal' in found, `a refusal, not ${'name' in found ? found.name : ''}`);
    return found.refusal;
}

/** The literal set through the one commit both surfaces use; the state after it. */
function set(state: EditorState, literal: string): EditorState {
    const made = commitAttributes(state, targetAt(state), literal);
    assert.ok(made !== null && 'tr' in made, made !== null && 'refusal' in made ? made.refusal : 'a transaction');
    return state.apply(made.tr);
}

/** `text` parsed, the caret put at `needle`, `literal` set: the source written, and that source parsed again. */
function written(source: string, needle: string, literal: string): { out: string; again: EditorState; state: EditorState } {
    const state = set(caretAt(stateOf(source), needle), literal);
    const out = text(state);
    return { out, again: stateOf(out), state };
}

/** Every literal in the document, top-level blocks' and list items', in order. */
function literals(state: EditorState): string[] {
    const out: string[] = [];
    state.doc.descendants(node => {
        const literal = literalOf(node);
        if (literal !== null) {
            out.push(literal);
        }
        return true;
    });
    return out;
}

suite('Editor Attributes…: where each construct\'s literal is written', () => {
    test('a paragraph: after a space at the end of its last line; edited in place; {} removes it', () => {
        const { out, state } = written('Alpha beta.\n\nNext one.\n', 'beta', '{.note}');
        assert.strictEqual(out, 'Alpha beta. {.note}\n\nNext one.\n');
        const edited = set(caretAt(state, 'beta'), '{.note #intro}');
        assert.strictEqual(text(edited), 'Alpha beta. {.note #intro}\n\nNext one.\n');
        assert.strictEqual(text(set(caretAt(edited, 'beta'), '{}')), 'Alpha beta.\n\nNext one.\n');
        assert.strictEqual(text(set(caretAt(edited, 'beta'), '')), 'Alpha beta.\n\nNext one.\n', 'an empty field removes it too');
    });

    test('a paragraph of two lines: at the end of the last one, not wrapped', () => {
        const source = 'The first line of a paragraph that is long enough to be wrapped where it was,\nand its second line.\n';
        assert.strictEqual(written(source, 'second', '{.aside}').out, `${source.trimEnd()} {.aside}\n`);
    });

    test('a paragraph holding only an image: the paragraph carries it, not the image', () => {
        const state = stateOf('![A chart](chart.png)\n');
        const image = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 1)));
        assert.strictEqual(targetAt(image).name, 'Paragraph');
        const out = text(set(image, '{.figure}'));
        assert.strictEqual(out, '![A chart](chart.png) {.figure}\n');
        assert.match(hostEngine().render(out), /<p class="figure"><img/);
    });

    test('a heading: at the end of its line, its id the anchor', () => {
        const { out, again } = written('## Overview\n', 'Overview', '{#overview .wide}');
        assert.strictEqual(out, '## Overview {#overview .wide}\n');
        assert.strictEqual(again.doc.child(0).attrs.anchor, 'overview');
        assert.strictEqual(text(set(caretAt(again, 'Overview'), '{}')), '## Overview\n');
    });

    test('a requirement heading is refused: its anchor is Req Explorer\'s', () => {
        const parsed = stateOf('## FR-X-001: Title {#fr-x-001}\n').doc.child(0);
        const req = parsed.type.create({ ...parsed.attrs, reqPrefix: 'FR-X-001: ' }, editorSchema.text('Title'));
        const state = EditorState.create({ doc: editorSchema.topNodeType.create(null, [req]) });
        assert.match(refusalAt(caretAt(state, 'Title', 2)), /Req Explorer/);
    });

    test('a list item: at the end of its first paragraph, the item and not the list', () => {
        const { out, again } = written('- one\n- two\n', 'two', '{.done}');
        assert.strictEqual(out, '- one\n- two {.done}\n');
        assert.match(hostEngine().render(out), /<li class="done">two<\/li>/);
        assert.deepStrictEqual(literals(again), ['{.done}']);
        assert.strictEqual(targetAt(caretAt(again, 'two')).name, 'List item');
        assert.strictEqual(text(set(caretAt(again, 'two'), '{}')), '- one\n- two\n');
    });

    test('a list item of two lines, a numbered one, a nested one, one in a quote', () => {
        assert.strictEqual(written('- first line\n  second line\n- next\n', 'second', '{.x}').out, '- first line\n  second line {.x}\n- next\n');
        assert.strictEqual(written('1. one\n2. two\n', 'one', '{#first}').out, '1. one {#first}\n2. two\n');
        assert.strictEqual(written('- outer\n  - inner\n- last\n', 'inner', '{.n}').out, '- outer\n  - inner {.n}\n- last\n');
        assert.strictEqual(written('- outer\n  - inner\n- last\n', 'outer', '{.o}').out, '- outer {.o}\n  - inner\n- last\n');
        assert.strictEqual(written('> - quoted item\n', 'quoted', '{.q}').out, '> - quoted item {.q}\n');
    });

    test('a list item keeps its literal beside the list\'s own', () => {
        const state = stateOf('- a {.x}\n{.y}\n');
        assert.deepStrictEqual(literals(state), ['{.y}', '{.x}']);
        const edited = set(caretAt(state, 'a'), '{.z}');
        assert.strictEqual(text(edited), '- a {.z}\n{.y}\n');
    });

    test('a quote: > {…} under its last paragraph, inside the quote', () => {
        const { out, again } = written('> A quoted line,\n> and the next.\n', 'quoted', '{.pull}');
        assert.strictEqual(out, '> A quoted line,\n> and the next.\n> {.pull}\n');
        assert.match(hostEngine().render(out), /<blockquote class="pull">/);
        assert.strictEqual(targetAt(caretAt(again, 'next')).name, 'Quote');
        assert.strictEqual(text(set(caretAt(again, 'next'), '{}')), '> A quoted line,\n> and the next.\n');
    });

    test('a quote ending in a list is refused: the plugin would give the literal to the list', () => {
        assert.strictEqual(refusalAt(caretAt(stateOf('> Text.\n>\n> - item\n'), 'Text')), QUOTE_ATTRS_REFUSAL);
    });

    test('a table: its own line under a blank line after it', () => {
        const table = '| a | b |\n| - | - |\n| 1 | 2 |\n';
        const { out, again } = written(`${table}\nAfter.\n`, '1', '{.wide}');
        assert.strictEqual(out, `${table}\n{.wide}\n\nAfter.\n`);
        assert.match(hostEngine().render(out), /<table class="wide">/);
        assert.strictEqual(targetAt(caretAt(again, '2')).name, 'Table');
        assert.strictEqual(text(set(caretAt(again, '2'), '{.wide #t}')), `${table}\n{.wide #t}\n\nAfter.\n`);
        assert.strictEqual(text(set(caretAt(again, '2'), '{}')), `${table}\nAfter.\n`);
    });

    test('a table whose literal stood right under it keeps it there once changed', () => {
        const state = stateOf('| a |\n| - |\n| 1 |\n{.x}\n\nAfter.\n');
        assert.deepStrictEqual(literals(state), ['{.x}']);
        assert.strictEqual(text(set(caretAt(state, '1'), '{.y}')), '| a |\n| - |\n| 1 |\n{.y}\n\nAfter.\n');
    });

    test('a literal line before a block that may interrupt a paragraph stays tight; one before a paragraph gets its blank line', () => {
        // A table ends where a heading starts, with no blank line. The parser reads `{.wide}` + `# After` as the table's
        // literal and a heading — markdown-it-attrs takes the literal's paragraph, and a heading interrupts one anyway —
        // so the seam holds as written.
        for (const [source, expected] of [
            ['| a |\n| - |\n| 1 |\n# After\n', '| a |\n| - |\n| 1 |\n\n{.wide}\n# After\n'],
        ] as const) {
            const out = written(source, '1', '{.wide}').out;
            assert.strictEqual(out, expected);
            assert.match(hostEngine().render(out), /<table class="wide">[\s\S]*<h1[^>]*>After<\/h1>/);
        }
        // `{.wider}` + `After.` is one paragraph of text to the parser: a gap the parse gave as empty, kept by the edit, gets its blank line.
        const state = stateOf('| a |\n| - |\n| 1 |\n\n{.wide}\n\nAfter.\n');
        const after = state.doc.child(1);
        const glued = state.apply(state.tr.setNodeMarkup(state.doc.child(0).nodeSize, undefined, { ...after.attrs, gap: '' }));
        const edited = set(caretAt(glued, '1'), '{.wider}');
        const out = text(edited);
        assert.strictEqual(out, '| a |\n| - |\n| 1 |\n\n{.wider}\n\nAfter.\n');
        assert.match(hostEngine().render(out), /<table class="wider">[\s\S]*<p>After\.<\/p>/);
    });

    test('a fenced code block: after the opening fence\'s info string; an indented one is refused', () => {
        const { out } = written('```js\nconst a = 1;\n```\n', 'const', '{.numbered}');
        assert.strictEqual(out, '```js {.numbered}\nconst a = 1;\n```\n');
        assert.match(hostEngine().render(out), /<code class="numbered language-js">/);
        assert.strictEqual(refusalAt(caretAt(stateOf('Text.\n\n    indented code\n'), 'indented')), INDENTED_CODE_ATTRS_REFUSAL);
    });

    test('a container and an admonition are refused, and so is a paragraph inside one', () => {
        const container = stateOf('::: warning\nInside.\n:::\n');
        assert.strictEqual(refusalAt(caretAt(container, 'Inside')), CONTAINER_ATTRS_REFUSAL);
        const admonition = stateOf('!!! note "Title"\n    Body text.\n');
        assert.strictEqual(refusalAt(caretAt(admonition, 'Body')), ADMONITION_ATTRS_REFUSAL);
    });

    test('a source block, the front matter and a rule selected: refused, refused, the rule', () => {
        const state = stateOf('---\ntitle: T\n---\n\nText.\n\n<div>html</div>\n\n---\n');
        const at = (name: string): EditorState => {
            let pos = -1;
            state.doc.forEach((node, offset) => {
                if (pos < 0 && node.type.name === name) {
                    pos = offset;
                }
            });
            return state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
        };
        assert.match(refusalAt(at('raw_block')), /source block/);
        assert.match(refusalAt(at('front_matter')), /front matter/);
        assert.strictEqual(targetAt(at('horizontal_rule')).name, 'Rule');
    });

    test('a literal markdown-it-attrs would not read back is refused with the reason', () => {
        const state = caretAt(stateOf('Alpha beta.\n'), 'beta');
        const target = targetAt(state);
        for (const [literal, reason] of [['{.}', /no attribute list/], ['.note', /no attribute list/], ['{.a', /is not closed/], ['{#}', /no attribute list/], ['{.a}\n{.b}', /no attribute list/]] as const) {
            const made = commitAttributes(state, target, literal);
            assert.ok(made !== null && 'refusal' in made, `${JSON.stringify(literal)} is refused`);
            assert.match(made.refusal, reason);
        }
        const rule = stateOf('Text.\n\n---\n');
        const selected = rule.apply(rule.tr.setSelection(NodeSelection.create(rule.doc, rule.doc.child(0).nodeSize)));
        const made = commitAttributes(selected, targetAt(selected), '{title="x{y"}');
        assert.ok(made !== null && 'refusal' in made && /last \{/.test(made.refusal));
        assert.strictEqual(commitAttributes(state, target, '{}'), null, 'removing what is not there does nothing');
    });

    test('the literal is kept verbatim: parse(serialize(…)) gives it back as typed, for each construct', () => {
        const literal = '{ .a  #b key="v w" }';
        const cases: [string, string][] = [
            ['Para text.\n', 'Para'],
            ['## Head\n', 'Head'],
            ['- item\n', 'item'],
            ['> quote\n', 'quote'],
            ['| h |\n| - |\n| c |\n', 'c'],
            ['```\ncode\n```\n', 'code'],
        ];
        for (const [source, needle] of cases) {
            const { again } = written(source, needle, literal);
            assert.deepStrictEqual(literals(again), [literal], source);
        }
    });

    test('one undo step takes it back', () => {
        const state = set(caretAt(stateOf('- one\n- two\n'), 'two'), '{.done}');
        let undone: Transaction | null = null;
        undo(state, tr => {
            undone = tr;
        });
        assert.ok(undone);
        assert.strictEqual(text(state.apply(undone)), '- one\n- two\n');
    });
});

suite('Editor Attributes…: what an edit leaves of a literal', () => {
    test('the second half of a split list item does not carry the item\'s literal again', () => {
        let state = caretAt(stateOf('- alpha beta {#a}\n'), 'beta');
        splitListItem(editorSchema.nodes.list_item)(state, tr => {
            state = state.apply(tr);
        });
        assert.strictEqual(text(state), '- alpha {#a}\n- beta\n');
        // Only its id: the class stays on both halves, as on a copy.
        let classed = caretAt(stateOf('- alpha beta {.x #a}\n'), 'beta');
        splitListItem(editorSchema.nodes.list_item)(classed, tr => {
            classed = classed.apply(tr);
        });
        assert.strictEqual(text(classed), '- alpha {.x #a}\n- beta {.x}\n');
    });

    test('typing in an item keeps its literal', () => {
        let state = caretAt(stateOf('- alpha {.x}\n'), 'alpha', 5);
        state = state.apply(state.tr.insertText(' more'));
        assert.strictEqual(text(state), '- alpha more {.x}\n');
    });

    test('a quote whose last paragraph becomes a list loses its literal, and the page draws what is saved', () => {
        let state = stateOf('> First.\n>\n> Last.\n> {.pull}\n');
        const quote = state.doc.child(0);
        const lastPara = quote.child(quote.childCount - 1);
        const at = 1 + quote.content.size - lastPara.nodeSize;
        const list = editorSchema.nodes.bullet_list.create(null, editorSchema.nodes.list_item.create(null, lastPara));
        state = state.apply(state.tr.replaceWith(at, at + lastPara.nodeSize, list));
        assert.strictEqual(state.doc.child(0).attrs.attrsSuffix, null);
        assert.strictEqual(text(state), '> First.\n>\n> - Last.\n');
    });
});

suite('Editor Attributes…: transient states, splits and braces that are text (review)', () => {
    test('Enter at the end of a quote\'s last paragraph keeps its literal, and typing on writes it under the new text', () => {
        let state = caretAt(stateOf('> Quoted.\n> {.pull}\n'), 'Quoted.', 'Quoted.'.length);
        splitBlock(state, tr => {
            state = state.apply(tr);
        });
        assert.strictEqual(state.doc.child(0).attrs.attrsSuffix, '{.pull}', 'kept through the empty paragraph');
        assert.strictEqual(text(state), '> Quoted.\n> {.pull}\n', 'an empty last paragraph writes nothing after it');
        state = state.apply(state.tr.insertText('More.'));
        assert.strictEqual(text(state), '> Quoted.\n>\n> More.\n> {.pull}\n');
    });

    test('an item whose text is deleted and typed again keeps its literal: an empty item is written - {.x}', () => {
        let state = stateOf('- alpha {.x}\n- beta\n');
        const from = posOf(state.doc, 'alpha');
        state = state.apply(state.tr.delete(from, from + 'alpha'.length));
        assert.strictEqual(text(state), '- {.x}\n- beta\n');
        assert.match(hostEngine().render(text(state)), /<li class="x"><\/li>/);
        state = state.apply(state.tr.insertText('gamma', from));
        assert.strictEqual(text(state), '- gamma {.x}\n- beta\n');
    });

    test('Shift+Enter at the end of an item keeps its literal', () => {
        let state = caretAt(stateOf('- alpha {.x}\n'), 'alpha', 5);
        state = state.apply(state.tr.replaceSelectionWith(editorSchema.nodes.hard_break.create()));
        assert.deepStrictEqual(literals(state), ['{.x}']);
        state = state.apply(state.tr.insertText('more'));
        const out = text(state);
        assert.strictEqual(out, '- alpha\\\n  more {.x}\n');
        assert.match(hostEngine().render(out), /<li class="x">/);
    });

    test('an item split at the start of its text keeps the literal on the half that stays where it was', () => {
        let state = caretAt(stateOf('- alpha {#a}\n'), 'alpha');
        splitListItem(editorSchema.nodes.list_item)(state, tr => {
            state = state.apply(tr);
        });
        assert.deepStrictEqual(literals(state), ['{#a}'], 'on one half, not on both, not on none');
        assert.strictEqual(state.doc.child(0).child(0).attrs.literal, '{#a}');
    });

    test('text ending in braces stays text: its braces are escaped, with a literal after it and once it is removed', () => {
        const source = 'Set notation \\{x\\}\n';
        const state = stateOf(source);
        assert.strictEqual(state.doc.child(0).textContent, 'Set notation {x}');
        const withLiteral = set(caretAt(state, 'notation'), '{.math}');
        const out = text(withLiteral);
        assert.strictEqual(out, 'Set notation \\{x\\} {.math}\n');
        assert.match(hostEngine().render(out), /<p class="math">Set notation \{x\}<\/p>/);
        const removed = text(set(caretAt(stateOf(out), 'notation'), '{}'));
        assert.strictEqual(removed, source);
        assert.match(hostEngine().render(removed), /<p>Set notation \{x\}<\/p>/);
        // A heading and an item likewise.
        assert.strictEqual(written('## Sets \\{x\\}\n', 'Sets', '{.s}').out, '## Sets \\{x\\} {.s}\n');
        assert.strictEqual(written('- Sets \\{x\\}\n', 'Sets', '{.s}').out, '- Sets \\{x\\} {.s}\n');
    });
});

suite('Editor Attributes…: a fence\'s literal is read on its own fence, a heading\'s whole (review)', () => {
    const fenceAttrs = (source: string) => hostEngine().parse(source, {}).find(t => t.type === 'fence')?.attrs ?? null;

    test('a ~~~ fence keeps, takes and copies a literal with a backtick, which a ``` fence cannot hold', () => {
        const opened = stateOf('~~~js {title="a`b"}\ncode\n~~~\n');
        assert.strictEqual(opened.doc.child(0).type.name, 'code_block');
        assert.strictEqual(opened.doc.child(0).attrs.attrsSuffix, '{title="a`b"}', 'the file\'s literal is the block\'s');
        const out = text(set(caretAt(stateOf('~~~js\ncode\n~~~\n'), 'code'), '{k=a`b}'));
        assert.strictEqual(out, '~~~js {k=a`b}\ncode\n~~~\n');
        assert.deepStrictEqual(fenceAttrs(out), [['k', 'a`b']]);
        const backticks = caretAt(stateOf('```js\ncode\n```\n'), 'code');
        const refused = commitAttributes(backticks, targetAt(backticks), '{k=a`b}');
        assert.ok(refused !== null && 'refusal' in refused && /backtick/.test(refused.refusal), 'a ``` fence refuses it, saying why');
        assert.strictEqual(withoutId('{title="a`b" #w}', 'code_block~'), '{title=a`b}', 'a copy on a ~~~ fence keeps it');
        assert.strictEqual(withoutId('{title="a`b" #w}', 'code_block'), null, 'on a ``` fence there is none to keep');
    });

    test('a heading whose literal holds a { in a value keeps the whole literal through an edit', () => {
        const state = stateOf('# H {title="a{b"}\n');
        assert.strictEqual(state.doc.child(0).attrs.attrsSuffix, '{title="a{b"}');
        const edited = state.apply(state.tr.insertText('X', posOf(state.doc, 'H') + 1));
        const out = text(edited);
        assert.strictEqual(out, '# HX {title="a{b"}\n');
        assert.deepStrictEqual(hostEngine().parse(out, {}).find(t => t.type === 'heading_open')?.attrs, [['title', 'a{b']]);
    });

    test('a heading with a closing # run after its literal keeps the literal, which markdown-it reads before the run', () => {
        const source = '# Title {#id} ##\n';
        assert.deepStrictEqual(hostEngine().parse(source, {}).find(t => t.type === 'heading_open')?.attrs, [['id', 'id']]);
        const state = stateOf(source);
        assert.strictEqual(state.doc.child(0).type.name, 'heading', 'an editable heading, not a source block');
        assert.strictEqual(state.doc.child(0).attrs.attrsSuffix, '{#id}');
        assert.strictEqual(state.doc.child(0).attrs.anchor, 'id');
        const out = text(state.apply(state.tr.insertText('X', posOf(state.doc, 'Title') + 5)));
        assert.strictEqual(out, '# TitleX {#id}\n');
        assert.deepStrictEqual(hostEngine().parse(out, {}).find(t => t.type === 'heading_open')?.attrs, [['id', 'id']]);
    });
});
