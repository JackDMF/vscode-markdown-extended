/**
 * Editing inside a note or a sidebar: the keys, the caret's way in and out,
 * and typing where the browser would put the text in the wrong span.
 *
 * A note is `sidenote(note_ref, sidenote_body)` (a marginal note likewise), a
 * sidebar one node holding its text (`schema.ts`). Each part is an inline node
 * with content, which ProseMirror edits well inside and the browser handles
 * poorly at its edges: a caret right after a note's span, or in an empty part,
 * has no place of its own in the DOM, and typed text lands in whichever span
 * the browser picks. So the edges are ProseMirror's here, not the browser's.
 *
 * The keys, inside a part:
 *
 * - `Tab` / `Enter` in the reference go to the body (selecting it while it is
 *   still the placeholder); in the body or a sidebar they leave the note, the
 *   caret after it. `Shift+Tab` goes back: body to reference, reference to
 *   before the note.
 * - `Esc` leaves the note, the caret after it.
 * - `→` at the end of the reference goes to the body, at the end of the body
 *   or a sidebar out of the note; `←` at a start goes back the same way. From
 *   outside, `→` before a note and `←` after it go in.
 * - `Backspace` at the start of an empty reference (or of an empty sidebar)
 *   removes the whole note — no husk is left. At the start of one with text it
 *   selects the note, and a second `Backspace` removes it; at the start of the
 *   body it goes to the end of the reference. `Backspace` right after a note
 *   and `Delete` right before one select it the same way. `Delete` at the end
 *   of a part does nothing: parts are not joined.
 */
