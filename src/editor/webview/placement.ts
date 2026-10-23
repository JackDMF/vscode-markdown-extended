/**
 * Where a floating layer goes, and which one shows: one policy and one slot
 * for every layer of the page (Daniel, 2026-10-19, wave 2 · #9).
 *
 * **The policy.** A layer stands at its anchor's start — what it is about: an
 * object, the selection, the caret's line, the control that opened it — x
 * clamped between the text column's left and the layer edge (the editor's
 * right edge less `LAYER_GUTTER`, or `GAP` short of a margin lane). It goes
 * below the anchor, `GAP` away, else above it; a place qualifies only under
 * the formatting row (and its lock line), inside the window, off the caret's
 * line and off every other open layer. Where both qualify, text decides: the
 * one whose band (`probeBand`) covers none, else below — above for an inline
 * object's bar. Neither: an anchor running out of the window keeps the layer at
 * the visible edge; otherwise it goes below the caret's line, inside the
 * window. No layer keeps a ladder of its own.
 *
 * **The slot.** One floating layer at a time — the selection's bubble, an
 * object's bar, a field bar, the pointer's bar (`LayerSlot`): a selection shows
 * the bubble, a caret rest the bar, a field replaces its bar, the pointer's
 * bar shows only while the slot is empty. A layer that appeared or moved
 * ignores the pointer for `INERT_MS`.
 *
 * Section A is pure (no DOM at module level, no ProseMirror): the unit suite
 * reads it in the extension host. Sections B and C read the DOM inside their
 * functions only. What counts as content is `clearance.ts`'s fact; where a
 * layer goes is this one.
 */
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { PROBING_CLASS, contentIn, firstLineTop, rowCeiling } from './clearance';
import { focusPlace } from './focusPlace';
import { rightLaneEdge } from './lane';
import { AttributesTarget, EditorObject, currentTarget, isBlockObject, isBlockPlaced, isMarkObject, objectOfNode } from './objects';

// -- A. The policy (pure) -----------------------------------------------------

/** The one gap: between a layer and what it stands against. */
export const GAP = 4;
/** A layer grown past the text column stops this short of the editor's right edge. */
export const LAYER_GUTTER = 16;
/** The rest that shows a layer: the caret's in an object, a keyboard selection's, the typing re-arm. */
export const REST_MS = 400;
/** A layer that appeared or moved ignores the pointer this long. */
export const INERT_MS = 250;

/** A rectangle in the window's coordinates. */
export interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface Size {
    width: number;
    height: number;
}

/** Where layers may stand: the column's left, the layer edge on the right, the row's bottom, the window's bottom. */
export interface Frame {
    columnLeft: number;
    layerEdge: number;
    ceiling: number;
    floor: number;
    /** The text column's right edge: a layer that fits the column keeps to it (wave 1, 2026-10-16); only a wider one stands past it, up to `layerEdge`. Absent: `layerEdge` for every layer. */
    columnRight?: number;
    /** The window's right edge less the gutter: a layer wider than the room (a field's floor) is kept left of it. Absent: no such clamp. */
    windowRight?: number;
}

/** The right edge a layer of `width` may reach in `frame`: the column's when it fits the column, else the layer edge. */
function rightEdge(width: number, frame: Frame): number {
    return frame.columnRight !== undefined && width <= frame.columnRight - frame.columnLeft ? Math.min(frame.columnRight, frame.layerEdge) : frame.layerEdge;
}

export interface Context {
    /** The caret's line across the column; a place over it never qualifies. */
    caret?: Rect | null;
    /** Rects of the other open layers; a place over one never qualifies. */
    avoid?: readonly Rect[];
    /** Whether a band covers text (the probe); the tie-break only. Absent = never covered. */
    covered?: (band: Rect) => boolean;
    /** The side that wins where text is under both: 'above' for an inline object's bar (Daniel, 2026-10-20); the default is below. A side free of text always wins. */
    bothCovered?: 'above' | 'below';
}

export type Side = 'below' | 'above' | 'right' | 'left' | 'edge' | 'caret' | 'none';

export interface Placement {
    x: number;
    y: number;
    side: Side;
    /** Set where the layer is taller than the room on both sides of its opener: the height it is shrunk to (it scrolls), the room of the side it stands on. */
    maxHeight?: number;
}

function overlaps(a: Rect, b: Rect): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** The layer's rect at `x`, `y`. */
function rectAt(x: number, y: number, size: Size): Rect {
    return { left: x, top: y, right: x + size.width, bottom: y + size.height };
}

/** Whether a layer of `size` at `x`, `y` stands inside `frame`, off the caret's line and off every open layer. */
function qualifies(x: number, y: number, size: Size, frame: Frame, ctx: Context): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y) || y < frame.ceiling + GAP || y + size.height > frame.floor) {
        return false;
    }
    const rect = rectAt(x, y, size);
    return !(ctx.caret && overlaps(rect, ctx.caret)) && !(ctx.avoid ?? []).some(r => overlaps(rect, r));
}

/** The band the probe tests: the layer's rect grown by GAP on every side (the critic's "full rectangle + gap"). */
export function probeBand(x: number, y: number, size: Size): Rect {
    return { left: x - GAP, top: y - GAP, right: x + size.width + GAP, bottom: y + size.height + GAP };
}

