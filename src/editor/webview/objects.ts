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
 * | `span` | A run of text carrying one `attr_span` mark (`[text]{…}`) | The mark's run in its textblock |
 * | `container` | A `container` node (`::: name`) | The node |
 * | `admonition` | An `admonition` node (`!!! type "Title"`) | The node |
 * | `block_attrs` | A top-level block carrying an attribute literal (`attrsSuffix`) | The node |
 * | `heading` | A top-level heading that is no `block_attrs` — a requirement heading is one | The node |
 * | `raw_block` | A source block | The node |
 * | `injected_block` | Injected content: an expansion, an atom, generated content | The node |
 * | `front_matter` | The front matter | The node |
 *
 * The last three are **block objects**, the rest **caret objects**; the toolbar
 * shows them on different triggers (`objectToolbar.ts`). Of the caret objects,
 * a container, an admonition and a block with attributes are placed like a
 * block, at its right edge (`isBlockPlaced`), and so is a heading, which has no
 * verbs of its own: its bar carries only the code actions other extensions
 * offer for it (`isTopLevelBlock`), and shows only when there are some.
 */
import { liftTarget } from 'prosemirror-transform';
import { Fragment, Mark, Node, ResolvedPos, Slice } from 'prosemirror-model';
import { EditorState, NodeSelection, Selection, TextSelection, Transaction } from 'prosemirror-state';
import { endsWithAttrsLiteral, hasInnerBrace, parseAttrsLiteral, readsAsRuleLiteral } from '../attrs';
import { SUFFIX_NODES, WRAPPER_NODES, editorSchema } from '../schema';
import { serializeInline } from '../serialize';
import { NoteNodeName, noteContextAt, noteRefusal } from './notes';

const nodes = editorSchema.nodes;

export type NodeObjectKind = 'note' | 'image' | 'badge' | 'container' | 'admonition' | 'block_attrs' | 'heading' | 'raw_block' | 'injected_block' | 'front_matter';

export type EditorObject =
    | { kind: 'link'; from: number; to: number; mark: Mark }
    | { kind: 'span'; from: number; to: number; mark: Mark }
    | { kind: NodeObjectKind; from: number; to: number; node: Node };

/** The objects the pointer resting on them shows the toolbar for; the others show it for the caret. */
const BLOCK_OBJECTS: ReadonlySet<string> = new Set(['raw_block', 'injected_block', 'front_matter']);

/** The caret objects that are blocks: their bar sits at the block's right edge, as a block object's does. */
const BLOCK_PLACED: ReadonlySet<string> = new Set(['container', 'admonition', 'block_attrs', 'heading']);

export function isBlockObject(object: EditorObject): boolean {
    return BLOCK_OBJECTS.has(object.kind);
}

export function isBlockPlaced(object: EditorObject): boolean {
    return BLOCK_OBJECTS.has(object.kind) || BLOCK_PLACED.has(object.kind);
}

/**
 * Whether the object is a whole top-level block — a source block, injected
 * content, the front matter, a heading, a container, an admonition, a block
 * with attributes at the top: the objects the host can name a range of the file
 * for, and so the ones that carry other extensions' code actions.
 */
export function isTopLevelBlock(state: EditorState, object: EditorObject): boolean {
    return object.kind !== 'link' && object.kind !== 'span' && object.from < state.doc.content.size
        && state.doc.resolve(object.from).depth === 0 && state.doc.nodeAt(object.from) === object.node;
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
    container: 'container',
    admonition: 'admonition',
    raw_block: 'raw_block',
    injected_block: 'injected_block',
    front_matter: 'front_matter',
};

/**
 * Whether `node` is a block whose attribute literal is its own object: one
 * carrying a literal — but not a requirement heading, whose `{#anchor}` is Req
 * Explorer's locator, read-only here like the id before it; a bar offering a
 * verb it must refuse on every requirement heading the caret rests in would be
 * noise on the corpus the editor is mostly used for.
 */
function carriesBlockAttrs(node: Node): boolean {
    return SUFFIX_NODES.has(node.type.name) && (node.attrs.attrsSuffix ?? null) !== null
        && !(node.type === nodes.heading && node.attrs.reqPrefix !== null);
}

