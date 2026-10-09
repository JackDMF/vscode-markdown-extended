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
 * a block with attributes) shows its bar once the caret or the
 * selection has rested inside it for `INLINE_DELAY_MS`, and hides it the moment
 * the caret leaves; the pointer does not show it — an inline bar following the
 * pointer across a paragraph jumps. Two bars exist so the two triggers never
 * fight: one follows the selection, one the pointer, and the pointer's stays
 * hidden while it would show what the selection's already shows. `Alt+Enter`
 * opens the bar of the object at the caret at once, the focus on its first verb;
 * the arrow keys move, `Enter` chooses, `Esc` returns to the text.
 *
 * **Where it sits.** Above the object's first line — at an inline object's
 * start, at a block's right edge (`Anchor`); below its last line when above is
 * taken or under the formatting row — and never over the line
 * the caret is on: a bar that would cover it is put on the other side. While text is selected the bar prefers below, since the
 * selection bubble takes the room above. It is `position: absolute` inside the
 * editor's mount, as the bubble is, so it scrolls with the text.
 *
 * **The verbs say what remains** ("Remove note, keep text"), and a verb whose
 * result is a disappearance announces it in the caret hint ("Note removed —
 * Ctrl+Z"): otherwise nothing visible happens but something going.
 *
 * Buttons act on `mousedown` + `preventDefault`, as the formatting toolbar's
 * do, so the editor keeps its focus and its selection.
 */
import { EditorState, Plugin, PluginKey, PluginView, TextSelection, Transaction } from 'prosemirror-state';
import { CellSelection, isInTable, selectedRect } from 'prosemirror-tables';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { ADMONITION_TYPES } from '../../syntax/markers';
import { containerClass } from '../schema';
import { editRawSourceAt } from './nodeViews';
import { HintTone, showHint, undoKey } from './hint';
import { FieldStep, InlineChoice, InlineField, fieldHeading, fieldKeys } from './inlineField';
import { NoteNodeName, noteRefusal, unwrapNote, unwrapNoteRefusal } from './notes';
import { embedAsTextTransaction } from './wikiEmbeds';
import { emojiAsTextTransaction, emojiTextStillRead } from './emoji';
import { clearPendingRange, showPendingRange } from './pendingRange';
import {
    BLOCK_NAMES, EditorObject, NOTE_CONVERSION, NO_BLOCK_ATTRS_REFUSAL, NodeObjectKind, attributesTargetOf, literalOf, changeAdmonitionTransaction, changeContainerTransaction,
    changeLinkTransaction, changeSpanRefusal, changeSpanTransaction, editImageTransaction, containerNameOf, convertNoteRefusal, convertNoteTransaction, currentObject,
    deleteObjectRefusal, deleteObjectTransaction, isBlockObject, isBlockPlaced, isTopLevelBlock, literalPlaceOf, literalRefusal, noteSource, objectAtSelection, objectOfNode, removeLinkRefusal,
    removeLinkTransaction, removeSpanRefusal, removeSpanTransaction, sameObject, unwrapTransaction,
} from './objects';
import { attributesStep } from './attributes';
import { Place, firstFree, firstLineTop, rightEdgeIn, rowCeiling } from './clearance';
import { NO_INCLUDES_REFUSAL } from './toolbar/actions';
import { followPointer, selectionBubbleShown } from './toolbar/toolbar';
import { SourceContext, inlineSourceTransaction } from './toolbar/commands';
import {
    addColumnTransaction, addRowTransaction, alignColumnTransaction, columnAlign, deleteColumnRefusal, deleteColumnTransaction, deleteRowRefusal,
    deleteRowTransaction, tableRefusal, tableSourceTransaction,
} from './tables';
import { TableAlign } from '../schema';
import type { CodeActionItem, LensItem, LinkChoice } from '../protocol';
import { chevronNode, lensLabelNodes, lensName } from './lenses';

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
const PENDING_OBJECTS: ReadonlySet<string> = new Set(['link', 'span', 'note', 'image']);

/** How long the caret rests in an inline object before its toolbar shows. */
export const INLINE_DELAY_MS = 400;

/** How long the pointer may be off a block and its bar before the bar goes: time to cross the gap between them. */
const HOVER_GRACE_MS = 300;

/** Between the bar and the line it sits above or below. */
const GAP = 4;

/** One verb as the bar draws it. */
export interface Verb {
    /** `data-verb`: what tests and stylesheets name it by. */
    id: string;
    /** As its owner titled it: `$(icon)` references are drawn as icons, and `lensLabel` gives the plain text. */
    label: string;
    title: string;
    /** Why it cannot be chosen here, shown in its tooltip; `null` when it can. */
    refusal?: string | null;
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
    /** Drawn after a separator: the first of another extension's lenses, or of its code actions, or a group of the object's own. */
    separated?: boolean;
}

/** One entry of a set-verb's menu. */
interface MenuEntry {
    /** `data-entry`: what tests name it by. */
    id: string;
    label: string;
    title: string;
    /** The keyboard route to the same thing, shown at the entry's right (`Tab at end`). */
    keys?: string;
    /** For a choice of one value out of several: whether this is the current one, marked. */
    checked?: boolean;
    /** Why it cannot be chosen here, in its tooltip; the entry is drawn disabled. */
    refusal?: string | null;
    run(): void;
}

interface Presentation {
    label: string;
    title: string;
    verbs: Verb[];
}

/**
 * An object whose bar would be its label alone, and so is not drawn: a
 * requirement heading (its verbs are other extensions' lenses and actions; any
 * other heading has **Attributes…**) and the front matter
 * (its own verbs are the properties panel's header), with none offered.
 */
function barless(object: EditorObject, presentation: Presentation): boolean {
    if (presentation.verbs.length === 0) {
        return object.kind === 'heading' || object.kind === 'front_matter';
    }
    // A bar whose one verb is Attributes…, on a block with no literal yet — every plain
    // heading — is chrome on every such block; the menu reaches it, and the verb joins
    // the bar once the block has others (lenses, code actions) or a literal.
    return 'node' in object && literalOf(object.node) === null && presentation.verbs.every(v => v.id === 'block-attributes');
}

const NOTE_LABELS: Readonly<Record<NoteNodeName, string>> = {
    sidenote: 'Sidenote',
    marginal_note: 'Marginal note',
    left_sidebar: 'Left sidebar',
    right_sidebar: 'Right sidebar',
};

const CONVERT_LABELS: Readonly<Record<NoteNodeName, string>> = {
    sidenote: 'Convert to marginal note',
    marginal_note: 'Convert to sidenote',
    left_sidebar: 'Move to right',
    right_sidebar: 'Move to left',
};


/**
 * What the bars draw into the document, set by the bars' view as they show
 * and go (`ObjectToolbarView.syncDecorations`) and drawn by the plugin's
 * decorations: `tint`, the table whose caret column is tinted while its bar
 * shows, by its position. A bar never draws layout into the document: it
 * floats, so showing it moves nothing.
 */
interface BarDecor {
    tint: number | null;
}

const NO_DECOR: BarDecor = { tint: null };

const decorKey = new PluginKey<BarDecor>('mep-object-toolbar-decor');

/**
 * Where a block's bar goes when no place is free (`placeBlock`, step 5):
 * above the block, unless that is under the formatting row (`ceiling`), where
 * it could not be seen or clicked; then below it, unless that is past the
 * window's bottom; then at the row's edge. A position, never a layout change.
 */
export function lastResortY(aboveY: number, belowY: number, height: number, ceiling: number, bottom = window.innerHeight): number {
    if (aboveY >= ceiling) {
        return aboveY;
    }
    if (belowY >= ceiling && belowY + height <= bottom) {
        return belowY;
    }
    return ceiling + GAP;
}

/** The caret's columns of the table at `tablePos`, as node decorations on their cells; none when the selection is not in it. */
function columnTint(state: EditorState, tablePos: number | null): Decoration[] {
    const table = tablePos === null ? null : state.doc.nodeAt(tablePos);
    if (tablePos === null || !table || table.type.name !== 'table' || !(isInTable(state) || state.selection instanceof CellSelection)) {
        return [];
    }
    const rect = selectedRect(state);
    if (rect.tableStart !== tablePos + 1) {
        return [];
    }
    const decorations: Decoration[] = [];
    for (let row = 0; row < rect.map.height; row++) {
        for (let col = rect.left; col < rect.right; col++) {
            const pos = rect.tableStart + rect.map.map[row * rect.map.width + col];
            const cell = state.doc.nodeAt(pos);
            if (cell) {
                decorations.push(Decoration.node(pos, pos + cell.nodeSize, { class: 'mep-table-column' }));
            }
        }
    }
    return decorations;
}

function barDecorations(state: EditorState, decor: BarDecor): DecorationSet {
    const decorations = columnTint(state, decor.tint);
    return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(state.doc, decorations);
}

function sameDecor(a: BarDecor, b: BarDecor): boolean {
    return a.tint === b.tint;
}

/**
 * What a source block's bar calls it: a source block, or — for a table the
 * editor leaves as source — the kind of table, so the bar says why this table
 * has no Row and Column menus when the one above it has them.
 */
function rawBlockLabel(construct: string | null): { label: string; title: string } {
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
        default:
            return { label: 'Source block', title: 'Shown as the preview renders it, edited as Markdown.' };
    }
}

