/**
 * Where a floating bar may go: never over content (Daniel, 2026-09-29). Every
 * bar of the page — an object's bar, a block's, the selection bubble, the
 * toolbar's field bar — says only where it could stand, in order of
 * preference, and `firstFree` answers which of those places is free, by one
 * notion of free for all of them: under the formatting row (fixed at the
 * editor's top, `rowCeiling`) and past
 * the window's bottom is not; over the selection bubble is not (for any bar
 * but the bubble); over content is not (`OCCUPIED`, text). Three ladders with
 * three notions of free had drifted apart — one bar pinned under the row, one
 * blind to images, one to lens rows — so the notion lives here, once.
 *
 * DOM geometry only, read from the view.
 */
import { EditorView } from 'prosemirror-view';

/** A rectangle in the window's coordinates. */
export interface Band {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/**
 * One place a bar could stand: its top left corner, and — when it stands
 * inside a rendered block (a source block's top right) — that block, whose own
 * content is probed instead of the page's. `when` is the bar's own condition
 * (it fits the column, it is off the caret's line).
 */
export interface Place {
    x: number;
    y: number;
    within?: Element;
    when?: () => boolean;
}

/** How far apart the points are that a band is probed at. */
const PROBE_STEP = 16;

/** On the mount while `firstFree` probes: the page's floating chrome takes no hit then (`editor.css`). */
export const PROBING_CLASS = 'mep-probing';

/**
 * What counts as occupied besides text: a cell of a table the editor edits —
 * an empty one too, since a cell is the table's content and the page draws it
 * to be seen (`editor.css`) — an image, an atom of any kind, and another
 * extension's lens row above a block.
 */
const OCCUPIED = '.ProseMirror > table td, .ProseMirror > table th, img:not(.ProseMirror-separator), .mep-atom, .mep-inline-atom, .mep-lens-row';

/** The language cards the page floats over the text (`languageCard.ts`, `completionList.ts`): occupied while open. */
const OPEN_CARDS = ':scope > .mep-language-card, :scope > .mep-completions';

/** What counts as content inside a rendered block, besides its text. */
const OCCUPIED_WITHIN = 'img:not(.ProseMirror-separator), td, th, .mep-inline-atom';

/** The bottom of the formatting row (fixed at the editor's top) in `mount`: nothing is placed under it. */
export function rowCeiling(mount: HTMLElement): number {
    const row = mount.querySelector(':scope > .mep-toolbar');
    return Math.max(0, row ? row.getBoundingClientRect().bottom : 0);
}

function overlaps(a: Band, b: Band): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * The first of `places` where a bar of `size` is free, or `null`. The probing
 * class is set on the mount once around the whole search — one style change,
 * not one per probe. `self` is the bar being placed, which is looked through
 * when it is the bubble (the other bars keep out of the bubble).
 */
export function firstFree(
    view: EditorView, mount: HTMLElement, places: readonly Place[], size: { width: number; height: number }, self?: Element,
): Place | null {
    const ceiling = rowCeiling(mount);
    const bubbleEl = mount.querySelector<HTMLElement>(':scope > .mep-bubble');
    const bubble = bubbleEl && !bubbleEl.hidden && bubbleEl !== self ? bubbleEl.getBoundingClientRect() : null;
    // An open card (a hover, a diagnostic, the completion list) is read, not a bar: no bar covers it.
    const cards = Array.from(mount.querySelectorAll<HTMLElement>(OPEN_CARDS))
        .filter(card => card !== self && !card.hidden)
        .map(card => card.getBoundingClientRect())
        .filter(r => r.width > 0 && r.height > 0);
    mount.classList.add(PROBING_CLASS);
    try {
        for (const place of places) {
            const band = { left: place.x, right: place.x + size.width, top: place.y, bottom: place.y + size.height };
            if (!Number.isFinite(band.left) || band.top < ceiling || band.bottom > window.innerHeight) {
                continue;
            }
            if (place.when && !place.when()) {
                continue;
            }
            if ((bubble && overlaps(bubble, band)) || cards.some(card => overlaps(card, band))) {
                continue;
            }
            if (place.within ? contentWithin(place.within, band) : contentIn(view, band)) {
                continue;
            }
            return place;
        }
        return null;
    } finally {
        mount.classList.remove(PROBING_CLASS);
    }
}

/**
 * Whether anything the page shows as content lies in `band`: a character of a
 * textblock, or what `OCCUPIED` names. Probed at points across the band's
 * middle and near its edges: a point over a line of text resolves to a
 * position whose character stands at that point; a point beside a short line,
 * or between blocks, resolves to a position somewhere else, which is no text.
 */
function contentIn(view: EditorView, band: Band): boolean {
    if (band.right <= band.left || band.bottom <= band.top) {
        return false;
    }
    const rows = [band.top + 2, (band.top + band.bottom) / 2, band.bottom - 2];
    for (const y of rows) {
        for (let x = band.left + 2; x <= band.right - 2; x += PROBE_STEP) {
            if (contentAt(view, x, y)) {
                return true;
            }
        }
    }
    return false;
}

function contentAt(view: EditorView, x: number, y: number): boolean {
    const element = document.elementFromPoint(x, y);
    if (element !== null && view.dom.contains(element) && element.closest(OCCUPIED) !== null) {
        return true;
    }
    const hit = view.posAtCoords({ left: x, top: y });
    if (!hit) {
        return false;
    }
    if (hit.inside >= 0) {
        const node = view.state.doc.nodeAt(hit.inside);
        if (node?.isAtom && node.isBlock) {
            const dom = view.nodeDOM(hit.inside);
            const r = dom instanceof Element ? dom.getBoundingClientRect() : null;
            return r !== null && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        }
    }
    const $pos = view.state.doc.resolve(hit.pos);
    if (!$pos.parent.inlineContent || $pos.parent.content.size === 0) {
        return false;
    }
    // Text at the point: a character on either side of the position whose box spans it.
    // (A point beside a line's end resolves to the end, with no character there.)
    const start = $pos.start();
    const end = $pos.end();
    for (const [from, to] of [[hit.pos - 1, hit.pos], [hit.pos, hit.pos + 1]]) {
        if (from < start || to > end) {
            continue;
        }
        const a = view.coordsAtPos(from, 1);
        const b = view.coordsAtPos(to, -1);
        const left = Math.min(a.left, b.left) - 1;
        const right = Math.max(a.left, b.left) + 1;
        if (a.top <= y && a.bottom >= y && x >= left && x <= right) {
            return true;
        }
    }
    return false;
}

/** Whether a rendered block's own content lies in `band`: its text, and its images, cells and badges. */
function contentWithin(root: Element, band: Band): boolean {
    return textRects(root).some(r => overlaps(r, band))
        || Array.from(root.querySelectorAll(OCCUPIED_WITHIN)).some(el => overlaps(el.getBoundingClientRect(), band));
}

/**
 * The top of the first line of `dom`'s content: where a block's text starts,
 * as its line boxes say — a floated note body left out. `null` for an element
 * that shows no text.
 */
export function firstLineTop(dom: Element): number | null {
    const rects = textRects(dom);
    return rects.length === 0 ? null : Math.min(...rects.map(r => r.top));
}

/**
 * The line boxes of the text inside `root`, whitespace-only text left out, and
 * text in a floated element (a note body set into the margin) too: it is no
 * part of the line it hangs beside, as `anchor()` in `objectToolbar.ts` keeps
 * to a note's reference for the same reason.
 */
function textRects(root: Element): DOMRect[] {
    const rects: DOMRect[] = [];
    const floated = new Map<Element, boolean>();
    const isFloated = (el: Element | null): boolean => {
        for (let at = el; at !== null && at !== root; at = at.parentElement) {
            let known = floated.get(at);
            if (known === undefined) {
                known = getComputedStyle(at).float !== 'none';
                floated.set(at, known);
            }
            if (known) {
                return true;
            }
        }
        return false;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === '' || isFloated(node.parentElement)) {
            continue;
        }
        range.selectNodeContents(node);
        for (const r of Array.from(range.getClientRects())) {
            if (r.width > 0 && r.height > 0) {
                rects.push(r);
            }
        }
    }
    return rects;
}

/**
 * The right edge of the text `dom` shows between `top` and `bottom`: the
 * lines of its text in that band, so a bar beside the first line can be
 * checked against a longer second line reaching under it. `-Infinity` for none.
 */
export function rightEdgeIn(dom: Element, top: number, bottom: number): number {
    let right = -Infinity;
    for (const r of textRects(dom)) {
        if (r.bottom > top && r.top < bottom) {
            right = Math.max(right, r.right);
        }
    }
    return right;
}
