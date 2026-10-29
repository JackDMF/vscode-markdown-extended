import * as assert from 'assert';
import { Node, Slice } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { Command, EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { Transform } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument, unwritableInTable } from '../../../src/editor/serialize';
import { FOOTNOTE_KEYS, connectLiterals, countFootnotes, deleteFootnoteRefTransaction, editInlineFootnote, deleteFootnoteEntryTransaction, footnoteIndexKey, footnoteIndexOf, insertFootnoteTransaction, labelRefusal, renameFootnoteTransaction, sortFootnotesTransaction, sortRefusal } from '../../../src/editor/webview/footnotes';
import { saidText } from '../../../src/editor/tips';
import { firstFocus } from '../../../src/editor/verbs';
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
        assert.strictEqual(next.selection.head, at(next.doc, 'Dreimal.'));        // An empty paragraph there goes, the caret into the entry as well.
        let empty = stateOf(`${COTK}\n`);
        empty = empty.apply(empty.tr.insert(empty.doc.content.size, editorSchema.nodes.paragraph.create()));
        empty = empty.apply(empty.tr.setSelection(TextSelection.create(empty.doc, empty.doc.content.size - 1)));
        const gone = run(empty, FOOTNOTE_KEYS.backspace) as EditorState;
        assert.strictEqual(gone.doc.lastChild?.type.name, 'footnote_entry');
        assert.strictEqual(gone.selection.head, at(gone.doc, 'Dreimal.'));
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

    test('Sort footnotes: 2, 1, 3 become 1, 2, 3, each text byte for byte, the blank lines as they were; one undo restores the order (AC2)', () => {
        const cotk = COTK.replace('[^Schäfchen]: *Schäfchen*: Kleine Schafe.\n[^liebst]: *liebst*: Agapáō.\n', '[^Schäfchen]: *Schäfchen*: Kleine Schafe.\n\n[^liebst]: *liebst*: Agapáō.\n');
        let state = stateOf(cotk);
        // Caret in "Agapáō", entry liebst: it stays in its entry.
        state = caret(state, at(state.doc, 'Agap'));
        const tr = sortFootnotesTransaction(state);
        assert.ok(tr !== null);
        state = state.apply(tr);
        assert.strictEqual(text(state), cotk.replace(/\[\^Schäfchen\]: .*\n\n\[\^liebst\]: .*\n\[\^drittes\]: .*\n/,
            '[^liebst]: *liebst*: Agapáō.\n\n[^Schäfchen]: *Schäfchen*: Kleine Schafe.\n[^drittes]: *drittes*: Dreimal.\n'));
        assert.deepStrictEqual(footnoteIndexOf(state).entries.map(e => e.number), [1, 2, 3]);
        assert.strictEqual(state.selection.$from.node(1).attrs.label, 'liebst', 'the caret stays in its entry');
        assert.strictEqual(sortFootnotesTransaction(state), null, 'in order: nothing to sort');
        state = run(state, undo) as EditorState;
        assert.strictEqual(text(state), cotk);
    });

    test('Sort footnotes gathers a scattered entry after the last one, unreferenced ones last', () => {
        const scattered = 'A[^b] B[^a].\n\n[^a]: Eins.\n\nZwischen.\n\n[^allein]: Allein.\n\n[^b]: Zwei.\n';
        let state = stateOf(scattered);
        state = state.apply(sortFootnotesTransaction(state) as Transaction);
        assert.strictEqual(text(state), 'A[^b] B[^a].\n\nZwischen.\n\n[^b]: Zwei.\n\n[^a]: Eins.\n\n[^allein]: Allein.\n');
    });

    test('Label… refuses an empty label, a space, a `]` and one another footnote has; a reference whose label is gone may take one that is there (AC10)', () => {
        const state = stateOf(COTK);
        const refused = (typed: string, own: string | null = 'liebst', join = false) => {
            const r = labelRefusal(state, typed, own, join);
            return r === null ? null : saidText(r);
        };
        assert.strictEqual(refused(''), 'Not set: a footnote needs a label');
        // The values as a screen reader is given them (`saidText`: a lone sign quoted, a word as it is); drawn in the code font.
        assert.strictEqual(refused('zwei Worte'), 'Not set: a label has no spaces — use "_" instead');
        assert.strictEqual(refused('a]b'), 'Not set: a label can\'t hold "]"');
        assert.strictEqual(refused('drittes'), 'Not set: drittes is used by footnote 3 — choose another');
        assert.strictEqual(refused('lieben'), null);
        assert.strictEqual(refused('drittes', 'fehlt', true), null);
    });

    test('Label… renames every reference and the text in one step; one undo; a `[^lieben]` written as text joins it', () => {
        // Written plainly: the file's `[^lieben]` is text while nothing defines it, and joins once something does (H2: an escaped one would not).
        let state = stateOf(COTK.replace('Zweiter Absatz.', 'Zweiter Absatz [^lieben].'));
        let liebst = -1;
        state.doc.forEach((node, offset) => {
            liebst = node.type.name === 'footnote_entry' && node.attrs.label === 'liebst' ? offset : liebst;
        });
        const before = text(state);
        const done = renameFootnoteTransaction(state, liebst, 'lieben');
        assert.ok(done !== null);
        assert.match(saidText(done.hint), /^Footnote liebst renamed to lieben — (Ctrl|Cmd)\+Z$/);
        state = state.apply(done.tr);
        assert.strictEqual(text(state), before.replace(/\[\^liebst\]/g, '[^lieben]'));
        assert.deepStrictEqual(footnoteIndexOf(state).entries.find(e => e.label === 'lieben')?.refCount, 3);
        state = run(state, undo) as EditorState;
        assert.strictEqual(text(state), before);
    });

    test('a jump verb takes the first focus unless refused (#5b exception to #14); then the rule', () => {
        const verbs = [
            { slot: 'open' as const, opensInPlace: false, jump: true as const },
            { slot: 'edit' as const, opensInPlace: true },
            { slot: 'destroy' as const, opensInPlace: false },
        ];
        assert.strictEqual(firstFocus(verbs), 0);
        assert.strictEqual(firstFocus([{ ...verbs[0], refusal: 'No reference' }, verbs[1], verbs[2]]), 1);
    });

    test('Insert › Footnote on `Taufe“.`: `[^Taufe]` right after the word, `[^Taufe]: *Taufe*: ` after the last entry, the caret after it; a second time `Taufe_2` (AC9)', () => {
        const doc = 'Die Bitte zur Taufe“. Und mehr.\n\n[^a]: *a*  \nErklärung.\n\nDanach.\n';
        let state = stateOf(doc);
        const from = at(state.doc, 'Taufe', true);
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + 'Taufe“.'.length)));
        let done = insertFootnoteTransaction(state);
        assert.ok(done !== null);
        state = state.apply(done.tr);
        assert.strictEqual(text(state), 'Die Bitte zur Taufe[^Taufe]“. Und mehr.\n\n[^a]: *a*  \nErklärung.\n\n[^Taufe]: *Taufe*:\n\nDanach.\n');
        assert.strictEqual(state.selection.$from.parent.textContent, 'Taufe: ');
        assert.strictEqual(state.selection.$from.parentOffset, 'Taufe: '.length, 'the caret after the prefill');
        assert.match(saidText(done.hint), /^Footnote Taufe added — type its text; ↩ goes back · (Ctrl|Cmd)\+Z$/);
        state = state.apply(state.tr.insertText('Untertauchen.'));
        assert.ok(text(state).includes('[^Taufe]: *Taufe*: Untertauchen.\n'), text(state));
        const again = at(state.doc, 'Taufe', true);
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, again, again + 'Taufe'.length)));
        done = insertFootnoteTransaction(state) as NonNullable<typeof done>;
        state = state.apply(done.tr);
        assert.ok(text(state).includes('Taufe[^Taufe_2][^Taufe]“.') && text(state).includes('[^Taufe_2]: *Taufe*:'), text(state));
        state = run(run(state, undo) as EditorState, undo) as EditorState;
    });

    test('Insert › Footnote at a caret: the next free number, an empty entry at the end, the caret in it', () => {
        let state = stateOf('Ein Satz[^1] hier.\n\n[^1]: Eins.\n');
        state = caret(state, at(state.doc, 'hier'));
        const done = insertFootnoteTransaction(state);
        assert.ok(done !== null);
        state = state.apply(done.tr);
        assert.strictEqual(text(state), 'Ein Satz[^1] hier[^2].\n\n[^1]: Eins.\n\n[^2]:\n');
        assert.strictEqual(state.selection.$from.node(1).attrs.label, '2');
        assert.deepStrictEqual(footnoteIndexOf(state).entries.map(e => e.number), [1, 2]);
    });

    test('Edit text… on an inline footnote: its text set in one step; empty, a stray `]` and a footnote inside refused with the reason (AC13)', () => {
        let state = stateOf('Mit weiser Anleitung^[Oder „geschickter Lenkung“] führt man Krieg.\n');
        let pos = -1;
        state.doc.descendants((node, p) => {
            pos = node.type.name === 'footnote_ref' ? p : pos;
        });
        const refused = (typed: string) => {
            const r = editInlineFootnote(state, pos, typed);
            return r !== null && 'refusal' in r ? saidText(r.refusal) : null;
        };
        assert.strictEqual(refused('  '), 'Not set: an inline footnote needs text — "Delete footnote" on its bar deletes it');
        assert.strictEqual(refused('Oder] Lenkung'), 'Not set: the "]" after “Oder” ends the footnote early — remove it or add a "[" before it');
        assert.strictEqual(refused('Oder [eckig] Lenkung'), null, 'a [ before it balances it');
        assert.strictEqual(refused('Siehe[^x] dort'), 'Not set: the preview would not read this as a footnote');
        const done = editInlineFootnote(state, pos, 'Oder *weise* Lenkung');
        assert.ok(done !== null && 'tr' in done);
        state = state.apply(done.tr);
        assert.strictEqual(text(state), 'Mit weiser Anleitung^[Oder *weise* Lenkung] führt man Krieg.\n');
        state = run(state, undo) as EditorState;
        assert.strictEqual(text(state), 'Mit weiser Anleitung^[Oder „geschickter Lenkung“] führt man Krieg.\n');
    });
});

