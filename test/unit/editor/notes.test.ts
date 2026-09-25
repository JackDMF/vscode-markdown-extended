import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { Command, EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { serializeDocument } from '../../../src/editor/serialize';
import {
    NESTED_NOTE_LOCK, NOTE_BODY_PLACEHOLDER, NOTE_REF_PLACEHOLDER, leaveNote, nextNotePart, noteContextAt, previousNotePart,
    wrapInNote, wrapNodeLockReason,
} from '../../../src/editor/webview/notes';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine } from './helpers';

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: editorPlugins() });
}

function text(state: EditorState): string {
    return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
}

/** The position of the `occurrence`-th `needle` in the document's text nodes. */
function posOf(doc: Node, needle: string, occurrence = 0): number {
    let found = -1;
    let seen = 0;
    doc.descendants((node, pos) => {
        if (found >= 0 || !node.isText) {
            return found < 0;
        }
        let at = (node.text ?? '').indexOf(needle);
        while (at >= 0 && found < 0) {
            if (seen++ === occurrence) {
                found = pos + at;
            }
            at = (node.text ?? '').indexOf(needle, at + 1);
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}" in the document`);
    return found;
}

function select(state: EditorState, needle: string): EditorState {
    const from = posOf(state.doc, needle);
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + needle.length)));
}

function caretAt(state: EditorState, pos: number): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function run(state: EditorState, command: Command): EditorState {
    let next = state;
    assert.ok(command(state, tr => {
        next = next.apply(tr);
    }), 'the command applies');
    return next;
}

/** Press a key through the page's keymaps, as ProseMirror would. */
function press(state: EditorState, key: string, shift = false): EditorState {
    let next = state;
    const event = { key, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false, keyCode: 0, type: 'keydown', preventDefault() { /* */ } };
    const view = {
        state,
        dispatch: (tr: Transaction) => {
            next = next.apply(tr);
        },
    };
    const handled = state.plugins.some(plugin => plugin.props.handleKeyDown?.call(plugin, view as never, event as unknown as KeyboardEvent));
    assert.ok(handled, `${shift ? 'Shift+' : ''}${key} is handled`);
    return next;
}

function selectedText(state: EditorState): string {
    return state.doc.textBetween(state.selection.from, state.selection.to);
}

function type(state: EditorState, s: string): EditorState {
    return state.apply(state.tr.insertText(s));
}

const SOURCE = 'Alpha beta gamma.\n';

suite('Editor notes: making one from the toolbar', () => {
    test('the selection becomes the reference and the body the placeholder, selected, so typing writes the note', () => {
        let state = run(select(stateOf(SOURCE), 'beta'), wrapInNote('sidenote'));
        assert.strictEqual(text(state), 'Alpha ++beta|note++ gamma.\n');
        assert.strictEqual(selectedText(state), NOTE_BODY_PLACEHOLDER);
        assert.strictEqual(noteContextAt(state.selection.$from)?.role, 'body');
        state = type(state, 'what it says');
        assert.strictEqual(text(state), 'Alpha ++beta|what it says++ gamma.\n');
    });

    test('from no selection the reference is the placeholder, selected: the plugin refuses an empty one', () => {
        const state = run(caretAt(stateOf(SOURCE), posOf(stateOf(SOURCE).doc, 'gamma')), wrapInNote('marginal_note'));
        assert.strictEqual(text(state), 'Alpha beta !!reference|note!!gamma.\n');
        assert.strictEqual(selectedText(state), NOTE_REF_PLACEHOLDER);
        assert.strictEqual(noteContextAt(state.selection.$from)?.role, 'ref');
    });

    test('a sidebar takes the selection as its text, the caret at its end; the spaces at the ends stay outside', () => {
        const state = run(select(stateOf(SOURCE), 'beta '), wrapInNote('left_sidebar'));
        assert.strictEqual(text(state), 'Alpha $beta$ gamma.\n');
        assert.ok(state.selection.empty);
        assert.strictEqual(noteContextAt(state.selection.$from)?.role, 'sidebar');
        assert.strictEqual(text(type(state, '!')), 'Alpha $beta!$ gamma.\n');
    });

    test('the marks the whole selection has go on the note, so the emphasis around it stays one', () => {
        const state = run(select(stateOf('**Alpha beta gamma.**\n'), 'beta'), wrapInNote('sidenote'));
        assert.strictEqual(text(state), '**Alpha ++beta|note++ gamma.**\n');
    });

    test('inside a note no note can be made, and the reason says so', () => {
        const state = select(stateOf('Alpha ++beta|body++ gamma.\n'), 'body');
        assert.strictEqual(wrapNodeLockReason(state), NESTED_NOTE_LOCK);
        assert.strictEqual(wrapInNote('marginal_note')(state), false);
    });
});