/** The object `node` at `pos` is, or `null` for a node that is none. */
export function objectOfNode(node: Node, pos: number): EditorObject | null {
    const kind = NODE_KINDS[node.type.name]
        ?? (carriesBlockAttrs(node) ? 'block_attrs' : node.type === nodes.heading ? 'heading' : undefined);
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
 * The run of `markType` the selection is in — a link, an attribute span: a
 * caret inside its text or at either of its ends, or a selection both of whose
 * ends are within it.
 */
function markObjectAt(state: EditorState, kind: 'link' | 'span'): EditorObject | null {
    const { $from, $to } = state.selection;
    if (!$from.parent.inlineContent || !$from.sameParent($to)) {
        return null;
    }
    const type = kind === 'link' ? editorSchema.marks.link : editorSchema.marks.attr_span;
    for (const neighbour of [$from.nodeAfter, $from.nodeBefore]) {
        const mark = neighbour ? type.isInSet(neighbour.marks) : undefined;
        if (!mark) {
            continue;
        }
        const run = markRunAt($from, mark);
        if (run !== null && $to.pos <= run.to) {
            return { kind, from: run.from, to: run.to, mark };
        }
    }
    return null;
}

/** The innermost container or admonition holding both ends of the selection. */
function wrapperAt(state: EditorState): EditorObject | null {
    const { $from, $to } = state.selection;
    for (let d = Math.min($from.depth, $to.depth); d > 0; d--) {
        const node = $from.node(d);
        if (WRAPPER_NODES.has(node.type.name) && $to.node(d) === node) {
            return objectOfNode(node, $from.before(d));
        }
    }
    return null;
}

/** The top-level block with an attribute literal holding both ends of the selection. */
function blockAttrsAt(state: EditorState): EditorObject | null {
    const { $from, $to } = state.selection;
    if ($from.depth < 1 || $to.depth < 1 || $from.node(1) !== $to.node(1)) {
        return null;
    }
    const node = $from.node(1);
    return carriesBlockAttrs(node) ? objectOfNode(node, $from.before(1)) : null;
}

/** The top-level heading holding both ends of the selection that is no block with attributes. */
function headingAt(state: EditorState): EditorObject | null {
    const { $from, $to } = state.selection;
    if ($from.depth < 1 || $to.depth < 1 || $from.node(1) !== $to.node(1) || $from.node(1).type !== nodes.heading) {
        return null;
    }
    return objectOfNode($from.node(1), $from.before(1));
}

/**
 * The object the selection is on: a node selected as a whole, else — innermost
 * first, so a link inside a note inside an admonition is the link — the link
 * the selection is in, the attribute span, the note both its ends are in, the
 * container or admonition, the top-level block with an attribute literal, and
 * last the top-level heading. `null` in plain text.
 */
export function objectAtSelection(state: EditorState): EditorObject | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return objectOfNode(sel.node, sel.from);
    }
    if (!(sel instanceof TextSelection)) {
        return null;
    }
    const mark = markObjectAt(state, 'link') ?? markObjectAt(state, 'span');
    if (mark !== null) {
        return mark;
    }
    const from = noteContextAt(sel.$from);
    const to = noteContextAt(sel.$to);
    if (from !== null && to !== null && from.noteBefore === to.noteBefore) {
        return objectOfNode(from.note, from.noteBefore);
    }
    return wrapperAt(state) ?? blockAttrsAt(state) ?? headingAt(state);
}