import { Fragment, Mark, Node, ResolvedPos, Slice } from 'prosemirror-model';
import { Command, EditorState, NodeSelection, Plugin, Selection, TextSelection, Transaction } from 'prosemirror-state';
import { undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { EditorView } from 'prosemirror-view';
import { PRESERVE_SOURCE_META, asRepair, isRepair, writtenEdit } from '../fidelity';
import { textblockSource } from '../positions';
import { NOTE_NODES, NOTE_PART_NODES, editorSchema } from '../schema';
import { RAW_TEXT_MARKS, unwritableEmbed, unwritableInNote } from '../serialize';
import { showHint } from './hint';
import { inlineForNote, runWikiEmbedInput } from './wikiEmbeds';

const nodes = editorSchema.nodes;

/** The text a new note's body starts with, selected, so typing replaces it. */
export const NOTE_BODY_PLACEHOLDER = 'note';
/** The text a note made from no selection starts with in its reference: the plugin refuses an empty one. */
export const NOTE_REF_PLACEHOLDER = 'reference';
/** The text a sidebar made from no selection starts with. */
export const SIDEBAR_PLACEHOLDER = 'sidebar';

/** Where the caret is in a note: the part, the note, and the positions around both. */
export interface NoteContext {
    /** The part holding the position: a reference, a body, or a sidebar. */
    part: Node;
    /** The note or sidebar node. */
    note: Node;
    /** Positions of the part's content: start and end. */
    partStart: number;
    partEnd: number;
    /** Positions right before and right after the note node. */
    noteBefore: number;
    noteAfter: number;
    /** `ref`, `body`, or `sidebar`. */
    role: 'ref' | 'body' | 'sidebar';
}

/** The note part `$pos` is in, the innermost one, or `null`. */
export function noteContextAt($pos: ResolvedPos): NoteContext | null {
    for (let d = $pos.depth; d > 0; d--) {
        const part = $pos.node(d);
        if (!NOTE_PART_NODES.has(part.type.name)) {
            continue;
        }
        const sidebar = NOTE_NODES.has(part.type.name);
        const noteDepth = sidebar ? d : d - 1;
        return {
            part,
            note: $pos.node(noteDepth),
            partStart: $pos.start(d),
            partEnd: $pos.end(d),
            noteBefore: $pos.before(noteDepth),
            noteAfter: $pos.after(noteDepth),
            role: sidebar ? 'sidebar' : part.type === nodes.note_ref ? 'ref' : 'body',
        };
    }
    return null;
}

function caret(state: EditorState, pos: number): TextSelection {
    return TextSelection.create(state.doc, pos);
}

/** The body's content range, given a note's start position. */
function bodyRange(state: EditorState, noteBefore: number): { from: number; to: number } {
    const note = state.doc.nodeAt(noteBefore) as Node;
    const refSize = note.child(0).nodeSize;
    const from = noteBefore + 1 + refSize + 1;
    return { from, to: from + note.child(1).content.size };
}

function refRange(state: EditorState, noteBefore: number): { from: number; to: number } {
    const note = state.doc.nodeAt(noteBefore) as Node;
    const from = noteBefore + 2;
    return { from, to: from + note.child(0).content.size };
}

/** Into the body: at its end, or over it while it is still the placeholder. */
function enterBody(state: EditorState, noteBefore: number): TextSelection {
    const { from, to } = bodyRange(state, noteBefore);
    const body = state.doc.textBetween(from, to);
    return body === NOTE_BODY_PLACEHOLDER ? TextSelection.create(state.doc, from, to) : caret(state, to);
}

/** A command acting on an empty selection inside a note part. */
function inPart(run: (state: EditorState, ctx: NoteContext, pos: number) => Selection | 'delete' | 'swallow' | null): Command {
    return (state, dispatch) => {
        const sel = state.selection;
        if (!(sel instanceof TextSelection)) {
            return false;
        }
        const ctx = noteContextAt(sel.$head);
        if (!ctx) {
            return false;
        }
        const result = run(state, ctx, sel.head);
        if (result === null) {
            return false;
        }
        if (dispatch) {
            if (result === 'delete') {
                const tr = state.tr.delete(ctx.noteBefore, ctx.noteAfter);
                dispatch(tr.setSelection(TextSelection.create(tr.doc, ctx.noteBefore)).scrollIntoView());
            } else if (result !== 'swallow') {
                dispatch(state.tr.setSelection(result).scrollIntoView());
            }
        }
        return true;
    };
}

/** Leave the note: the caret right after it. */
export const leaveNote: Command = inPart((state, ctx) => caret(state, ctx.noteAfter));

/** Tab and Enter: reference → body, body or sidebar → after the note. */
export const nextNotePart: Command = inPart((state, ctx) =>
    ctx.role === 'ref' ? enterBody(state, ctx.noteBefore) : caret(state, ctx.noteAfter));

/** Shift+Tab: body → end of the reference, reference or sidebar → before the note. */
export const previousNotePart: Command = inPart((state, ctx) =>
    ctx.role === 'body' ? caret(state, refRange(state, ctx.noteBefore).to) : caret(state, ctx.noteBefore));

/** → at the end of a part. */
const arrowRightInPart: Command = inPart((state, ctx, pos) => {
    if (!state.selection.empty || pos !== ctx.partEnd) {
        return null;
    }
    return ctx.role === 'ref' ? caret(state, bodyRange(state, ctx.noteBefore).from) : caret(state, ctx.noteAfter);
});

/** ← at the start of a part. */
const arrowLeftInPart: Command = inPart((state, ctx, pos) => {
    if (!state.selection.empty || pos !== ctx.partStart) {
        return null;
    }
    return ctx.role === 'body' ? caret(state, refRange(state, ctx.noteBefore).to) : caret(state, ctx.noteBefore);
});

/** Backspace at the start of a part. */
const backspaceInPart: Command = inPart((state, ctx, pos) => {
    if (!state.selection.empty || pos !== ctx.partStart) {
        return null;
    }
    if (ctx.role === 'body') {
        return caret(state, refRange(state, ctx.noteBefore).to);
    }
    if (ctx.part.content.size === 0) {
        return 'delete';
    }
    return NodeSelection.create(state.doc, ctx.noteBefore);
});

/**
 * Backspace or Delete of one character inside a part, done by ProseMirror.
 * Left to the browser, deleting the last character of a part empties its span,
 * the browser drops the span, and the note read back from the DOM has lost a
 * part — the reference's text reappears as the body.
 */
function deleteCharInPart(dir: -1 | 1): Command {
    return (state, dispatch) => {
        const sel = state.selection;
        if (!(sel instanceof TextSelection) || !sel.empty) {
            return false;
        }
        const ctx = noteContextAt(sel.$head);
        const pos = sel.head;
        if (!ctx || (dir < 0 ? pos <= ctx.partStart : pos >= ctx.partEnd)) {
            return false;
        }
        // A character outside the Basic Multilingual Plane is two positions.
        const pair = dir < 0 ? state.doc.textBetween(Math.max(ctx.partStart, pos - 2), pos) : state.doc.textBetween(pos, Math.min(ctx.partEnd, pos + 2));
        const size = pair.length === 2 && /^[\ud800-\udbff][\udc00-\udfff]$/.test(pair) ? 2 : 1;
        if (dispatch) {
            dispatch((dir < 0 ? state.tr.delete(pos - size, pos) : state.tr.delete(pos, pos + size)).scrollIntoView());
        }
        return true;
    };
}

/** Delete at the end of a part: parts are never joined. */
const deleteInPart: Command = inPart((state, ctx, pos) =>
    state.selection.empty && pos === ctx.partEnd ? 'swallow' : null);

/** The note node right before (`-1`) or after (`1`) an empty selection outside notes. */
function adjacentNote(state: EditorState, dir: -1 | 1): { pos: number; node: Node } | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) {
        return null;
    }
    const $pos = sel.$head;
    const node = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
    if (!node || !NOTE_NODES.has(node.type.name)) {
        return null;
    }
    return { pos: dir < 0 ? $pos.pos - node.nodeSize : $pos.pos, node };
}

