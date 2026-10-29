/**
 * The object toolbar: every object in the document (`objects.ts`) carries its
 * verbs visibly, and every object does it the same way — a small floating bar,
 * a label naming the object on its left, then the verbs. Daniel's rule of
 * 2026-09-25, after removing a note had been knowledge in the head (two
 * Backspaces at one spot) while a source block showed its verbs on hover and a
 * note or a link showed nothing.
 *
 * **The triggers.** A block object (a source block, injected content, the front
 * matter) shows its bar while the pointer is on it or it is selected. A caret
 * object (a note, a link, a span, an image, a badge, a container, an admonition,
 * a code block at any depth, a block with attributes) shows its bar once the caret or the
 * selection has rested inside it for `INLINE_DELAY_MS`, and hides it the moment
 * the caret leaves; the pointer does not show it — an inline bar following the
 * pointer across a paragraph jumps. Two bars exist so the two triggers never
 * fight: one follows the selection, one the pointer — and only one floating
 * layer shows at a time (`LayerSlot`, `placement.ts`): the caret's bar wins,
 * the pointer's shows only while the slot is empty (the block under the
 * pointer gets the hover cue meanwhile), a non-empty selection has the bubble
 * instead. Typing hides the caret's bar until the next rest; `Esc` — in the
 * bar, its field, or the text while the bar shows — hides it until the caret
 * leaves the object. `Alt+Enter` opens the bar of the object at the caret at
 * once, whatever holds the slot, the focus on the first verb
 * that opens something in place and changes nothing yet (`firstFocus`,
 * `verbs.ts`) — never Open, never Remove or Delete — else on the bar itself,
 * where `Enter` or `↓` moves into its verbs; the arrow keys move, `Enter`
 * chooses, `Esc` returns to the text. With nothing to act on, `Alt+Enter` is
 * taken all the same and says so in a neutral hint, the caret staying
 * (`NO_TARGET_HINT`).
 *
 * **Where it sits.** Where the one placement policy puts every layer
 * (`placement.ts`): below its object — an inline object's last line, a
 * block's box — at the object's start, else above it; never on the caret's
 * line, under the formatting row or over another layer; text breaks a tie.
 * A field a verb opens stands at what it edits. It is `position: absolute`
 * inside the editor's mount, as the bubble is, so it scrolls with the text.
 *
 * **One model for every bar** (`verbs.ts`): each verb has a slot, and the
 * slots stand in one order — Open · Edit… · type verbs · Attributes… · Edit
 * source · other extensions' actions · divider · Remove/Delete. **Remove
 * keeps, Delete destroys**, and a Remove says what stays ("Remove link, keep
 * text"); a verb whose result is a disappearance announces it in the caret
 * hint, one pattern for all ("Note deleted — Ctrl+Z", `undoHint`): otherwise
 * nothing visible happens but something going. In a narrow editor a verb
 * drops the noun its bar's title names before the title truncates (`fit`).
 *
 * Buttons act on `mousedown` + `preventDefault`, as the formatting toolbar's
 * do, so the editor keeps its focus and its selection.
 */
import { EditorState, Plugin, PluginKey, PluginView, TextSelection, Transaction } from 'prosemirror-state';
import { CellSelection, isInTable, selectedRect } from 'prosemirror-tables';
import { Mapping } from 'prosemirror-transform';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { ADMONITION_TYPES, plainWikiEmbed } from '../../syntax/markers';
import { containerClass } from '../schema';
import type { Completion } from '../completions';
import { DEFAULT_FENCE, FENCED_DONE, INDENTED_PLACEHOLDER, languageCompleter, languageOf, savedOpeningLine } from '../fences';
import { editRawSourceAt } from './nodeViews';
import { typesText } from '../keys';
import { HintTone, RefusalPlace, announceHint, applyKey, dismissRefusal, macKeys, showChangeHint, showHint, showRefusal, undoHint, undoKey } from './hint';
import { EMBED_WAY_BACK, FILE_STAYS, NO_TARGET_HINT, Slot, Slotted, VERB, arrange, barDescription, barName, crumbName, crumbPartName, emojiWayBack, firstFocus, overflowOrder, quotedVerb, wording } from '../verbs';
import { FieldStep, InlineChoice, InlineField, fieldHeading, refusedStep } from './inlineField';
import { FieldRow } from './fieldRow';
import { NOTE_LABELS, NoteNodeName, noteRefusal, unwrapNote, unwrapNoteRefusal } from './notes';
import {
    backToReferenceTransaction, deleteFootnoteEntryTransaction, deleteFootnoteRefTransaction, editInlineFootnote, entryAt, footnoteIndexOf, goToFootnoteTransaction,
    dispatchWithHint, entryDeleteRefusal, labelRefusal, orphanChip, refAt, renameFootnoteTransaction, sortFootnotesTransaction, sortRefusal,
} from './footnotes';
import { embedAsTextTransaction } from './wikiEmbeds';
import { emojiAsTextTransaction, emojiTextStillRead, selectEmojiBeside } from './emoji';
import { clearPendingRange, pendingRangeId, showPendingRange } from './pendingRange';
import { FocusPlace, focusPlace } from './focusPlace';
import { refocusingAfterComposition } from './sourceBlock';
import {
    BLOCK_NAMES, EditorObject, NOTE_CONVERSION, NO_BLOCK_ATTRS_REFUSAL, NodeObjectKind, attributesTargetOf, literalOf, changeAdmonitionTransaction, changeContainerTransaction,
    changeLinkTransaction, changeSpanRefusal, changeSpanTransaction, editImageTransaction, containerNameOf, convertNoteRefusal, convertNoteTransaction, currentObject,
    deleteObjectRefusal, deleteObjectTransaction, isBlockObject, isBlockPlaced, isTopLevelBlock, noteSource, objectAtSelection, objectOfNode, removeLinkRefusal,
    removeLinkTransaction, removeSpanRefusal, removeSpanTransaction, sameObject, unwrapTransaction, changeLanguageTransaction, commitOpeningLine, CodeBlockObject,
    changeInlineLiteralRefusal, changeInlineLiteralTransaction, holderNames, inlineHolderOf, isMarkObject, LiteralObject, literalObjectOf, literalOfObject, attributeHolderAt, holderInside,
    AttributesTarget, CrumbPart, Crumbs, Followed, attributesTargetAt, blockAttrsRefusal, commitAttributes, constructExplanation, crumbsAt, followAll,
    noteFieldRange,
} from './objects';
import { attributesField, attributesRemovedHint, attributesStep, goneFieldHint, holderAttributesStep } from './attributes';
import { attributesTip, attributesTyped } from '../attributeLiteral';
import { currentReadsAttrs } from '../inlineEngine';
import { NO_INCLUDES_REFUSAL, titleOf } from './toolbar/actions';
import { barSeparator, followPointer, selectionWantsBubble, separator } from './toolbar/toolbar';
import { buildMoreEntry, fitWithMore, holdFocus, moreControl, moreName, overflows } from './overflow';
import { SourceContext, inlineSourceTransaction } from './toolbar/commands';
import {
    addColumnTransaction, addRowTransaction, alignColumnTransaction, columnAlign, deleteColumnRefusal, deleteColumnTransaction, deleteRowRefusal,
    deleteRowTransaction, tableRefusal, tableSourceTransaction,
} from './tables';
import { TableAlign } from '../schema';
import type { CodeActionItem, LensItem, LinkChoice } from '../protocol';
import { chevronNode, lensLabelNodes, lensName } from './lenses';
import { Said, Tip, plainTip, said, saidText, tipText, value } from '../tips';
import { Tooltips } from './tooltip';
import { HideReason, LayerClaim, LayerSlot, REST_MS, anchorOf, blockAnchor, blockFieldAnchor, caretRect, floatedAround, placeMenu, rangeAnchor, revealField } from './placement';

/**
 * The opening line the save writes for a code block (`savedOpeningLine`), once
 * per node: the bar reads it on every redraw — Edit source's prefill is in its
 * signature — and composing it scans the block's whole text for a closing run.
 */
const openingLines = new WeakMap<CodeBlockObject['node'], string>();

function openingLineOfBlock(node: CodeBlockObject['node']): string {
    let line = openingLines.get(node);
    if (line === undefined) {
        line = savedOpeningLine(node);
        openingLines.set(node, line);
    }
    return line;
}

/** What the verbs need from the page. */
export interface ObjectToolbarHost {
    /** Open the text editor beside, at the line the top-level node at `pos` starts on. */
    openSourceAt(pos: number): void;
    openSnippet(path: string): void;
    /** Follow a link, as a Ctrl/Cmd+click does. */
    openLink(href: string): void;
    sourceContext(): SourceContext;
    /** Send the document now and ask the host to parse it again (`edit.reparse`). */
    flushReparse(): void;
    /** Ask the host to render a new source block's text (`render`), as the toolbar's source actions do. */
    requestRender(src: string): void;
    /**
     * The code actions other extensions offer for the top-level block at `pos`,
     * as far as the page knows them: asked of the host the first time, the bar
     * redrawn when the answer arrives (`main.ts`).
     */
    codeActionsAt(pos: number): readonly CodeActionItem[];
    runCodeAction(id: string): void;
    /**
     * The lenses other extensions put on the top-level block at `pos` as its
     * verbs (`lensVerbsAt`): a heading's `action` lenses, and the lenses whose
     * element the page does not show.
     */
    lensesAt(pos: number): readonly LensItem[];
    runLens(id: string): void;
    /** Whether any extension offers includes for this document (the `document` message's `includes`). */
    includesOffered(): boolean;
    /** Ask the host for an include line to replace the directive of the expansion at `pos` with (`main.ts`). */
    pickInclude(pos: number): void;
    /** What a link's (with `images`, an image's) path may complete to: the host's answer to `linkChoices`. */
    linkChoices(query: string, images: boolean): Promise<LinkChoice[]>;
}

/**
 * How many lens verbs a bar shows in a line. With more, the first ones stay
 * and the rest go behind **Actions** (a choice, with the dropdown chevron), so the bar keeps to this many slots:
 * a requirement heading can carry eight lenses, and a bar as wide as the page
 * is a row again.
 */
export const LENS_VERBS_INLINE = 4;

/**
 * The objects whose range stays drawn while their field is open: the inline
 * ones, whose text the field is about. A block's field (a container's name, an
 * admonition's title) names its block by the bar beside it.
 */
const PENDING_OBJECTS: ReadonlySet<string> = new Set(['link', 'span', 'styled', 'holder', 'note', 'image']);

/** How long the caret rests in an inline object before its toolbar shows: the one rest (`placement.ts`). */
export const INLINE_DELAY_MS = REST_MS;

/** How long the pointer may be off a block and its bar before the bar goes: time to cross the gap between them. */
const HOVER_GRACE_MS = 300;

/** Narrower than this, a cut title says nothing: `fit` hides it (the bar's `aria-label` still names the object). */
const TITLE_STUB = 42;

/** What a two-part bar leaves of the window's width, at most (#8 review 1): 16 px each side, as the overlay's hints. */
const BAR_WINDOW_GUTTER = 32;

/** What `reopenVia` holds for "…"'s own list, which no verb id is. */
const MORE_LIST = '…';

/** One verb as the bar draws it. */
export interface Verb {
    /** `data-verb`: what tests and stylesheets name it by. */
    id: string;
    /** As its owner titled it: `$(icon)` references are drawn as icons, and `lensLabel` gives the plain text. */
    label: string;
    /** The label without the noun the bar's title already names (`Delete`, `Edit…`), drawn when the bar is too narrow for its title (`ObjectBar.fit`). */
    short?: string;
    title: string;
    /** `title` with a piece in the code font (a fence's ```), where the hover should draw it: the same words (`tipText(tip) === title`). */
    tip?: Tip;
    /** Where it stands on the bar (`verbs.ts`): its order, its divider, whether `Alt+Enter` may focus it. */
    slot: Slot;
    /** A `run` verb that opens a source box in place (a source block's, a table's Edit source): it opens in place, as a field does. */
    box?: true;
    /** Why it cannot be chosen here, shown in its tooltip and, pressed, at it (#10); `null` when it can. */
    refusal?: Said | null;
    /** A verb that runs at once. */
    run?(): void;
    /** A verb that asks for a value first, in the inline field — and, when its commit names another step, for that one next. */
    field?: FieldStep;
    /** A verb that asks for one of a list of values, in the inline choice. */
    choice?: { value: string; label: string; options: readonly { value: string; label: string }[]; commit(value: string): void };
    /**
     * A set-verb: a menu of related actions that opens under it on a click,
     * `Enter` or `Space` — a table's Row, Column and Align, each with the dropdown chevron (`chevronNode`) — drawn
     * with the formatting toolbar's menu chrome (`.mep-menu`), navigated with
     * the arrow keys, `Enter` choosing and `Esc` closing it.
     */
    menu?: readonly MenuEntry[];
    /** Drawn after a separator: set by `arrange` (`verbs.ts`) — before other extensions' verbs, before the destroying verb — or by a presentation for a group of its own (a table's Attributes…). */
    separated?: boolean;
    /** What its field edits, when it is not the bar's object: the element inside it (`withInlineAttributes`), drawn while the field is open. */
    target?: { from: number; to: number };
    /**
     * The block its field edits, when the field stands at that block and not at the bar's object (#8): a
     * breadcrumb part's List above the list, an admonition's heading above the heading (`blockFieldAnchor`).
     */
    anchorBlock?: AttributesTarget;
    /** On a two-part bar, it acts on the outer part (an admonition's Type▾): never the first focus (`firstFocus`, #8). */
    outer?: true;
    /** One of a reversible jump pair (a footnote's Go to footnote text / Back to reference): it may take the first focus (`firstFocus`, #5b). */
    jump?: true;
    /** What a table's set-verb acts on, tinted while it is active (`ObjectBar.activeAxis`): Row the caret's row, Column and Align its column. */
    axis?: 'row' | 'column';
}

/** A verb's button drawn with `text` — its label or its short form — and, where it opens a list, the workbench's dropdown chevron, as the formatting row's menus carry. */
function drawVerbLabel(el: HTMLElement, verb: Verb, text: string): void {
    el.replaceChildren(...lensLabelNodes(text));
    if (verb.menu || verb.choice) {
        el.append(chevronNode());
    }
}

/** A verb as the bars' model reads it (`verbs.ts`): whether it opens in place is read from which of its ways it has. */
function slotted(verb: Verb): Slotted {
    return {
        slot: verb.slot, refusal: verb.refusal, separated: verb.separated, opensInPlace: Boolean(verb.field || verb.choice || verb.menu || verb.box),
        ...(verb.outer ? { outer: true as const } : {}),
        ...(verb.jump ? { jump: true as const } : {}),
    };
}

/** One entry of a set-verb's menu. */
interface MenuEntry {
    /** `data-entry`: what tests name it by. */
    id: string;
    label: string;
    title: string;
    /** The keyboard route to the same thing, shown at the entry's right (`Tab at end`); or what stays (`formatting stays`, #8). */
    keys?: string;
    /** A literal after the label, in the code font, muted (`Bold {.term}`, #8). */
    code?: string;
    /** For a choice of one value out of several: whether this is the current one, marked. */
    checked?: boolean;
    /** Why it cannot be chosen here, in its tooltip and, pressed, beside it (#10); the entry is drawn disabled. */
    refusal?: Said | null;
    /** Drawn after a divider: in a bar's "…", the verb that destroys, last. */
    separated?: boolean;
    /** It opens a menu of its own (a set-verb moved into "…"): drawn with the chevron right. */
    opens?: boolean;
    run(): void;
}

/**
 * A part of the breadcrumb as the bar draws it (#8): a control that opens its
 * field — or says why it cannot — or, for an admonition or a container, which
 * keep no literal here, a title.
 */
interface CrumbView {
    role: 'current' | 'outer';
    name: string;
    /** A title part's short form, taken before anything is cut (`Warning`). */
    short?: string;
    literal: string | null;
    /** What pressing it chooses — its field, or its refusal (#10, at the part); `null` for a title part. */
    verb: Verb | null;
    /** Where its field opens, as its tooltip says: `under the list`, `at the bold text`. */
    opens: string;
}

interface Presentation {
    label: string;
    /** The title's short form, drawn before the title truncates (`ObjectBar.fit`): an admonition's type alone, `Warning`. */
    short?: string;
    /**
     * A last step after `short`, the code part and what follows it gone with it: a footnote's number alone ("1").
     * A title with it steps "Footnote 1 · liebst" → "Footnote 1" → "1" → hidden, never cut (UX review 2).
     */
    tiny?: string;
    /** Written after the label in the editor's code font: an atom's spelling (`Emoji :)`). */
    code?: string;
    /** Written after `code`, in the label's font: what a footnote's title says of it (` · 2 references`). */
    after?: string;
    title: string;
    verbs: Verb[];
    /** The breadcrumb in the title's place (#8): the outer part, then the current one — the bar's object. */
    crumbs?: { outer: CrumbView; current: CrumbView };
    /** The bar's accessible name where it is not its title's (`List item .lead in List .steps`). */
    name?: string;
    /**
     * No bar on a caret rest (F6): a breadcrumb whose parts are both bare — every list item of a list
     * without literals — `Alt+Enter` draws it. Decided before other extensions' actions join the verbs.
     */
    restless?: boolean;
    /**
     * Where the bar stands when not at its object (#8 review 1): the current part's block — the heading of an
     * admonition or a container whose bar it is — so the bar is at the heading's line, not under the whole box.
     */
    anchorFrom?: number;
}

/**
 * An object whose bar would be its label alone, and so is not drawn: a
 * requirement heading (its verbs are other extensions' lenses and actions; any
 * other heading has **Attributes…**) and the front matter
 * (its own verbs are the properties panel's header), with none offered.
 */
function barless(object: EditorObject, presentation: Presentation): boolean {
    // A breadcrumb's bar is drawn on a rest where a part carries a literal (#8, F6).
    if (presentation.crumbs !== undefined) {
        return presentation.restless === true;
    }
    // Attributes of Bold… for the bold the caret is in is no reason for a bar on a caret
    // rest (`withInlineAttributes`): `Alt+Enter` draws it there (`ObjectToolbarView.forced`).
    const verbs = presentation.verbs.filter(v => v.id !== 'inline-attributes');
    if (verbs.length === 0) {
        return object.kind === 'heading' || object.kind === 'front_matter';
    }
    // A bar whose one verb is Attributes…, on a block with no literal yet — every plain
    // heading — is chrome on every such block; the menu reaches it, and the verb joins
    // the bar once the block has others (lenses, code actions) or a literal.
    return 'node' in object && literalOf(object.node) === null && verbs.every(v => v.id === 'block-attributes');
}

/** What stays when an inline part's literal is removed (#8 Remove▾'s right column): the element, or a span's text. */
const STAYS: Readonly<Record<string, string>> = {
    styled: 'formatting stays',
    holder: 'formatting stays',
    span: 'text stays',
    link: 'link stays',
    image: 'image stays',
};

/** What stays when a note's or a sidebar's literal is removed: the element, named (`marginal note stays`). */
function staysOf(target: CrumbPart['target']): string | undefined {
    if (target === null || !('object' in target)) {
        return undefined;
    }
    return target.object.kind === 'note' ? `${holderNames(target).noun} stays` : STAYS[target.object.kind];
}

/**
 * Whether `crumbs` are `object`'s bar's (#8): its current part is `object` —
 * the inline element, the list item, the heading at its place — or `object` is
 * the admonition or the container whose title part stands outer.
 */
function crumbsFor(object: EditorObject, crumbs: Crumbs): boolean {
    const target = crumbs.current.target;
    if (isMarkObject(object) || object.kind === 'image' || object.kind === 'note') {
        return target !== null && 'object' in target && sameObject(target.object, object);
    }
    if (object.kind === 'admonition' || object.kind === 'container') {
        const outer = crumbs.outer;
        return outer !== null && outer.target === null && outer.refusal === null && outer.from === object.from;
    }
    // By place, not by target: a refused current part (an item starting with a heading, a new empty one) has none, and keeps its crumbs (#8 review 1).
    return crumbs.current.anchor !== 'run' && crumbs.current.from === object.from;
}

const CONVERT_LABELS: Readonly<Record<NoteNodeName, string>> = {
    sidenote: 'Convert to marginal note',
    marginal_note: 'Convert to sidenote',
    left_sidebar: 'Move to right',
    right_sidebar: 'Move to left',
};


/**
 * What the bars draw into the document, set by the bars' view as they show
 * and go (`ObjectToolbarView.syncDecorations`) and drawn by the plugin's
 * decorations: `tint`, the table whose caret row or column is tinted, by its
 * position, and which — only while the bar's Row, or its Column or Align, is
 * open, focused or hovered (`ObjectBar.activeVerb`): at rest the caret's cell
 * carries a ring (`tables.ts`), and a tint the whole time the bar showed read
 * as styling. A bar never draws layout into the document: it floats, so
 * showing it moves nothing.
 */
