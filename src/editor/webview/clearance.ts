/**
 * Where a floating bar may go: never over text (Daniel, 2026-09-29). The
 * selection bubble asks here whether the band above the selection holds text,
 * and the object toolbar where a block's first line ends. DOM geometry only,
 * read from the view, so both bars answer "is there text here" the same way.
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

/**
 * Whether any text the page shows lies in `band`: a character of a textblock,
 * or a rendered block (a source block, injected content), whose box is text as
 * far as a reader is concerned. Probed at points across the band's middle and
 * near its edges: a point over a line of text resolves to a position whose
 * character stands at that point; a point beside a short line, or between
 * blocks, resolves to a position somewhere else, which is no text there.
 */
export function textInBand(view: EditorView, band: Band): boolean {
    if (band.right <= band.left || band.bottom <= band.top) {
        return false;
    }
    // The page's floating chrome — a bar, the bubble, a menu — may stand over the
    // band where it was last put; the probe looks through it (`editor.css`).
    const root = document.documentElement;
    root.classList.add(PROBING_CLASS);
    try {
        const rows = [band.top + 2, (band.top + band.bottom) / 2, band.bottom - 2];
        for (const y of rows) {
            for (let x = band.left + 2; x <= band.right - 2; x += PROBE_STEP) {
                if (textAt(view, x, y)) {
                    return true;
                }
            }
        }
        return false;
    } finally {
        root.classList.remove(PROBING_CLASS);
    }
}

/** On the root while `textInBand` probes: the page's floating chrome takes no hit then. */
export const PROBING_CLASS = 'mep-probing';

function textAt(view: EditorView, x: number, y: number): boolean {
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
    const at = view.coordsAtPos(hit.pos);
    return at.top <= y && at.bottom >= y && Math.abs(at.left - x) <= PROBE_STEP;
}

/**
 * The right edge of the first line of `dom`'s content, and that line's top:
 * where a block's text ends on its first line, as its line boxes say. `null`
 * for an element that shows no text.
 */
export function firstLineOf(dom: Element): { top: number; bottom: number; right: number } | null {
    const range = document.createRange();
    range.selectNodeContents(dom);
    const rects = Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0);
    if (rects.length === 0) {
        return null;
    }
    const top = Math.min(...rects.map(r => r.top));
    const first = rects.filter(r => r.top < top + Math.min(...rects.map(q => q.height)) / 2 + 1);
    return { top, bottom: Math.max(...first.map(r => r.bottom)), right: Math.max(...first.map(r => r.right)) };
}

/** The line boxes of the text inside `root` (whitespace-only text left out). */
function textRects(root: Element): DOMRect[] {
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim() === '') {
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

/** Whether any text inside `root` lies in `band` — a rendered block's own text, which `textInBand` sees only as the block. */
export function textInElement(root: Element, band: Band): boolean {
    return textRects(root).some(r => r.left < band.right && r.right > band.left && r.top < band.bottom && r.bottom > band.top);
}
