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
 * | `wiki_embed` | A `wiki_embed` node (`![[…]]`, `markdownItWikiEmbed.ts`) | The node |
 * | `emoji` | An `emoji` node (an emoji the file holds, `markdownItEmoji.ts`) | The node |
 * | `span` | A run of text carrying one `attr_span` mark (`[text]{…}`) | The mark's run in its textblock |
 * | `container` | A `container` node (`::: name`) | The node |
 * | `admonition` | An `admonition` node (`!!! type "Title"`) | The node |
 * | `table` | A pipe table (`table`), the caret in a cell or cells selected | The node |
 * | `block_attrs` | A top-level block carrying an attribute literal (`attrsSuffix`), a quote's too; a table with one stays a `table` | The node |
 * | `heading` | A top-level heading that is no `block_attrs` — a requirement heading is one | The node |
 * | `raw_block` | A source block | The node |
 * | `injected_block` | Injected content: an expansion, an atom, generated content | The node |
 * | `front_matter` | The front matter | The node |
 *
 * The last three are **block objects**, the rest **caret objects**; the toolbar
 * shows them on different triggers (`objectToolbar.ts`). Of the caret objects,
 * a container, an admonition, a table and a block with attributes are placed like a
 * block, at its right edge (`isBlockPlaced`), and so is a heading: its one
 * verb is **Attributes…**, then the code actions other extensions offer for it
 * (`isTopLevelBlock`); a requirement heading has no verb of its own, and its
 * bar shows only when there are some.
 */
import { liftTarget } from 'prosemirror-transform';
import { Fragment, Mark, Node, ResolvedPos, Slice } from 'prosemirror-model';
import { EditorState, NodeSelection, Selection, TextSelection, Transaction } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import { attrsReadAt, endLiteralOf, fenceHolder, hasInnerBrace, parseAttrsLiteral, readsAsRuleLiteral } from '../attrs';
import { isTextBrace, readBrace, tightenedBrace } from '../../syntax/attrsLiteral';
import { currentInlineDefinition, currentReadsAttrs } from '../inlineEngine';
import { SUFFIX_NODES, WRAPPER_NODES, editorSchema } from '../schema';
import { LiteralLoss, itemTakesLiteral, literalHolder, literalNotReadBack, literalsReadBack, quoteTakesLiteral, serializeInline } from '../serialize';
import { NoteNodeName, noteContextAt, noteRefusal } from './notes';

const nodes = editorSchema.nodes;

export type NodeObjectKind = 'note' | 'image' | 'badge' | 'wiki_embed' | 'emoji' | 'container' | 'admonition' | 'table' | 'block_attrs' | 'heading' | 'raw_block' | 'injected_block' | 'front_matter';

export type EditorObject =
    | { kind: 'link'; from: number; to: number; mark: Mark }
    | { kind: 'span'; from: number; to: number; mark: Mark }
    | { kind: NodeObjectKind; from: number; to: number; node: Node };

/** The objects the pointer resting on them shows the toolbar for; the others show it for the caret. */
const BLOCK_OBJECTS: ReadonlySet<string> = new Set(['raw_block', 'injected_block', 'front_matter']);

/** The caret objects that are blocks: their bar sits at the block's right edge, as a block object's does. */
const BLOCK_PLACED: ReadonlySet<string> = new Set(['container', 'admonition', 'table', 'block_attrs', 'heading']);

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
    wiki_embed: 'wiki_embed',
    emoji: 'emoji',
    container: 'container',
    admonition: 'admonition',
    table: 'table',
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