/** Select the note next to the caret (Backspace after one, Delete before one). */
function selectAdjacentNote(dir: -1 | 1): Command {
    return (state, dispatch) => {
        const found = adjacentNote(state, dir);
        if (!found) {
            return false;
        }
        if (dispatch) {
            dispatch(state.tr.setSelection(NodeSelection.create(state.doc, found.pos)));
        }
        return true;
    };
}

/** → before a note goes into it (its reference, or a sidebar's text); ← after one into its end. */
function enterAdjacentNote(dir: -1 | 1): Command {
    return (state, dispatch) => {
        const found = adjacentNote(state, dir);
        if (!found) {
            return false;
        }
        if (dispatch) {
            const sidebar = NOTE_PART_NODES.has(found.node.type.name);
            let target: number;
            if (dir > 0) {
                target = sidebar ? found.pos + 1 : refRange(state, found.pos).from;
            } else {
                target = sidebar ? found.pos + found.node.nodeSize - 1 : bodyRange(state, found.pos).to;
            }
            dispatch(state.tr.setSelection(caret(state, target)).scrollIntoView());
        }
        return true;
    };
}

function chain(...commands: Command[]): Command {
    return (state, dispatch, view) => commands.some(c => c(state, dispatch, view));
}

/** The keys of a note, ahead of every other keymap. */
export function noteKeymap(): Plugin {
    return keymap({
        'Tab': nextNotePart,
        'Enter': nextNotePart,
        'Shift-Tab': previousNotePart,
        'Escape': leaveNote,
        'ArrowRight': chain(arrowRightInPart, enterAdjacentNote(1)),
        'ArrowLeft': chain(arrowLeftInPart, enterAdjacentNote(-1)),
        // Right after an input rule (a typed `]]` made an embed), Backspace gives back what was typed.
        'Backspace': chain(undoInputRule, backspaceInPart, deleteCharInPart(-1), selectAdjacentNote(-1)),
        'Delete': chain(deleteInPart, deleteCharInPart(1), selectAdjacentNote(1)),
    });
}

// ---------------------------------------------------------------------------
// The caret between a note's two parts, and typing at the edges
// ---------------------------------------------------------------------------

/**
 * A text position inside a note but outside both its parts (before the
 * reference, between the two, after the body) is where a click on the note's
 * own span can put the caret, and no text can go there. The caret is moved
 * into the nearest part, the way it was heading.
 */
