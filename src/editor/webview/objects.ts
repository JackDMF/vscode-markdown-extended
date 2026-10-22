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
 * | `styled` | A run of emphasis, strikethrough or a highlight carrying a literal (`_text_{…}`) | The mark's run in its textblock |
 * | `container` | A `container` node (`::: name`) | The node |
 * | `admonition` | An `admonition` node (`!!! type "Title"`) | The node |
 * | `table` | A pipe table (`table`), the caret in a cell or cells selected | The node |
 * | `code_block` | A fenced or indented code block at any depth, the caret in its text; one with a literal stays a `code_block` | The node |
 * | `block_attrs` | A top-level block carrying an attribute literal (`attrsSuffix`), a quote's too; a table with one stays a `table` | The node |
 * | `heading` | A top-level heading that is no `block_attrs` — a requirement heading is one; a heading in a quote whose quote or itself carries a literal (`block_attrs` then when it has one) | The node |
 * | `list_item` | The innermost list item at the caret, at any depth, outside a container or an admonition | The node |
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
import { innerOf, isRemoval } from '../attributeLiteral';
import { Said, TipPart, said, value } from '../tips';
import { isTextBrace, readBrace, tightenedBrace } from '../../syntax/attrsLiteral';
import { currentInlineDefinition, currentReadsAttrs } from '../inlineEngine';
import { HolderNames, INLINE_LITERAL_HOLDERS, InlineLiteralHolder, holderNamed, holderOfCarrier, namesOf } from '../inlineLiterals';
import { SUFFIX_NODES, WRAPPER_NODES, editorSchema, noteRef } from '../schema';
import { LiteralLoss, itemTakesLiteral, literalHolder, literalLostReason, literalNotReadBack, quoteLiteralHost, quoteTakesLiteral, serializeInline } from '../serialize';
import { NoteNodeName, noteContextAt, noteRefusal } from './notes';
import { VERB, wording } from '../verbs';
import { BACKTICK_INFO_REFUSAL, LANGUAGE_FOLLOWED_REFUSAL, LANGUAGE_LITERAL_REFUSAL, LANGUAGE_WORD_REFUSAL, isLanguageWord, languageOf, parseOpeningLine, savedFence, savedOpeningLine, withLanguage } from '../fences';

const nodes = editorSchema.nodes;

export type NodeObjectKind = 'note' | 'image' | 'badge' | 'wiki_embed' | 'emoji' | 'container' | 'admonition' | 'table' | 'code_block' | 'block_attrs' | 'heading' | 'list_item' | 'raw_block' | 'injected_block' | 'front_matter';

/**
 * The objects that are a mark's run in its textblock rather than a node. A
 * `holder` is the run of a styled mark carrying no literal yet (`**x**`,
 * `` `x` ``): never what `objectAtSelection` finds — formatting has no bar of
 * its own on a caret rest — only what `attributeHolderAt` names, so its
 * attributes can be given from the menu, the bubble and `Alt+Enter`.
 */
export type MarkObjectKind = 'link' | 'span' | 'styled' | 'holder';

export type EditorObject =
    | { kind: 'link'; from: number; to: number; mark: Mark }
    | { kind: 'span'; from: number; to: number; mark: Mark }
    | { kind: 'styled'; from: number; to: number; mark: Mark }
    | { kind: 'holder'; from: number; to: number; mark: Mark }
    | { kind: NodeObjectKind; from: number; to: number; node: Node };

/** Whether the object is a mark's run (`MarkObjectKind`): a link, an attribute span, emphasis with a literal, a bare holder. */
export function isMarkObject(object: EditorObject): object is Extract<EditorObject, { mark: Mark }> {
    return object.kind === 'link' || object.kind === 'span' || object.kind === 'styled' || object.kind === 'holder';
}

/** The objects the pointer resting on them shows the toolbar for; the others show it for the caret. */
const BLOCK_OBJECTS: ReadonlySet<string> = new Set(['raw_block', 'injected_block', 'front_matter']);

/** The caret objects that are blocks: their bar sits at the block's right edge, as a block object's does. */
const BLOCK_PLACED: ReadonlySet<string> = new Set(['container', 'admonition', 'table', 'code_block', 'block_attrs', 'heading', 'list_item']);

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
    return !isMarkObject(object) && object.from < state.doc.content.size
        && state.doc.resolve(object.from).depth === 0 && state.doc.nodeAt(object.from) === object.node;
}

/**
 * Whether two objects are the same one: the same kind at the same place, of
 * the same mark where it is a run — a bare holder and the styled run it
 * becomes once it has a literal count as one.
 */
export function sameObject(a: EditorObject | null, b: EditorObject | null): boolean {
    if (a === null || b === null || a.from !== b.from || (a.kind !== b.kind && !(RUN_KINDS.has(a.kind) && RUN_KINDS.has(b.kind)))) {
        return false;
    }
    // Two runs starting at one place are one object only when they are runs of one mark, written
    // alike: code inside bold starts where the bold does (`**`foo`bar**`), and is another.
    // The delimiter only where it names the mark (`**` Bold, `__` Strong): a link whose address changed,
    // a bare one now written `[url](url)`, is the same link.
    return !('mark' in a) || !('mark' in b) || (a.mark.type === b.mark.type
        && (holderOfCarrier(a.mark.type.name)?.markups === undefined || a.mark.attrs.markup === b.mark.attrs.markup));
}

/** A run of formatting, bare or with a literal: one object as it gains or loses one. */
const RUN_KINDS: ReadonlySet<string> = new Set(['holder', 'styled']);

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
    // Ahead of `carriesBlockAttrs`: a fence with a literal is a code block, whose bar offers Attributes… among its verbs.
    code_block: 'code_block',
    // At any depth, with a literal or without: the breadcrumb's current part (#8), its List the outer one.
    list_item: 'list_item',
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

/** What an inline holder at the selection is: the holder, and the object its run or its image is. */
export interface InlineHolderAt {
    holder: InlineLiteralHolder;
    object: LiteralObject;
}

/** The object a run of `mark` (`holder`'s) is: a link, a span, a styled run carrying a literal, else a bare holder. */
function runObject(holder: InlineLiteralHolder, mark: Mark, from: number, to: number): LiteralObject {
    const kind = holder.holder === 'link' ? 'link' : holder.holder === 'span' ? 'span' : mark.attrs.literal !== null ? 'styled' : 'holder';
    return { kind, from, to, mark };
}

/**
 * The one rule for "the inline element at the selection that carries, or can
 * carry, a `{…}`", read by the bars (`objectAtSelection`, `withLiteral`) and
 * by the menu, the bubble and `Alt+Enter` (`attributeHolderAt`), so no two of
 * them name different elements: a selected image; else, with both ends of the
 * selection in one textblock, the first of `holders` — in the registry's
 * order, a link, a span, then the styled ones innermost first
 * (`inlineLiterals.ts`) — whose mark is on the node after the caret, or else
 * on the node before it, and whose run holds the selection's other end. At a
 * seam between two runs of one kind the one after the caret is meant; over
 * exactly the same text, the innermost. With `withLiteral`, a styled mark
 * counts only while it carries a literal: formatting has no bar of its own.
 */
