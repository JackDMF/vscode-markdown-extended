import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { parseDocument, serializeDocument } from '../../../src/editor';
import { editorSchema } from '../../../src/editor/schema';
import {
    EditorObject, applySpanTransaction, changeAdmonitionTransaction, changeBlockAttrsTransaction, changeContainerTransaction, changeSpanTransaction,
    literalPlaceOf, literalRefusal, objectAtSelection, removeSpanTransaction, unwrapTransaction,
} from '../../../src/editor/webview/objects';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { blockCommand, insertWrapperTransaction } from '../../../src/editor/webview/toolbar/commands';
import { leaveWrapper, unwrapFromStart } from '../../../src/editor/webview/wrappers';
import { hostEngine, topChildren } from './helpers';

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

function select(state: EditorState, needle: string): EditorState {
    const from = posOf(state.doc, needle);
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + needle.length)));
}

function apply(state: EditorState, tr: Transaction | null): EditorState {
    assert.ok(tr, 'a transaction');
    return state.apply(tr);
}

function objectHere(state: EditorState): EditorObject {
    const object = objectAtSelection(state);
    assert.ok(object, 'an object at the selection');
    return object;
}

/** The node of type `name` the selection is in, found through the object model. */
function firstOf(doc: Node, name: string): { node: Node; pos: number } {
    let found: { node: Node; pos: number } | null = null;
    doc.descendants((node, pos) => {
        if (found === null && node.type.name === name) {
            found = { node, pos };
        }
        return found === null;
    });
    assert.ok(found, `no ${name}`);
    return found;
}