/** The table holding both ends of the selection — a caret or text in its cells, or cells selected across them. */
function tableObjectAt(state: EditorState): EditorObject | null {
    const { $from, $to } = state.selection;
    if ($from.depth < 1 || $to.depth < 1 || $from.node(1) !== $to.node(1) || $from.node(1).type !== nodes.table) {
        return null;
    }
    return objectOfNode($from.node(1), $from.before(1));
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
 * container or admonition, the table, the top-level block with an attribute
 * literal, and last the top-level heading. Cells selected across (a
 * `CellSelection`) are their table. `null` in plain text.
 */
export function objectAtSelection(state: EditorState): EditorObject | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return objectOfNode(sel.node, sel.from);
    }
    if (sel instanceof CellSelection) {
        return tableObjectAt(state);
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
    return wrapperAt(state) ?? tableObjectAt(state) ?? blockAttrsAt(state) ?? headingAt(state);
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
 * not be written back (`noteRefusal` — a right sidebar before a digit, say:
 * `@y@5` reads as a sidebar, `$y$5` would not), which the notes plugin would
 * refuse anyway.
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

/**
 * Why **Remove link** is refused, or `null` — asked of the filter's own check
 * (`noteRefusal`): with `](…)` gone its text may touch a sidebar's marker
 * (`[x](u)$y$` would be `x$y$`).
 */
export function removeLinkRefusal(state: EditorState, link: Extract<EditorObject, { kind: 'link' }>): string | null {
    return noteRefusal(removeLinkTransaction(state, link));
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
 * Why deleting the object is refused, or `null` — asked of the filter's own
 * check (`noteRefusal`): an image gone from between a letter and a sidebar
 * leaves the two touching (`a![i](u.png)$y$` would be `a$y$`).
 */
export function deleteObjectRefusal(state: EditorState, object: EditorObject): string | null {
    return noteRefusal(deleteObjectTransaction(state, object));
}

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
 * Where a literal goes, which decides what the plugin reads of it: `span`
 * after an attribute span, or the name of the node it is written for
 * (`literalPlaceOf`). After a span markdown-it-attrs cuts at the first `}`,
 * quoted or not (`hasInnerBrace`); after a rule's `---` it starts at the last
 * `{` (`readsAsRuleLiteral`); a fence's and a table's it reads off raw text,
 * every other one off what the inline rules made of it (`attrsReadAt`).
 */
export type LiteralPlace = string;

/** The place a block's literal goes: its node's name, a fence's by its fence (`literalHolder`), as `attrsReadAt` knows it. */
export function literalPlaceOf(node: Node): LiteralPlace {
    return literalHolder(node);
}

/**
 * The text brace `value` with the spaces beside its `=` taken out, when that is
 * the same attributes the author wrote: as many key/value pairs, none spaced,
 * and a literal the plugin reads. `null` when taking them out would change what
 * it says (`{.a =b}` would be the class `a=b`) or still be no literal (`{ = b}`).
 */
function tightenedSuggestion(value: string): string | null {
    const tightened = tightenedBrace(value, 0);
    const reading = readBrace(tightened, 0);
    return reading.separators.length === readBrace(value, 0).separators.length && !reading.spaced && parseAttrsLiteral(tightened) !== null
        ? tightened
        : null;
}

/**
 * Why no literal is offered at all: the host's engine reads none
 * (`InlineEngineDefinition.attrs`), so the preview shows any `{…}` as text.
 */
export const NO_ATTRS_REFUSAL = 'The preview reads no attributes here: markdown-it-attrs does not run (markdownExtended.plugins.disabled names attrs, or another extension turned it off), so a {…} shows as text.';

/**
 * Why `literal` cannot be an attribute span's or a block's literal at `place`
 * (a paragraph's by default), or `null`: the preview must read it there as
 * attributes, all of it (`attrsReadAt`, the rule the host's parse recognises
 * a literal by) — and reads none where the host's engine reads no
 * attributes (`NO_ATTRS_REFUSAL`).
 */
export function literalRefusal(literal: string, place: LiteralPlace = 'paragraph'): string | null {
    if (!currentReadsAttrs()) {
        return NO_ATTRS_REFUSAL;
    }
    const value = literal.trim();
    if (value.startsWith('{') && readBrace(value, 0).close < 0) {
        return `${value} is not closed: end the attribute list with }.`;
    }
    if (value.startsWith('{') && isTextBrace(value, 0)) {
        const text = `${value} is text, not an attribute list: a space beside its = makes it text, as in PowerShell's @{a = 1}.`;
        const tightened = tightenedSuggestion(value);
        return tightened === null ? text : `${text} Write it as ${tightened}.`;
    }
    if (parseAttrsLiteral(value) === null) {
        return `${value || 'An empty value'} is no attribute list: write it as {.class}, {#id} or {key="value"}, as markdown-it-attrs reads it.`;
    }
    if (place === 'span' && hasInnerBrace(value)) {
        return `${value} holds a } inside a value: after a span markdown-it-attrs cuts the literal at its first }, and the rest would stay behind as text.`;
    }
    if (place === nodes.horizontal_rule.name && !readsAsRuleLiteral(value)) {
        return `${value} holds a { inside a value: markdown-it-attrs reads a rule's literal from its last {, and the rule would lose its attributes.`;
    }
    if (place === fenceHolder('```') && value.includes('`')) {
        return `${value} holds a backtick: the line opening a \`\`\` fence holds none, and the block would no longer be code. A ~~~ fence takes it.`;
    }
    if (attrsReadAt(value, place) === null) {
        const math = currentInlineDefinition().math ? ', math' : '';
        return `${value} holds what markdown-it reads before markdown-it-attrs here — a \\, an entity, code, emphasis, HTML, a link${math} or a plugin's markup — and the preview would show it as text.`;
    }
    return null;
}

/**
 * Why a literal is refused that reads as attributes alone (`literalRefusal`)
 * but not together with the block it is written in (`literalsReadBack`).
 */
export const LITERAL_READ_WITH_BLOCK_REFUSAL = 'Read together with the rest of its block — a $ pairing with a $ in another {…} as a left sidebar or as math, say — the preview would not read these attributes back as written.';

/**
 * Why a literal is refused in a block that, before it was set, already held a
 * literal the preview would not read back (`existing`): that one is the cause,
 * whatever is typed.
 */
export function literalAlreadyLostRefusal(existing: LiteralLoss): string {
    if (existing.literal === null) {
        return 'Read with the rest of this block, the preview already would read text in it as attributes the editor does not show: that is the cause, not the literal typed. Edit the block once in the text editor first.';
    }
    return `Read with the rest of this block, the preview already would not read ${existing.literal} back as written: that is the cause, not the literal typed. Remove or change it first.`;
}

/** The top-level block holding `pos` in `doc`, or `null`. */
function topBlockAt(doc: Node, pos: number): Node | null {
    const $pos = doc.resolve(Math.min(pos, doc.content.size));
    return $pos.depth === 0 ? doc.nodeAt(pos) : $pos.node(1);
}

/**
 * Why the top-level block holding `pos` in `doc` — a document a literal was
 * just set in — is refused: a literal it holds would not read back once the
 * block is written (`literalsReadBack`), or `null`. When the block already
 * failed so in `before`, the document the literal was set in, the reason
 * names the literal it failed on (`literalAlreadyLostRefusal`) — unless that
 * is the literal being changed (`changing`, its value before): then the new
 * value is what is judged.
 */
export function literalsReadBackRefusal(doc: Node, pos: number, before?: Node, changing?: string | null): string | null {
    const block = topBlockAt(doc, pos);
    if (block === null || literalsReadBack(block)) {
        return null;
    }
    const old = before === undefined ? null : topBlockAt(before, pos);
    const existing = old === null ? null : literalNotReadBack(old);
    return existing === null || (existing.literal !== null && existing.literal === changing) ? LITERAL_READ_WITH_BLOCK_REFUSAL : literalAlreadyLostRefusal(existing);
}

/** Why `literal` cannot be given to the selection as an attribute span, or `null`: the span's literal alone (`literalRefusal`), then read with its block (`literalsReadBackRefusal`). */
export function spanLiteralRefusal(state: EditorState, literal: string): string | null {
    const value = literal.trim();
    const alone = literalRefusal(value, 'span');
    if (alone !== null || spanLockReason(state) !== null) {
        return alone;
    }
    const { from, to } = state.selection;
    const tr = state.tr.addMark(from, to, editorSchema.marks.attr_span.create({ literal: value }));
    return literalsReadBackRefusal(tr.doc, from, state.doc);
}

/** Why the span's literal cannot be changed to `literal`, or `null`: as `spanLiteralRefusal` asks it. */
export function changeSpanRefusal(state: EditorState, span: Extract<EditorObject, { kind: 'span' }>, literal: string): string | null {
    const value = literal.trim();
    const alone = literalRefusal(value, 'span');
    if (alone !== null) {
        return alone;
    }
    const tr = state.tr.removeMark(span.from, span.to, span.mark).addMark(span.from, span.to, editorSchema.marks.attr_span.create({ literal: value }));
    return literalsReadBackRefusal(tr.doc, span.from, state.doc, span.mark.attrs.literal as string);
}

/** Why an attribute span cannot be made of the selection, or `null`: it needs an engine that reads attributes, and selected text in one textblock that is not code. */
export function spanLockReason(state: EditorState): string | null {
    if (!currentReadsAttrs()) {
        return NO_ATTRS_REFUSAL;
    }
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
    return noteRefusal(tr) === null && literalsReadBackRefusal(tr.doc, from, state.doc) === null ? tr.scrollIntoView() : null;
}

/** The span's run given `literal` instead. `null` for an unchanged or unreadable literal, or one a note around it could not hold. */
export function changeSpanTransaction(state: EditorState, span: Extract<EditorObject, { kind: 'span' }>, literal: string): Transaction | null {
    const value = literal.trim();
    if (value === span.mark.attrs.literal || literalRefusal(value, 'span') !== null) {
        return null;
    }
    const type = editorSchema.marks.attr_span;
    const tr = state.tr.removeMark(span.from, span.to, span.mark).addMark(span.from, span.to, type.create({ literal: value }));
    return noteRefusal(tr) === null && literalsReadBackRefusal(tr.doc, span.from, state.doc, span.mark.attrs.literal as string) === null ? tr.scrollIntoView() : null;
}

/**
 * Why **Remove attributes** is refused, or `null` — asked of the filter's own
 * check (`noteRefusal`): with `]{…}` gone its text may touch a sidebar's
 * marker (`[x]{.c}$y$` would be `x$y$`).
 */
export function removeSpanRefusal(state: EditorState, span: Extract<EditorObject, { kind: 'span' }>): string | null {
    return noteRefusal(removeSpanTransaction(state, span));
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
 * markdown-it-attrs takes off the info as attributes where the host's engine
 * runs it (`currentReadsAttrs`); where not, the `{…}` is text the info keeps.
 */
export function containerNameOf(value: string): { name: string; info: string } | null {
    if (/[\r\n]/.test(value) || (currentReadsAttrs() && endLiteralOf(value) !== null)) {
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
    const current = node.attrs.title as string;
    // A committed field is trimmed; one that holds the title it was opened
    // with, outer spaces aside, changes nothing (`" padded "` stays as written).
    const title = change.title === undefined || change.title.trim() === current.trim() ? current : change.title.trim();
    if (/[\r\n]/.test(title) || (type === node.attrs.type && title === current)) {
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
 * Where a block given a literal for the first time writes it (`AttrsPlacement`
 * in `blocks.ts`, read by `withBlockSuffix`): a quote's under its last
 * paragraph, a list's under its last line, a table's under a blank line after
 * it, anything else's at the end of its line.
 */
function newPlacement(node: Node): string {
    switch (node.type.name) {
        case 'blockquote':
        case 'bullet_list':
        case 'ordered_list':
            return 'line';
        case 'table':
            return 'blank';
        default:
            return 'end';
    }
}

/** Why a quote cannot be given a literal: the plugin gives a `> {…}` line to the block it ends. */
export const QUOTE_ATTRS_REFUSAL = 'A quote\'s {…} stands on a line under its last paragraph, and this quote ends in another block: markdown-it-attrs would give the literal to that block.';

/**
 * Why `node` cannot be given a literal, or `null` — the one rule the menu
 * entry, the bars and every commit ask, so none can offer what another would
 * refuse. Removing a literal is refused only on a requirement heading.
 */
export function literalHomeRefusal(node: Node): string | null {
    switch (node.type.name) {
        case 'container':
            return CONTAINER_ATTRS_REFUSAL;
        case 'admonition':
            return ADMONITION_ATTRS_REFUSAL;
        case 'raw_block':
            return 'A source block is edited as Markdown: write its {…} there (Edit source).';
        case 'front_matter':
            return 'The front matter is YAML: it renders nothing that could carry attributes.';
        case 'injected_block':
            return 'Injected content is not in the file: there is no block here to give attributes to.';
        case 'code_block':
            return node.attrs.markup === '' ? INDENTED_CODE_ATTRS_REFUSAL : null;
        case 'blockquote':
            return quoteTakesLiteral(node) ? null : QUOTE_ATTRS_REFUSAL;
        case 'list_item':
            return itemTakesLiteral(node) ? null : ITEM_ATTRS_REFUSAL;
    }
    return blockAttrsRefusal(node) ?? (SUFFIX_NODES.has(node.type.name) ? null : NO_BLOCK_ATTRS_REFUSAL);
}

/**
 * The top-level block at `pos` with `literal` as its attribute literal, where
 * it stood before (a new one where `newPlacement` says); `''` removes it. A
 * heading's anchor follows the literal's id. `null` when unchanged, refused
 * (`literalHomeRefusal`, or the save would not read the block back as it
 * would be shown: `literalsReadBackRefusal`, then the edit filter's own check,
 * `noteRefusal`, a removal as much as any change) or unreadable.
 */
export function changeBlockAttrsTransaction(state: EditorState, pos: number, literal: string): Transaction | null {
    const tr = blockAttrsTransaction(state, pos, literal);
    const value = literal.trim();
    return tr !== null && (value === '' || literalsReadBackRefusal(tr.doc, pos, state.doc, state.doc.nodeAt(pos)?.attrs.attrsSuffix as string | null) === null) && noteRefusal(tr) === null
        ? tr.scrollIntoView()
        : null;
}

/** `changeBlockAttrsTransaction` before it asks whether the save reads the block back: `null` when unchanged, refused where the literal stands or unreadable. */
function blockAttrsTransaction(state: EditorState, pos: number, literal: string): Transaction | null {
    const node = state.doc.nodeAt(pos);
    const value = literal.trim();
    if (!node || !SUFFIX_NODES.has(node.type.name) || blockAttrsRefusal(node) !== null
        || value === (node.attrs.attrsSuffix ?? '')
        || (value !== '' && (literalRefusal(value, literalPlaceOf(node)) !== null || literalHomeRefusal(node) !== null))) {
        return null;
    }
    const attrs: Record<string, unknown> = { ...node.attrs, attrsSuffix: value === '' ? null : value };
    if (node.type === nodes.heading) {
        attrs.anchor = value === '' ? null : (parseAttrsLiteral(value) ?? []).filter(([n]) => n === 'id').map(([, v]) => v).pop() ?? null;
    } else {
        attrs.attrsPlacement = value === '' ? null : (node.attrs.attrsPlacement as string | null) ?? newPlacement(node);
    }
    return state.tr.setNodeMarkup(pos, undefined, attrs);
}

// ---------------------------------------------------------------------------
// Attributes… — the literal of the block at the caret
// ---------------------------------------------------------------------------

/**
 * What each block is called where its attributes are asked for: the field's
 * label (`Paragraph · Attributes`) and a block-attributes bar's.
 */
export const BLOCK_NAMES: Readonly<Record<string, string>> = {
    paragraph: 'Paragraph',
    heading: 'Heading',
    blockquote: 'Quote',
    bullet_list: 'List',
    ordered_list: 'List',
    list_item: 'List item',
    code_block: 'Code block',
    horizontal_rule: 'Rule',
    table: 'Table',
};

/**
 * Why a container is given no literal here: the preview draws a `{…}` on its
 * `:::` line (`markdownItContainer.ts`), but the container node has no slot for
 * one, so a container written with one stays a source block (`blocks.ts`).
 */
export const CONTAINER_ATTRS_REFUSAL = 'A container\'s {…} is not edited here: the preview gives a literal on its ::: line to the container, but the editor has no place for it — a container written with one is a source block, edited as Markdown. Its classes here are its name and info (Change name/info).';

/** Why an admonition is given no literal: the plugin hands it to the title bar. */
export const ADMONITION_ATTRS_REFUSAL = 'An admonition takes no {…}: markdown-it-attrs gives a literal on its !!! line to the title bar, not to the box. Its class is its type (Change type).';

/** Why an indented code block is given no literal: it has no opening line. */
export const INDENTED_CODE_ATTRS_REFUSAL = 'An indented code block has no opening line to carry a {…}: make it a fenced one first.';

/** Why a list item is given no literal: it is written at the end of the item's first paragraph. */
export const ITEM_ATTRS_REFUSAL = 'A list item\'s {…} stands at the end of its first paragraph, and this item does not start with a paragraph ending in text.';

/** Why nothing at the selection takes a literal. */
export const NO_BLOCK_ATTRS_REFUSAL = 'Put the caret in one paragraph, heading, list item, quote, table or code block to give it attributes.';

/**
 * The block **Attributes…** acts on: a top-level block of `SUFFIX_NODES`, or a
 * list item at any depth; `name` is what the field calls it.
 */
export interface AttributesTarget {
    pos: number;
    node: Node;
    name: string;
}

/** The literal the target carries now, or `null`. */
export function literalOf(node: Node): string | null {
    const literal = node.type === nodes.list_item ? node.attrs.literal : node.attrs.attrsSuffix;
    return typeof literal === 'string' ? literal : null;
}

/**
 * A block as a target — a top-level one, the block a bar is for, or a list
 * item — or why it is none: none where the host's engine reads no attributes
 * (`NO_ATTRS_REFUSAL`), else `literalHomeRefusal`, except that a block which
 * has a literal already can always have it edited or removed (a requirement
 * heading's apart).
 */
export function attributesTargetOf(node: Node, pos: number): AttributesTarget | { refusal: string } {
    const refusal = (currentReadsAttrs() ? null : NO_ATTRS_REFUSAL) ?? blockAttrsRefusal(node) ?? (literalOf(node) === null ? literalHomeRefusal(node) : null);
    return refusal === null ? { pos, node, name: BLOCK_NAMES[node.type.name] ?? 'Block' } : { refusal };
}

/**
 * The block the selection gives attributes to, or why there is none — what
 * **Formatting → Attributes…** is enabled by and acts on. Innermost first: the
 * list item holding both ends of the selection (a literal the item writes at
 * the end of its first paragraph, at any depth), else the top-level block
 * holding them — a nested paragraph's or quote's literal is not written
 * (`fidelity.ts`), so a paragraph in a quote gives the quote its attributes and
 * a paragraph in a container meets the container's refusal. A selected block
 * (a rule, a source block) is itself; a selected image, its paragraph.
 */
export function attributesTargetAt(state: EditorState): AttributesTarget | { refusal: string } {
    const sel = state.selection;
    if (sel instanceof NodeSelection && sel.$from.depth === 0) {
        return attributesTargetOf(sel.node, sel.from);
    }
    const { $from, $to } = sel;
    if ($from.depth < 1 || $to.depth < 1 || $from.node(1) !== $to.node(1)) {
        return { refusal: NO_BLOCK_ATTRS_REFUSAL };
    }
    for (let d = $from.depth; d > 1; d--) {
        const node = $from.node(d);
        if (node.type === nodes.list_item && $to.depth >= d && $to.node(d) === node) {
            return attributesTargetOf(node, $from.before(d));
        }
    }
    return attributesTargetOf($from.node(1), $from.before(1));
}

/** The target as it is in `state`: the same kind of node at the same place, or `null` when it is gone. */
export function currentTarget(state: EditorState, target: AttributesTarget): AttributesTarget | null {
    const node = target.pos < state.doc.content.size ? state.doc.nodeAt(target.pos) : null;
    return node !== null && node.type === target.node.type ? { ...target, node } : null;
}

/** What a literal typed into the Attributes field does: a transaction and whether it removed the literal, a refusal, or nothing (unchanged). */
export type AttributesCommit = { tr: Transaction; removed: boolean } | { refusal: string } | null;

/**
 * The target given `literal` — `{}` or nothing removes its literal — as the
 * menu entry and every bar's **Attributes…** commit it: one rule for both.
 * A literal markdown-it-attrs would not read back whole is refused with the
 * reason (`literalRefusal`); an unchanged one does nothing.
 */
export function commitAttributes(state: EditorState, target: AttributesTarget, literal: string): AttributesCommit {
    const current = currentTarget(state, target);
    if (current === null) {
        return null;
    }
    const value = literal.trim();
    const removed = value === '' || value === '{}';
    const node = current.node;
    const refusal = blockAttrsRefusal(node)
        ?? (removed ? null : literalRefusal(value, literalPlaceOf(node)) ?? literalHomeRefusal(node));
    if (refusal !== null) {
        return { refusal };
    }
    const next = removed ? null : value;
    if (next === literalOf(node)) {
        return null;
    }
    if (!removed) {
        // The literal reads alone; whether it reads with the rest of its block is asked of the block as it would be.
        const set = node.type === nodes.list_item
            ? state.tr.setNodeMarkup(current.pos, undefined, { ...node.attrs, literal: next })
            : state.tr.setNodeMarkup(current.pos, undefined, { ...node.attrs, attrsSuffix: next, attrsPlacement: (node.attrs.attrsPlacement as string | null) ?? newPlacement(node) });
        const lost = literalsReadBackRefusal(set.doc, current.pos, state.doc, literalOf(node));
        if (lost !== null) {
            return { refusal: lost };
        }
    }
    const tr = node.type === nodes.list_item
        ? state.tr.setNodeMarkup(current.pos, undefined, { ...node.attrs, literal: next })
        : blockAttrsTransaction(state, current.pos, next ?? '');
    if (tr === null) {
        return null;
    }
    // A removal too: the edit filter would refuse it, beside the block as much as in it, and the field says why.
    const filtered = noteRefusal(tr);
    return filtered === null ? { tr: tr.scrollIntoView(), removed } : { refusal: filtered };
}
