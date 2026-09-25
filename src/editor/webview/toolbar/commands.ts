/**
 * What the toolbar's actions do to the editor state. ProseMirror only, no DOM,
 * so each piece can be exercised on an `EditorState` in a unit test.
 */
import { lift, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { Mark, MarkType, Node, NodeType, ResolvedPos } from 'prosemirror-model';
import { liftListItem, wrapInList } from 'prosemirror-schema-list';
import { GapCursor } from 'prosemirror-gapcursor';
import { AllSelection, Command, EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { PRESERVE_SOURCE_META } from '../../fidelity';
import { editorSchema } from '../../schema';
import { RAW_TEXT_MARKS, serializeNode, unwritableInNote } from '../../serialize';
import { ActionApply, BlockTarget, FOOTNOTE_LABEL } from './actions';

const nodes = editorSchema.nodes;

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

function markMatches(mark: Mark, type: MarkType, markup: string | null): boolean {
    return mark.type === type && (markup === null || mark.attrs.markup === markup);
}

/**
 * Whether the selection carries `type` written with `markup`: at a caret, the
 * marks typing would get; over a range, every piece of text in it.
 */
export function markActive(state: EditorState, type: MarkType, markup: string | null): boolean {
    const { empty, $from, from, to } = state.selection;
    if (empty) {
        return (state.storedMarks ?? $from.marks()).some(m => markMatches(m, type, markup));
    }
    let text = false;
    let all = true;
    state.doc.nodesBetween(from, to, node => {
        if (node.isText) {
            text = true;
            all = all && node.marks.some(m => markMatches(m, type, markup));
        }
    });
    return text && all;
}

/**
 * The one toggle both policies below share: remove `type` when `removes` says
 * the selection already has what the command is for, otherwise add it written
 * with `markup` (`null` for a mark with no delimiter attribute, `code`). A mark
 * type excludes itself, so adding replaces the same type with another
 * delimiter rather than nesting a second one inside it.
 */
function markTransaction(state: EditorState, type: MarkType, markup: string | null, removes: (state: EditorState) => boolean): Transaction | null {
    if (!toggleMark(type)(state)) {
        return null;
    }
    const active = removes(state);
    const mark = markup === null ? type.create() : type.create({ markup });
    const tr = state.tr;
    if (state.selection.empty) {
        return active ? tr.removeStoredMark(type) : tr.addStoredMark(mark);
    }
    for (const range of state.selection.ranges) {
        if (active) {
            tr.removeMark(range.$from.pos, range.$to.pos, type);
        } else {
            tr.addMark(range.$from.pos, range.$to.pos, mark);
        }
    }
    return tr.scrollIntoView();
}

/**
 * Why toggling `type` here would make a note the serializer cannot write back
 * (`unwritableInNote`), or `null`. Only code, superscript and subscript can:
 * their text is written as it is, so over a note (`^a ++b|c++ d^`) or over a
 * note part's terminator the next parse would read another document.
 */
function markRefusalOf(state: EditorState, type: MarkType, tr: Transaction | null): string | null {
    if (!RAW_TEXT_MARKS.has(type.name) || tr === null || !tr.docChanged) {
        return null;
    }
    return unwritableInNote(tr.doc, state.selection.from, state.selection.to);
}

function toggleMarkWith(type: MarkType, markup: string | null, removes: (state: EditorState) => boolean): Command {
    return (state, dispatch) => {
        const tr = markTransaction(state, type, markup, removes);
        if (tr === null || markRefusalOf(state, type, tr) !== null) {
            return false;
        }
        dispatch?.(tr);
        return true;
    };
}

/** Why a toolbar button's mark cannot be toggled here, for its tooltip; `null` when nothing refuses it. */
export function markRefusal(state: EditorState, type: MarkType, markup: string | null): string | null {
    return markRefusalOf(state, type, markTransaction(state, type, markup, s => markActive(s, type, markup)));
}

/**
 * A toolbar button: toggle a mark written with *its* delimiter. Off where the
 * whole selection already carries it with that delimiter; on otherwise — so
 * the `_` button on text that is `*` **swaps** the delimiter. Each button
 * stands for one of the four elements `markdown-it-ib` renders, and pressing
 * the one the text is not yet is asking for that element.
 */
export function toggleMarkup(type: MarkType, markup: string | null): Command {
    return toggleMarkWith(type, markup, state => markActive(state, type, markup));
}

/**
 * A key (`Mod-i`, `Mod-b`): toggle the mark by its **type**. Off where the whole
 * selection carries it with any delimiter — `Ctrl+B` un-bolds `__strong__` in
 * one press, as it always did — and on otherwise, written with `markup`, the
 * CommonMark default (`*`, `**`). The key says "emphasis", not "this element".
 */
export function toggleMarkType(type: MarkType, markup: string): Command {
    return toggleMarkWith(type, markup, state => markActive(state, type, null));
}

// ---------------------------------------------------------------------------
// Block type
// ---------------------------------------------------------------------------

/** The kind of block the selection is in, as the block-type control shows it. */
export interface CurrentBlock {
    node: BlockTarget;
    level?: number;
}

function isRequirementHeading(node: Node): boolean {
    return node.type === nodes.heading && (node.attrs.reqPrefix !== null || node.attrs.attrsSuffix !== null);
}

export const REQUIREMENT_HEADING_LOCK = 'A requirement heading keeps its type: changing it would lose its id and its anchor. Edit the title only.';
export const ATOM_LOCK = 'A source block or content another extension shows is selected; it has no block type to change.';
export const NODE_LOCK = 'A whole element is selected, not text in a block; put the caret in a paragraph or heading to change its type.';
export const GAP_LOCK = 'The caret is between two blocks, where there is no block to retype. Insert adds a block here.';
export const ALL_LOCK = 'The whole document is selected, several blocks at once; select one block to change its type.';
export const WHOLE_LOCK = 'The whole document is selected; put the caret in the block to change its type.';
export const NO_TEXT_LOCK = 'Put the caret in a paragraph or heading to change its type.';

/**
 * Why the block type cannot be changed here, or `null` when it can — decided
 * per kind of selection, so the tooltip says what is actually the matter:
 *
 * - text (`TextSelection`): locked only on a requirement heading (`reqPrefix`
 *   or `attrsSuffix`), where setting a type rebuilds the heading's attributes
 *   and one click would lose the id and the anchor;
 * - a selected node: an atom (a source block, injected content, the front
 *   matter, a badge) has no type; any other node (a rule, an image) is not a
 *   text block the type applies to;
 * - a gap cursor stands between blocks, in none;
 * - Ctrl+A (`AllSelection`) selects the document, not a block.
 */
export function blockLockReason(state: EditorState): string | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection) {
        return sel.node.type.spec.atom === true ? ATOM_LOCK : NODE_LOCK;
    }
    if (sel instanceof GapCursor) {
        return GAP_LOCK;
    }
    if (sel instanceof AllSelection) {
        return state.doc.childCount > 1 ? ALL_LOCK : WHOLE_LOCK;
    }
    if (!(sel instanceof TextSelection)) {
        return NO_TEXT_LOCK;
    }
    let locked = isRequirementHeading(sel.$from.parent) || isRequirementHeading(sel.$to.parent);
    state.doc.nodesBetween(sel.from, sel.to, node => {
        locked = locked || isRequirementHeading(node);
        return !locked;
    });
    return locked ? REQUIREMENT_HEADING_LOCK : null;
}

