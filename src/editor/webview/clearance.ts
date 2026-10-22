/**
 * What counts as content (Daniel, 2026-09-29): the one fact a floating layer
 * keeps off — a character of a textblock, a table's cell, an image, an atom,
 * another extension's lens row — and where the chrome over the page ends
 * (`rowCeiling`). Where a layer goes is `placement.ts`'s:
 * its policy reads this oracle to break a tie between below and above.
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

/** How far apart the points are that a band is probed at. */
const PROBE_STEP = 16;

/** On the mount while the placement probes (`placement.ts`): the page's floating chrome takes no hit then (`editor.css`). */
export const PROBING_CLASS = 'mep-probing';

/**
 * What counts as occupied besides text: a cell of a table the editor edits —
 * an empty one too, since a cell is the table's content and the page draws it
 * to be seen (`editor.css`) — an image, an atom of any kind, and another
 * extension's lens row above a block.
 */
const OCCUPIED = '.ProseMirror > table td, .ProseMirror > table th, img:not(.ProseMirror-separator), .mep-atom, .mep-inline-atom, .mep-lens-row';

/**
 * The bottom of the formatting row (fixed at the editor's top) in `mount`:
 * nothing is placed under it. The row's lock note stands in the row, so the
 * row is all the chrome there is (wave 2 #2).
 */
export function rowCeiling(mount: HTMLElement): number {
    const row = mount.querySelector(':scope > .mep-toolbar');
    return Math.max(0, row ? row.getBoundingClientRect().bottom : 0);
}

/**
 * Whether anything the page shows as content lies in `band`: a character of a
 * textblock, or what `OCCUPIED` names. Probed at points across the band's
 * middle and near its edges: a point over a line of text resolves to a
 * position whose character stands at that point; a point beside a short line,
 * or between blocks, resolves to a position somewhere else, which is no text.
 */
export function contentIn(view: EditorView, band: Band): boolean {
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
 * part of the line it hangs beside, as `anchorOf` in `placement.ts` keeps
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