function normalizedSelection(state: EditorState, previous: Selection): Selection | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) {
        return null;
    }
    const $pos = sel.$head;
    const parent = $pos.parent;
    if (parent.type !== nodes.sidenote && parent.type !== nodes.marginal_note) {
        return null;
    }
    const noteBefore = $pos.before();
    const index = $pos.index();
    const forward = sel.head >= previous.head;
    if (index === 0) {
        return caret(state, refRange(state, noteBefore).from);
    }
    if (index === 1) {
        return caret(state, forward ? bodyRange(state, noteBefore).from : refRange(state, noteBefore).to);
    }
    return caret(state, bodyRange(state, noteBefore).to);
}

/** Whether typing at the selection must be done by ProseMirror rather than the browser. */
function typingAtNoteEdge(state: EditorState): boolean {
    const sel = state.selection;
    if (!(sel instanceof TextSelection)) {
        return false;
    }
    if (noteContextAt(sel.$from) !== null || noteContextAt(sel.$to) !== null) {
        return true;
    }
    const around = [sel.$from.nodeBefore, sel.$from.nodeAfter, sel.$to.nodeBefore, sel.$to.nodeAfter];
    return around.some(n => n !== null && NOTE_NODES.has(n.type.name));
}

/** prosemirror-history's meta key; an undo restores a state that was allowed. */
const HISTORY_META = 'history$';

/**
 * Why the transaction must not be applied: it leaves a note in the range it
 * changed that the serializer cannot write back (`unwritableInNote`), judged
 * against the document the transaction started from: a sidebar seam the file
 * already held is never refused, only one the transaction created. Checked
 * is exactly what the save will write again, in the document the fidelity
 * plugin's repair makes of the edit (`writtenEdit`, from the plan the plugin
 * applies): every textblock of each top-level block whose `src` that plan
 * clears, wherever it stands — the other items of the list typed in, the other
 * cells of its table, a copied heading whose id it strips — and none of a
 * block it keeps. A re-sync from the host and an undo are never refused; each
 * puts back a document that was written or allowed. Nor is a repair a plugin
 * appends (`isRepair`): it follows a transaction checked here, and the
 * fidelity plugin's applies the very plan checked. Then a wiki embed under a
 * raw mark in that range (`unwritableEmbed`). The one check the filter makes,
 * and the one a verb asks before it is dispatched, so a button is disabled with
 * the filter's own reason.
 */
export function noteRefusal(tr: Transaction): string | null {
    const range = refusableRange(tr);
    if (range === null) {
        return null;
    }
    const before = tr.before;
    const written = writtenEdit(tr);
    return unwritableInNote(written.doc, range.from, range.to, {
        doc: before,
        mapping: tr.mapping,
        rewritten: written.rewritten,
        sourceOf: pos => textblockSource(before, pos),
    }) ?? unwritableEmbed(tr.doc, range.from, range.to);
}

/**
 * The range of the new document a transaction changed, which a refusal is
 * decided over — the notes' here, the tables' (`tables.ts`) — or `null` for one
 * that is never refused: no change, a re-sync from the host, an undo, a repair
 * a plugin appends to a transaction already checked (`isRepair`).
 */
export function refusableRange(tr: Transaction): { from: number; to: number } | null {
    if (!tr.docChanged || tr.getMeta(PRESERVE_SOURCE_META) === true || tr.getMeta(HISTORY_META) !== undefined || isRepair(tr)) {
        return null;
    }
    let from = Infinity;
    let to = -Infinity;
    tr.steps.forEach((step, i) => {
        const range = step as unknown as { from?: unknown; to?: unknown };
        if (typeof range.from !== 'number' || typeof range.to !== 'number') {
            from = 0;
            to = tr.doc.content.size;
            return;
        }
        const after = tr.mapping.slice(i);
        from = Math.min(from, after.map(range.from, -1));
        to = Math.max(to, after.map(range.to, 1));
    });
    return from > to ? null : { from, to };
}