/** The innermost list or quote around the caret's block, with its depth. */
function wrapperOf($pos: ResolvedPos): { node: Node; depth: number } | null {
    for (let d = $pos.depth - 1; d > 0; d--) {
        const node = $pos.node(d);
        if (node.type === nodes.bullet_list || node.type === nodes.ordered_list || node.type === nodes.blockquote) {
            return { node, depth: d };
        }
    }
    return null;
}

/** What the block-type control shows: the textblock's own type, or, for a paragraph, the list or quote around it. */
export function currentBlock(state: EditorState): CurrentBlock | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection)) {
        return null;
    }
    const parent = sel.$from.parent;
    if (parent.type === nodes.heading) {
        return { node: 'heading', level: parent.attrs.level as number };
    }
    if (parent.type === nodes.code_block) {
        return { node: 'code_block' };
    }
    if (parent.type !== nodes.paragraph) {
        return null;
    }
    const wrapper = wrapperOf(sel.$from);
    return wrapper ? { node: wrapper.node.type.name as BlockTarget } : { node: 'paragraph' };
}

export function isCurrent(current: CurrentBlock | null, node: BlockTarget, level?: number): boolean {
    return current !== null && current.node === node && (node !== 'heading' || current.level === level);
}

/** Change the list the caret is in to the other kind, keeping its items. */
function convertList(target: NodeType): Command {
    return (state, dispatch) => {
        const wrapper = wrapperOf(state.selection.$from);
        if (!wrapper || wrapper.node.type === nodes.blockquote || wrapper.node.type === target) {
            return false;
        }
        if (dispatch) {
            const pos = state.selection.$from.before(wrapper.depth);
            dispatch(state.tr.setNodeMarkup(pos, target, { tight: wrapper.node.attrs.tight }).scrollIntoView());
        }
        return true;
    };
}

