import * as assert from 'assert';
import { Node, Slice } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { Command, EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { Transform } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument } from '../../../src/editor/serialize';
import { FOOTNOTE_KEYS, connectLiterals, deleteFootnoteEntryTransaction, footnoteIndexKey, footnoteIndexOf } from '../../../src/editor/webview/footnotes';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine, topChildren } from './helpers';

/** CA-cotk22's shape: the definitions in the file's order Schäfchen, liebst, drittes = 2, 1, 3. */
const COTK = [
    'Erster Satz. „Simon, liebst[^liebst] du mich?“ Meine Schäfchen[^Schäfchen].',
    '',
    'Zweiter Absatz.',
    '',
    'Zum dritten Mal[^drittes] fragte er. Noch einmal liebst[^liebst].',
    '',
    '[^Schäfchen]: *Schäfchen*: Kleine Schafe.',
    '[^liebst]: *liebst*: Agapáō.',
    '[^drittes]: *drittes*: Dreimal.',
    '',
].join('\n');

function stateOf(text: string): EditorState {
    return EditorState.create({ doc: parseDocument(hostEngine(), text).doc, plugins: editorPlugins(() => true) });
}

function text(state: EditorState): string {
    return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
}

/** Run `command` on `state` as a key would: its transaction applied, or `null` when it did not apply. */
function run(state: EditorState, command: Command): EditorState | null {
    let next: EditorState | null = null;
    const applied = command(state, (tr: Transaction) => {
        next = state.apply(tr);
    });
    return applied ? next ?? state : null;
}

/** The position right after the first `needle` in a text node of `doc`, or before it with `before`. */
function at(doc: Node, needle: string, before = false): number {
    let found = -1;
    doc.descendants((node, pos) => {
        const k = found < 0 && node.isText ? (node.text ?? '').indexOf(needle) : -1;
        if (k >= 0) {
            found = pos + k + (before ? 0 : needle.length);
        }
        return found < 0;
    });
    assert.ok(found >= 0, needle);
    return found;
}

function caret(state: EditorState, pos: number): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

/** The labels of the entries, in document order. */
function entries(state: EditorState): string[] {
    return topChildren(state.doc).filter(n => n.type.name === 'footnote_entry').map(n => n.attrs.label as string);
}

/**
 * Deleting footnotes (wave 4 #5b, plan step 6): only a delete aimed at a
 * reference takes its text along — the second press beside it, the first
 * having selected it — in one undo step; a cut, a deleted sentence leaves the
 * entry, which a pasted reference finds again.
 */
