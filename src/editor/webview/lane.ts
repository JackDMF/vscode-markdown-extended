/**
 * The margin lane and the line the person is on.
 *
 * `markdown-extended.css` reserves a lane for notes on `<html>`'s padding once
 * the document holds one and the window is wide enough; the column narrows,
 * every line above the caret rewraps, and the caret's line moves — by 89px at
 * 1280px for the first `++…++` of a page. ProseMirror's own scrolling does not
 * help: the caret is still inside the window. So the update that opens or
 * closes the lane is measured: the line's top before, the same line's top
 * after, and the difference scrolled away.
 *
 * Whether the lane flipped is read from the html element's computed padding —
 * the fact as the stylesheet decides it (its media queries, its `:has()`, a
 * reader's `--mep-note-lane: 0`), never counted from the document.
 */
import { Mappable } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';

/** The html element's padding-left / padding-right as computed: the lane as the stylesheet decides it. */
function laneEdges(): string {
    const style = getComputedStyle(document.documentElement);
    return `${style.paddingLeft} ${style.paddingRight}`;
}

/** The top of the line holding `pos` on screen, or `null` where it cannot be measured. */
function lineTop(view: EditorView, pos: number): number | null {
    try {
        return view.coordsAtPos(pos).top;
    } catch {
        return null;
    }
}

/**
 * Run `apply` (a state update); if the lane opened or closed, scroll so the
 * line holding `head` — mapped through `mapping` — keeps its place on screen.
 * Measured after the update, so whatever moved the line (the reflow,
 * ProseMirror's scrollIntoView, the browser's scroll anchoring) is undone by
 * the difference; if nothing moved, nothing scrolls.
 */
export function keepingLine(view: EditorView, head: number, mapping: Mappable, apply: () => void): void {
    const edges = laneEdges();
    const before = lineTop(view, head);
    apply();
    if (before === null || laneEdges() === edges) {
        return;
    }
    const after = lineTop(view, mapping.map(head));
    if (after !== null && after !== before) {
        window.scrollBy(0, after - before);
    }
}