/** The object at the same place in `state`, if it is still there and still the same kind; verbs act on this, never on a stale one. */
export function currentObject(state: EditorState, object: EditorObject): EditorObject | null {
    if (object.kind === 'link' || object.kind === 'span') {
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

/** Why no link is made here — said to the gesture that asked (the key, the menu entry). */
export const LINK_LOCK = 'Put the caret in text, or select text within one paragraph, heading or list item (not code), to link it.';
/** Why no image or file goes in here, after Insert → Image… or a paste. */
export const IMAGE_LOCK = 'Put the caret in text (not code) to insert an image there.';
/** The same, after a drop: the place is where the file was let go. */
export const DROP_LOCK = 'Drop onto text (not code) to insert an image there.';

/**
 * `lock` — the refusal of the gesture asking — when nothing inline can go at
 * the selection, else `null`. A link, an image and a dropped file all need a
 * caret or a selection within one textblock that is not code: one rule, said
 * three ways.
 */
export function insertLockReason(state: EditorState, lock: string): string | null {
    const sel = state.selection;
    const ok = sel instanceof TextSelection && sel.$from.sameParent(sel.$to)
        && sel.$from.parent.inlineContent && !sel.$from.parent.type.spec.code;
    return ok ? null : lock;
}

/**
 * A link to `href` made at the selection: selected text is linked as it is;
 * at a caret, `text` is inserted linked — the address itself when `text` is
 * empty — with the marks the caret carries, and the caret after it. `null` for
 * an empty href, a selection a link cannot be made at (`insertLockReason`), or
 * a link a note around it could not hold.
 */
export function insertLinkTransaction(state: EditorState, text: string, href: string): Transaction | null {
    const target = href.trim();
    if (target === '' || insertLockReason(state, LINK_LOCK) !== null) {
        return null;
    }
    const link = editorSchema.marks.link.create({ href: target });
    const { from, to, empty } = state.selection;
    let tr: Transaction;
    if (empty) {
        const content = text === '' ? target : text;
        const marks = link.addToSet((state.storedMarks ?? state.selection.$from.marks()).filter(m => m.type !== link.type));
        tr = state.tr.replaceSelectionWith(editorSchema.text(content, marks), false);
        tr.setSelection(TextSelection.create(tr.doc, from + content.length));
    } else {
        tr = state.tr.removeMark(from, to, editorSchema.marks.link).addMark(from, to, link);
    }
    return noteRefusal(tr) === null ? tr.scrollIntoView() : null;
}

/**
 * The files the host chose (`LinkedFile`) put at the selection: an image by
 * its path, its alt text the file's stem; any other file as a link named by
 * its file name; a space between two. The selection is replaced; with one
 * image, it is selected afterwards (its alt text is asked for next), else the
 * caret goes after them. `null` where nothing can go (`insertLockReason`), or
 * where a note around the selection could not hold it.
 */
export function insertFilesTransaction(state: EditorState, files: readonly { src: string; alt: string; image: boolean }[]): Transaction | null {
    if (files.length === 0 || insertLockReason(state, IMAGE_LOCK) !== null) {
        return null;
    }
    const marks = (state.storedMarks ?? state.selection.$from.marks()).filter(m => m.type !== editorSchema.marks.link);
    const inserted: Node[] = [];
    files.forEach((file, i) => {
        if (i > 0) {
            inserted.push(editorSchema.text(' ', marks));
        }
        inserted.push(file.image
            ? editorSchema.nodes.image.create({ src: file.src, alt: file.alt }, null, marks)
            : editorSchema.text(file.alt || file.src, editorSchema.marks.link.create({ href: file.src }).addToSet(marks)));
    });
    const from = state.selection.from;
    const tr = state.tr.replaceSelection(new Slice(Fragment.from(inserted), 0, 0));
    const size = inserted.reduce((n, node) => n + node.nodeSize, 0);
    tr.setSelection(files.length === 1 && files[0].image ? NodeSelection.create(tr.doc, from) : TextSelection.create(tr.doc, from + size));
    return noteRefusal(tr) === null ? tr.scrollIntoView() : null;
}

/**
 * The image at `pos` with `alt` and `src` instead, its title kept — its
 * **Edit image…**. `null` when there is no image there, for an empty source,
 * or when nothing changes.
 */
export function editImageTransaction(state: EditorState, pos: number, alt: string, src: string): Transaction | null {
    const node = state.doc.nodeAt(pos);
    const next = src.trim();
    if (!node || node.type !== nodes.image || next === '' || (next === node.attrs.src && alt === (node.attrs.alt ?? ''))) {
        return null;
    }
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: next, alt: alt === '' ? null : alt });
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

// ---------------------------------------------------------------------------
// Attribute spans
// ---------------------------------------------------------------------------

/**
 * Where a literal goes, which decides what the plugin reads of it: after a span
 * markdown-it-attrs cuts at the first `}`, quoted or not (`hasInnerBrace`);
 * after a rule's `---` it starts at the last `{` (`readsAsRuleLiteral`); after
 * any other block it reads the whole literal, quotes respected.
 */
export type LiteralPlace = 'span' | 'rule' | 'block';

/** The place a block's literal goes: a rule's is read from its last `{`. */
export function literalPlaceOf(node: Node): LiteralPlace {
    return node.type === nodes.horizontal_rule ? 'rule' : 'block';
}

/** Why `literal` cannot be an attribute span's or a block's literal at `place`, or `null`: the plugin must read it as attributes, all of it. */
export function literalRefusal(literal: string, place: LiteralPlace = 'block'): string | null {
    const value = literal.trim();
    if (parseAttrsLiteral(value) === null) {
        return `${value || 'An empty value'} is no attribute list: write it as {.class}, {#id} or {key="value"}, as markdown-it-attrs reads it.`;
    }
    if (place === 'span' && hasInnerBrace(value)) {
        return `${value} holds a } inside a value: after a span markdown-it-attrs cuts the literal at its first }, and the rest would stay behind as text.`;
    }
    if (place === 'rule' && !readsAsRuleLiteral(value)) {
        return `${value} holds a { inside a value: markdown-it-attrs reads a rule's literal from its last {, and the rule would lose its attributes.`;
    }
    return null;
}

/** Why an attribute span cannot be made of the selection, or `null`: it needs selected text in one textblock that is not code. */
export function spanLockReason(state: EditorState): string | null {
    const sel = state.selection;
    const ok = sel instanceof TextSelection && !sel.empty && sel.$from.sameParent(sel.$to)
        && sel.$from.parent.inlineContent && !sel.$from.parent.type.spec.code;
    return ok ? null : 'Select text within one paragraph, heading or list item (not code) to give it attributes.';
}

/**
 * The selection made an attribute span `[text]{literal}` — a span it is already
 * in given the new literal instead, as a mark type excludes itself. `null` when
 * there is no selection to make it of, or the literal is not one the plugin reads.
 */
export function applySpanTransaction(state: EditorState, literal: string): Transaction | null {
    const value = literal.trim();
    if (spanLockReason(state) !== null || literalRefusal(value, 'span') !== null) {
        return null;
    }
    const { from, to } = state.selection;
    const tr = state.tr.addMark(from, to, editorSchema.marks.attr_span.create({ literal: value }));
    return noteRefusal(tr) === null ? tr.scrollIntoView() : null;
}

/** The span's run given `literal` instead. `null` for an unchanged or unreadable literal, or one a note around it could not hold. */
export function changeSpanTransaction(state: EditorState, span: Extract<EditorObject, { kind: 'span' }>, literal: string): Transaction | null {
    const value = literal.trim();
    if (value === span.mark.attrs.literal || literalRefusal(value, 'span') !== null) {
        return null;
    }
    const type = editorSchema.marks.attr_span;
    const tr = state.tr.removeMark(span.from, span.to, span.mark).addMark(span.from, span.to, type.create({ literal: value }));
    return noteRefusal(tr) === null ? tr.scrollIntoView() : null;
}

/** The span's mark taken off its text, which stays; the caret at the text's end. */
export function removeSpanTransaction(state: EditorState, span: Extract<EditorObject, { kind: 'span' }>): Transaction {
    const tr = state.tr.removeMark(span.from, span.to, span.mark);
    return tr.setSelection(TextSelection.create(tr.doc, span.to)).scrollIntoView();
}

// ---------------------------------------------------------------------------
// Containers and admonitions
// ---------------------------------------------------------------------------

/**
 * The wrapper at `pos` removed, its blocks kept where it stood — lifted, so the
 * selection inside keeps its place in the text. `null` where there is none.
 */
export function unwrapTransaction(state: EditorState, pos: number): Transaction | null {
    const node = state.doc.nodeAt(pos);
    if (!node || !WRAPPER_NODES.has(node.type.name)) {
        return null;
    }
    const $start = state.doc.resolve(pos + 1);
    const $end = state.doc.resolve(pos + node.nodeSize - 1);
    const range = $start.blockRange($end, n => n === node);
    const target = range === null ? null : liftTarget(range);
    if (range === null || target === null) {
        return null;
    }
    return state.tr.lift(range, target).scrollIntoView();
}

/**
 * The name and info a container field's value gives: its first word and the
 * rest, verbatim (`warning big` → `warning`, ` big`); `null` when the plugin
 * would not read it back so — a line break, or a trailing `{…}`, which
 * markdown-it-attrs takes off the info as attributes.
 */
export function containerNameOf(value: string): { name: string; info: string } | null {
    if (/[\r\n]/.test(value) || endsWithAttrsLiteral(value)) {
        return null;
    }
    const [, name, info] = /^\s*(\S*)([\s\S]*)$/.exec(value) ?? ['', '', ''];
    return { name, info: info.replace(/\s+$/, '') };
}

/** The container at `pos` named by `value` (`containerNameOf`). `null` when unchanged or unreadable. */
export function changeContainerTransaction(state: EditorState, pos: number, value: string): Transaction | null {
    const node = state.doc.nodeAt(pos);
    const next = containerNameOf(value);
    if (!node || node.type !== nodes.container || next === null
        || (next.name === node.attrs.name && next.info === node.attrs.info)) {
        return null;
    }
    return state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next }).scrollIntoView();
}