interface BarDecor {
    tint: { table: number; axis: 'row' | 'column' } | null;
}

const NO_DECOR: BarDecor = { tint: null };

const decorKey = new PluginKey<BarDecor>('mep-object-toolbar-decor');

/**
 * The caret's rows or columns of the table `tint` names, as node decorations
 * on their cells (`mep-table-row`, `mep-table-column`); none when the
 * selection is not in it.
 */
function axisTint(state: EditorState, tint: BarDecor['tint']): Decoration[] {
    const table = tint === null ? null : state.doc.nodeAt(tint.table);
    if (tint === null || !table || table.type.name !== 'table' || !(isInTable(state) || state.selection instanceof CellSelection)) {
        return [];
    }
    const rect = selectedRect(state);
    if (rect.tableStart !== tint.table + 1) {
        return [];
    }
    const rows = tint.axis === 'row' ? [rect.top, rect.bottom] : [0, rect.map.height];
    const cols = tint.axis === 'row' ? [0, rect.map.width] : [rect.left, rect.right];
    const decorations: Decoration[] = [];
    for (let row = rows[0]; row < rows[1]; row++) {
        for (let col = cols[0]; col < cols[1]; col++) {
            const pos = rect.tableStart + rect.map.map[row * rect.map.width + col];
            const cell = state.doc.nodeAt(pos);
            if (cell) {
                decorations.push(Decoration.node(pos, pos + cell.nodeSize, { class: tint.axis === 'row' ? 'mep-table-row' : 'mep-table-column' }));
            }
        }
    }
    return decorations;
}

function barDecorations(state: EditorState, decor: BarDecor): DecorationSet {
    const decorations = axisTint(state, decor.tint);
    return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(state.doc, decorations);
}

function sameDecor(a: BarDecor, b: BarDecor): boolean {
    return a.tint === b.tint || (a.tint !== null && b.tint !== null && a.tint.table === b.tint.table && a.tint.axis === b.tint.axis);
}

/**
 * What a source block's bar calls it: "Source · <why>" (`construct`, the
 * classifier's reason in words: `has a footnote`, `definition list` …), or a
 * source block when no word says more. A pipe table the editor leaves as source
 * (only a top-level one: a table inside a quote or a list is `has a table`) says
 * the kind of table, so the bar says why this table has no Row and Column menus
 * when the one above it has them.
 */
export function rawBlockLabel(construct: string | null, src = ''): { label: string; title: string } {
    // An attribute literal the editor cannot keep where it stands: what it does, and where it would (#8 F12, `sourceExplanation`).
    const explained = constructExplanation(construct, src);
    if (explained !== null && construct !== null) {
        return { label: `Source · ${construct}`, title: saidText(explained) };
    }
    switch (construct) {
        case 'multimd table':
            return {
                label: 'Source · multimd table',
                title: 'A table using markdown-it-multimd-table\'s extensions — a span, a caption, a multi-line row, no header or a second body — shown as the preview renders it, edited as Markdown.',
            };
        case 'table':
            return {
                label: 'Source · table',
                title: 'A pipe table holding what a cell cannot hold here — a note, code with a |, HTML, a row of another width — shown as the preview renders it, edited as Markdown.',
            };
        case null:
            return { label: 'Source block', title: 'Shown as the preview renders it, edited as Markdown.' };
        default:
            return { label: `Source · ${construct}`, title: `${construct[0].toUpperCase()}${construct.slice(1)}, which the editor does not edit as text — shown as the preview renders it, edited as Markdown.` };
    }
}

function isSidebar(name: NoteNodeName): boolean {
    return name === 'left_sidebar' || name === 'right_sidebar';
}

/** Why a container's Classes field refuses a value ending in `{…}` (#10 C24): in the field, which stays open. */
export const CONTAINER_TITLE_REFUSAL: Said = said`Not set: a container's title can't end in ${value('{…}')} — it would be read as attributes. Remove the ${value('{…}')} at its end.`;

/**
 * A verb's refusal builds the whole transaction it would dispatch and asks the
 * filters' own check of it (`noteRefusal`, `tableRefusal`), and a bar is
 * presented on every refresh and hover: each is read once per state, by the
 * verb and the object's place (`key`), not once per presentation.
 */
const refusals = new WeakMap<EditorState, Map<string, Said | null>>();

/** The refusal `read` gives in `state`, remembered under `key` (`refusals`). */
function refusalOnce(state: EditorState, key: string, read: () => Said | null): Said | null {
    let byKey = refusals.get(state);
    if (byKey === undefined) {
        byKey = new Map();
        refusals.set(state, byKey);
    }
    if (!byKey.has(key)) {
        byKey.set(key, read());
    }
    return byKey.get(key) ?? null;
}

/**
 * Why the plugins' filters (the notes' and the tables') would refuse `tr` — asked
 * of the transaction before it is dispatched, so a verb shows the reason as a
 * disabled button instead of making the filter say it after the click — or `null`.
 * No transaction is no atom to act on: `none` says so.
 */
function filterRefusal(tr: Transaction | null, none: string): Said | null {
    return tr === null ? none : noteRefusal(tr) ?? tableRefusal(tr);
}

/** What the verbs of an atom do: the bar gives them, the verbs only say which — and what the undo hint says they did (`done`). */
export interface EmbedActions {
    asText(done: string): void;
    remove(done: string): void;
}

/** What sets an atom's two verbs apart (`atomVerbs`): the atom's noun and spelling, and Convert to text's transaction and refusal. */
interface AtomVerbTexts {
    /** What the verbs call it (`emoji`, `embed`), as `wording` builds their labels and hints from it; the ids follow. */
    noun: string;
    /** As the file spells it: Convert to text's tooltip names the text it becomes. */
    spelling: string;
    /** Convert to text's way back, one sentence after the text it becomes, with the punctuation that joins it (`; …`, `: …`). */
    wayBack: string;
    /** Delete's tooltip, where it says more than the label. */
    removeTitle?: string;
    /** Why neither can be chosen where there is no such atom. */
    none: string;
    /** The atom as text, or `null` where `[from, to)` is no such atom. */
    asTextTransaction(state: EditorState, from: number, to: number): Transaction | null;
    /** Why Convert to text is refused besides the filters, if it is: `tr` makes the atom at `from` text. */
    asTextRefusal?(state: EditorState, tr: Transaction, from: number): string | null;
}

/**
 * The verbs of an atom `object` — a wiki embed, an emoji: Convert to text and
 * Delete, each with the reason it cannot be chosen in `state`, if there is
 * one. Refused as the notes' and the tables' filters would refuse it: the text
 * takes the atom's marks, and an attribute span over it that holds a note
 * marker (or `|` in a cell) is allowed over an atom and not over text.
 */
function atomVerbs(state: EditorState, object: EditorObject, actions: EmbedActions, texts: AtomVerbTexts): Verb[] {
    const place = `${object.from}:${object.to}`;
    const asText = wording({ verb: 'Convert to text', noun: texts.noun });
    const remove = wording({ verb: 'Delete', noun: texts.noun });
    const asTextId = `convert-${texts.noun}-to-text`;
    const removeId = `delete-${texts.noun}`;
    return [
        {
            id: asTextId,
            label: asText.label,
            title: `${asText.label} ("${texts.spelling}")${texts.wayBack}`,
            slot: 'type',
            refusal: refusalOnce(state, `${asTextId}@${place}`, () => {
                const tr = texts.asTextTransaction(state, object.from, object.to);
                // The atom's own reason first: it names why its text would read otherwise, which the filters only find.
                return tr === null ? texts.none : texts.asTextRefusal?.(state, tr, object.from) ?? filterRefusal(tr, texts.none);
            }),
            run: () => actions.asText(asText.done),
        },
        {
            id: removeId,
            label: remove.label,
            short: remove.short,
            title: texts.removeTitle ?? `The ${texts.noun} goes from the text.`,
            slot: 'destroy',
            refusal: refusalOnce(state, `${removeId}@${place}`, () => filterRefusal(deleteObjectTransaction(state, object), texts.none)),
            run: () => actions.remove(remove.done),
        },
    ];
}

/** The verbs of the wiki embed `object`, each with the reason it cannot be chosen in `state`, if there is one. */
export function wikiEmbedVerbs(state: EditorState, object: EditorObject, actions: EmbedActions): Verb[] {
    return atomVerbs(state, object, actions, {
        noun: 'embed',
        // The text it becomes, as Convert to text inserts it (`embedAsTextTransaction`), not the source's encoding.
        spelling: object.kind === 'wiki_embed' ? plainWikiEmbed(object.node.attrs.source as string) : '',
        // It reads as the way back: the sentence names the result first.
        wayBack: `; ${EMBED_WAY_BACK}`,
        removeTitle: FILE_STAYS,
        none: 'There is no embed here.',
        asTextTransaction: embedAsTextTransaction,
    });
}

/**
 * The verbs of the emoji atom `object`, each with the reason it cannot be
 * chosen in `state`, if there is one: as an embed's, and Convert to text where
 * its characters would still read as an emoji (`emojiTextStillRead`).
 */
export function emojiVerbs(state: EditorState, object: EditorObject, actions: EmbedActions): Verb[] {
    return atomVerbs(state, object, actions, {
        noun: 'emoji',
        spelling: object.kind === 'emoji' ? object.node.attrs.source as string : '',
        none: 'There is no emoji here.',
        asTextTransaction: emojiAsTextTransaction,
        asTextRefusal: emojiTextStillRead,
        wayBack: `: ${emojiWayBack(undoKey())}`,
    });
}

/** What a bar tells the view about its field. */
interface BarEvents {
    escape(): void;
    /**
     * A field opened for `object`, editing `target` within it when given: what it acts on is drawn (`pendingRange.ts`);
     * or editing the block `block`, where it stands (#8: a breadcrumb's outer part, an admonition's heading).
     */
    fieldOpened(object: EditorObject, target?: { from: number; to: number }, block?: AttributesTarget): void;
    fieldClosed(committed: boolean): void;
    /** The open field's row changed size (its keys line, a refusal cleared): the slot places it again. */
    fieldResized(): void;
    /** The bar went with its field open: the view hides it from inside an update, so the drawing goes after it. */
    fieldDropped(): void;
    /** A verb's menu opened or closed, or its button took or lost the focus or the pointer: what it drives (a table's row or column tint) is drawn anew (`activeVerb`). */
    verbActive(): void;
    /** A refused verb or entry was pressed: why, at it (#10). */
    refuse(message: Said, place: RefusalPlace): void;
    /** A menu closed: a refusal said at one of its entries goes with it. */
    menuClosed(panel: HTMLElement): void;
}

/** One bar: a label and verbs, or a label and the inline field. */
class ObjectBar {
    readonly el: HTMLElement;
    object: EditorObject | null = null;
    /** Where the bar stands when not at its object (`Presentation.anchorFrom`): the current part's block. */
    anchorFrom: number | null = null;
    private field: InlineField | InlineChoice | null = null;
    /** What draws the field's row while it is open (`fieldRow.ts`). */
    private row: FieldRow | null = null;
    private signature = '';
    /** What the last `fit` was for — the room and the signature — so a scroll frame that changed neither measures nothing (`refit` forgets it). */
    private fitted = '';
    /** The object's name as the title shows it (`Emoji :rocket:`): the bar's accessible name while a field stands in for its verbs. */
    private name = '';
    private buttons: { verb: Verb; el: HTMLButtonElement }[] = [];
    /** The breadcrumb's parts (#8), outer then current, as drawn: a part's button, or a title part's span. */
    private parts: { view: CrumbView; el: HTMLElement }[] = [];
    /** The outer part moved into "…" by `fitCrumbs` (#8, step 3 of the ladder): its entry is first there. */
    private outerMoved = false;
    /** What the open field edits by its place (`FieldStep.followed`): followed through the document's changes while it is open (#8 F7). */
    private following: readonly object[] = [];
    /** "…" (`moreControl`), last on the bar: the verbs `fit` moved into it, in the order they left. */
    private more: HTMLButtonElement | null = null;
    private moved: { verb: Verb; el: HTMLButtonElement }[] = [];
    /** The title, and its short form, as the presentation gave them. */
    private title = { label: '', short: undefined as string | undefined, tiny: undefined as string | undefined };
    /** The title's nodes as `render` drew them (its code part, what follows it): a title with a `tiny` step puts them back on each fit. */
    private titleNodes: globalThis.Node[] = [];
    /**
     * An open menu: its panel, the button it hangs from — the verb's, or "…" for a verb moved into it — its
     * entries, and where it comes from: the set-verb whose menu it is (none for "…"'s own list), and
     * whether it was opened through "…" (`viaMore`: its entries have no hover).
     */
    private menu: { panel: HTMLElement; button: HTMLButtonElement; entries: { entry: MenuEntry; el: HTMLElement }[]; verb?: string; viaMore: boolean } | null = null;
    /** The verb under the pointer, by id (`activeVerb`). */
    private hovered: string | null = null;
    /** The entry of the "…" list under the pointer, by the id of the verb it stands for (`activeVerb`). */
    private hoveredEntry: string | null = null;
    /**
     * A menu that was open through "…" when the bar was drawn again: a set-verb's, by its id, or "…"'s own list
     * (`MORE_LIST`): `fit` opens it where its verb stands now, or where "…" still is.
     */
    private reopenVia: string | null = null;
    /** The entry of "…"'s own list the focus was on when it was drawn again (`reopenVia` `MORE_LIST`): the reopened list puts the focus on it where it still stands. */
    private reopenEntry: string | null = null;

    constructor(trigger: 'selection' | 'hover', private readonly events: BarEvents, private readonly tips: Tooltips) {
        this.el = document.createElement('div');
        this.el.className = 'mep-object-toolbar mep-layer';
        this.el.dataset.trigger = trigger;
        this.el.setAttribute('role', 'toolbar');
        this.el.tabIndex = -1;
        this.el.hidden = true;
        this.el.addEventListener('mousedown', e => {
            if (!(this.field && e.target === this.field.el)) {
                e.preventDefault();
            }
        });
        this.el.addEventListener('keydown', e => this.onKey(e));
    }

    get visible(): boolean {
        return !this.el.hidden;
    }

    get editing(): boolean {
        return this.field !== null;
    }

    /** What the open field edits by its place, and the place its field stands at: none while no field is open. */
    get followed(): readonly object[] {
        return this.field === null ? [] : this.following;
    }

    /** Show `object`; redrawn only when what it shows changed, so a focused verb keeps its focus, and never under an open field. */
    show(object: EditorObject, presentation: Presentation): void {
        this.object = object;
        this.anchorFrom = presentation.anchorFrom ?? null;
        this.el.dataset.object = object.kind;
        // Everything the bar draws or will prefill: an image's `src` is in no
        // label, only in the title and the field's value, and a bar kept after
        // an undo would otherwise offer the undone source.
        // A breadcrumb's parts too (#8): names, literals, refusals, roles — a literal changed redraws them.
        const part = (c: CrumbView) => [c.role, c.name, c.short ?? null, c.literal, c.opens, c.verb?.id ?? null, c.verb?.refusal ?? null, c.verb?.field?.value ?? null];
        const signature = JSON.stringify([
            object.kind, object.from, presentation.label, presentation.short ?? null, presentation.title, presentation.name ?? null,
            presentation.crumbs === undefined ? null : [part(presentation.crumbs.outer), part(presentation.crumbs.current)],
            presentation.verbs.map(v => [
                v.id, v.label, v.title, v.refusal ?? null, v.field?.value ?? v.choice?.value ?? null, v.separated ?? false,
                v.menu?.map(m => [m.id, m.label, m.title, m.keys ?? null, m.code ?? null, m.checked ?? null, m.refusal ?? null]) ?? null,
            ]),
        ]);
        if (!this.field && signature !== this.signature) {
            // An open set-verb menu whose entries changed under it (the table
            // changed, an undo) is rebuilt: its entries act on the object as it
            // is, and a stale "Delete row" would say so of a row that is gone.
            // (An open menu holds the focus — it closes when the focus leaves it — so the rebuilt one takes it.)
            const reopen = this.menu?.verb;
            const via = this.menu?.viaMore === true;
            // "…"'s own list, open: it holds the verbs as they are now, so it is drawn again with them where "…" is still in the bar.
            const list = this.menu !== null && this.menu.button === this.more && reopen === undefined;
            this.reopenEntry = list ? this.menu?.entries.find(m => m.el === document.activeElement)?.entry.id ?? null : null;
            this.signature = signature;
            this.reopenVia = null;
            this.render(presentation);
            const again = reopen === undefined ? undefined : this.buttons.find(b => b.verb.id === reopen);
            if (list) {
                this.reopenVia = MORE_LIST;
            } else if (again?.verb.menu && !again.verb.refusal) {
                if (via) {
                    // Where the verb stands is not known before the bar is fitted: it may be in "…" still.
                    this.reopenVia = again.verb.id;
                } else {
                    this.openMenu(again.verb.menu, again.el, { name: lensName(again.verb.label), verb: again.verb.id });
                }
            }
        }
        this.el.hidden = false;
    }

    hide(): void {
        // The hover first, while its control is still in the bar (a menu's entry goes with the menu).
        this.tips.hide(this.el);
        this.closeMenu(false);
        this.reopenVia = null;
        if (this.field) {
            this.dropRow();
            this.field.dispose();
            this.events.fieldDropped();
        }
        this.field = null;
        this.object = null;
        this.signature = '';
        this.el.hidden = true;
        delete this.el.dataset.object;
    }

    /**
     * `Alt+Enter`'s focus (`firstFocus`, `verbs.ts`): the first verb that opens
     * something in place and is not refused — else the bar itself, named for
     * the screen reader by its object, how many verbs can be chosen and its keys, `Enter` or `↓`
     * moving into its first verb (and `Esc` still returning).
     */
    focusFirst(): void {
        const first = this.buttons[firstFocus(this.buttons.map(b => slotted(b.verb)))];
        (first?.el ?? this.el).focus({ preventScroll: true });
    }

    /**
     * The bar fitted to `room`, the widest it may be — from the text column's
     * left edge to the editor's right edge less the gutter: a floating layer
     * may stand past the column (Daniel, 2026-10-16). Every verb at its full
     * label, then — where the title would be cut — every verb that has a
     * short form at it, the noun the title already names dropped (`Delete`,
     * `Edit…`, `Remove, keep content`); then the title truncates, down to
     * hidden if the verbs need it (narrower than `TITLE_STUB` it says nothing:
     * the bar's `aria-label` still names the object, and its hover). Verbs
     * never truncate (`flex: none`): where even the hidden title leaves too
     * little room, they move into the bar's "…" in `overflowOrder` — the verb
     * that destroys first, then other extensions', then from the right, never
     * the one `Alt+Enter` focuses (Daniel, 2026-10-19). Before the title
     * truncates, a title with a short form takes it (`Warning admonition` →
     * `Warning`). It starts from the full labels every time, so a bar grown
     * wider again gets them back — and does nothing where neither the room
     * nor what the bar shows changed since the last fit. Not while a field is
     * open: the verbs are not drawn then.
     */
    fit(room: number): void {
        const label = this.el.querySelector<HTMLElement>(':scope > .mep-object-label');
        const crumbs = this.el.querySelector<HTMLElement>(':scope > .mep-crumbs');
        const key = `${Math.round(room)}|${this.signature}`;
        if (this.field || this.el.hidden || (label === null && crumbs === null) || key === this.fitted) {
            return;
        }
        this.fitted = key;
        if (crumbs !== null) {
            this.fitCrumbs(room);
            return;
        }
        const movedBefore = this.moved.map(b => b.verb.id).join(',');
        const shortens = this.buttons.filter(b => b.verb.short !== undefined && b.verb.short !== b.verb.label);
        for (const b of shortens) {
            if (b.el.dataset.short !== undefined) {
                drawVerbLabel(b.el, b.verb, b.verb.label);
                delete b.el.dataset.short;
                b.el.removeAttribute('aria-label');
            }
        }
        label.hidden = false;
        if (this.title.tiny !== undefined) {
            label.replaceChildren(...this.titleNodes);
        }
        this.setTitle(label, this.title.label);
        for (const b of this.buttons) {
            this.showVerb(b);
        }
        this.moved = [];
        // "…" is in the bar only while it holds a verb: taken out and put back as it is measured, it keeps the focus it had.
        const keepMore = holdFocus(this.buttons.map(b => b.el), this.more, this.el);
        this.more?.remove();
        this.el.style.maxWidth = `${Math.floor(room)}px`;
        // Measured at the mount's left edge: an absolute box's room is what lies right of its `left`, and `place` sets it after.
        const left = this.el.style.left;
        this.el.style.left = '0px';
        const cut = () => label.scrollWidth > label.clientWidth + 1;
        if (cut()) {
            // The verbs that can drop their noun do.
            for (const b of shortens) {
                drawVerbLabel(b.el, b.verb, b.verb.short as string);
                b.el.dataset.short = b.verb.short;
                // Named in full for a screen reader: the short form leans on the title.
                b.el.setAttribute('aria-label', b.verb.label);
            }
            // The title's short form, before it truncates.
            if (cut() && this.title.short !== undefined) {
                if (this.title.tiny !== undefined) {
                    // A title with steps (a footnote's: "Footnote 1 · liebst" → "Footnote 1" → "1") is never cut mid-word.
                    label.replaceChildren(this.title.short);
                } else {
                    this.setTitle(label, this.title.short);
                }
            }
            if (cut() && this.title.tiny !== undefined) {
                label.replaceChildren(this.title.tiny);
            }
            // Still too wide, and the title cut below a stub that could say anything — or a stepped title cut at all: it goes.
            label.hidden = cut() && (this.title.tiny !== undefined || label.offsetWidth < TITLE_STUB);
        }
        // The title hidden and the verbs still past the room: they move into "…".
        const more = this.more;
        if (label.hidden && more) {
            const order = overflowOrder(this.buttons.map(b => slotted(b.verb))).map(k => this.buttons[k]);
            this.moved = fitWithMore(order, () => overflows(this.el), b => this.showVerb(b), b => this.hideVerb(b), shown => {
                if (shown) {
                    this.el.append(more);
                } else {
                    more.remove();
                }
            });
        }
        if (this.more) {
            const inMore = this.moreEntries().map(e => e.label);
            this.more.setAttribute('aria-label', moreName('bar', inMore));
        }
        // A title the room hid still names the object on a rest on the bar (its `aria-label` names it too).
        this.tips.attach(this.el, () => (label.hidden ? plainTip(this.name) : null));
        this.el.style.left = left;
        keepMore();
        this.menuAfterFit(movedBefore);
    }