/** A rule after the block the selection is in. */
const insertRule: Command = (state, dispatch) => {
    const pos = insertionPoint(state);
    if (dispatch) {
        const tr = state.tr.insert(pos, nodes.horizontal_rule.create());
        dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView());
    }
    return true;
};

/**
 * The command a `block` action runs. The type the block already has is not
 * applied again (it would only reset the block's attributes); a list or quote
 * that is already there is lifted, a list of the other kind converted.
 */
export function blockCommand(node: BlockTarget, level?: number): Command {
    if (node === 'horizontal_rule') {
        return insertRule;
    }
    return (state, dispatch) => {
        if (blockLockReason(state) !== null) {
            return false;
        }
        const current = currentBlock(state);
        const $from = state.selection.$from;
        const wrapper = wrapperOf($from);
        switch (node) {
            case 'paragraph':
                if ($from.parent.type !== nodes.paragraph) {
                    return setBlockType(nodes.paragraph)(state, dispatch);
                }
                if (!wrapper) {
                    return false;
                }
                return wrapper.node.type === nodes.blockquote ? lift(state, dispatch) : liftListItem(nodes.list_item)(state, dispatch);
            case 'heading':
                return isCurrent(current, 'heading', level) ? false : setBlockType(nodes.heading, { level })(state, dispatch);
            case 'code_block':
                return isCurrent(current, 'code_block') ? false : setBlockType(nodes.code_block, { params: '', markup: '```' })(state, dispatch);
            case 'blockquote':
                return wrapper?.node.type === nodes.blockquote ? lift(state, dispatch) : wrapIn(nodes.blockquote)(state, dispatch);
            case 'bullet_list':
            case 'ordered_list': {
                const type = nodes[node];
                if (wrapper?.node.type === type) {
                    return liftListItem(nodes.list_item)(state, dispatch);
                }
                if (wrapper && wrapper.node.type !== nodes.blockquote) {
                    return convertList(type)(state, dispatch);
                }
                return wrapInList(type)(state, dispatch);
            }
        }
        return false;
    };
}

// ---------------------------------------------------------------------------
// Constructs outside the editable core (a footnote, the block constructs), written as source
// ---------------------------------------------------------------------------

/** What writing source needs from the page. */
export interface SourceContext {
    eol: '\n' | '\r\n';
    defaultWrap: number;
    /** The document's text as it would be saved, to pick a footnote label it does not use. */
    documentText: string;
}

/** The first footnote number `text` does not use yet. */
export function freeFootnoteLabel(text: string): string {
    const used = new Set<string>();
    for (const m of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
        used.add(m[1]);
    }
    let n = 1;
    while (used.has(String(n))) {
        n++;
    }
    return String(n);
}

function label(text: string, value: string): string {
    return text.split(FOOTNOTE_LABEL).join(value);
}

/** A source block's `src`: the template's lines in the document's line ending, the last one terminated. */
function sourceText(text: string, eol: '\n' | '\r\n'): string {
    return text.split(/\r?\n/).join(eol) + eol;
}

/**
 * Where an inserted block goes: after the top-level block the selection ends
 * in — read from `$to`, so a selection over several blocks inserts after the
 * last of them. A selection that ends between top-level blocks (a selected
 * top-level atom, `AllSelection`, a gap cursor) inserts at that boundary: after
 * the atom, after the last block for Ctrl+A, where the gap cursor stands.
 *
 * Never before the first block. A block written first is the file's first
 * line, and `---` there opens front matter: with another `---` lower down,
 * the next parse folds everything between into YAML. Nothing goes before the
 * front matter either, which the same rule covers. Only an empty document
 * takes a block at 0, having nothing to follow.
 */
