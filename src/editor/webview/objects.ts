/**
 * The editor's objects, and what their verbs do to the state. ProseMirror only,
 * no DOM, so each verb's transaction is checked on an `EditorState`
 * (`objectToolbar.test.ts`); the object toolbar (`objectToolbar.ts`) draws them.
 *
 * An **object** is a thing in the document that has verbs of its own — that
 * can be removed, converted, opened, or edited as source as a whole — as
 * opposed to text, which is typed. Every object is found the same way, from a
 * position and a node or a mark, and carries the range it occupies:
 *
 * | Object | What it is | Range |
 * | --- | --- | --- |
 * | `note` | A `sidenote`, `marginal_note`, `left_sidebar` or `right_sidebar` node | The node |
 * | `link` | A run of text carrying one `link` mark | The mark's run in its textblock |
 * | `image` | An `image` node | The node |
 * | `badge` | An `inline_atom` (Req Explorer's status badge) | The node |
 * | `raw_block` | A source block | The node |
 * | `injected_block` | Injected content: an expansion, an atom, generated content | The node |
 * | `front_matter` | The front matter | The node |
 *
 * The last three are **block objects**, the first four **inline objects**; the
 * toolbar shows them on different triggers (`objectToolbar.ts`).
 */
import { Mark, Node, ResolvedPos } from 'prosemirror-model';
import { EditorState, NodeSelection, Selection, TextSelection, Transaction } from 'prosemirror-state';
import { editorSchema } from '../schema';
import { serializeInline } from '../serialize';
import { NoteNodeName, noteContextAt, noteRefusal } from './notes';

const nodes = editorSchema.nodes;

export type NodeObjectKind = 'note' | 'image' | 'badge' | 'raw_block' | 'injected_block' | 'front_matter';

export type EditorObject =
    | { kind: 'link'; from: number; to: number; mark: Mark }
    | { kind: NodeObjectKind; from: number; to: number; node: Node };

/** The objects the pointer resting on them shows the toolbar for; the others show it for the caret. */
const BLOCK_OBJECTS: ReadonlySet<string> = new Set(['raw_block', 'injected_block', 'front_matter']);

export function isBlockObject(object: EditorObject): boolean {
    return BLOCK_OBJECTS.has(object.kind);
}

/** Whether two objects are the same one: the same kind at the same place. */
export function sameObject(a: EditorObject | null, b: EditorObject | null): boolean {
    return a !== null && b !== null && a.kind === b.kind && a.from === b.from;
}

const NODE_KINDS: Readonly<Record<string, NodeObjectKind>> = {
    sidenote: 'note',
    marginal_note: 'note',
    left_sidebar: 'note',
    right_sidebar: 'note',
    image: 'image',
    inline_atom: 'badge',
    raw_block: 'raw_block',
    injected_block: 'injected_block',
    front_matter: 'front_matter',
};

/** The object `node` at `pos` is, or `null` for a node that is none. */
export function objectOfNode(node: Node, pos: number): EditorObject | null {
    const kind = NODE_KINDS[node.type.name];
    return kind === undefined ? null : { kind, from: pos, to: pos + node.nodeSize, node };
}

/**
 * The run of `mark` in `$pos`'s textblock that `$pos` stands in or touches, as
 * document positions; `null` when the mark is on neither side of it.
 */
function markRunAt($pos: ResolvedPos, mark: Mark): { from: number; to: number } | null {
    const parent = $pos.parent;
    const at = $pos.parentOffset;
    const start = $pos.start();
    let runFrom = -1;
    let offset = 0;
    for (let i = 0; i <= parent.childCount; i++) {
        const child = i < parent.childCount ? parent.child(i) : null;
        if (child !== null && mark.isInSet(child.marks)) {
            runFrom = runFrom < 0 ? offset : runFrom;
        } else if (runFrom >= 0) {
            if (runFrom <= at && at <= offset) {
                return { from: start + runFrom, to: start + offset };
            }
            runFrom = -1;
        }
        offset += child?.nodeSize ?? 0;
    }
    return null;
}

/**
 * The link the selection is in: a caret inside the link's text or at either of
 * its ends, or a selection both of whose ends are within it.
 */
function linkAt(state: EditorState): EditorObject | null {
    const { $from, $to } = state.selection;
    if (!$from.parent.inlineContent || !$from.sameParent($to)) {
        return null;
    }
    const link = editorSchema.marks.link;
    for (const neighbour of [$from.nodeAfter, $from.nodeBefore]) {
        const mark = neighbour ? link.isInSet(neighbour.marks) : undefined;
        if (!mark) {
            continue;
        }
        const run = markRunAt($from, mark);
        if (run !== null && $to.pos <= run.to) {
            return { kind: 'link', from: run.from, to: run.to, mark };
        }
    }
    return null;
}

/**
 * The object the selection is on: a node selected as a whole, else the link
 * the selection is in — the innermost object, so a link inside a note is the
 * link — else the note both its ends are in. `null` in plain text.
 */
export function objectAtSelection(state: EditorState): EditorObject | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return objectOfNode(sel.node, sel.from);
    }
    if (!(sel instanceof TextSelection)) {
        return null;
    }
    const link = linkAt(state);
    if (link !== null) {
        return link;
    }
    const from = noteContextAt(sel.$from);
    const to = noteContextAt(sel.$to);
    if (from === null || to === null || from.noteBefore !== to.noteBefore) {
        return null;
    }
    return objectOfNode(from.note, from.noteBefore);
}

