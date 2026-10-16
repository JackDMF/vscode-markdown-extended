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
import { Node } from 'prosemirror-model';
import { Transaction } from 'prosemirror-state';
import { Mappable } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import { NOTE_NODES } from '../schema';
import { NOTE_SYNTAX } from '../../syntax/markers';

/** The classes the stylesheet's `:has()` counts as a note or a sidebar on the page. */
const NOTE_CLASSES = [NOTE_SYNTAX.sidenote.noteClass, NOTE_SYNTAX.marginalNote.noteClass, NOTE_SYNTAX.leftSidebar.cssClass, NOTE_SYNTAX.rightSidebar.cssClass];

/** A class attribute in rendered HTML naming one of them: a source block's or an injected atom's notes. */
const NOTE_IN_HTML = new RegExp(`class="(?:[^"]*\\s)?(?:${NOTE_CLASSES.join('|')})(?:\\s[^"]*)?"`);

/** Whether `node` is, or draws, a note or a sidebar of the page. */
function isNoteOnPage(node: Node): boolean {
    return NOTE_NODES.has(node.type.name) || (typeof node.attrs.html === 'string' && NOTE_IN_HTML.test(node.attrs.html));
}

/**
 * Whether `doc` holds a note or a sidebar lying wholly between `from` and
 * `to`: one a step made or removed. A note the range only reaches into — the
 * text typed in it — is a note before and after.
 */
function noteBetween(doc: Node, from: number, to: number): boolean {
    let found = false;
    doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (node, pos) => {
        found ||= pos >= from && pos + node.nodeSize <= to && isNoteOnPage(node);
        return !found;
    });
    return found;
}

/**
 * Whether `tr` can open or close the lane: one of its steps made or removed a
 * note or a sidebar — or an atom whose rendering holds one, which the
 * stylesheet's `:has()` counts as well. Only those decide the lane, so typing,
 * in plain text or in a note, is not measured.
 */
export function touchesNote(tr: Transaction): boolean {
    return tr.steps.some((step, i) => {
        const before = tr.docs[i];
        const after = i + 1 < tr.docs.length ? tr.docs[i + 1] : tr.doc;
        let touched = false;
        step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
            touched ||= noteBetween(before, oldStart, oldEnd) || noteBetween(after, newStart, newEnd);
        });
        return touched;
    });
}

/**
 * The layout as the stylesheet decides it: the html element's padding-left /
 * padding-right (the lane), and whether the document's first note floats —
 * a stylesheet with `--mep-note-lane: 0` reserves nothing, and its notes still
 * flip between the margin and the text.
 */
function laneEdges(): string {
    const style = getComputedStyle(document.documentElement);
    const note = document.querySelector(`.ProseMirror :is(${NOTE_CLASSES.map(c => `.${c}`).join(', ')})`);
    return `${style.paddingLeft} ${style.paddingRight} ${note ? getComputedStyle(note).float : 'none'}`;
}

/**
 * Where the right lane begins, in viewport coordinates — the inner edge of
 * `<html>`'s padding-right where it holds more than the page's own gutter
 * (`--md-page-gutter`) — or `null` while no lane is reserved there. The same
 * fact `laneEdges` reads: a floating layer (an object bar) stays left of it,
 * since past it stand the notes.
 */
export function rightLaneEdge(): number | null {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const padding = parseFloat(style.paddingRight) || 0;
    const gutter = parseFloat(style.getPropertyValue('--md-page-gutter')) || 0;
    return padding > gutter ? root.clientWidth - padding : null;
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
    // A line that was not on screen has no place to keep: ProseMirror's own
    // scrolling brings the caret into view, and is left as it is.
    if (before === null || before < 0 || before >= window.innerHeight || laneEdges() === edges) {
        return;
    }
    const after = lineTop(view, mapping.map(head));
    if (after !== null && after !== before) {
        window.scrollBy(0, after - before);
    }
}
