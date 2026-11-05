import { Node } from 'prosemirror-model';
import { EditorState, TextSelection, Transaction } from 'prosemirror-state';
import { PRESERVE_SOURCE_META } from '../fidelity';
import { sharedEnds } from '../sharedEnds';

/**
 * `pos` inside the top-level block at `oldFrom` in `old`, at the same place
 * inside the block at `newFrom` in `next` (#8 review 2): the same index path,
 * every node on it of the same type with as many children, and the same
 * offset in a textblock that has room for it; else `null`.
 */
function samePlace(old: Node, pos: number, next: Node, newFrom: number): number | null {
    const $pos = old.resolve(pos);
    let node = next.nodeAt(newFrom);
    if ($pos.depth < 1 || node === null || node.type !== $pos.node(1).type) {
        return null;
    }
    let at = newFrom;
    for (let d = 2; d <= $pos.depth; d++) {
        const index = $pos.index(d - 1);
        if (node.childCount !== $pos.node(d - 1).childCount || node.child(index).type !== $pos.node(d).type) {
            return null;
        }
        at += 1;
        for (let k = 0; k < index; k++) {
            at += node.child(k).nodeSize;
        }
        node = node.child(index);
    }
    return node.inlineContent && $pos.parentOffset <= node.content.size ? at + 1 + $pos.parentOffset : null;
}

/**
 * The transaction that turns `state.doc` into `next` — the host's parse of the
 * text document after a change made elsewhere — without rebuilding the state,
 * so prosemirror-history survives it and earlier edits stay undoable.
 *
 * It replaces only what differs. The top-level children the two documents
 * share at the start and at the end (same text and structure, attributes
 * aside at every depth: `sharedEnds`) stay in place, and only the run between
 * them is replaced by `next`'s. A node kept in place, at any depth, whose
 * attributes differ — `src`, which the host sets on a block the page had
 * edited; a nested paragraph's `lineWidth`, which typing in a list item or an
 * admonition left as it was — has them set with `setNodeMarkup`, which keeps
 * the content positions, so a history step inside it still maps. A single
 * whole-document replace would be simpler and would lose the history: a step
 * whose position a replace deleted cannot be mapped, and undo drops it.
 *
 * A caret inside a block replaced by one block of its type keeps its place
 * in it (`samePlace`); elsewhere the selection is mapped.
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
    const { head, tail } = sharedEnds(doc, next);

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
        // One block swapped for one of its type (anything in it differs: a sibling item's text): a caret in it
        // stays at its place there (#8 review 2), so its bar and an open field stay with it — mapped, it would
        // leave the block.
        const sel = state.selection;
        if (middle.length === 1 && oldCount - head - tail === 1 && sel instanceof TextSelection
            && sel.from > from && sel.to < to) {
            const anchor = samePlace(doc, sel.anchor, tr.doc, from);
            const caret = samePlace(doc, sel.head, tr.doc, from);
            if (anchor !== null && caret !== null) {
                tr.setSelection(TextSelection.create(tr.doc, anchor, caret));
            }
        }
    }

    // `setNodeMarkup` never changes a node's size, so offsets in `next` are
    // offsets in `tr.doc` from here on.
    next.forEach((child, offset, index) => {
        const kept = index < head || index >= newCount - tail;
        if (kept && !tr.doc.child(index).eq(child)) {
            markupAs(tr, offset, child);
        }
    });
    return tr.setMeta('addToHistory', false).setMeta(PRESERVE_SOURCE_META, true);
}

/**
 * The node at `pos` in `tr.doc` and every node inside it given the attributes
 * (and marks) of `next`, which has its text and structure (`sharedEnds`): one
 * `setNodeMarkup` per node that differs, so positions inside stay as they are.
 */
function markupAs(tr: Transaction, pos: number, next: Node): void {
    const have = tr.doc.nodeAt(pos);
    if (have === null || have.eq(next)) {
        return;
    }
    if (!have.sameMarkup(next)) {
        tr.setNodeMarkup(pos, next.type, next.attrs, next.marks);
    }
    next.forEach((child, offset) => {
        if (!child.isText) {
            markupAs(tr, pos + 1 + offset, child);
        }
    });
}
