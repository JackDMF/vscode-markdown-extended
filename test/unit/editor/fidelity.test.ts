import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { PRESERVE_SOURCE_META, fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { hostEngine, topChildren } from './helpers';

const SOURCE = [
    '---',
    'title: Fidelity',
    '---',
    '',
    'First paragraph.',
    '',
    'Second paragraph.',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    'Third paragraph.',
    '',
].join('\n');

/** The document position just inside top-level child `index`. */
function inside(doc: Node, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) {
        pos += doc.child(i).nodeSize;
    }
    return pos + 1;
}

function start(doc: Node, index: number): number {
    return inside(doc, index) - 1;
}

suite('Editor fidelity plugin', () => {
    const md = hostEngine();
    const parsed = parseDocument(md, SOURCE);
    const original = topChildren(parsed.doc).map(n => n.attrs.src as string | null);
    const names = topChildren(parsed.doc).map(n => n.type.name);
    const state = () => EditorState.create({ doc: parsed.doc, plugins: [fidelityPlugin()] });

    test('the fixture is front matter, three paragraphs and a raw table', () => {
        assert.deepStrictEqual(names, ['front_matter', 'paragraph', 'paragraph', 'raw_block', 'paragraph']);
    });

    test('typing into the second paragraph clears only its src', () => {
        const before = state();
        const after = before.apply(before.tr.insertText('Edited: ', inside(before.doc, 2)));
        const srcs = topChildren(after.doc).map(n => n.attrs.src as string | null);
        assert.deepStrictEqual(srcs, [original[0], original[1], null, original[3], original[4]]);
        const out = serializeDocument({ ...parsed, doc: after.doc }, { defaultWrap: 90 });
        assert.strictEqual(out, SOURCE.replace('Second paragraph.', 'Edited: Second paragraph.'));
    });

    test('deleting a node leaves every other node\'s src, and its gap goes with it', () => {
        const before = state();
        const from = start(before.doc, 1);
        const after = before.apply(before.tr.delete(from, from + before.doc.child(1).nodeSize));
        const srcs = topChildren(after.doc).map(n => n.attrs.src as string | null);
        assert.deepStrictEqual(srcs, [original[0], original[2], original[3], original[4]]);
        const out = serializeDocument({ ...parsed, doc: after.doc }, { defaultWrap: 90 });
        assert.strictEqual(out, SOURCE.replace('First paragraph.\n\n', ''));
    });

    test('front_matter and raw_block never lose src, even when replaced by a new node object', () => {
        const before = state();
        const fm = before.doc.child(0);
        const table = before.doc.child(3);
        let tr = before.tr.replaceWith(start(before.doc, 3), start(before.doc, 3) + table.nodeSize, table.type.create({ ...table.attrs }));
        tr = tr.replaceWith(0, fm.nodeSize, fm.type.create({ ...fm.attrs }));
        const after = before.apply(tr);
        assert.notStrictEqual(after.doc.child(0), fm, 'a new node object');
        assert.strictEqual(after.doc.child(0).attrs.src, original[0]);
        assert.strictEqual(after.doc.child(3).attrs.src, original[3]);
    });

    test('a moved node keeps its identity and therefore its slice', () => {
        const before = state();
        const third = before.doc.child(4);
        const tr = before.tr.delete(start(before.doc, 4), start(before.doc, 4) + third.nodeSize);
        tr.insert(start(before.doc, 1), third);
        const after = before.apply(tr);
        assert.strictEqual(after.doc.child(1).attrs.src, original[4]);
    });

    test('a transaction marked to preserve sources, and an undo, clear nothing', () => {
        for (const meta of [[PRESERVE_SOURCE_META, true], ['history$', { redo: false }]] as const) {
            const before = state();
            const tr = before.tr.insertText('x', inside(before.doc, 1)).setMeta(meta[0], meta[1]);
            const after = before.apply(tr);
            assert.strictEqual(after.doc.child(1).attrs.src, original[1], String(meta[0]));
        }
    });
});
