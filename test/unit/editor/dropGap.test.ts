import * as assert from 'assert';
import { EditorState } from 'prosemirror-state';
import { fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { dropGapPlugin } from '../../../src/editor/webview/plugins';
import { hostEngine, topChildren } from './helpers';

const SOURCE = 'First.\n\n\n\nSecond, after three blank lines.\n\nThird.\n';

suite('Editor webview: a dropped block', () => {
    test('keeps its source and loses the gap it had at its old place', () => {
        const parsed = parseDocument(hostEngine(), SOURCE);
        const state = EditorState.create({ doc: parsed.doc, plugins: [fidelityPlugin(), dropGapPlugin()] });
        const [first, second] = topChildren(state.doc);

        // What ProseMirror's drop handler does for a moved node: delete it, then
        // insert the same node object at the drop point.
        const tr = state.tr.delete(first.nodeSize, first.nodeSize + second.nodeSize);
        tr.insert(tr.doc.content.size, second);
        const next = state.apply(tr.setMeta('uiEvent', 'drop'));

        const moved = topChildren(next.doc)[2];
        assert.strictEqual(moved.attrs.src, second.attrs.src, 'the moved block is written from its slice');
        assert.strictEqual(moved.attrs.gap, null, 'its old gap is not carried to the new place');
        assert.strictEqual(
            serializeDocument({ doc: next.doc, eol: parsed.eol, tail: parsed.tail }, { defaultWrap: 90 }),
            'First.\n\nThird.\n\nSecond, after three blank lines.\n',
        );
    });

    test('a block moved by anything but a drop is left alone', () => {
        const parsed = parseDocument(hostEngine(), SOURCE);
        const state = EditorState.create({ doc: parsed.doc, plugins: [fidelityPlugin(), dropGapPlugin()] });
        const [first, second] = topChildren(state.doc);
        const tr = state.tr.delete(first.nodeSize, first.nodeSize + second.nodeSize);
        tr.insert(tr.doc.content.size, second);
        const moved = topChildren(state.apply(tr).doc)[2];
        assert.strictEqual(moved.attrs.gap, second.attrs.gap);
    });
});
