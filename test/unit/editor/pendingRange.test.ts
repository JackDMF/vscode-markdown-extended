import * as assert from 'assert';
import { EditorState, Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { editorSchema } from '../../../src/editor/schema';
import { clearPendingRange, pendingRange, pendingRangeId, pendingRangePlugin, showPendingRange } from '../../../src/editor/webview/pendingRange';

suite('Editor pending range', () => {
    /** A view as far as the range needs one: its state, and dispatch. */
    const viewOf = (text: string): EditorView => {
        const doc = editorSchema.node('doc', null, [editorSchema.node('paragraph', null, [editorSchema.text(text)])]);
        const view = { state: EditorState.create({ doc, plugins: [pendingRangePlugin()] }) } as { state: EditorState; dispatch?: (tr: Transaction) => void };
        view.dispatch = tr => {
            view.state = view.state.apply(tr);
        };
        return view as unknown as EditorView;
    };

    test('wave 3 follow-up: a dropped field\'s late clear leaves the range a field drew since', () => {
        const view = viewOf('Alpha beta gamma.');
        showPendingRange(view, 7, 11);
        const dropped = pendingRangeId(view.state);
        // The row's Link… took the slot in the same task and drew its own range.
        showPendingRange(view, 1, 6);
        clearPendingRange(view, dropped);
        assert.deepStrictEqual({ ...pendingRange(view.state), id: undefined }, { from: 1, to: 6, id: undefined }, 'the new field\'s range stays');
        clearPendingRange(view, pendingRangeId(view.state));
        assert.strictEqual(pendingRange(view.state), null);
    });

    test('a range keeps its field through a change that moves it, and is cleared by it', () => {
        const view = viewOf('Alpha beta gamma.');
        showPendingRange(view, 7, 11);
        const id = pendingRangeId(view.state);
        view.dispatch(view.state.tr.insertText('Hey ', 1));
        assert.strictEqual(pendingRange(view.state)?.from, 11);
        clearPendingRange(view, id);
        assert.strictEqual(pendingRange(view.state), null);
    });

    test('a clear for a field that drew no range leaves another\'s; a plain clear takes any', () => {
        const view = viewOf('Alpha beta gamma.');
        showPendingRange(view, 7, 11);
        clearPendingRange(view, null);
        assert.notStrictEqual(pendingRange(view.state), null);
        clearPendingRange(view);
        assert.strictEqual(pendingRange(view.state), null);
    });
});