export function insertionPoint(state: EditorState): number {
    const sel = state.selection;
    const doc = state.doc;
    const $to = sel.$to;
    const pos = $to.depth === 0 ? $to.pos : $to.after(1);
    const first = doc.firstChild;
    return first !== null ? Math.max(pos, first.nodeSize) : pos;
}

/**
 * Stand-ins for the markers while the block is serialized. The serializer
 * escapes `==`, `^`, `++`, `$`, … in text (`ESCAPE_EXTRA`), which is exactly
 * what must not happen to them; private-use characters pass unescaped and are
 * replaced afterwards. One per marker character, so the wrapper measures the
 * line as it will be, and no space inside, so it never breaks a line in one.
 * Not U+E000/U+E001: those are the wrapper's hold markers, which it strips.
 */
const OPEN_STAND_IN = String.fromCharCode(0xe002);
const CLOSE_STAND_IN = String.fromCharCode(0xe003);

export const WRAP_LOCK = 'Put the caret in, or select text within, one paragraph, heading or list item (not code) to add this.';

/** Whether a `wrap-source` action can act on this selection: text inside one textblock that is not code. */
export function canWrapSource(state: EditorState): boolean {
    const sel = state.selection;
    if (!(sel instanceof TextSelection)) {
        return false;
    }
    const parent = sel.$from.parent;
    return sel.$from.sameParent(sel.$to) && parent.isTextblock && !parent.type.spec.code && sel.$from.depth >= 1;
}

/** The marks the text at both ends of the selection shares: the markers go inside those, so they nest. */
function sharedMarks(state: EditorState): readonly Mark[] {
    const { $from, $to, empty } = state.selection;
    const code = editorSchema.marks.code;
    if (empty) {
        return $from.marks().filter(m => m.type !== code);
    }
    const first = $from.nodeAfter?.marks ?? [];
    const last = $to.nodeBefore?.marks ?? [];
    return first.filter(m => m.type !== code && m.isInSet(last));
}

function count(haystack: string, needle: string): number {
    return needle === '' ? 1 : haystack.split(needle).length - 1;
}

/**
 * `block` (a top-level node holding stand-in runs) as a source block: serialized
 * by rule, as any edited block is, then each run replaced by the literal it
 * stands for, so the literal is written unescaped. `null` when a run is not in
 * the text exactly once.
 */
function asSourceBlock(block: Node, runs: readonly (readonly [string, string])[], context: SourceContext, gap: string | null): Node | null {
    let written = serializeNode(block.type.create({ ...block.attrs, src: null }, block.content, block.marks), { defaultWrap: context.defaultWrap });
    for (const [run, literal] of runs) {
        if (run === '') {
            continue;
        }
        if (count(written, run) !== 1) {
            return null;
        }
        written = written.split(run).join(literal);
    }
    return nodes.raw_block.create({ src: sourceText(written, context.eol), gap, html: '' });
}

/**
 * The transaction a `wrap-source` action makes: the selection's text wrapped
 * in `open` … `close` as literal Markdown, and the top-level block holding it
 * replaced by a source block with that text.
 *
 * The block is serialized by rule, as any edited block is, with stand-ins where
 * the markers go; the stand-ins are then replaced by the markers, so they are
 * written unescaped. The source block keeps the block's `gap`, and the
 * transaction carries `PRESERVE_SOURCE_META`, so the blank lines around it stay
 * as they were. It is one history event: undo returns the block as it was.
 *
 * The page then sends the text with `reparse`, and the host posts its own
 * parse — the block rendered as the preview renders it (see `main.ts`).
 * Returns `null` where the action cannot act (`canWrapSource`), or where the
 * document already holds a stand-in character.
 */
