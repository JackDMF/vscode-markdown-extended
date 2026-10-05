import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { Command, EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { PRESERVE_SOURCE_META } from '../../../src/editor/fidelity';
import { editorSchema } from '../../../src/editor/schema';
import { SIDEBAR_GLUED_AFTER, SIDEBAR_GLUED_BEFORE, SIDEBAR_GLUED_URL, serializeDocument, setLinkify, unwritableInNote } from '../../../src/editor/serialize';
import {
    NESTED_NOTE_LOCK, NOTE_BODY_PLACEHOLDER, NOTE_REF_PLACEHOLDER, NoteNodeName, inNoteOf, leaveNote, nextNotePart, noteContextAt, noteRefusal,
    previousNotePart, toggleNote, unwrapNote, unwrapNoteRefusal, wrapInNote, wrapNodeLockReason,
} from '../../../src/editor/webview/notes';
import { convertNoteRefusal, deleteObjectRefusal, objectAtSelection, removeLinkRefusal, removeSpanRefusal } from '../../../src/editor/webview/objects';
import { TOOLBAR_ACTIONS } from '../../../src/editor/webview/toolbar/actions';
import { inlineSourceTransaction, markRefusal, toggleMarkup, wrapSourceTransaction } from '../../../src/editor/webview/toolbar/commands';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { createEditorEngine } from '../../../src/editor';
import { plugins } from '../../../src/plugin/plugins';
import { hostEngine, topChildren, touched } from './helpers';

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
        // In a right sidebar, code may hold its @ (the sidebar rule skips a code span whole), and superscript too, written `\@`.
        const sidebar = select(stateOf('Mail @ write user&#64;host now @ end.\n'), 'user@host');
        assert.strictEqual(markRefusal(sidebar, code, null), null);
        const coded = run(sidebar, toggleMarkup(code, null));
        assert.strictEqual(text(coded), 'Mail @ write `user@host` now @ end.\n');
        assert.deepStrictEqual(notesAfterSave(coded), ['right_sidebar']);
        assert.strictEqual(markRefusal(sidebar, sup, null), null, 'superscript may hold it');
        const raised = run(sidebar, toggleMarkup(sup, null));
        assert.strictEqual(text(raised), 'Mail @ write ^user\\@host^ now @ end.\n');
        assert.deepStrictEqual(notesAfterSave(raised), ['right_sidebar']);
        // An edit beside a sidebar that would glue it to a letter, or a left one to a digit, is refused with what to do.
        const glued = stateOf('Alpha $side$ beta.\n');
        const space = posOf(glued.doc, 'Alpha ') + 'Alpha'.length;
        assert.strictEqual(noteRefusal(glued.tr.delete(space, space + 1)), SIDEBAR_GLUED_BEFORE);
        const after = posOf(glued.doc, ' beta');
        assert.strictEqual(noteRefusal(glued.tr.insertText('5', after)), SIDEBAR_GLUED_AFTER);
        assert.strictEqual(noteRefusal(glued.tr.insertText('x', after)), null, 'a letter after it is fine');
        // A note made of a code span that holds |: its reference would.
        const made = select(stateOf('A `a|b` c.\n'), 'a|b');
        assert.ok(wrapNodeLockReason(made, 'sidenote')?.includes('"|"'));
        assert.strictEqual(wrapInNote('sidenote')(made), false);
        assert.strictEqual(wrapNodeLockReason(made, 'right_sidebar'), null, 'a sidebar may hold | in code');
    });

    test('every mark button whose toggle would glue a sidebar to a letter is disabled with the reason the filter gives', () => {
        // Taking a mark off `x` takes its delimiters with it: `a x$y$ z`.
        for (const action of TOOLBAR_ACTIONS) {
            if (action.apply.kind !== 'mark') {
                continue;
            }
            const type = editorSchema.marks[action.apply.mark];
            const source = `a ${action.syntax.replace('text', 'x')}$y$ z.\n`;
            const state = select(stateOf(source), 'x');
            assert.deepStrictEqual(notesAfterSave(state), ['left_sidebar'], `${action.id}: ${source}`);
            const reason = markRefusal(state, type, action.apply.markup);
            assert.strictEqual(reason, SIDEBAR_GLUED_BEFORE, action.id);
            assert.strictEqual(toggleMarkup(type, action.apply.markup)(state), false, `${action.id}: not run`);
            // What the button would do, made by hand: the filter refuses it with the same reason.
            const removed = state.tr.removeMark(state.selection.from, state.selection.to, type);
            assert.strictEqual(noteRefusal(removed), reason, `${action.id}: the filter's reason`);
            assert.strictEqual(state.apply(removed).doc, state.doc, `${action.id}: the filter refuses it`);
        }
        // Remove link likewise: `[x](u)$y$` would be `x$y$`.
        const linked = stateOf('a [x](u)$y$ z.\n');
        const link = objectAtSelection(select(linked, 'x'));
        assert.ok(link?.kind === 'link');
        assert.strictEqual(removeLinkRefusal(linked, link), SIDEBAR_GLUED_BEFORE);
        const spaced = stateOf('a [x](u) $y$ z.\n');
        const free = objectAtSelection(select(spaced, 'x'));
        assert.ok(free?.kind === 'link');
        assert.strictEqual(removeLinkRefusal(spaced, free), null);
    });

    test('the host\'s re-sync is never refused', () => {
        const state = stateOf('Alpha ++the `ab` ref|body++ gamma.\n');
        const tr = state.tr.insertText('|', posOf(state.doc, 'ab') + 1).setMeta(PRESERVE_SOURCE_META, true);
        assert.strictEqual(noteRefusal(tr), null);
    });
});

