import { Node } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';

/**
 * Where the editing focus is: the one answer every bar reads — the object
 * toolbar's two bars, the formatting row, the bubble, the caret the page
 * reports. Read from the focused element and the document each time it is
 * asked, written by nobody: no transaction, no registry, no plugin state, so
 * no bar can hold a stale copy of it.
 *
 * - `text`: the editable root has the focus — the caret is a place in the text.
 * - `chrome`: the focus is in the editor's own controls outside the text — the
 *   formatting row, the bubble, a menu, an object bar and its field.
 * - `control`: the focus is in a node view's own control inside the text's
 *   element — a source box, a property's field, the properties' header
 *   buttons. The selection is still there but hidden, and nothing that acts on
 *   it may be offered; `owner` is the block the control belongs to.
 * - `away`: anywhere else, or nowhere.
 */
export type FocusPlace =
    | { kind: 'text' }
    | { kind: 'chrome' }
    | { kind: 'control'; owner: { node: Node; pos: number } | null }
    | { kind: 'away' };

export type PlaceKind = FocusPlace['kind'];

/** Why the formatting row refuses everything while a control has the focus. */
export const CONTROL_LOCK = 'A source box or a property field holds the focus: apply or cancel it first (Ctrl+Enter, Esc).';

/** What `placeOf` reads of an element: whether it contains another, as `Node.contains` answers (an element contains itself). */
interface Container {
    contains(other: unknown): boolean;
}

/** The place of the focused element `active`, against the editable root and the mount that holds it and the bars. */
export function placeOf(active: Container | null, viewDom: Container, mount: Container | null): PlaceKind {
    if (active === null) {
        return 'away';
    }
    if (active === viewDom) {
        return 'text';
    }
    if (viewDom.contains(active)) {
        return 'control';
    }
    return mount?.contains(active) ? 'chrome' : 'away';
}

export function focusPlace(view: EditorView): FocusPlace {
    const active = document.activeElement;
    const kind = placeOf(active, view.dom, view.dom.parentElement);
    return kind === 'control' ? { kind, owner: ownerOf(view, active as Element) } : { kind };
}

/** The block whose node view drew the atom holding `control`, found by the element ProseMirror drew for it. */
function ownerOf(view: EditorView, control: Element): { node: Node; pos: number } | null {
    const atom = control.closest('.mep-atom');
    if (atom === null || !view.dom.contains(atom)) {
        return null;
    }
    let owner: { node: Node; pos: number } | null = null;
    view.state.doc.descendants((node, pos) => {
        if (owner !== null) {
            return false;
        }
        if (view.nodeDOM(pos) === atom) {
            owner = { node, pos };
            return false;
        }
        // An atom is a block: no need to walk a paragraph's text.
        return !node.isTextblock;
    });
    return owner;
}