/**
 * The admonition at `pos` with another type or title. Its opening line is then
 * written by rule (`header` cleared), so the file says what the node now is.
 * `null` when nothing changes, or for a title on more than one line.
 */
export function changeAdmonitionTransaction(state: EditorState, pos: number, change: { type?: string; title?: string }): Transaction | null {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== nodes.admonition) {
        return null;
    }
    const type = change.type ?? (node.attrs.type as string);
    const title = change.title === undefined ? (node.attrs.title as string) : change.title.trim();
    if (/[\r\n]/.test(title) || (type === node.attrs.type && title === node.attrs.title)) {
        return null;
    }
    return state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, type, title, header: null }).scrollIntoView();
}

// ---------------------------------------------------------------------------
// Block attributes
// ---------------------------------------------------------------------------

/** Why the block's attribute literal is not edited here, or `null`: a requirement heading's anchor is Req Explorer's. */
export function blockAttrsRefusal(node: Node): string | null {
    return node.type === nodes.heading && node.attrs.reqPrefix !== null
        ? 'A requirement heading\'s anchor is Req Explorer\'s: its anchor migration renames it, the editor does not.'
        : null;
}

/**
 * The top-level block at `pos` with `literal` as its attribute literal, where
 * it stood before; `''` removes it. A heading's anchor follows the literal's id.
 * `null` when unchanged, refused (`blockAttrsRefusal`) or unreadable.
 */
export function changeBlockAttrsTransaction(state: EditorState, pos: number, literal: string): Transaction | null {
    const node = state.doc.nodeAt(pos);
    const value = literal.trim();
    if (!node || !SUFFIX_NODES.has(node.type.name) || blockAttrsRefusal(node) !== null
        || value === (node.attrs.attrsSuffix ?? '') || (value !== '' && literalRefusal(value, literalPlaceOf(node)) !== null)) {
        return null;
    }
    const attrs: Record<string, unknown> = { ...node.attrs, attrsSuffix: value === '' ? null : value };
    if (node.type === nodes.heading) {
        attrs.anchor = value === '' ? null : (parseAttrsLiteral(value) ?? []).filter(([n]) => n === 'id').map(([, v]) => v).pop() ?? null;
    } else {
        attrs.attrsPlacement = value === '' ? null : (node.attrs.attrsPlacement as string | null) ?? 'end';
    }
    return state.tr.setNodeMarkup(pos, undefined, attrs).scrollIntoView();
}