/**
 * Below the anchor, else above; x = anchor.left clamped into
 * [columnLeft, layerEdge - width]. Both free: the one whose band covers no
 * text (`covered`); text under both: `bothCovered` (below unless an inline
 * object's bar), else below. Neither qualifies: an anchor running out of the
 * window while still in view keeps the layer at the visible bottom edge (the
 * top one where that is on the caret's line); otherwise below the caret's line,
 * else above it, and only where neither fits kept inside the window — or, no
 * caret, below the anchor. An anchor wholly out of the window pins nothing.
 */
export function placeStacked(size: Size, anchor: Rect, frame: Frame, ctx: Context = {}): Placement {
    // A layer wider than the room was fitted to it before (`ObjectBar.fit`): this clamps, never shrinks.
    const clamped = Math.max(frame.columnLeft, Math.min(anchor.left, rightEdge(size.width, frame) - size.width));
    // Wider than the column allows (a field's floor, `fieldFloor`): kept inside the window, left of the column if it must.
    const x = frame.windowRight !== undefined && clamped + size.width > frame.windowRight ? Math.max(LAYER_GUTTER, frame.windowRight - size.width) : clamped;
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - size.height;
    const belowOk = qualifies(x, below, size, frame, ctx);
    const aboveOk = qualifies(x, above, size, frame, ctx);
    if (belowOk && aboveOk) {
        const covered = ctx.covered;
        if (covered) {
            const textBelow = covered(probeBand(x, below, size));
            const textAbove = covered(probeBand(x, above, size));
            if (textBelow && !textAbove) {
                return { x, y: above, side: 'above' };
            }
            if (textBelow && textAbove && ctx.bothCovered === 'above') {
                return { x, y: above, side: 'above' };
            }
        }
        return { x, y: below, side: 'below' };
    }
    if (belowOk) {
        return { x, y: below, side: 'below' };
    }
    if (aboveOk) {
        return { x, y: above, side: 'above' };
    }
    const inView = anchor.bottom > frame.ceiling && anchor.top < frame.floor;
    if (inView && (anchor.top < frame.ceiling || anchor.bottom > frame.floor)) {
        // A table, a source block or a selection that runs out of the window — past
        // either edge, no place qualifying: the bar sticks to the visible edge. An
        // anchor wholly out of the window (scrolled away) is none of that: its layer
        // is not pinned over text that has nothing to do with it.
        const y = frame.floor - GAP - size.height;
        const onCaret = ctx.caret ? overlaps(rectAt(x, y, size), ctx.caret) : false;
        return { x, y: onCaret ? frame.ceiling + GAP : y, side: 'edge' };
    }
    // Where nothing else qualifies: off the caret's line — below it where that is inside the
    // window, else above it — and only where neither fits, kept inside the window.
    const lowest = Math.max(frame.ceiling + GAP, frame.floor - size.height);
    if (ctx.caret) {
        const underCaret = ctx.caret.bottom + GAP;
        if (underCaret + size.height <= frame.floor) {
            return { x, y: underCaret, side: 'caret' };
        }
        const overCaret = ctx.caret.top - GAP - size.height;
        if (overCaret >= frame.ceiling + GAP) {
            return { x, y: overCaret, side: 'caret' };
        }
        return { x, y: Math.min(underCaret, lowest), side: 'caret' };
    }
    // No caret: below the anchor, inside the window — unless the anchor is out of it, where its layer is too.
    return { x, y: inView ? Math.min(below, lowest) : below, side: 'below' };
}

/**
 * Right of the anchor, else left of it — top-aligned at `alignTop`, clamped
 * into the frame — else (`fallback` 'stacked') below or above it, never
 * 'caret' or 'edge', else 'none'. A beside place never covers its anchor.
 */
export function placeBeside(size: Size, anchor: Rect, alignTop: number, frame: Frame, ctx: Context = {}, fallback: 'stacked' | 'none' = 'stacked'): Placement {
    const y = Math.max(frame.ceiling + GAP, Math.min(alignTop, frame.floor - size.height));
    const right = anchor.right + GAP;
    if (right + size.width <= frame.layerEdge && qualifies(right, y, size, frame, ctx)) {
        return { x: right, y, side: 'right' };
    }
    const left = anchor.left - GAP - size.width;
    if (left >= frame.columnLeft && qualifies(left, y, size, frame, ctx)) {
        return { x: left, y, side: 'left' };
    }
    if (fallback === 'stacked') {
        const stacked = placeStacked(size, anchor, frame, ctx);
        if (stacked.side === 'below' || stacked.side === 'above') {
            // 'below' is also the no-caret last resort: it counts only where it really qualifies, off the anchor.
            if (qualifies(stacked.x, stacked.y, size, frame, ctx) && !overlaps(rectAt(stacked.x, stacked.y, size), anchor)) {
                return stacked;
            }
        }
    }
    return { x: right, y, side: 'none' };
}

/**
 * A refusal at a pressed control (#10): under the surface the control stands
 * on — the row, the bubble, a bar — at the control's left, so it never covers
 * the control or its neighbours' row; above the control where the window has
 * no room below. It stands above every layer and keeps off none.
 */
export function placeAtControl(size: Size, control: Rect, surface: Rect, frame: Frame): Placement {
    return placeStacked(size, { left: control.left, right: control.right, top: control.top, bottom: Math.max(control.bottom, surface.bottom) }, frame, { avoid: [] });
}

/**
 * A refusal at a pressed menu entry (#10): beside the menu, right else left,
 * top-aligned at the entry; where neither side has room, above the menu at
 * its right end (over the row's right end) — never at the window's floor,
 * away from the entry (ux-critic #10 (a)).
 */