/**
 * The plugin that keeps the caret out of the places between a note's parts,
 * inserts typed text itself inside and next to a note (the DOM has no caret
 * position of its own after a note's span, or in an empty part, and the
 * browser would put the text into the neighbouring span), and pastes into a
 * part as text — a slice of paragraphs would split the note in two.
 */
export function notesPlugin(embedInput: Plugin): Plugin {
    let editorView: EditorView | null = null;
    return new Plugin({
        // The one edit the serializer cannot write back is refused here,
        // whatever made it — a key, the toolbar, a paste, typing into a code
        // span — with the reason shown beside the caret (`noteRefusal`); and
        // so is a wiki embed made code, superscript or subscript (`unwritableEmbed`).
        filterTransaction(tr) {
            const reason = noteRefusal(tr);
            if (reason !== null) {
                if (editorView) {
                    showHint(editorView, reason, 'refusal');
                }
                return false;
            }
            return true;
        },
        view(view) {
            editorView = view;
            return {
                destroy() {
                    editorView = null;
                },
            };
        },
        appendTransaction(transactions, oldState, newState) {
            if (!transactions.some(tr => tr.selectionSet)) {
                return null;
            }
            const fixed = normalizedSelection(newState, oldState.selection);
            return fixed ? asRepair(newState.tr.setSelection(fixed)) : null;
        },
        props: {
            handleDOMEvents: {
                beforeinput(view, event) {
                    const e = event as InputEvent;
                    if (e.isComposing || !typingAtNoteEdge(view.state)) {
                        return false;
                    }
                    if (e.inputType === 'insertText' && typeof e.data === 'string') {
                        e.preventDefault();
                        // The embed input rule first (a `]]` closing `![[name]]`), and no
                        // other: a block rule (three backticks, `# `, `- `) would turn the line holding the note into a block.
                        const { from, to } = view.state.selection;
                        const text = e.data;
                        if (!runWikiEmbedInput(embedInput, view, from, to, text)) {
                            view.dispatch(view.state.tr.insertText(text).scrollIntoView());
                        }
                        return true;
                    }
                    // A deletion the keymap did not take (a word, a line): what the
                    // browser would delete, clamped to the part, deleted by
                    // ProseMirror — an emptied span dropped by the browser would
                    // lose the part.
                    const ctx = noteContextAt(view.state.selection.$head);
                    const ranges = e.inputType.startsWith('delete') && ctx ? e.getTargetRanges() : [];
                    if (ctx && ranges.length === 1) {
                        const from = Math.max(ctx.partStart, view.posAtDOM(ranges[0].startContainer, ranges[0].startOffset));
                        const to = Math.min(ctx.partEnd, view.posAtDOM(ranges[0].endContainer, ranges[0].endOffset));
                        e.preventDefault();
                        if (from < to) {
                            view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
                        }
                        return true;
                    }
                    return false;
                },
            },
            handlePaste(view, _event, slice) {
                const sel = view.state.selection;
                if (noteContextAt(sel.$from) === null && noteContextAt(sel.$to) === null) {
                    return false;
                }
                // One line of the slice's text, with the marks typed text takes
                // here; a wiki embed atom stays one, text stays text (`inlineForNote`).
                const marks = view.state.storedMarks ?? sel.$from.marks();
                const inline = inlineForNote(slice, marks);
                const tr = inline.some(n => n.type === editorSchema.nodes.wiki_embed)
                    ? view.state.tr.replaceSelection(new Slice(Fragment.from(inline), 0, 0))
                    : view.state.tr.insertText(inline.map(n => n.text ?? '').join(''));
                view.dispatch(tr.scrollIntoView());
                return true;
            },
        },
    });
}

// ---------------------------------------------------------------------------
// Making a note from the toolbar
// ---------------------------------------------------------------------------

export type NoteNodeName = 'sidenote' | 'marginal_note' | 'left_sidebar' | 'right_sidebar';

export const NOTE_LOCK = 'Select text in a paragraph or heading, outside any note, to add this.';
export const NESTED_NOTE_LOCK = 'A note cannot hold another note: the text is already in one.';

