import { Node } from 'prosemirror-model';
import { Plugin, PluginKey, Transaction } from 'prosemirror-state';
import { EDITABLE_TOP_NODES } from './schema';

export const fidelityPluginKey = new PluginKey('mepFidelity');

/**
 * Set this meta on a transaction (`tr.setMeta(PRESERVE_SOURCE_META, true)`) to
 * keep every `src` it would otherwise clear — for a transaction that restores
 * content rather than changing it, such as re-syncing from the text document.
 */
export const PRESERVE_SOURCE_META = 'mepPreserveSource';

/** prosemirror-history's plugin key, as it names its meta; undo and redo carry it. */
const HISTORY_META = 'history$';

function preserves(tr: Transaction): boolean {
    return tr.getMeta(PRESERVE_SOURCE_META) === true || tr.getMeta(HISTORY_META) !== undefined;
}

/**
 * Clears `src` on every top-level editable node a transaction changed, so the
 * serializer writes that node by rule and keeps emitting every other one from
 * its slice.
 *
 * "Changed" is judged by node identity: ProseMirror never mutates a node, so a
 * top-level child of the new document that was not a child of the old one is
 * new or edited, and one that was is untouched — also when it moved, because a
 * move carries the same node object and its slice is still exactly its text.
 *
 * `front_matter`, `raw_block` and `injected_block` are never cleared: their
 * `src` is what they are, and it changes only when the UI sets it explicitly.
 *
 * Undo and redo are left alone: prosemirror-history restores `src` together with
 * the content it restores, and clearing it again would re-serialize a block the
 * undo just returned to its exact source text.
 */
export function fidelityPlugin(): Plugin {
    return new Plugin({
        key: fidelityPluginKey,
        appendTransaction(transactions, oldState, newState) {
            if (!transactions.some(tr => tr.docChanged) || transactions.some(preserves)) {
                return null;
            }
            const before = new Set<Node>();
            oldState.doc.forEach(child => {
                before.add(child);
            });
            let tr: Transaction | null = null;
            newState.doc.forEach((child, offset) => {
                if (before.has(child) || !EDITABLE_TOP_NODES.has(child.type.name) || child.attrs.src === null) {
                    return;
                }
                tr = tr ?? newState.tr;
                tr.setNodeMarkup(offset, undefined, { ...child.attrs, src: null });
            });
            return tr;
        },
    });
}