suite('Editor notes: a character reference glued to a sidebar\'s marker is text, as the parser reads it', () => {
    test('an edit elsewhere in the block is saved as edited', () => {
        const list = stateOf('- a &#120;$y$ z\n- other item\n');
        const edited = list.apply(list.tr.insertText(' EDITED', posOf(list.doc, 'other') + 'other'.length));
        assert.notStrictEqual(edited.doc, list.doc, 'the edit is applied');
        assert.strictEqual(text(edited), '- a x\\$y\\$ z\n- other EDITED item\n');
        assert.deepStrictEqual(notesAfterSave(edited), []);
    });

    test('a typo fixed beside it is applied, and no toolbar button is disabled for it', () => {
        const base = stateOf('Typo heer, see REQ-&#49;$the note$ later.\n');
        const fixed = base.apply(base.tr.insertText('re', posOf(base.doc, 'heer') + 2, posOf(base.doc, 'heer') + 4));
        assert.strictEqual(text(fixed), 'Typo here, see REQ-1\\$the note\\$ later.\n');
        const word = select(base, 'Typo');
        for (const action of TOOLBAR_ACTIONS) {
            if (action.apply.kind === 'mark') {
                assert.strictEqual(markRefusal(word, editorSchema.marks[action.apply.mark], action.apply.markup), null, action.id);
            }
        }
        assert.strictEqual(wrapNodeLockReason(word, 'left_sidebar'), null);
    });

    test('a footnote added and a note\'s Edit source in that block write no sidebar the file did not hold', () => {
        const source = 'See &#120;$y$ and the claim.\n';
        const state = caretAt(stateOf(source), posOf(stateOf(source).doc, 'claim') + 'claim'.length);
        const footnote = TOOLBAR_ACTIONS.find(a => a.id === 'footnote-reference')?.apply;
        assert.ok(footnote?.kind === 'wrap-source');
        const tr = wrapSourceTransaction(state, footnote, { eol: '\n', defaultWrap: 90, documentText: source });
        assert.ok(tr);
        const noted = state.apply(tr);
        assert.strictEqual(noted.doc.child(0).attrs.src, 'See x\\$y\\$ and the claim[^1].\n');
        assert.deepStrictEqual(notesAfterSave(noted), []);
        const withNote = 'See &#120;$y$ and the ++claim|old++.\n';
        const inNote = caretAt(stateOf(withNote), posOf(stateOf(withNote).doc, 'claim') + 1);
        const note = objectAtSelection(inNote);
        assert.ok(note?.kind === 'note');
        const edited = inNote.apply(inlineSourceTransaction(inNote, note.from, note.to, '++claim|new++', note.node.marks, { eol: '\n', defaultWrap: 90, documentText: withNote }) as Transaction);
        assert.strictEqual(text(edited), 'See x\\$y\\$ and the ++claim|new++.\n');
        assert.deepStrictEqual(notesAfterSave(edited), ['sidenote']);
    });
});