suite('Editor notes: the keys inside one', () => {
    const NOTE = 'Alpha ++beta|body++ gamma.\n';

    test('Tab goes from the reference to the body, then out; Shift+Tab back; Esc out', () => {
        let state = caretAt(stateOf(NOTE), posOf(stateOf(NOTE).doc, 'beta') + 2);
        state = press(state, 'Tab');
        assert.strictEqual(noteContextAt(state.selection.$from)?.role, 'body');
        assert.strictEqual(text(type(state, '!')), 'Alpha ++beta|body!++ gamma.\n', 'at the end of the body');
        state = run(state, previousNotePart);
        assert.strictEqual(text(type(state, '?')), 'Alpha ++beta?|body++ gamma.\n', 'at the end of the reference');
        state = run(run(state, nextNotePart), nextNotePart);
        assert.strictEqual(noteContextAt(state.selection.$from), null);
        assert.strictEqual(text(type(state, ' more')), 'Alpha ++beta|body++ more gamma.\n', 'after the note');
        state = run(caretAt(state, posOf(state.doc, 'body') + 1), leaveNote);
        assert.strictEqual(text(type(state, 'X')), 'Alpha ++beta|body++X gamma.\n');
        assert.strictEqual(text(type(press(caretAt(state, posOf(state.doc, 'body')), 'Escape'), 'Y')), 'Alpha ++beta|body++Y gamma.\n');
    });

    test('Enter in the reference goes to the body; in the body it leaves the note, never splitting it', () => {
        let state = press(caretAt(stateOf(NOTE), posOf(stateOf(NOTE).doc, 'beta') + 4), 'Enter');
        assert.strictEqual(noteContextAt(state.selection.$from)?.role, 'body');
        state = press(state, 'Enter');
        assert.strictEqual(noteContextAt(state.selection.$from), null);
        assert.strictEqual(text(state), NOTE);
    });

    test('→ at the end of a part moves on, ← at a start moves back, and both enter a note from outside', () => {
        const base = stateOf(NOTE);
        let state = press(caretAt(base, posOf(base.doc, 'beta') + 4), 'ArrowRight');
        assert.strictEqual(text(type(state, 'X')), 'Alpha ++beta|Xbody++ gamma.\n');
        state = press(caretAt(base, posOf(base.doc, 'body') + 4), 'ArrowRight');
        assert.strictEqual(text(type(state, 'X')), 'Alpha ++beta|body++X gamma.\n');
        state = press(caretAt(base, posOf(base.doc, 'body')), 'ArrowLeft');
        assert.strictEqual(text(type(state, 'X')), 'Alpha ++betaX|body++ gamma.\n');
        state = press(caretAt(base, posOf(base.doc, ' gamma')), 'ArrowLeft');
        assert.strictEqual(text(type(state, 'X')), 'Alpha ++beta|bodyX++ gamma.\n', '← after a note goes to the end of its body');
        state = press(caretAt(base, posOf(base.doc, 'beta') - 2), 'ArrowRight');
        assert.strictEqual(text(type(state, 'X')), 'Alpha ++Xbeta|body++ gamma.\n', '→ before a note goes to the start of its reference');
    });

    test('Backspace at the start of an empty reference removes the whole note, no husk left', () => {
        let state = select(stateOf(NOTE), 'beta');
        state = state.apply(state.tr.deleteSelection());
        assert.strictEqual(noteContextAt(state.selection.$from)?.role, 'ref');
        state = press(state, 'Backspace');
        // Two spaces are left, written as one (a run of spaces is one in HTML).
        assert.strictEqual(text(state), 'Alpha gamma.\n');
        assert.strictEqual(text(type(state, 'X')), 'Alpha X gamma.\n', 'the caret is where the note was');
    });

    test('Backspace at the start of a reference with text selects the note, and a second one removes it', () => {
        let state = press(caretAt(stateOf(NOTE), posOf(stateOf(NOTE).doc, 'beta')), 'Backspace');
        assert.ok(state.selection instanceof NodeSelection && state.selection.node.type.name === 'sidenote');
        state = press(state, 'Backspace');
        assert.strictEqual(text(state), 'Alpha gamma.\n');
    });

    test('Backspace at the start of the body goes to the end of the reference; right after a note it selects the note', () => {
        const base = stateOf(NOTE);
        let state = press(caretAt(base, posOf(base.doc, 'body')), 'Backspace');
        assert.strictEqual(text(type(state, 'X')), 'Alpha ++betaX|body++ gamma.\n');
        state = press(caretAt(base, posOf(base.doc, ' gamma')), 'Backspace');
        assert.ok(state.selection instanceof NodeSelection && state.selection.node.type.name === 'sidenote');
    });

    test('Backspace at the start of an empty sidebar removes it', () => {
        let state = select(stateOf('Alpha @x@ gamma.\n'), 'x');
        state = press(state.apply(state.tr.deleteSelection()), 'Backspace');
        assert.strictEqual(text(state), 'Alpha gamma.\n');
    });

    test('a caret put between the reference and the body is moved into a part', () => {
        const base = stateOf(NOTE);
        const between = posOf(base.doc, 'beta') + 'beta'.length + 1;
        assert.strictEqual(base.doc.resolve(between).parent.type.name, 'sidenote');
        const state = base.apply(base.tr.setSelection(TextSelection.create(base.doc, between)));
        assert.notStrictEqual(noteContextAt(state.selection.$from), null);
    });
});
