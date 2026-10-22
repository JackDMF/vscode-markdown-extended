import { Node } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';
import { applyKey } from './hint';
import { rawBlockControl } from './nodeViews';
import { panelControl } from './properties';

/**
 * What a declared control is, for what the row says while it has the focus:
 * a source box (a raw block's, the properties' YAML) applied with Ctrl+Enter,
 * a property's own field applied with Enter, or something pressed, not typed
 * in — a button, a checkbox, a chip.
 */
export type ControlRole = 'source' | 'property' | 'button';

/** What a node view declares about the element that has the focus: its block's position, and what kind of control it is. */
export interface DeclaredControl {
    pos: number | undefined;
    role: ControlRole;
}

/** The places that need nothing from the document: the same in `placeOf`'s answer and in `FocusPlace`. */
type PlainPlace =
    | { kind: 'text' }
    | { kind: 'chrome'; field: boolean }
    | { kind: 'content' }
    | { kind: 'away' };

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
 *   on it may be offered; `owner` is the block that declared it, `role` what
 *   kind of control it is (`ControlRole`).
 * - `content`: anything else inside the text's element that can take the
 *   focus — another extension's lens, a status badge, a summary table's cell,
 *   a link in a rendering. Not a control: the bars read the selection as for
 *   the text, but there is no caret to draw a bubble at.
 * - `away`: anywhere else, or nowhere.
 */
export type FocusPlace = PlainPlace | { kind: 'control'; owner: { node: Node; pos: number } | null; role: ControlRole };

/** `placeOf`'s answer: the place, with a control as its node view declared it, its block not yet looked up. */
export type Place = PlainPlace | { kind: 'control'; control: DeclaredControl };

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
    return { kind: 'control', owner: node === null || pos === undefined ? null : { node, pos }, role: place.control.role };
}

/**
 * What an element of the properties panel is (`panelControl`): its YAML box a
 * source box; any other field typed in — a value, a new name, the hidden
 * native date input the calendar button opens — a property's; anything else,
 * pressed rather than typed in, a button.
 */
export function panelRole(el: { tag: string; type?: string; sourceBox: boolean }): ControlRole {
    if (el.sourceBox) {
        return 'source';
    }
    if (el.tag === 'TEXTAREA' || (el.tag === 'INPUT' && !/^(checkbox|radio|button|submit|reset|color|file|range|image)$/.test(el.type ?? 'text'))) {
        return 'property';
    }
    return 'button';
}

/**
 * What a control of the formatting row acts on, which decides whether the
 * focus in a node view's control refuses it (`rowLock`):
 *
 * - `selection`: the text at the selection — every mark, menu and verb of the
 *   row. The selection is hidden behind an open source box or the properties
 *   panel, so these are refused while one has the focus.
 * - `document`: the document as a whole — **Export**. It is offered wherever
 *   the focus is, and takes the document as a save does (`commitSource`): an
 *   open source box (a raw block's, the properties' YAML) and a value typed
 *   into a property's row are applied first; a new property (**+ Add
 *   property**) not yet added with Enter is left out. Its note says so while
 *   the focus is in one (`RowLock.note`).
 */
export type RowScope = 'selection' | 'document';

/** What the focus means for a row control: why it is refused, and what to know when it is pressed now. */
export interface RowLock {
    /** Why it is refused, `null` when it is offered. */
    refusal: string | null;
    /** For an offered control, what the focus changes about what it does; `null` when nothing. */
    note: string | null;
}

/** The note of a document-wide control while the focus is in a node view's control of `role`: what a save would take of it. */
function documentNote(role: ControlRole): string | null {
    switch (role) {
        case 'source':
            return 'Applies the open source box first';
        case 'property':
            return 'Applies the values typed first; a property not yet added with Enter is left out';
        case 'button':
            return null;
    }
}

/** What the focus at `place` means for a row control acting on `scope`: the one answer the row reads for each of its controls. */
export function rowLock(place: FocusPlace, scope: RowScope): RowLock {
    if (place.kind !== 'control') {
        return { refusal: null, note: null };
    }
    return scope === 'selection'
        ? { refusal: controlLock(place.role), note: null }
        : { refusal: null, note: documentNote(place.role) };
}

/**
 * Why the formatting row refuses what acts on the selection while a control
 * has the focus, and how to get it back: shown at the row's end, read as its
 * description, and each refused tool's tooltip. A source box applies with
 * Ctrl+Enter, a property's field with Enter; a button has nothing to apply.
 */
export function controlLock(role: ControlRole): string {
    return lockForms(role).full;
}

/** What the row says while a control has the focus: the whole reason, and its short form for a row too narrow. */
export interface LockForms {
    full: string;
    /** The floor the row shows where `full` does not fit: it never cuts a key (Daniel, 2026-10-19). */
    short: string;
    /** What a press on a refused tool says at that tool (#10): what is off, then how to get it back. */
    press: string;
}

/** `controlLock`'s reason in the forms the row may show it in, and what a press on a refused tool says. */
export function lockForms(role: ControlRole): LockForms {
    switch (role) {
        case 'source':
            return {
                full: `Editing source · ${applyKey()} apply · Esc cancel`,
                short: `Source · ${applyKey()} · Esc`,
                press: `Formatting is off while editing source — ${applyKey()} applies`,
            };
        case 'property':
            return { full: 'Editing a property · Enter apply · Esc cancel', short: 'Property · Enter · Esc', press: 'Formatting is off while editing a property — Enter applies' };
        case 'button':
            return {
                full: 'Focus is outside the text · Esc or click into the text',
                short: 'Outside the text',
                press: 'Formatting is off while the focus is outside the text — press Esc or click into the text',
            };
    }
}