suite('Editor notes: a seam the file already holds is never refused, only one the edit makes', () => {
    const linkifyOff = createEditorEngine({ linkify: false, typographer: false, plugins, extend: [] });
    const read = (source: string, md = hostEngine()) => EditorState.create({ doc: parseDocument(md, source, {}).doc, plugins: editorPlugins() });
    const sidebarAt = (doc: Node) => {
        let at = -1;
        doc.descendants((node, pos) => {
            at = at < 0 && node.type.name.endsWith('_sidebar') ? pos : at;
        });
        return at;
    };
    /** The sidebars `markdown` holds, read by `md`. */
    const sidebarsIn = (markdown: string, md = hostEngine()) => {
        const found: string[] = [];
        parseDocument(md, markdown, {}).doc.descendants(node => {
            if (node.type.name.endsWith('_sidebar')) {
                found.push(node.type.name);
            }
        });
        return found;
    };
    /** The sidebars `state`'s document holds once saved and read again, by the engine it was read with. */
    const sidebarsAfterSave = (state: EditorState, md = hostEngine()) => sidebarsIn(text(state), md);
    /** `doc` written by rule, every block as if edited, as the save after an edit the filter let through would write it. */
    const writtenByRule = (doc: Node) => serializeDocument({ doc: doc.type.create(null, topChildren(doc).map(n => touched(n))), eol: '\n', tail: '' }, { defaultWrap: 90 });
    // The page reads URLs as the engine that parsed its document does (`setLinkify`); every test leaves it on, as it starts.
    teardown(() => setLinkify(true));
    const files: [string, string, MarkdownIt][] = [
        ['a URL in parentheses', 'See (http://e.com)$note$ here.\n', hostEngine()],
        ['a URL in quotes', 'See "http://e.com"$note$ here.\n', hostEngine()],
        ['a URL before a comma', 'See http://e.com,$note$ here.\n', hostEngine()],
        ['a URL ending in /, linkify off', 'See http://e.com/$note$ here.\n', linkifyOff],
        ['a URL ending in /, linkify off, right sidebar', 'See http://e.com/@note@ here.\n', linkifyOff],
    ];

    test('a sidebar the parser read after a URL leaves its paragraph editable: a typo is fixed, bold applies', () => {
        for (const [label, source, md] of files) {
            setLinkify(md === linkifyOff ? false : true);
            const state = read(source, md);
            assert.strictEqual(unwritableInNote(state.doc), null, `${label}: linkify reads no URL into the marker`);
            const typed = state.apply(state.tr.insertText('X', posOf(state.doc, 'See') + 1));
            // Compared by identity, not by `notStrictEqual`: a failure would print two whole documents.
            assert.ok(typed.doc !== state.doc, `${label}: the letter is applied`);
            assert.strictEqual(text(typed), source.replace('See', 'SXee'), label);
            const word = select(state, 'See');
            assert.strictEqual(markRefusal(word, editorSchema.marks.strong, '**'), null, `${label}: bold is not disabled`);
            assert.strictEqual(text(run(word, toggleMarkup(editorSchema.marks.strong, '**'))), source.replace('See', '**See**'), label);
            assert.strictEqual(wrapNodeLockReason(word, 'sidenote'), null, `${label}: a note can be made`);
        }
    });

    test('a seam the edit makes is still refused, in a plain paragraph and beside one the file holds', () => {
        // Deleting the space glues the sidebar to the URL.
        const spaced = read('See http://e.com/ $note$ here.\n');
        const sidebar = posOf(spaced.doc, 'note') - 1;
        const glue = spaced.tr.delete(sidebar - 1, sidebar);
        assert.strictEqual(noteRefusal(glue), SIDEBAR_GLUED_URL);
        assert.ok(spaced.apply(glue).doc === spaced.doc, 'the filter refuses it');
        // A second sidebar in a paragraph whose first one is held after a URL is judged on its own.
        const both = read('See (http://e.com)$note$ and $more$ here.\n');
        const second = both.tr.delete(posOf(both.doc, 'and ') + 3, posOf(both.doc, 'and ') + 4);
        assert.strictEqual(noteRefusal(second), SIDEBAR_GLUED_BEFORE);
        assert.ok(both.apply(second).doc === both.doc, 'the filter refuses it');
        // The closing side of a sidebar is its own seam: a digit after it is new.
        const closed = read('See (http://e.com)$note$ here.\n');
        const digit = closed.tr.insertText('5', posOf(closed.doc, ' here'));
        assert.strictEqual(noteRefusal(digit), SIDEBAR_GLUED_AFTER);
        // A letter put before a marker the file holds after a URL: the plugin's own rule, a loss the edit makes.
        const letter = closed.tr.insertText('x', posOf(closed.doc, 'note') - 1);
        assert.strictEqual(noteRefusal(letter), SIDEBAR_GLUED_BEFORE);
        // A sidebar converted to the other kind is judged on its own: a `$` closer before a digit is new.
        const right = read('a @y@5 z.\n');
        assert.strictEqual(convertNoteRefusal(right, sidebarAt(right.doc)), SIDEBAR_GLUED_AFTER);
    });

    test('Convert on a sidebar held after a URL is decided by linkify on the converted text', () => {
        // linkify-it reads `@` and `$` apart: `http://e.com,@x@` is one address, `(http://e.com)@x@` stops at `)`.
        for (const [source, reason] of [
            ['See (http://e.com)$x$ here.\n', null],
            ['See http://e.com,$x$ here.\n', SIDEBAR_GLUED_URL],
        ] as [string, string | null][]) {
            const held = read(source);
            const at = sidebarAt(held.doc);
            const converted = held.tr.setNodeMarkup(at, editorSchema.nodes.right_sidebar);
            assert.strictEqual(noteRefusal(converted), reason, `${source}: a kind changed in place`);
            assert.strictEqual(convertNoteRefusal(held, at), reason, `${source}: Convert`);
            if (reason === null) {
                assert.deepStrictEqual(sidebarsAfterSave(held.apply(converted)), ['right_sidebar'], `${source}: read back as converted`);
            }
        }
    });

    test('an edit after which linkify reads a marker the file holds into the URL is refused, wherever it is made', () => {
        const at = (needle: string, offset = 0) => (s: EditorState) => posOf(s.doc, needle) + offset;
        const edits: [string, string, (state: EditorState) => Transaction][] = [
            // The URL's closing bracket or quote deleted, or replaced by a character a URL holds.
            ['delete ")"', 'See (http://e.com/)$note$ here.\n', s => s.tr.delete(sidebarAt(s.doc) - 1, sidebarAt(s.doc))],
            ['delete the closing quote', 'See "http://e.com/"$note$ here.\n', s => s.tr.delete(sidebarAt(s.doc) - 1, sidebarAt(s.doc))],
            ['replace ")" by "/"', 'See (http://e.com)$note$ here.\n', s => s.tr.insertText('/', sidebarAt(s.doc) - 1, sidebarAt(s.doc))],
            ['replace ")" by ","', 'See (http://e.com/)$note$ here.\n', s => s.tr.insertText(',', sidebarAt(s.doc) - 1, sidebarAt(s.doc))],
            // A bracket the URL opened, closed by the sidebar's text or the text after it: linkify reads on through the marker.
            ['")" typed at the end of the sidebar', 'See http://e.com/($note$ here.\n', s => s.tr.insertText(')', at('note', 4)(s))],
            ['")" typed at the start of the sidebar', 'See http://e.com/($note$ here.\n', s => s.tr.insertText(')', at('note')(s))],
            ['")" typed right after the closer', 'See http://e.com/($note$ here.\n', s => s.tr.insertText(')', at(' here')(s))],
            ['")x" typed right after the closer', 'See http://e.com/($note$ here.\n', s => s.tr.insertText(')x', at(' here')(s))],
            ['" x" deleted after the closer', 'See http://e.com/($note$ x) here.\n', s => s.tr.delete(at(' x')(s), at(' x', 2)(s))],
            ['"]" typed at the end of the sidebar', 'See http://e.com/[$note$ here.\n', s => s.tr.insertText(']', at('note', 4)(s))],
            ['"}" typed at the end of the sidebar', 'See http://e.com/{$note$ here.\n', s => s.tr.insertText('}', at('note', 4)(s))],
        ];
        for (const [label, source, edit] of edits) {
            const state = read(source);
            assert.deepStrictEqual(sidebarsAfterSave(state), ['left_sidebar'], `${label}: the file holds a sidebar`);
            const tr = edit(state);
            assert.strictEqual(noteRefusal(tr), SIDEBAR_GLUED_URL, label);
            assert.ok(state.apply(tr).doc === state.doc, `${label}: the filter refuses it`);
            // What it prevents: written anyway, the sidebar is part of the address.
            assert.deepStrictEqual(sidebarsIn(writtenByRule(tr.doc)), [], `${label}: the loss`);
            // Elsewhere in the paragraph, before the scheme and after the sidebar, edits still apply.
            // (A `[` in text is written escaped, which ends no URL earlier: the sidebar was never part of it.)
            const typed = state.apply(state.tr.insertText('X', posOf(state.doc, 'See') + 1));
            assert.strictEqual(text(typed).replace('\\[', '['), source.replace('See', 'SXee'), `${label}: before the scheme`);
            assert.deepStrictEqual(sidebarsAfterSave(typed), ['left_sidebar'], `${label}: before the scheme, read back`);
            const after = state.apply(state.tr.insertText('X', posOf(state.doc, 'here') + 1));
            assert.strictEqual(text(after).replace('\\[', '['), source.replace('here', 'hXere'), `${label}: after the sidebar`);
            assert.deepStrictEqual(sidebarsAfterSave(after), ['left_sidebar'], `${label}: after the sidebar, read back`);
        }
        // Text before the scheme is not linkify's: deleting the `(` keeps the run, and the sidebar.
        const opened = read('See (http://e.com)$note$ here.\n');
        const unopened = opened.apply(opened.tr.delete(posOf(opened.doc, '('), posOf(opened.doc, '(') + 1));
        assert.strictEqual(text(unopened), 'See http://e.com)$note$ here.\n');
        assert.deepStrictEqual(notesAfterSave(unopened), ['left_sidebar']);
    });

    test('an edit linkify reads no marker into is applied: inside the sidebar, after a space in it, formatting over the URL', () => {
        const harmless: [string, string, (state: EditorState) => Transaction, string][] = [
            ['x typed into the sidebar', 'See (http://e.com)$note$ here.\n', s => s.tr.insertText('x', posOf(s.doc, 'note') + 4), 'See (http://e.com)$notex$ here.\n'],
            ['")" typed after a space in the sidebar', 'See http://e.com/($no te$ here.\n', s => s.tr.insertText(')', posOf(s.doc, 'te') + 2), 'See http://e.com/($no te)$ here.\n'],
            ['" x" deleted after a sidebar holding a space', 'See http://e.com/($a b$ x) here.\n', s => s.tr.delete(posOf(s.doc, ' x'), posOf(s.doc, ' x') + 2), 'See http://e.com/($a b$) here.\n'],
        ];
        for (const [label, source, edit, saved] of harmless) {
            const state = read(source);
            const tr = edit(state);
            assert.strictEqual(noteRefusal(tr), null, label);
            const next = state.apply(tr);
            assert.strictEqual(text(next), saved, label);
            assert.deepStrictEqual(sidebarsAfterSave(next), ['left_sidebar'], `${label}: read back`);
        }
        // Bold, italic, highlight and strikethrough over the URL and the text before it, or over its `)` alone:
        // linkify reads the delimiters as they are written, and stops before the marker.
        const source = 'See (http://e.com)$note$ here.\n';
        for (const [mark, markup] of [['strong', '**'], ['em', '*'], ['mark', '=='], ['strike', '~~']] as [string, string][]) {
            for (const needle of ['See (http://e.com)', ')']) {
                const held = read(source);
                // From `See` or the `)` to the sidebar: the URL is a text node of its own, its link's.
                const from = needle === ')' ? posOf(held.doc, ')') : posOf(held.doc, 'See');
                const state = held.apply(held.tr.setSelection(TextSelection.create(held.doc, from, sidebarAt(held.doc))));
                const type = editorSchema.marks[mark];
                assert.strictEqual(markRefusal(state, type, markup), null, `${mark} over ${needle}: not disabled`);
                const formatted = run(state, toggleMarkup(type, markup));
                assert.ok(formatted.doc !== state.doc, `${mark} over ${needle}: applied`);
                assert.deepStrictEqual(sidebarsAfterSave(formatted), ['left_sidebar'], `${mark} over ${needle}: ${text(formatted)}`);
            }
        }
    });

    test('with linkify off no URL refuses anything: a sidebar after an address is edited like any other', () => {
        setLinkify(false);
        const source = 'See http://e.com/($note$ here.\n';
        for (const [label, edit, saved] of [
            ['")" typed at the end of the sidebar', (s: EditorState) => s.tr.insertText(')', posOf(s.doc, 'note') + 4), 'See http://e.com/($note)$ here.\n'],
            ['"(" deleted', (s: EditorState) => s.tr.delete(posOf(s.doc, '('), posOf(s.doc, '(') + 1), 'See http://e.com/$note$ here.\n'],
        ] as [string, (s: EditorState) => Transaction, string][]) {
            const state = read(source, linkifyOff);
            const tr = edit(state);
            assert.strictEqual(noteRefusal(tr), null, label);
            const next = state.apply(tr);
            assert.strictEqual(text(next), saved, label);
            assert.deepStrictEqual(sidebarsAfterSave(next, linkifyOff), ['left_sidebar'], `${label}: read back with linkify off`);
        }
        // A sidebar glued to an address the edit makes, too: nothing reads the address.
        const spaced = read('See http://e.com/ $note$ here.\n', linkifyOff);
        const sidebar = posOf(spaced.doc, 'note') - 1;
        assert.strictEqual(noteRefusal(spaced.tr.delete(sidebar - 1, sidebar)), null);
    });

    test('Remove attributes and Remove image that would glue a sidebar give the filter\'s reason', () => {
        const spanned = select(read('a [x]{.c}$y$ z.\n'), 'x');
        const span = objectAtSelection(spanned);
        assert.ok(span?.kind === 'span');
        assert.strictEqual(removeSpanRefusal(spanned, span), SIDEBAR_GLUED_BEFORE);
        const free = select(read('a [x]{.c} $y$ z.\n'), 'x');
        const freeSpan = objectAtSelection(free);
        assert.ok(freeSpan?.kind === 'span');
        assert.strictEqual(removeSpanRefusal(free, freeSpan), null);
        for (const [source, reason] of [['a![i](u.png)$y$ z.\n', SIDEBAR_GLUED_BEFORE], ['a ![i](u.png)$y$ z.\n', null]] as [string, string | null][]) {
            const state = read(source);
            let image = -1;
            state.doc.descendants((node, pos) => {
                image = node.type.name === 'image' ? pos : image;
            });
            const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, image)));
            const object = objectAtSelection(selected);
            assert.ok(object?.kind === 'image', source);
            assert.strictEqual(deleteObjectRefusal(selected, object), reason, source);
        }
    });

    test('Remove note and Remove sidebar that would glue a sidebar give the filter\'s reason', () => {
        const cases: [string, string, NoteNodeName, string | null][] = [
            ['Alpha ++beta|the body++@y@ gamma.\n', 'body', 'sidenote', SIDEBAR_GLUED_BEFORE],
            ['Alpha ++beta|the body++ @y@ gamma.\n', 'body', 'sidenote', null],
            ['Alpha $beta$@y@ gamma.\n', 'beta', 'left_sidebar', SIDEBAR_GLUED_BEFORE],
            ['Alpha $beta$ @y@ gamma.\n', 'beta', 'left_sidebar', null],
            ['Alpha $beta$ @y@ gamma.\n', 'Alpha', 'left_sidebar', 'There is no note here.'],
        ];
        for (const [source, needle, name, reason] of cases) {
            const state = read(source);
            const inside = caretAt(state, posOf(state.doc, needle) + 1);
            assert.strictEqual(unwrapNoteRefusal(inside, name), reason, `${source} at ${needle}`);
            if (reason === SIDEBAR_GLUED_BEFORE) {
                assert.strictEqual(run(inside, unwrapNote(name)).doc, inside.doc, `${source}: the filter refuses it`);
            }
        }
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
