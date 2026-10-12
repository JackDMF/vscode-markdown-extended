import { Node } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';
import { macKeys } from './hint';
import { rawBlockControl } from './nodeViews';
import { panelControl } from './properties';

/**
 * Where the editing focus is: the one answer every bar reads — the object
 * toolbar's two bars, the formatting row, the bubble, the caret the page
 * reports. Read from the focused element each time it is asked, written by
 * nobody: no transaction, no registry, no plugin state, so no bar can hold a
 * stale copy of it.
 *
 * - `text`: the editable root has the focus — the caret is a place in the text.
 * - `chrome`: the editor's own controls outside the text — the formatting row,
 *   the bubble, a menu, an object bar; `field` when it is an inline field (a
 *   bar's, or the row's own **Insert → Link…**).
 * - `control`: a control a node view declares as its own — an open source box
 *   (`RawBlockView`), anything in the properties panel (`PropertiesView`).
 *   The selection is still there but hidden behind it, and nothing that acts
 *   on it may be offered; `owner` is the block that declared it, `field`
 *   whether something is being typed (a box, a property's field) rather than
 *   a button pressed.
 * - `content`: anything else inside the text's element that can take the
 *   focus — another extension's lens, a status badge, a summary table's cell,
 *   a link in a rendering. Not a control: the bars read the selection as for
 *   the text, but there is no caret to draw a bubble at.
 * - `away`: anywhere else, or nowhere.
 */
export type FocusPlace =
    | { kind: 'text' }
    | { kind: 'chrome'; field: boolean }
    | { kind: 'control'; owner: { node: Node; pos: number } | null; field: boolean }
    | { kind: 'content' }
    | { kind: 'away' };

/** What a node view declares about the element that has the focus: its block's position, and whether it is a field. */
export interface DeclaredControl {
    pos: number | undefined;
    field: boolean;
}

/** `placeOf`'s answer: the place, with a control as its node view declared it. */
export type Place =
    | { kind: 'text' }
    | { kind: 'chrome'; field: boolean }
    | { kind: 'control'; control: DeclaredControl }
    | { kind: 'content' }
    | { kind: 'away' };

/** What `placeOf` reads of an element: whether it contains another, as `Node.contains` answers (an element contains itself). */
interface Container {
    contains(other: unknown): boolean;
}

/** What `placeOf` asks about the focused element: which node view declares it its control, and whether it is a bar's inline field. */
export interface PlaceReader<E> {
    control(el: E): DeclaredControl | null;
    inlineField(el: E): boolean;
}

/** The place of the focused element `active`, against the editable root and the mount that holds it and the bars. */
export function placeOf<E extends Container>(active: E | null, viewDom: Container, mount: Container | null, read: PlaceReader<E>): Place {
    if (active === null) {
        return { kind: 'away' };
    }
    if (active === viewDom) {
        return { kind: 'text' };
    }
    if (viewDom.contains(active)) {
        const control = read.control(active);
        return control === null ? { kind: 'content' } : { kind: 'control', control };
    }
    return mount?.contains(active) ? { kind: 'chrome', field: read.inlineField(active) } : { kind: 'away' };
}

const DOM_READER: PlaceReader<Element> = {
    control: el => rawBlockControl(el) ?? panelControl(el),
    inlineField: el => el.classList.contains('mep-inline-field'),
};

/** Where the focus of the page is, for `view`. */
export function focusPlace(view: EditorView): FocusPlace {
    return placeOfElement(view, document.activeElement);
}

/** Where `el` would be, were it focused — `focusLeft` asks it of the element the focus is going to. */
export function placeOfElement(view: EditorView, el: Element | null): FocusPlace {
    const place = placeOf(el, view.dom, view.dom.parentElement, DOM_READER);
    if (place.kind !== 'control') {
        return place;
    }
    const pos = place.control.pos;
    const node = pos === undefined ? null : view.state.doc.nodeAt(pos);
    return { kind: 'control', owner: node === null || pos === undefined ? null : { node, pos }, field: place.control.field };
}

/**
 * Why the formatting row refuses everything while a control has the focus,
 * and how to get it back: shown at the row's end, read as its description, and
 * each refused tool's tooltip. A field has something to apply or cancel; a
 * button of the panel has not.
 */
export function controlLock(field: boolean): string {
    return field
        ? `Editing source · ${macKeys() ? 'Cmd' : 'Ctrl'}+Enter apply · Esc cancel`
        : 'Focus is outside the text · Esc or click into the text';
}