/** The positions of every footnote reference atom in `doc`. */
function refsIn(doc: Node): number[] {
    const out: number[] = [];
    doc.descendants((node, pos) => {
        if (node.type.name === 'footnote_ref') {
            out.push(pos);
        }
    });
    return out;
}

/** The text the preview shows for footnote `n` of `markdown` (the host's engine). */
function previewText(markdown: string, n: number): string {
    const html = hostEngine().render(markdown);
    const item = new RegExp(`<li id="fn${n}" class="footnote-item"><p>([\\s\\S]*?) <a href="#fnref${n}"`).exec(html);
    return item === null ? '' : item[1];
}

/** Code review 1 of wave 4 #5b (`wave4-footnotes-review-1.md`): each finding, fail-first. */
suite('Editor footnotes: review 1', () => {
    test('H1: Sort with a label defined twice keeps the earlier definition right before the live one: the preview shows the same text', () => {
        const doc = 'A[^x] and b[^y].\n\n[^x]: first x text\n\n[^y]: y text\n\n[^x]: second x text (the live one)\n';
        assert.strictEqual(previewText(doc, 1), 'second x text (the live one)');
        const state = stateOf(doc);
        assert.ok(footnoteIndexOf(state).outOfOrder, 'y between the two x: Sort is offered');
        const sorted = text(state.apply(sortFootnotesTransaction(state) as Transaction));
        assert.strictEqual(sorted, 'A[^x] and b[^y].\n\n[^x]: first x text\n\n[^x]: second x text (the live one)\n\n[^y]: y text\n');
        assert.strictEqual(previewText(sorted, 1), 'second x text (the live one)');
        assert.strictEqual(footnoteIndexOf(stateOf(sorted)).outOfOrder, false, 'and in order now');
    });

    test('L1: Sort reaches its fixpoint in one step when references stand inside the entries it moves', () => {
        const doc = 'Text x[^x] und z[^z].\n\n[^z]: Z sagt[^w].\n\n[^x]: X sagt[^y].\n\n[^w]: W\n\n[^y]: Y\n';
        let state = stateOf(doc);
        state = state.apply(sortFootnotesTransaction(state) as Transaction);
        assert.strictEqual(footnoteIndexOf(state).outOfOrder, false, text(state));
        assert.deepStrictEqual(footnoteIndexOf(state).entries.map(e => e.number), [1, 2, 3, 4]);
        assert.strictEqual(sortFootnotesTransaction(state), null);
    });

    test('H2: Label… connects only the new label\'s `[^z]` written plainly — never an escaped one, never another label\'s', () => {
        const doc = 'Write \\[^x\\] to make a footnote, like this[^x].\n\nOther[^y] para, see [^z].\n\nAnd \\[^z\\] escaped.\n\n[^x]: X text\n\n[^y]: Y text\n';
        let state = stateOf(doc);
        const entry = footnoteIndexOf(state).entries.find(e => e.label === 'y');
        const done = renameFootnoteTransaction(state, (entry as { pos: number }).pos, 'z');
        assert.ok(done !== null);
        state = state.apply(done.tr);
        const out = text(state);
        assert.ok(out.startsWith('Write \\[^x\\] to make a footnote, like this[^x].\n'), out);
        assert.deepStrictEqual(footnoteIndexOf(state).refs.map(r => r.label), ['x', 'z', 'z'], 'the plain [^z] joins, the escaped one stays text');
        assert.ok(out.includes('see [^z].\n\nAnd \\[^z\\] escaped.'), out);
    });

    test('H3: a `|` in a footnote in a table cell is refused — by the table\'s check, in Edit text…, in Label…; Insert leaves it out of the label', () => {
        let state = stateOf('| a | b |\n| --- | --- |\n| x^[note] | y[^n] |\n\n[^n]: N.\n');
        const [inline, labelled] = refsIn(state.doc);
        const refusal = editInlineFootnote(state, inline, 'a|b');
        assert.ok(refusal !== null && 'refusal' in refusal, 'Edit text… refuses');
        assert.strictEqual(saidText(refusal.refusal), 'Not set: "|" can\'t go in a footnote in a table cell — it would split the row');
        assert.strictEqual(saidText(labelRefusal(state, 'a|b', 'n') ?? ''), 'Not set: a label in a table cell can\'t hold "|" — it would split the row');
        assert.strictEqual(labelRefusal(stateOf('Text[^n].\n\n[^n]: N.\n'), 'a|b', 'n'), null, 'outside a table a label may hold it');
        // The table's own check, which the edit filter asks: a label with `|` given any other way.
        const renamed = state.tr.setNodeMarkup(labelled, undefined, { ...state.doc.nodeAt(labelled)?.attrs, label: 'a|b' });
        assert.strictEqual(saidText(unwritableInTable(renamed.doc) ?? ''), '"|" can\'t go in a footnote in a table cell — it would split the row. Remove it.');
        state = stateOf('| a | b |\n| --- | --- |\n| Wort a\\|b hier | y |\n');
        const from = at(state.doc, 'a|b', true);
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + 3)));
        const inserted = insertFootnoteTransaction(state);
        assert.ok(inserted !== null);
        assert.strictEqual(unwritableInTable(inserted.tr.doc), null);
        assert.deepStrictEqual(countFootnotes(inserted.tr.doc).entries.map(e => e.label), ['ab']);
    });

    test('M2: an aimed delete counts a reference in a source block: the text stays; a rename it would not follow is refused', () => {
        const doc = '!!! note See[^x] here\n\nPara[^x].\n\n[^x]: The text of x\n';
        const state = stateOf(doc);
        assert.ok(footnoteIndexOf(state).refs.some(r => r.raw === true), 'the title is source');
        const [ref] = refsIn(state.doc);
        const done = deleteFootnoteRefTransaction(state, ref);
        assert.ok(done !== null);
        assert.ok(text(state.apply(done.tr)).includes('[^x]: The text of x'), 'the entry stays');
        assert.match(saidText(done.hint), /^Reference deleted, footnote "x" stays \(1 more reference\)/);
        assert.strictEqual(saidText(labelRefusal(state, 'y', 'x') ?? ''), 'Not set: a block shown as source refers to "x" too — rename it there first, in its source');
    });

    test('M3: text with `[^x]` pasted into a code block stays text: no atom, the block whole', () => {
        let state = stateOf('```\ncode line\n```\n\nPara[^x].\n\n[^x]: X.\n');
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at(state.doc, 'code line'))));
        const plugin = state.plugins.find(p => p.spec.key === footnoteIndexKey);
        const view = { state } as unknown as EditorView;
        const pasted = (plugin?.props.transformPasted as (s: Slice, v: EditorView, plain: boolean) => Slice)(
            new Slice(editorSchema.nodes.paragraph.create(null, editorSchema.text(' see [^x]')).content, 1, 1), view, true);
        let atoms = 0;
        pasted.content.descendants(n => {
            atoms += n.type.name === 'footnote_ref' ? 1 : 0;
        });
        assert.strictEqual(atoms, 0);
    });

    test('M-a (review 2): Sort that would move an entry past a source block holding the kept definition refuses, nothing moves', () => {
        const doc = 'A[^x] and b[^y] and c[^z].\n\n[^y]: y text\n\n[^x]: first x text\n\n> [^x]: second x in a quote (live)\n\n[^z]: z text\n';
        assert.match(previewText(doc, 1), /^second x in a quote/);
        const state = stateOf(doc);
        assert.ok(footnoteIndexOf(state).outOfOrder);
        assert.ok(sortFootnotesTransaction(state) === null, 'nothing moves');
        assert.strictEqual(saidText(sortRefusal(state) ?? ''), 'Not sorted: a source block also defines "x" — sorting would change which text the preview shows');
        // Where moving changes no kept definition, Sort sorts and says nothing against it.
        const plain = stateOf('A[^b] B[^a].\n\n[^a]: Eins.\n\n[^b]: Zwei.\n');
        assert.strictEqual(sortRefusal(plain), null);
        assert.ok(sortFootnotesTransaction(plain) !== null);
    });

    test('L-a (review 2): three definitions of a label, in place, are in order: no Sort, no empty step', () => {
        const doc = 'A[^x] und b[^y].\n\n[^x]: first\n\n[^x]: second\n\n[^x]: third (live)\n\n[^y]: y\n';
        const state = stateOf(doc);
        assert.strictEqual(footnoteIndexOf(state).outOfOrder, false);
        assert.ok(sortFootnotesTransaction(state) === null, 'no step');
        // Out of order with three: sorted once, the live one last of its label, and in order after.
        const mixed = stateOf('A[^x] und b[^y].\n\n[^x]: first\n\n[^y]: y\n\n[^x]: second\n\n[^x]: third (live)\n');
        const sorted = text(mixed.apply(sortFootnotesTransaction(mixed) as Transaction));
        assert.strictEqual(sorted, 'A[^x] und b[^y].\n\n[^x]: first\n\n[^x]: second\n\n[^x]: third (live)\n\n[^y]: y\n');
        assert.strictEqual(previewText(sorted, 1), 'third (live)');
        assert.strictEqual(footnoteIndexOf(stateOf(sorted)).outOfOrder, false);
    });
});