suite('Editor footnote keys and deletes', () => {
    test('Backspace after the only reference to `drittes`: the first press selects it, the second deletes it and its entry; one undo restores both, byte for byte (AC5)', () => {
        let state = caret(stateOf(COTK), at(stateOf(COTK).doc, 'Mal') + 1);
        const first = run(state, FOOTNOTE_KEYS.backspace) as EditorState;
        assert.ok(first.selection instanceof NodeSelection && first.selection.node.attrs.label === 'drittes', 'the first press selects the reference');
        assert.strictEqual(text(first), COTK, 'and deletes nothing');
        state = run(first, FOOTNOTE_KEYS.backspace) as EditorState;
        assert.ok(!text(state).includes('[^drittes]'), 'the reference went');
        assert.deepStrictEqual(entries(state), ['Schäfchen', 'liebst'], 'and its entry with it');
        state = run(state, undo) as EditorState;
        assert.strictEqual(text(state), COTK, 'one undo brings both back');
    });

    test('Delete before a reference does the same, forward; with another reference left, the entry stays', () => {
        let state = stateOf(COTK);
        state = caret(state, at(state.doc, 'Simon, liebst'));
        state = run(run(state, FOOTNOTE_KEYS.delete) as EditorState, FOOTNOTE_KEYS.delete) as EditorState;
        assert.ok(text(state).includes('„Simon, liebst du mich?“'), 'the first reference to liebst went');
        assert.deepStrictEqual(entries(state), ['Schäfchen', 'liebst', 'drittes'], 'liebst keeps its text: one more reference');
        assert.deepStrictEqual(footnoteIndexOf(state).refs.map(r => [r.label, r.number]), [['Schäfchen', 1], ['drittes', 2], ['liebst', 3]], 'renumbered at once');
    });

    test('a selected sentence holding the only reference, deleted: the entry stays, not referenced (AC4); undo restores it', () => {
        let state = stateOf(COTK);
        const from = at(state.doc, 'Zum', true);
        const to = at(state.doc, 'fragte er.');
        state = state.apply(state.tr.delete(from, to));
        assert.deepStrictEqual(entries(state), ['Schäfchen', 'liebst', 'drittes']);
        const drittes = footnoteIndexOf(state).entries.find(e => e.label === 'drittes');
        assert.deepStrictEqual([drittes?.number, drittes?.refCount], [null, 0], 'not referenced');
        assert.deepStrictEqual(footnoteIndexKey.getState(state)?.orphaned, ['drittes'], 'the hint names it');
        state = run(state, undo) as EditorState;
        assert.strictEqual(text(state), COTK);
    });

    test('the only reference cut and pasted two paragraphs earlier: one atom, the entry unchanged, renumbered; the file differs by the moved sentence only (AC3)', () => {
        let state = stateOf(COTK);
        const from = at(state.doc, 'Zum', true);
        const to = at(state.doc, 'fragte er.');
        const moved: Slice = state.doc.slice(from, to);
        state = state.apply(state.tr.delete(from, to));
        state = state.apply(state.tr.replace(at(state.doc, 'Zweiter Absatz.'), at(state.doc, 'Zweiter Absatz.'), moved));
        const atoms: string[] = [];
        state.doc.descendants(n => {
            if (n.type.name === 'footnote_ref') {
                atoms.push(n.attrs.label as string);
            }
        });
        assert.deepStrictEqual(atoms, ['liebst', 'Schäfchen', 'drittes', 'liebst']);
        assert.deepStrictEqual(footnoteIndexOf(state).entries.map(e => [e.label, e.number]), [['Schäfchen', 2], ['liebst', 1], ['drittes', 3]]);
        const out = text(state);
        assert.strictEqual(out, COTK.replace('Zum dritten Mal[^drittes] fragte er. ', '').replace('Zweiter Absatz.', 'Zweiter Absatz.Zum dritten Mal[^drittes] fragte er.'));
    });

    test('Backspace at the start of an entry\'s text is refused; Delete at the end of the block before one too; the document stays', () => {
        let state = stateOf(COTK);
        let entryText = -1;
        state.doc.forEach((node, offset) => {
            entryText = node.type.name === 'footnote_entry' && node.attrs.label === 'liebst' ? offset + 2 : entryText;
        });
        state = caret(state, entryText);
        assert.strictEqual(run(state, FOOTNOTE_KEYS.backspace)?.doc, state.doc, 'Backspace: handled, nothing changed');
        state = caret(state, at(state.doc, 'Kleine Schafe.'));
        assert.strictEqual(run(state, FOOTNOTE_KEYS.delete)?.doc, state.doc, 'Delete before the next entry: handled, nothing changed');
    });

    test('Backspace at the start of the paragraph after an entry puts the caret at the end of the entry\'s text, nothing deleted (F7)', () => {
        let state = stateOf(`${COTK}\nNach den Fußnoten.\n`);
        state = caret(state, at(state.doc, 'Nach', true));
        const next = run(state, FOOTNOTE_KEYS.backspace) as EditorState;
        assert.strictEqual(next.doc, state.doc);
        assert.strictEqual(next.selection.head, at(next.doc, 'Dreimal.'));
    });

    test('Delete on a selected entry deletes it with its references, one undo step (F8)', () => {
        let state = stateOf(COTK);
        let liebst = -1;
        state.doc.forEach((node, offset) => {
            liebst = node.type.name === 'footnote_entry' && node.attrs.label === 'liebst' ? offset : liebst;
        });
        state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, liebst)));
        state = run(state, FOOTNOTE_KEYS.delete) as EditorState;
        assert.ok(!text(state).includes('[^liebst]'), text(state));
        state = run(state, undo) as EditorState;
        assert.strictEqual(text(state), COTK);
        assert.deepStrictEqual(deleteFootnoteEntryTransaction(state, 1), null, 'only an entry');
    });

    test('Shift+Enter in an entry breaks the line, written `␣␣` and a lazy line; Enter in its empty last paragraph leaves it', () => {
        let state = stateOf(COTK);
        state = caret(state, at(state.doc, 'Kleine'));
        state = run(state, FOOTNOTE_KEYS.shiftEnter) as EditorState;
        assert.ok(text(state).includes('[^Schäfchen]: *Schäfchen*: Kleine  \nSchafe.'), JSON.stringify(text(state)));
        state = caret(stateOf(COTK), at(stateOf(COTK).doc, 'Dreimal.'));
        state = state.apply(state.tr.split(state.selection.from));
        const left = run(state, FOOTNOTE_KEYS.enter) as EditorState;
        assert.ok(left !== null, 'handled');
        assert.deepStrictEqual(topChildren(left.doc).map(n => n.type.name).slice(-2), ['footnote_entry', 'paragraph']);
        assert.strictEqual(left.selection.$from.parent.type.name, 'paragraph');
        assert.strictEqual(left.selection.$from.depth, 1, 'the caret is in the paragraph after the entry');
        assert.strictEqual((topChildren(left.doc).slice(-2)[0] as Node).childCount, 1, 'the empty paragraph went');
    });

    test('a pasted or a given `[^x]` text whose label the document defines is the reference; one it does not stays text; in code it stays text', () => {
        const state = stateOf(COTK);
        const plugin = state.plugins.find(p => p.spec.key === footnoteIndexKey);
        const view = { state } as unknown as EditorView;
        const pasted = (plugin?.props.transformPasted as (s: Slice, v: EditorView) => Slice)(
            new Slice(editorSchema.nodes.paragraph.create(null, editorSchema.text('Siehe[^liebst] und[^fehlt].')).content, 0, 0), view);
        const names: string[] = [];
        pasted.content.descendants(n => {
            names.push(n.isText ? `"${n.text}"` : n.type.name);
        });
        assert.deepStrictEqual(names, ['"Siehe"', 'footnote_ref', '" und[^fehlt]."']);
        const tr = new Transform(editorSchema.nodes.doc.create(null, [
            editorSchema.nodes.paragraph.create(null, [editorSchema.text('a[^liebst] '), editorSchema.text('[^liebst]', [editorSchema.marks.code.create()])]),
        ]));
        connectLiterals(tr, new Set(['liebst']));
        const kinds: string[] = [];
        tr.doc.descendants(n => {
            kinds.push(n.isText ? `"${n.text}"` : n.type.name);
        });
        assert.deepStrictEqual(kinds, ['paragraph', '"a"', 'footnote_ref', '" "', '"[^liebst]"']);
    });
});