function holderRunAt(state: EditorState, holders: readonly InlineLiteralHolder[], withLiteral: boolean, accept: (object: LiteralObject) => boolean = () => true): InlineHolderAt | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        const holder = holderOfCarrier(sel.node.type.name);
        return holder !== undefined && holders.includes(holder) && 'node' in holder.carrier
            ? { holder, object: { kind: 'image', from: sel.from, to: sel.to, node: sel.node } }
            : null;
    }
    const { $from, $to } = sel;
    if (!$from.parent.inlineContent || !$from.sameParent($to)) {
        return null;
    }
    for (const holder of holders) {
        if (!('mark' in holder.carrier)) {
            continue;
        }
        const type = editorSchema.marks[holder.carrier.mark];
        for (const neighbour of [$from.nodeAfter, $from.nodeBefore]) {
            const mark = neighbour?.marks.find(m => m.type === type && (!withLiteral || !holder.styled || m.attrs.literal !== null));
            const run = mark === undefined ? null : markRunAt($from, mark);
            const object = mark === undefined || run === null || $to.pos > run.to ? null : runObject(holder, mark, run.from, run.to);
            if (object !== null && accept(object)) {
                return { holder, object };
            }
        }
    }
    return null;
}

/**
 * What at the selection can carry a `{…}`: the inline holder there — a
 * selected image, or the run of a link, a span or a styled mark, with a
 * literal or without one (`holderRunAt`) — and the block **Attributes…** acts
 * on (`attributesTargetAt`) or why there is none. Where the bars show a mark's
 * object or an image, `inline` is that same object.
 */
export function attributeHolderAt(state: EditorState): { inline: InlineHolderAt | null; block: AttributesTarget | { refusal: Said } } {
    // Asked by every surface on every update: once per state — and per engine, whose reading of attributes the block's half asks.
    const definition = currentInlineDefinition();
    const known = holderCache.get(state);
    if (known !== undefined && known.definition === definition) {
        return known.value;
    }
    const value = { inline: holderRunAt(state, INLINE_LITERAL_HOLDERS, false), block: attributesTargetAt(state) };
    holderCache.set(state, { definition, value });
    return value;
}

const holderCache = new WeakMap<EditorState, { definition: unknown; value: ReturnType<typeof attributeHolderAt> }>();

/**
 * The inline holder inside `object` the selection is in, other than `object`
 * itself — bold in a table cell, code in a link — whose attributes the
 * object's bar offers as a verb of its own: the same search, `object`'s own
 * holder left out, the run within `object`'s range. `null` where there is none.
 */
export function holderInside(state: EditorState, object: EditorObject): InlineHolderAt | null {
    const own = isMarkObject(object) ? holderOfCarrier(object.mark.type.name) : undefined;
    // Within `object` is part of the search: a holder around it (a span around a link) is passed over, not the end of it.
    return holderRunAt(state, INLINE_LITERAL_HOLDERS.filter(h => h !== own && 'mark' in h.carrier), false,
        found => found.from >= object.from && found.to <= object.to && !sameObject(found, object));
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

/**
 * The code block both ends of the selection are in, at any depth — in a list
 * item, a quote, a container: its text is the innermost block the caret can
 * stand in, so it comes before the wrapper around it.
 */
function codeBlockAt(state: EditorState): EditorObject | null {
    const { $from, $to } = state.selection;
    return $from.parent.type === nodes.code_block && $from.sameParent($to) ? objectOfNode($from.parent, $from.before()) : null;
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

/** The blocks a heading below the top level may stand in and still be given a literal (#8): the save writes a heading's at any depth. */
const HEADING_HOSTS: ReadonlySet<string> = new Set(['blockquote', 'admonition', 'container']);

/** A node at a position. */
interface NodeAt {
    node: Node;
    pos: number;
}

/**
 * The heading holding both ends of the selection below the top level whose
 * every block around it is a quote, an admonition or a container (#8 rule 1):
 * the innermost block holder there, its literal written where it stands.
 */
function nestedHeadingOf(state: EditorState): NodeAt | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return null;
    }
    const { $from, $to } = sel;
    if ($from.depth < 2 || $from.parent.type !== nodes.heading || !$from.sameParent($to)) {
        return null;
    }
    for (let d = 1; d < $from.depth; d++) {
        if (!HEADING_HOSTS.has($from.node(d).type.name)) {
            return null;
        }
    }
    return { node: $from.parent, pos: $from.before() };
}

/** The innermost list item holding both ends of the selection, and its depth. */
function innermostItemOf(state: EditorState): (NodeAt & { depth: number }) | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return null;
    }
    const { $from, $to } = sel;
    for (let d = $from.depth; d > 1; d--) {
        const node = $from.node(d);
        if (node.type === nodes.list_item && $to.depth >= d && $to.node(d) === node) {
            return { node, pos: $from.before(d), depth: d };
        }
    }
    return null;
}

/**
 * A heading in a quote that is the bar's object (#8 Quote › Heading): when it
 * or its quote carries a literal — the breadcrumb shows them; with neither,
 * no bar. One in an admonition or a container is the wrapper's bar's.
 */
function nestedHeadingAt(state: EditorState): EditorObject | null {
    const heading = nestedHeadingOf(state);
    if (heading === null) {
        return null;
    }
    const quote = state.selection.$from.node(1);
    return literalOf(heading.node) !== null || literalOf(quote) !== null ? objectOfNode(heading.node, heading.pos) : null;
}