/** The object at the same place in `state`, if it is still there and still the same kind; verbs act on this, never on a stale one. */
export function currentObject(state: EditorState, object: EditorObject): EditorObject | null {
    if (object.kind === 'link') {
        const found = objectAtSelection(state);
        return sameObject(found, object) ? found : null;
    }
    if (object.from < 0 || object.from >= state.doc.content.size) {
        return null;
    }
    const node = state.doc.nodeAt(object.from);
    const found = node ? objectOfNode(node, object.from) : null;
    return sameObject(found, object) ? found : null;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** What each note converts to: a sidenote and a marginal note into each other, a sidebar to the other side. */
export const NOTE_CONVERSION: Readonly<Record<NoteNodeName, NoteNodeName>> = {
    sidenote: 'marginal_note',
    marginal_note: 'sidenote',
    left_sidebar: 'right_sidebar',
    right_sidebar: 'left_sidebar',
};

/** The selection put back at the same positions after the node at `pos` was replaced by one of the same size. */
function selectionKept(state: EditorState, tr: Transaction, pos: number, size: number): Selection {
    const sel = state.selection;
    if (sel instanceof NodeSelection && sel.from === pos) {
        return NodeSelection.create(tr.doc, pos);
    }
    if (sel instanceof TextSelection && sel.from > pos && sel.to < pos + size) {
        return TextSelection.create(tr.doc, sel.anchor, sel.head);
    }
    return sel.map(tr.doc, tr.mapping);
}

/**
 * The note at `pos` converted to its counterpart (`NOTE_CONVERSION`), its
 * reference, body and marks kept as they are, the selection where it was — the
 * two have the same structure, so every position inside means the same. One
 * step: one undo converts it back. `null` where there is no note.
 */
export function convertNoteTransaction(state: EditorState, pos: number): Transaction | null {
    const node = state.doc.nodeAt(pos);
    if (!node || !(node.type.name in NOTE_CONVERSION)) {
        return null;
    }
    const target = NOTE_CONVERSION[node.type.name as NoteNodeName];
    let next: Node;
    if (target === 'sidenote' || target === 'marginal_note') {
        const body = (target === 'sidenote' ? nodes.sidenote_body : nodes.marginal_note_body).create(null, node.child(1).content);
        next = nodes[target].create(null, [node.child(0), body], node.marks);
    } else {
        next = nodes[target].create(null, node.content, node.marks);
    }
    const tr = state.tr.replaceWith(pos, pos + node.nodeSize, next);
    return tr.setSelection(selectionKept(state, tr, pos, node.nodeSize)).scrollIntoView();
}

/**
 * Why the note at `pos` cannot be converted, or `null`: its counterpart could
 * not be written back (`noteRefusal` — a right sidebar's code holding `@`, say),
 * which the notes plugin would refuse anyway.
 */
export function convertNoteRefusal(state: EditorState, pos: number): string | null {
    const tr = convertNoteTransaction(state, pos);
    return tr === null ? 'There is no note here.' : noteRefusal(tr);
}

/**
 * The Markdown a note is written as on its own — `++reference|note++`,
 * `!!reference|note!!`, `$text$`, `@text@` — by the serializer, the marks the
 * note carries left out: they stay on the text around the source when it is
 * put back (`inlineSourceTransaction`).
 */
export function noteSource(note: Node): string {
    return serializeInline(note.mark([]));
}

// ---------------------------------------------------------------------------
// Links and images
// ---------------------------------------------------------------------------

/**
 * The link's text linked to `href` instead, its title kept. A bare URL or an
 * `<…>` autolink is written as `[text](href)` from now on: its text is the old
 * address, which a bare form would write as the link. `null` for an empty or
 * unchanged href.
 */
export function changeLinkTransaction(state: EditorState, link: Extract<EditorObject, { kind: 'link' }>, href: string): Transaction | null {
    const next = href.trim();
    if (next === '' || next === link.mark.attrs.href) {
        return null;
    }
    const mark = editorSchema.marks.link.create({ ...link.mark.attrs, href: next, markup: null });
    return state.tr.removeMark(link.from, link.to, link.mark).addMark(link.from, link.to, mark).scrollIntoView();
}

/** The link's mark taken off its text, which stays; the caret at the text's end. */
export function removeLinkTransaction(state: EditorState, link: Extract<EditorObject, { kind: 'link' }>): Transaction {
    const tr = state.tr.removeMark(link.from, link.to, link.mark);
    return tr.setSelection(TextSelection.create(tr.doc, link.to)).scrollIntoView();
}

/** The image at `pos` showing `src` instead, its alt text and title kept. `null` for an empty or unchanged source. */
export function changeImageTransaction(state: EditorState, pos: number, src: string): Transaction | null {
    const node = state.doc.nodeAt(pos);
    const next = src.trim();
    if (!node || node.type !== nodes.image || next === '' || next === node.attrs.src) {
        return null;
    }
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: next });
    return tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView();
}

// ---------------------------------------------------------------------------
// Removing a node object
// ---------------------------------------------------------------------------

/**
 * The node object at `from`–`to` deleted — an image, a source block, an
 * expansion (whose directive line goes with it) — the caret put where it was.
 */
export function deleteObjectTransaction(state: EditorState, object: EditorObject): Transaction {
    const tr = state.tr.delete(object.from, object.to);
    const $at = tr.doc.resolve(Math.min(object.from, tr.doc.content.size));
    return tr.setSelection(Selection.near($at)).scrollIntoView();
}
