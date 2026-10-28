import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { FOOTNOTES_CHANGED, FootnoteIndex, countFootnotes, footnoteIndexOf, literalAt, touchesFootnotes } from '../../../src/editor/webview/footnotes';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine } from './helpers';

/** The engine's numbers (markdown-it-footnote, without the editor's flag, as the preview): each label's and each inline footnote's, by its text. */
function engineNumbers(text: string): { labels: Map<string, number>; inline: Map<string, number> } {
    const env: { footnotes?: { list?: { label?: string; content?: string }[] } } = {};
    hostEngine().parse(text, env);
    const labels = new Map<string, number>();
    const inline = new Map<string, number>();
    (env.footnotes?.list ?? []).forEach((item, i) => {
        if (item.label !== undefined) {
            labels.set(item.label, i + 1);
        } else if (item.content !== undefined) {
            inline.set(item.content, i + 1);
        }
    });
    return { labels, inline };
}

/** The editor's numbers for `text`, as the page counts them, by label and by inline text. */
function pageNumbers(text: string): { labels: Map<string, number>; inline: Map<string, number>; doc: Node } {
    const doc = parseDocument(hostEngine(), text).doc;
    const count = countFootnotes(doc);
    const labels = new Map<string, number>();
    const inline = new Map<string, number>();
    const atoms: Node[] = [];
    doc.descendants(node => {
        if (node.type.name === 'footnote_ref') {
            atoms.push(node);
        }
    });
    let k = 0;
    for (const ref of count.refs) {
        if (ref.number === null) {
            k += ref.raw ? 0 : 1;
            continue;
        }
        if (ref.label !== null) {
            labels.set(ref.label, ref.number);
        } else if (!ref.raw) {
            inline.set(atoms[k].attrs.source as string, ref.number);
        }
        k += ref.raw ? 0 : 1;
    }
    return { labels, inline, doc };
}

/** Every place a reference stands, the engine's order across them: paragraph, note body, entry body, cell, heading, inline notes, repeats, an undefined label, a repeated definition, a source block. */
const EVERYWHERE = [
    '# Die Welt[^welt] im Titel',
    '',
    'Ein Satz[^satz] mit Anleitung^[Oder „Lenkung“.] und noch einmal Welt[^welt].',
    '',
    'Ein Helfer ++Helfer|Siehe Joh 14:16.[^helfer]++ und ein Satz[^satz].',
    '',
    '| Wort | Sinn |',
    '| - | - |',
    '| Zelle[^zelle] | x |',
    '',
    '!!! note "Titel[^titel]"',
    '    Ein Kasten.',
    '',
    'Ein Name[^fehlt], den nichts definiert.',
    '',
    '[^welt]: *Welt*: Kósmos[^innen].',
    '',
    '[^satz]: Der erste Satz.',
    '',
    '[^satz]: Der zweite, den der Motor nimmt.',
    '',
    '[^innen]: Erst im Eintrag gezählt.',
    '',
    '[^helfer]: Paráklētos.',
    '',
    '[^zelle]: Eine Zelle.',
    '',
    '[^titel]: Im Titel.',
    '',
    '[^allein]: Nichts verweist hierher.',
    '',
].join('\n');

/** CA-cotk22's shape: three references in a quote, the definitions in the file's order Schäfchen, liebst, drittes = 2, 1, 3. */
const COTK = [
    '> „Simon, liebst[^liebst] du mich?“ Meine Schäfchen[^Schäfchen]. Zum dritten[^drittes] Mal.',
    '',
    '[^Schäfchen]: *Schäfchen*: Kleine Schafe.',
    '[^liebst]: *liebst*: Agapáō.',
    '[^drittes]: *drittes*: Dreimal.',
    '',
].join('\n');

function stateOf(text: string): EditorState {
    return EditorState.create({ doc: parseDocument(hostEngine(), text).doc, plugins: editorPlugins(() => true) });
}

/** The position right after the first `needle` in a text node of `doc`. */
function after(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        const at = found < 0 && node.isText ? (node.text ?? '').indexOf(needle) : -1;
        if (at >= 0) {
            found = pos + at + needle.length;
        }
        return found < 0;
    });
    assert.ok(found >= 0, needle);
    return found;
}

/**
 * The footnotes' numbers (wave 4 #5b, plan step 5): counted on the page as
 * the engine counts them, never written into the document, counted anew only
 * when a change touches footnotes.
 */