export function placeAtEntry(size: Size, menu: Rect, entry: Rect, frame: Frame): Placement {
    const beside = placeBeside(size, menu, entry.top, frame, {}, 'none');
    if (beside.side !== 'none') {
        return beside;
    }
    const x = Math.max(frame.columnLeft, Math.min(menu.right - size.width, frame.layerEdge - size.width));
    return { x, y: Math.max(frame.ceiling, menu.top - GAP - size.height), side: 'above' };
}

/**
 * `keys` after each key in `moves` followed it to its new key — or ended, where
 * it maps to `null`. Built in one go from the old set, so a key that shifts
 * onto another one's old name takes nothing from it.
 */
export function rekeyed(keys: Iterable<string>, moves: ReadonlyMap<string, string | null>): Set<string> {
    const next = new Set<string>();
    for (const key of keys) {
        const to = moves.has(key) ? moves.get(key) : key;
        if (to !== null && to !== undefined) {
            next.add(to);
        }
    }
    return next;
}

/** Whether `b` differs from `a` by a pixel: the inert time is armed again only then. */
export function moved(a: Placement | null, b: Placement): boolean {
    return a === null || Math.abs(a.x - b.x) >= 1 || Math.abs(a.y - b.y) >= 1;
}

/**
 * A menu panel of `size` under its opener (`align` 'start': its left at the
 * opener's, 'end': its right at the opener's), `gap` away (`GAP`; a submenu
 * under its entry has none: a band between them would belong to the next
 * entry, whose pointer-enter closes the submenu), flipping above where the
 * window ends; kept inside `frame`. Taller than the room on both sides, it
 * goes below, else above — the larger room, below on a tie — with `maxHeight`
 * that room: never over its opener.
 */
export function placeMenuAt(size: Size, opener: Rect, frame: Frame, align: 'start' | 'end' = 'start', gap = GAP): Placement {
    const left = align === 'end' ? opener.right - size.width : opener.left;
    const x = Math.max(frame.columnLeft, Math.min(left, frame.layerEdge - size.width));
    const below = opener.bottom + gap;
    if (below + size.height <= frame.floor) {
        return { x, y: below, side: 'below' };
    }
    const above = opener.top - gap - size.height;
    if (above >= frame.ceiling) {
        return { x, y: above, side: 'above' };
    }
    // Taller than the room on both sides: never over its opener (it would cover the entry or face it
    // was opened from). On the larger side, below on a tie, its height shrunk to that room.
    const roomBelow = Math.max(0, frame.floor - below);
    const roomAbove = Math.max(0, opener.top - gap - frame.ceiling);
    if (roomBelow >= roomAbove) {
        return { x, y: below, side: 'below', maxHeight: roomBelow };
    }
    return { x, y: opener.top - gap - roomAbove, side: 'above', maxHeight: roomAbove };
}

// -- B. Readers and writers (DOM) ----------------------------------------------

/** A block's content edge: `.mep-atom` stands 8px out on each side (`editor.css`). */
const ATOM_INSET = 8;

/** A menu's padding: a submenu stands this much above its opener, so its first entry is level with it. */
const MENU_PADDING = 4;

/**
 * Every floating layer of the page, one list: the bars, the bubble and the
 * field bars (`.mep-layer`), the menus and the preview card, the language
 * card and the completion list. A layer placed by the policy keeps off the
 * others; a hint keeps off all of them. The hint and the tooltip are not
 * layers: neither is in it.
 */
export const LAYER_SELECTOR = '.mep-layer, .mep-menu, .mep-preview-card, .mep-language-card, .mep-completions';

