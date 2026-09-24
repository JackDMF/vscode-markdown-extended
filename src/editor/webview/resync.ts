import { Mark, Node } from 'prosemirror-model';
import { EditorState, Transaction } from 'prosemirror-state';
import { PRESERVE_SOURCE_META } from '../fidelity';

/** Same type, marks and content — the node may still differ in its attributes. */
function sameContent(a: Node, b: Node): boolean {
    return a.type === b.type && Mark.sameSet(a.marks, b.marks) && a.content.eq(b.content);
}

/**
 * The transaction that turns `state.doc` into `next` — the host's parse of the
 * text document after a change made elsewhere — without rebuilding the state,
 * so prosemirror-history survives it and earlier edits stay undoable.
 *
 * It replaces only what differs. The top-level children the two documents
 * share at the start and at the end (same content, attributes aside) stay in
 * place, and only the run between them is replaced by `next`'s. A child kept in
 * place whose attributes differ — typically `src`, which the host sets on a
 * block the page had edited — has them set with `setNodeMarkup`, which keeps the
 * content positions, so a history step inside it still maps. A single
 * whole-document replace would be simpler and would lose the history: a step
 * whose position a replace deleted cannot be mapped, and undo drops it.
 *
 * The result equals `next` node for node. The transaction is kept out of the
 * history (it is not the person's edit, and undo must not revert another
 * writer's change) and carries `PRESERVE_SOURCE_META`, so `fidelityPlugin`
 * leaves the host's `src` and `gap` as they are.
 */
export function resyncTransaction(state: EditorState, next: Node): Transaction {
    const tr = state.tr;
    const doc = state.doc;
    const oldCount = doc.childCount;
    const newCount = next.childCount;

    let head = 0;
    while (head < oldCount && head < newCount && sameContent(doc.child(head), next.child(head))) {
        head++;
    }
    let tail = 0;
    while (tail < oldCount - head && tail < newCount - head
        && sameContent(doc.child(oldCount - 1 - tail), next.child(newCount - 1 - tail))) {
        tail++;
    }

    let from = 0;
    for (let i = 0; i < head; i++) {
        from += doc.child(i).nodeSize;
    }
    let to = doc.content.size;
    for (let i = 0; i < tail; i++) {
        to -= doc.child(oldCount - 1 - i).nodeSize;
    }
    const middle: Node[] = [];
    for (let i = head; i < newCount - tail; i++) {
        middle.push(next.child(i));
    }
    if (from !== to || middle.length > 0) {
        tr.replaceWith(from, to, middle);
    }

    // `setNodeMarkup` never changes a node's size, so offsets in `next` are
    // offsets in `tr.doc` from here on.
    next.forEach((child, offset, index) => {
        const kept = index < head || index >= newCount - tail;
        if (kept && !tr.doc.child(index).eq(child)) {
            tr.setNodeMarkup(offset, child.type, child.attrs, child.marks);
        }
    });
    return tr.setMeta('addToHistory', false).setMeta(PRESERVE_SOURCE_META, true);
}
