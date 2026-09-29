/**
 * The range an open inline field acts on, kept visible.
 *
 * While a field has the focus the text does not, and the browser draws no
 * selection there: the words a link is being made of, the span being given
 * a class, the link or image being edited would vanish from view exactly while
 * the person decides what to do with them. So the range is drawn as a
 * decoration (`mep-pending-range`, in the selection's colour) from the moment
 * a field opens until it closes, mapped through every change meanwhile — a
 * re-sync from the host included.
 */
import { EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';

interface Pending {
    from: number;
    to: number;
}

const key = new PluginKey<Pending | null>('mepPendingRange');

export const PENDING_RANGE_CLASS = 'mep-pending-range';

export function pendingRangePlugin(): Plugin {
    return new Plugin<Pending | null>({
        key,
        state: {
            init: () => null,
            apply(tr, value) {
                const meta = tr.getMeta(key) as { set: Pending | null } | undefined;
                if (meta !== undefined) {
                    return meta.set;
                }
                if (value === null || !tr.docChanged) {
                    return value;
                }
                const from = tr.mapping.map(value.from, 1);
                const to = tr.mapping.map(value.to, -1);
                return from < to ? { from, to } : null;
            },
        },
        props: {
            decorations(state) {
                const range = key.getState(state);
                return range ? DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: PENDING_RANGE_CLASS })]) : null;
            },
        },
    });
}

/** The range the page's field acts on now, if one is drawn. For tests. */
export function pendingRange(state: EditorState): Pending | null {
    return key.getState(state) ?? null;
}

/** Draw `from`–`to` as what the open field acts on; an empty range draws nothing. */
export function showPendingRange(view: EditorView, from: number, to: number): void {
    view.dispatch(view.state.tr.setMeta(key, { set: from < to ? { from, to } : null }).setMeta('addToHistory', false));
}

/** The field closed: nothing is pending any more. */
export function clearPendingRange(view: EditorView): void {
    if (key.getState(view.state)) {
        view.dispatch(view.state.tr.setMeta(key, { set: null }).setMeta('addToHistory', false));
    }
}