    /**
     * A two-part bar fitted to `room` (#8, section 4.6; review 1), never wider
     * than the window less `BAR_WINDOW_GUTTER`, one step at a time while it is
     * past the room: (1) the outer part's literal is cut, (2) then hidden — a
     * title part takes its short form ("Warning"); (3) the current part's
     * literal is cut, six characters still showing; (4) the outer part moves
     * into the bar's "…" as "Attributes of List… {.steps}", the chevron with
     * it, "…" drawn even where every verb fits (a title part never moves: it is
     * no control); (5) the verbs move into "…" in `overflowOrder`; (6) the
     * current literal is hidden, (7) then a title part — so "…" stays inside
     * the bar. No part's name is ever cut, and the bar's name keeps every part.
     * Its verbs keep their nouns throughout: no short forms on a two-part bar.
     * Measured, from the whole bar each time.
     */
    private fitCrumbs(room: number): void {
        const movedBefore = this.moved.map(b => b.verb.id).join(',');
        for (const b of this.buttons) {
            this.showVerb(b);
        }
        this.moved = [];
        this.outerMoved = false;
        const keepMore = holdFocus([...this.parts.map(p => p.el), ...this.buttons.map(b => b.el)], this.more, this.el);
        this.more?.remove();
        const [outer, current] = this.parts;
        const sep = this.el.querySelector<HTMLElement>(':scope > .mep-crumbs > .mep-crumb-sep');
        for (const p of this.parts) {
            p.el.hidden = false;
            p.el.classList.remove('mep-crumb-cut');
            p.el.classList.toggle('mep-crumb-bare', p.view.literal === null);
            const name = p.el.querySelector('.mep-crumb-name');
            if (name !== null) {
                name.textContent = p.view.name;
            }
        }
        if (sep !== null) {
            sep.hidden = false;
        }
        // Never past the window, whatever the room (#8 review 1: at 380 px the bar ran off it): its "…" stays inside.
        // The window's width less a scrollbar, as the placement clamps with (`placement.ts`).
        this.el.style.maxWidth = `${Math.floor(Math.min(room, document.documentElement.clientWidth - BAR_WINDOW_GUTTER))}px`;
        const left = this.el.style.left;
        this.el.style.left = '0px';
        const more = this.more;
        const past = () => overflows(this.el);
        if (outer !== undefined && current !== undefined && past()) {
            // (1) The outer literal is cut, (2) then hidden; a title takes its short form.
            outer.el.classList.add('mep-crumb-cut');
            if (past()) {
                outer.el.classList.add('mep-crumb-bare');
                const name = outer.el.querySelector('.mep-crumb-name');
                if (outer.view.short !== undefined && name !== null) {
                    name.textContent = outer.view.short;
                }
            }
            // (3) The current literal is cut, six characters still showing — before the outer part leaves (#8 review 1).
            if (past()) {
                current.el.classList.add('mep-crumb-cut');
            }
            // (4) The outer part, a control, moves into "…" — first there — the chevron with it.
            if (past() && outer.view.verb !== null && more) {
                outer.el.hidden = true;
                if (sep !== null) {
                    sep.hidden = true;
                }
                this.outerMoved = true;
                this.el.append(more);
            }
        }
        if (more && past()) {
            // (5) The verbs, in `overflowOrder`; "…" stays while it holds the outer part.
            const order = overflowOrder(this.buttons.map(b => slotted(b.verb))).map(k => this.buttons[k]);
            this.moved = fitWithMore(order, () => overflows(this.el), b => this.showVerb(b), b => this.hideVerb(b), shown => {
                if (shown || this.outerMoved) {
                    this.el.append(more);
                } else {
                    more.remove();
                }
            });
        }
        if (outer !== undefined && current !== undefined) {
            // (6) Still past — the verb Alt+Enter focuses never leaves — the current literal goes, (7) then a title part:
            // "…" is pinned inside the bar. The bar's name keeps both parts and their literals.
            if (past()) {
                current.el.classList.add('mep-crumb-bare');
            }
            if (past() && outer.view.verb === null) {
                outer.el.hidden = true;
                if (sep !== null) {
                    sep.hidden = true;
                }
            }
        }
        if (this.more) {
            this.more.setAttribute('aria-label', moreName('bar', this.moreEntries().map(e => e.label)));
        }
        this.el.style.left = left;
        keepMore();
        this.menuAfterFit(movedBefore);
    }

    /**
     * What the fit did to an open menu. A menu whose button is hidden or gone
     * (its verb moved into "…", "…" itself left) hangs from nothing: it closes,
     * the focus it held going to "…" where that is in the bar, else to the bar;
     * so does one opened through "…" when what "…" holds changed, its entries
     * being the old ones. A set-verb menu that was open through "…" when the
     * bar was drawn again opens now, where its verb stands.
     */
    private menuAfterFit(movedBefore: string): void {
        const menu = this.menu;
        if (menu) {
            const moved = this.moved.map(b => b.verb.id).join(',');
            if (!menu.button.isConnected || menu.button.hidden || (menu.viaMore && moved !== movedBefore)) {
                const held = menu.panel.contains(document.activeElement);
                this.closeMenu(false);
                if (held) {
                    (this.more?.isConnected ? this.more : this.el).focus({ preventScroll: true });
                }
            }
        }
        const pending = this.reopenVia;
        const entry = this.reopenEntry;
        this.reopenVia = null;
        this.reopenEntry = null;
        if (pending === MORE_LIST && this.menu === null) {
            if (this.more?.isConnected) {
                this.openMenu(this.moreEntries(), this.more, { name: moreName('bar', []), viaMore: true, focus: entry ?? undefined });
            } else {
                // "…" is gone — the verbs it held fit the bar now: the focus the list had stays in the bar.
                this.el.focus({ preventScroll: true });
            }
            return;
        }
        const b = pending === null || pending === MORE_LIST ? undefined : this.buttons.find(x => x.verb.id === pending);
        if (b?.verb.menu && !b.verb.refusal && this.menu === null) {
            const name = lensName(b.verb.label);
            if (this.moved.includes(b) && this.more?.isConnected) {
                this.openMenu(b.verb.menu, this.more, { name, verb: b.verb.id, viaMore: true });
            } else if (!b.el.hidden) {
                this.openMenu(b.verb.menu, b.el, { name, verb: b.verb.id });
            }
        }
    }

    /** The title drawn as `text`, an atom's spelling after it as before. */
    private setTitle(label: HTMLElement, text: string): void {
        const first = label.firstChild;
        if (first && first.nodeType === globalThis.Node.TEXT_NODE) {
            first.nodeValue = text;
        }
    }

    /** A verb back on the bar, with the divider before it. */
    private showVerb(b: { verb: Verb; el: HTMLButtonElement }): void {
        b.el.hidden = false;
        const before = b.el.previousElementSibling as HTMLElement | null;
        if (b.verb.separated && before?.classList.contains('mep-object-separator')) {
            before.hidden = false;
        }
    }

    /** A verb moved into "…": its button, and the divider that belongs to it, go. */
    private hideVerb(b: { verb: Verb; el: HTMLButtonElement }): void {
        b.el.hidden = true;
        const before = b.el.previousElementSibling as HTMLElement | null;
        if (b.verb.separated && before?.classList.contains('mep-object-separator')) {
            before.hidden = true;
        }
    }

    /**
     * What "…" lists: the moved verbs in the bar's order, each with its full
     * label (never the short form), the verb that destroys last after a
     * divider; a set-verb's entry opens its own menu under "…" (F4).
     */
    private moreEntries(): MenuEntry[] {
        // The breadcrumb's outer part, moved there by the fit (#8): first, named as the menu names it, its literal after it.
        const outer = this.outerMoved ? this.parts.find(p => p.view.role === 'outer') : undefined;
        const crumb: MenuEntry[] = outer?.view.verb ? [{
            id: outer.view.verb.id,
            label: outer.view.verb.label,
            code: outer.view.literal ?? undefined,
            title: outer.view.verb.title,
            refusal: outer.view.verb.refusal,
            run: () => this.choose(outer.view.verb as Verb),
        }] : [];
        return [...crumb, ...this.buttons.filter(b => this.moved.includes(b)).map(({ verb }): MenuEntry => ({
            id: verb.id,
            label: lensName(verb.label),
            title: verb.title,
            refusal: verb.refusal,
            separated: verb.slot === 'destroy',
            opens: verb.menu !== undefined,
            run: () => {
                if (verb.menu && this.more) {
                    this.openMenu(verb.menu, this.more, { name: lensName(verb.label), verb: verb.id, viaMore: true });
                } else {
                    this.choose(verb);
                }
            },
        }))];
    }

    /** The open field's row fitted to `room` before the slot places it (`FieldRow.fit`). */
    fitField(room: number, fresh: boolean): void {
        this.row?.fit(room, fresh);
    }

    /** The field's row is gone with its field: what it set on the bar goes too. */
    private dropRow(): void {
        this.row?.destroy();
        this.row = null;
    }

    /** Fit again at the next placing, though neither the room nor the bar changed: a font loaded late changed the labels' widths. */
    refit(): void {
        this.fitted = '';
    }

    private render(presentation: Presentation): void {
        this.tips.hide(this.el);
        this.closeMenu(false);
        this.hovered = null;
        const label = document.createElement('span');
        label.className = 'mep-object-label';
        label.textContent = presentation.label;
        this.title = { label: presentation.label, short: presentation.short, tiny: presentation.tiny };
        this.moved = [];
        this.outerMoved = false;
        this.el.dataset.name = presentation.label;
        if (presentation.code !== undefined) {
            const code = document.createElement('span');
            code.className = 'mep-object-label-code';
            code.textContent = presentation.code;
            label.append(' ', code);
        }
        if (presentation.after !== undefined) {
            label.append(presentation.after);
        }
        this.titleNodes = Array.from(label.childNodes);
        // What the object is, on a rest: the title is a label, not a control — no focus, no press.
        this.tips.attach(label, () => (presentation.title === '' ? null : plainTip(presentation.title)));
        this.fitted = '';
        // A breadcrumb takes the title's place (#8): its parts are controls in the bar's arrow order, counted with the verbs.
        const head = presentation.crumbs === undefined ? label : this.renderCrumbs(presentation.crumbs);
        if (presentation.crumbs === undefined) {
            this.parts = [];
        }
        this.name = presentation.name ?? `${barName(presentation.label, presentation.code)}${presentation.after ?? ''}`;
        const parts = this.parts.filter(p => p.view.verb !== null && !p.view.verb.refusal).length;
        this.el.setAttribute('aria-label', barDescription(this.name, parts + presentation.verbs.filter(v => !v.refusal).length));
        this.buttons = presentation.verbs.map(verb => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'mep-object-verb';
            el.dataset.verb = verb.id;
            drawVerbLabel(el, verb, verb.label);
            if ((el.textContent ?? '') === '') {
                // Only an icon: the button is named by it, not left without a name.
                el.setAttribute('aria-label', lensName(verb.label));
            }
            el.tabIndex = -1;
            this.tips.attach(el, () => (verb.tip ? { ...verb.tip, note: verb.refusal ?? verb.tip.note } : plainTip(verb.title, verb.refusal)));
            el.setAttribute('aria-disabled', String(Boolean(verb.refusal)));
            if (verb.menu) {
                el.setAttribute('aria-haspopup', 'menu');
                el.setAttribute('aria-expanded', 'false');
            }
            el.addEventListener('click', e => {
                e.preventDefault();
                this.choose(verb, el);
            });
            // Open, focused or hovered: the verb is active, and a table draws what it acts on (`activeVerb`).
            el.addEventListener('pointerenter', () => this.verbHovered(verb.id, true));
            el.addEventListener('pointerleave', () => this.verbHovered(verb.id, false));
            el.addEventListener('focus', () => this.events.verbActive());
            el.addEventListener('blur', () => this.events.verbActive());
            return { verb, el };
        });
        // The title, then a divider: it names the object, it is not the first verb (whose own divider that one is).
        // No verbs, no divider: it would divide the title from nothing.
        // "…", drawn last by `fit` once it moves a verb into it.
        const more = moreControl('bar') as HTMLButtonElement;
        more.addEventListener('click', e => {
            e.preventDefault();
            this.toggleMore();
        });
        // Its hover is its name: said once, as the `aria-label`, not again as a description.
        this.tips.attach(more, () => plainTip(more.getAttribute('aria-label') ?? 'More actions'), 'below', false);
        more.hidden = false;
        this.more = this.buttons.length > 0 || this.parts.length > 0 ? more : null;
        this.el.replaceChildren(head, ...(this.buttons.length > 0 ? [barSeparator()] : []), ...this.buttons.flatMap((b, i) => b.verb.separated && i > 0 ? [barSeparator(), b.el] : [b.el]));
    }

    /**
     * The breadcrumb (#8): a group "Blocks at the caret" — no landmark — of
     * the outer part, a chevron drawn and not read, and the current part. A
     * part that opens a field is a button: its name, then its literal in the
     * code font (hidden while it has none); named "Attributes of List,
     * .steps"; the current one `aria-current`, its name set semibold. A part
     * that is a title (an admonition's, a container's) is drawn as the bar's
     * title: not focusable, no hover. Pressed, a part opens its field, or says
     * why it cannot at the part (#10).
     */
    private renderCrumbs(crumbs: NonNullable<Presentation['crumbs']>): HTMLElement {
        const group = document.createElement('span');
        group.className = 'mep-crumbs';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', 'Blocks at the caret');
        const draw = (view: CrumbView): HTMLElement => {
            const name = document.createElement('span');
            name.className = 'mep-crumb-name';
            name.textContent = view.name;
            const verb = view.verb;
            if (verb === null) {
                const title = document.createElement('span');
                title.className = 'mep-crumb mep-crumb-title';
                title.dataset.part = view.role;
                title.append(name);
                return title;
            }
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'mep-crumb';
            el.tabIndex = -1;
            el.dataset.part = view.role;
            el.classList.toggle('mep-crumb-bare', view.literal === null);
            if (view.role === 'current') {
                el.setAttribute('aria-current', 'true');
            }
            const code = document.createElement('span');
            code.className = 'mep-crumb-code';
            code.textContent = view.literal ?? '';
            el.append(name, code);
            el.setAttribute('aria-label', crumbPartName(view));
            el.setAttribute('aria-disabled', String(Boolean(verb.refusal)));
            // Its hover says what pressing it does and where the field opens, as the menu's entry names it; a refused one why not.
            this.tips.attach(el, () => (verb.refusal ? plainTip(`Attributes of ${view.name}…`, verb.refusal) : plainTip(`Attributes of ${view.name}… — opens ${view.opens}`)));
            el.addEventListener('click', e => {
                e.preventDefault();
                this.choose(verb, el);
            });
            el.addEventListener('focus', () => this.events.verbActive());
            el.addEventListener('blur', () => this.events.verbActive());
            return el;
        };
        const outer = draw(crumbs.outer);
        const current = draw(crumbs.current);
        const sep = document.createElement('span');
        sep.className = 'mep-crumb-sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.append(...lensLabelNodes('$(chevron-right)'));
        group.append(outer, sep, current);
        this.parts = [{ view: crumbs.outer, el: outer }, { view: crumbs.current, el: current }];
        return group;
    }

    /**
     * The verb that is active now, by id: the one whose menu is open — under
     * its button or, moved there, under "…" — else the one whose button has the
     * focus, else the one under the pointer; with the "…" list itself open, the
     * entry that has the focus or the pointer stands for its verb. `null` for
     * none. What a table's bar tints follows it (F6: Row tints the caret's row,
     * Column and Align its column).
     */
    activeVerb(): string | null {
        const menu = this.menu;
        if (menu?.verb) {
            return menu.verb;
        }
        const entry = menu === null ? undefined : menu.entries.find(m => m.el === document.activeElement)?.entry.id ?? this.hoveredEntry;
        const focused = this.buttons.find(b => b.el === document.activeElement);
        return entry ?? focused?.verb.id ?? this.hovered;
    }

    /** The axis the active verb acts on (`Verb.axis`): what a table's bar tints. */
    activeAxis(): Verb['axis'] {
        const id = this.activeVerb();
        return id === null ? undefined : this.buttons.find(b => b.verb.id === id)?.verb.axis;
    }

    private verbHovered(id: string, on: boolean): void {
        if (on || this.hovered === id) {
            this.hovered = on ? id : null;
            this.events.verbActive();
        }
    }

    /** The pointer on or off an entry of the open menu: only the "…" list's entries stand for a verb (`activeVerb`). */
    private entryHovered(id: string, on: boolean): void {
        if (this.menu !== null && this.menu.verb === undefined && (on || this.hoveredEntry === id)) {
            this.hoveredEntry = on ? id : null;
            this.events.verbActive();
        }
    }

    /** "…" pressed: its menu opens under it, or closes. */
    private toggleMore(): void {
        const more = this.more;
        if (!more) {
            return;
        }
        const open = this.menu?.button === more;
        this.closeMenu(open);
        if (!open) {
            this.openMenu(this.moreEntries(), more, { name: moreName('bar', []), viaMore: true });
        }
    }

    /** `verb` chosen — pressed at `el`, where a refused one says why (#10): under the bar, never a silent nothing. */
    private choose(verb: Verb, el?: HTMLElement): void {
        if (verb.refusal) {
            if (el) {
                this.tips.hide();
                this.events.refuse(verb.refusal, { at: 'control', el });
            }
            return;
        }
        if (verb.menu) {
            const button = this.buttons.find(b => b.verb === verb)?.el;
            const open = this.menu?.button === button;
            this.closeMenu(open);
            if (button && !open) {
                this.openMenu(verb.menu, button, { name: lensName(verb.label), verb: verb.id });
            }
        } else if (verb.field) {
            this.openField(verb, verb.field);
        } else if (verb.choice) {
            this.openField(verb, verb.choice);
        } else {
            verb.run?.();
        }
    }

    /**
     * A set-verb's menu, under its button (above it where the window has no
     * room below), in the formatting toolbar's menu chrome: an entry is its
     * label and, at its right, the keys that do the same; the current value of
     * a choice is marked as that toolbar marks an active entry. The focus goes
     * to the marked entry, else the first that can be chosen. Inside the bar's
     * element, so the bar counts the focus in it as its own.
     */
    private openMenu(entries: readonly MenuEntry[], button: HTMLButtonElement, from: { name: string; verb?: string; viaMore?: boolean; focus?: string }): void {
        const viaMore = from.viaMore === true;
        const panel = document.createElement('div');
        panel.className = 'mep-menu mep-object-menu';
        panel.setAttribute('role', 'menu');
        panel.tabIndex = -1;
        // Named for what it holds: the verb's label, or "More actions" — never nameless, the button of "…" has no text.
        panel.setAttribute('aria-label', from.name);
        const made = entries.map(entry => {
            // Inside "…" the label is whole: what the entry's hover would add is its description, and it has no hover.
            const el = buildMoreEntry({
                role: entry.checked === undefined ? 'menuitem' : 'menuitemradio',
                checked: entry.checked,
                opens: entry.opens,
                refusal: entry.refusal,
                description: viaMore && entry.title !== entry.label ? entry.title : undefined,
            });
            el.dataset.entry = entry.id;
            const label = document.createElement('span');
            label.className = 'mep-entry-label';
            label.textContent = entry.label;
            el.append(label);
            if (entry.code !== undefined) {
                // The part's literal (#8 Remove▾): in the code font, muted, after the name.
                const code = document.createElement('span');
                code.className = 'mep-entry-code';
                code.textContent = entry.code;
                el.append(code);
            }
            if (entry.opens) {
                el.append(chevronNode('right'));
            }
            if (entry.keys) {
                const keys = document.createElement('span');
                keys.className = 'mep-entry-syntax';
                keys.textContent = entry.keys;
                el.append(keys);
            }
            if (!viaMore) {
                // A set-verb's entry says what it does on a rest (it has no preview card).
                this.tips.attach(el, () => plainTip(entry.title, entry.refusal), 'beside');
            }
            el.addEventListener('click', e => {
                e.preventDefault();
                this.pick(entry, el);
            });
            el.addEventListener('mouseenter', () => {
                followPointer(panel, el);
                this.entryHovered(entry.id, true);
            });
            el.addEventListener('mouseleave', () => this.entryHovered(entry.id, false));
            // Moving between entries with the arrow keys is a move between the verbs they stand for (`activeVerb`).
            el.addEventListener('focus', () => this.events.verbActive());
            return { entry, el };
        });
        panel.append(...made.flatMap((m, i) => (m.entry.separated && i > 0 ? [separator(), m.el] : [m.el])));
        panel.addEventListener('keydown', e => this.onMenuKey(e));
        panel.addEventListener('focusout', e => {
            if (!(e.relatedTarget instanceof globalThis.Node && panel.contains(e.relatedTarget))) {
                this.closeMenu(false);
            }
        });
        this.menu = { panel, button, entries: made, verb: from.verb, viaMore };
        button.setAttribute('aria-expanded', 'true');
        // `position: fixed`, a child of the bar so the bar counts its focus as its own: placed as the row's menus are.
        this.el.append(panel);
        placeMenu(panel, button);
        const first = made.find(m => m.entry.id === from.focus && !m.entry.refusal)
            ?? made.find(m => m.entry.checked && !m.entry.refusal) ?? made.find(m => !m.entry.refusal);
        (first?.el ?? panel).focus({ preventScroll: true });
        this.events.verbActive();
    }

    /** Close the open menu, the focus back on its verb when asked. */
    private closeMenu(focusButton: boolean): void {
        const menu = this.menu;
        if (menu === null) {
            return;
        }
        this.menu = null;
        this.hoveredEntry = null;
        this.events.verbActive();
        menu.button.setAttribute('aria-expanded', 'false');
        // An entry's hover goes with its menu: once the panel is out of the bar, `hide(this.el)` finds it no more.
        this.tips.hide(menu.panel);
        // So does a refusal said at one of its entries.
        this.events.menuClosed(menu.panel);
        menu.panel.remove();
        if (focusButton) {
            menu.button.focus({ preventScroll: true });
        }
    }

    /** `entry` picked — pressed at `el`, where a refused one says why beside the menu, which stays open (#10). */
    private pick(entry: MenuEntry, el?: HTMLElement): void {
        if (entry.refusal) {
            const panel = this.menu?.panel;
            if (el && panel) {
                this.tips.hide(panel);
                this.events.refuse(entry.refusal, { at: 'menu-entry', el, menu: panel });
            }
            return;
        }
        this.closeMenu(false);
        entry.run();
    }

    private onMenuKey(e: KeyboardEvent): void {
        const menu = this.menu;
        if (menu === null) {
            return;
        }
        // The bar's own keys move between verbs; inside the menu they are the menu's.
        e.stopPropagation();
        const enabled = menu.entries.filter(m => !m.entry.refusal);
        const index = enabled.findIndex(m => m.el === document.activeElement);
        const focus = (k: number) => enabled[(k % enabled.length + enabled.length) % enabled.length]?.el.focus({ preventScroll: true });
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                focus(index + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                focus(index < 0 ? -1 : index - 1);
                break;
            case 'Home':
                e.preventDefault();
                focus(0);
                break;
            case 'End':
                e.preventDefault();
                focus(-1);
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (index >= 0) {
                    this.pick(enabled[index].entry);
                }
                break;
            case 'Escape':
            case 'Tab':
                e.preventDefault();
                this.closeMenu(true);
                break;
        }
    }

    /**
     * The verb's field — or its choice, for a verb with `options` — in place of
     * the verbs, beside the label. A field whose commit names a next step
     * (**Edit image…**: the alt text, then the path) shows that field next, in
     * the same place; the bar is redrawn once the last one is in.
     */
    private openField(verb: Verb, spec: NonNullable<Verb['field']> | NonNullable<Verb['choice']>): void {
        let label = this.el.querySelector<HTMLElement>('.mep-object-label');
        // A breadcrumb gives way to the field's heading for the field's lifetime (#8): drawn again once it closes.
        const crumbs = this.el.querySelector<HTMLElement>(':scope > .mep-crumbs');
        if (label === null && crumbs !== null) {
            label = document.createElement('span');
            label.className = 'mep-object-label';
            crumbs.replaceWith(label);
            this.parts = [];
        }
        const make = 'options' in spec
            ? (callbacks: { onCommit(value: string): void; onCancel(reason: 'escape' | 'blur'): void }) =>
                new InlineChoice({ choices: spec.options, value: spec.value, label: spec.label, ...callbacks })
            : (callbacks: { onCommit(value: string): void; onCancel(reason: 'escape' | 'blur'): void }) =>
                new InlineField({
                    value: spec.value, caret: spec.caret, label: spec.label, placeholder: spec.placeholder, complete: spec.complete, adorn: spec.adorn,
                    onChange: value => this.row?.changed(value), ...callbacks,
                });
        const field = make({
            onCommit: value => {
                this.dropRow();
                this.field = null;
                this.signature = '';
                const next = spec.commit(value);
                if (next) {
                    this.openField(verb, next);
                    return;
                }
                this.events.fieldClosed(true);
            },
            onCancel: reason => {
                this.dropRow();
                this.field = null;
                this.signature = '';
                if (reason === 'escape') {
                    this.events.escape();
                }
                this.events.fieldClosed(false);
            },
        });
        field.el.dataset.verb = verb.id;
        this.field = field;
        // The step's own and what its field is placed at (`target`, `anchorBlock`): one object each where they are the same.
        this.following = [...('options' in spec ? [] : spec.followed ?? []), ...(verb.target ? [verb.target] : []), ...(verb.anchorBlock ? [verb.anchorBlock] : [])];
        // The buttons go with the replaced row, and no pointerleave comes for a hover on one: forgotten here, it would tint on (`activeVerb`).
        this.hovered = null;
        this.hoveredEntry = null;
        if (label) {
            // A prefilled field shows no placeholder: the label says what the value is.
            // The object's name alone: what the field holds (a literal) is not said twice (`Image · Attributes`).
            // An attributes field names the element it edits, whichever bar opened it (`FieldStep.heading`).
            label.textContent = ('heading' in spec ? spec.heading : undefined) ?? fieldHeading(this.el.dataset.name ?? '', spec.label);
            // The heading says it all: the object's hover, attached for the title, would say something else.
            this.tips.attach(label, () => null);
            // A title `fit` hid for the verbs is the field's heading now, and there are no verbs to count.
            label.hidden = false;
            this.el.setAttribute('aria-label', this.name);
        }
        this.fitted = '';
        this.tips.hide(this.el);
        this.dropRow();
        this.row = new FieldRow(this.el, label ? [label, barSeparator()] : [], field, 'options' in spec ? null : spec, { contentChanged: () => this.events.fieldResized() });
        this.row.render();
        field.focus();
        if (this.object) {
            this.events.fieldOpened(this.object, verb.target, verb.anchorBlock);
        }
    }

    private onKey(e: KeyboardEvent): void {
        // What the keys reach: the breadcrumb's parts shown, outer then current — a refused one too, Enter saying why at it (#8) —
        // then the verbs shown and offered, then "…" while it holds any.
        const enabled: { el: HTMLElement; choose(): void }[] = [
            ...this.parts.filter(p => p.view.verb !== null && !p.el.hidden).map(p => ({ el: p.el, choose: () => this.choose(p.view.verb as Verb, p.el) })),
            ...this.buttons.filter(b => !b.verb.refusal && !b.el.hidden).map(b => ({ el: b.el, choose: () => this.choose(b.verb) })),
            ...(this.more?.isConnected ? [{ el: this.more, choose: () => this.toggleMore() }] : []),
        ];
        const index = enabled.findIndex(b => b.el === document.activeElement);
        const move = (step: number) => {
            if (enabled.length > 0) {
                enabled[((index < 0 ? 0 : index + step) % enabled.length + enabled.length) % enabled.length].el.focus({ preventScroll: true });
            }
        };
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowDown':
                e.preventDefault();
                move(1);
                break;
            case 'ArrowLeft':
            case 'ArrowUp':
                e.preventDefault();
                move(-1);
                break;
            case 'Home':
                e.preventDefault();
                enabled[0]?.el.focus({ preventScroll: true });
                break;
            case 'End':
                e.preventDefault();
                enabled[enabled.length - 1]?.el.focus({ preventScroll: true });
                break;
            case 'Enter':
            case ' ':
                if (index >= 0) {
                    e.preventDefault();
                    enabled[index].choose();
                } else if (e.key === 'Enter' && document.activeElement === this.el) {
                    // The bar itself has the focus (`focusFirst`): Enter moves into its first verb, as ↓ does; choosing one is a second Enter.
                    e.preventDefault();
                    move(1);
                }
                break;
            case 'Escape':
                e.preventDefault();
                e.stopPropagation();
                this.events.escape();
                break;
        }
    }
}