suite('Editor containers and admonitions: the toolbar, the keys and the object verbs', () => {
    const SOURCE = 'Alpha beta.\n\nLast.\n';

    test('Insert puts a native admonition after the block, the caret in its empty body; typing writes the indented body', () => {
        let state = caretAt(stateOf(SOURCE), 'beta');
        state = apply(state, insertWrapperTransaction(state, { kind: 'insert-wrapper', node: 'admonition', type: 'warning', title: 'Warning' }));
        assert.strictEqual(state.selection.$from.node(1).type.name, 'admonition');
        assert.strictEqual(text(state), 'Alpha beta.\n\n!!! warning "Warning"\n\nLast.\n', 'an empty body is no line');
        state = state.apply(state.tr.insertText('Careful.'));
        assert.strictEqual(text(state), 'Alpha beta.\n\n!!! warning "Warning"\n    Careful.\n\nLast.\n');
    });

    test('Insert puts a native container after the block, the caret in its body', () => {
        let state = caretAt(stateOf(SOURCE), 'beta');
        state = apply(state, insertWrapperTransaction(state, { kind: 'insert-wrapper', node: 'container', name: 'container' }));
        state = state.apply(state.tr.insertText('Inside.'));
        assert.strictEqual(text(state), 'Alpha beta.\n\n::: container\nInside.\n:::\n\nLast.\n');
    });

    test('Enter in an empty last paragraph leaves the wrapper; in the only one it leaves it and keeps the body', () => {
        let state = stateOf('!!! note "N"\n    Body.\n\nAfter.\n');
        state = caretAt(state, 'Body.', 5);
        state = state.apply(state.tr.split(state.selection.from));
        let next = state;
        assert.ok(leaveWrapper(state, tr => {
            next = state.apply(tr);
        }));
        assert.strictEqual(next.selection.$from.depth, 1, 'the caret is at top level');
        assert.strictEqual(text(next), '!!! note "N"\n    Body.\n\nAfter.\n', 'the empty paragraph went with the caret, and is written as nothing');

        let fresh = caretAt(stateOf(SOURCE), 'beta');
        fresh = apply(fresh, insertWrapperTransaction(fresh, { kind: 'insert-wrapper', node: 'container', name: 'c' }));
        let left = fresh;
        assert.ok(leaveWrapper(fresh, tr => {
            left = fresh.apply(tr);
        }));
        assert.strictEqual(left.selection.$from.depth, 1);
        assert.strictEqual(firstOf(left.doc, 'container').node.childCount, 1, 'a wrapper keeps its one paragraph');
    });

    test('Backspace at the start of an empty first paragraph removes the wrapper and keeps the content', () => {
        let state = stateOf('::: box\nKept one.\n\nKept two.\n:::\n');
        const inner = firstOf(state.doc, 'container').pos + 1;
        state = state.apply(state.tr.insert(inner, editorSchema.nodes.paragraph.create()));
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, inner + 1)));
        let next = state;
        assert.ok(unwrapFromStart(state, tr => {
            next = state.apply(tr);
        }));
        assert.strictEqual(topChildren(next.doc).map(n => n.type.name).join(','), 'paragraph,paragraph,paragraph');
        assert.strictEqual(text(next), 'Kept one.\n\nKept two.\n');
        const notEmpty = caretAt(stateOf('::: box\nText.\n:::\n'), 'Text');
        assert.strictEqual(unwrapFromStart(notEmpty), false, 'a paragraph with text is not taken');
    });

    test('the object at the caret is the innermost: a span in an admonition is the span, text beside it the admonition', () => {
        const state = stateOf('!!! note "N"\n    A [word]{.k} here.\n');
        assert.strictEqual(objectHere(caretAt(state, 'word', 2)).kind, 'span');
        assert.strictEqual(objectHere(caretAt(state, 'here', 2)).kind, 'admonition');
        assert.strictEqual(objectAtSelection(caretAt(stateOf('Plain.\n'), 'Plain', 2)), null);
    });

    test('Remove container, keep content: its paragraphs stay where it stood', () => {
        let state = caretAt(stateOf('Before.\n\n::: box\nOne.\n\nTwo.\n:::\n\nAfter.\n'), 'One', 1);
        const object = objectHere(state);
        assert.strictEqual(object.kind, 'container');
        state = apply(state, unwrapTransaction(state, object.from));
        assert.strictEqual(text(state), 'Before.\n\nOne.\n\nTwo.\n\nAfter.\n');
        assert.strictEqual(state.selection.$from.parent.textContent, 'One.', 'the caret stays in the text it was in');
    });

    test('Change name/info renames the container, the info kept verbatim; a trailing {…} is refused', () => {
        let state = stateOf('::: box\nText.\n:::\n');
        const at = firstOf(state.doc, 'container').pos;
        state = apply(state, changeContainerTransaction(state, at, 'panel wide'));
        assert.strictEqual(text(state), '::: panel wide\nText.\n:::\n');
        assert.strictEqual(changeContainerTransaction(state, at, 'panel {.x}'), null);
    });

    test('a span is made of the selection, its literal changed and removed, each one step', () => {
        let state = select(stateOf('Alpha beta gamma.\n'), 'beta');
        state = apply(state, applySpanTransaction(state, '{.klasse}'));
        assert.strictEqual(text(state), 'Alpha [beta]{.klasse} gamma.\n');
        assert.strictEqual(applySpanTransaction(select(state, 'Alpha'), '{.}'), null, 'not a literal the plugin reads');
        const span = objectHere(caretAt(state, 'beta', 2));
        assert.strictEqual(span.kind, 'span');
        state = apply(state, span.kind === 'span' ? changeSpanTransaction(state, span, '{#b .c}') : null);
        assert.strictEqual(text(state), 'Alpha [beta]{#b .c} gamma.\n');
        const changed = objectHere(caretAt(state, 'beta', 2));
        state = apply(state, changed.kind === 'span' ? removeSpanTransaction(state, changed) : null);
        assert.strictEqual(text(state), 'Alpha beta gamma.\n');
    });

    test('a span\'s literal a note could not hold is refused inside a note', () => {
        const state = select(stateOf('Text ++ref|a body++ end.\n'), 'body');
        assert.ok(applySpanTransaction(state, '{.c}'));
        assert.strictEqual(applySpanTransaction(state, '{title="a|b"}'), null);
    });
    test('a changed body keeps the opening line as written; a changed title writes it by rule', () => {
        let state = stateOf('!!! note Unquoted title\n    Body.\n');
        state = apply(state, caretAt(state, 'Body', 4).tr.insertText(' More'));
        assert.strictEqual(text(state), '!!! note Unquoted title\n    Body More.\n');
        const at = firstOf(state.doc, 'admonition').pos;
        state = apply(state, changeAdmonitionTransaction(state, at, { title: 'Another' }));
        assert.strictEqual(text(state), '!!! note "Another"\n    Body More.\n');
        state = apply(state, changeAdmonitionTransaction(state, at, { type: 'warning' }));
        assert.strictEqual(text(state), '!!! warning "Another"\n    Body More.\n');
        state = apply(state, changeAdmonitionTransaction(state, at, { title: '' }));
        assert.strictEqual(text(state), '!!! warning\n    Body More.\n');
    });
});