export function wrapSourceTransaction(state: EditorState, apply: Extract<ActionApply, { kind: 'wrap-source' }>, context: SourceContext): Transaction | null {
    if (!canWrapSource(state)) {
        return null;
    }
    const value = apply.close.includes(FOOTNOTE_LABEL) || apply.open.includes(FOOTNOTE_LABEL)
        ? freeFootnoteLabel(context.documentText) : '';
    const open = label(apply.open, value);
    const close = label(apply.close, value);
    const sel = state.selection;
    const index = sel.$from.index(0);
    const topPos = sel.$from.before(1);
    const top = state.doc.child(index);

    // A marker cannot close after a space (`==word ==` is no highlight), and a
    // double click selects the word with the space after it: the markers go
    // around the text without the spaces at its ends.
    let { from, to } = sel;
    if (!sel.empty) {
        const selected = state.doc.textBetween(from, to, undefined, '￼');
        const lead = selected.length - selected.trimStart().length;
        const trail = selected.length - selected.trimEnd().length;
        if (lead + trail < selected.length) {
            from += lead;
            to -= trail;
        }
    }

    const openRun = OPEN_STAND_IN.repeat(open.length);
    const closeRun = CLOSE_STAND_IN.repeat(close.length);
    const marks = sharedMarks(state);
    const scratch = state.tr;
    if (from === to) {
        scratch.insert(from, editorSchema.text(openRun + apply.placeholder + closeRun, marks));
    } else {
        if (closeRun) {
            scratch.insert(to, editorSchema.text(closeRun, marks));
        }
        if (openRun) {
            scratch.insert(from, editorSchema.text(openRun, marks));
        }
    }
    const block = asSourceBlock(scratch.doc.child(index), [[openRun, open], [closeRun, close]], context, top.attrs.gap ?? null);
    if (block === null) {
        return null;
    }
    const tr = state.tr.replaceWith(topPos, topPos + top.nodeSize, block);
    if (apply.definition !== undefined) {
        tr.insert(topPos + block.nodeSize, nodes.raw_block.create({ src: sourceText(label(apply.definition, value), context.eol), gap: null, html: '' }));
    }
    tr.setSelection(NodeSelection.create(tr.doc, topPos));
    return tr.setMeta(PRESERVE_SOURCE_META, true).scrollIntoView();
}

/**
 * The transaction that writes `literal` in place of the inline range
 * `from`–`to` as literal source — a note's **Edit source** in the object
 * toolbar. The top-level block holding the range is replaced by a source block
 * whose text is the block serialized by rule with `literal` where the range was,
 * unescaped: the range's place is held by a stand-in run of the literal's
 * length, carrying `marks` (those the replaced node carried), so the marks
 * around it are written around the literal and the wrapper measures the line
 * as it will be. As for `wrap-source`, the block keeps its `gap`, the
 * transaction carries `PRESERVE_SOURCE_META` and is one history event, and the
 * page then sends `edit` with `reparse`: the host's parser decides what the text
 * now is. `null` when the range is not inside one textblock, the literal is
 * empty, or the document already holds a stand-in character.
 */
export function inlineSourceTransaction(
    state: EditorState, from: number, to: number, literal: string, marks: readonly Mark[], context: SourceContext,
): Transaction | null {
    const $from = state.doc.resolve(from);
    if (literal === '' || $from.depth < 1 || !$from.parent.inlineContent || !$from.sameParent(state.doc.resolve(to))) {
        return null;
    }
    const index = $from.index(0);
    const topPos = $from.before(1);
    const top = state.doc.child(index);
    const run = OPEN_STAND_IN.repeat(literal.length);
    const scratch = state.tr.replaceWith(from, to, editorSchema.text(run, marks));
    const block = asSourceBlock(scratch.doc.child(index), [[run, literal]], context, top.attrs.gap ?? null);
    if (block === null) {
        return null;
    }
    const tr = state.tr.replaceWith(topPos, topPos + top.nodeSize, block);
    tr.setSelection(NodeSelection.create(tr.doc, topPos));
    return tr.setMeta(PRESERVE_SOURCE_META, true).scrollIntoView();
}

/**
 * The transaction an `insert-source` action makes: a new source block holding
 * the template after the block the selection is in, selected. The page then
 * opens its **Edit source** box and asks the host to render it.
 */
export function insertSourceTransaction(state: EditorState, template: string, context: SourceContext): { tr: Transaction; pos: number; src: string } {
    const pos = insertionPoint(state);
    const src = sourceText(label(template, freeFootnoteLabel(context.documentText)), context.eol);
    const tr = state.tr.insert(pos, nodes.raw_block.create({ src, gap: null, html: '' }));
    tr.setSelection(NodeSelection.create(tr.doc, pos));
    return { tr: tr.scrollIntoView(), pos, src };
}