suite('Editor footnote numbers', () => {
    test('every reference, wherever it stands, has the number the engine gives it', () => {
        const engine = engineNumbers(EVERYWHERE);
        const page = pageNumbers(EVERYWHERE);
        assert.ok(engine.labels.size >= 6 && engine.inline.size === 1, JSON.stringify([...engine.labels]));
        assert.deepStrictEqual([...page.labels].sort(), [...engine.labels].sort());
        assert.deepStrictEqual([...page.inline], [...engine.inline]);
    });

    test('a label nothing defines has no number; a repeat keeps its label\'s with the next sub; the last definition is the live one', () => {
        const { doc } = pageNumbers(EVERYWHERE);
        const count = countFootnotes(doc);
        // A label nothing defines is text to the engine, so no atom: one is left so by an edit, its entry deleted.
        assert.deepStrictEqual(count.refs.filter(r => r.label === 'fehlt'), []);
        let entryPos = -1;
        doc.forEach((node, offset) => {
            entryPos = node.type.name === 'footnote_entry' && node.attrs.label === 'zelle' ? offset : entryPos;
        });
        const without = doc.copy(doc.content.cut(0, entryPos).append(doc.content.cut(entryPos + (doc.nodeAt(entryPos) as Node).nodeSize)));
        assert.deepStrictEqual(countFootnotes(without).refs.filter(r => r.label === 'zelle').map(r => r.number), [null]);
        assert.deepStrictEqual(count.refs.filter(r => r.label === 'welt').map(r => [r.number, r.sub]), [[1, 0], [1, 1]]);
        const satz = count.entries.filter(e => e.label === 'satz');
        assert.deepStrictEqual(satz.map(e => [e.live, e.number, e.duplicateOf]), [[false, null, 2], [true, 2, null]]);
        assert.deepStrictEqual(count.entries.filter(e => e.label === 'allein').map(e => [e.live, e.number, e.refCount]), [[true, null, 0]]);
        // The title's reference is in a source block (an admonition's title is a string): counted from its record.
        assert.ok(count.refs.some(r => r.raw === true && r.label === 'titel' && r.number !== null));
        assert.strictEqual(count.entries.find(e => e.label === 'titel')?.number, count.refs.find(r => r.label === 'titel')?.number);
    });

    test('CA-cotk22\'s entries read 2, 1, 3 where written, out of order; sorted they are in order', () => {
        const count = countFootnotes(parseDocument(hostEngine(), COTK).doc);
        assert.deepStrictEqual(count.entries.map(e => [e.label, e.number]), [['Schäfchen', 2], ['liebst', 1], ['drittes', 3]]);
        assert.strictEqual(count.outOfOrder, true);
        const sorted = COTK.replace(/\[\^Schäfchen\]: .*\n(\[\^liebst\]: .*\n)/, '$1[^Schäfchen]: *Schäfchen*: Kleine Schafe.\n');
        assert.deepStrictEqual(countFootnotes(parseDocument(hostEngine(), sorted).doc).entries.map(e => e.number), [1, 2, 3]);
        assert.strictEqual(countFootnotes(parseDocument(hostEngine(), sorted).doc).outOfOrder, false);
        // An unreferenced entry before a numbered one is out of order too; after them, not.
        assert.strictEqual(countFootnotes(parseDocument(hostEngine(), `${sorted}\n[^allein]: X\n`).doc).outOfOrder, false);
        assert.strictEqual(countFootnotes(parseDocument(hostEngine(), `[^allein]: X\n\n${sorted}`).doc).outOfOrder, true);
    });

    test('counted anew only when a change touches footnotes: typing in a paragraph or an entry\'s text does not', () => {
        const state = stateOf(COTK);
        const typed = (tr: ReturnType<EditorState['tr']['insertText']>) => touchesFootnotes(tr);
        assert.strictEqual(typed(state.tr.insertText('x', after(state.doc, 'Simon'))), false, 'typing in the quote');
        assert.strictEqual(typed(state.tr.insertText('x', after(state.doc, 'Kleine'))), false, 'typing in an entry');
        assert.strictEqual(typed(state.tr.delete(after(state.doc, 'liebst') - 1, after(state.doc, 'liebst') + 1)), true, 'deleting a reference');
        const atom = editorSchema.nodes.footnote_ref.create({ label: 'liebst' });
        assert.strictEqual(typed(state.tr.insert(after(state.doc, 'Mal'), atom)), true, 'inserting one');
        assert.strictEqual(typed(state.tr.setMeta(FOOTNOTES_CHANGED, true)), true, 'a verb that says so');
        // Backspace at the start of an entry's text joins it: its boundary is in the range.
        let liebst = -1;
        state.doc.forEach((node, offset) => {
            liebst = node.type.name === 'footnote_entry' && node.attrs.label === 'liebst' ? offset : liebst;
        });
        assert.strictEqual(typed(state.tr.delete(liebst - 1, liebst + 3)), true, 'joining across an entry\'s edge');
    });

    test('a recount that changes no number keeps the version; one that does bumps it; typing maps the positions', () => {
        let state = stateOf(COTK);
        const before: FootnoteIndex = footnoteIndexOf(state);
        state = state.apply(state.tr.insertText('xyz', 1 + 2));
        const typed = footnoteIndexOf(state);
        assert.strictEqual(typed.version, before.version);
        assert.deepStrictEqual(typed.refs.map(r => r.pos), before.refs.map(r => r.pos + 3));
        // Move "liebst" after "drittes": the numbers change.
        const at = typed.refs[0].pos;
        const atom = state.doc.nodeAt(at) as Node;
        let tr = state.tr.delete(at, at + 1);
        tr = tr.insert(tr.mapping.map(footnoteIndexOf(state).refs[2].pos + 1), atom);
        state = state.apply(tr);
        const moved = footnoteIndexOf(state);
        assert.strictEqual(moved.version, before.version + 1);
        assert.deepStrictEqual(moved.refs.map(r => [r.label, r.number]), [['Schäfchen', 1], ['drittes', 2], ['liebst', 3]]);
        assert.deepStrictEqual(moved.entries.map(e => e.number), [1, 3, 2]);
        // Nothing of the document changed for it: the atoms still carry their labels only.
        assert.deepStrictEqual(Object.keys(atom.attrs).sort(), ['label', 'source']);
    });

    test('widgets: one ↩ per reference of a numbered entry, a chip for one nothing refers to, a rule before each run of entries', () => {
        const state = stateOf(`${COTK}\nZwischen den Einträgen.\n\n[^allein]: *Allein*: nichts verweist hierher.\n\n[^liebst2]: X\n\nNoch einmal liebst[^liebst].\n`);
        const found = footnoteIndexOf(state).decorations.find().map(d => (d as unknown as { type: { spec: { key?: string } } }).type.spec.key ?? '');
        assert.deepStrictEqual(found.filter(k => k.startsWith('fn-back')).sort(), ['fn-back-Schäfchen-2-1-1', 'fn-back-drittes-3-1-1', 'fn-back-liebst-1-1-2', 'fn-back-liebst-1-2-2']);
        assert.deepStrictEqual(found.filter(k => k.startsWith('fn-chip')), ['fn-chip-not referenced', 'fn-chip-not referenced']);
        assert.strictEqual(found.filter(k => k === 'fn-sep').length, 2);
    });

    test('a key in a long document with footnotes costs what one without costs (1000 blocks, 30 footnotes)', () => {
        const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        const blocks = (withNotes: boolean) => {
            const out: string[] = [];
            for (let i = 0; i < 1000; i++) {
                out.push(withNotes && i % 33 === 0 ? `Absatz ${i} mit einem Verweis[^n${i}] und Text.` : `Absatz ${i} mit Text und noch etwas Text.`, '');
            }
            if (withNotes) {
                for (let i = 0; i < 1000; i += 33) {
                    out.push(`[^n${i}]: Erklärung ${i}.`, '');
                }
            }
            return out.join('\n');
        };
        const keys = (state: EditorState) => {
            const at = TextSelection.atStart(state.doc).from + 5;
            const times: number[] = [];
            let s = state;
            for (let i = 0; i < 5; i++) {
                s = s.apply(s.tr.insertText('w', at));
            }
            for (const key of 'abcdefghijklmnopqrstuvwxyz'.split('')) {
                const tr = s.tr.insertText(key, at);
                const began = performance.now();
                s = s.apply(tr);
                times.push(performance.now() - began);
            }
            return median(times);
        };
        const withNotes = stateOf(blocks(true));
        assert.strictEqual(footnoteIndexOf(withNotes).refs.length, 31);
        const plain = stateOf(blocks(false));
        // Warmed up both ways first: the first keys pay for the JIT.
        keys(withNotes);
        keys(plain);
        const a = keys(withNotes);
        const b = keys(plain);
        process.stdout.write(`      [footnotes] 1000 blocks: a key ${a.toFixed(3)} ms with 31 references, ${b.toFixed(3)} ms with none\n`);
        assert.ok(a <= b + 0.2, `a key costs ${a.toFixed(3)} ms with footnotes and ${b.toFixed(3)} ms without`);
    });

    test('a `[^x]` written as text whose label nothing defines is underlined; one that is defined, or in code, is not; a typed one is found, a fixed one loses it', () => {
        let state = stateOf('Siehe[^Schaefchen] und `[^code]`.\n\n[^Schäfchen]: *Schäfchen*: X.\n');
        const at = after(state.doc, 'Siehe') + 2;
        assert.strictEqual(literalAt(state, at), 'Schaefchen');
        assert.strictEqual(literalAt(state, after(state.doc, '[^co')), null);
        state = state.apply(state.tr.insertText(' [^neu]', after(state.doc, 'und')));
        assert.strictEqual(literalAt(state, after(state.doc, '[^n')), 'neu', 'found where it was typed');
        // Two literals in one paragraph are written escaped (their carets would pair), so the edit goes through.
        // Fixed: the label as the entry has it.
        state = state.apply(state.tr.insertText('ä', at + 'Sch'.length, at + 'Schae'.length));
        assert.strictEqual(literalAt(state, at), null);
    });
});