/** The innermost list item at the caret as the bar's object (#8): the current part, its List the outer one. */
function listItemAt(state: EditorState): EditorObject | null {
    const item = innermostItemOf(state);
    return item === null ? null : objectOfNode(item.node, item.pos);
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
 * the selection is in, the attribute span, emphasis with a literal, the note both its ends are in, the
 * code block at any depth, the container or admonition, the table, a heading in a quote that shows a
 * literal, the innermost list item, the top-level block with an attribute
 * literal, and last the top-level heading — the bar's object is the
 * breadcrumb's current part, the menu's target (`attributesTargetAt`, #8). Cells selected across (a
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
    const mark = holderRunAt(state, INLINE_LITERAL_HOLDERS, true)?.object ?? null;
    if (mark !== null) {
        return mark;
    }
    const from = noteContextAt(sel.$from);
    const to = noteContextAt(sel.$to);
    if (from !== null && to !== null && from.noteBefore === to.noteBefore) {
        return objectOfNode(from.note, from.noteBefore);
    }
    return codeBlockAt(state) ?? wrapperAt(state) ?? tableObjectAt(state) ?? nestedHeadingAt(state) ?? listItemAt(state) ?? blockAttrsAt(state) ?? headingAt(state);
}

/**
 * The object at the same place in `state`, if it is still there and still the
 * same kind; verbs act on this, never on a stale one. A mark's run is the
 * selection's object again, or — a run inside another object's, a bare
 * holder — the run of the same mark the selection is in (`holderRunAt`).
 */
export function currentObject(state: EditorState, object: EditorObject): EditorObject | null {
    if (isMarkObject(object)) {
        const found = objectAtSelection(state);
        if (sameObject(found, object)) {
            return found;
        }
        const holder = holderOfCarrier(object.mark.type.name);
        const again = holder === undefined ? null : holderRunAt(state, [holder], false)?.object ?? null;
        return sameObject(again, object) ? again : null;
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
        // The reference is made again: its anchor class is the target's.
        next = nodes[target].create(null, [noteRef(target, node.child(0).content), body], node.marks);
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
export function convertNoteRefusal(state: EditorState, pos: number): Said | null {
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
export function removeLinkRefusal(state: EditorState, link: Extract<EditorObject, { kind: 'link' }>): Said | null {
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
export const IMAGE_LOCK = 'An image goes into text — put the caret in a line of text (not code).';
/** The same, after a drop: the place is where the file was let go. */
export const DROP_LOCK = 'An image goes into text — drop it onto a line of text (not code).';
/** The same where no lock names the place: what a paste, a drop or Insert → Image… says when nothing goes in (C17c). */
export const IMAGE_PLACE_REFUSAL = 'The image can\'t go here — put the caret in a line of text.';

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
export function deleteObjectRefusal(state: EditorState, object: EditorObject): Said | null {
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
export const NO_ATTRS_REFUSAL: Said = said`Attributes are turned off, so a ${value('{…}')} would show as text. Remove ${value('attrs')} from Markdown Extended › Plugins: Disabled.`;

/** What an image's or a link's own attribute is, and the verb that changes it (F8: the bar's own label, `wording`). */
const OWN_ATTRIBUTE: Readonly<Record<string, Readonly<Record<string, { what: string; verb: string }>>>> = {
    link: {
        href: { what: 'the link\'s address', verb: wording({ verb: 'Edit', noun: 'link', opens: true }).label },
        title: { what: 'the link\'s title', verb: VERB.showInTextEditor },
    },
    image: {
        src: { what: 'the image\'s path', verb: wording({ verb: 'Edit', noun: 'image', opens: true }).label },
        alt: { what: 'the image\'s alt text', verb: wording({ verb: 'Edit', noun: 'image', opens: true }).label },
        title: { what: 'the image\'s title', verb: VERB.showInTextEditor },
    },
};

/**
 * Why `literal` cannot be an attribute span's or a block's literal at `place`
 * (a paragraph's by default), or `null`: the preview must read it there as
 * attributes, all of it (`attrsReadAt`, the rule the host's parse recognises
 * a literal by) — and reads none where the host's engine reads no
 * attributes (`NO_ATTRS_REFUSAL`). The literal is named as the attributes
 * field shows it, between the braces it draws (`innerOf`), so the reason
 * never asks for a brace one cannot type there; `braced` names it whole, for
 * a field whose text holds the braces (a code block's opening line).
 */
export function literalRefusal(literal: string, place: LiteralPlace = 'paragraph', braced = false): Said | null {
    if (!currentReadsAttrs()) {
        return NO_ATTRS_REFUSAL;
    }
    const typed = literal.trim();
    const shown = braced ? typed : innerOf(typed);
    // The value as the message names it (#10): carried as a part, never recovered from the prose.
    const v = value(shown);
    const reading = typed.startsWith('{') ? readBrace(typed, 0) : null;
    if (reading !== null && reading.close < 0) {
        // With the braces the field's, an open quote is what leaves the list unclosed — it swallows the closing brace —
        // as the plugin's own reading says it ended (`openQuote`), not as a pattern over the text guesses.
        if (reading.openQuote) {
            return said`Not set: ${v} has an open quote — close it with a double quote.`;
        }
        // F3: the attributes field draws the braces and drops a stray one (`literalFrom`), so only a field whose text holds them
        // (a code block's opening line) reaches this — pinned in attributes.test.ts.
        return said`Not set: ${v} isn't closed — end it with ${value('}')}.`;
    }
    if (typed.startsWith('{') && isTextBrace(typed, 0)) {
        const tightened = tightenedSuggestion(typed);
        return tightened === null
            ? said`Not set: ${v} has spaces around ${value('=')}, so it would show as text. Remove the spaces around it.`
            : said`Not set: ${v} has spaces around ${value('=')}, so it would show as text. Write it as ${value(braced ? tightened : innerOf(tightened))}.`;
    }
    if (parseAttrsLiteral(typed) === null) {
        const examples = braced ? [value('{.class}'), value('{#id}'), value('{key="value"}')] : [value('.class'), value('#id'), value('key="value"')];
        const what: TipPart[] = shown === '' ? ['an empty value'] : v;
        return said`Not set: ${what} isn't an attribute. Write ${examples[0]}, ${examples[1]} or ${examples[2]}.`;
    }
    if (INLINE_PLACES.has(place) && hasInnerBrace(typed)) {
        return said`Not set: the ${value('}')} inside ${v} would end the attributes there and leave the rest as text. Remove it.`;
    }
    const holder = holderNamed(place);
    const own = holder === undefined ? undefined : (parseAttrsLiteral(typed) ?? []).find(([name]) => holder.own.includes(name))?.[0];
    if (holder !== undefined && own !== undefined) {
        // The one key at fault, what it is, and the verb on the element's bar that changes it.
        const named = OWN_ATTRIBUTE[holder.holder]?.[own] ?? { what: `the ${holder.noun}'s own`, verb: VERB.showInTextEditor };
        return said`Not set: ${value(own)} is ${named.what} — ${named.verb} changes it. Here, give it a class, an id or another attribute.`;
    }
    if (place === nodes.horizontal_rule.name && !readsAsRuleLiteral(typed)) {
        return said`Not set: the ${value('{')} inside ${v} would cut this rule's attributes off. Remove it.`;
    }
    if (place === fenceHolder('```') && typed.includes('`')) {
        return said`Not set: a backtick in ${v} would end the ${value('```')} fence's code. Use a ${value('~~~')} fence, or remove it.`;
    }
    if (attrsReadAt(typed, place) === null) {
        const last = currentInlineDefinition().math ? 'HTML, a link or math' : 'HTML or a link';
        return said`Not set: ${v} holds formatting (${value('\\')}, "${{ code: '&…;' }}", code, emphasis, ${last}), so it would show as text. Remove it.`;
    }
    return null;
}

/**
 * Why a literal is refused that reads as attributes alone (`literalRefusal`)
 * but not together with the block it is written in (`literalsReadBack`): a `$`
 * in it pairing with another as a left sidebar or math, say.
 */
export const LITERAL_READ_WITH_BLOCK_REFUSAL: Said = said`Not set: a ${value('$')} here would pair with a ${value('$')} elsewhere in the block. Remove it, or use ${VERB.showInTextEditor}.`;

/**
 * Why a literal is refused in a block that, before it was set, already held a
 * literal the preview would not read back (`existing`): that one is the cause,
 * whatever is typed.
 */
export function literalAlreadyLostRefusal(existing: LiteralLoss): Said {
    if (existing.cause?.kind === 'unread') {
        return literalLostReason(existing);
    }
    if (existing.cause !== undefined || existing.literal === null) {
        return `Not set: this block already doesn't save as shown — not because of what you typed. Use ${VERB.showInTextEditor} to change the block once first.`;
    }
    return said`Not set: this block's attributes ${value(existing.literal)} already don't save as shown — not because of what you typed. Remove or change them first.`;
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
export function literalsReadBackRefusal(doc: Node, pos: number, before?: Node, changing?: string | null): Said | null {
    const block = topBlockAt(doc, pos);
    const lost = block === null ? null : literalNotReadBack(block);
    if (lost === null) {
        return null;
    }
    const old = before === undefined ? null : topBlockAt(before, pos);
    const existing = old === null ? null : literalNotReadBack(old);
    if (existing === null && (lost.cause !== undefined || lost.literal === null)) {
        // A block read as another is the edit filter's to name, which every caller asks next (`noteRefusal`):
        // a note's or an atom's own check names it better, and speaks first there.
        if (lost.cause?.kind === 'block') {
            return null;
        }
        // What the comparison of the save's text found (two runs read as one …), else text read as
        // attributes no literal gives: the edit filter's own answer, not a `$` pairing.
        return literalLostReason(lost);
    }
    return existing === null || (existing.literal !== null && existing.literal === changing) ? LITERAL_READ_WITH_BLOCK_REFUSAL : literalAlreadyLostRefusal(existing);
}

/**
 * The places of the literals written right after an inline element — a span's
 * `]`, emphasis' closing delimiter, a link's `)` — as `attrsReadAt` knows them
 * (the holders' keys, `inlineLiterals.ts`): there markdown-it-attrs cuts the
 * text after the element at the literal's first `}`.
 */
const INLINE_PLACES: ReadonlySet<string> = new Set(INLINE_LITERAL_HOLDERS.map(h => h.holder));

/**
 * An object that carries an inline literal (`inlineLiterals.ts`): a mark's run
 * — a link, a span, a styled run — or an image, a node.
 */
export type LiteralObject = Extract<EditorObject, { mark: Mark }> | { kind: 'image'; from: number; to: number; node: Node };

/** `object` as one that carries an inline literal (`LiteralObject`), or `null`: a mark's run, or an image. */
export function literalObjectOf(object: EditorObject | null): LiteralObject | null {
    if (object === null) {
        return null;
    }
    return isMarkObject(object) ? object : object.kind === 'image' ? { kind: 'image', from: object.from, to: object.to, node: object.node } : null;
}

/** The mark or the node of `object` that carries its literal. */
function carrierOf(object: LiteralObject): Mark | Node {
    return 'mark' in object ? object.mark : object.node;
}

/** `object` with the holder of its literal (`inlineLiterals.ts`). */
export function inlineHolderOf(object: LiteralObject): InlineHolderAt {
    return { holder: holderOfCarrier(carrierOf(object).type.name) as InlineLiteralHolder, object };
}

/** What the holder at `at` is called, by the delimiter its run is written with (`namesOf`: `**` Bold, `_` Emphasis …). */
export function holderNames(at: InlineHolderAt): HolderNames {
    return namesOf(at.holder, carrierOf(at.object).attrs.markup);
}

/** The delimiter `at`'s run is written with, where its mark has a choice of one (`**`, `_`); else none. */
export function holderMarkup(at: InlineHolderAt): string | undefined {
    const markup = carrierOf(at.object).attrs.markup;
    return typeof markup === 'string' ? markup : undefined;
}

/** The literal `object` carries now, or `null`. */
export function literalOfObject(object: LiteralObject): string | null {
    const literal = carrierOf(object).attrs.literal;
    return typeof literal === 'string' ? literal : null;
}

/** The place (`LiteralPlace`) of the literal an object carries: its holder's key (`holderOfCarrier`), a span's `span`, an image's `image`. */
export function inlineLiteralPlace(object: LiteralObject): LiteralPlace {
    const name = carrierOf(object).type.name;
    return holderOfCarrier(name)?.holder ?? name;
}

/**
 * The literal typed into a link's, a styled run's or an image's field as its
 * carrier will hold it: `null` for an empty field or `{}`, which remove it,
 * the literal trimmed otherwise.
 */
function typedMarkLiteral(literal: string): string | null {
    return isRemoval(literal) ? null : literal.trim();
}

/**
 * `object` given `literal` (`null`: none) instead, every other attribute of
 * its carrier kept: a mark's run its mark again, an image its node, still
 * selected when it was.
 */
function literalChange(state: EditorState, object: LiteralObject, literal: string | null): Transaction {
    if (!('mark' in object)) {
        const tr = state.tr.setNodeMarkup(object.from, undefined, { ...object.node.attrs, literal });
        return state.selection instanceof NodeSelection && state.selection.from === object.from ? tr.setSelection(NodeSelection.create(tr.doc, object.from)) : tr;
    }
    const mark = object.mark.type.create({ ...object.mark.attrs, literal });
    return state.tr.removeMark(object.from, object.to, object.mark).addMark(object.from, object.to, mark);
}

/**
 * Why the literal of a link, of emphasis or code with one (`styled`) or of
 * an image cannot be changed to `literal`, or `null`: the literal alone where
 * it is written (`literalRefusal`, at `inlineLiteralPlace`), then read with
 * its block (`literalsReadBackRefusal`), then the note around it
 * (`noteRefusal`). An empty field or `{}` removes it, which only its block and
 * a note can refuse.
 */
export function changeInlineLiteralRefusal(state: EditorState, object: LiteralObject, literal: string): Said | null {
    const value = typedMarkLiteral(literal);
    const alone = value === null ? null : literalRefusal(value, inlineLiteralPlace(object));
    if (alone !== null) {
        return alone;
    }
    const tr = literalChange(state, object, value);
    return literalsReadBackRefusal(tr.doc, object.from, state.doc, literalOfObject(object)) ?? noteRefusal(tr);
}

/**
 * The object's literal set to `literal` — removed for an empty field or `{}` —
 * in one transaction. `null` when it is unchanged or refused
 * (`changeInlineLiteralRefusal`).
 */
export function changeInlineLiteralTransaction(state: EditorState, object: LiteralObject, literal: string): Transaction | null {
    const value = typedMarkLiteral(literal);
    if (value === literalOfObject(object) || changeInlineLiteralRefusal(state, object, literal) !== null) {
        return null;
    }
    return literalChange(state, object, value).scrollIntoView();
}

/** Why `literal` cannot be given to the selection as an attribute span, or `null`: the span's literal alone (`literalRefusal`), then read with its block (`literalsReadBackRefusal`). */
export function spanLiteralRefusal(state: EditorState, literal: string): Said | null {
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
export function changeSpanRefusal(state: EditorState, span: Extract<EditorObject, { kind: 'span' }>, literal: string): Said | null {
    const value = literal.trim();
    const alone = literalRefusal(value, 'span');
    if (alone !== null) {
        return alone;
    }
    const tr = state.tr.removeMark(span.from, span.to, span.mark).addMark(span.from, span.to, editorSchema.marks.attr_span.create({ literal: value }));
    // The edit filter's answer too, as `changeSpanTransaction` asks it: a field never closes on a change that is then dropped.
    return literalsReadBackRefusal(tr.doc, span.from, state.doc, span.mark.attrs.literal as string) ?? noteRefusal(tr);
}

/**
 * Why Span with class makes no span of the selection with `literal`, or
 * `null`: the literal alone and read with its block (`spanLiteralRefusal`),
 * the selection (`spanLockReason`), then the edit filter's own answer for the
 * span made (`noteRefusal`) — the one reason its field gives, before and after
 * the focus is back.
 */
export function applySpanRefusal(state: EditorState, literal: string): Said | null {
    const applied = spanApplied(state, literal);
    return 'refusal' in applied ? applied.refusal : null;
}

/**
 * Span with class on the selection, decided in one place for its field's
 * reason (`applySpanRefusal`) and its transaction (`applySpanTransaction`):
 * the literal alone and read with its block (`spanLiteralRefusal`), the
 * selection (`spanLockReason`), then the edit filter (`noteRefusal`).
 */
function spanApplied(state: EditorState, literal: string): { tr: Transaction } | { refusal: Said } {
    const alone = spanLiteralRefusal(state, literal) ?? spanLockReason(state);
    if (alone !== null) {
        return { refusal: alone };
    }
    const { from, to } = state.selection;
    const tr = state.tr.addMark(from, to, editorSchema.marks.attr_span.create({ literal: literal.trim() }));
    const filtered = noteRefusal(tr);
    return filtered === null ? { tr } : { refusal: filtered };
}

/** Why an attribute span cannot be made of the selection, or `null`: it needs an engine that reads attributes, and selected text in one textblock that is not code. */
export function spanLockReason(state: EditorState): Said | null {
    if (!currentReadsAttrs()) {
        return NO_ATTRS_REFUSAL;
    }
    const sel = state.selection;
    const ok = sel instanceof TextSelection && !sel.empty && sel.$from.sameParent(sel.$to)
        && sel.$from.parent.inlineContent && !sel.$from.parent.type.spec.code;
    return ok ? null : 'Select text within one paragraph, heading or list item (not in a code block) to give it attributes.';
}

/**
 * The selection made an attribute span `[text]{literal}` — a span it is already
 * in given the new literal instead, as a mark type excludes itself. `null` when
 * there is no selection to make it of, or the literal is not one the plugin reads.
 */
export function applySpanTransaction(state: EditorState, literal: string): Transaction | null {
    const applied = spanApplied(state, literal);
    return 'tr' in applied ? applied.tr.scrollIntoView() : null;
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
export function removeSpanRefusal(state: EditorState, span: Extract<EditorObject, { kind: 'span' }>): Said | null {
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

/**
 * Why `quote` cannot be given a literal (#8, critique 13): a `> {…}` line under
 * it goes to the block it ends in — a list, a table, a code block, a quote —
 * named here, what happened first, then what to do.
 */
export function quoteAttrsRefusal(quote: Node): Said {
    const host = quoteLiteralHost(quote);
    if (host === null) {
        return 'This quote has no text yet, so attributes here would have nothing to style. Write a paragraph in it first.';
    }
    const kind = (BLOCK_NAMES[host.type.name] ?? 'block').toLowerCase();
    return `This quote ends in a ${kind}, so attributes here would style the ${kind}. End the quote with a paragraph to give it attributes.`;
}

/**
 * Why `node` cannot be given a literal, or `null` — the one rule the menu
 * entry, the bars and every commit ask, so none can offer what another would
 * refuse. Removing a literal is refused only on a requirement heading.
 */
export function literalHomeRefusal(node: Node): Said | null {
    switch (node.type.name) {
        case 'container':
            return CONTAINER_ATTRS_REFUSAL;
        case 'admonition':
            return ADMONITION_ATTRS_REFUSAL;
        case 'raw_block':
            return said`A source block is edited as Markdown — ${VERB.editSource} and write its ${value('{…}')} there.`;
        case 'front_matter':
            return 'Front matter is YAML — it takes no attributes.';
        case 'injected_block':
            return 'This content comes from another extension, not the file — it takes no attributes.';
        case 'code_block':
            // An indented one is fenced as it takes the literal (`blockAttrsTransaction`).
            return null;
        case 'blockquote':
            return quoteTakesLiteral(node) ? null : quoteAttrsRefusal(node);
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
    const attrs: Record<string, unknown> = { ...node.attrs, ...fencedFor(node, value), attrsSuffix: value === '' ? null : value };
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
    // Never a target: a wrapper keeps no literal here. The breadcrumb's title part is called so (`blockCrumbsOf`).
    admonition: 'Admonition',
    container: 'Container',
};

/**
 * Why a container is given no literal here (#8, critique 11): the preview draws
 * a `{…}` on its `:::` line or on a line of its own just before the closing
 * `:::` (`markdownItContainer.ts`, probe c3), but the container node has no
 * slot for one, so a container written either way stays a source block
 * (`blocks.ts`). Its classes here are its name and info.
 */
export const CONTAINER_ATTRS_REFUSAL: Said = said`A container's attributes can't be set here. Written in the file (on its ${value(':::')} line or just before the closing ${value(':::')}), they make it open as source. To add classes here, use ${VERB.editClasses}`;

/**
 * Why an admonition is given no literal here (#8, critique 10): a `{…}` as the
 * last line of its body does class the box (probe a4) — on the `!!!` line it
 * styles only the title — but the admonition node keeps neither, so one
 * written so opens as source. Its look here is its type.
 */
export const ADMONITION_ATTRS_REFUSAL: Said = `An admonition's attributes can't be set here. In the file they go on the last line of its body (the admonition then opens as source). To change its look here, choose a ${VERB.type}▾.`;

/**
 * What a source block made by an admonition's title literal says (F12, shown
 * once #5a's source marker carries the reason): `!!! note {.x}` with no title
 * draws an empty one.
 */
export const ADMONITION_TITLE_LITERAL_EMPTY: Said = said`The ${value('{.x}')} on the ${value('!!!')} line styles the title, so with no title it draws an empty one. To style the box, put ${value('{.x}')} on the last line of its body; for a styled title, write one: ${value('!!! note "Title" {.x}')}.`;

/** The same with a title: the literal styles it, not the box. */
export const ADMONITION_TITLE_LITERAL: Said = said`The ${value('{.x}')} on the ${value('!!!')} line styles the title, not the box. To style the box, put ${value('{.x}')} on the last line of its body.`;

/** What a quote whose paragraph carries its own literal says (F12, critique 12): it stays a source block. */
export const QUOTE_PARAGRAPH_LITERAL: Said = said`A paragraph inside a quote can't keep its own ${value('{.x}')} here, so the quote shows as source. Change it with ${VERB.showInTextEditor}, or style the whole quote instead with a last line ${value('> {.x}')}.`;

/**
 * Why a source block the classifier made for an attribute literal is one, in
 * words (F12): `reason` the classifier's own (`attributes on …`), `src` the
 * block's text. `null` for any other reason. Pure: whichever of #5a's source
 * marker and #8 merges second shows it in the bar's title and aria name.
 */
export function sourceExplanation(reason: string, src: string): Said | null {
    if (reason === 'attributes on admonition_title_open') {
        // The title is the quoted string after the type on the `!!!` line.
        const opening = src.split(/\r?\n/, 1)[0];
        return /^\s*(?:!!!|\?\?\?\+?)\s*\S+\s+"[^"]*"/.test(opening) ? ADMONITION_TITLE_LITERAL : ADMONITION_TITLE_LITERAL_EMPTY;
    }
    if (reason === 'attributes on paragraph_open' && /^\s*>/.test(src)) {
        return QUOTE_PARAGRAPH_LITERAL;
    }
    return null;
}

/**
 * Why a code block inside a quote, a list or a container is given no literal:
 * the save writes a fence's literal only at the top level (a nested one is
 * kept as source, `fidelity.ts`). Its other verbs work at any depth.
 */
export const NESTED_CODE_ATTRS_REFUSAL: Said = said`A code block inside a quote, a list or a container takes no ${value('{…}')} here. ${VERB.language} and ${VERB.editSource} still work.`;

/**
 * Why a list inside another block is given no literal: the save writes a
 * list's literal only at the top level (a `{…}` line under a nested list goes
 * to the outermost one, and a nested list written with one is kept as source).
 */
export const NESTED_LIST_ATTRS_REFUSAL: Said = `A list inside a quote, an admonition or a container keeps attributes only as source — use ${VERB.showInTextEditor} to add them there.`;

/**
 * Why `node`, standing inside another block, is given no literal, or `null`:
 * the save writes a literal below the top level only for a heading and a list
 * item (`writtenLiterals`, `fidelity.ts`) — a nested code block's, a nested
 * list's or any other nested block's would be dropped, so none is taken. A
 * block that takes no literal anywhere (a container, an admonition) is left to
 * `literalHomeRefusal`, whose reason names it.
 */
export function nestedAttrsRefusal(node: Node): Said | null {
    if (node.type === nodes.heading || node.type === nodes.list_item || !SUFFIX_NODES.has(node.type.name)) {
        return null;
    }
    if (node.type === nodes.code_block) {
        return NESTED_CODE_ATTRS_REFUSAL;
    }
    return node.type === nodes.bullet_list || node.type === nodes.ordered_list ? NESTED_LIST_ATTRS_REFUSAL : NO_BLOCK_ATTRS_REFUSAL;
}

/**
 * What an indented code block given `literal` becomes as well: a fenced one,
 * on the fence a new block gets, lengthened past a run inside — it has no
 * opening line to carry the literal otherwise. Nothing for any other block, or
 * no literal.
 */
function fencedFor(node: Node, literal: string): { markup?: string } {
    return node.type === nodes.code_block && node.attrs.markup === '' && literal !== ''
        ? { markup: savedFence(node) }
        : {};
}

/** Why a list item is given no literal: it is written at the end of the item's first paragraph. */
export const ITEM_ATTRS_REFUSAL = `This item's attributes go at the end of its first paragraph, and it doesn't start with one — use ${VERB.showInTextEditor}.`;

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
 * heading's apart). A caller says whether the block is `nested`, inside
 * another block: then only a heading and a list item take one
 * (`nestedAttrsRefusal`: a nested code block, list or other block is refused).
 */
export function attributesTargetOf(node: Node, pos: number, nested = false): AttributesTarget | { refusal: Said } {
    const refusal = (currentReadsAttrs() ? null : NO_ATTRS_REFUSAL)
        ?? (nested ? nestedAttrsRefusal(node) : null)
        ?? blockAttrsRefusal(node) ?? (literalOf(node) === null ? literalHomeRefusal(node) : null);
    return refusal === null ? { pos, node, name: BLOCK_NAMES[node.type.name] ?? 'Block' } : { refusal };
}

/**
 * The block the selection gives attributes to, or why there is none — what
 * **Formatting → Attributes of Paragraph…** is named by and acts on, and the
 * breadcrumb's current block part (`crumbsAt`, #8): one rule, so the bar and
 * the menu name the same block. Innermost first: a heading in a quote, an
 * admonition or a container (its literal written where it stands), else the
 * list item holding both ends of the selection (a literal the item writes at
 * the end of its first paragraph, at any depth), else the top-level block
 * holding them — a nested paragraph's or quote's literal is not written
 * (`fidelity.ts`), so a paragraph in a quote gives the quote its attributes and
 * a paragraph in a container meets the container's refusal. A selected block
 * (a rule, a source block) is itself; a selected image, its paragraph.
 */
export function attributesTargetAt(state: EditorState): AttributesTarget | { refusal: Said } {
    const sel = state.selection;
    if (sel instanceof NodeSelection && sel.$from.depth === 0) {
        return attributesTargetOf(sel.node, sel.from);
    }
    const { $from, $to } = sel;
    if ($from.depth < 1 || $to.depth < 1 || $from.node(1) !== $to.node(1)) {
        return { refusal: NO_BLOCK_ATTRS_REFUSAL };
    }
    const held = nestedHeadingOf(state) ?? innermostItemOf(state);
    if (held !== null) {
        return attributesTargetOf(held.node, held.pos, true);
    }
    return attributesTargetOf($from.node(1), $from.before(1));
}

/** The target as it is in `state`: the same kind of node at the same place, or `null` when it is gone. */
export function currentTarget(state: EditorState, target: AttributesTarget): AttributesTarget | null {
    const node = target.pos < state.doc.content.size ? state.doc.nodeAt(target.pos) : null;
    return node !== null && node.type === target.node.type ? { ...target, node } : null;
}

/** What an open field or a bar holds a position of: a block target, an object, an inline element's run, a range. */
export type Followed = AttributesTarget | EditorObject | LiteralObject | { from: number; to: number };

/**
 * `items` followed through `transactions` into `doc`, in place (#8 F7, the
 * wave-2 follow-up): a host resync that inserts above a bar's object or an
 * open field's target moves them, it does not close the field. Each is
 * mapped once however often it is named. Returned: the ones that are gone —
 * a step deleted across their start, or (a block, a node object) no node of
 * their type stands at the mapped place, decided on the new document; a run
 * whose end met its start. Positions only: O(items × steps), never per key.
 */
export function followAll(items: Iterable<Followed>, transactions: readonly Transaction[], doc: Node): Set<Followed> {
    const gone = new Set<Followed>();
    for (const item of new Set(items)) {
        let from = 'pos' in item ? item.pos : item.from;
        // A node's start also mapped leaning left: a step that replaces only the node's markup at its own place
        // (a resync's `setNodeMarkup`) maps a right-leaning start into the node.
        let left = from;
        let to = 'pos' in item ? item.pos + item.node.nodeSize : item.to;
        let across = false;
        for (const tr of transactions) {
            const start = tr.mapping.mapResult(from, 1);
            across = across || start.deletedAcross;
            from = start.pos;
            left = tr.mapping.map(left, -1);
            to = tr.mapping.map(to, -1);
        }
        if ('pos' in item || 'node' in item) {
            const was = item.node;
            const at = (pos: number) => (!across && pos < doc.content.size ? doc.nodeAt(pos) : null);
            from = at(from)?.type === was.type ? from : left;
            const node = at(from);
            if (node === null || node.type !== was.type) {
                gone.add(item);
                continue;
            }
            if ('pos' in item) {
                item.pos = from;
                item.node = node;
            } else {
                item.from = from;
                item.to = from + node.nodeSize;
                item.node = node;
            }
        } else if (across || to < from || ('mark' in item && to === from)) {
            gone.add(item);
        } else {
            item.from = from;
            item.to = to;
        }
    }
    return gone;
}

// ---------------------------------------------------------------------------
// The breadcrumb: the parts at the caret that hold a {…} (#8)
// ---------------------------------------------------------------------------

/**
 * One part of the breadcrumb (#8): a block or an inline element that holds,
 * or can hold, a `{…}`. The current part is the caret's innermost holder —
 * the bar's object and the menu's target; the outer one the block around it.
 */
export interface CrumbPart {
    role: 'current' | 'outer';
    /** As the field and the menu call it (`BLOCK_NAMES`, `holderNames`): `List item`, `List`, `Quote`, `Heading`, `Bold`; a wrapper's is its kind (its bar names it). */
    name: string;
    /** As written, braces included; `null` for none. */
    literal: string | null;
    /** What its field acts on; `null` for a title part (an admonition, a container: no literal kept here) or a refused one. */
    target: AttributesTarget | InlineHolderAt | null;
    /** Why a part that is drawn cannot be given attributes (a list inside a quote, F3); `null` when it can. */
    refusal: Said | null;
    /** Where its field opens: under the holder's own line, under the block, at the run. */
    anchor: 'line' | 'block' | 'run';
    from: number;
    to: number;
}

/** The breadcrumb at the caret: the current part and, where the editor holds both levels, the outer one. */
export interface Crumbs {
    current: CrumbPart;
    outer: CrumbPart | null;
}

/** The lists whose literal the save writes: a top-level one's (`writtenLiterals`). */
const LIST_NODES: ReadonlySet<string> = new Set(['bullet_list', 'ordered_list']);

/** `node` at `pos` as a block part: named by its kind, its target or the reason it has none. */
function blockPart(role: CrumbPart['role'], node: Node, pos: number, nested: boolean): CrumbPart {
    const found = attributesTargetOf(node, pos, nested);
    const refused = 'refusal' in found;
    const own = node.type === nodes.list_item || node.type === nodes.heading;
    return {
        role,
        name: BLOCK_NAMES[node.type.name] ?? 'Block',
        literal: literalOf(node),
        target: refused ? null : found,
        refusal: refused ? found.refusal : null,
        anchor: own ? 'line' : 'block',
        from: pos,
        to: pos + node.nodeSize,
    };
}

/**
 * The block parts at the selection, the inline element left out — what the
 * Block type menu's two entries read (`blockPartsAt`) and what the bar's
 * breadcrumb is built on (`crumbsAt`). O(depth): it reads `$from`'s
 * ancestors, never the document.
 *
 * - A heading in a quote: the heading, and the quote when that carries a literal.
 * - A heading in an admonition or a container: the heading, and — only when the
 *   heading carries a literal — the wrapper as a title part (no target: the
 *   wrapper keeps no literal here; its bar names it).
 * - A list item: the item, and always a List — the top-level list, the only one
 *   the file can give a literal to (F2); for a list not at the top level a
 *   refused part (F3).
 * - Else the top-level block alone (refused in a wrapper, as the menu says).
 */
function blockCrumbsOf(state: EditorState): Crumbs | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return null;
    }
    const { $from, $to } = sel;
    if ($from.depth < 1 || $to.depth < 1 || $from.node(1) !== $to.node(1)) {
        return null;
    }
    const heading = nestedHeadingOf(state);
    if (heading !== null) {
        const current = blockPart('current', heading.node, heading.pos, true);
        for (let d = $from.depth - 1; d >= 1; d--) {
            const node = $from.node(d);
            if (WRAPPER_NODES.has(node.type.name)) {
                // The literal gate stays for a wrapper (ux-critic reopen): its other lines reach it.
                const title: CrumbPart = {
                    role: 'outer', name: BLOCK_NAMES[node.type.name] ?? 'Block', literal: null, target: null, refusal: null,
                    anchor: 'block', from: $from.before(d), to: $from.before(d) + node.nodeSize,
                };
                return { current, outer: current.literal === null ? null : title };
            }
        }
        const quote = $from.node(1);
        return { current, outer: literalOf(quote) === null ? null : blockPart('outer', quote, $from.before(1), false) };
    }
    const item = innermostItemOf(state);
    if (item !== null) {
        const current = blockPart('current', item.node, item.pos, true);
        const top = $from.node(1);
        if (LIST_NODES.has(top.type.name)) {
            return { current, outer: blockPart('outer', top, $from.before(1), false) };
        }
        // Drawn always, and refused (F3): a list inside a quote, an admonition or a container keeps no literal here.
        const list = $from.node(item.depth - 1);
        const from = $from.before(item.depth - 1);
        return {
            current,
            outer: { role: 'outer', name: BLOCK_NAMES[list.type.name] ?? 'List', literal: null, target: null, refusal: NESTED_LIST_ATTRS_REFUSAL, anchor: 'block', from, to: from + list.nodeSize },
        };
    }
    return { current: blockPart('current', $from.node(1), $from.before(1), false), outer: null };
}

/** `at` as the breadcrumb's current part: an inline element, its field at its run. */
function inlinePart(at: InlineHolderAt): CrumbPart {
    return {
        role: 'current', name: holderNames(at).label, literal: literalOfObject(at.object), target: at, refusal: null,
        anchor: 'run', from: at.object.from, to: at.object.to,
    };
}

/**
 * The breadcrumb at the selection (#8): the caret's innermost holder — the
 * inline element carrying a literal (the bar's object, `holderRunAt`), else
 * the innermost block holder (`attributesTargetAt`'s) — and the outer part:
 * for an inline element the innermost block holder when that carries a
 * literal, else, in a list item, its List when that carries one; for a block,
 * as `blockCrumbsOf` says. At most two parts. `null` where the selection
 * holds neither (across blocks, a node selected that is no image).
 *
 * Asked by the bar on every refresh: once per state (and per engine, whose
 * reading of attributes the targets ask), O(depth) the first time.
 */
export function crumbsAt(state: EditorState): Crumbs | null {
    const definition = currentInlineDefinition();
    const known = crumbCache.get(state);
    if (known !== undefined && known.definition === definition) {
        return known.value;
    }
    const blocks = blockCrumbsAt(state);
    const inline = state.selection instanceof TextSelection || state.selection instanceof NodeSelection
        ? holderRunAt(state, INLINE_LITERAL_HOLDERS, true)
        : null;
    let value: Crumbs | null = blocks;
    if (inline !== null) {
        const block = blocks?.current ?? null;
        const outer = block !== null && block.target !== null && block.literal !== null
            ? { ...block, role: 'outer' as const }
            : block?.name === BLOCK_NAMES.list_item && blocks?.outer?.target && blocks.outer.literal !== null ? blocks.outer : null;
        value = { current: inlinePart(inline), outer };
    }
    crumbCache.set(state, { definition, value });
    return value;
}

const crumbCache = new WeakMap<EditorState, { definition: unknown; value: Crumbs | null }>();

/** `blockCrumbsOf`, once per state and engine. */
function blockCrumbsAt(state: EditorState): Crumbs | null {
    const definition = currentInlineDefinition();
    const known = blockCrumbCache.get(state);
    if (known !== undefined && known.definition === definition) {
        return known.value;
    }
    const value = blockCrumbsOf(state);
    blockCrumbCache.set(state, { definition, value });
    return value;
}

const blockCrumbCache = new WeakMap<EditorState, { definition: unknown; value: Crumbs | null }>();

/**
 * The Block type menu's two attribute entries, from the one resolver (#8):
 * the innermost block holder (`attributesTargetAt`), then the outer block
 * part — a List, a Quote — or `null` where there is none to offer (no outer
 * block, or one that keeps no literal here: an admonition's title part).
 */
export function blockPartsAt(state: EditorState): { current: AttributesTarget | { refusal: Said }; outer: CrumbPart | null } {
    const outer = blockCrumbsAt(state)?.outer ?? null;
    return { current: attributeHolderAt(state).block, outer: outer !== null && outer.target === null && outer.refusal === null ? null : outer };
}

/**
 * What a literal typed into the Attributes field does: a transaction, whether
 * it removed the literal and whether it fenced an indented code block (the
 * hint says so), a refusal, or nothing (unchanged).
 */
export type AttributesCommit = { tr: Transaction; removed: boolean; fenced: boolean } | { refusal: Said } | null;

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
    const removed = isRemoval(value);
    const node = current.node;
    // Below the top level only a heading's and a list item's literal is written: any other would be dropped by the save.
    const refusal = (state.doc.resolve(current.pos).depth > 0 ? nestedAttrsRefusal(node) : null)
        ?? blockAttrsRefusal(node)
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
            : state.tr.setNodeMarkup(current.pos, undefined, { ...node.attrs, ...fencedFor(node, value), attrsSuffix: next, attrsPlacement: (node.attrs.attrsPlacement as string | null) ?? newPlacement(node) });
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
    return filtered === null ? { tr: tr.scrollIntoView(), removed, fenced: !removed && fencedFor(node, value).markup !== undefined } : { refusal: filtered };
}

// ---------------------------------------------------------------------------
// A code block's opening line — Edit source and Language…
// ---------------------------------------------------------------------------

/**
 * A code block as the field's caller holds it: the object `currentObject`
 * found in `state` — where it stands and the node there.
 */
export type CodeBlockObject = Extract<EditorObject, { node: Node }>;

/** The code block at `block` with `line` as its opening line, read (`parseOpeningLine`); the refusal of the line itself otherwise. */
function withOpeningLine(state: EditorState, { from: pos, node }: CodeBlockObject, line: string): Transaction | { refusal: Said } {
    const parsed = parseOpeningLine(line, node.textContent, String(node.attrs.params ?? ''));
    if ('refusal' in parsed) {
        return parsed;
    }
    return state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        markup: parsed.markup,
        params: parsed.params,
        attrsSuffix: parsed.literal,
        attrsPlacement: parsed.literal === null ? null : 'end',
    });
}

/**
 * What a typed opening line does to the code block `block`, in one pass: the
 * transaction that sets it, the reason it is refused, or `null` — the line
 * leaves the file as it is. The line the field showed, typed back as it is,
 * changes nothing and is never read again: the info string is kept as the file
 * has it, spacing and braces that are text included. The refusals, in order: the
 * line's own (`parseOpeningLine`: no fence, a fence too short for the content,
 * a backtick after backticks), then its literal's — none inside another block
 * (`NESTED_CODE_ATTRS_REFUSAL`), else the one every literal meets
 * (`literalRefusal`) and the block's read-back (`literalsReadBackRefusal`) —
 * then the edit filter's (`noteRefusal`). "As it is" is what the save writes
 * (`savedOpeningLine`): a block whose fence the save lengthens, given that
 * longer fence by hand, is unchanged; an indented block given a fence is not.
 */
function openingLineChange(state: EditorState, block: CodeBlockObject, line: string): { tr: Transaction } | { refusal: Said } | null {
    const { from: pos, node } = block;
    if (node.attrs.markup !== '' && line === savedOpeningLine(node)) {
        return null;
    }
    const tr = withOpeningLine(state, block, line);
    if (!(tr instanceof Transaction)) {
        return tr;
    }
    // `setNodeMarkup` at `pos` leaves a node there.
    const next = tr.doc.nodeAt(pos) ?? node;
    const literal = next.attrs.attrsSuffix as string | null;
    // A literal is read on the fence it stands on (`fenceHolder`): asked again when either changes.
    if (literal !== null && (literal !== node.attrs.attrsSuffix || fenceHolder(String(next.attrs.markup)) !== fenceHolder(String(node.attrs.markup)))) {
        const refusal = (state.doc.resolve(pos).depth > 0 ? NESTED_CODE_ATTRS_REFUSAL : null)
            // The opening line's field holds the braces as typed: the reason names the literal whole.
            ?? literalRefusal(literal, fenceHolder(String(next.attrs.markup)), true)
            ?? literalsReadBackRefusal(tr.doc, pos, state.doc, node.attrs.attrsSuffix as string | null);
        if (refusal !== null) {
            return { refusal };
        }
    }
    const filtered = noteRefusal(tr);
    if (filtered !== null) {
        return { refusal: filtered };
    }
    const unchanged = (node.attrs.markup === '') === (next.attrs.markup === '') && savedOpeningLine(next) === savedOpeningLine(node);
    return unchanged ? null : { tr: tr.scrollIntoView() };
}

/**
 * Language… committed: the code block `block` with `language` as its info
 * string's first word, the rest of the info string and the literal kept as
 * they are — set on the node directly, not read back from a line
 * (`parseOpeningLine` reads braces; the language has none to say) — and
 * whether it fenced an indented block, on the fence the save writes for it
 * (`savedFence`). The one rule it meets is the backtick's: none in the info
 * string of a ``` fence (a language that is itself a backtick, `a`b`). A value
 * that is not one word (a space, a brace) is refused, the reason pointing to
 * Edit source; so is an emptied language while words or a {…} follow it, which
 * would become the language. `null` when the language is as it is.
 */
export function changeLanguageTransaction(state: EditorState, block: CodeBlockObject, language: string): { tr: Transaction; fenced: boolean } | { refusal: Said } | null {
    const { from: pos, node } = block;
    if (!isLanguageWord(language)) {
        return { refusal: LANGUAGE_WORD_REFUSAL };
    }
    const word = language.trim();
    const params = String(node.attrs.params ?? '');
    if (word === languageOf(params)) {
        // Unchanged — an indented block has no language to remove — and the info string's spacing is none of its business.
        return null;
    }
    const rest = withLanguage(params, '');
    if (word === '' && rest !== '') {
        // The next word of the info string would become the language (Daniel, #4 build questions); a {…} is named as such.
        return { refusal: rest.startsWith('{') ? LANGUAGE_LITERAL_REFUSAL : LANGUAGE_FOLLOWED_REFUSAL };
    }
    const indented = node.attrs.markup === '';
    const fence = savedFence(node);
    const next = withLanguage(params, word);
    if (fence.startsWith('`') && next.includes('`')) {
        return { refusal: BACKTICK_INFO_REFUSAL };
    }
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, markup: indented ? fence : node.attrs.markup, params: next });
    const filtered = noteRefusal(tr);
    return filtered === null ? { tr: tr.scrollIntoView(), fenced: indented } : { refusal: filtered };
}

/** An opening-line change with whether it fenced an indented block, a refusal or nothing as it is. */
function withFenced(change: ReturnType<typeof openingLineChange>, fenced: boolean): { tr: Transaction; fenced: boolean } | { refusal: Said } | null {
    if (change === null) {
        return null;
    }
    return 'refusal' in change ? change : { tr: change.tr, fenced };
}

/**
 * Edit source committed on the code block `block`: `line` as its opening
 * line — fence, info string, literal (`parseOpeningLine`) — and whether that
 * fenced an indented block, whose field opens empty, so `''` there fences it
 * on the fence a new block gets. `null` when the file stays as it is; a
 * refusal for a line `openingLineChange` refuses.
 */
export function commitOpeningLine(state: EditorState, block: CodeBlockObject, line: string): { tr: Transaction; fenced: boolean } | { refusal: Said } | null {
    const fenced = block.node.attrs.markup === '';
    return withFenced(openingLineChange(state, block, fenced && line.trim() === '' ? savedFence(block.node) : line), fenced);
}