/** The slot's key of `object`'s bar (`placement.ts`): what Esc's dismissal keeps refusing until the caret leaves it. */
function barKey(trigger: 'bar' | 'hover', object: Pick<EditorObject, 'kind' | 'from'>): string {
    return `${trigger}@${object.kind}@${object.from}`;
}

/** What an Esc dismissal is about, kept beside its key in the slot so a change of the document can move it without parsing the key. */
interface Dismissal {
    trigger: 'bar' | 'hover';
    kind: EditorObject['kind'];
    from: number;
}

class ObjectToolbarView implements PluginView {
    private readonly mount: HTMLElement;
    private readonly selectionBar: ObjectBar;
    private readonly hoverBar: ObjectBar;
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];
    /** The inline object the caret has rested in long enough (or `Alt+Enter` opened). */
    private matured: EditorObject | null = null;
    /** The object `Alt+Enter` opened the bar of: drawn even where `barless` says no, while it has a verb for the element at the caret. */
    private forced: EditorObject | null = null;
    private pending: { object: EditorObject; timer: ReturnType<typeof setTimeout> } | null = null;
    /** The top-level atom's element the pointer is on. */
    private hovered: HTMLElement | null = null;
    private hoverTimer: ReturnType<typeof setTimeout> | undefined;
    private destroyed = false;
    /** Language…'s completer, for the document it read the languages of (`languageCompleter`). */
    private languages: { doc: EditorState['doc']; complete: (query: string) => Completion[] } | null = null;
    /** While `act` moves the focus: what the transactions dispatched meanwhile (a source box's commit) did to positions. */
    private focusMoves: Mapping | null = null;
    /** The hover the bars share with the formatting row (`tooltip.ts`), released with the view. */
    private readonly tips: Tooltips;
    /** The one floating layer of the view (`placement.ts`), shared with the bubble and the row's field bars. */
    private readonly slot: LayerSlot;
    /** The key of a bar's open field in the slot, while one is open. */
    private fieldKey: string | null = null;
    /** A key went down in the text and its change has not come yet: the change it brings is typing (`LayerSlot.typing`). */
    private keyed = false;
    /** The atom carrying the hover cue: the pointer is on it while the slot is taken (`mep-hover-cue`). */
    private cued: HTMLElement | null = null;
    private readonly unfreed: () => void;
    /** Typing hid the caret's bar and its rest has not come: the pointer's bar does not take the free slot meanwhile (`refreshHover`). */
    private typingHold = false;
    /** The dismissals Esc made, by the slot's key: where each is about, for `followDismissals`. */
    private readonly dismissals = new Map<string, Dismissal>();
    /** What puts the window's scroll back once an outer part's field closes (#8, `revealField`). */
    private unreveal: ((committed: boolean) => void) | null = null;
    /** The bars whose open field's target a change deleted (`followObjects`): closed at the next `update`. */
    private readonly goneFields = new Set<ObjectBar>();

    constructor(private readonly view: EditorView, private readonly host: ObjectToolbarHost) {
        this.mount = view.dom.parentElement as HTMLElement;
        // One hover for the bars and the formatting row (`tooltip.ts`).
        this.tips = Tooltips.for(this.mount);
        this.slot = LayerSlot.for(view, this.mount);
        this.selectionBar = this.makeBar('selection');
        this.hoverBar = this.makeBar('hover');
        this.mount.append(this.selectionBar.el, this.hoverBar.el);

        this.listen(document, 'mousemove', e => this.pointerAt(e.target as Element | null, e as MouseEvent));
        this.listen(document.documentElement, 'mouseleave', () => this.unhover());
        // Focus moving in or out of the editor and the bars shows or hides the selection's bar.
        const later = () => setTimeout(() => this.refresh(), 0);
        this.listen(document, 'focusin', later);
        // A refused composition takes the focus for a moment and gives it back (`refocusingAfterComposition`): the bar stays.
        this.listen(document, 'focusout', () => setTimeout(() => {
            if (!refocusingAfterComposition(this.view)) {
                this.refresh();
            }
        }, 0));
        // Capturing, so it is known before the key's own command changes the text (`update`).
        // A key whose release the text never sees (the focus moved to a bar) is over at its keyup anywhere.
        // A character made with Alt (Option, AltGr: `{ } [ ] @ \ ~`) is typing; a modifier, a shortcut or an Alt command is not (`typesText`).
        this.listen(view.dom, 'keydown', e => {
            this.keyed = typesText(e as KeyboardEvent);
        }, true);
        this.listen(document, 'keyup', () => {
            this.keyed = false;
        }, true);
        // What Esc dismissed stays dismissed until the caret leaves the object (Daniel, 2026-10-20): a click back
        // into the same object after the focus was away does not bring the bar again — Alt+Enter does.
        // A slot that came free shows the pointer's bar where the pointer rests (the hover cue goes).
        this.unfreed = this.slot.onFreed(() => this.refreshHover());
        this.refresh();
    }

    /** A bar and what it tells the view: Esc dismisses it, a field takes the slot at what it edits. */
    private makeBar(trigger: 'selection' | 'hover'): ObjectBar {
        const events: BarEvents = {
            escape: () => {
                const object = bar.object;
                if (object !== null) {
                    // Hidden until the caret leaves the object; Alt+Enter brings it back.
                    this.dismiss(trigger === 'selection' ? 'bar' : 'hover', object);
                }
                this.view.focus();
            },
            fieldOpened: (object, target, block) => {
                // A block's field names its block by its heading and stands at it: no range drawn (#8).
                if (block !== undefined) {
                    clearPendingRange(this.view);
                } else if (target !== undefined) {
                    showPendingRange(this.view, target.from, target.to);
                } else if (PENDING_OBJECTS.has(object.kind)) {
                    showPendingRange(this.view, object.from, object.to);
                }
                this.fieldOpened(bar, object, target, block);
            },
            fieldClosed: committed => {
                this.fieldGone();
                // An outer part's field scrolled the window to stand in view (#8): the scroll goes back.
                this.unreveal?.(committed);
                this.unreveal = null;
                clearPendingRange(this.view);
                this.refresh();
            },
            fieldResized: () => {
                if (this.fieldKey !== null) {
                    this.slot.contentChanged(this.fieldKey);
                }
            },
            fieldDropped: () => {
                this.fieldGone();
                this.unreveal = null;
                // Dropped in the view's update, where nothing may be dispatched: cleared after it — only
                // this field's range, not one a field that took the slot meanwhile drew (the row's Link…).
                const dropped = pendingRangeId(this.view.state);
                setTimeout(() => {
                    if (!this.destroyed) {
                        clearPendingRange(this.view, dropped);
                    }
                }, 0);
            },
            verbActive: () => this.syncDecorations(),
            refuse: (message, place) => showRefusal(this.view, message, place),
            menuClosed: panel => dismissRefusal(this.view, panel),
        };
        const bar: ObjectBar = new ObjectBar(trigger, events, this.tips);
        return bar;
    }

    /**
     * A bar's verb opened its field: the field takes the slot, at what it
     * edits — the element inside the object (`target`), else (an inline
     * object with the caret in it) the caret's line at the caret, else the
     * object: a block's field stands where the block's bar did, anchored to
     * the block.
     */
    private fieldOpened(bar: ObjectBar, object: EditorObject, target?: { from: number; to: number }, block?: AttributesTarget): void {
        const view = this.view;
        const sel = view.state.selection;
        const range = block !== undefined ? { from: block.pos, to: block.pos + block.node.nodeSize } : target ?? { from: object.from, to: object.to };
        const key = `field@${range.from}-${range.to}`;
        if (this.fieldKey === key && this.slot.current?.key === key) {
            // The next step of the same field, or its refusal's line: the size changed, the claim is the same.
            this.slot.contentChanged(key);
            return;
        }
        this.fieldKey = key;
        // A block's field opens where that block's bar stands, anchored to the block (Daniel, #4 build critique); an inline
        // object's at the object, a selection's at the selection — only where the caret itself is the anchor, at the caret.
        const atCaret = target === undefined && block === undefined && bar === this.selectionBar && sel instanceof TextSelection && !isBlockPlaced(object);
        const head = sel.head;
        // An outer part's field stands under a block that may be far from the caret (#8): the window shows it, and gives the scroll back.
        if (block !== undefined && block.pos !== object.from) {
            this.unreveal = revealField(view, blockAnchor(view, block), bar.el.offsetHeight);
        }
        this.slot.request({
            kind: 'field',
            key,
            el: bar.el,
            anchor: () => {
                if (!bar.editing) {
                    return null;
                }
                const size = view.state.doc.content.size;
                if (block !== undefined) {
                    // At the block the field edits (#8): above it, its lens row with it (`blockFieldAnchor`).
                    return blockFieldAnchor(view, block);
                }
                if (target !== undefined) {
                    return rangeAnchor(view, Math.min(target.from, size), Math.min(target.to, size));
                }
                return atCaret ? caretRect(view, Math.min(head, size)) : bar.object ? anchorOf(view, bar.object) : null;
            },
            valid: () => bar.editing,
            hidden: () => this.barHidden(bar, 'displaced'),
            fit: (room, fresh) => bar.fitField(room, fresh),
            prefer: block === undefined ? undefined : () => 'above',
        }, { force: true });
    }

    /** A bar's field closed or went: its claim ends. */
    private fieldGone(): void {
        if (this.fieldKey !== null) {
            this.slot.release(this.fieldKey);
            this.fieldKey = null;
        }
    }

    update(view: EditorView, prevState?: EditorState): void {
        // A key changed the text: the caret's bar hides while typing and comes back on the next rest.
        if (this.keyed && prevState !== undefined && view.state.doc !== prevState.doc) {
            this.keyed = false;
            this.cancelPending();
            this.matured = null;
            this.typingHold = true;
            this.slot.typing();
        }
        // A field whose target the change deleted (`followObjects`): it closes, nothing written, and says so (#8 review 1).
        for (const bar of this.goneFields) {
            const hint = goneFieldHint(bar.followed);
            this.hideBar(bar);
            this.say(hint, 'neutral');
        }
        this.goneFields.clear();
        this.refresh();
    }

    /** The view applied `transactions` (`appendTransaction`): followed while `act` moves the focus. */
    applied(transactions: readonly Transaction[], newState: EditorState): void {
        let changed = false;
        for (const tr of transactions) {
            this.focusMoves?.appendMapping(tr.mapping);
            changed = changed || tr.docChanged;
        }
        if (changed) {
            this.followDismissals(transactions, newState.doc);
            this.followObjects(transactions, newState.doc);
        }
    }

    /**
     * A change of the document moved what the bars hold a position of (#8 F7,
     * the wave-2 follow-up): the bars' objects, the rested and forced object,
     * and an open field's target and the place it stands at — followed in
     * place (`followAll`), so a host resync that inserts above the object
     * keeps its bar and its open field, what was typed and all, and the
     * commit writes to the same block. A field whose target is gone closes,
     * writing nothing — after this update, from `update`.
     */
    private followObjects(transactions: readonly Transaction[], doc: EditorState['doc']): void {
        const bars = [this.selectionBar, this.hoverBar];
        const items: Followed[] = [];
        for (const bar of bars) {
            if (bar.object !== null) {
                items.push(bar.object);
            }
            items.push(...bar.followed as Followed[]);
        }
        for (const object of [this.matured, this.forced, this.pending?.object ?? null]) {
            if (object !== null) {
                items.push(object);
            }
        }
        if (items.length === 0) {
            return;
        }
        const gone = followAll(items, transactions, doc);
        if (gone.size === 0) {
            return;
        }
        for (const bar of bars) {
            if (bar.editing && (bar.followed.some(f => gone.has(f as Followed)) || (bar.object !== null && gone.has(bar.object)))) {
                this.goneFields.add(bar);
            }
        }
        this.matured = this.matured !== null && gone.has(this.matured) ? null : this.matured;
        this.forced = this.forced !== null && gone.has(this.forced) ? null : this.forced;
        if (this.pending !== null && gone.has(this.pending.object)) {
            this.cancelPending();
        }
    }

    /** Esc: `object`'s layer hides until the caret leaves it; what the dismissal is about is kept for `followDismissals`. */
    private dismiss(trigger: 'bar' | 'hover', object: EditorObject): void {
        this.dismissals.set(barKey(trigger, object), { trigger, kind: object.kind, from: object.from });
        this.slot.dismiss(barKey(trigger, object));
    }

    /**
     * A change of the document moved what Esc's dismissals are about (the keys
     * hold a position): a host resync that inserts above the caret's object
     * must not end the dismissal, so the keys follow the change — all at once,
     * so two that shift onto each other do not collide. An object the change
     * deleted has nothing to be dismissed from: its dismissal ends. Whether it
     * is gone is read from the NEW document — a step that replaces a node's
     * markup at its own position (the fidelity repair on a block's first edit)
     * reports the position deleted though the object is still there: a node
     * object is gone where no object of its kind stands at the mapped place, a
     * mark's run where a step deleted across it.
     */
    private followDismissals(transactions: readonly Transaction[], doc: EditorState['doc']): void {
        const live = new Set(this.slot.dismissedOf(''));
        const moves = new Map<string, string | null>();
        const next = new Map<string, Dismissal>();
        for (const [key, d] of this.dismissals) {
            if (!live.has(key)) {
                continue;
            }
            let pos = d.from;
            let across = false;
            for (const tr of transactions) {
                const result = tr.mapping.mapResult(pos, 1);
                pos = result.pos;
                across = across || result.deletedAcross;
            }
            if (this.dismissedGone(d, pos, across, doc)) {
                this.slot.caretLeft(key);
                continue;
            }
            const moved: Dismissal = { ...d, from: pos };
            moves.set(key, barKey(d.trigger, moved));
            next.set(barKey(d.trigger, moved), moved);
        }
        this.slot.rekeyAll(moves);
        this.dismissals.clear();
        for (const [key, d] of next) {
            this.dismissals.set(key, d);
        }
    }

    /** Whether what `d` is about is gone from `doc`, the change having mapped its place to `pos` (`followDismissals`). */
    private dismissedGone(d: Dismissal, pos: number, deletedAcross: boolean, doc: EditorState['doc']): boolean {
        if (d.kind === 'link' || d.kind === 'span' || d.kind === 'styled' || d.kind === 'holder') {
            return deletedAcross;
        }
        const node = pos <= doc.content.size ? doc.nodeAt(pos) : null;
        return node === null || objectOfNode(node, pos)?.kind !== d.kind;
    }

    destroy(): void {
        this.destroyed = true;
        this.cancelPending();
        clearTimeout(this.hoverTimer);
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.unfreed();
        this.cue(null);
        this.selectionBar.hide();
        this.selectionBar.el.remove();
        this.slot.destroy();
        this.tips.release();
        this.hoverBar.el.remove();
    }

    /**
     * `Alt+Enter`: the bar of the object at the caret, now, the focus on its
     * first verb. Where there is none but the caret is in code, a key,
     * emphasis … without a `{…}` (`attributeHolderAt`), a bar of its own with
     * **Attributes…** — never drawn on a caret rest, kept while the selection
     * stays in its run (`selectionObject`). `'none'` where there is neither —
     * the only answer the key says so for (`NO_TARGET_HINT`); `{ title }`
     * where there is an object and no bar could be drawn for it — the
     * presentation's title says what it is (led by its label where the title
     * does not name the object), so the key is not silent there.
     */
    openFromKeyboard(): 'opened' | 'none' | { title: string } {
        const object = objectAtSelection(this.view.state) ?? (currentReadsAttrs() ? attributeHolderAt(this.view.state).inline?.object ?? null : null);
        if (object === null) {
            return 'none';
        }
        this.cancelPending();
        this.matured = object;
        this.forced = object;
        // It takes the slot whatever holds it, a dismissal of this object's bar included.
        this.refresh(true);
        if (!this.selectionBar.visible) {
            const presentation = this.present(object);
            // It leads with what the object is; a title that already names it stands as it is.
            const names = presentation.title.toLowerCase().includes(presentation.label.toLowerCase());
            return { title: names ? presentation.title : `${presentation.label}: ${presentation.title}` };
        }
        this.selectionBar.focusFirst();
        return 'opened';
    }

    /**
     * Esc in the text (F1, Daniel 2026-10-19): while the caret's bar shows, it
     * hides until the caret leaves the object, and the key is consumed; with
     * no bar up, VS Code's Esc is untouched.
     */
    escapeInText(): boolean {
        const claim = this.slot.current;
        const object = this.selectionBar.object;
        if (claim === null || claim.kind !== 'bar' || claim.el.hidden || object === null) {
            return false;
        }
        this.dismiss('bar', object);
        return true;
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    /** Whether the control that has the focus is `object`'s own (`focusPlace.ts`): its source box, its panel. */
    private holdsFocusedControl(object: EditorObject): boolean {
        const place = focusPlace(this.view);
        return place.kind === 'control' && place.owner?.pos === object.from;
    }

    /**
     * The object the selection's bar is for, by where the focus is
     * (`focusPlace.ts`): the selection's while the text, what else in it can
     * take the focus, or the editor's own controls have it — but not another
     * inline field than the bars' own: the row's **Insert → Link…** field is
     * the one bar then; while a node view's control has it — a source box, the
     * properties panel — the selection is hidden behind it, and the bar is the
     * control's block's; elsewhere, none. A bar's open field counts as the
     * bars' however the focus left: it keeps itself open while the window is
     * away (`InlineField`).
     */
    private selectionObject(): EditorObject | null {
        const place: FocusPlace = this.selectionBar.editing || this.hoverBar.editing ? { kind: 'chrome', field: false } : focusPlace(this.view);
        switch (place.kind) {
            case 'text':
            case 'content':
                return objectAtSelection(this.view.state) ?? this.maturedHolder();
            case 'chrome':
                return place.field ? null : objectAtSelection(this.view.state) ?? this.maturedHolder();
            case 'control':
                return place.owner === null ? null : objectOfNode(place.owner.node, place.owner.pos);
            case 'away':
                return null;
        }
    }

    /**
     * Whether the selection says where the caret is, for ending a dismissal: by
     * the selection, not by where the focus is — a node view's control focused
     * while the selection moved ends it too. Not while the window is away (the
     * caret is where it was) or the focus is in the bars' own chrome (a field).
     */
    private selectionSpeaks(): boolean {
        if (this.selectionBar.editing || this.hoverBar.editing) {
            return false;
        }
        const kind = focusPlace(this.view).kind;
        return kind !== 'away' && kind !== 'chrome';
    }

    /** The bare holder `Alt+Enter` opened a bar for (`openFromKeyboard`), while the selection is still in its run. */
    private maturedHolder(): EditorObject | null {
        return this.matured?.kind === 'holder' ? currentObject(this.view.state, this.matured) : null;
    }

    private cancelPending(): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending = null;
        }
    }

    // -- the selection's bar ---------------------------------------------------

    /**
     * The caret's bar, through the slot (`placement.ts`): a block object's at
     * once, an inline object's once the caret has rested in it `REST_MS`; none
     * while the selection wants the bubble (one layer at a time), none for an
     * object whose bar Esc dismissed until the caret leaves it — `force`
     * (`Alt+Enter`) overrides both.
     */
    private refresh(force = false): void {
        if (this.destroyed) {
            return;
        }
        const object = this.selectionObject();
        const key = object === null ? null : barKey('bar', object);
        // The selection left a dismissed object: its dismissal ends. The focus away, or in the
        // bars' own chrome, says nothing: it is back where it was.
        if (this.selectionSpeaks()) {
            for (const dismissed of this.slot.dismissedOf('bar@')) {
                if (dismissed !== key) {
                    this.slot.caretLeft(dismissed);
                }
            }
        }
        if (object === null) {
            this.cancelPending();
            this.matured = null;
            this.forced = null;
            this.hideBar(this.selectionBar);
        } else if (isBlockObject(object) || sameObject(object, this.matured)) {
            this.cancelPending();
            this.matured = isBlockObject(object) ? null : object;
            this.forced = sameObject(object, this.forced) ? this.forced : null;
            // The refusals that need no presentation first: it asks the host for lenses and code actions.
            // One thing at a time: a non-empty selection has the bubble, not the caret's bar.
            const refused = (!force && (this.slot.holds('bubble') || selectionWantsBubble(this.view)))
                // Esc dismissed it, a row menu is open, a field holds the slot.
                || (!this.selectionBar.editing && !this.slot.wouldGrant({ kind: 'bar', key: barKey('bar', object), el: this.selectionBar.el }, { force }));
            const presentation = refused ? null : this.present(object);
            // Alt+Enter draws what a rest does not: the element's Attributes of Bold…, a breadcrumb of two bare parts (F6).
            const keyed = presentation !== null && this.forced !== null && (presentation.verbs.some(v => v.id === 'inline-attributes') || presentation.restless === true);
            this.forced = keyed || presentation === null ? this.forced : null;
            if (presentation === null) {
                this.hideBar(this.selectionBar);
            } else if (barless(object, presentation) && !keyed) {
                // A heading's verbs are other extensions' lenses and actions; with none, no bar.
                this.hideBar(this.selectionBar);
            } else {
                this.selectionBar.show(object, presentation);
                if (this.selectionBar.editing) {
                    // Its field holds the slot, at what it edits: placed again, not replaced by the bar.
                    this.slot.replace();
                } else if (!this.slot.request(this.claim(this.selectionBar, 'bar', object), { force })) {
                    this.selectionBar.hide();
                }
            }
        } else if (!sameObject(object, this.pending?.object ?? null)) {
            // A new inline object: nothing until the caret has rested in it.
            this.cancelPending();
            this.matured = null;
            this.forced = null;
            this.hideBar(this.selectionBar);
            this.armRest(object);
        }
        this.refreshHover();
        this.syncDecorations();
    }

    /** The caret's rest in `object`: after `REST_MS` its bar asks for the slot. */
    private armRest(object: EditorObject): void {
        this.pending = {
            object,
            timer: setTimeout(() => {
                this.pending = null;
                this.matured = object;
                this.refresh();
            }, REST_MS),
        };
    }

    /** `bar`'s claim on the slot for `object`. */
    private claim(bar: ObjectBar, kind: 'bar' | 'hover', object: EditorObject): LayerClaim {
        return {
            kind,
            key: barKey(kind, object),
            el: bar.el,
            anchor: () => (bar.object === null ? null : anchorOf(this.view, this.partAnchor(bar) ?? bar.object)),
            // An object in a note's body or a sidebar floated into the margin: its bar stands there, at it (#15).
            inMargin: () => bar.object !== null && floatedAround(this.view, (this.partAnchor(bar) ?? bar.object).from) !== null,
            valid: () => bar.object !== null,
            hidden: reason => this.barHidden(bar, reason),
            fit: (room, fresh) => {
                if (fresh) {
                    bar.refit();
                }
                bar.fit(room);
            },
        };
    }

    /** The block `bar` stands at instead of its object (`ObjectBar.anchorFrom`, #8 review 1): a heading in its admonition; `null` for its object. */
    private partAnchor(bar: ObjectBar): EditorObject | null {
        const at = bar.anchorFrom;
        const node = at === null || at >= this.view.state.doc.content.size ? null : this.view.state.doc.nodeAt(at);
        return node === null ? null : objectOfNode(node, at as number);
    }

    /**
     * The slot hid `bar`: another layer took it, Esc, typing. The caret's bar
     * comes back only on its own next rest — never by the slot.
     */
    private barHidden(bar: ObjectBar, reason: HideReason): void {
        if (bar === this.selectionBar && (reason === 'displaced' || reason === 'typing')) {
            this.cancelPending();
            this.matured = null;
        }
        bar.hide();
        this.syncDecorations();
    }

    /** Hide `bar`, letting go of the slot where it holds it. */
    private hideBar(bar: ObjectBar): void {
        const claim = this.slot.current;
        if (claim !== null && claim.el === bar.el) {
            this.slot.release(claim.key);
        }
        bar.hide();
    }

    /**
     * What the bars shown need drawn in the document: the tint of the caret's
     * row or column of the table whose bar shows, while the verb acting on it
     * is active (`activeAxis`, `Verb.axis`). It is a decoration, so the view is
     * told in a transaction of its own — after this update, which may not
     * dispatch one. A tint changes no box, so nothing moves.
     */
    private syncDecorations(): void {
        const wanted = (): BarDecor => {
            const bar = this.selectionBar;
            const axis = bar.visible && bar.object?.kind === 'table' ? bar.activeAxis() : undefined;
            return { tint: axis === undefined || bar.object === null ? null : { table: bar.object.from, axis } };
        };
        if (sameDecor(wanted(), decorKey.getState(this.view.state) ?? NO_DECOR)) {
            return;
        }
        queueMicrotask(() => {
            const next = wanted();
            if (!this.destroyed && !sameDecor(next, decorKey.getState(this.view.state) ?? NO_DECOR)) {
                this.view.dispatch(this.view.state.tr.setMeta(decorKey, next));
            }
        });
    }

    // -- the pointer's bar -----------------------------------------------------

    /**
     * Whether the pointer is on the pointer's bar. By where it is, not by what
     * the event names: the bar ignores the pointer for a moment after it appears
     * or moves (`data-inert`), and the event then names what is under it — the
     * text, which would start the bar's way out under a pointer that never moved.
     */
    private onHoverBar(e: MouseEvent): boolean {
        if (!this.hoverBar.visible) {
            return false;
        }
        const r = this.hoverBar.el.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    }

    private pointerAt(target: Element | null, e: MouseEvent): void {
        if (target === null || typeof target.closest !== 'function') {
            return;
        }
        if (this.hoverBar.el.contains(target) || this.onHoverBar(e)) {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = undefined;
            return;
        }
        // A block's lens row is the block's, for the pointer: crossing it on
        // the way to the bar above must not hide the bar.
        const before = target.closest<HTMLElement>('.mep-lens-row');
        let below = before?.parentElement === this.view.dom ? before.nextElementSibling : null;
        while (below instanceof HTMLElement && below.classList.contains('mep-lens-row')) {
            below = below.nextElementSibling;
        }
        const atom = below instanceof HTMLElement && below.classList.contains('mep-atom') ? below : target.closest<HTMLElement>('.mep-atom');
        if (atom && atom.parentElement === this.view.dom) {
            clearTimeout(this.hoverTimer);
            this.hoverTimer = undefined;
            if (atom !== this.hovered) {
                this.hovered = atom;
                this.endHoverDismissals();
                this.refreshHover();
            }
            return;
        }
        if (this.hovered && this.hoverTimer === undefined) {
            this.hoverTimer = setTimeout(() => this.unhover(), HOVER_GRACE_MS);
        }
    }

    private unhover(): void {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = undefined;
        this.hovered = null;
        this.endHoverDismissals();
        this.refreshHover();
    }

    /**
     * The pointer left the block it was on, or is on another: Esc's dismissal of
     * the pointer's bar ends (`escape`). Only the caret's bar was ever cleared,
     * so a block dismissed once never had its bar again.
     */
    private endHoverDismissals(): void {
        for (const key of this.slot.dismissedOf('hover@')) {
            this.slot.caretLeft(key);
        }
    }

    /** The block object whose element the pointer is on, found by the element ProseMirror drew for it. */
    private hoveredObject(): EditorObject | null {
        const el = this.hovered;
        if (el === null || !this.view.dom.contains(el)) {
            return null;
        }
        const doc = this.view.state.doc;
        let offset = 0;
        for (let i = 0; i < doc.childCount; i++) {
            const child = doc.child(i);
            if (this.view.nodeDOM(offset) === el) {
                const object = objectOfNode(child, offset);
                return object !== null && isBlockObject(object) ? object : null;
            }
            offset += child.nodeSize;
        }
        return null;
    }

    /**
     * The pointer's bar, through the slot: the caret's layer wins (Daniel,
     * 2026-10-19) — it shows only while the slot is empty; while another layer
     * holds it, the block under the pointer carries the hover cue
     * (`mep-hover-cue`) instead, and its bar shows once the slot comes free.
     */
    private refreshHover(): void {
        const object = this.hoveredObject();
        // The cheap reasons first: the presentation asks for code actions and lenses.
        // While a node view's control has the focus nothing else is offered: the control is the edit.
        const presentation = object === null || (this.selectionBar.visible && sameObject(object, this.selectionBar.object))
            || focusPlace(this.view).kind === 'control'
            ? null
            : this.present(object);
        // A dismissed pointer's bar is not coming: no cue promises it.
        const dismissed = object !== null && this.slot.dismissedOf('hover@').includes(barKey('hover', object));
        // Typing hid the caret's bar and its rest is to bring it back: the pointer's bar waits too, at the cue.
        const typingHold = this.typingHold && this.pending !== null && !this.hoverBar.editing;
        if (!typingHold) {
            this.typingHold = false;
        }
        if (object === null || presentation === null || barless(object, presentation) || dismissed) {
            this.cue(null);
            this.hideBar(this.hoverBar);
        } else if (typingHold) {
            this.cue(this.hovered);
            this.hideBar(this.hoverBar);
        } else if (!this.hoverBar.editing && !this.slot.wouldGrant({ kind: 'hover', key: barKey('hover', object), el: this.hoverBar.el })) {
            // Another layer holds the slot, or a row menu is open: the cue, and no bar drawn only to be hidden.
            this.cue(this.hovered);
            this.hoverBar.hide();
        } else {
            this.hoverBar.show(object, presentation);
            if (this.hoverBar.editing) {
                // Its field holds the slot: placed again, not replaced by the bar.
                this.slot.replace();
            } else if (this.slot.request(this.claim(this.hoverBar, 'hover', object))) {
                this.cue(null);
            } else {
                this.hoverBar.hide();
                this.cue(this.hovered);
            }
        }
        this.syncDecorations();
    }

    /** The hover cue on `atom`, and on no other block. */
    private cue(atom: HTMLElement | null): void {
        if (atom === this.cued) {
            return;
        }
        this.cued?.classList.remove('mep-hover-cue');
        atom?.classList.add('mep-hover-cue');
        this.cued = atom;
    }

    // -- the verbs -------------------------------------------------------------

    /**
     * Run `make` on the object as it is now; nothing when it is gone. The focus
     * goes back into the text **first**: a field's commit has already removed
     * the input, and the dispatch's own refresh, seeing the focus on the body,
     * would hide the bar and re-arm the inline delay — the bar blinking out and
     * coming back late after every change of a URL or a source. The hint that
     * it was done is said only when the state moved: a transaction a plugin's
     * filter refused leaves the view on the very state it had, and the filter
     * has said why beside the caret — the success hint would cover that, and
     * be untrue.
     */
    private act(object: EditorObject, make: (current: EditorObject) => boolean, hint?: string, removes = false): void {
        // What the verb was offered for, read before the focus moves: leaving a
        // source box commits it, which rewrites its block or — emptied — removes
        // it, and the next block would then stand where it stood. The block is
        // followed through the commit; one the commit removed is done with — and
        // for a verb that removes (`removes`), done as asked, so it says so.
        const offered = currentObject(this.view.state, object);
        const moved = new Mapping();
        this.focusMoves = moved;
        try {
            this.view.focus();
        } finally {
            this.focusMoves = null;
        }
        if (offered === null) {
            return;
        }
        const from = moved.map(offered.from, 1);
        const to = moved.map(offered.to, -1);
        if (to <= from) {
            if (removes && hint !== undefined) {
                showChangeHint(this.view, undoHint(hint));
            }
            return;
        }
        const before = this.view.state;
        const current = currentObject(before, { ...offered, from, to });
        if (current !== null && make(current) && this.view.state !== before && hint !== undefined) {
            showChangeHint(this.view, undoHint(hint));
        }
    }

    private say(text: string, tone: HintTone): void {
        showHint(this.view, text, tone);
    }

    /**
     * The object's own verbs and — for a whole top-level block — the lenses
     * other extensions put on it as verbs (`lenses.ts`) and the code actions
     * they offer for its lines, as the text editor's light bulb would offer
     * them there, in the slots' order with the slots' dividers (`arrange`,
     * `verbs.ts`): other extensions' verbs after the object's own, before the
     * one that destroys. While the block's own control has the focus — its
     * source box, the properties panel — only its own verbs: the control is
     * the edit, and another extension's command would run on what the box has
     * not applied yet.
     */
    private present(object: EditorObject): Presentation {
        const own = this.withCrumbs(object, this.withInlineAttributes(object, this.ownPresentation(object)));
        const at = this.actionsAt(object);
        if (at === null || this.holdsFocusedControl(object)) {
            return { ...own, verbs: arrange(own.verbs) };
        }
        const lenses = this.lensVerbs(this.host.lensesAt(at));
        const actions = this.host.codeActionsAt(at).map((item): Verb => {
            const name = lensName(item.title);
            return {
                id: `code-action:${item.id}`,
                label: item.title,
                title: item.kind ? `${name} (${item.kind}, from another extension)` : `${name} (from another extension)`,
                slot: 'actions',
                refusal: item.refusal ?? null,
                run: () => {
                    this.view.focus();
                    this.host.runCodeAction(item.id);
                },
            };
        });
        // Within the actions slot: the lenses, the code actions, then the **Actions** choice holding the lenses that did not fit.
        const inline = lenses.filter(v => v.id !== 'lens-overflow');
        const overflow = lenses.filter(v => v.id === 'lens-overflow');
        return { ...own, verbs: arrange([...own.verbs, ...inline, ...actions, ...overflow]) };
    }

    /**
     * Where the lenses and code actions `object`'s bar carries are asked for:
     * a whole top-level block's own — and, for a list item's bar or a heading's
     * in a quote, the top-level list's or quote's (#8, Daniel: nothing the
     * list's bar offered is lost to the item's). `null` for none.
     */
    private actionsAt(object: EditorObject): number | null {
        const state = this.view.state;
        if (isTopLevelBlock(state, object)) {
            return object.from;
        }
        if (isMarkObject(object) || !(object.kind === 'list_item' || object.kind === 'heading' || object.kind === 'block_attrs') || object.from >= state.doc.content.size) {
            return null;
        }
        const $pos = state.doc.resolve(object.from);
        if ($pos.depth < 1) {
            return null;
        }
        const top = $pos.node(1).type.name;
        return top === 'bullet_list' || top === 'ordered_list' || top === 'blockquote' ? $pos.before(1) : null;
    }

    /**
     * The breadcrumb on `object`'s bar (#8), where the editor holds two
     * levels (`crumbsAt`) and `object` is the current part — a list item, a
     * heading in a quote, an inline element with a literal — or the wrapper
     * whose heading it is (an admonition, a container: their title part).
     * Else `own` as it is: a one-part bar. The parts open their own fields,
     * the outer one at its block; an admonition's Type▾ and Edit title… act
     * on the outer part (`outer`). A breadcrumb of two bare parts draws no bar
     * on a rest (F6, `restless`).
     */
    private withCrumbs(object: EditorObject, own: Presentation): Presentation {
        const crumbs = currentReadsAttrs() ? crumbsAt(this.view.state) : null;
        if (crumbs === null || crumbs.outer === null || !crumbsFor(object, crumbs)) {
            return own;
        }
        const title = crumbs.outer.target === null && crumbs.outer.refusal === null;
        const outer: CrumbView = title
            ? { role: 'outer', name: own.label, short: own.short, literal: null, verb: null, opens: '' }
            : this.crumbView(crumbs.outer);
        const current = this.crumbView(crumbs.current);
        const blockBar = object.kind === 'list_item' || object.kind === 'heading' || object.kind === 'block_attrs';
        // An admonition's Type▾ and Edit title…, a container's Edit classes…, act on the outer part: never the first focus (#14 on two-part bars).
        const ownVerbs = title ? own.verbs.map(v => (v.slot === 'type' || v.slot === 'edit' ? { ...v, outer: true as const } : v)) : own.verbs;
        return {
            ...own,
            crumbs: { outer, current },
            name: crumbName(current, outer),
            restless: blockBar && current.literal === null && outer.literal === null,
            ...(title ? { anchorFrom: crumbs.current.from } : {}),
            verbs: this.withCrumbRemove(object, ownVerbs, crumbs, title),
        };
    }

    /**
     * Remove on a two-part bar (#8, section 4.4), in place of the object's own
     * Remove attributes: **Remove attributes of List** where one part carries
     * a literal; **Remove attributes ▾** naming each part, the current one
     * first, where both do — an inline part's entry saying what stays
     * (`formatting stays`); on an admonition or a container whose heading
     * carries one, one **Remove ▾**: the heading's attributes, then — after a
     * divider — the wrapper, its content kept. Each entry reads its part again
     * when chosen (`removePart`), never a position held from before.
     */
    private withCrumbRemove(object: EditorObject, verbs: Verb[], crumbs: Crumbs, title: boolean): Verb[] {
        const outer = crumbs.outer as CrumbPart;
        const current = crumbs.current;
        // What stays, in a word (#8 review 1, W2/W3): "item" for a list item, else the part's own name.
        const stays = (part: CrumbPart) => (part.name === BLOCK_NAMES.list_item ? 'item' : part.name.toLowerCase());
        const removes = (part: CrumbPart) => `Removes the ${part.name.toLowerCase()}'s attributes; the ${stays(part)} stays.`;
        const entryOf = (part: CrumbPart): MenuEntry => ({
            id: `remove-${part.role}`,
            label: part.name,
            code: part.literal ?? undefined,
            keys: part.target !== null && 'object' in part.target ? staysOf(part.target) ?? 'text stays' : `${stays(part)} stays`,
            title: removes(part),
            run: () => this.removePart(object, part),
        });
        if (title) {
            const wrapper = verbs.find(v => v.slot === 'destroy');
            if (current.literal === null || wrapper === undefined || wrapper.run === undefined) {
                return verbs;
            }
            const unwrap = wrapper.run;
            const keep = object.kind === 'container' ? 'Container, keep content' : 'Admonition, keep content';
            const remove: Verb = {
                id: 'remove-menu',
                label: wording({ verb: 'Remove', noun: '' }).label,
                title: 'Choose what to remove',
                slot: 'destroy',
                menu: [
                    { ...entryOf(current), label: `Attributes of ${current.name}` },
                    { id: 'remove-wrapper', label: keep, title: wrapper.title, separated: true, run: unwrap },
                ],
            };
            return [...verbs.filter(v => v !== wrapper), remove];
        }
        // The object's own Remove of its literal gives way: a styled run's, a span's, a block's one-part Remove attributes.
        const rest = verbs.filter(v => v.id !== 'remove-attributes');
        const carrying = [current, outer].filter(p => p.literal !== null && (p.target !== null));
        if (carrying.length === 0) {
            return rest;
        }
        // In the Remove slot, before the verb that destroys ("Delete note"): the destroying verb stays last (#15 critique).
        const destroys = rest.findIndex(v => v.slot === 'destroy');
        const placed = (remove: Verb): Verb[] => (destroys < 0 ? [...rest, remove] : [...rest.slice(0, destroys), remove, ...rest.slice(destroys)]);
        if (carrying.length === 1) {
            const part = carrying[0];
            return placed({
                id: 'remove-attributes',
                label: `Remove attributes of ${part.name}`,
                title: removes(part),
                slot: 'destroy',
                run: () => this.removePart(object, part),
            });
        }
        return placed({
            id: 'remove-attributes',
            label: wording({ verb: 'Remove', noun: 'attributes', titled: false }).label,
            title: 'Choose whose attributes to remove',
            slot: 'destroy',
            menu: carrying.map(entryOf),
        });
    }

    /**
     * Remove the literal of the breadcrumb's part `part` was (#8): its part
     * read again by its role from the state as it is once the focus is back —
     * never a position held from when the bar was drawn — and refused at the
     * Remove control, nothing removed, where that part is gone or its literal
     * changed meanwhile (a resync). The hint names the part.
     */
    private removePart(object: EditorObject, part: CrumbPart): void {
        const done = attributesRemovedHint(part.name);
        // Every refusal stands at the Remove control that was pressed (#8 review 1), never silent.
        const refuse = (message: Said) => {
            const el = this.selectionBar.el.querySelector<HTMLElement>('[data-verb="remove-attributes"], [data-verb="remove-menu"]');
            if (el !== null && !el.hidden) {
                showRefusal(this.view, message, { at: 'control', el });
            } else {
                showRefusal(this.view, message);
            }
        };
        this.act(object, () => {
            const crumbs = crumbsAt(this.view.state);
            const now = crumbs === null ? null : part.role === 'current' ? crumbs.current : crumbs.outer;
            if (now === null || now.name !== part.name || now.literal !== part.literal || now.target === null) {
                refuse(`Not removed: the ${part.name.toLowerCase()}'s attributes changed meanwhile — choose Remove again.`);
                return false;
            }
            const target = now.target;
            if ('pos' in target) {
                const made = commitAttributes(this.view.state, target, '');
                if (made === null) {
                    return false;
                }
                if ('refusal' in made) {
                    refuse(made.refusal);
                    return false;
                }
                this.view.dispatch(made.tr);
                return true;
            }
            const run = literalObjectOf(currentObject(this.view.state, target.object));
            const tr = run === null ? null : run.kind === 'span' ? removeSpanTransaction(this.view.state, run as Extract<EditorObject, { kind: 'span' }>) : changeInlineLiteralTransaction(this.view.state, run, '');
            if (tr === null) {
                const why = run === null || run.kind === 'span' ? null : changeInlineLiteralRefusal(this.view.state, run, '');
                refuse(why ?? `Not removed: the ${part.name.toLowerCase()}'s attributes changed meanwhile — choose Remove again.`);
                return false;
            }
            this.view.dispatch(tr);
            return true;
        }, done);
    }

    /** A block or inline part of the breadcrumb as its button: its field — the one every route opens — or why it has none. */
    private crumbView(part: CrumbPart): CrumbView {
        const name = part.name;
        const base = {
            id: `crumb-${part.role}`,
            label: `Attributes of ${name}…`,
            title: attributesTip(name, part.literal),
            slot: 'attributes' as const,
        };
        const opens = part.anchor === 'run' && part.target !== null && 'object' in part.target
            ? `at the ${holderNames(part.target).noun}`
            : `under the ${name === BLOCK_NAMES.list_item ? 'item' : name.toLowerCase()}`;
        let verb: Verb;
        if (part.target === null) {
            verb = { ...base, refusal: part.refusal ?? NO_BLOCK_ATTRS_REFUSAL };
        } else if ('pos' in part.target) {
            // A copy, followed while its field is open (F7): the field commits to it and stands at it — the cached part is the state's.
            const target = { ...part.target };
            verb = { ...base, field: attributesStep(this.view, target), anchorBlock: target };
        } else {
            const at = { holder: part.target.holder, object: { ...part.target.object } };
            // A note's field stands at its reference (#15 F4), a copy followed with it.
            verb = { ...base, field: holderAttributesStep(this.view, at), target: at.object.kind === 'note' ? noteFieldRange(at.object) : at.object };
        }
        return { role: part.role, name, literal: part.literal, verb, opens };
    }

    /**
     * The object's own verbs and, beside its Attributes…, **Attributes of Bold…**
     * for the element inside it the caret is in — bold in a table's cell, code
     * in a link (`holderInside`, the rule the menu reads) — whose field is the
     * one every route opens (`holderAttributesStep`), headed by the element.
     */
    private withInlineAttributes(object: EditorObject, own: Presentation): Presentation {
        const inside = currentReadsAttrs() ? holderInside(this.view.state, object) : null;
        if (inside === null) {
            return own;
        }
        const names = holderNames(inside);
        const name = `Attributes of ${names.label}`;
        // Headed by the element, not by the object whose bar it is on: `Bold · Attributes` (`attributesField`).
        const step = holderAttributesStep(this.view, inside);
        const verb: Verb = {
            id: 'inline-attributes',
            label: `${name}…`,
            title: attributesTip(names.label, literalOfObject(inside.object), ' Written right after it.'),
            slot: 'attributes',
            field: step,
            // The run itself: followed with the field while it is open (F7).
            target: inside.object,
        };
        return { ...own, verbs: [...own.verbs, verb] };
    }

    /**
     * Lenses as verbs: each its title, running its command. Past
     * `LENS_VERBS_INLINE` the first ones stay and the rest are one **Actions**
     * verb, a choice of them. A lens without a command is shown, and refused:
     * it is what the other extension shows there, and runs nothing.
     */
    private lensVerbs(items: readonly LensItem[]): Verb[] {
        const run = (id: string) => {
            this.view.focus();
            this.host.runLens(id);
        };
        const verbs = (items.length > LENS_VERBS_INLINE ? items.slice(0, LENS_VERBS_INLINE - 1) : items).map((item, k): Verb => {
            const label = lensName(item.title);
            const id = item.id;
            return {
                id: `lens:${id ?? `text-${k}`}`,
                label: item.title,
                title: `${item.tooltip ?? label} (from another extension)`,
                slot: 'actions',
                refusal: id === undefined ? 'The extension that shows it gave it no action to run.' : null,
                run: () => {
                    if (id !== undefined) {
                        run(id);
                    }
                },
            };
        });
        if (items.length > LENS_VERBS_INLINE) {
            const rest = items.slice(LENS_VERBS_INLINE - 1).filter((item): item is LensItem & { id: string } => item.id !== undefined);
            verbs.push({
                id: 'lens-overflow',
                label: 'Actions',
                title: 'More from other extensions',
                slot: 'actions',
                refusal: rest.length === 0 ? 'None of the others runs anything.' : null,
                choice: {
                    value: '',
                    label: 'Action',
                    options: [{ value: '', label: 'Choose an action…' }, ...rest.map(item => ({ value: item.id, label: lensName(item.title) }))],
                    commit: value => {
                        if (value === '') {
                            this.view.focus();
                            return;
                        }
                        run(value);
                    },
                },
            });
        }
        return verbs;
    }

    private ownPresentation(object: EditorObject): Presentation {
        const view = this.view;
        const host = this.host;
        const dispatch = view.dispatch.bind(view);
        switch (object.kind) {
            case 'note': {
                const name = object.node.type.name as NoteNodeName;
                const sidebar = isSidebar(name);
                const source = noteSource(object.node);
                const note = literalObjectOf(object) as LiteralObject;
                const literal = literalOfObject(note);
                const noun = NOTE_LABELS[name].toLowerCase();
                // A sidebar's text stays in the sentence (Remove); a note's own text goes, its reference staying (Delete).
                const remove = sidebar ? wording({ verb: 'Remove', noun: 'sidebar', keeps: ', keep text' }) : wording({ verb: 'Delete', noun: 'note' });
                const removeId = sidebar ? 'remove-note' : 'delete-note';
                // F5: "Remove attributes, keep note" before the verb that destroys, only while there is a literal;
                // at 520 px ", keep note" goes first ("Remove attributes").
                const keeps = wording({ verb: 'Remove', noun: 'attributes', keeps: sidebar ? ', keep sidebar' : ', keep note', titled: false });
                const removeAttributes: Verb[] = literal === null ? [] : [{
                    id: 'remove-attributes',
                    label: keeps.label,
                    short: wording({ verb: 'Remove', noun: 'attributes', titled: false }).label,
                    title: `The {…} goes; the ${noun} stays.`,
                    slot: 'destroy',
                    refusal: refusalOnce(view.state, `remove-attributes@${object.from}:${object.to}`, () => changeInlineLiteralRefusal(view.state, note, '')),
                    run: () => this.apply(object, current => {
                        const now = literalObjectOf(current);
                        return now === null ? null : changeInlineLiteralTransaction(view.state, now, '');
                    }, attributesRemovedHint(NOTE_LABELS[name])),
                }];
                const closing = sidebar ? (name === 'left_sidebar' ? '$' : '@') : name === 'sidenote' ? '++' : '!!';
                return {
                    label: NOTE_LABELS[name],
                    // The literal is read with the label, as an image's is (`Marginal note {.tipp}`).
                    ...(literal === null ? {} : { code: literal }),
                    title: `${sidebar ? 'A sidebar: its text is set beside the main text.' : 'A note: its reference is in the sentence, its text beside it.'}${literal === null ? '' : ` · ${literal}`}`,
                    verbs: [
                        this.markAttributesVerb(note, 'note-attributes', VERB.attributes,
                            typed => `The ${noun}'s {…}, written right after its closing ${closing}: ${typed} (Enter to set, Esc to cancel).`),
                        ...removeAttributes,
                        {
                            id: removeId,
                            label: remove.label,
                            short: remove.short,
                            title: sidebar
                                ? 'The sidebar goes; its text stays in the sentence, with its formatting.'
                                : 'The note goes; its reference stays in the sentence, with its formatting. The note\'s own text is dropped.',
                            slot: 'destroy',
                            refusal: refusalOnce(view.state, `${removeId}@${object.from}:${object.to}`, () => unwrapNoteRefusal(view.state, name)),
                            run: () => this.act(object, () => unwrapNote(name)(view.state, dispatch), remove.done),
                        },
                        {
                            id: 'convert-note',
                            label: CONVERT_LABELS[name],
                            title: `Make it a ${NOTE_LABELS[NOTE_CONVERSION[name]].toLowerCase()}; its text and attributes stay.`,
                            slot: 'type',
                            refusal: refusalOnce(view.state, `convert-note@${object.from}:${object.to}`, () => convertNoteRefusal(view.state, object.from)),
                            run: () => this.act(object, current => {
                                const tr = convertNoteTransaction(view.state, current.from);
                                if (tr) {
                                    dispatch(tr);
                                }
                                return tr !== null;
                            }),
                        },
                        {
                            id: 'edit-source',
                            label: VERB.editSource,
                            title: `Edit ${source} as Markdown (Enter to apply, Esc to cancel).`,
                            slot: 'source',
                            refusal: source.includes('\n') ? `It holds a line break, which a one-line field can't show — use ${quotedVerb(VERB.showInTextEditor)}.` : null,
                            field: { value: source, label: 'Markdown', commit: value => this.commitNoteSource(object, source, value) },
                        },
                    ],
                };
            }
            case 'link': {
                const href = object.mark.attrs.href as string;
                const edit = wording({ verb: 'Edit', noun: 'link', opens: true });
                const remove = wording({ verb: 'Remove', noun: 'link', keeps: ', keep text' });
                return {
                    label: 'Link',
                    title: href,
                    verbs: [
                        { id: 'open-link', label: wording({ verb: 'Open', noun: '' }).label, title: `Open ${href} (as Ctrl+click does).`, slot: 'open', run: () => host.openLink(href) },
                        {
                            // The field Ctrl+K and Insert → Link… open in a link, with the same completion.
                            id: 'edit-link',
                            label: edit.label,
                            short: edit.short,
                            title: 'Link the text to another address: a file, a #heading, a web address (Enter to apply, Esc to cancel).',
                            slot: 'edit',
                            field: {
                                value: href,
                                label: 'Address',
                                complete: query => host.linkChoices(query, false),
                                commit: value => this.act(object, current => {
                                    const tr = current.kind === 'link' ? changeLinkTransaction(view.state, current, value) : null;
                                    if (tr) {
                                        dispatch(tr);
                                    }
                                    return tr !== null;
                                }),
                            },
                        },
                        this.markAttributesVerb(object, 'link-attributes', VERB.attributes, typed => `The link's {…}, written after its (…): ${typed} (Enter to set, Esc to cancel).`),
                        {
                            id: 'remove-link',
                            label: remove.label,
                            short: remove.short,
                            title: 'The link goes; its text stays.',
                            slot: 'destroy',
                            refusal: refusalOnce(view.state, `remove-link@${object.from}:${object.to}`, () => removeLinkRefusal(view.state, object)),
                            run: () => this.act(object, current => {
                                if (current.kind !== 'link') {
                                    return false;
                                }
                                dispatch(removeLinkTransaction(view.state, current));
                                return true;
                            }, remove.done),
                        },
                    ],
                };
            }
            case 'image': {
                const src = object.node.attrs.src as string;
                const alt = (object.node.attrs.alt as string | null) ?? '';
                const literal = (object.node.attrs.literal as string | null) ?? null;
                const image = literalObjectOf(object) as LiteralObject;
                // The title says Image, not file: Open keeps its noun.
                const open = wording({ verb: 'Open', noun: 'file', titled: false });
                const edit = wording({ verb: 'Edit', noun: 'image', opens: true });
                const remove = wording({ verb: 'Delete', noun: 'image' });
                return {
                    label: 'Image',
                    // The literal is read with the label: in its title, and after it, as an emoji's spelling is.
                    ...(literal === null ? {} : { code: literal }),
                    title: `${alt === '' ? src : `${alt}: ${src}`}${literal === null ? '' : ` · ${literal}`}`,
                    verbs: [
                        {
                            id: 'edit-image',
                            label: edit.label,
                            short: edit.short,
                            title: 'Its alt text, then its path, each in the field (Enter to go on and apply, Esc to cancel).',
                            slot: 'edit',
                            field: {
                                value: alt,
                                label: 'Alt text',
                                commit: nextAlt => ({
                                    value: src,
                                    label: 'Image path',
                                    complete: query => host.linkChoices(query, true),
                                    commit: nextSrc => this.act(object, current => {
                                        const tr = editImageTransaction(view.state, current.from, nextAlt, nextSrc);
                                        if (tr) {
                                            dispatch(tr);
                                        }
                                        return tr !== null;
                                    }),
                                }),
                            },
                        },
                        this.markAttributesVerb(image, 'image-attributes', VERB.attributes, typed => `The image's {…}, written after its (…): ${typed} (Enter to set, Esc to cancel).`),
                        { id: 'open-image', label: open.label, short: open.short, title: `Open ${src} (as Ctrl+click on a link does).`, slot: 'open', run: () => host.openLink(src) },
                        {
                            id: 'delete-image',
                            label: remove.label,
                            short: remove.short,
                            title: FILE_STAYS,
                            slot: 'destroy',
                            refusal: refusalOnce(view.state, `delete-image@${object.from}:${object.to}`, () => deleteObjectRefusal(view.state, object)),
                            run: () => this.remove(object, remove.done),
                        },
                    ],
                };
            }
            case 'span': {
                const literal = object.mark.attrs.literal as string;
                // The attributes field every route opens; empty removes nothing here — a span is its literal (Remove attributes).
                // Left as it was shown, Enter changes nothing (`changeSpanTransaction` would rewrite `{ .s }` as `{.s}`).
                const step = attributesField('Span', literal, (value, refused) => {
                    const current = currentObject(view.state, object);
                    if (current?.kind !== 'span') {
                        // The span is gone (the document changed under the open field): the field closes, the focus back, nothing written.
                        this.act(object, () => false);
                        return;
                    }
                    // Refused — the field kept open with what was typed and the reason under it — when markdown-it-attrs would not read the value as attributes.
                    const refusal = changeSpanRefusal(view.state, current, value);
                    if (refusal !== null) {
                        return refused(refusal);
                    }
                    this.apply(object, now => (now.kind === 'span' ? changeSpanTransaction(view.state, now, value) : null));
                }, {
                    removable: false,
                    unchanged: () => this.act(object, () => false),
                    // The span followed while the field is open (F7): a resync above it keeps the field.
                    followed: [object],
                });
                // The title says Span, not attributes: the verb keeps its noun however narrow the bar.
                const remove = wording({ verb: 'Remove', noun: 'attributes', keeps: ', keep text', titled: false });
                return {
                    label: 'Span',
                    title: `[text]${literal}: a span with these attributes.`,
                    verbs: [
                        {
                            id: 'edit-attributes',
                            label: VERB.attributes,
                            title: 'Change the span\'s {…} (Enter to set, Esc to cancel).',
                            slot: 'attributes',
                            field: step,
                            // At the span it edits, as every run's attributes field (`markAttributesVerb`), followed with it.
                            target: object,
                        },
                        {
                            id: 'remove-attributes',
                            label: remove.label,
                            title: 'The span goes; its text stays, with its formatting.',
                            slot: 'destroy',
                            refusal: refusalOnce(view.state, `remove-attributes@${object.from}:${object.to}`, () => removeSpanRefusal(view.state, object)),
                            run: () => this.apply(object, current => (current.kind === 'span' ? removeSpanTransaction(view.state, current) : null), remove.done),
                        },
                    ],
                };
            }
            case 'holder': {
                // Only `Alt+Enter` opens it: formatting has no bar of its own on a caret rest.
                const names = holderNames(inlineHolderOf(object));
                const text = view.state.doc.textBetween(object.from, object.to, ' ', ' ');
                return {
                    label: names.label,
                    title: `\`${text}\`: ${names.noun} — Attributes… gives it a {…}`,
                    verbs: [this.markAttributesVerb(object, 'edit-attributes', VERB.attributes, typed => `Give the ${names.noun} a {…}, written right after it: ${typed} (Enter to set, Esc to cancel).`)],
                };
            }
            case 'styled': {
                const literal = object.mark.attrs.literal as string;
                const name = holderNames(inlineHolderOf(object)).label;
                // The title names the formatting, not its attributes: no short form.
                const remove = wording({ verb: 'Remove', noun: 'attributes', keeps: ', keep formatting', titled: false });
                return {
                    label: name,
                    // The literal is read with the label, as an image's is (`Code {.k}`).
                    code: literal,
                    title: `${name} with the attributes ${literal}, written after its closing delimiter.`,
                    verbs: [
                        this.markAttributesVerb(object, 'edit-attributes', VERB.attributes, typed => `Change the ${name.toLowerCase()}'s {…}: ${typed} (Enter to set, Esc to cancel).`),
                        {
                            id: 'remove-attributes',
                            label: remove.label,
                            title: `The {…} goes; the text stays ${name.toLowerCase()}.`,
                            slot: 'destroy',
                            refusal: refusalOnce(view.state, `remove-attributes@${object.from}:${object.to}`, () => changeInlineLiteralRefusal(view.state, object, '')),
                            run: () => this.apply(object, current => (current.kind === 'styled' ? changeInlineLiteralTransaction(view.state, current, '') : null), remove.done),
                        },
                    ],
                };
            }
            case 'container': {
                const name = object.node.attrs.name as string;
                const info = object.node.attrs.info as string;
                const remove = wording({ verb: 'Remove', noun: 'container', keeps: ', keep content' });
                const classes: FieldStep = {
                    value: `${name}${info}`,
                    label: 'Classes',
                    commit: value => {
                        if (containerNameOf(value) === null) {
                            // Refused in the field (#10 C24): it stays open with what was typed, the reason under it.
                            return refusedStep(classes, value, CONTAINER_TITLE_REFUSAL);
                        }
                        this.apply(object, current => changeContainerTransaction(view.state, current.from, value));
                    },
                };
                return {
                    label: name === '' ? 'Container' : `Container ${name}`,
                    title: `A block with the class "${containerClass(name, info)}".`,
                    verbs: [
                        {
                            // The field holds the whole ::: line, name and info: the classes the div gets (Daniel, 2026-10-16).
                            id: 'edit-classes',
                            label: VERB.editClasses,
                            title: 'What follows ::: — its name and info, the classes the block gets (Enter to apply, Esc to cancel).',
                            slot: 'edit',
                            field: classes,
                        },
                        this.wrapperAttributesVerb(object),
                        {
                            id: 'remove-container',
                            label: remove.label,
                            short: remove.short,
                            title: 'The container goes; its blocks stay where it stood.',
                            slot: 'destroy',
                            run: () => this.apply(object, current => unwrapTransaction(view.state, current.from), remove.done),
                        },
                    ],
                };
            }
            case 'admonition': {
                const type = object.node.attrs.type as string;
                const title = object.node.attrs.title as string;
                const remove = wording({ verb: 'Remove', noun: 'admonition', keeps: ', keep content' });
                return {
                    label: `${titleOf(type)} admonition`,
                    short: titleOf(type),
                    title: title === '' ? `A ${type} admonition without a title.` : `A ${type} admonition: ${title}`,
                    verbs: [
                        {
                            id: 'change-type',
                            label: VERB.type,
                            title: 'Another of the plugin\'s types: another colour and icon.',
                            slot: 'type',
                            choice: {
                                value: type,
                                label: 'Type',
                                options: ADMONITION_TYPES.map(t => ({ value: t, label: t })),
                                commit: value => this.apply(object, current => changeAdmonitionTransaction(view.state, current.from, { type: value })),
                            },
                        },
                        {
                            id: 'edit-title',
                            label: wording({ verb: 'Edit', noun: 'title', opens: true, titled: false }).label,
                            title: 'The title bar\'s text; empty for no title bar (Enter to apply, Esc to cancel).',
                            slot: 'edit',
                            field: {
                                value: title,
                                label: 'Title',
                                commit: value => this.apply(object, current => changeAdmonitionTransaction(view.state, current.from, { title: value })),
                            },
                        },
                        this.wrapperAttributesVerb(object),
                        {
                            id: 'remove-admonition',
                            label: remove.label,
                            short: remove.short,
                            title: 'The admonition goes; its blocks stay where it stood.',
                            slot: 'destroy',
                            run: () => this.apply(object, current => unwrapTransaction(view.state, current.from), remove.done),
                        },
                    ],
                };
            }
            case 'table':
                return this.tablePresentation(object);
            case 'code_block': {
                const indented = object.node.attrs.markup === '';
                const code = [languageOf(object.node.attrs.params as string), (object.node.attrs.attrsSuffix as string | null) ?? ''].filter(Boolean).join(' ');
                const remove = wording({ verb: 'Delete', noun: 'code block' });
                const attributes = this.attributesVerb(object);
                // The title names only what the bar can do: Attributes… stays out where it is refused (nested, the engine off).
                const fencers = attributes.refusal ? 'Language… or Edit source' : 'Language…, Attributes… or Edit source';
                return {
                    label: indented ? 'Indented code block' : 'Code block',
                    code: code === '' ? undefined : code,
                    title: indented
                        ? `An indented code block: it has no opening line until ${fencers} fences it.`
                        : 'A fenced code block: its language and its {…} stand on its opening line.',
                    verbs: [
                        this.languageVerb(object),
                        attributes,
                        this.openingLineVerb(object),
                        { id: 'delete-code-block', label: remove.label, short: remove.short, title: 'The block goes from the file.', slot: 'destroy', run: () => this.remove(object, remove.done) },
                    ],
                };
            }
            case 'list_item': {
                const literal = literalOf(object.node);
                return {
                    label: BLOCK_NAMES.list_item,
                    ...(literal === null ? {} : { code: literal }),
                    title: literal === null ? 'A list item.' : `${literal}: the attributes the item is rendered with.`,
                    verbs: [this.attributesVerb(object)],
                };
            }
            case 'block_attrs': {
                // The block's name and its literal in the code font, as an inline element's bar shows its own (#8):
                // `Quote {.warning}` · Attributes… · | · Remove attributes.
                const literal = (object.node.attrs.attrsSuffix as string | null) ?? '';
                const name = BLOCK_NAMES[object.node.type.name] ?? 'Block';
                return {
                    label: name,
                    code: literal,
                    title: `${literal}: the attributes the block is rendered with.`,
                    verbs: [this.attributesVerb(object), this.removeBlockAttributesVerb(object, name)],
                };
            }
            case 'wiki_embed':
                return {
                    label: 'Wiki embed',
                    title: `${object.node.attrs.source as string}: kept as written, for the extension that renders embeds (Foam).`,
                    verbs: wikiEmbedVerbs(view.state, object, {
                        asText: done => this.act(object, current => {
                            const tr = embedAsTextTransaction(this.view.state, current.from, current.to);
                            if (tr !== null) {
                                this.view.dispatch(tr);
                            }
                            return tr !== null;
                        }, done),
                        remove: done => this.remove(object, done),
                    }),
                };
            case 'emoji': {
                const source = object.node.attrs.source as string;
                return {
                    label: 'Emoji',
                    code: source,
                    title: `Emoji ${source} — kept as written`,
                    verbs: emojiVerbs(view.state, object, {
                        asText: done => this.act(object, current => {
                            const tr = emojiAsTextTransaction(this.view.state, current.from, current.to);
                            if (tr !== null) {
                                this.view.dispatch(tr);
                            }
                            return tr !== null;
                        }, done),
                        remove: done => this.remove(object, done),
                    }),
                };
            }
            case 'footnote':
            case 'footnote_entry':
                return this.footnotePresentation(object);
            case 'badge': {
                const mark = object.node.attrs.mark as { rule?: unknown } | null;
                return {
                    label: mark?.rule === 'req-status-badges' ? 'Status badge' : 'Injected content',
                    title: 'Shown here by another extension; the file holds nothing at this place.',
                    verbs: [],
                };
            }
            case 'raw_block': {
                // While its own source box has the focus, the box is the edit: no Edit source to offer.
                const editing = this.holdsFocusedControl(object);
                const editSource: Verb = {
                    id: 'edit-source',
                    label: VERB.editSource,
                    title: `Edit this block as Markdown (${applyKey()} to apply, Esc to cancel).`,
                    slot: 'source',
                    box: true,
                    run: () => {
                        if (currentObject(view.state, object)) {
                            editRawSourceAt(view, object.from);
                        }
                    },
                };
                const remove = wording({ verb: 'Delete', noun: 'block' });
                return {
                    ...rawBlockLabel(object.node.attrs.construct as string | null, object.node.attrs.src as string),
                    verbs: [
                        this.showInTextEditor(object),
                        ...(editing ? [] : [editSource]),
                        { id: 'delete-block', label: remove.label, short: remove.short, title: 'The block goes from the file.', slot: 'destroy', run: () => this.remove(object, remove.done) },
                    ],
                };
            }
            case 'injected_block': {
                const kind = object.node.attrs.kind as string;
                const mark = object.node.attrs.mark as { snippet?: unknown; path?: unknown; missing?: unknown } | null;
                if (kind !== 'expansion') {
                    return {
                        label: kind === 'generated' ? 'Generated content' : 'Injected content',
                        title: 'Shown here as the preview shows it; the file holds nothing at this place.',
                        verbs: [],
                    };
                }
                const snippet = typeof mark?.snippet === 'string' ? mark.snippet : '';
                const path = mark?.path;
                const verbs: Verb[] = [];
                const open = wording({ verb: 'Open', noun: 'snippet' });
                const change = wording({ verb: 'Change', noun: 'snippet', opens: true });
                // The title names the snippet, not its directive: a bare Delete would read as deleting the snippet's file.
                const remove = wording({ verb: 'Delete', noun: 'directive', titled: false });
                if (typeof path === 'string' && !mark?.missing) {
                    verbs.push({ id: 'open-snippet', label: open.label, short: open.short, title: path, slot: 'open', run: () => host.openSnippet(path) });
                }
                // Offered on a missing snippet too: choosing another is how it is mended. It asks
                // the host for a choice, so nothing opens in place: `Alt+Enter` does not land on it.
                verbs.push({
                    id: 'change-snippet',
                    label: change.label,
                    short: change.short,
                    title: 'Choose another snippet for this directive from the ones the extensions offer.',
                    slot: 'edit',
                    refusal: host.includesOffered() ? null : NO_INCLUDES_REFUSAL,
                    run: () => {
                        if (currentObject(view.state, object)) {
                            host.pickInclude(object.from);
                        }
                    },
                });
                verbs.push(
                    this.showInTextEditor(object),
                    {
                        id: 'delete-directive',
                        label: remove.label,
                        short: remove.short,
                        title: FILE_STAYS,
                        slot: 'destroy',
                        run: () => this.remove(object, remove.done),
                    },
                );
                return {
                    label: mark?.missing ? `Snippet ${snippet} (not found)` : `Included snippet ${snippet}`,
                    title: 'The file holds one directive line here; the body comes from the snippet.',
                    verbs,
                };
            }
            case 'front_matter':
                // Its own verbs are the panel's header (`properties.ts`); the bar carries other extensions' actions only.
                return { label: 'Properties', title: 'The front matter; its keys are edited in the panel, in place.', verbs: [] };
            case 'heading': {
                const prefix = object.node.attrs.reqPrefix as string | null;
                const id = prefix?.replace(/:\s*$/, '') ?? '';
                // A requirement heading's anchor is Req Explorer's: no verb it would
                // refuse on every requirement the caret rests in (`carriesBlockAttrs`).
                return {
                    label: id ? `Requirement ${id}` : `Heading ${object.node.attrs.level as number}`,
                    title: id ? 'A requirement heading: its id and anchor are Req Explorer\'s.' : 'A heading.',
                    verbs: id ? [] : [this.attributesVerb(object)],
                };
            }
        }
    }

    /**
     * A table's bar, five slots (Daniel, 2026-09-29): three set-verbs — Row
     * (insert above, insert below, delete), Column (insert left, insert
     * right, delete), Align (left, center, right, the current one marked;
     * the marked one chosen again is the default, `---`) — then, after a gap,
     * **Edit source** and **Delete table**. The menus act on the rows and
     * columns the selection is in, the caret's cell or the cells selected
     * across, and the caret's column is tinted while the bar shows, so
     * "left" and "right" have something to be left and right of. No *Toggle
     * header row*: a pipe table has exactly one header (`tables.ts`).
     */
    private tablePresentation(object: Extract<EditorObject, { kind: NodeObjectKind }>): Presentation {
        const view = this.view;
        const state = view.state;
        const remove = wording({ verb: 'Delete', noun: 'table' });
        const columns = object.node.firstChild?.childCount ?? 0;
        const rows = object.node.childCount;
        const entry = (id: string, label: string, title: string, make: () => Transaction | null, more: Partial<MenuEntry> = {}, hint?: string): MenuEntry => ({
            id, label, title, ...more, run: () => this.apply(object, make, hint),
        });
        const align = columnAlign(state);
        const alignEntry = (value: Exclude<TableAlign, null>, label: string, delimiter: string): MenuEntry => entry(
            `align-${value}`, label,
            align === value ? `Aligned ${value} (${delimiter}): choose it again for the default alignment (---).` : `Align the column ${value}: its delimiter cell becomes ${delimiter}.`,
            () => alignColumnTransaction(view.state, align === value ? null : value),
            { checked: align === value, keys: delimiter },
        );
        return {
            label: 'Table',
            title: `A pipe table: ${columns} ${columns === 1 ? 'column' : 'columns'}, a header row and ${rows - 1} ${rows === 2 ? 'row' : 'rows'} under it.`,
            verbs: [
                {
                    id: 'row', label: 'Row', slot: 'type', axis: 'row', title: 'Insert a row next to the caret\'s, or delete it.',
                    menu: [
                        entry('insert-row-above', 'Insert above', 'A new row above the caret\'s; above the header row it is the new header.', () => addRowTransaction(view.state, 'above')),
                        entry('insert-row-below', 'Insert below', 'A new row below the caret\'s. Tab in the last cell adds one too.', () => addRowTransaction(view.state, 'below'), { keys: 'Tab at end' }),
                        // The one that takes something away stands apart, after a divider (Daniel, #4 build critique).
                        entry('delete-row', 'Delete row', 'The caret\'s row goes; deleting the header row makes the next row the header.',
                            () => deleteRowTransaction(view.state), { refusal: deleteRowRefusal(state), separated: true }, 'Row deleted'),
                    ],
                },
                {
                    id: 'column', label: 'Column', slot: 'type', axis: 'column', title: 'Insert a column next to the caret\'s (tinted), or delete it.',
                    menu: [
                        entry('insert-column-left', 'Insert left', 'A new column left of the caret\'s.', () => addColumnTransaction(view.state, 'left')),
                        entry('insert-column-right', 'Insert right', 'A new column right of the caret\'s.', () => addColumnTransaction(view.state, 'right')),
                        entry('delete-column', 'Delete column', 'The caret\'s column goes.', () => deleteColumnTransaction(view.state), { refusal: deleteColumnRefusal(state), separated: true }, 'Column deleted'),
                    ],
                },
                {
                    id: 'align', label: 'Align', slot: 'type', axis: 'column', title: 'How the caret\'s column (tinted) is aligned: the colons of its delimiter cell.',
                    menu: [alignEntry('left', 'Left', ':--'), alignEntry('center', 'Center', ':-:'), alignEntry('right', 'Right', '--:')],
                },
                { ...this.attributesVerb(object), separated: true },
                {
                    id: 'edit-source',
                    label: VERB.editSource,
                    title: `Edit this table as Markdown (${applyKey()} to apply, Esc to cancel).`,
                    slot: 'source',
                    box: true,
                    run: () => this.editTableSource(object),
                },
                { id: 'delete-table', label: remove.label, short: remove.short, title: 'The table goes from the file.', slot: 'destroy', run: () => this.remove(object, remove.done) },
            ],
        };
    }

    /**
     * **Attributes…** on a block's bar: the same field as **Formatting →
     * Attributes…** (`attributesStep`), for this block — refused, with the
     * reason, on a container and an admonition, whose renderers drop a literal.
     */
    private attributesVerb(object: EditorObject): Verb {
        // A code block is an object at any depth, a list item and a heading in a quote too; below the top level only
        // a heading's and a list item's literal is written (`nestedAttrsRefusal`).
        const nested = !isMarkObject(object) && object.from < this.view.state.doc.content.size && this.view.state.doc.resolve(object.from).depth > 0;
        const found = isMarkObject(object) ? { refusal: NO_BLOCK_ATTRS_REFUSAL } : attributesTargetOf(object.node, object.from, nested);
        const refused = 'refusal' in found;
        const fences = object.kind === 'code_block' && object.node.attrs.markup === '' ? ' Setting one makes the block fenced.' : '';
        return {
            id: 'block-attributes',
            label: VERB.attributes,
            slot: 'attributes',
            title: attributesTip(refused ? 'Block' : found.name, refused ? null : literalOf(found.node), fences),
            refusal: refused ? found.refusal : null,
            field: refused ? undefined : attributesStep(this.view, found),
        };
    }

    /**
     * An admonition's or a container's Attributes… (#8, F5): refused for the
     * wrapper itself — it keeps no literal here — but where the caret's block
     * inside it is one that takes one (the menu's target, `attributesTargetAt`:
     * a heading, a list item), **Attributes of Heading…** for that block,
     * its field under it.
     */
    private wrapperAttributesVerb(object: EditorObject): Verb {
        const own = this.attributesVerb(object);
        const found = currentReadsAttrs() ? attributesTargetAt(this.view.state) : null;
        if (found === null || 'refusal' in found || found.pos <= object.from || found.pos >= object.to) {
            return own;
        }
        // A copy, followed while its field is open (F7).
        const target = { ...found };
        return {
            id: 'block-attributes',
            label: `Attributes of ${target.name}…`,
            slot: 'attributes',
            title: attributesTip(target.name, literalOf(target.node)),
            field: attributesStep(this.view, target),
            anchorBlock: target,
        };
    }

    /**
     * **Remove attributes** on a one-part block's bar (#8, F8): its literal
     * goes, the block stays — the same commit the field's empty value makes
     * (`commitAttributes`), the hint naming the block ("Quote attributes
     * removed"). Refused only where the field would refuse it.
     */
    private removeBlockAttributesVerb(object: Extract<EditorObject, { node: unknown }>, name: string): Verb {
        const remove = wording({ verb: 'Remove', noun: 'attributes', titled: false });
        return {
            id: 'remove-attributes',
            label: remove.label,
            title: `Removes the ${name.toLowerCase()}'s attributes; the ${name === BLOCK_NAMES.list_item ? 'item' : name.toLowerCase()} stays.`,
            slot: 'destroy',
            refusal: blockAttrsRefusal(object.node),
            run: () => this.removeBlockLiteral(object, () => {
                const now = currentObject(this.view.state, object);
                if (now === null || isMarkObject(now)) {
                    return null;
                }
                const found = attributesTargetOf(now.node, now.from, this.view.state.doc.resolve(now.from).depth > 0);
                return 'refusal' in found ? null : found;
            }, attributesRemovedHint(name)),
        };
    }

    /**
     * Remove the literal of the block `target` reads now (`null`: gone), once
     * the focus is back (`act`): one transaction, the hint `done`; refused at
     * the caret where the commit refuses it.
     */
    private removeBlockLiteral(object: EditorObject, target: () => AttributesTarget | null, done: string): void {
        this.act(object, () => {
            const now = target();
            const made = now === null ? null : commitAttributes(this.view.state, now, '');
            if (made === null) {
                return false;
            }
            if ('refusal' in made) {
                showRefusal(this.view, made.refusal);
                return false;
            }
            this.view.dispatch(made.tr);
            return true;
        }, done);
    }

    /**
     * A code block's **Language…**: the first word of its info string in a
     * field, the document's languages offered first, then every language the
     * preview highlights (`languageCompleter`); any word is taken, `''`
     * removes it, the rest of the info string and the `{…}` stay. On an
     * indented block it fences it (`changeLanguageTransaction`), and the hint
     * says so — the one change a look at the bar's title would not explain.
     */
    private languageVerb(object: Extract<EditorObject, { node: unknown }>): Verb {
        const indented = object.node.attrs.markup === '';
        const step: FieldStep = {
            value: languageOf(object.node.attrs.params as string),
            label: 'Language',
            keys: '↵ set · Esc cancel · empty: no language',
            complete: query => Promise.resolve(this.languageCompleter()(query)),
            commit: value => this.commitCodeBlock(step, object, value, changeLanguageTransaction),
        };
        // The fence in the code font: drawn as a part of its own, so three backticks read as the fence, not as noise.
        const tip: Tip | undefined = indented
            ? { parts: ['Language — setting one makes the block fenced (', { code: DEFAULT_FENCE }, '); its text stays.'] }
            : undefined;
        return {
            id: 'language',
            label: VERB.language,
            slot: 'type',
            title: tip ? tipText(tip) : 'The fence\'s language — the first word of its info string; the rest stays.',
            tip,
            field: step,
        };
    }

    /** Language…'s completer for the document as it is: its languages read once, not on each key (`languageCompleter`). */
    private languageCompleter(): (query: string) => Completion[] {
        const doc = this.view.state.doc;
        if (this.languages?.doc !== doc) {
            this.languages = { doc, complete: languageCompleter(doc) };
        }
        return this.languages.complete;
    }

    /**
     * A code block's **Edit source**: its opening line — fence, info string,
     * `{…}` — in the bar's field, read back and refused in one place
     * (`commitOpeningLine`). An indented block's opens empty, the fence a new
     * block gets as its placeholder: `Enter` fences it.
     */
    private openingLineVerb(object: Extract<EditorObject, { node: unknown }>): Verb {
        const indented = object.node.attrs.markup === '';
        const step: FieldStep = {
            // What the save writes (`savedOpeningLine`), not the node's own fence: the field must show the line the file will hold.
            value: indented ? '' : openingLineOfBlock(object.node),
            label: 'Opening line',
            placeholder: indented ? INDENTED_PLACEHOLDER : undefined,
            keys: '↵ set · Esc cancel · fence, info, {…}',
            commit: value => this.commitCodeBlock(step, object, value, commitOpeningLine),
        };
        return { id: 'edit-source', label: VERB.editSource, slot: 'source', title: 'Edit source — opening line (fence, language, attributes)', field: step };
    }

    /**
     * A code block's field committed through `make`: refused — the field kept
     * open with what was typed and why (`refusedStep`) — else applied on the
     * block as it is once the focus is back (`act`), the hint said only when
     * it fenced an indented block.
     */
    private commitCodeBlock(
        step: FieldStep,
        object: CodeBlockObject,
        value: string,
        make: (state: EditorState, block: CodeBlockObject, value: string) => { tr: Transaction; fenced: boolean } | { refusal: Said } | null,
    ): FieldStep | void {
        const state = this.view.state;
        // The node `currentObject` finds is the one the pass reads: no second lookup by position.
        const found = currentObject(state, object);
        const current = found !== null && !isMarkObject(found) ? found : null;
        const asked = current === null ? null : make(state, current, value);
        if (asked !== null && 'refusal' in asked) {
            return refusedStep(step, value, asked.refusal);
        }
        this.act(object, now => {
            // The pass made above stands while nothing moved under it; moving the focus back may have (a source box committed).
            if (isMarkObject(now)) {
                return false;
            }
            const made = current !== null && this.view.state === state && now.from === current.from ? asked : make(this.view.state, now, value);
            if (made === null || 'refusal' in made) {
                return false;
            }
            const before = this.view.state;
            this.view.dispatch(made.tr);
            if (made.fenced && this.view.state !== before) {
                showChangeHint(this.view, undoHint(FENCED_DONE));
            }
            return true;
        });
    }

    /**
     * The verb that opens the attributes field of a link, a styled run
     * (`_x_{…}`, `` `x`{…} ``), an image or a bare holder: the one step every
     * route shares (`holderAttributesStep`). A run's field opens at the run it
     * edits (`target`), not where the caret or the bar was; an image's stands
     * at the image, its object, already; a note's at its reference, never at
     * the body floated into the margin (#15 F4, `noteFieldRange`).
     */
    private markAttributesVerb(object: LiteralObject, id: string, label: string, title: (typed: string) => string): Verb {
        // The run itself, followed with its field while it is open (F7).
        const target = 'mark' in object ? object : object.kind === 'note' ? noteFieldRange(object) : undefined;
        // What the tooltip says an empty value does is what the field's keys line says: it removes only a literal there is.
        return { id, label, title: title(attributesTyped(literalOfObject(object))), slot: 'attributes', field: holderAttributesStep(this.view, inlineHolderOf(object)), target };
    }

    /** A table's **Edit source**: the table becomes a source block holding its text, the source box open (`tableSourceTransaction`). */
    private editTableSource(object: EditorObject): void {
        this.view.focus();
        const current = currentObject(this.view.state, object);
        const made = current === null ? null : tableSourceTransaction(this.view.state, current.from, this.host.sourceContext());
        if (current === null || made === null) {
            return;
        }
        this.view.dispatch(made.tr);
        this.host.requestRender(made.src);
        editRawSourceAt(this.view, current.from);
    }

    private showInTextEditor(object: EditorObject): Verb {
        return { id: 'show-in-text-editor', label: VERB.showInTextEditor, title: 'Open the text editor beside, at this block.', slot: 'open', run: () => this.host.openSourceAt(object.from) };
    }

    /** Run a verb that is one transaction on the object as it is now; nothing when it makes none. */
    private apply(object: EditorObject, make: (current: EditorObject) => Transaction | null, hint?: string): void {
        this.act(object, current => {
            const tr = make(current);
            if (tr !== null) {
                this.view.dispatch(tr);
            }
            return tr !== null;
        }, hint);
    }

    /**
     * A footnote's bar (wave 4 #5b): a reference's — Go to footnote text ·
     * Label… · Delete footnote, its last reference, else Delete reference — an
     * inline footnote's, and an entry's — Back to reference · Label… · Sort
     * footnotes, while they are out of order · Delete footnote. The title
     * says the number and, in the code font, the label; the hints name the
     * label, which stays while numbers change.
     */
    private footnotePresentation(object: EditorObject): Presentation {
        const view = this.view;
        const node = (object as Extract<EditorObject, { node: unknown }>).node;
        const index = footnoteIndexOf(view.state);
        const label = node.attrs.label as string | null;
        const said = (done: { tr: Transaction; hint: Said } | null) => {
            if (done !== null) {
                dispatchWithHint(view, done.tr, done.hint);
            }
            return done !== null;
        };
        const labelVerb = (heading: string, mayJoin: boolean): Verb => {
            const step: FieldStep = {
                value: label ?? '',
                label: 'Label',
                heading: fieldHeading(heading, 'Label'),
                keys: '↵ set · Esc cancel',
                followed: [object],
                commit: typed => {
                    const now = currentObject(view.state, object);
                    if (now === null || typed === label) {
                        this.act(object, () => false);
                        return;
                    }
                    const refusal = labelRefusal(view.state, typed, label, mayJoin, now.from);
                    if (refusal !== null) {
                        return refusedStep(step, typed, refusal);
                    }
                    const done = renameFootnoteTransaction(view.state, now.from, typed);
                    const unwritable = done === null ? null : noteRefusal(done.tr);
                    if (unwritable !== null) {
                        return refusedStep(step, typed, unwritable);
                    }
                    this.act(object, current => said(renameFootnoteTransaction(view.state, current.from, typed)));
                },
            };
            // The label in the code font, as the bar's title draws it.
            const tip: Tip = { parts: ['Renames ', { code: label ?? '' }, ' in every reference and in its text (↵ set · Esc cancel)'] };
            return { id: 'footnote-label', label: 'Label…', title: tipText(tip), tip, slot: 'edit', field: step };
        };
        if (object.kind === 'footnote') {
            const ref = refAt(index, object.from);
            if (label === null) {
                const number = ref?.number ?? null;
                const heading = number === null ? 'Inline footnote' : `Inline footnote ${number}`;
                const source = node.attrs.source as string;
                const step: FieldStep = {
                    value: source,
                    label: 'Text',
                    heading,
                    keys: '↵ set · Esc cancel',
                    followed: [object],
                    commit: typed => {
                        const now = currentObject(view.state, object);
                        if (now === null || typed === source) {
                            this.act(object, () => false);
                            return;
                        }
                        const edit = editInlineFootnote(view.state, now.from, typed);
                        if (edit !== null && 'refusal' in edit) {
                            return refusedStep(step, typed, edit.refusal);
                        }
                        this.act(object, current => {
                            const again = editInlineFootnote(view.state, current.from, typed);
                            if (again === null || !('tr' in again)) {
                                return false;
                            }
                            view.dispatch(again.tr);
                            return true;
                        });
                    },
                };
                return {
                    label: heading,
                    short: 'Inline footnote',
                    title: `An inline footnote: ^[${source}]`,
                    verbs: [
                        { id: 'edit-inline-footnote', label: 'Edit text…', short: 'Edit…', title: 'Its text, as Markdown between ^[ and ] (Enter to set, Esc to cancel).', slot: 'edit', field: step },
                        { id: 'delete-footnote', label: 'Delete footnote', short: 'Delete', title: `Deletes the footnote and its text — ${undoKey()}`, slot: 'destroy', run: () => this.act(object, current => said(deleteFootnoteRefTransaction(view.state, current.from))) },
                    ],
                };
            }
            if (ref === undefined || ref.number === null) {
                return {
                    label: 'No footnote ·',
                    code: label,
                    title: `No footnote ${label} — the preview shows it as text. Label… gives it one that is there.`,
                    verbs: [
                        labelVerb('Footnote', true),
                        { id: 'delete-reference', label: 'Delete reference', short: 'Delete', title: `Deletes the reference — ${undoKey()}`, slot: 'destroy', run: () => this.act(object, current => said(deleteFootnoteRefTransaction(view.state, current.from))) },
                    ],
                };
            }
            // A source block's references count too (review 1 M2): with one left, the text stays.
            const others = index.refs.filter(r => r.label === label).length - 1;
            const last = others === 0;
            const goTip: Tip = { parts: [`Moves the caret to the footnote's text — ↩ or ${quotedVerb('Back to reference')} returns (`, `${macKeys() ? 'Cmd' : 'Ctrl'}+click on `, { code: `[${ref.number}]` }, ' does the same)'] };
            return {
                label: `Footnote ${ref.number} ·`,
                short: `Footnote ${ref.number}`,
                tiny: String(ref.number),
                code: label,
                title: `Footnote ${ref.number}, written [^${label}]: its text stands where the file has it.`,
                verbs: [
                    {
                        id: 'go-to-footnote', label: 'Go to footnote text', short: 'Go to text', slot: 'open', jump: true,
                        title: tipText(goTip),
                        tip: goTip,
                        run: () => this.act(object, current => {
                            const done = goToFootnoteTransaction(view.state, current.from);
                            if (done !== null) {
                                view.dispatch(done.tr);
                                announceHint(view, done.number === null ? 'Footnote text' : `Footnote ${done.number} text`);
                            }
                            return done !== null;
                        }),
                    },
                    labelVerb(`Footnote ${ref.number}`, false),
                    last
                        ? { id: 'delete-footnote', label: 'Delete footnote', short: 'Delete', title: `Deletes the reference and its text — ${undoKey()}`, slot: 'destroy', run: () => this.act(object, current => said(deleteFootnoteRefTransaction(view.state, current.from))) }
                        : { id: 'delete-reference', label: 'Delete reference', short: 'Delete', title: `Footnote text stays — ${others} more reference${others === 1 ? '' : 's'}`, slot: 'destroy', run: () => this.act(object, current => said(deleteFootnoteRefTransaction(view.state, current.from))) },
                ],
            };
        }
        const entry = entryAt(index, object.from);
        const number = entry?.number ?? null;
        const count = entry?.refCount ?? 0;
        const chip = entry === undefined || number !== null ? null : orphanChip(entry);
        const verbs: Verb[] = [
            {
                id: 'back-to-reference', label: 'Back to reference', short: 'Back', slot: 'open', jump: true,
                title: 'Returns to the reference you came from, else the first',
                refusal: number === null
                    ? entry !== undefined && entry.duplicateOf !== null
                        ? `No reference leads here — they go to footnote ${entry.duplicateOf}, which has the same label`
                        : 'No reference to go back to — this footnote is not referenced'
                    : null,
                run: () => this.act(object, current => {
                    const done = backToReferenceTransaction(view.state, current.from);
                    if (done !== null) {
                        view.dispatch(done.tr);
                        announceHint(view, done.number === null ? 'Reference' : `Reference ${done.number}`);
                    }
                    return done !== null;
                }),
            },
            labelVerb(number === null ? 'Footnote' : `Footnote ${number}`, false),
        ];
        if (index.outOfOrder) {
            verbs.push({
                id: 'sort-footnotes', label: 'Sort footnotes', short: 'Sort', slot: 'type',
                title: `Puts the footnote texts in number order, unreferenced ones last — ${undoKey()}`,
                refusal: sortRefusal(view.state),
                run: () => this.act(object, () => {
                    const tr = sortFootnotesTransaction(view.state);
                    if (tr !== null) {
                        dispatchWithHint(view, tr, `Footnotes sorted — ${undoKey()}`);
                    }
                    return tr !== null;
                }),
            });
        }
        const refs = number === null ? 0 : count;
        verbs.push({
            id: 'delete-footnote', label: 'Delete footnote', short: 'Delete', slot: 'destroy',
            title: refs === 0 ? `Deletes its text — ${undoKey()}` : `Deletes its text and ${refs === 1 ? 'its reference' : `${refs} references`} — ${undoKey()}`,
            refusal: entryDeleteRefusal(view.state, object.from),
            run: () => this.act(object, current => said(deleteFootnoteEntryTransaction(view.state, current.from))),
        });
        return {
            label: number === null ? 'Footnote ·' : `Footnote ${number} ·`,
            short: number === null ? 'Footnote' : `Footnote ${number}`,
            tiny: number === null ? undefined : String(number),
            code: label ?? '',
            after: chip !== null ? ` · ${chip.text}` : count > 1 ? ` · ${count} references` : undefined,
            title: chip !== null ? chip.title : `The text of footnote ${number as number}, where the file writes it.`,
            verbs,
        };
    }

    private remove(object: EditorObject, hint: string): void {
        this.act(object, current => {
            this.view.dispatch(deleteObjectTransaction(this.view.state, current));
            return true;
        }, hint, true);
    }

    /**
     * A note's **Edit source**: the note node is replaced by the literal text
     * typed, and the edit is posted with `reparse`, so the host's parser decides
     * what it is — a note again (of whichever kind the markers now say), or
     * literal text if it is malformed. The page has no parser, and two parsers
     * would be the defect: the page would have to guess what the preview's
     * engine makes of the text, and would sooner or later guess otherwise.
     */
    private commitNoteSource(object: EditorObject, original: string, value: string): void {
        // The focus first, as in `act`.
        this.view.focus();
        const current = currentObject(this.view.state, object);
        if (current === null || current.kind !== 'note' || value === original || value.trim() === '') {
            return;
        }
        const tr = inlineSourceTransaction(this.view.state, current.from, current.to, value, current.node.marks, this.host.sourceContext());
        if (tr === null) {
            this.say(`Not applied: this note can't be saved as typed here. Change it with ${quotedVerb(VERB.showInTextEditor)}.`, 'refusal');
            return;
        }
        this.view.dispatch(tr);
        this.host.flushReparse();
    }
}