function rectOf(r: DOMRect | Rect): Rect {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/**
 * The right edge a layer may reach: the text column's (the mount's), or — a
 * floating layer may stand past the column (Daniel, 2026-10-16) — the
 * editor's right edge less `LAYER_GUTTER`, whichever is further; but never
 * into a margin lane reserved for notes (`rightLaneEdge`): `GAP` short of it.
 */
export function layerEdge(mount: HTMLElement): number {
    const column = mount.getBoundingClientRect().right;
    const lane = rightLaneEdge();
    const edge = document.documentElement.clientWidth - LAYER_GUTTER;
    return Math.max(column, lane === null ? edge : Math.min(edge, lane - GAP));
}

/** The mount frame: everything about the text — the column, the layer edge, under the row (and its lock line), inside the window. */
export function readFrame(mount: HTMLElement): Frame {
    const column = mount.getBoundingClientRect();
    return {
        columnLeft: column.left, columnRight: column.right, layerEdge: layerEdge(mount), ceiling: rowCeiling(mount), floor: window.innerHeight,
        windowRight: document.documentElement.clientWidth - LAYER_GUTTER,
    };
}

/** The width no field is narrower than (#8 review 1), as `.mep-hint`'s: min(44ch of `el`'s font, the window less 2 × `LAYER_GUTTER`). */
export function fieldFloor(el: HTMLElement): number {
    const em = parseFloat(getComputedStyle(el).fontSize) || 12;
    // A `ch` of the UI font, about half an em: measured once per size would buy nothing the floor needs.
    return Math.min(44 * em * 0.55, document.documentElement.clientWidth - 2 * LAYER_GUTTER);
}

/** The viewport frame: the chrome's — menus, the preview card, tooltips. */
export const VIEWPORT = (): Frame => ({ columnLeft: 0, layerEdge: window.innerWidth, ceiling: 0, floor: window.innerHeight });

/**
 * The caret's line across the column, ±2 px, or `null` where there is no
 * caret in the text: no text selection, or the focus in a node view's control
 * (a source box) that hides it. A bar or field that has the focus keeps the
 * caret's line: the caret is still where the person was.
 */
export function caretBand(view: EditorView, frame: Frame): Rect | null {
    const sel = view.state.selection;
    if (!(sel instanceof TextSelection) || focusPlace(view).kind === 'control') {
        return null;
    }
    try {
        const c = view.coordsAtPos(sel.head);
        return { left: frame.columnLeft, right: frame.layerEdge, top: c.top - 2, bottom: c.bottom + 2 };
    } catch {
        return null;
    }
}

/** The caret at `pos`, a rect one pixel wide on its line: what a field without a target is anchored to. */
export function caretRect(view: EditorView, pos: number): Rect {
    const c = view.coordsAtPos(pos);
    return { left: c.left, top: c.top, right: c.left + 1, bottom: c.bottom };
}

/** Rects of every visible floating layer (`LAYER_SELECTOR`) but `except`, what it holds and what holds it. */
export function openLayers(mount: HTMLElement, except?: Element): Rect[] {
    return Array.from(mount.querySelectorAll<HTMLElement>(LAYER_SELECTOR))
        .filter(el => !(except && (el === except || except.contains(el) || el.contains(except))) && !el.hidden && el.getClientRects().length > 0)
        .map(el => el.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0)
        .map(rectOf);
}

/**
 * Where a field for the block `target` names stands — at the block's left edge, as its bar does —
 * whichever menu or bar opened it, not at the caret or the text's last line: the anchor of the
 * block's own object (`anchorOf`), the one rule, so a field opened from Formatting and the same
 * field opened from the block's bar flip to the same top. The block as it is now (`currentTarget`:
 * the position a field was opened at may have moved or gone in a resync); `null` where it is gone
 * or not drawn. A block that is no object of its own (a paragraph, a list) is read as a block
 * with attributes, its text's first line the top: what its bar would anchor to once it had a literal;
 * a list item's is its first block's (`anchorOf`), so its field stands under the item's own line.
 */
export function blockAnchor(view: EditorView, target: AttributesTarget): Rect | null {
    const current = currentTarget(view.state, target);
    if (current === null) {
        return null;
    }
    const object: EditorObject = objectOfNode(current.node, current.pos)
        ?? { kind: 'block_attrs', from: current.pos, to: current.pos + current.node.nodeSize, node: current.node };
    return anchorOf(view, object);
}

/**
 * The window scrolled for a field of `height` about to open under `block`
 * (#8: an outer part's — the List's under a list far below the caret): when
 * the field would stand past the window's bottom, or the block's last line
 * is above its top, by the difference, so the field and that line are in
 * view. The caret does not move. What it returns puts the scroll back: after
 * a cancel where it was, after a commit too — unless the caret's line would
 * then be out of view. `null` where nothing scrolled; only on open and close,
 * never per key.
 */
export function revealField(view: EditorView, block: Rect | null, height: number): ((committed: boolean) => void) | null {
    const scroller = document.scrollingElement;
    if (block === null || !(scroller instanceof HTMLElement)) {
        return null;
    }
    const bottom = block.bottom + GAP + height + GAP;
    const delta = bottom > window.innerHeight ? bottom - window.innerHeight : block.bottom < GAP ? block.bottom - GAP - height : 0;
    if (delta === 0) {
        return null;
    }
    const saved = scroller.scrollTop;
    scroller.scrollTop = saved + delta;
    return committed => {
        const now = scroller.scrollTop;
        scroller.scrollTop = saved;
        if (committed) {
            // The caret's line out of view once the scroll is back (the commit grew the block above it): left where it is.
            const caret = caretRect(view, Math.min(view.state.selection.head, view.state.doc.content.size));
            if (caret !== null && (caret.bottom < 0 || caret.top > window.innerHeight)) {
                scroller.scrollTop = now;
            }
        }
    };
}

/**
 * An object's anchor, in the window's coordinates: an inline object's first
 * line's start and top, its last line's bottom; a block's box — an atom's
 * less its inset, a heading's or an attributed block's from its text's first
 * line. `null` where it is not drawn.
 */
export function anchorOf(view: EditorView, object: EditorObject): Rect | null {
    try {
        if (isBlockPlaced(object)) {
            // A list item's box is its first block's (#8): its bar and its field stand under the item's own line, not under the list nested in it.
            const dom = isMarkObject(object) ? null : view.nodeDOM(object.kind === 'list_item' ? object.from + 1 : object.from);
            if (!(dom instanceof Element)) {
                return null;
            }
            const box = dom.getBoundingClientRect();
            const inset = isBlockObject(object) ? ATOM_INSET : 0;
            const textual = object.kind === 'heading' || object.kind === 'block_attrs' || object.kind === 'list_item';
            const top = (textual ? firstLineTop(dom) : null) ?? box.top;
            return { left: box.left + inset, top, right: box.right - inset, bottom: box.bottom };
        }
        if (!isMarkObject(object)) {
            const dom = view.nodeDOM(object.from);
            if (dom instanceof Element) {
                // An inline element's own line boxes: a note's body floated into
                // the margin is not one of them, so the layer keeps to the reference's lines.
                const rects = Array.from(dom.getClientRects()).filter(r => r.width > 0 || r.height > 0);
                if (rects.length > 0) {
                    return { left: rects[0].left, top: rects[0].top, right: Math.max(...rects.map(r => r.right)), bottom: rects[rects.length - 1].bottom };
                }
            }
        }
        const start = view.coordsAtPos(object.from, 1);
        const end = view.coordsAtPos(object.to, -1);
        return { left: start.left, top: Math.min(start.top, end.top), right: Math.max(start.right, end.right), bottom: Math.max(start.bottom, end.bottom) };
    } catch {
        return null;
    }
}

/**
 * A range's anchor from its line boxes: the left of its LAST line — the
 * layer stands under that line, so its x belongs to it (on one line, the
 * range's start) — the top of its first, the bottom of its last. The range is
 * kept inside the document; `null` where it is not drawn.
 */
export function rangeAnchor(view: EditorView, rawFrom: number, rawTo: number): Rect | null {
    // A range a field was opened on, the document shorter since (a resync): kept inside it.
    const size = view.state.doc.content.size;
    const from = Math.max(0, Math.min(rawFrom, size));
    const to = Math.max(from, Math.min(rawTo, size));
    let rects: DOMRect[] = [];
    try {
        const start = view.domAtPos(from, 1);
        const end = view.domAtPos(to, -1);
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    } catch {
        rects = [];
    }
    if (rects.length === 0) {
        try {
            const s = view.coordsAtPos(from, 1);
            const e = view.coordsAtPos(to, -1);
            return { left: s.left, top: Math.min(s.top, e.top), right: Math.max(s.right, e.right), bottom: Math.max(s.bottom, e.bottom) };
        } catch {
            // Not drawn: the thing the layer is about is gone, and the claim ends.
            return null;
        }
    }
    // The last line: the boxes beside the lowest-starting one.
    const lastTop = Math.max(...rects.map(r => r.top));
    const last = rects.filter(r => r.bottom > lastTop);
    return {
        left: Math.min(...last.map(r => r.left)),
        top: Math.min(...rects.map(r => r.top)),
        right: Math.max(...last.map(r => r.right)),
        bottom: Math.max(...rects.map(r => r.bottom)),
    };
}

export interface PlaceOptions {
    /** The view whose caret and text the layer keeps off; none for a layer that knows neither (the language card). */
    view?: EditorView;
    mount: HTMLElement;
    /** Where `el` is positioned: `absolute` in the mount, or `fixed` in the window. */
    space: 'mount' | 'viewport';
    /** Keep off the caret's line (`caretBand`). */
    caret?: boolean;
    /** Break a tie by text (`contentIn`, probing with the floating chrome looked through). */
    covered?: boolean;
    /** The layer itself and what it holds, left out of the open layers; `el` when not given. */
    except?: Element;
    /** The frame and the other open layers, where the caller has read them already: not read twice. */
    frame?: Frame;
    avoid?: readonly Rect[];
    /** The side that wins where text is under both (`Context.bothCovered`). */
    bothCovered?: 'above' | 'below';
}

/** Write `p` (viewport coordinates) as `el`'s position in its space. */
function writeAt(el: HTMLElement, x: number, y: number, space: 'mount' | 'viewport', mount?: HTMLElement): void {
    const base = space === 'mount' && mount ? mount.getBoundingClientRect() : { left: 0, top: 0 };
    el.style.left = `${x - base.left}px`;
    el.style.top = `${y - base.top}px`;
}

/**
 * Place `el` — shown, so it can be measured — by `placeStacked` against
 * `anchor`, in the mount frame, keeping off the open layers; returns the
 * placement in viewport coordinates. It never arms the inert time: only the
 * slot knows whether the layer moved.
 */
export function placeLayer(el: HTMLElement, anchor: Rect, opts: PlaceOptions): Placement {
    const frame = opts.frame ?? readFrame(opts.mount);
    const view = opts.view;
    const ctx: Context = {
        caret: opts.caret && view ? caretBand(view, frame) : null,
        avoid: opts.avoid ?? openLayers(opts.mount, opts.except ?? el),
        bothCovered: opts.bothCovered,
    };
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    let placement: Placement;
    if (opts.covered && view) {
        // One style change around the probes, not one per probe.
        opts.mount.classList.add(PROBING_CLASS);
        try {
            placement = placeStacked(size, anchor, frame, { ...ctx, covered: band => contentIn(view, band) });
        } finally {
            opts.mount.classList.remove(PROBING_CLASS);
        }
    } else {
        placement = placeStacked(size, anchor, frame, ctx);
    }
    writeAt(el, placement.x, placement.y, opts.space, opts.mount);
    return placement;
}

/**
 * A menu panel (`position: fixed`) under its opener — its left at the
 * opener's, or its right for `align` 'end' — flipping above where the window
 * ends; a submenu (`parentPanel`) beside its parent panel at the opener's
 * top, right else left, else — neither fits — under its entry, over the parent.
 */
export function placeMenu(panel: HTMLElement, opener: Element, parentPanel?: HTMLElement, align: 'start' | 'end' = 'start'): Placement {
    const frame = VIEWPORT();
    // A height a former placement shrank the panel to is not its height now ("…" moves entries; a re-place measures anew).
    panel.style.maxHeight = '';
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const r = rectOf(opener.getBoundingClientRect());
    let p: Placement;
    if (parentPanel) {
        const parent = rectOf(parentPanel.getBoundingClientRect());
        p = placeBeside(size, parent, r.top - MENU_PADDING, frame, {}, 'none');
        if (p.side === 'none') {
            // Neither side of the parent has room (a narrow window, a menu moved into "…"): under its
            // entry, over the parent — the panel is later in the page than its parent, so it is painted
            // above it, and the entry it was opened from stays in sight. Butted against the entry, no
            // `GAP`: the band would be the next entry's, and the pointer entering it closes the submenu.
            p = placeMenuAt(size, r, frame, 'start', 0);
        }
    } else {
        p = placeMenuAt(size, r, frame, align);
    }
    writeAt(panel, p.x, p.y, 'viewport');
    if (p.maxHeight !== undefined) {
        panel.style.maxHeight = `${p.maxHeight}px`;
    }
    return p;
}

/**
 * The preview card (`position: fixed`, shown) beside its menu — right, else
 * left — top-aligned at the highlighted entry, else below or above the menu,
 * never over it or the entry, nor over `others` (the menu's open parents: a
 * menu that stands under its entry covers part of the room above it). False
 * where none of those has room: the caller hides it.
 */
export function placeCard(card: HTMLElement, menuPanel: HTMLElement, entry: HTMLElement, others: readonly HTMLElement[] = []): boolean {
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const avoid = others.map(el => rectOf(el.getBoundingClientRect()));
    const p = placeBeside(size, rectOf(menuPanel.getBoundingClientRect()), entry.getBoundingClientRect().top, VIEWPORT(), { avoid }, 'stacked');
    if (p.side === 'none') {
        return false;
    }
    writeAt(card, p.x, p.y, 'viewport');
    return true;
}

/**
 * A tooltip (`position: fixed`) under its control, or beside it; in the
 * viewport frame and over every layer (it stands above them all), so it keeps
 * off none. Where nothing qualifies, kept inside the window.
 */
export function placeTip(tip: HTMLElement, owner: HTMLElement, place: 'below' | 'beside'): Placement {
    const frame = VIEWPORT();
    const size = { width: tip.offsetWidth, height: tip.offsetHeight };
    const r = rectOf(owner.getBoundingClientRect());
    let p = place === 'beside' ? placeBeside(size, r, r.top, frame) : placeStacked(size, r, frame);
    if (p.side === 'none') {
        p = {
            x: Math.max(0, Math.min(r.right + GAP, frame.layerEdge - size.width)),
            y: Math.max(0, Math.min(r.top, frame.floor - size.height)),
            side: 'none',
        };
    }
    writeAt(tip, p.x, p.y, 'viewport');
    return p;
}

// -- C. The slot (one occupant, one arbiter) -----------------------------------

export type LayerKind = 'bubble' | 'bar' | 'field' | 'hover';

/** Why the slot hid a layer. */
export type HideReason = 'displaced' | 'dismissed' | 'typing' | 'suppressed' | 'released' | 'invalid';

export interface LayerClaim {
    kind: LayerKind;
    /** What the layer is about: an object's `bar@${kind}@${from}`, a selection's `sel@${from}-${to}`, a field's `field@${from}-${to}`. Esc's dismissal and the re-place cache key on it. */
    key: string;
    el: HTMLElement;
    /** The anchor now, in viewport coordinates; `null` when the thing is gone (the claim is released). */
    anchor(): Rect | null;
    /** The owner's own precondition (the selection is still non-empty, the object still at the caret). */
    valid(): boolean;
    /** The slot hid the layer: by another claim, Esc, typing, release. The owner clears its own state (tips, menus, fields). */
    hidden(reason: HideReason): void;
    /** Fit the layer to the room it may take before it is placed (`ObjectBar.fit`); `fresh` after a font loaded. */
    fit?(room: number, fresh: boolean): void;
    /** Where text is under both sides: 'above' for an inline object's bar (the policy's `bothCovered`); absent: below. */
    bothCovered?: 'above' | 'below';
}

/** What the occupant was last placed from, in viewport coordinates: a re-place with the same inputs (anchor, size, frame, the other layers) does nothing. */
interface Placed {
    key: string;
    anchor: Rect;
    width: number;
    height: number;
    frame: Frame;
    /** The other open layers it kept off. */
    avoid: Rect[];
}

/** Where an element was last written, in its own space: what `moved` compares. */
interface Written {
    el: HTMLElement;
    at: Placement;
}

const slots = new WeakMap<EditorView, LayerSlot>();

function sameRect(a: Rect, b: Rect): boolean {
    return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.right - b.right) < 0.5 && Math.abs(a.bottom - b.bottom) < 0.5;
}