/**
 * The marks a note may carry from around it. Not code, superscript or
 * subscript: their text is written as it is, so a note inside one is written
 * as its literal syntax and the next parse has no note (`^a ++b|c++ d^`). Not
 * a link: the selection is the link's text, which stays linked inside the
 * reference.
 */
function carriesOnNote(mark: Mark): boolean {
    return !RAW_TEXT_MARKS.has(mark.type.name) && mark.type !== editorSchema.marks.link;
}

/** The marks both ends of the selection share that a note may carry: they go on the note node, not inside it. */
function sharedMarks(state: EditorState, from: number, to: number): readonly Mark[] {
    const $from = state.doc.resolve(from);
    const $to = state.doc.resolve(to);
    if (from === to) {
        return (state.storedMarks ?? $from.marks()).filter(carriesOnNote);
    }
    const first = $from.nodeAfter?.marks ?? [];
    const last = $to.nodeBefore?.marks ?? [];
    return first.filter(m => m.isInSet(last) && carriesOnNote(m));
}

/**
 * Why a note cannot be made at the selection, or `null` when it can. With
 * `name`, also why that kind of note, made of this selection, could not be
 * written back (`unwritableInNote`: selected inline code holding `|`, say).
 */
export function wrapNodeLockReason(state: EditorState, name?: NoteNodeName): string | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection)) {
        return NOTE_LOCK;
    }
    if (noteContextAt(sel.$from) !== null || noteContextAt(sel.$to) !== null) {
        return NESTED_NOTE_LOCK;
    }
    const parent = sel.$from.parent;
    if (!sel.$from.sameParent(sel.$to) || (parent.type !== nodes.paragraph && parent.type !== nodes.heading)) {
        return NOTE_LOCK;
    }
    let crossesNote = false;
    state.doc.nodesBetween(sel.from, sel.to, node => {
        crossesNote = crossesNote || NOTE_NODES.has(node.type.name);
    });
    if (crossesNote) {
        return NESTED_NOTE_LOCK;
    }
    const tr = name === undefined ? null : wrapTransaction(state, name);
    return tr === null ? null : noteRefusal(tr);
}

/** Whether the selection is inside a note of this kind. */
export function inNoteOf(state: EditorState, name: NoteNodeName): boolean {
    return noteOfKindAt(state, name) !== null;
}

/**
 * Make a note or a sidebar of the selection, as the toolbar's `wrap-node`
 * actions do. For a note the selected text becomes the reference and the body
 * starts as the placeholder, selected, so typing writes the note; from no
 * selection the reference is the placeholder, selected (the plugin refuses an
 * empty reference, and an empty part has no place for a caret). For a sidebar
 * the selection becomes its text, the caret at its end; from no selection it
 * is the placeholder, selected. Spaces at the ends of the selection stay
 * outside, and the marks the whole selection had go on the note.
 */
export function wrapInNote(name: NoteNodeName): Command {
    return (state, dispatch) => {
        if (wrapNodeLockReason(state, name) !== null) {
            return false;
        }
        dispatch?.(wrapTransaction(state, name).scrollIntoView());
        return true;
    };
}

/**
 * The note of kind `name` the selection is in — both its ends, or the note
 * selected as a node — with its position; `null` otherwise.
 */
export function noteOfKindAt(state: EditorState, name: NoteNodeName): { pos: number; node: Node } | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return sel.node.type.name === name ? { pos: sel.from, node: sel.node } : null;
    }
    const from = noteContextAt(sel.$from);
    const to = noteContextAt(sel.$to);
    if (from === null || to === null || from.noteBefore !== to.noteBefore || from.note.type.name !== name) {
        return null;
    }
    return { pos: from.noteBefore, node: from.note };
}

/**
 * Remove the note of kind `name` the selection is in and keep its text: a
 * sidenote or marginal note becomes its reference's inline content (the note
 * itself is dropped), a sidebar its own. Marks inside are kept, and the marks
 * the note carried go onto the kept text; the caret is at its end. One step,
 * so one undo brings the note back.
 */