const toolbarViews = new WeakMap<EditorView, ObjectToolbarView>();

/** The object toolbar, as a plugin: its view follows every state, and `Alt+Enter` opens it from the keyboard. */
export function objectToolbarPlugin(host: ObjectToolbarHost): Plugin<BarDecor> {
    let toolbar: ObjectToolbarView | null = null;
    return new Plugin<BarDecor>({
        key: decorKey,
        state: {
            init: () => NO_DECOR,
            apply: (tr, value) => {
                const meta = tr.getMeta(decorKey) as BarDecor | undefined;
                if (meta !== undefined) {
                    return meta;
                }
                if (!tr.docChanged || value.tint === null) {
                    return value;
                }
                return { tint: { ...value.tint, table: tr.mapping.map(value.tint.table) } };
            },
        },
        view(editorView) {
            toolbar = new ObjectToolbarView(editorView, host);
            toolbarViews.set(editorView, toolbar);
            return toolbar;
        },
        appendTransaction(transactions, _oldState, newState) {
            toolbar?.applied(transactions, newState);
            return null;
        },
        props: {
            decorations(state) {
                return barDecorations(state, decorKey.getState(state) ?? NO_DECOR);
            },
            handleKeyDown(view, event) {
                if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
                    // Consumed only while the caret's bar shows (F1); else VS Code's Esc.
                    return toolbarViews.get(view)?.escapeInText() ?? false;
                }
                if (event.key !== 'Enter' || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                    return false;
                }
                // Beside an emoji, the emoji is the object: the arrows step over it, so this is how the keyboard selects it.
                const select = selectEmojiBeside(view.state);
                if (select !== null) {
                    view.dispatch(select);
                }
                const opened = toolbarViews.get(view)?.openFromKeyboard() ?? 'none';
                if (opened === 'opened') {
                    event.preventDefault();
                    return true;
                }
                if (view.state.selection instanceof TextSelection) {
                    // The key is taken, the caret stays (#4); it says there is nothing to act on only where there is no object — one
                    // whose bar could not be drawn says what it is instead (its title), never "nothing here".
                    showHint(view, opened === 'none' ? NO_TARGET_HINT : opened.title, 'neutral');
                    event.preventDefault();
                    return true;
                }
                return false;
            },
        },
    });
}