suite('Editor block attributes: the object and its verb', () => {
    test('Edit block attributes replaces the literal in place; empty removes it; a requirement heading\'s anchor is refused', () => {
        let state = stateOf('Some text here. {.lead}\n');
        state = apply(state, changeBlockAttrsTransaction(state, 0, '{.lead .wide}'));
        assert.strictEqual(text(state), 'Some text here. {.lead .wide}\n');
        state = apply(state, changeBlockAttrsTransaction(state, 0, ''));
        assert.strictEqual(text(state), 'Some text here.\n');
        let heading = stateOf('## Title {#old}\n');
        heading = apply(heading, changeBlockAttrsTransaction(heading, 0, '{#new .c}'));
        assert.deepStrictEqual([heading.doc.child(0).attrs.anchor, text(heading)], ['new', '## Title {#new .c}\n']);
        const req = heading.doc.child(0).type.create({ ...heading.doc.child(0).attrs, reqPrefix: 'FR-X-001: ' }, heading.doc.child(0).content);
        const locked = EditorState.create({ doc: editorSchema.topNodeType.create(null, [req]) });
        assert.strictEqual(changeBlockAttrsTransaction(locked, 0, '{#other}'), null);
    });

    test('a new block type keeps the literal: a paragraph made a heading writes it at the end of its line', () => {
        let state = caretAt(stateOf('Some text here\n{.aside}\n'), 'text');
        state = apply(state, (() => {
            let made: Transaction | null = null;
            blockCommand('heading', 2)(state, tr => {
                made = tr;
            });
            return made;
        })());
        assert.strictEqual(text(state), '## Some text here {.aside}\n');
        assert.strictEqual(objectHere(caretAt(state, 'here')).kind, 'block_attrs');
    });

    test('a requirement heading\'s anchor is no block-attributes object: it is Req Explorer\'s, and the heading is a heading object', () => {
        const parsed = parseDocument(hostEngine(), '## FR-X-001: Title {#fr-x-001}\n');
        const heading = parsed.doc.child(0);
        const req = heading.type.create({ ...heading.attrs, reqPrefix: 'FR-X-001: ' }, editorSchema.text('Title'));
        const state = EditorState.create({ doc: editorSchema.topNodeType.create(null, [req]) });
        // Its bar carries only the code actions other extensions offer for it (objectToolbar.ts).
        assert.strictEqual(objectAtSelection(caretAt(state, 'Title', 2))?.kind, 'heading');
    });

    test('a selected rule with attributes is its block-attributes object', () => {
        const state = stateOf('Text.\n\n--- {#cut}\n');
        const at = state.doc.child(0).nodeSize;
        const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, at)));
        assert.strictEqual(objectHere(selected).kind, 'block_attrs');
    });
});

suite('Editor stage 3: review findings, in the page', () => {
    test('5. a span literal with a quoted } is refused, with the reason', () => {
        const state = select(stateOf('Alpha beta gamma.\n'), 'beta');
        assert.strictEqual(applySpanTransaction(state, '{title="a}b"}'), null);
        assert.match(literalRefusal('{title="a}b"}', 'span') ?? '', /cuts the literal at its first \}/);
        const made = apply(state, applySpanTransaction(state, '{.ok}'));
        const span = objectHere(caretAt(made, 'beta', 2));
        assert.strictEqual(span.kind === 'span' ? changeSpanTransaction(made, span, '{title="a}b"}') : 'not a span', null);
    });

    test('6. a rule\'s literal is refused when the plugin would not read it whole: a { inside a value', () => {
        const state = stateOf('Text.\n\n--- {#cut}\n');
        const at = state.doc.child(0).nodeSize;
        assert.strictEqual(state.doc.nodeAt(at)?.type.name, 'horizontal_rule');
        assert.strictEqual(changeBlockAttrsTransaction(state, at, '{.a title="x{y"}'), null);
        assert.match(literalRefusal('{.a title="x{y"}', literalPlaceOf(state.doc.nodeAt(at) as Node)) ?? '', /from its last \{/);
        const quotedClose = apply(state, changeBlockAttrsTransaction(state, at, '{title="a}b"}'));
        assert.strictEqual(text(quotedClose), 'Text.\n\n--- {title="a}b"}\n', 'a quoted } the plugin reads correctly after a rule');
        const paragraph = stateOf('Some text. {.lead}\n');
        assert.ok(changeBlockAttrsTransaction(paragraph, 0, '{.a title="x{y"}'), 'after a paragraph the plugin reads the whole literal');
    });
});