export function unwrapNote(name: NoteNodeName): Command {
    return (state, dispatch) => {
        const found = noteOfKindAt(state, name);
        if (found === null) {
            return false;
        }
        if (dispatch) {
            const { pos, node } = found;
            const kept = NOTE_PART_NODES.has(node.type.name) ? node.content : node.child(0).content;
            const content: Node[] = [];
            kept.forEach(child => {
                content.push(child.mark(node.marks.reduce((set, m) => m.addToSet(set), child.marks)));
            });
            const fragment = Fragment.from(content);
            const tr = state.tr.replaceWith(pos, pos + node.nodeSize, fragment);
            tr.setSelection(TextSelection.create(tr.doc, pos + fragment.size));
            dispatch(tr.scrollIntoView());
        }
        return true;
    };
}

/**
 * Why `unwrapNote(name)` is not run here, so Remove note and Remove sidebar
 * are disabled with it: the filter's reason for the transaction it would
 * dispatch (`noteRefusal`) — a sidebar's text glued to a letter, a reference's
 * to a sidebar — or that there is no such note at the selection.
 */
export function unwrapNoteRefusal(state: EditorState, name: NoteNodeName): string | null {
    let reason: string | null = 'There is no note here.';
    unwrapNote(name)(state, tr => {
        reason = noteRefusal(tr);
    });
    return reason;
}

/** A note action: inside a note of its kind it removes the note (`unwrapNote`), elsewhere it makes one (`wrapInNote`). */
export function toggleNote(name: NoteNodeName): Command {
    return (state, dispatch, view) => unwrapNote(name)(state, dispatch, view) || wrapInNote(name)(state, dispatch, view);
}

/** The transaction `wrapInNote` dispatches, for a selection `wrapNodeLockReason` allows. */
function wrapTransaction(state: EditorState, name: NoteNodeName): Transaction {
    let { from, to } = state.selection;
    if (from !== to) {
        const selected = state.doc.textBetween(from, to, undefined, '￼');
        const lead = selected.length - selected.trimStart().length;
        const trail = selected.length - selected.trimEnd().length;
        if (lead + trail < selected.length) {
            from += lead;
            to -= trail;
        }
    }
    const marks = sharedMarks(state, from, to);
    const inner = from === to ? Fragment.empty : stripMarks(state.doc.slice(from, to).content, marks);
    const text = (s: string) => editorSchema.text(s);
    let note: Node;
    let select: (start: number) => { from: number; to: number };
    if (name === 'sidenote' || name === 'marginal_note') {
        const refContent = inner.size > 0 ? inner : Fragment.from(text(NOTE_REF_PLACEHOLDER));
        const body = (name === 'sidenote' ? nodes.sidenote_body : nodes.marginal_note_body).create(null, text(NOTE_BODY_PLACEHOLDER));
        note = nodes[name].create(null, [nodes.note_ref.create(null, refContent), body], marks);
        select = start => {
            if (inner.size === 0) {
                return { from: start + 2, to: start + 2 + refContent.size };
            }
            const bodyFrom = start + 1 + note.child(0).nodeSize + 1;
            return { from: bodyFrom, to: bodyFrom + NOTE_BODY_PLACEHOLDER.length };
        };
    } else {
        const content = inner.size > 0 ? inner : Fragment.from(text(SIDEBAR_PLACEHOLDER));
        note = nodes[name].create(null, content, marks);
        select = start => (inner.size === 0
            ? { from: start + 1, to: start + 1 + content.size }
            : { from: start + 1 + content.size, to: start + 1 + content.size });
    }
    const tr = state.tr.replaceWith(from, to, note);
    const range = select(from);
    return tr.setSelection(TextSelection.create(tr.doc, range.from, range.to));
}

/** The content with `marks` taken off every node, since the note carries them. */
function stripMarks(content: Fragment, marks: readonly Mark[]): Fragment {
    const out: Node[] = [];
    content.forEach(node => {
        out.push(node.mark(marks.reduce((set, m) => m.removeFromSet(set), node.marks)));
    });
    return Fragment.from(out);
}