function isSidebar(name: NoteNodeName): boolean {
    return name === 'left_sidebar' || name === 'right_sidebar';
}

/**
 * A verb's refusal builds the whole transaction it would dispatch and asks the
 * filters' own check of it (`noteRefusal`, `tableRefusal`), and a bar is
 * presented on every refresh and hover: each is read once per state, by the
 * verb and the object's place (`key`), not once per presentation.
 */
const refusals = new WeakMap<EditorState, Map<string, string | null>>();

/** The refusal `read` gives in `state`, remembered under `key` (`refusals`). */
function refusalOnce(state: EditorState, key: string, read: () => string | null): string | null {
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
function filterRefusal(tr: Transaction | null, none: string): string | null {
    return tr === null ? none : noteRefusal(tr) ?? tableRefusal(tr);
}

/** What the verbs of a wiki embed do: the bar gives them, the verbs only say which. */
export interface EmbedActions {
    asText(): void;
    remove(): void;
}

/** What sets an atom's two verbs apart (`atomVerbs`): their ids, labels and titles, and Edit as text's transaction and refusal. */
interface AtomVerbTexts {
    asText: { id: string; title: string };
    remove: { id: string; label: string; title: string };
    /** Why neither can be chosen where there is no such atom. */
    none: string;
    /** The atom as text, or `null` where `[from, to)` is no such atom. */
    asTextTransaction(state: EditorState, from: number, to: number): Transaction | null;
    /** Why Edit as text is refused besides the filters, if it is. */
    asTextRefusal?(state: EditorState, tr: Transaction): string | null;
}

/**
 * The verbs of an atom `object` — a wiki embed, an emoji: Edit as text and
 * Remove, each with the reason it cannot be chosen in `state`, if there is
 * one. Refused as the notes' and the tables' filters would refuse it: the text
 * takes the atom's marks, and an attribute span over it that holds a note
 * marker (or `|` in a cell) is allowed over an atom and not over text.
 */
function atomVerbs(state: EditorState, object: EditorObject, actions: EmbedActions, texts: AtomVerbTexts): Verb[] {
    const place = `${object.from}:${object.to}`;
    return [
        {
            id: texts.asText.id,
            label: 'Edit as text',
            title: texts.asText.title,
            refusal: refusalOnce(state, `${texts.asText.id}@${place}`, () => {
                const tr = texts.asTextTransaction(state, object.from, object.to);
                return filterRefusal(tr, texts.none) ?? (tr === null ? null : texts.asTextRefusal?.(state, tr) ?? null);
            }),
            run: () => actions.asText(),
        },
        {
            id: texts.remove.id,
            label: texts.remove.label,
            title: texts.remove.title,
            refusal: refusalOnce(state, `${texts.remove.id}@${place}`, () => filterRefusal(deleteObjectTransaction(state, object), texts.none)),
            run: () => actions.remove(),
        },
    ];
}

/** The verbs of the wiki embed `object`, each with the reason it cannot be chosen in `state`, if there is one. */
export function wikiEmbedVerbs(state: EditorState, object: EditorObject, actions: EmbedActions): Verb[] {
    return atomVerbs(state, object, actions, {
        asText: { id: 'edit-wiki-embed-as-text', title: 'Make it plain text, ![[name]], to edit its name; delete the last ] and type it again to make it an embed.' },
        remove: { id: 'remove-wiki-embed', label: 'Remove embed', title: 'The embed goes from the text.' },
        none: 'There is no embed here.',
        asTextTransaction: embedAsTextTransaction,
    });
}

/**
 * The verbs of the emoji atom `object`, each with the reason it cannot be
 * chosen in `state`, if there is one: as an embed's, and Edit as text where
 * its characters would still read as an emoji (`emojiTextStillRead`).
 */
export function emojiVerbs(state: EditorState, object: EditorObject, actions: EmbedActions): Verb[] {
    const source = object.kind === 'emoji' ? object.node.attrs.source as string : '';
    return atomVerbs(state, object, actions, {
        asText: { id: 'edit-emoji-as-text', title: `Make it its spelling, ${source}, as plain text; typed text is saved so it shows as typed.` },
        remove: { id: 'remove-emoji', label: 'Remove emoji', title: 'The emoji goes from the text.' },
        none: 'There is no emoji here.',
        asTextTransaction: emojiAsTextTransaction,
        asTextRefusal: emojiTextStillRead,
    });
}

/** What a bar tells the view about its field. */
interface BarEvents {
    escape(): void;
    /** A field opened for `object`: what it acts on is drawn (`pendingRange.ts`). */
    fieldOpened(object: EditorObject): void;
    fieldClosed(committed: boolean): void;
    /** The bar went with its field open: the view hides it from inside an update, so the drawing goes after it. */
    fieldDropped(): void;
}

/** One bar: a label and verbs, or a label and the inline field. */
class ObjectBar {
    readonly el: HTMLElement;
    object: EditorObject | null = null;
    private field: InlineField | InlineChoice | null = null;
    private signature = '';
    private buttons: { verb: Verb; el: HTMLButtonElement }[] = [];
    /** A set-verb's open menu: its panel, the verb's button, its entries. */
    private menu: { panel: HTMLElement; button: HTMLButtonElement; entries: { entry: MenuEntry; el: HTMLElement }[] } | null = null;

    constructor(trigger: 'selection' | 'hover', private readonly events: BarEvents) {
        this.el = document.createElement('div');
        this.el.className = 'mep-object-toolbar';
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

    /** Show `object`; redrawn only when what it shows changed, so a focused verb keeps its focus, and never under an open field. */
    show(object: EditorObject, presentation: Presentation): void {
        this.object = object;
        this.el.dataset.object = object.kind;
        // Everything the bar draws or will prefill: an image's `src` is in no
        // label, only in the title and the field's value, and a bar kept after
        // an undo would otherwise offer the undone source.
        const signature = JSON.stringify([
            object.kind, object.from, presentation.label, presentation.title,
            presentation.verbs.map(v => [
                v.id, v.label, v.title, v.refusal ?? null, v.field?.value ?? v.choice?.value ?? null, v.separated ?? false,
                v.menu?.map(m => [m.id, m.label, m.title, m.keys ?? null, m.checked ?? null, m.refusal ?? null]) ?? null,
            ]),
        ]);
        if (!this.field && signature !== this.signature) {
            // An open set-verb menu whose entries changed under it (the table
            // changed, an undo) is rebuilt: its entries act on the object as it
            // is, and a stale "Delete row" would say so of a row that is gone.
            // (An open menu holds the focus — it closes when the focus leaves it — so the rebuilt one takes it.)
            const reopen = this.menu ? this.menu.button.dataset.verb : undefined;
            this.signature = signature;
            this.render(presentation);
            const again = reopen === undefined ? undefined : this.buttons.find(b => b.verb.id === reopen);
            if (again?.verb.menu && !again.verb.refusal) {
                this.openMenu(again.verb.menu, again.el);
            }
        }
        this.el.hidden = false;
    }

    hide(): void {
        this.closeMenu(false);
        if (this.field) {
            this.field.dispose();
            this.events.fieldDropped();
        }
        this.field = null;
        this.object = null;
        this.signature = '';
        this.el.hidden = true;
        delete this.el.dataset.object;
    }

    /** The focus on the first verb that can be chosen, or on the bar itself when it has none (so `Esc` still returns). */
    focusFirst(): void {
        const first = this.buttons.find(b => !b.verb.refusal);
        (first?.el ?? this.el).focus({ preventScroll: true });
    }

    private render(presentation: Presentation): void {
        this.closeMenu(false);
        const label = document.createElement('span');
        label.className = 'mep-object-label';
        label.textContent = presentation.label;
        label.title = presentation.title;
        this.el.setAttribute('aria-label', presentation.label);
        this.buttons = presentation.verbs.map(verb => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'mep-object-verb';
            el.dataset.verb = verb.id;
            el.replaceChildren(...lensLabelNodes(verb.label));
            if (verb.menu || verb.choice) {
                // It opens a list: the workbench's dropdown chevron, as the formatting row's menus carry.
                el.append(chevronNode());
            }
            if ((el.textContent ?? '') === '') {
                // Only an icon: the button is named by it, not left without a name.
                el.setAttribute('aria-label', lensName(verb.label));
            }
            el.tabIndex = -1;
            el.title = verb.refusal ? `${verb.title}\n${verb.refusal}` : verb.title;
            el.setAttribute('aria-disabled', String(Boolean(verb.refusal)));
            if (verb.menu) {
                el.setAttribute('aria-haspopup', 'menu');
                el.setAttribute('aria-expanded', 'false');
            }
            el.addEventListener('click', e => {
                e.preventDefault();
                this.choose(verb);
            });
            return { verb, el };
        });
        this.el.replaceChildren(label, ...this.buttons.flatMap(b => {
            if (!b.verb.separated) {
                return [b.el];
            }
            const separator = document.createElement('span');
            separator.className = 'mep-object-separator';
            separator.setAttribute('role', 'separator');
            return [separator, b.el];
        }));
    }

    private choose(verb: Verb): void {
        if (verb.refusal) {
            return;
        }
        if (verb.menu) {
            const button = this.buttons.find(b => b.verb === verb)?.el;
            const open = this.menu?.button === button;
            this.closeMenu(open);
            if (button && !open) {
                this.openMenu(verb.menu, button);
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
    private openMenu(entries: readonly MenuEntry[], button: HTMLButtonElement): void {
        const panel = document.createElement('div');
        panel.className = 'mep-menu mep-object-menu';
        panel.setAttribute('role', 'menu');
        panel.tabIndex = -1;
        panel.setAttribute('aria-label', lensName(button.textContent ?? ''));
        const made = entries.map(entry => {
            const el = document.createElement('div');
            el.className = 'mep-menu-item';
            el.dataset.entry = entry.id;
            el.tabIndex = -1;
            el.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio');
            if (entry.checked !== undefined) {
                el.setAttribute('aria-checked', String(entry.checked));
                el.classList.toggle('mep-active', entry.checked);
            }
            const label = document.createElement('span');
            label.className = 'mep-entry-label';
            label.textContent = entry.label;
            el.append(label);
            if (entry.keys) {
                const keys = document.createElement('span');
                keys.className = 'mep-entry-syntax';
                keys.textContent = entry.keys;
                el.append(keys);
            }
            el.title = entry.refusal ? `${entry.title}\n${entry.refusal}` : entry.title;
            if (entry.refusal) {
                el.classList.add('mep-disabled');
                el.setAttribute('aria-disabled', 'true');
            }
            el.addEventListener('click', e => {
                e.preventDefault();
                this.pick(entry);
            });
            el.addEventListener('mouseenter', () => followPointer(panel, el));
            return { entry, el };
        });
        panel.append(...made.map(m => m.el));
        panel.addEventListener('keydown', e => this.onMenuKey(e));
        panel.addEventListener('focusout', e => {
            if (!(e.relatedTarget instanceof globalThis.Node && panel.contains(e.relatedTarget))) {
                this.closeMenu(false);
            }
        });
        this.menu = { panel, button, entries: made };
        button.setAttribute('aria-expanded', 'true');
        this.el.append(panel);
        const r = button.getBoundingClientRect();
        const below = r.bottom + 2;
        panel.style.left = `${Math.max(0, Math.min(r.left, window.innerWidth - panel.offsetWidth))}px`;
        panel.style.top = `${below + panel.offsetHeight > window.innerHeight ? Math.max(0, r.top - 2 - panel.offsetHeight) : below}px`;
        const first = made.find(m => m.entry.checked && !m.entry.refusal) ?? made.find(m => !m.entry.refusal);
        (first?.el ?? panel).focus({ preventScroll: true });
    }

    /** Close the open menu, the focus back on its verb when asked. */
    private closeMenu(focusButton: boolean): void {
        const menu = this.menu;
        if (menu === null) {
            return;
        }
        this.menu = null;
        menu.button.setAttribute('aria-expanded', 'false');
        menu.panel.remove();
        if (focusButton) {
            menu.button.focus({ preventScroll: true });
        }
    }

    private pick(entry: MenuEntry): void {
        if (entry.refusal) {
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
        const label = this.el.querySelector('.mep-object-label');
        const make = 'options' in spec
            ? (callbacks: { onCommit(value: string): void; onCancel(reason: 'escape' | 'blur'): void }) =>
                new InlineChoice({ choices: spec.options, value: spec.value, label: spec.label, ...callbacks })
            : (callbacks: { onCommit(value: string): void; onCancel(reason: 'escape' | 'blur'): void }) =>
                new InlineField({ value: spec.value, caret: spec.caret, label: spec.label, placeholder: spec.placeholder, complete: spec.complete, ...callbacks });
        const field = make({
            onCommit: value => {
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
        if (label) {
            // A prefilled field shows no placeholder: the label says what the value is.
            label.textContent = fieldHeading(this.el.getAttribute('aria-label') ?? '', spec.label);
        }
        const keys = 'keys' in spec && spec.keys ? [fieldKeys(spec.keys)] : [];
        this.el.replaceChildren(...(label ? [label] : []), field.el, ...keys);
        field.focus();
        if (this.object) {
            this.events.fieldOpened(this.object);
        }
    }

    private onKey(e: KeyboardEvent): void {
        const enabled = this.buttons.filter(b => !b.verb.refusal);
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
                    this.choose(enabled[index].verb);
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

/**
 * Where an inline object's bar is put against, in the window's coordinates:
 * the top of the object's first line, the bottom of its last, and its start
 * (`left`). A block's bar is placed from the block itself (`placeBlock`).
 */
interface Anchor {
    top: number;
    bottom: number;
    left?: number;
}

/** A block's content edge: `.mep-atom` stands 8px out on each side (`editor.css`). */
const ATOM_INSET = 8;

class ObjectToolbarView implements PluginView {
    private readonly mount: HTMLElement;
    private readonly selectionBar: ObjectBar;
    private readonly hoverBar: ObjectBar;
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];
    /** The inline object the caret has rested in long enough (or `Alt+Enter` opened). */
    private matured: EditorObject | null = null;
    private pending: { object: EditorObject; timer: ReturnType<typeof setTimeout> } | null = null;
    /** The top-level atom's element the pointer is on. */
    private hovered: HTMLElement | null = null;
    private hoverTimer: ReturnType<typeof setTimeout> | undefined;
    private destroyed = false;

    constructor(private readonly view: EditorView, private readonly host: ObjectToolbarHost) {
        this.mount = view.dom.parentElement as HTMLElement;
        const events: BarEvents = {
            escape: () => this.view.focus(),
            fieldOpened: object => {
                if (PENDING_OBJECTS.has(object.kind)) {
                    showPendingRange(this.view, object.from, object.to);
                }
            },
            fieldClosed: () => {
                clearPendingRange(this.view);
                this.refresh();
            },
            fieldDropped: () => setTimeout(() => {
                if (!this.destroyed) {
                    clearPendingRange(this.view);
                }
            }, 0),
        };
        this.selectionBar = new ObjectBar('selection', events);
        this.hoverBar = new ObjectBar('hover', events);
        this.mount.append(this.selectionBar.el, this.hoverBar.el);

        this.listen(document, 'mousemove', e => this.pointerAt(e.target as Element | null));
        this.listen(document.documentElement, 'mouseleave', () => this.unhover());
        // Focus moving in or out of the editor and the bars shows or hides the selection's bar.
        const later = () => setTimeout(() => this.refresh(), 0);
        this.listen(document, 'focusin', later);
        this.listen(document, 'focusout', later);
        // A scroll fires many times a frame, and placing probes the layout: once per frame.
        this.listen(window, 'scroll', () => this.placeAllInFrame(), true);
        this.listen(window, 'resize', () => this.placeAllInFrame());
        this.refresh();
    }

    /** The frame a `placeAll` is waiting for, or `undefined`. */
    private placeFrame: number | undefined;

    private placeAllInFrame(): void {
        if (this.placeFrame === undefined) {
            this.placeFrame = requestAnimationFrame(() => {
                this.placeFrame = undefined;
                if (!this.destroyed) {
                    this.placeAll();
                }
            });
        }
    }

    update(): void {
        this.refresh();
    }

    destroy(): void {
        this.destroyed = true;
        if (this.placeFrame !== undefined) {
            cancelAnimationFrame(this.placeFrame);
        }
        this.cancelPending();
        clearTimeout(this.hoverTimer);
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.selectionBar.hide();
        this.selectionBar.el.remove();
        this.hoverBar.el.remove();
    }

    /** `Alt+Enter`: the bar of the object at the caret, now, the focus on its first verb. False where there is none. */
    openFromKeyboard(): boolean {
        const object = objectAtSelection(this.view.state);
        if (object === null) {
            return false;
        }
        this.cancelPending();
        this.matured = object;
        this.refresh();
        if (!this.selectionBar.visible) {
            return false;
        }
        this.selectionBar.focusFirst();
        return true;
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    /** The focus is in the editor or a bar — or a bar's field is open: it keeps itself open while the window is away (`InlineField`). */
    private focusInside(): boolean {
        if (this.selectionBar.editing) {
            return true;
        }
        const active = document.activeElement;
        return active !== null && (this.view.dom.contains(active) || this.selectionBar.el.contains(active) || this.hoverBar.el.contains(active));
    }

    private cancelPending(): void {
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending = null;
        }
    }

    // -- the selection's bar ---------------------------------------------------

    private refresh(): void {
        if (this.destroyed) {
            return;
        }
        const object = this.focusInside() ? objectAtSelection(this.view.state) : null;
        if (object === null) {
            this.cancelPending();
            this.matured = null;
            this.selectionBar.hide();
        } else if (isBlockObject(object) || sameObject(object, this.matured)) {
            this.cancelPending();
            this.matured = isBlockObject(object) ? null : object;
            const presentation = this.present(object);
            if (barless(object, presentation)) {
                // A heading's verbs are other extensions' lenses and actions; with none, no bar.
                this.selectionBar.hide();
            } else if (isBlockPlaced(object) && selectionBubbleShown(this.view)) {
                // One thing at a time: while text is selected its bubble is the bar.
                this.selectionBar.hide();
            } else {
                this.selectionBar.show(object, presentation);
                this.place(this.selectionBar, object);
            }
        } else if (!sameObject(object, this.pending?.object ?? null)) {
            // A new inline object: nothing until the caret has rested in it.
            this.cancelPending();
            this.matured = null;
            this.selectionBar.hide();
            this.pending = {
                object,
                timer: setTimeout(() => {
                    this.pending = null;
                    this.matured = object;
                    this.refresh();
                }, INLINE_DELAY_MS),
            };
        }
        this.refreshHover();
        this.syncDecorations();
    }

    /**
     * What the bars shown need drawn in the document: the tint of the caret's
     * column of the table whose bar shows. It is a decoration, so the view is
     * told in a transaction of its own — after this update, which may not
     * dispatch one. A tint changes no box, so nothing moves.
     */
    private syncDecorations(): void {
        const wanted = (): BarDecor => ({
            tint: this.selectionBar.visible && this.selectionBar.object?.kind === 'table' ? this.selectionBar.object.from : null,
        });
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

    private pointerAt(target: Element | null): void {
        if (target === null || typeof target.closest !== 'function') {
            return;
        }
        if (this.hoverBar.el.contains(target)) {
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
        this.refreshHover();
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

    private refreshHover(): void {
        const object = this.hoveredObject();
        // The cheap reasons first: the presentation asks for code actions and lenses.
        const presentation = object === null || (this.selectionBar.visible && sameObject(object, this.selectionBar.object)) || selectionBubbleShown(this.view)
            ? null
            : this.present(object);
        if (object === null || presentation === null || barless(object, presentation)) {
            this.hoverBar.hide();
        } else {
            this.hoverBar.show(object, presentation);
            this.place(this.hoverBar, object);
        }
        this.syncDecorations();
    }

    // -- placing ---------------------------------------------------------------

    private placeAll(): void {
        for (const bar of [this.selectionBar, this.hoverBar]) {
            if (bar.visible && bar.object) {
                this.place(bar, bar.object);
            }
        }
        this.syncDecorations();
    }

    /** Where the object's first line starts and its last line ends. */
    private anchor(object: EditorObject): Anchor {
        const view = this.view;
        if (object.kind !== 'link' && object.kind !== 'span') {
            const dom = view.nodeDOM(object.from);
            if (dom instanceof Element) {
                // An inline element's own line boxes: a note's body floated
                // into the margin is not one of them, so the bar keeps to the
                // reference's lines.
                const rects = Array.from(dom.getClientRects()).filter(r => r.width > 0 || r.height > 0);
                if (rects.length > 0) {
                    return { left: rects[0].left, top: rects[0].top, bottom: rects[rects.length - 1].bottom };
                }
            }
        }
        const start = view.coordsAtPos(object.from, 1);
        const end = view.coordsAtPos(object.to, -1);
        return { left: start.left, top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) };
    }

    /**
     * An inline object's bar (a note, a link, a span, an image, a badge):
     * above the object's first line at its start, else beside that line —
     * just right of its textblock's text on it — else below its last line;
     * the first of these `firstFree` finds free, above and below never on the
     * caret's line. Where none is free, below.
     */
    private place(bar: ObjectBar, object: EditorObject): void {
        if (isBlockPlaced(object)) {
            this.placeBlock(bar, object);
            return;
        }
        const el = bar.el;
        const view = this.view;
        const base = this.mount.getBoundingClientRect();
        const anchor = this.anchor(object);
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        const sel = view.state.selection;
        const typing = bar === this.selectionBar && sel instanceof TextSelection;
        const caret = typing ? view.coordsAtPos(sel.head) : null;
        const offCaret = (y: number) => () => caret === null || y >= caret.bottom || y + height <= caret.top;
        const x0 = Math.max(base.left, Math.min(anchor.left ?? base.right - width, base.right - width));
        const aboveY = this.clearOfLensRows(anchor.top - GAP - height, height, true);
        const belowY = this.clearOfLensRows(anchor.bottom + GAP, height, false);
        const block = this.textblockDOM(object.from);
        const lineRight = block ? rightEdgeIn(block, anchor.top, anchor.top + height) : -Infinity;
        const besideX = lineRight + GAP;
        const places: Place[] = [
            { x: x0, y: aboveY, when: offCaret(aboveY) },
            { x: besideX, y: anchor.top, when: () => besideX + width <= base.right },
            { x: x0, y: belowY, when: offCaret(belowY) },
        ];
        const found = firstFree(view, this.mount, places, { width, height });
        let x = found?.x ?? x0;
        let y = found?.y ?? belowY;
        if (!found && caret !== null && !offCaret(y)()) {
            y = caret.bottom + GAP;
        }
        x = Math.max(base.left, Math.min(x, base.right - width));
        el.style.left = `${x - base.left}px`;
        el.style.top = `${y - base.top}px`;
    }

    /** The element of the textblock holding position `pos`: the line an inline object stands on. */
    private textblockDOM(pos: number): Element | null {
        const $pos = this.view.state.doc.resolve(Math.min(pos, this.view.state.doc.content.size));
        for (let d = $pos.depth; d > 0; d--) {
            if ($pos.node(d).isTextblock) {
                const dom = this.view.nodeDOM($pos.before(d));
                return dom instanceof Element ? dom : null;
            }
        }
        return null;
    }

    /**
     * `y` moved past another extension's lens rows (`lenses.ts`), which sit
     * right above a block's first line, where a bar goes too — above a row
     * when going up, below it going down — so a candidate place is not one
     * that `firstFree` must refuse for the row (a lens row is `OCCUPIED`).
     */
    private clearOfLensRows(y: number, height: number, up: boolean): number {
        const rows = Array.from(this.view.dom.querySelectorAll(':scope > .mep-lens-row'), r => r.getBoundingClientRect());
        let at = y;
        for (let hit = rows.find(r => at < r.bottom && at + height > r.top); hit; hit = rows.find(r => at < r.bottom && at + height > r.top)) {
            at = up ? hit.top - GAP - height : hit.bottom + GAP;
        }
        return at;
    }

    /**
     * A block's bar covers no content where it can help it, and never moves
     * layout (Daniel, 2026-09-29 and 2026-09-30). The first of these places
     * `firstFree` finds free is where it goes:
     *
     * 1. beside the block's first line, outside it, top-aligned with it — where
     *    the block ends short of the text column's right edge (a table, a short
     *    heading);
     * 2. above the block, right-aligned to the column — where the line above
     *    ends short of it, or a margin is there;
     * 3. inside the block's own box at its top right — a source block, a
     *    container or an admonition whose first line is short — probing the
     *    block's own content;
     * 4. below the block, right-aligned to the column;
     * 5. where none is free: above the block, right-aligned to the column,
     *    regardless — over whatever is there, usually the empty tail of the
     *    line above, as a heading's bar has always stood. Where above is under
     *    the formatting row (the block's top scrolled up to it), the bar could
     *    be neither seen nor clicked there: below the block then, and where
     *    that is past the window's bottom too, at the row's edge — over the
     *    block's own top, still moving nothing.
     *
     * A bar is never given room in the document: a room moved the block down
     * as its bar appeared, and the layout jumped under the reader (a
     * full-width table's bar did it on every visit). A block that draws a box
     * of its own (a table, a source block, a container, an admonition) is its
     * box; a heading or a block with attributes is its text, whose lines in
     * the bar's band must all end before the bar.
     */
    private placeBlock(bar: ObjectBar, object: EditorObject): void {
        const el = bar.el;
        const view = this.view;
        const base = this.mount.getBoundingClientRect();
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        const dom = object.kind === 'link' || object.kind === 'span' ? null : view.nodeDOM(object.from);
        if (!(dom instanceof Element)) {
            return;
        }
        const box = dom.getBoundingClientRect();
        const style = getComputedStyle(view.dom);
        const columnRight = view.dom.getBoundingClientRect().right - (parseFloat(style.paddingRight) || 0);
        const textual = object.kind === 'heading' || object.kind === 'block_attrs';
        const top = (textual ? firstLineTop(dom) : null) ?? box.top;
        const right = textual
            ? rightEdgeIn(dom, top, top + height)
            : box.right - (isBlockObject(object) ? ATOM_INSET : 0);
        const edge = columnRight - width;
        const aboveY = this.clearOfLensRows(box.top - GAP - height, height, true);
        const insideRight = box.right - (isBlockObject(object) ? ATOM_INSET : 0) - GAP;
        const insideY = box.top + (isBlockObject(object) ? ATOM_INSET : GAP);
        const belowY = this.clearOfLensRows(box.bottom + GAP, height, false);
        const ladder: Place[] = [
            { x: right + GAP, y: top, when: () => right + GAP + width <= columnRight },
            { x: edge, y: aboveY },
            ...(textual || object.kind === 'table' ? [] : [{ x: insideRight - width, y: insideY, within: dom }]),
            { x: edge, y: belowY },
        ];
        const found = firstFree(view, this.mount, ladder, { width, height });
        let x = found?.x ?? edge;
        const y = found?.y ?? lastResortY(aboveY, belowY, height, rowCeiling(this.mount));
        x = Math.max(base.left, Math.min(x, base.right - width));
        el.style.left = `${x - base.left}px`;
        el.style.top = `${y - base.top}px`;
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
    private act(object: EditorObject, make: (current: EditorObject) => boolean, hint?: string): void {
        this.view.focus();
        const before = this.view.state;
        const current = currentObject(before, object);
        if (current !== null && make(current) && this.view.state !== before && hint !== undefined) {
            this.say(`${hint} — ${undoKey()}`, 'neutral');
        }
    }

    private say(text: string, tone: HintTone): void {
        showHint(this.view, text, tone);
    }

    /**
     * The object's own verbs, then — for a whole top-level block — the lenses
     * other extensions put on it as verbs (`lenses.ts`), then the code actions
     * they offer for its lines, as the text editor's light bulb would offer
     * them there; each group after a separator.
     */
    private present(object: EditorObject): Presentation {
        const own = this.ownPresentation(object);
        if (!isTopLevelBlock(this.view.state, object)) {
            return own;
        }
        const lenses = this.lensVerbs(this.host.lensesAt(object.from), own.verbs.length > 0);
        const before = own.verbs.length + lenses.length;
        const actions = this.host.codeActionsAt(object.from).map((item, k): Verb => {
            const name = lensName(item.title);
            return {
                id: `code-action:${item.id}`,
                label: item.title,
                title: item.kind ? `${name} (${item.kind}, from another extension)` : `${name} (from another extension)`,
                refusal: item.refusal ?? null,
                separated: k === 0 && before > 0,
                run: () => {
                    this.view.focus();
                    this.host.runCodeAction(item.id);
                },
            };
        });
        return lenses.length + actions.length === 0 ? own : { ...own, verbs: [...own.verbs, ...lenses, ...actions] };
    }

    /**
     * Lenses as verbs: each its title, running its command. Past
     * `LENS_VERBS_INLINE` the first ones stay and the rest are one **Actions**
     * verb, a choice of them. A lens without a command is shown, and refused:
     * it is what the other extension shows there, and runs nothing.
     */
    private lensVerbs(items: readonly LensItem[], separated: boolean): Verb[] {
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
                refusal: id === undefined ? 'The extension that shows it gave it no command.' : null,
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
        if (verbs.length > 0 && separated) {
            verbs[0] = { ...verbs[0], separated: true };
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
                return {
                    label: NOTE_LABELS[name],
                    title: sidebar ? 'A sidebar: its text is set beside the main text.' : 'A note: its reference is in the sentence, its text beside it.',
                    verbs: [
                        {
                            id: 'remove-note',
                            label: sidebar ? 'Remove sidebar, keep text' : 'Remove note, keep text',
                            title: sidebar
                                ? 'The sidebar goes; its text stays in the sentence, with its formatting.'
                                : 'The note goes; its reference stays in the sentence, with its formatting. The note\'s own text is dropped.',
                            refusal: refusalOnce(view.state, `remove-note@${object.from}:${object.to}`, () => unwrapNoteRefusal(view.state, name)),
                            run: () => this.act(object, () => unwrapNote(name)(view.state, dispatch), sidebar ? 'Sidebar removed' : 'Note removed'),
                        },
                        {
                            id: 'convert-note',
                            label: CONVERT_LABELS[name],
                            title: `Make it a ${NOTE_LABELS[NOTE_CONVERSION[name]].toLowerCase()}, its text kept.`,
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
                            label: 'Edit source',
                            title: `Edit ${source} as Markdown (Enter to apply, Esc to cancel).`,
                            refusal: source.includes('\n') ? 'It holds a line break, which a one-line field cannot show: edit it in the text editor.' : null,
                            field: { value: source, label: 'Markdown', commit: value => this.commitNoteSource(object, source, value) },
                        },
                    ],
                };
            }
            case 'link': {
                const href = object.mark.attrs.href as string;
                return {
                    label: 'Link',
                    title: href,
                    verbs: [
                        { id: 'open-link', label: 'Open', title: `Open ${href} (as Ctrl+click does).`, run: () => host.openLink(href) },
                        {
                            // The field Ctrl+K and Insert → Link… open in a link, with the same completion.
                            id: 'edit-link',
                            label: 'Edit link…',
                            title: 'Link the text to another address: a file, a #heading, a web address (Enter to apply, Esc to cancel).',
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
                        {
                            id: 'remove-link',
                            label: 'Remove link',
                            title: 'The link goes; its text stays.',
                            refusal: refusalOnce(view.state, `remove-link@${object.from}:${object.to}`, () => removeLinkRefusal(view.state, object)),
                            run: () => this.act(object, current => {
                                if (current.kind !== 'link') {
                                    return false;
                                }
                                dispatch(removeLinkTransaction(view.state, current));
                                return true;
                            }, 'Link removed'),
                        },
                    ],
                };
            }
            case 'image': {
                const src = object.node.attrs.src as string;
                const alt = (object.node.attrs.alt as string | null) ?? '';
                return {
                    label: 'Image',
                    title: alt === '' ? src : `${alt}: ${src}`,
                    verbs: [
                        {
                            id: 'edit-image',
                            label: 'Edit image…',
                            title: 'Its alt text, then its path, each in the field (Enter to go on and apply, Esc to cancel).',
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
                        { id: 'open-image', label: 'Open file', title: `Open ${src} (as Ctrl+click on a link does).`, run: () => host.openLink(src) },
                        {
                            id: 'remove-image',
                            label: 'Remove image',
                            title: 'The image goes from the text.',
                            refusal: refusalOnce(view.state, `remove-image@${object.from}:${object.to}`, () => deleteObjectRefusal(view.state, object)),
                            run: () => this.remove(object, 'Image removed'),
                        },
                    ],
                };
            }
            case 'span': {
                const literal = object.mark.attrs.literal as string;
                return {
                    label: 'Span',
                    title: `[text]${literal}: a span with these attributes.`,
                    verbs: [
                        {
                            id: 'edit-attributes',
                            label: 'Edit attributes',
                            title: 'Change the span\'s {…} (Enter to apply, Esc to cancel).',
                            field: {
                                value: literal,
                                label: 'Attributes',
                                commit: value => this.commitLiteral(object, value, current =>
                                    current.kind === 'span' ? changeSpanTransaction(view.state, current, value) : null),
                            },
                        },
                        {
                            id: 'remove-attributes',
                            label: 'Remove attributes, keep text',
                            title: 'The span goes; its text stays, with its formatting.',
                            refusal: refusalOnce(view.state, `remove-attributes@${object.from}:${object.to}`, () => removeSpanRefusal(view.state, object)),
                            run: () => this.apply(object, current => (current.kind === 'span' ? removeSpanTransaction(view.state, current) : null), 'Attributes removed'),
                        },
                    ],
                };
            }
            case 'container': {
                const name = object.node.attrs.name as string;
                const info = object.node.attrs.info as string;
                return {
                    label: name === '' ? 'Container' : `Container ${name}`,
                    title: `A block with the class "${containerClass(name, info)}".`,
                    verbs: [
                        {
                            id: 'change-name',
                            label: 'Change name/info',
                            title: 'What follows ::: — the classes the block gets (Enter to apply, Esc to cancel).',
                            field: {
                                value: `${name}${info}`,
                                label: 'Name and info',
                                commit: value => {
                                    if (containerNameOf(value) === null) {
                                        this.view.focus();
                                        this.say('A container\'s name and info are one line, and cannot end in {…}: markdown-it-attrs would take that as attributes.', 'refusal');
                                        return;
                                    }
                                    this.apply(object, current => changeContainerTransaction(view.state, current.from, value));
                                },
                            },
                        },
                        this.attributesVerb(object),
                        {
                            id: 'remove-container',
                            label: 'Remove container, keep content',
                            title: 'The container goes; its blocks stay where it stood.',
                            run: () => this.apply(object, current => unwrapTransaction(view.state, current.from), 'Container removed'),
                        },
                    ],
                };
            }
            case 'admonition': {
                const type = object.node.attrs.type as string;
                const title = object.node.attrs.title as string;
                return {
                    label: `Admonition ${type}`,
                    title: title === '' ? `A ${type} admonition without a title.` : `A ${type} admonition: ${title}`,
                    verbs: [
                        {
                            id: 'change-type',
                            label: 'Change type',
                            title: 'Another of the plugin\'s types: another colour and icon.',
                            choice: {
                                value: type,
                                label: 'Type',
                                options: ADMONITION_TYPES.map(t => ({ value: t, label: t })),
                                commit: value => this.apply(object, current => changeAdmonitionTransaction(view.state, current.from, { type: value })),
                            },
                        },
                        {
                            id: 'edit-title',
                            label: 'Edit title',
                            title: 'The title bar\'s text; empty for no title bar (Enter to apply, Esc to cancel).',
                            field: {
                                value: title,
                                label: 'Title',
                                commit: value => this.apply(object, current => changeAdmonitionTransaction(view.state, current.from, { title: value })),
                            },
                        },
                        this.attributesVerb(object),
                        {
                            id: 'remove-admonition',
                            label: 'Remove admonition, keep content',
                            title: 'The admonition goes; its blocks stay where it stood.',
                            run: () => this.apply(object, current => unwrapTransaction(view.state, current.from), 'Admonition removed'),
                        },
                    ],
                };
            }
            case 'table':
                return this.tablePresentation(object);
            case 'block_attrs': {
                const literal = (object.node.attrs.attrsSuffix as string | null) ?? '';
                return {
                    label: `${BLOCK_NAMES[object.node.type.name] ?? 'Block'} attributes`,
                    title: `${literal}: the attributes the block is rendered with.`,
                    verbs: [this.attributesVerb(object)],
                };
            }
            case 'wiki_embed':
                return {
                    label: 'Wiki embed',
                    title: `${object.node.attrs.source as string}: kept as written, for the extension that renders embeds (Foam).`,
                    verbs: wikiEmbedVerbs(view.state, object, {
                        asText: () => this.act(object, current => {
                            const tr = embedAsTextTransaction(this.view.state, current.from, current.to);
                            if (tr !== null) {
                                this.view.dispatch(tr);
                            }
                            return tr !== null;
                        }, 'Embed is text'),
                        remove: () => this.remove(object, 'Embed removed'),
                    }),
                };
            case 'emoji': {
                const source = object.node.attrs.source as string;
                return {
                    label: `Emoji ${source}`,
                    title: `${source}: kept as written, saved as it stands in the file.`,
                    verbs: emojiVerbs(view.state, object, {
                        asText: () => this.act(object, current => {
                            const tr = emojiAsTextTransaction(this.view.state, current.from, current.to);
                            if (tr !== null) {
                                this.view.dispatch(tr);
                            }
                            return tr !== null;
                        }, 'Emoji is text'),
                        remove: () => this.remove(object, 'Emoji removed'),
                    }),
                };
            }
            case 'badge': {
                const mark = object.node.attrs.mark as { rule?: unknown } | null;
                return {
                    label: mark?.rule === 'req-status-badges' ? 'Status badge' : 'Injected content',
                    title: 'Shown here by another extension; the file holds nothing at this place.',
                    verbs: [],
                };
            }
            case 'raw_block':
                return {
                    ...rawBlockLabel(object.node.attrs.construct as string | null),
                    verbs: [
                        {
                            id: 'edit-source',
                            label: 'Edit source',
                            title: 'Edit this block as Markdown (Ctrl+Enter to apply, Esc to cancel).',
                            run: () => {
                                if (currentObject(view.state, object)) {
                                    editRawSourceAt(view, object.from);
                                }
                            },
                        },
                        this.showInTextEditor(object),
                        { id: 'delete-block', label: 'Delete block', title: 'The block goes from the file.', run: () => this.remove(object, 'Block deleted') },
                    ],
                };
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
                if (typeof path === 'string' && !mark?.missing) {
                    verbs.push({ id: 'open-snippet', label: 'Open snippet', title: path, run: () => host.openSnippet(path) });
                }
                // Offered on a missing snippet too: choosing another is how it is mended.
                verbs.push({
                    id: 'change-snippet',
                    label: 'Change snippet…',
                    title: 'Choose another snippet for this directive from the ones the extensions offer.',
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
                        label: 'Delete directive',
                        // The line is named, not spelled: its syntax is the extension's that resolves it.
                        title: `The directive line of ${snippet} goes from the file, and the snippet with it; the snippet's own file stays.`,
                        run: () => this.remove(object, 'Directive deleted'),
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
                    id: 'row', label: 'Row', title: 'Insert a row next to the caret\'s, or delete it.',
                    menu: [
                        entry('insert-row-above', 'Insert above', 'A new row above the caret\'s; above the header row it is the new header.', () => addRowTransaction(view.state, 'above')),
                        entry('insert-row-below', 'Insert below', 'A new row below the caret\'s. Tab in the last cell adds one too.', () => addRowTransaction(view.state, 'below'), { keys: 'Tab at end' }),
                        entry('delete-row', 'Delete row', 'The caret\'s row goes; deleting the header row makes the next row the header.',
                            () => deleteRowTransaction(view.state), { refusal: deleteRowRefusal(state) }, 'Row deleted'),
                    ],
                },
                {
                    id: 'column', label: 'Column', title: 'Insert a column next to the caret\'s (tinted), or delete it.',
                    menu: [
                        entry('insert-column-left', 'Insert left', 'A new column left of the caret\'s.', () => addColumnTransaction(view.state, 'left')),
                        entry('insert-column-right', 'Insert right', 'A new column right of the caret\'s.', () => addColumnTransaction(view.state, 'right')),
                        entry('delete-column', 'Delete column', 'The caret\'s column goes.', () => deleteColumnTransaction(view.state), { refusal: deleteColumnRefusal(state) }, 'Column deleted'),
                    ],
                },
                {
                    id: 'align', label: 'Align', title: 'How the caret\'s column (tinted) is aligned: the colons of its delimiter cell.',
                    menu: [alignEntry('left', 'Left', ':--'), alignEntry('center', 'Center', ':-:'), alignEntry('right', 'Right', '--:')],
                },
                { ...this.attributesVerb(object), separated: true },
                {
                    id: 'edit-source',
                    label: 'Edit source',
                    title: 'Edit this table as Markdown (Ctrl+Enter to apply, Esc to cancel).',
                    run: () => this.editTableSource(object),
                },
                { id: 'delete-table', label: 'Delete table', title: 'The table goes from the file.', run: () => this.remove(object, 'Table deleted') },
            ],
        };
    }

    /**
     * **Attributes…** on a block's bar: the same field as **Formatting →
     * Attributes…** (`attributesStep`), for this block — refused, with the
     * reason, on a container and an admonition, whose renderers drop a literal.
     */
    private attributesVerb(object: EditorObject): Verb {
        const found = object.kind === 'link' || object.kind === 'span' ? { refusal: NO_BLOCK_ATTRS_REFUSAL } : attributesTargetOf(object.node, object.from);
        const refused = 'refusal' in found;
        return {
            id: 'block-attributes',
            label: 'Attributes…',
            title: 'The block\'s {…}: {.class}, {#id}, {key=value}; {} removes it (Enter to apply, Esc to cancel).',
            refusal: refused ? found.refusal : null,
            field: refused ? undefined : attributesStep(this.view, found),
        };
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
        return { id: 'show-in-text-editor', label: 'Show in text editor', title: 'Open the text editor beside, at this block.', run: () => this.host.openSourceAt(object.from) };
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
     * A literal typed into a field: refused, with the reason beside the caret,
     * when markdown-it-attrs would not read it as attributes (`''` is allowed
     * where it means "none"); applied otherwise.
     */
    private commitLiteral(object: EditorObject, value: string, make: (current: EditorObject) => Transaction | null, hint?: string): void {
        const place = 'node' in object ? literalPlaceOf(object.node) : 'span';
        const current = currentObject(this.view.state, object);
        const refusal = hint !== undefined && value.trim() === '' ? null
            : current?.kind === 'span' ? changeSpanRefusal(this.view.state, current, value) : literalRefusal(value, place);
        if (refusal !== null) {
            this.view.focus();
            this.say(refusal, 'refusal');
            return;
        }
        this.apply(object, make, hint);
    }

    private remove(object: EditorObject, hint: string): void {
        this.act(object, current => {
            this.view.dispatch(deleteObjectTransaction(this.view.state, current));
            return true;
        }, hint);
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
            this.say('This note cannot be written as source here.', 'refusal');
            return;
        }
        this.view.dispatch(tr);
        this.host.flushReparse();
    }
}

const toolbarViews = new WeakMap<EditorView, ObjectToolbarView>();

/** The object toolbar, as a plugin: its view follows every state, and `Alt+Enter` opens it from the keyboard. */
export function objectToolbarPlugin(host: ObjectToolbarHost): Plugin<BarDecor> {
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
                return { tint: tr.mapping.map(value.tint) };
            },
        },
        view(editorView) {
            const toolbar = new ObjectToolbarView(editorView, host);
            toolbarViews.set(editorView, toolbar);
            return toolbar;
        },
        props: {
            decorations(state) {
                return barDecorations(state, decorKey.getState(state) ?? NO_DECOR);
            },
            handleKeyDown(view, event) {
                if (event.key !== 'Enter' || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                    return false;
                }
                const opened = toolbarViews.get(view)?.openFromKeyboard() ?? false;
                if (opened) {
                    event.preventDefault();
                }
                return opened;
            },
        },
    });
}
