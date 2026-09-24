import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { closeHistory, history, undo } from 'prosemirror-history';
import { EditorState, Transaction } from 'prosemirror-state';
import { fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { resyncTransaction } from '../../../src/editor/webview/resync';
import { hostEngine } from './helpers';

const SOURCE = [
    '---',
    'title: Resync',
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

/**
 * The page's answer to a `document` message while it already shows one: the
 * state is changed in place, not rebuilt, so the undo history outlives a change
 * made elsewhere.
 */
suite('Editor webview: re-sync from the host', () => {
    const md = hostEngine();
    const parsed = parseDocument(md, SOURCE);

    function session() {
        let s = EditorState.create({ doc: parsed.doc, plugins: [history(), fidelityPlugin()] });
        return {
            get state() {
                return s;
            },
            apply(tr: Transaction) {
                s = s.apply(tr);
            },
            write: () => serializeDocument({ ...parsed, doc: s.doc }, { defaultWrap: 90 }),
        };
    }

    test('the result is the host\'s document, node for node', () => {
        const page = session();
        page.apply(page.state.tr.insertText('Edited ', inside(page.state.doc, 1)));
        const next = parseDocument(md, SOURCE.replace('Third', 'Changed elsewhere, third')).doc;
        page.apply(resyncTransaction(page.state, next));
        assert.ok(page.state.doc.eq(next));
    });

    test('an edit made before a change elsewhere is still undone by undo', () => {
        const page = session();
        page.apply(page.state.tr.insertText('Edited ', inside(page.state.doc, 1)));
        const elsewhere = page.write().replace('Third paragraph.', 'Third paragraph, changed elsewhere.');
        page.apply(resyncTransaction(page.state, parseDocument(md, elsewhere).doc));
        assert.strictEqual(page.write(), elsewhere);

        assert.ok(undo(page.state, tr => page.apply(tr)));
        assert.strictEqual(page.write(), SOURCE.replace('Third paragraph.', 'Third paragraph, changed elsewhere.'),
            'the edit is undone, the other writer\'s change stays');
    });

    test('an undo past a re-sync clears the src the host gave a block it changes', () => {
        const page = session();
        page.apply(page.state.tr.insertText('One ', inside(page.state.doc, 2)));
        // A second history event, which finds `src` already cleared.
        page.apply(closeHistory(page.state.tr.insertText('two ', inside(page.state.doc, 2))));
        // The host's parse of what the page sent: the edited paragraph now has
        // a `src` that no history event recorded.
        page.apply(resyncTransaction(page.state, parseDocument(md, page.write()).doc));
        assert.notStrictEqual(page.state.doc.child(2).attrs.src, null);

        assert.ok(undo(page.state, tr => page.apply(tr)));
        assert.strictEqual(page.state.doc.child(2).attrs.src, null, 'the slice of "One two Second" is not this block\'s text');
        assert.strictEqual(page.write(), SOURCE.replace('Second paragraph.', 'One Second paragraph.'));
        assert.ok(undo(page.state, tr => page.apply(tr)));
        assert.strictEqual(page.write(), SOURCE);
    });

    test('the re-sync itself is not an undo step', () => {
        const page = session();
        const elsewhere = SOURCE.replace('First', 'Changed elsewhere, first');
        page.apply(resyncTransaction(page.state, parseDocument(md, elsewhere).doc));
        assert.strictEqual(undo(page.state, tr => page.apply(tr)), false);
        assert.strictEqual(page.write(), elsewhere);
    });
});
