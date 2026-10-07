import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { closeHistory, undo } from 'prosemirror-history';
import { splitBlock } from 'prosemirror-commands';
import { Command, EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { PRESERVE_SOURCE_META, asRepair, descent, fidelityPlan, fidelityPlugin, isRepair, writtenEdit } from '../../../src/editor/fidelity';
import { resyncTransaction } from '../../../src/editor/webview/resync';
import { editorSchema } from '../../../src/editor/schema';
import { DEFAULT_INLINE_ENGINE, inlineEngineDefinition } from '../../../src/editor/inlineEngine';
import {
    SIDEBAR_GLUED_AFTER, SIDEBAR_GLUED_BEFORE, SIDEBAR_GLUED_URL, SIDEBAR_LEFT_MATH, SIDEBAR_MADE, SIDEBAR_REWRITTEN, SIDEBAR_REWRITTEN_REFERENCE,
    serializeDocument, setInlineEngine, sidebarRewrittenBeside, unwritableInNote,
} from '../../../src/editor/serialize';
import {
    NESTED_NOTE_LOCK, NOTE_BODY_PLACEHOLDER, NOTE_REF_PLACEHOLDER, NoteNodeName, inNoteOf, leaveNote, nextNotePart, noteContextAt, noteRefusal,
    previousNotePart, refusableRange, toggleNote, unwrapNote, unwrapNoteRefusal, wrapInNote, wrapNodeLockReason,
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
    // The page reads a textblock as the engine that parsed its document does (`setInlineEngine`); every test leaves it as it starts.
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));
    const files: [string, string, MarkdownIt][] = [
        ['a URL in parentheses', 'See (http://e.com)$note$ here.\n', hostEngine()],
        ['a URL in quotes', 'See "http://e.com"$note$ here.\n', hostEngine()],
        ['a URL before a comma', 'See http://e.com,$note$ here.\n', hostEngine()],
        ['a URL ending in /, linkify off', 'See http://e.com/$note$ here.\n', linkifyOff],
        ['a URL ending in /, linkify off, right sidebar', 'See http://e.com/@note@ here.\n', linkifyOff],
    ];

    test('a sidebar the parser read after a URL leaves its paragraph editable: a typo is fixed, bold applies', () => {
        for (const [label, source, md] of files) {
            setInlineEngine(inlineEngineDefinition(md));
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
        setInlineEngine(inlineEngineDefinition(linkifyOff));
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

suite('Editor notes: the page reads what it writes, with the host\'s engine', () => {
    const noEmoji = createEditorEngine({ linkify: true, typographer: false, plugins: plugins.filter(p => p.name !== 'markdown-it-emoji'), extend: [] });
    const read = (source: string, md = hostEngine()) => {
        setInlineEngine(inlineEngineDefinition(md));
        return EditorState.create({ doc: parseDocument(md, source, {}).doc, plugins: editorPlugins() });
    };
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));
    const sidebarsIn = (markdown: string, md = hostEngine()) => {
        const found: string[] = [];
        parseDocument(md, markdown, {}).doc.descendants(node => {
            if (node.type.name.endsWith('_sidebar')) {
                found.push(node.type.name);
            }
        });
        return found;
    };
    /** Delete the character right before the first sidebar. */
    const deleteBeforeSidebar = (state: EditorState) => {
        let at = -1;
        state.doc.descendants((node, pos) => {
            at = at < 0 && node.type.name.endsWith('_sidebar') ? pos : at;
        });
        return state.tr.delete(at - 1, at);
    };
    const typeAtEnd = (state: EditorState) => state.tr.insertText('Z', state.doc.child(0).nodeSize - 1);

    test('the page\'s engine is the host\'s: every inline plugin its registry runs, in its order, with its settings', () => {
        assert.deepStrictEqual(inlineEngineDefinition(hostEngine()), DEFAULT_INLINE_ENGINE);
        const without = createEditorEngine({ linkify: false, typographer: true, plugins: plugins.filter(p => p.name !== 'markdown-it-kbd'), extend: [] });
        assert.deepStrictEqual(inlineEngineDefinition(without), {
            linkify: false,
            typographer: true,
            plugins: DEFAULT_INLINE_ENGINE.plugins.filter(p => p.name !== 'markdown-it-kbd'),
            math: false,
            wikiEmbeds: true,
            attrs: true,
        });
        // markdown-it-attrs is no page plugin, so only `attrs` says the host ran it.
        const noAttrs = createEditorEngine({ linkify: true, typographer: false, plugins: plugins.filter(p => p.name !== 'markdown-it-attrs'), extend: [] });
        assert.deepStrictEqual(inlineEngineDefinition(noAttrs), { ...DEFAULT_INLINE_ENGINE, attrs: false });
        // The plugin as the page runs it is the wrapper: its rules keeping a text brace from attrs are part of the fact.
        for (const rule of ['curly_attributes', 'mep_text_braces_aside', 'mep_text_braces_back']) {
            const offByExtender = createEditorEngine({ linkify: true, typographer: false, plugins, extend: [m => { m.core.ruler.disable(rule); }] });
            assert.strictEqual(inlineEngineDefinition(offByExtender).attrs, false, `${rule}: read off the engine as built`);
        }
    });

    test('a space deleted before a sidebar after an address is refused where the line as written lets linkify read on', () => {
        // `C\+\+http…` and the line start's `\-http…`: the escape ends the text before the scheme, and linkify reads the URL.
        for (const source of ['C++http://e.com/ $x$ here.\n', '-http://e.com/ $x$ here.\n']) {
            const state = read(source);
            assert.deepStrictEqual(sidebarsIn(source), ['left_sidebar'], source);
            const tr = deleteBeforeSidebar(state);
            assert.strictEqual(noteRefusal(tr), SIDEBAR_GLUED_URL, source);
            assert.ok(state.apply(tr).doc === state.doc, `${source}: the filter refuses it`);
        }
        // In the middle of a line `-http` is no scheme to linkify, and the sidebar reads back.
        const mid = read('a -http://e.com/ $x$ here.\n');
        const glued = mid.apply(deleteBeforeSidebar(mid));
        assert.strictEqual(text(glued), 'a -http://e.com/$x$ here.\n');
        assert.deepStrictEqual(sidebarsIn(text(glued)), ['left_sidebar']);
    });

    test('a sidebar the parser read after an address that is no URL to linkify stays editable', () => {
        for (const source of ['See http://e~http://f.com/$x$ here.\n', 'See http://ühttp://f.com/$x$ here.\n']) {
            const state = read(source, noEmoji);
            assert.deepStrictEqual(sidebarsIn(source, noEmoji), ['left_sidebar'], source);
            const tr = typeAtEnd(state);
            assert.strictEqual(noteRefusal(tr), null, source);
            const typed = state.apply(tr);
            assert.strictEqual(text(typed), source.replace('here.', 'here.Z'), source);
            assert.deepStrictEqual(sidebarsIn(text(typed), noEmoji), ['left_sidebar'], `${source}: read back`);
            assert.strictEqual(markRefusal(select(state, 'See'), editorSchema.marks.strong, '**'), null, `${source}: bold is not disabled`);
        }
    });

    test('a line whose character reference the editor would write out is refused with that cause, in either direction', () => {
        // The address once written out reads the sidebar in; the `.` once written out takes the address apart, which gives one up.
        for (const [source, before, after] of [
            ['See h&#116;tp://e.com/$x$ here.\n', ['left_sidebar'], []],
            ['x&#46;http://e.com/$x$\n', [], ['left_sidebar']],
        ] as [string, string[], string[]][]) {
            const state = read(source);
            assert.deepStrictEqual(sidebarsIn(source), before, source);
            const tr = typeAtEnd(state);
            assert.strictEqual(noteRefusal(tr), SIDEBAR_REWRITTEN_REFERENCE, source);
            assert.ok(state.apply(tr).doc === state.doc, `${source}: the filter refuses it`);
            // What it prevents: written anyway, the sidebar is gone or one is made.
            assert.deepStrictEqual(sidebarsIn(serializeDocument({ doc: tr.doc.type.create(null, topChildren(tr.doc).map(n => touched(n))), eol: '\n', tail: '' }, { defaultWrap: 90 })), after, `${source}: the change`);
            assert.strictEqual(markRefusal(select(state, 'x'), editorSchema.marks.strong, '**'), SIDEBAR_REWRITTEN_REFERENCE, `${source}: bold is disabled with it`);
        }
    });

    test('an edit after which text reads as a sidebar the editor does not show is refused', () => {
        // The address holds `$x$`; with its scheme broken it is no URL, and `$x$` would be a sidebar.
        const state = read('See http://e.com/$x$ here.\n');
        assert.deepStrictEqual(sidebarsIn('See http://e.com/$x$ here.\n'), []);
        const p = posOf(state.doc, 'http') + 3;
        const tr = state.tr.delete(p, p + 1);
        assert.strictEqual(noteRefusal(tr), SIDEBAR_MADE);
        assert.ok(state.apply(tr).doc === state.doc, 'the filter refuses it');
        // Text elsewhere in it is typed: the address and what it holds are read as they were.
        const typed = state.apply(state.tr.insertText('X', posOf(state.doc, 'See') + 1));
        assert.strictEqual(text(typed), 'SXee http://e.com/$x$ here.\n');
    });

    test('a paragraph holding several sidebars is judged sidebar by sidebar, where each stands', () => {
        const source = 'One $a$ two @b@ three $c$ four.\n';
        const state = read(source);
        // A digit after the last left one would make it read on to no closer.
        assert.strictEqual(noteRefusal(state.tr.insertText('5', posOf(state.doc, ' four'))), SIDEBAR_GLUED_AFTER);
        // A letter right before the right one.
        const beforeRight = posOf(state.doc, 'two') + 3;
        assert.strictEqual(noteRefusal(state.tr.delete(beforeRight, beforeRight + 1)), SIDEBAR_GLUED_BEFORE);
        // Typing between them is fine.
        const typed = state.apply(state.tr.insertText('X', posOf(state.doc, 'three')));
        assert.deepStrictEqual(sidebarsIn(text(typed)), ['left_sidebar', 'right_sidebar', 'left_sidebar']);
    });
});

suite('Editor notes: what the save writes again is what is read back', () => {
    const read = (source: string) => EditorState.create({ doc: parseDocument(hostEngine(), source, {}).doc, plugins: editorPlugins() });
    const sidebarsIn = (markdown: string) => {
        const found: string[] = [];
        parseDocument(hostEngine(), markdown, {}).doc.descendants(node => {
            if (node.type.name.endsWith('_sidebar')) {
                found.push(node.type.name);
            }
        });
        return found;
    };
    /** The textblock holding `needle`, and the top-level block around it. */
    const textblockOf = (doc: Node, needle: string) => {
        const $pos = doc.resolve(posOf(doc, needle));
        return { textblock: $pos.parent, block: $pos.node(1) };
    };
    // The other textblock spells `$x$` so that, written out, it reads otherwise: in each list, quote and table the edit is in another one.
    const besides: [string, string, string[], string[]][] = [
        ['a list, a sidebar lost', '- edit me\n- See h&#116;tp://e.com/$x$ here.\n', ['left_sidebar'], []],
        ['a quote, a sidebar lost', '> edit me\n>\n> See h&#116;tp://e.com/$x$ here.\n', ['left_sidebar'], []],
        ['a table, a sidebar lost', '| a | b |\n| - | - |\n| edit me | See h&#116;tp://e.com/$x$ here. |\n', ['left_sidebar'], []],
        ['a list, a sidebar made', '- edit me\n- x&#46;http://e.com/$x$ y\n', [], ['left_sidebar']],
        ['a quote, a sidebar made', '> edit me\n>\n> x&#46;http://e.com/$x$ y\n', [], ['left_sidebar']],
        ['a table, a sidebar made', '| a | b |\n| - | - |\n| edit me | x&#46;http://e.com/$x$ y |\n', [], ['left_sidebar']],
    ];

    test('an edit is refused where the save would write another item, paragraph or cell of its block so that it reads otherwise', () => {
        for (const [label, source, before, after] of besides) {
            const state = read(source);
            assert.deepStrictEqual(sidebarsIn(source), before, label);
            const tr = state.tr.insertText('Z', posOf(state.doc, 'edit'));
            const other = textblockOf(state.doc, 'e.com');
            assert.strictEqual(noteRefusal(tr), sidebarRewrittenBeside(other.block, other.textblock, true), label);
            assert.ok(state.apply(tr).doc === state.doc, `${label}: the filter refuses it`);
            // What it prevents: the fidelity plugin clears the block's `src`, and the save writes the other textblock out.
            const unfiltered = EditorState.create({ doc: state.doc, plugins: [fidelityPlugin()] }).apply(tr);
            assert.deepStrictEqual(sidebarsIn(text(unfiltered)), after, `${label}: the change`);
        }
    });

    test('the refusal beside an edit names the block and the textblock, and the reference only where that textblock spells one', () => {
        const state = read('| a | b |\n| - | - |\n| edit me | See h&#116;tp://e.com/$x$ here. |\n');
        const reason = noteRefusal(state.tr.insertText('Z', posOf(state.doc, 'edit')));
        assert.ok(reason?.includes('the whole table') && reason.includes('another cell') && reason.includes('character reference'), reason ?? 'none');
        // `&amp;` stands in the first item; the second reads otherwise for another cause (`\/` written out as `/`).
        const source = '- Tom &amp; Jerry\n- See http:\\/\\/e.com/$x$ here.\n';
        assert.deepStrictEqual(sidebarsIn(source), ['left_sidebar']);
        const list = read(source);
        assert.strictEqual(noteRefusal(list.tr.insertText('Z', posOf(list.doc, 'here'))), SIDEBAR_REWRITTEN, 'its own text holds no reference');
        const other = textblockOf(list.doc, 'e.com');
        assert.strictEqual(noteRefusal(list.tr.insertText('Z', posOf(list.doc, 'Tom'))), sidebarRewrittenBeside(other.block, other.textblock, false), 'beside it, neither');
    });

    test('a line whose source an earlier edit has cleared is refused without naming a cause it can no longer see', () => {
        const state = read('See h&#116;tp://e.com/$x$ here.\n');
        const cleared = EditorState.create({ doc: state.doc.type.create(null, topChildren(state.doc).map(n => touched(n))), plugins: editorPlugins() });
        assert.strictEqual(noteRefusal(cleared.tr.insertText('Z', posOf(cleared.doc, 'here'))), SIDEBAR_REWRITTEN);
    });

    test('a heading and a cell are read as their own writers write them, each marker followed through their last touches', () => {
        // The requirement prefix goes first; in the cell `\\` before code is written `&#92;`, three characters longer.
        for (const source of ['## REQ-001: See $x$ and @y@ here\n', '| a |\n| - |\n| See a\\\\`c` $x$ and @y@ here |\n']) {
            const state = read(source);
            assert.deepStrictEqual(sidebarsIn(source), ['left_sidebar', 'right_sidebar'], source);
            const tr = state.tr.insertText('Z', posOf(state.doc, 'here'));
            assert.strictEqual(noteRefusal(tr), null, source);
            assert.deepStrictEqual(sidebarsIn(text(state.apply(tr))), ['left_sidebar', 'right_sidebar'], `${source}: read back`);
            // The space before the right one deleted glues it to `and`: refused for that, found where it stands.
            const space = posOf(state.doc, 'and ') + 3;
            assert.strictEqual(noteRefusal(state.tr.delete(space, space + 1)), SIDEBAR_GLUED_BEFORE, source);
        }
    });

    test('an edit in a list whose other items hold sidebars that read back applies, and they stay sidebars', () => {
        const source = '- edit me\n- See $x$ here.\n- And @y@ there.\n';
        const state = read(source);
        const tr = state.tr.insertText('Z', posOf(state.doc, 'edit'));
        assert.strictEqual(noteRefusal(tr), null);
        const typed = state.apply(tr);
        assert.strictEqual(text(typed), source.replace('edit', 'Zedit'));
        assert.deepStrictEqual(sidebarsIn(text(typed)), ['left_sidebar', 'right_sidebar']);
    });

    test('a copy of a whole block is not checked: the save writes it from its src, as the file spells it', () => {
        const source = `- one\n- See h&#116;tp://e.com/$x$ here.\n\nEnd.\n`;
        const state = read(source);
        // A drag-copy's slice of a NodeSelection carries the same node object.
        const slice = NodeSelection.create(state.doc, 0).content();
        assert.ok(slice.content.firstChild === state.doc.child(0));
        const tr = state.tr.replaceRange(state.doc.content.size, state.doc.content.size, slice);
        assert.strictEqual(noteRefusal(tr), null);
        const copied = state.apply(tr);
        assert.strictEqual(text(copied), `${source}\n- one\n- See h&#116;tp://e.com/$x$ here.\n`);
        assert.deepStrictEqual(sidebarsIn(text(copied)), ['left_sidebar', 'left_sidebar']);
    });
});

suite('Editor notes: the check reads the plan the fidelity plugin applies', () => {
    const SPELLED = 'See h&#116;tp://e.com/$x$ here';
    const read = (source: string) => EditorState.create({ doc: parseDocument(hostEngine(), source, {}).doc, plugins: editorPlugins() });
    /** A drag-copy of the whole top-level block at `from`, dropped at `at`: its slice carries the same node object. */
    const copyBlock = (state: EditorState, from: number, at: number) => {
        const slice = NodeSelection.create(state.doc, from).content();
        assert.ok(slice.content.firstChild === state.doc.nodeAt(from));
        return state.tr.replaceRange(at, at, slice);
    };

    test('a copy of a heading carrying an id is written without it, by rule, and refused where it would then lose its sidebar', () => {
        const source = `## ${SPELLED} {#t}\n\nEnd.\n`;
        const state = read(source);
        const tr = copyBlock(state, 0, state.doc.content.size);
        assert.strictEqual(noteRefusal(tr), SIDEBAR_REWRITTEN_REFERENCE);
        assert.strictEqual(state.applyTransaction(tr).transactions.length, 0, 'the filter drops it');
    });

    test('a copy dropped before its original is the copy: refused for the copy, and the original is not rewritten', () => {
        const source = `Intro.\n\n## ${SPELLED} {#t}\n\nBody.\n`;
        const state = read(source);
        const tr = copyBlock(state, state.doc.child(0).nodeSize, 0);
        assert.strictEqual(noteRefusal(tr), SIDEBAR_REWRITTEN_REFERENCE);
        // The plan rewrites the copy at the start, and not the original.
        assert.deepStrictEqual(writtenEdit(tr).rewritten.map(b => [b.offset, b.copyOf]), [[0, state.doc.child(0).nodeSize]]);
        // Where nothing reads otherwise, the copy applies, and the original keeps its id where it stands.
        const plain = read('Intro.\n\n## Plain {#t}\n\nBody.\n');
        const copied = plain.apply(copyBlock(plain, plain.doc.child(0).nodeSize, 0));
        assert.strictEqual(text(copied), '## Plain\n\nIntro.\n\n## Plain {#t}\n\nBody.\n');
        assert.deepStrictEqual(topChildren(copied.doc).filter(n => n.type.name === 'heading').map(n => n.attrs.anchor as unknown), [null, 't']);
    });

    test('a copy keeps its classes and every other attribute and loses only its ids, its items\' too: page and save agree', () => {
        /** Every literal and id the page holds, by top-level block: its own, its anchor, its items'. */
        const held = (doc: Node) => topChildren(doc).map(n => {
            const items: unknown[] = [];
            n.descendants(d => {
                if (d.type.name === 'list_item') {
                    items.push(d.attrs.literal);
                }
            });
            return [n.attrs.attrsSuffix ?? null, n.attrs.anchor ?? null, items] as unknown;
        });
        const cases: [string, string, boolean][] = [
            // [block, its copy as saved, whether the copy keeps its src: nothing of it changes]
            ['A wide one. {.wide #w}', 'A wide one. {.wide}', false],
            ['Classed. {.c}', 'Classed. {.c}', true],
            ['## Title {.unnumbered}', '## Title {.unnumbered}', true],
            ['## Head {.c #t}', '## Head {.c}', false],
            ['- one\n- two\n{.wide}', '- one\n- two\n{.wide}', true],
            ['- one {.a}\n- two {.b}\n{.wide}', '- one {.a}\n- two {.b}\n{.wide}', true],
            ['- one {.a}\n- two {.b}', '- one {.a}\n- two {.b}', true],
            ['- one {#i1}\n- two', '- one\n- two', false],
            ['- one {#i1}\n- two\n{.wide}', '- one\n- two\n{.wide}', false],
            ['- one {#i1 .x}\n- two {.b}\n{.wide #l}', '- one {.x}\n- two {.b}\n{.wide}', false],
            ['Text. {title="a{b" #w}', 'Text. {title="a{b"}', false],
            ['- one {title="a{b" #i}\n- two', '- one {title="a{b"}\n- two', false],
            ['Text. {title="a}b c" #w .c}', 'Text. {title="a}b c" .c}', false],
            ['Text. {k=a"b" #w}', 'Text. {k=a"b"}', false],
            ['Text. {title="a "b"" #w}', 'Text.', false],
            ['> q\n> {.note #n}', '> q\n> {.note}', false],
            ['| a |\n| - |\n| b |\n{.grid}', '| a |\n| - |\n| b |\n{.grid}', true],
        ];
        for (const [block, copy, keepsSrc] of cases) {
            const source = `${block}\n\nEnd.\n`;
            const state = read(source);
            const tr = copyBlock(state, 0, state.doc.content.size);
            assert.strictEqual(noteRefusal(tr), null, block);
            const copied = state.apply(tr);
            assert.strictEqual(text(copied), `${source}\n${copy}\n`, block);
            assert.deepStrictEqual(held(copied.doc), held(parseDocument(hostEngine(), text(copied), {}).doc), `${block}: what the page shows is what is read back`);
            assert.strictEqual(copied.doc.child(0).attrs.src, state.doc.child(0).attrs.src, `${block}: the original keeps its src`);
            assert.strictEqual(copied.doc.lastChild?.attrs.src === state.doc.child(0).attrs.src, keepsSrc, `${block}: the copy's src`);
        }
    });

    test('the literal a copy is saved with reads in the preview as the original\'s attributes minus its id', () => {
        const md = hostEngine();
        const attrsOf = (source: string) => md.parse(source, {}).filter(t => t.attrs !== null && (t.type === 'paragraph_open' || t.type === 'list_item_open'))
            .map(t => (t.attrs ?? []).map(([n, v]) => [n, v]));
        for (const block of [
            'Text. {title="a{b" #w}', '- one {title="a{b" #i}\n- two', 'Text. {title="a}b c" #w .c}',
            'Text. {data-x="a=b" title=\'q\' #w}',
        ]) {
            const source = `${block}\n\nEnd.\n`;
            const state = read(source);
            const saved = text(state.apply(copyBlock(state, 0, state.doc.content.size)));
            assert.ok(saved.startsWith(`${source}\n`), block);
            const original = attrsOf(block)[0];
            assert.ok(original.some(([n]) => n === 'title'), `${block}: the preview reads the title`);
            assert.deepStrictEqual(attrsOf(saved.slice(source.length + 1))[0], original.filter(([n]) => n !== 'id'), `${block}: the copy reads as the original, minus its id`);
        }
    });

    test('a copy\'s literal is one the preview reads as attributes, or none: never one it shows as text', () => {
        const md = hostEngine();
        const holders = new Set(['paragraph_open', 'list_item_open', 'heading_open']);
        /** The attributes the host gives the first paragraph, item or heading of `source`, and whether a `{` is left in its text. */
        const readOf = (source: string) => {
            const tokens = md.parse(source, {});
            const holder = tokens.find(t => holders.has(t.type) && t.attrs !== null) ?? null;
            const leftover = tokens.some(t => t.type === 'inline' && (t.children ?? []).some(c => c.type === 'text' && c.content.includes('{')));
            return { attrs: (holder?.attrs ?? []).map(([n, v]) => [n, v]), leftover };
        };
        for (const [block, copy] of [
            // A `"` inside a bare value stays bare: escaped, the preview showed the copy's `{…}` as text.
            ['Text. {k=a"b" #w}', 'Text. {k=a"b"}'],
            ['- one {k=a"b" #i}\n- two', '- one {k=a"b"}\n- two'],
            ['## Head {k=a"b" #t}', '## Head {k=a"b"}'],
            ['Text. {k=a"b" c #w}', 'Text. {k=a"b" c=""}'],
            // A value with a space and a `"` has no literal the preview reads back: the copy has none.
            ['Text. {title="a "b"" #w}', 'Text.'],
            ['- one {title="a "b"" #i}\n- two', '- one\n- two'],
            ['## Head {title="a "b"" #t}', '## Head'],
        ]) {
            const source = `${block}\n\nEnd.\n`;
            const state = read(source);
            const saved = text(state.apply(copyBlock(state, 0, state.doc.content.size)));
            assert.strictEqual(saved, `${source}\n${copy}\n`, block);
            const original = readOf(block);
            assert.ok(!original.leftover && original.attrs.some(([n]) => n === 'id'), `${block}: the preview reads the original's attributes`);
            const back = readOf(copy);
            assert.strictEqual(back.leftover, false, `${block}: the preview shows nothing of the copy's literal as text`);
            const rest = original.attrs.filter(([n]) => n !== 'id');
            assert.deepStrictEqual(back.attrs, copy.includes('{') ? rest : [], `${block}: the copy reads as the original minus its id, or has no attributes`);
        }
    });

    test('a copy dropped directly before or after its original is the copy, and the original keeps its id and its src', () => {
        const heading = (doc: Node) => topChildren(doc).map(n => (n.attrs.anchor ?? n.attrs.attrsSuffix ?? null) as unknown);
        for (const [source, copied] of [
            ['Intro.\n\n## Head {#t}\n\nBody.\n', 'Intro.\n\n## Head\n\n## Head {#t}\n\nBody.\n'],
            ['Intro.\n\nA wide one. {.wide #w}\n\nBody.\n', 'Intro.\n\nA wide one. {.wide}\n\nA wide one. {.wide #w}\n\nBody.\n'],
            ['## Head {#t}\n\nBody.\n', '## Head\n\n## Head {#t}\n\nBody.\n'],
            ['A wide one. {.wide #w}\n', 'A wide one. {.wide}\n\nA wide one. {.wide #w}\n'],
        ]) {
            const state = read(source);
            const index = state.doc.child(0).type.name === 'paragraph' && state.doc.childCount > 2 ? 1 : 0;
            const at = index === 0 ? 0 : state.doc.child(0).nodeSize;
            const tr = copyBlock(state, at, at);
            const original = state.doc.child(index);
            const result = state.apply(tr);
            assert.strictEqual(text(result), copied, source);
            assert.strictEqual(result.doc.child(index + 1).attrs.src, original.attrs.src, `${source}: the original is not rewritten`);
            // The lenses follow a block the same way: the original's, not the copy's.
            const from = descent([tr], state.doc, tr.doc);
            assert.strictEqual(from[index + 1], index, `${source}: the original descends from itself`);
            assert.strictEqual(from[index], -1, `${source}: the copy descends from none`);
            assert.deepStrictEqual(heading(result.doc), heading(parseDocument(hostEngine(), copied, {}).doc), `${source}: page and save agree`);
        }

        // A list carrying `{.wide}` keeps it on both; the copy's src is the original's, the original's not rewritten.
        const list = read('Intro.\n\n- one {#i1}\n- two\n{.wide}\n\nBody.\n');
        const listCopied = list.apply(copyBlock(list, list.doc.child(0).nodeSize, list.doc.child(0).nodeSize));
        assert.deepStrictEqual(topChildren(listCopied.doc).map(n => [n.attrs.attrsSuffix ?? null, n.firstChild?.attrs.literal ?? null]),
            [[null, null], ['{.wide}', null], ['{.wide}', '{#i1}'], [null, null]]);
        assert.strictEqual(listCopied.doc.child(2).attrs.src, list.doc.child(1).attrs.src);

        // A run of blocks pasted directly before itself: both of the run are copies.
        const run = read('Intro.\n\n## Head {#t}\n\nA wide one. {.wide #w}\n\nBody.\n');
        const runFrom = run.doc.child(0).nodeSize;
        const runTr = run.tr.replaceRange(runFrom, runFrom, run.doc.slice(runFrom, runFrom + run.doc.child(1).nodeSize + run.doc.child(2).nodeSize));
        assert.ok(runTr.doc.child(1) === run.doc.child(1), 'the slice carries the same objects');
        assert.strictEqual(text(run.apply(runTr)), 'Intro.\n\n## Head\n\nA wide one. {.wide}\n\n## Head {#t}\n\nA wide one. {.wide #w}\n\nBody.\n');
        assert.deepStrictEqual(descent([runTr], run.doc, runTr.doc), [0, -1, -1, 1, 2, 3]);

        // The mirror, at the end: a copy directly after its original, in a transaction that also types
        // into an earlier block, is the copy too (the original is the one the end walk passes first).
        const tail = read('Intro.\n\n## Head {#t}\n\nBody.\n');
        const after = tail.doc.child(0).nodeSize + tail.doc.child(1).nodeSize;
        const tailTr = tail.tr.insertText('Z', posOf(tail.doc, 'Intro'));
        tailTr.replaceRange(tailTr.mapping.map(after), tailTr.mapping.map(after), NodeSelection.create(tail.doc, tail.doc.child(0).nodeSize).content());
        assert.ok(tailTr.doc.child(2) === tail.doc.child(1), 'the copy is the same object');
        const tailed = tail.apply(tailTr);
        assert.strictEqual(text(tailed), 'ZIntro.\n\n## Head {#t}\n\n## Head\n\nBody.\n');
        assert.strictEqual(tailed.doc.child(1).attrs.src, tail.doc.child(1).attrs.src, 'the original is not rewritten');
        assert.deepStrictEqual(descent([tailTr], tail.doc, tailTr.doc), [0, 1, -1, 2]);
    });

    test('the repair the plugin appends is exactly the plan the check read', () => {
        const cases: [string, (state: EditorState) => Transaction][] = [
            ['typing in a heading', s => s.tr.insertText('Z', posOf(s.doc, 'Plain'))],
            ['a copied paragraph with a literal', s => copyBlock(s, s.doc.child(0).nodeSize + s.doc.child(1).nodeSize, s.doc.content.size)],
            ['a copied heading carrying an id', s => copyBlock(s, s.doc.child(0).nodeSize, s.doc.content.size)],
            ['Enter in a paragraph carrying a literal', s => s.tr.split(posOf(s.doc, 'one.'))],
        ];
        for (const [label, make] of cases) {
            const state = read(`- edit me\n- ${SPELLED}.\n\n## Plain {#t}\n\nA wide one. {.wide #w}\n`);
            const tr = make(state);
            const plan = fidelityPlan([tr], tr.before, tr.doc);
            assert.ok(plan.updates.size > 0, `${label}: the plan changes something`);
            const checked = writtenEdit(tr).doc;
            const result = state.applyTransaction(tr);
            assert.strictEqual(result.transactions[0], tr, `${label}: applies`);
            assert.strictEqual(result.transactions.length, 2, `${label}: one repair`);
            assert.ok(result.state.doc.eq(checked), `${label}: the document checked is the one the repair makes`);
            plan.updates.forEach((attrs, pos) => {
                assert.deepStrictEqual({ ...result.state.doc.nodeAt(pos)?.attrs }, { ...attrs }, `${label}: the repair sets the planned attributes at ${pos}`);
            });
        }
    });
});

suite('Editor notes: what the page\'s plugins append to an edit is a repair, which no filter refuses', () => {
    const SPELLED = 'See h&#116;tp://e.com/$x$ here.';
    const read = (source: string) => EditorState.create({ doc: parseDocument(hostEngine(), source, {}).doc, plugins: editorPlugins() });
    /** `tr` through every filter and appender, as the view dispatches it: it applies, and all that follows it is a repair. */
    const dispatch = (state: EditorState, tr: Transaction, label: string, appends = true) => {
        const result = state.applyTransaction(tr);
        assert.strictEqual(result.transactions[0], tr, `${label}: the edit applies`);
        assert.strictEqual(result.transactions.length > 1, appends, `${label}: whether something is appended`);
        assert.ok(result.transactions.slice(1).every(isRepair), `${label}: every appended transaction is a repair`);
        return result.state;
    };
    /** What the fidelity plugin appends to `tr` alone — the transaction a filter once dropped, with a refusal hint. */
    const fidelityRepair = (state: EditorState, tr: Transaction) => {
        const plain = EditorState.create({ doc: state.doc, selection: state.selection });
        return fidelityPlugin().spec.appendTransaction?.call(fidelityPlugin(), [tr], plain, plain.apply(tr)) as Transaction;
    };
    // Beside the edited paragraph, a block holding a textblock the file spells so that, written by rule, it reads otherwise.
    const besides: [string, string][] = [
        ['a paragraph', `${SPELLED}\n`],
        ['a list', `- one\n- ${SPELLED}\n`],
        ['a quote', `> one\n>\n> ${SPELLED}\n`],
        ['a table', `| a | b |\n| - | - |\n| c | ${SPELLED} |\n`],
    ];

    test('Enter beside such a block applies with no refusal, and the save writes the edited paragraphs fresh and that block as the file spells it', () => {
        for (const [label, block] of besides) {
            const state = read(`Alpha beta\n\n${block}`);
            const at = caretAt(state, posOf(state.doc, 'beta'));
            let tr: Transaction | undefined;
            assert.ok(splitBlock(at, t => {
                tr = t;
            }), label);
            const repair = fidelityRepair(at, tr as Transaction);
            assert.ok(isRepair(repair), label);
            // Every plugin's filter takes it: none refuses it, so no hint is shown.
            const applied = at.apply(tr as Transaction);
            assert.ok(applied.plugins.every(p => p.spec.filterTransaction?.call(p, repair, applied) ?? true), `${label}: no filter refuses the repair`);
            const next = dispatch(at, tr as Transaction, label);
            assert.strictEqual(next.doc.child(0).attrs.src, null, `${label}: the edited paragraph is written fresh`);
            assert.strictEqual(text(next), `Alpha\n\nbeta\n\n${block}`, label);
        }
    });

    test('an undo past a re-sync has the src it no longer matches cleared, across a block it does not touch', () => {
        const source = `First.\n\n- one\n- ${SPELLED}\n\nSecond.\n`;
        let state = read(source);
        const typeBoth = (s: EditorState, word: string) => {
            // The later position first, so the earlier one holds.
            const tr = s.tr.insertText(word, posOf(s.doc, 'Second'));
            return tr.insertText(word, posOf(s.doc, 'First'));
        };
        state = dispatch(state, typeBoth(state, 'A '), 'one edit in two paragraphs');
        // A second history event, which finds both `src` already cleared.
        state = dispatch(state, closeHistory(typeBoth(state, 'B ')), 'a second one', false);
        // The host's parse of what the page sent: both paragraphs get a `src` no history event recorded.
        state = state.apply(resyncTransaction(state, parseDocument(hostEngine(), text(state), {}).doc));
        assert.notStrictEqual(state.doc.child(0).attrs.src, null);
        let undoTr: Transaction | undefined;
        assert.ok(undo(state, t => {
            undoTr = t;
        }));
        const undone = dispatch(state, undoTr as Transaction, 'the undo');
        assert.strictEqual(undone.doc.child(0).attrs.src, null);
        assert.strictEqual(undone.doc.child(2).attrs.src, null);
        assert.strictEqual(text(undone), `A First.\n\n- one\n- ${SPELLED}\n\nA Second.\n`);
    });

    test('the tables\' fix-ups are repairs too: a body cell made a header, a row left with a hole', () => {
        const state = read('| a | b |\n| - | - |\n| c | d |\n');
        const $c = state.doc.resolve(posOf(state.doc, 'c'));
        const cellPos = $c.before($c.depth);
        const cell = $c.parent;
        const header = dispatch(state, state.tr.setNodeMarkup(cellPos, editorSchema.nodes.table_header, cell.attrs), 'a header cell in the body');
        assert.strictEqual(header.doc.resolve(posOf(header.doc, 'c')).parent.type, editorSchema.nodes.table_cell, 'normalised');
        const hole = dispatch(state, state.tr.delete(cellPos, cellPos + cell.nodeSize), 'a row with a hole');
        assert.strictEqual(hole.doc.child(0).child(1).childCount, 2, 'the row is filled again');
        // Both filters, the notes' and the tables', decide over this range: a repair has none.
        assert.strictEqual(refusableRange(asRepair(state.tr.insertText('x', posOf(state.doc, 'd')))), null);
    });
});

suite('Editor notes: with VS Code\'s math reading $, no left sidebar is made', () => {
    /** The extender VS Code's math adds, as far as the definition reads it: an inline rule `math_inline` after `escape`. */
    const mathLike = (md: MarkdownIt) => {
        md.inline.ruler.after('escape', 'math_inline', () => false);
        return md;
    };
    const read = (source: string) => {
        setInlineEngine({ ...DEFAULT_INLINE_ENGINE, math: true });
        return EditorState.create({ doc: parseDocument(hostEngine(), source, {}).doc, plugins: editorPlugins() });
    };
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));
    const sidebarAt = (doc: Node) => {
        let at = -1;
        doc.descendants((node, pos) => {
            at = at < 0 && node.type.name.endsWith('_sidebar') ? pos : at;
        });
        return at;
    };

    test('the definition says math is on when the engine holds its rule, enabled, and off otherwise', () => {
        assert.strictEqual(inlineEngineDefinition(hostEngine([mathLike])).math, true);
        assert.strictEqual(inlineEngineDefinition(hostEngine()).math, false);
        const disabled = (md: MarkdownIt) => {
            mathLike(md).inline.ruler.disable('math_inline');
            return md;
        };
        assert.strictEqual(inlineEngineDefinition(hostEngine([disabled])).math, false, 'a disabled rule reads nothing');
    });

    test('Left sidebar and Move to left are disabled with the math reason; right sidebars are not affected', () => {
        const state = read('See @a note@ here.\n');
        assert.strictEqual(convertNoteRefusal(state, sidebarAt(state.doc)), SIDEBAR_LEFT_MATH, 'Move to left');
        const word = select(state, 'here');
        assert.strictEqual(wrapNodeLockReason(word, 'left_sidebar'), SIDEBAR_LEFT_MATH, 'Left sidebar');
        assert.strictEqual(wrapNodeLockReason(word, 'right_sidebar'), null, 'Right sidebar');
        assert.strictEqual(noteRefusal(state.tr.insertText('Z', posOf(state.doc, 'here'))), null, 'typing beside a right sidebar');
        assert.strictEqual(markRefusal(select(state, 'See'), editorSchema.marks.strong, '**'), null, 'bold');
    });

    test('the filter refuses any edit that would leave a left sidebar', () => {
        const state = read('See here.\n');
        const at = posOf(state.doc, 'here');
        const tr = state.tr.insert(at, [editorSchema.nodes.left_sidebar.create(null, editorSchema.text('note')), editorSchema.text(' ')]);
        assert.strictEqual(noteRefusal(tr), SIDEBAR_LEFT_MATH);
        assert.ok(state.apply(tr).doc === state.doc, 'the filter refuses it');
        // Without math the same insertion is made.
        setInlineEngine(DEFAULT_INLINE_ENGINE);
        assert.strictEqual(noteRefusal(tr), null);
    });

    test('a left sidebar glued to a letter is refused with the math reason, as the space the glued hint asks for would not help', () => {
        const state = read('See here.\n');
        // `See here$note$.`: with a space before it, `$note$` is math.
        const at = posOf(state.doc, 'here') + 4;
        const tr = state.tr.insert(at, editorSchema.nodes.left_sidebar.create(null, editorSchema.text('note')));
        assert.strictEqual(noteRefusal(tr), SIDEBAR_LEFT_MATH, 'glued to `here`');
        const spaced = state.tr.insert(at, [editorSchema.text(' '), editorSchema.nodes.left_sidebar.create(null, editorSchema.text('note')), editorSchema.text(' ')]);
        assert.strictEqual(noteRefusal(spaced), SIDEBAR_LEFT_MATH, 'with the spaces, the same reason');
        // Without math the glued one is refused for the letter, and the spaced one is made.
        setInlineEngine(DEFAULT_INLINE_ENGINE);
        assert.strictEqual(noteRefusal(tr), SIDEBAR_GLUED_BEFORE);
        assert.strictEqual(noteRefusal(spaced), null);
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