function sameFrame(a: Frame, b: Frame): boolean {
    return Math.abs(a.columnLeft - b.columnLeft) < 0.5 && Math.abs(a.layerEdge - b.layerEdge) < 0.5
        && Math.abs(a.ceiling - b.ceiling) < 0.5 && Math.abs(a.floor - b.floor) < 0.5 && Math.abs((a.columnRight ?? 0) - (b.columnRight ?? 0)) < 0.5;
}

/**
 * The one floating layer of a view: the selection's bubble, an object's bar,
 * a field bar or the pointer's bar — one at a time. A 'hover' claim takes
 * only an empty slot; every other kind displaces the occupant, which comes
 * back on its owner's next rest, never by the slot. Priority is no number:
 * the kinds exclude each other by state (a non-empty selection has no caret
 * bar; a field is opened from a bar or the row and replaces it).
 *
 * The slot places its occupant (`placeLayer`: caret's line, text, the other
 * layers) and places it again on a scroll, a resize or a font loading —
 * once per frame, and only when the
 * anchor, the size or the frame changed. A layer that appeared or moved
 * ignores the pointer for `INERT_MS` (`data-inert`) — a field, asked for and
 * focused, excepted; the keyboard is untouched.
 */
export class LayerSlot {
    private occupant: LayerClaim | null = null;
    private readonly dismissed = new Set<string>();
    private menuOpen = false;
    private placed: Placed | null = null;
    private written: Written | null = null;
    private inertEl: HTMLElement | null = null;
    private inertTimer: ReturnType<typeof setTimeout> | undefined;
    private frameRequest: number | undefined;
    private refitNext = false;
    private holders = 0;
    private destroyed = false;
    private readonly freed = new Set<() => void>();
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];

    /** One per view, shared by the row's view and the bars' view: each that takes it gives it back with `destroy`. */
    static for(view: EditorView, mount: HTMLElement): LayerSlot {
        let slot = slots.get(view);
        if (slot === undefined) {
            slot = new LayerSlot(view, mount);
            slots.set(view, slot);
        }
        slot.holders++;
        return slot;
    }

    private constructor(private readonly view: EditorView, private readonly mount: HTMLElement) {
        // A scroll fires many times a frame, and placing probes the layout: once per frame.
        this.listen(window, 'scroll', () => this.replaceInFrame(), true);
        this.listen(window, 'resize', () => this.replaceInFrame());
        // A font that loaded after the layer was fitted changed its labels' widths.
        this.listen(document.fonts, 'loadingdone', () => {
            this.refitNext = true;
            this.replaceInFrame();
        });
    }

    get current(): LayerClaim | null {
        return this.occupant;
    }

    holds(kind: LayerKind): boolean {
        return this.occupant?.kind === kind;
    }

    /**
     * Take the slot with `claim`, its element shown by the owner: a 'hover'
     * claim only when the slot is empty (or holds a hover); every other kind
     * displaces the occupant — except a field, which only another field or a
     * `force` claim displaces (its text would be lost). Refused while `key` is
     * dismissed or a row menu is open, unless `force` (Alt+Enter). The occupant
     * asking again is placed again where its anchor, size or frame changed.
     */
    request(claim: LayerClaim, opts: { force?: boolean } = {}): boolean {
        if (this.destroyed) {
            return false;
        }
        const current = this.occupant;
        const same = current !== null && current.key === claim.key && current.el === claim.el;
        if (!same) {
            if (claim.kind === 'hover' && current !== null && current.kind !== 'hover') {
                return false;
            }
            if ((this.dismissed.has(claim.key) || this.suppressed) && !opts.force) {
                return false;
            }
            // A field holds what its person typed: only a field, or a forced claim (Alt+Enter), takes its place.
            if (current !== null && current.kind === 'field' && claim.kind !== 'field' && !opts.force) {
                return false;
            }
        }
        this.dismissed.delete(claim.key);
        if (!same && current !== null && current.el !== claim.el) {
            this.occupant = null;
            current.hidden('displaced');
        }
        const appeared = current === null || current.el !== claim.el;
        this.occupant = claim;
        if (!same) {
            this.placed = null;
        }
        claim.el.hidden = this.hides(claim);
        if (!this.hides(claim)) {
            // A claim whose anchor is gone, on a slot that was empty, leaves it empty: nobody left, nobody to tell.
            this.place(appeared, current !== null);
        }
        if (this.occupant === null) {
            // The anchor was gone: the claim ended as it was made.
            return false;
        }
        return true;
    }

    /** The owner let go of `key` (it hid the layer itself). */
    release(key: string): void {
        if (this.occupant?.key === key) {
            this.vacate();
        }
    }

    /** Place the occupant again if its anchor, size or frame changed; the inert time only if it moved. */
    replace(): void {
        const claim = this.occupant;
        if (claim === null || this.hides(claim) || this.destroyed) {
            return;
        }
        if (!claim.valid()) {
            this.vacate();
            claim.hidden('invalid');
            return;
        }
        this.place(false);
    }

    /** The occupant's content changed size (a field's refusal line, a fit): placed again, the inert time only if it moved. */
    contentChanged(key: string): void {
        if (this.occupant?.key === key && !this.hides(this.occupant)) {
            this.placed = null;
            this.place(false);
        }
    }

    /** Esc: the layer about `key` hides, and `key` is refused until `caretLeft(key)`; Alt+Enter's `force` overrides. */
    dismiss(key: string): void {
        this.dismissed.add(key);
        const claim = this.occupant;
        if (claim?.key === key) {
            this.vacate();
            claim.hidden('dismissed');
        }
    }

    /** The caret (or the selection) left what `key` is about: its dismissal ends. */
    caretLeft(key: string): void {
        this.dismissed.delete(key);
    }

    /**
     * What the dismissals were about has moved (a change of the document shifted
     * it): each key in `moves` follows to its new key, or ends where it maps to
     * `null`. All at once, so keys shifting onto one another do not collide.
     */
    rekeyAll(moves: ReadonlyMap<string, string | null>): void {
        const next = rekeyed(this.dismissed, moves);
        this.dismissed.clear();
        for (const key of next) {
            this.dismissed.add(key);
        }
    }

    /** The dismissed keys starting with `prefix`: what an owner ends once the caret is elsewhere. */
    dismissedOf(prefix: string): string[] {
        return Array.from(this.dismissed).filter(k => k.startsWith(prefix));
    }

    /** A keystroke changed the text: a 'bar' occupant hides; its owner asks again on its next rest. */
    typing(): void {
        const claim = this.occupant;
        if (claim?.kind === 'bar') {
            this.vacate();
            claim.hidden('typing');
        }
    }

    /** Whether a row menu is open: every layer but a field is refused and hidden meanwhile (`suppress`). */
    get suppressed(): boolean {
        return this.menuOpen;
    }

    /**
     * A row menu opened (`true`) or closed: the occupant hides while it is open,
     * and comes back after if still valid — a field does not: hiding the input
     * that has the focus would blur it, and a blur cancels, the typed text lost.
     * A slot found empty when the menu closes tells its waiters (`onFreed`): the
     * bubble or the pointer's bar that was refused while the menu was open.
     */
    suppress(on: boolean): void {
        if (on === this.menuOpen || this.destroyed) {
            return;
        }
        this.menuOpen = on;
        const claim = this.occupant;
        if (claim === null) {
            if (!on) {
                this.announceFree();
            }
            return;
        }
        if (claim.kind === 'field') {
            return;
        }
        if (on) {
            claim.el.hidden = true;
            return;
        }
        if (!claim.valid()) {
            this.vacate();
            claim.hidden('invalid');
            return;
        }
        claim.el.hidden = false;
        this.placed = null;
        this.place(true);
    }

    /** Whether the open row menu hides `claim`: every kind but a field. */
    private hides(claim: LayerClaim): boolean {
        return this.menuOpen && claim.kind !== 'field';
    }

    /** Call `listener` (after the current task) whenever the slot becomes empty: a pointer's bar waiting for it. Returns the unsubscribe. */
    onFreed(listener: () => void): () => void {
        this.freed.add(listener);
        return () => this.freed.delete(listener);
    }

    /** Give the slot back; the last holder takes it down. */
    destroy(): void {
        if (--this.holders > 0 || this.destroyed) {
            return;
        }
        this.destroyed = true;
        slots.delete(this.view);
        if (this.frameRequest !== undefined) {
            cancelAnimationFrame(this.frameRequest);
        }
        clearTimeout(this.inertTimer);
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.freed.clear();
        this.occupant = null;
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    /** The occupant is gone; `announce` false where there was none before it (a claim refused at its first placement). */
    private vacate(announce = true): void {
        this.occupant = null;
        this.placed = null;
        if (announce) {
            this.announceFree();
        }
    }

    /** The slot is empty: its waiters hear it after the current task, if it still is. */
    private announceFree(): void {
        if (this.freed.size > 0) {
            setTimeout(() => {
                if (!this.destroyed && this.occupant === null) {
                    for (const listener of Array.from(this.freed)) {
                        listener();
                    }
                }
            }, 0);
        }
    }

    private replaceInFrame(): void {
        if (this.frameRequest === undefined && !this.destroyed) {
            this.frameRequest = requestAnimationFrame(() => {
                this.frameRequest = undefined;
                this.replace();
            });
        }
    }

    /**
     * Place the occupant; `appeared`: it was not shown a moment ago, so the
     * pointer is refused whether or not it moved. `hadOccupant`: something held
     * the slot before it — only then does its anchor being gone free the slot
     * for the waiters.
     */
    private place(appeared: boolean, hadOccupant = true): void {
        const claim = this.occupant;
        if (claim === null) {
            return;
        }
        const anchor = claim.anchor();
        if (anchor === null) {
            this.vacate(hadOccupant);
            claim.hidden('released');
            return;
        }
        const frame = readFrame(this.mount);
        const fresh = this.refitNext;
        this.refitNext = false;
        // A field's room is never narrower than a hint's (#8 review 1): a user stylesheet's narrow column or margin lane
        // (petrol at 520 px wrapped a keys line at 150 px) gives it min(44ch, window − 32 px), placed inside the window.
        const room = frame.layerEdge - frame.columnLeft;
        claim.fit?.(claim.kind === 'field' ? Math.max(room, fieldFloor(claim.el)) : room, fresh);
        const width = claim.el.offsetWidth;
        const height = claim.el.offsetHeight;
        const avoid = openLayers(this.mount, claim.el);
        const prev = this.placed;
        if (!appeared && !fresh && prev !== null && prev.key === claim.key && sameRect(prev.anchor, anchor)
            && Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5 && sameFrame(prev.frame, frame)
            && prev.avoid.length === avoid.length && prev.avoid.every((r, i) => sameRect(r, avoid[i]))) {
            return;
        }
        const p = placeLayer(claim.el, anchor, { view: this.view, mount: this.mount, space: 'mount', caret: true, covered: true, except: claim.el, frame, avoid, bothCovered: claim.bothCovered });
        // Compared where it is written: a layer that scrolls with the text has not moved.
        const base = this.mount.getBoundingClientRect();
        const at: Placement = { x: p.x - base.left, y: p.y - base.top, side: p.side };
        const before = this.written?.el === claim.el ? this.written.at : null;
        this.written = { el: claim.el, at };
        this.placed = { key: claim.key, anchor, width, height, frame, avoid };
        if (claim.kind === 'field') {
            // A field was asked for and has the focus: nothing under the pointer is meant for the text, and its
            // set-verb menu opens inside it — no inert time (a bar the field replaced gives up what it had).
            this.disarm(claim.el);
        } else if (appeared || moved(before, at)) {
            this.arm(claim.el);
        }
    }

    /** `el` takes the pointer again before its inert time is over. */
    private disarm(el: HTMLElement): void {
        if (this.inertEl === el) {
            clearTimeout(this.inertTimer);
            this.inertEl = null;
        }
        delete el.dataset.inert;
    }

    /** The pointer is refused by `el` for `INERT_MS` (`.mep-layer[data-inert]`). */
    private arm(el: HTMLElement): void {
        if (this.inertEl !== null && this.inertEl !== el) {
            delete this.inertEl.dataset.inert;
        }
        this.inertEl = el;
        el.dataset.inert = '';
        clearTimeout(this.inertTimer);
        this.inertTimer = setTimeout(() => {
            delete el.dataset.inert;
            if (this.inertEl === el) {
                this.inertEl = null;
            }
        }, INERT_MS);
    }
}
