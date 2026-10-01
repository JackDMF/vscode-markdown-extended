import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { Command, EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { PRESERVE_SOURCE_META } from '../../../src/editor/fidelity';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument } from '../../../src/editor/serialize';
import {
    NESTED_NOTE_LOCK, NOTE_BODY_PLACEHOLDER, NOTE_REF_PLACEHOLDER, inNoteOf, leaveNote, nextNotePart, noteContextAt, noteRefusal, previousNotePart,
    toggleNote, unwrapNote, wrapInNote, wrapNodeLockReason,
} from '../../../src/editor/webview/notes';
import { markRefusal, toggleMarkup } from '../../../src/editor/webview/toolbar/commands';
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
function press(state: EditorState, key: string, shift = false, ctrl = false): EditorState {
    let next = state;
    const event = { key, shiftKey: shift, ctrlKey: ctrl, metaKey: false, altKey: false, keyCode: 0, type: 'keydown', preventDefault() { /* */ } };
    const view = {
        state,
        dispatch: (tr: Transaction) => {
            next = next.apply(tr);
        },
    };
    const handled = state.plugins.some(plugin => plugin.props.handleKeyDown?.call(plugin, view as never, event as unknown as KeyboardEvent));
    assert.ok(handled, `${ctrl ? 'Ctrl+' : ''}${shift ? 'Shift+' : ''}${key} is handled`);
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

/** The kinds of note node in the document's text, as the next parse reads it. */
function notesAfterSave(state: EditorState): string[] {
    const found: string[] = [];
    parseDocument(hostEngine(), text(state), {}).doc.descendants(node => {
        if (['sidenote', 'marginal_note', 'left_sidebar', 'right_sidebar'].includes(node.type.name)) {
            found.push(node.type.name);
        }
    });
    return found;
}

suite('Editor notes: what the serializer cannot write back is not made', () => {
    const sup = editorSchema.marks.sup;
    const sub = editorSchema.marks.sub;
    const code = editorSchema.marks.code;

    test('a note made inside ^sup^, ~sub~ or `code` does not carry that mark, so it survives a save', () => {
        let state = run(select(stateOf('A ^a raised run^ b.\n'), 'raised'), wrapInNote('sidenote'));
        assert.deepStrictEqual(notesAfterSave(state), ['sidenote'], text(state));
        state.doc.descendants(node => {
            if (node.type.name === 'sidenote') {
                assert.deepStrictEqual(node.marks.map(m => m.type.name), []);
            }
        });
        const coded = stateOf('A `code span` b.\n');
        state = run(caretAt(coded, posOf(coded.doc, 'span')), wrapInNote('sidenote'));
        assert.deepStrictEqual(notesAfterSave(state), ['sidenote'], text(state));
        const low = stateOf('A ~low text~ b.\n');
        state = run(caretAt(low, posOf(low.doc, 'text')), wrapInNote('marginal_note'));
        assert.deepStrictEqual(notesAfterSave(state), ['marginal_note'], text(state));
    });

    test('superscript, subscript and code toggled over a note mark its text, never the note, and the note survives a save', () => {
        // prosemirror-transform's AddMarkStep marks inline atoms and text, not
        // an inline node with content: the note is left bare, its reference
        // and body take the mark as text, and each is written inside the note.
        const base = stateOf('Alpha ++beta|body++ gamma.\n');
        const across = base.apply(base.tr.setSelection(TextSelection.create(base.doc, posOf(base.doc, 'Alpha'), posOf(base.doc, 'gamma') + 5)));
        const written: Record<string, string> = { sup: '^Alpha ^++^beta^|^body^++^ gamma^.\n', sub: '~Alpha ~++~beta~|~body~++~ gamma~.\n', code: '`Alpha `++`beta`|`body`++` gamma`.\n' };
        for (const type of [sup, sub, code]) {
            assert.strictEqual(markRefusal(across, type, null), null, type.name);
            const marked = run(across, toggleMarkup(type, null));
            marked.doc.descendants(node => {
                if (node.type.name === 'sidenote') {
                    assert.deepStrictEqual(node.marks, [], `${type.name}: the note node carries no mark`);
                }
            });
            assert.strictEqual(text(marked), written[type.name]);
            assert.deepStrictEqual(notesAfterSave(marked), ['sidenote'], text(marked));
            const reread = parseDocument(hostEngine(), text(marked), {}).doc;
            assert.strictEqual(serializeDocument({ doc: reread.type.create(null, [reread.child(0).type.create({ ...reread.child(0).attrs, src: null }, reread.child(0).content)]), eol: '\n', tail: '' }, { defaultWrap: 90 }),
                text(marked), `${type.name}: written the same again`);
        }
    });

    test('a note node carrying superscript, subscript or code — a paste can make one — is refused with the reason', () => {
        const base = stateOf('Alpha ++beta|body++ gamma.\n');
        let notePos = -1;
        base.doc.descendants((node, pos) => {
            if (node.type.name === 'sidenote') {
                notePos = pos;
            }
        });
        const note = base.doc.nodeAt(notePos) as Node;
        for (const type of [sup, sub, code]) {
            const tr = base.tr.replaceWith(notePos, notePos + note.nodeSize, note.mark([type.create()]));
            assert.ok(noteRefusal(tr)?.includes('cannot hold a note'), type.name);
            assert.strictEqual(base.apply(tr).doc, base.doc, `${type.name}: the edit is not applied`);
        }
        const bold = base.tr.replaceWith(notePos, notePos + note.nodeSize, note.mark([editorSchema.marks.strong.create()]));
        assert.strictEqual(noteRefusal(bold), null, 'bold can hold a note');
    });

    test('inside a note part, code is fine where it holds no terminator', () => {
        const coded = run(select(stateOf('Alpha ++beta ref|the body++ gamma.\n'), 'body'), toggleMarkup(code, null));
        assert.strictEqual(text(coded), 'Alpha ++beta ref|the `body`++ gamma.\n');
        assert.deepStrictEqual(notesAfterSave(coded), ['sidenote']);
    });

    test('a sidebar has no terminator: code and superscript in one may hold its marker character, and it stays a sidebar', () => {
        const sidebar = select(stateOf('Mail @ write user&#64;host now, or me&#64; @ end.\n'), 'user@host');
        assert.strictEqual(markRefusal(sidebar, code, null), null);
        assert.strictEqual(markRefusal(sidebar, sup, null), null, 'nor superscript');
        const coded = run(sidebar, toggleMarkup(code, null));
        assert.strictEqual(text(coded), 'Mail @ write `user@host` now, or me\\@ @ end.\n');
        assert.deepStrictEqual(notesAfterSave(coded), ['right_sidebar']);
        const raised = run(select(stateOf('Mail @ write me&#64; now @ end.\n'), 'me@'), toggleMarkup(sup, null));
        assert.strictEqual(text(raised), 'Mail @ write ^me\\@^ now @ end.\n');
        assert.deepStrictEqual(notesAfterSave(raised), ['right_sidebar']);
    });

    test('code holding the part\'s terminator or the marker pair is refused, whether typed, toggled or made', () => {
        // Typing | into a code span in a reference.
        const ref = stateOf('Alpha ++the `ab` ref|body++ gamma.\n');
        const inCode = caretAt(ref, posOf(ref.doc, 'ab') + 1);
        assert.strictEqual(inCode.apply(inCode.tr.insertText('|')).doc, inCode.doc, '| in code in a reference');
        assert.ok(noteRefusal(inCode.tr.insertText('|'))?.includes('"|"'));
        assert.notStrictEqual(inCode.apply(inCode.tr.insertText('x')).doc, inCode.doc, 'other characters type');
        // ++ in a code span in a body: the first + is fine, the second would close the note.
        const bodyDoc = stateOf('Alpha ++ref|see `i` here++ gamma.\n');
        let body = caretAt(bodyDoc, posOf(bodyDoc.doc, 'i') + 1);
        body = body.apply(body.tr.insertText('+'));
        assert.strictEqual(text(body), 'Alpha ++ref|see `i+` here++ gamma.\n');
        assert.strictEqual(body.apply(body.tr.insertText('+')).doc, body.doc, '++ in code in a body');
        // A note made of a code span that holds |: its reference would.
        const made = select(stateOf('A `a|b` c.\n'), 'a|b');
        assert.ok(wrapNodeLockReason(made, 'sidenote')?.includes('"|"'));
        assert.strictEqual(wrapInNote('sidenote')(made), false);
        assert.strictEqual(wrapNodeLockReason(made, 'right_sidebar'), null, 'a sidebar may hold | in code');
    });

    test('the host\'s re-sync is never refused', () => {
        const state = stateOf('Alpha ++the `ab` ref|body++ gamma.\n');
        const tr = state.tr.insertText('|', posOf(state.doc, 'ab') + 1).setMeta(PRESERVE_SOURCE_META, true);
        assert.strictEqual(noteRefusal(tr), null);
    });
});

suite('Editor notes: a note action removes its note again, keeping the text', () => {
    /** Toggle `name` with the caret right after `needle`'s first character, and what typing there then writes. */
    function toggledAt(source: string, needle: string, name: 'sidenote' | 'marginal_note' | 'left_sidebar' | 'right_sidebar'): EditorState {
        const base = stateOf(source);
        return run(caretAt(base, posOf(base.doc, needle) + 1), toggleNote(name));
    }

    test('a sidenote becomes its reference, the note dropped, the caret at the reference\'s end', () => {
        const state = toggledAt('Alpha ++beta ref|the body++ gamma.\n', 'body', 'sidenote');
        assert.strictEqual(text(state), 'Alpha beta ref gamma.\n');
        assert.strictEqual(text(type(state, 'X')), 'Alpha beta refX gamma.\n', 'the caret is at the end of the kept text');
    });

    test('a marginal note becomes its reference, marks inside kept', () => {
        const state = toggledAt('The !!lives *in* **here**|note body!! and more.\n', 'lives', 'marginal_note');
        assert.strictEqual(text(state), 'The lives *in* **here** and more.\n');
        // At the end of bold text typing goes on in bold, as anywhere.
        assert.strictEqual(text(type(state, 'X')), 'The lives *in* **hereX** and more.\n');
    });

    test('a sidebar becomes its text, marks kept; the marks the note carried go onto that text', () => {
        const left = toggledAt('A $ **L** side $ b.\n', 'side', 'left_sidebar');
        // The spaces inside the markers stay; a run of spaces is written as one.
        assert.strictEqual(text(left), 'A **L** side b.\n');
        const right = toggledAt('**Bold @right@ around** end.\n', 'right', 'right_sidebar');
        assert.strictEqual(text(right), '**Bold right around** end.\n');
        assert.strictEqual(text(type(right, 'X')), '**Bold rightX around** end.\n');
    });

    test('a selection inside the note unwraps it too; the other kind\'s action does not', () => {
        const base = select(stateOf('Alpha ++beta|body++ gamma.\n'), 'bod');
        assert.strictEqual(text(run(base, toggleNote('sidenote'))), 'Alpha beta gamma.\n');
        assert.strictEqual(unwrapNote('marginal_note')(base), false);
        assert.strictEqual(toggleNote('marginal_note')(base), false, 'and it makes no note inside a note');
    });

    test('the note node selected is unwrapped the same way', () => {
        let state = press(caretAt(stateOf('Alpha ++beta|body++ gamma.\n'), posOf(stateOf('Alpha ++beta|body++ gamma.\n').doc, 'beta')), 'Backspace');
        assert.ok(state.selection instanceof NodeSelection);
        state = run(state, toggleNote('sidenote'));
        assert.strictEqual(text(state), 'Alpha beta gamma.\n');
    });

    test('one undo brings the note back', () => {
        const source = 'Alpha ++beta|body++ gamma.\n';
        const state = toggledAt(source, 'body', 'sidenote');
        let undone = state;
        assert.ok(undo(state, tr => {
            undone = state.apply(tr);
        }));
        assert.strictEqual(text(undone), source);
    });

    test('outside a note, the action still makes one; inside one it is active', () => {
        const made = run(select(stateOf('Alpha beta gamma.\n'), 'beta'), toggleNote('sidenote'));
        assert.strictEqual(text(made), 'Alpha ++beta|note++ gamma.\n');
        assert.strictEqual(inNoteOf(made, 'sidenote'), true);
        assert.strictEqual(inNoteOf(made, 'marginal_note'), false);
    });
});
