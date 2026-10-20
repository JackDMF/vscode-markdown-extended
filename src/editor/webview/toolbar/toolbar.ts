/**
 * The formatting toolbar at the top of the page, its menus and preview card,
 * and the bubble over a text selection — drawn from the action table
 * (`actions.ts`) and applied through `commands.ts`.
 *
 * - **The row** is one line of uniform controls: the block-type menu, the five
 *   native marks, the Formatting, Annotation and Insert menus — and, pinned at
 *   its right end with the diagnostics count, the Export menu, which acts on
 *   the document rather than the selection. It never wraps and never
 *   scrolls: narrow, what does not fit moves into a "…" menu (`layoutRow`,
 *   `ROW_OVERFLOW`). A mark's glyph is its real element (`<i>`, `<em>`, …)
 *   held to the button's size.
 * - **A menu** lists its entries as glyph · word · syntax — the glyph the element
 *   the parser makes, styled by the page's cascade, at its natural size and
 *   clipped; the Block type entries draw their word as the element, zoomed to
 *   the entry height no lower than `SAMPLE_ZOOM_FLOOR`.
 * - **The hover** (`tooltip.ts`) names a row or bubble control — a mark's word,
 *   delimiter, element and key — and says why it is refused; a menu entry has
 *   none (its card says it).
 * - **The preview card** shows the hovered or focused entry at its natural size,
 *   in a short example, 300 ms after the pointer or the focus reaches it.
 * - **The bubble** offers, over a text selection, the five native marks, the
 *   extension's five (highlight, super- and subscript, strikethrough, key)
 *   and the two notes (`inBubble`).
 *
 * Everything lives inside the page's `body.markdown-body`, so a sample is
 * styled by the same stylesheets as the document; only the chrome is
 * `styles/editor.css`. The menus and the card are positioned `fixed` in a layer
 * of their own: the row clips what hangs out of it.
 *
 * Controls act on `mousedown` + `preventDefault`, so the editor keeps its focus
 * and its selection; they are reachable by Tab, menus by the arrow keys.
 */
import { EditorState, NodeSelection, Plugin, PluginView, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { ExportFormatName, LinkChoice, LinkedFile } from '../../protocol';
import { EXPORT_FORMATS } from '../../../services/exporter/formats';
import { editorSchema } from '../../schema';
import { LayerSlot, REST_MS, caretRect, placeCard, placeMenu, rangeAnchor } from '../placement';
import { showHint } from '../hint';
import { FieldStep, InlineField, fieldAside, fieldHeading, refusedStep } from '../inlineField';
import { chevronNode, lensLabelNodes } from '../lenses';
import { clearPendingRange, showPendingRange } from '../pendingRange';
import { ControlRole, FocusPlace, RowScope, focusPlace, lockForms, placeOfElement, rowLock } from '../focusPlace';
import { editRawSourceAt } from '../nodeViews';
import { addPropertyAt } from '../properties';
import { inNoteOf, toggleNote, unwrapNoteRefusal, wrapNodeLockReason } from '../notes';
import {
    applySpanRefusal, applySpanTransaction, attributeHolderAt, holderMarkup, holderNames, InlineHolderAt, attributesTargetAt, changeLinkTransaction, currentObject, editImageTransaction, IMAGE_LOCK, insertFilesTransaction, insertLinkTransaction,
    insertLockReason, LINK_LOCK, NO_ATTRS_REFUSAL, objectAtSelection, spanLockReason,
} from '../objects';
import { currentReadsAttrs } from '../../inlineEngine';
import { ATTRIBUTES_FIELD_KEYS, attributesStep, holderAttributesStep } from '../attributes';
import { insertTableTransaction } from '../tables';
import {
    ActionPreview, CLASS_LITERAL, FEWER_TYPES, SOURCE_NOTE, isSourceAction, INLINE_ATTRS_LOCK, MENU_LABELS, MORE_TYPES, NO_INCLUDES_REFUSAL, PREVIEW_CARD_CLASS, PROPERTIES_PRESENT_REFUSAL, ROW_LAYOUT, ROW_OVERFLOW, RowControl, SAMPLE_CLASS, SPAN_FIELD_PREFILL, SUBMENU_GLYPH, SUBMENU_SYNTAX, SampleSpec,
    TOOLBAR_ACTIONS, ToolbarAction, ToolbarMenu, ToolbarSubmenu, aliasNote, ariaLabelOf, elideDataUris, inBubble, inRow, menuOf, moreOrder, submenuOf, tipOf,
} from './actions';
import { moreControl, moreName, moveUntilFits, overflows } from '../overflow';
import { ariaKeyshortcuts, keyLabel } from '../../keys';
import { Tip, plainTip } from '../../tips';
import { macKeys } from '../hint';
import { Tooltips, describeAs } from '../tooltip';
import {
    SourceContext, WRAP_LOCK, blockCommand, blockLockReason, canWrapSource, currentBlock, insertPropertiesTransaction, insertSourceTransaction, insertWrapperTransaction, isCurrent,
    markActive, markRefusal, toggleMarkup, wrapSourceTransaction,
} from './commands';

/** What the toolbar needs from the page. */
export interface ToolbarHost {
    sourceContext(): SourceContext;
    /** Send the document now and ask the host to parse it again (`edit.reparse`). */
    flushReparse(): void;
    /** Ask the host to render a new source block. */
    requestRender(src: string): void;
    /** Whether any extension offers includes for this document (the `document` message's `includes`). */
    includesOffered(): boolean;
    /** Ask the host for an include line; the page inserts the answer after the current block (`main.ts`). */
    pickInclude(): void;
    /** What a link's (with `images`, an image's) path may complete to: the host's answer to `linkChoices`. */
    linkChoices(query: string, images: boolean): Promise<LinkChoice[]>;
    /** Ask the host for an image file (VS Code's open dialog); `chosen` gets it, as the page inserts it, unless the page moved on. */
    pickImage(chosen: (files: LinkedFile[]) => void): void;
    /** Export the document in `format`: what the open source boxes hold committed and the pending edit sent first, as before a save (`main.ts`). */
    exportDocument(format: ExportFormatName): void;
    /** Open VS Code's Settings at the export's settings. */
    exportSettings(): void;
    /** The format of an export the page asked for that runs still — from the press until the host's `exportDone` — or `null`. */
    exporting(): ExportFormatName | null;
}

interface ExportEntry {
    id: string;
    label: string;
    detail?: string;
    /** An export: refused while another runs. */
    exports: boolean;
    separated?: true;
    run: (host: ToolbarHost) => void;
}

/**
 * The entries of the Export menu at the row's right end: the export's formats
 * from their one table (`formats.ts`, which the format quick pick lists too),
 * then the settings. Not in the action table (`actions.ts`): an action there
 * edits the text at the selection, and carries the element it makes and the
 * syntax it writes, checked against the parser; these act on the document as
 * a whole and make a file, so they have neither, and the row's lock does not
 * refuse them (`RowScope`). Plain text, the format and how it is made.
 */
const EXPORT_ENTRIES: readonly ExportEntry[] = [
    ...EXPORT_FORMATS.map((f): ExportEntry => ({ id: f.format, label: f.label, detail: f.detail, exports: true, run: host => host.exportDocument(f.format) })),
    { id: 'settings', label: 'Export settings…', exports: false, separated: true, run: host => host.exportSettings() },
];

/** The Export menu's face: its label, and the codicon before it. */
const EXPORT_LABEL = 'Export';

/** A format as the menu and the quick pick name it (`formats.ts`). */
function formatLabel(format: ExportFormatName): string {
    return EXPORT_FORMATS.find(f => f.format === format)?.label ?? format;
}

/**
 * What Export's face says while an export of `format` runs: `Exporting PDF…`
 * where the row has the room, `PDF…` where it has not (`layoutRow`); the
 * tooltip always says it whole (Daniel, 2026-10-19).
 */
export function exportBusyLabel(format: ExportFormatName, room: 'full' | 'short'): string {
    return room === 'full' ? `Exporting ${formatLabel(format)}…` : `${formatLabel(format)}…`;
}

/** Why the other formats are refused while an export of `format` runs: the face's note and their description. */
export function exportBusyNote(format: ExportFormatName): string {
    return `Exporting ${formatLabel(format)} — the other formats wait for it`;
}

/** What the running format's entry says in place of how it is made. */
const EXPORT_RUNNING_DETAIL = 'exporting…';

/** The workbench's busy codicon, spinning (`codicon-modifier-spin`); held still where motion is reduced (`editor.css`). */
function spinner(): globalThis.Node[] {
    const nodes = lensLabelNodes('$(loading)');
    for (const node of nodes) {
        if (node instanceof HTMLElement) {
            node.classList.add('codicon-modifier-spin');
        }
    }
    return nodes;
}

/** How long the pointer or the focus rests on an entry before its preview card shows. */
const PREVIEW_DELAY_MS = 300;

/** The class that points at the lock's reason after a refused press (`editor.css`), and how long it stays. */
const LOCK_FLASH_CLASS = 'mep-row-lock-flash';
const LOCK_FLASH_MS = 900;

/** On the row while the lock's reason stands in the refused tools' place: they give way to it (`layoutRow`, `editor.css`). */
const LOCK_INROW_CLASS = 'mep-row-lock-inrow';

/**
 * The least a Block type sample is zoomed to fit its entry (`fitSamples`):
 * below it a label stops being read — the code block's stood at 0.42 — so
 * what still stands out is clipped instead.
 */
const SAMPLE_ZOOM_FLOOR = 0.75;

/** Draw a sample: the element the parser makes, with its classes, attributes and content. */
export function renderSample(spec: SampleSpec): HTMLElement {
    const node = document.createElement(spec.tag);
    if (spec.className) {
        node.className = spec.className;
    }
    for (const [name, value] of Object.entries(spec.attrs ?? {})) {
        node.setAttribute(name, value);
    }
    for (const child of spec.children ?? []) {
        node.append(typeof child === 'string' ? child : renderSample(child));
    }
    return node;
}

function sampleHolder(spec: SampleSpec): HTMLElement {
    const holder = span(SAMPLE_CLASS);
    holder.append(renderSample(spec));
    return holder;
}

/** A menu entry's swatch: the element at its natural size (clipped by `editor.css`), chrome text, or empty. */
function glyphOf(glyph: SampleSpec | { text: string } | null): HTMLElement {
    const holder = span('mep-entry-glyph');
    holder.setAttribute('aria-hidden', 'true');
    if (glyph === null) {
        return holder;
    }
    if ('tag' in glyph) {
        holder.append(sampleHolder(glyph));
    } else {
        holder.classList.add('mep-glyph-text');
        holder.textContent = glyph.text;
    }
    return holder;
}

function span(className: string, text?: string): HTMLElement {
    const node = document.createElement('span');
    node.className = className;
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

/**
 * The entry under the pointer takes the focus, as in the workbench's menus,
 * when the menu holds the focus already (opened from the keyboard, or by a
 * set-verb): an entry under the pointer and another holding the focus would
 * be drawn alike, and `Enter` would run the one the reader is not looking at.
 * A menu opened by a click leaves the focus in the text, and so it stays.
 */
export function followPointer(panel: HTMLElement, item: HTMLElement): void {
    if (panel.contains(document.activeElement) && document.activeElement !== item) {
        item.focus({ preventScroll: true });
    }
}

/**
 * What the inline holder at the selection makes the Formatting entry and the
 * bubble's `{…}` say: its name by its delimiter (`Attributes of Bold…`,
 * `holderNames`), and its syntax and card written as it — the card drawing the
 * element the engine renders it as, none for an image (`example`, `tag` in
 * `inlineLiterals.ts`).
 */
function inlineEntry(inline: InlineHolderAt): { label: string; syntax: string; preview: ActionPreview } {
    const label = `Attributes of ${holderNames(inline).label}…`;
    const markup = holderMarkup(inline);
    const holder = inline.holder;
    const tag = holder.tag?.(markup);
    const text = holder.holder === 'code' ? 'code' : holder.holder === 'image' ? 'alt' : 'text';
    return {
        label,
        syntax: holder.example(text, CLASS_LITERAL, markup),
        preview: {
            markdown: `Run ${holder.example('--flag', '{.k}', markup)} now.`,
            nodes: tag === undefined ? [] : [{ tag: 'p', children: ['Run ', { tag, className: 'k', children: ['--flag'] }, ' now.'] }],
        },
    };
}

/** The word an entry shows, where the selection names it (`Attributes of Bold…`, `ActionState.label`); its glyph, `{…}`, stays. */
function relabel(item: HTMLElement, label: string): void {
    const word = item.querySelector('.mep-entry-label');
    if (word !== null && word.textContent !== label) {
        word.textContent = label;
    }
}

/** The syntax column an entry shows, where the selection decides it. */
function resyntax(item: HTMLElement, syntax: string): void {
    const column = item.querySelector('.mep-entry-syntax');
    if (column !== null && column.textContent !== syntax) {
        column.textContent = syntax;
    }
}

/** What the span's entry, and the bubble's `{…}` outside an element, are called (`actions.ts`). */
const SPAN_LABEL = TOOLBAR_ACTIONS.find(a => a.apply.kind === 'attr-span')?.label ?? 'Span with class…';

/** Why Span with class makes no span where its literal alone is fine: the note around it, or the block read whole, would not hold it. */
const SPAN_REFUSED = 'These attributes cannot be given to this text here.';

function div(className: string): HTMLElement {
    const node = document.createElement('div');
    node.className = className;
    return node;
}

export interface ActionState {
    enabled: boolean;
    active: boolean;
    /** Why a disabled action is disabled, when there is something to say. */
    reason: string | null;
    /**
     * What the selection names the action (`Attributes of Paragraph…`, `Attributes of Code…`):
     * its sample's text and its tooltip's name, where the action's own label is only the resting form.
     */
    label?: string;
    /** The whole tooltip but its reason, where the selection decides what the action does (the bubble's `{…}`). */
    tip?: Tip;
    /** What a named entry's syntax column and card say, where the selection decides it (`Attributes of Bold…` as `**text**{.class}`). */
    syntax?: string;
    preview?: ActionPreview;
    /** The button's accessible name, where the selection decides what it does (the bubble's `{…}`). */
    ariaLabel?: string;
}

/** Whether each action applies at the selection, and whether it is what the selection already has. */
export function evaluate(action: ToolbarAction, state: EditorState, includes: boolean): ActionState {
    const apply = action.apply;
    switch (apply.kind) {
        case 'mark': {
            const type = editorSchema.marks[apply.mark];
            const reason = markRefusal(state, type, apply.markup);
            return { enabled: reason === null && toggleMarkup(type, apply.markup)(state), active: markActive(state, type, apply.markup), reason };
        }
        case 'wrap-node': {
            // Inside a note of its kind the action removes it, like a mark's button,
            // and is refused where the object bar's Delete note / Remove sidebar is (`unwrapNoteRefusal`).
            if (inNoteOf(state, apply.node)) {
                const unwrap = unwrapNoteRefusal(state, apply.node);
                return { enabled: unwrap === null, active: true, reason: unwrap };
            }
            const reason = wrapNodeLockReason(state, apply.node);
            return { enabled: reason === null, active: false, reason };
        }
        case 'block': {
            if (apply.node === 'horizontal_rule') {
                return { enabled: true, active: false, reason: null };
            }
            const reason = blockLockReason(state);
            const active = reason === null && isCurrent(currentBlock(state), apply.node, apply.level);
            return { enabled: reason === null && (active || blockCommand(apply.node, apply.level)(state)), active, reason };
        }
        case 'wrap-source': {
            const enabled = canWrapSource(state);
            return { enabled, active: false, reason: enabled ? null : WRAP_LOCK };
        }
        case 'insert-source':
        case 'insert-wrapper':
        case 'insert-table':
            return { enabled: true, active: false, reason: null };
        case 'insert-include':
            return { enabled: includes, active: false, reason: includes ? null : NO_INCLUDES_REFUSAL };
        case 'insert-properties': {
            const present = state.doc.firstChild?.type === editorSchema.nodes.front_matter;
            return { enabled: !present, active: false, reason: present ? PROPERTIES_PRESENT_REFUSAL : null };
        }
        case 'attr-span': {
            const reason = spanLockReason(state);
            return { enabled: reason === null, active: false, reason };
        }
        case 'block-attrs': {
            // Named by the block it acts on (`attributeHolderAt`'s block half), the refused form by none.
            const target = attributeHolderAt(state).block;
            return 'refusal' in target
                ? { enabled: false, active: false, reason: target.refusal, label: 'Attributes of Block…' }
                : { enabled: true, active: false, reason: null, label: `Attributes of ${target.name}…` };
        }
        case 'inline-attrs': {
            // Named by the inline element it acts on, the one its bar and the bubble name (`attributeHolderAt`),
            // and drawn as that element, its syntax and card written as it (`inlineEntry`).
            const inline = currentReadsAttrs() ? attributeHolderAt(state).inline : null;
            return inline === null
                ? { enabled: false, active: false, reason: currentReadsAttrs() ? INLINE_ATTRS_LOCK : NO_ATTRS_REFUSAL, label: action.label }
                : { enabled: true, active: false, reason: null, ...inlineEntry(inline) };
        }
        case 'attrs-bubble': {
            // Within one element's run, its attributes — the one the menu and its bar name
            // (`attributeHolderAt`) — else an attribute span made of the selection.
            const inline = currentReadsAttrs() && !state.selection.empty ? attributeHolderAt(state).inline : null;
            // Never drawn as on: it is no toggle. What it targets is its name and its tooltip.
            if (inline !== null) {
                const entry = inlineEntry(inline);
                return { enabled: true, active: false, reason: null, tip: { parts: [`${entry.label} — `, { code: entry.syntax }] }, ariaLabel: entry.label };
            }
            const reason = spanLockReason(state);
            return { enabled: reason === null, active: false, reason, tip: { parts: [`${SPAN_LABEL} — `, { code: `[text]${CLASS_LITERAL}` }] }, ariaLabel: SPAN_LABEL };
        }
        case 'insert-link': {
            const reason = objectAtSelection(state)?.kind === 'link' ? null : insertLockReason(state, LINK_LOCK);
            return { enabled: reason === null, active: false, reason };
        }
        case 'insert-image': {
            const reason = insertLockReason(state, IMAGE_LOCK);
            return { enabled: reason === null, active: false, reason };
        }
    }
}

/** Anything that performs an action: a row button, a bubble button, a menu entry. */
interface Tool {
    action: ToolbarAction;
    el: HTMLElement;
}

interface Menu {
    id: ToolbarMenu | ToolbarSubmenu | 'export' | 'more';
    panel: HTMLElement;
    /** Its entries in order, the submenu's opener included; the arrow keys move between them. */
    items: HTMLElement[];
    tools: Tool[];
    /** Entries that are no action of the table — the Export menu's — and what each does. */
    commands: Map<HTMLElement, () => void>;
    /** What the menu acts on, so whether the row's lock refuses it (`rowLock`). */
    scope: RowScope;
    /** A top-level menu's face in the row. */
    face?: HTMLElement;
    /** Hung from its face's right edge, not its left: the row's last control, at the window's edge. */
    alignEnd?: true;
    /**
     * A submenu's entry in its parent, and the parent. A row menu moved into
     * "…" (`layoutRow`) keeps its face and has its entry there as `opener`;
     * `parent` is "…" only while it is moved, so it is a submenu exactly then.
     */
    opener?: HTMLElement;
    parent?: Menu;
    children: Menu[];
    /** Opened as a top-level menu: it hides the floating layer (`LayerSlot.suppress`) until it closes, whatever it is by then. */
    suppressing?: true;
    /** "More types…": the entry that shows the entries kept behind it (`ToolbarAction.alias`) in place, and those entries. */
    more?: { item: HTMLElement; hidden: HTMLElement[]; count: number };
}

function setState(node: HTMLElement, enabled: boolean, active: boolean): void {
    node.classList.toggle('mep-active', active);
    node.classList.toggle('mep-disabled', !enabled);
    node.setAttribute('aria-disabled', String(!enabled));
}

function isDisabled(node: HTMLElement): boolean {
    return node.getAttribute('aria-disabled') === 'true';
}

/** An entry the keys may move to: offered, and shown (an alias waits under "More types…" until it is pressed). */
function reachable(node: HTMLElement): boolean {
    return !isDisabled(node) && !node.hidden;
}

/** A divider of a bar (`.mep-object-toolbar`): after its title, and where `arrange` (`verbs.ts`) divides its verbs. */
export function barSeparator(): HTMLElement {
    const rule = span('mep-object-separator');
    rule.setAttribute('role', 'separator');
    return rule;
}

/** A divider between groups of a menu's entries; the bars' menus draw it too (`objectToolbar.ts`). */
export function separator(): HTMLElement {
    const rule = div('mep-menu-separator');
    rule.setAttribute('role', 'separator');
    return rule;
}

/** What opens `menu` and gets the focus back from it: its entry in its parent while it is a submenu, else its face. */
function triggerOf(menu: Menu): HTMLElement | undefined {
    return menu.parent ? menu.opener : menu.face;
}

class ToolbarView implements PluginView {
    private readonly mount: HTMLElement;
    private readonly row: HTMLElement;
    private readonly bubble: HTMLElement;
    /** Where the menus and the card are, outside the row that clips. */
    private readonly layer: HTMLElement;
    private readonly card: HTMLElement;
    private readonly tools: Tool[] = [];
    private readonly menus: Menu[] = [];
    /** The Export menu's format entries: refused while an export runs. */
    private readonly formatItems: HTMLElement[] = [];
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];
    private cardTimer: ReturnType<typeof setTimeout> | undefined;
    /** The field an action asked for a value in (a span's literal, a link's address, an image's alt text), while it is open. */
    private fieldBar: { bar: HTMLElement; field: InlineField } | null = null;
    private destroyed = false;
    /** The row's reason while it is locked (`layoutRow`), in the row, and what kind of control locked it; `null` when none does. */
    private lockNote!: HTMLElement;
    private lockRole: ControlRole | null = null;
    private flashTimer: ReturnType<typeof setTimeout> | undefined;
    /** A pointer button is down: a selection it draws shows its bubble at the release (`bubbleReleased`). */
    private pointerHeld = false;
    /** Watches the row and its status for a size that changes what fits in it (`layoutRow`). */
    private rowSize: ResizeObserver | undefined;
    /** "…": the menu that holds what does not fit in the row (`layoutRow`), its face, and the group the face stands in. */
    private more!: Menu;
    private moreFace!: HTMLElement;
    private moreGroup!: HTMLElement;
    /** In "…", between the moved marks and the moved menus. */
    private moreDivider!: HTMLElement;
    /** Each control that may leave the row: its element in the row, and its entry in "…". */
    private readonly rowControls = new Map<RowControl, HTMLElement>();
    private readonly overflowEntries = new Map<RowControl, HTMLElement>();
    /** The row's menus by id; all but Block type may move into "…". */
    private readonly rowMenus = new Map<ToolbarMenu, Menu>();
    /** What is in "…" now, in the order it left the row (`ROW_OVERFLOW`). */
    private moved: readonly RowControl[] = [];
    /** Export's label: `layoutRow` names the running format in it, as the row's room allows. */
    private exportLabel!: HTMLElement;
    /** What the last layout was measured for (`layoutRow`): the same again measures nothing. */
    private layoutKey = '';
    /** The update a focus move asked for, while it waits. */
    private focusTimer: ReturnType<typeof setTimeout> | undefined;
    /** The hover of the row's controls and the bubble's (`tooltip.ts`), shared with the bars. */
    private readonly tips: Tooltips;
    /** What each control's hover says now, written by `update`. */
    private readonly tipOfControl = new WeakMap<HTMLElement, Tip | null>();
    /** The one floating layer of the view (`placement.ts`): the bubble and the field bars take it, a row menu hides it. */
    private readonly slot: LayerSlot;
    /** The selection the bubble is about (`selectionKey`), while it is wanted; its rest's timer. */
    private bubbleKey: string | null = null;
    private bubbleTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly view: EditorView, private readonly host: ToolbarHost) {
        this.mount = view.dom.parentElement as HTMLElement;
        this.tips = Tooltips.for(this.mount);
        this.slot = LayerSlot.for(view, this.mount);
        this.layer = div('mep-toolbar-layer');
        this.card = div(`${PREVIEW_CARD_CLASS}`);
        this.card.hidden = true;
        this.card.setAttribute('role', 'tooltip');
        this.layer.append(this.card);
        this.row = this.buildRow();
        this.bubble = this.buildBubble();
        this.mount.insertBefore(this.row, view.dom);
        this.mount.append(this.bubble, this.layer);

        // The editor keeps the focus and the selection whatever is pressed here.
        for (const surface of [this.row, this.bubble, this.layer]) {
            surface.addEventListener('mousedown', e => e.preventDefault());
        }
        this.listen(view.dom, 'focusin', () => this.syncBubble());
        // Esc in the bubble hides it until the selection changes, the focus back in the text.
        this.listen(this.bubble, 'keydown', e => {
            if ((e as KeyboardEvent).key === 'Escape' && this.bubbleKey !== null) {
                e.preventDefault();
                this.slot.dismiss(this.bubbleKey);
                this.view.focus();
            }
        });
        this.listen(view.dom, 'focusout', e => this.focusLeft(e as FocusEvent));
        this.listen(this.bubble, 'focusout', e => this.focusLeft(e as FocusEvent));
        // A source box or a property's field taking the focus, or giving it
        // back, changes no state: the row is read again once the focus has
        // moved (`focusPlace.ts`) — once per move: a move fires a focusout and a focusin.
        const later = () => {
            if (this.focusTimer !== undefined) {
                return;
            }
            this.focusTimer = setTimeout(() => {
                this.focusTimer = undefined;
                if (!this.destroyed) {
                    this.update(this.view);
                }
            }, 0);
        };
        this.listen(document, 'focusin', later);
        this.listen(document, 'focusout', later);
        this.listen(document, 'mousedown', e => {
            const target = e.target as Node;
            if (!this.row.contains(target) && !this.layer.contains(target)) {
                this.closeAll();
            }
        }, true);
        // Fixed menus would stay where the page scrolled away from; a menu's own
        // scrolling (a long list of admonitions) is not that.
        this.listen(window, 'scroll', e => {
            // The hover is not: it follows its control (`tooltip.ts`).
            if (!this.layer.contains(e.target as Node)) {
                this.closeAll(true);
            }
        }, true);
        this.listen(window, 'resize', () => this.closeAll());
        // The main button held: a selection it draws shows its bubble at the
        // release (`bubbleReleased`). Only the main button — a right press
        // opens a menu that may take its release.
        this.listen(document, 'pointerdown', e => {
            if ((e as PointerEvent).button === 0) {
                this.pointerHeld = true;
            }
        }, true);
        const released = () => {
            this.pointerHeld = false;
            setTimeout(() => {
                // After the release's own selection change: a selection the pointer drew shows its bubble now.
                if (!this.destroyed) {
                    this.bubbleReleased();
                }
            }, 0);
        };
        this.listen(document, 'pointerup', released, true);
        this.listen(document, 'pointercancel', released, true);
        // A release that never reaches the page — the window left while the
        // button was down (Alt-Tab), a menu took it — would hold the bubble back
        // for good: a blur, or a move with no button down, says the press is over.
        const lost = () => {
            if (this.pointerHeld) {
                this.pointerHeld = false;
                this.bubbleReleased();
            }
        };
        this.listen(window, 'blur', lost);
        this.listen(document, 'pointermove', e => {
            if ((e as PointerEvent).buttons === 0) {
                lost();
            }
        }, true);
        // What fits in the row changes with its width and with the count beside
        // Export: laid out again when either changes (`layoutRow`), and when a
        // font has loaded, which changes every control's width.
        if (typeof ResizeObserver !== 'undefined') {
            this.rowSize = new ResizeObserver(() => this.layoutRow());
            this.rowSize.observe(this.row);
            this.rowSize.observe(this.row.querySelector('.mep-row-status') as Element);
        }
        if (typeof document.fonts !== 'undefined') {
            this.listen(document.fonts, 'loadingdone', () => {
                this.layoutKey = '';
                this.layoutRow();
            });
        }
        this.update(view);
    }

    update(view: EditorView): void {
        const state = view.state;
        const states = new Map<ToolbarAction, ActionState>();
        const includes = this.host.includesOffered();
        // While a source box or the properties panel has the focus, the
        // selection is hidden behind it: nothing here may act on it, and the
        // row says why at its end. What acts on the whole document is not
        // refused (`RowScope`).
        const place = focusPlace(view);
        const lock = rowLock(place, 'selection').refusal;
        const stateOf = (action: ToolbarAction) => {
            let s = states.get(action);
            if (!s) {
                s = lock !== null ? { enabled: false, active: false, reason: lock } : evaluate(action, state, includes);
                states.set(action, s);
            }
            return s;
        };
        const mac = macKeys();
        for (const tool of this.tools) {
            const s = stateOf(tool.action);
            setState(tool.el, s.enabled, s.active);
            const note = s.enabled ? null : s.reason;
            if (tool.el.classList.contains('mep-menu-item')) {
                // A menu entry shows its word and syntax, and its card the construct and the refusal: no hover.
                // A refused one says why to a screen reader.
                describeAs(tool.el, note);
                // A mark's entry in "…" is checked as its button is pressed.
                if (tool.el.getAttribute('role') === 'menuitemcheckbox') {
                    tool.el.setAttribute('aria-checked', String(s.active));
                }
                // A named entry says one name: the selection's, or — the row locked — its resting one.
                if (tool.action.named) {
                    relabel(tool.el, s.label ?? tool.action.label);
                    resyntax(tool.el, s.syntax ?? tool.action.column ?? tool.action.syntax.split('\n')[0]);
                }
                continue;
            }
            this.tipOfControl.set(tool.el, s.tip ? { ...s.tip, note } : tipOf(tool.action, { label: s.label, reason: note, mac }));
            this.tips.refresh(tool.el);
            if (s.ariaLabel !== undefined) {
                tool.el.setAttribute('aria-label', s.ariaLabel);
            }
        }
        for (const menu of this.menus) {
            if (menu.opener) {
                const enabled = menu.tools.some(t => stateOf(t.action).enabled);
                setState(menu.opener, enabled, false);
            }
            if (menu === this.more) {
                continue;
            }
            if (menu.face && menu.scope === 'document') {
                this.updateDocumentFace(menu, place);
            } else if (menu.face) {
                this.updateFace(menu, stateOf, lock);
            }
        }
        // After the faces: a face relabelled ("Paragraph", "Heading 2") changes what fits in the row.
        this.lockRole = place.kind === 'control' ? place.role : null;
        this.layoutRow();
        this.updateMore(lock);
        this.syncBubble();
    }

    /**
     * The row never scrolls and never moves the page (Daniel, 2026-10-19).
     * Where it is too narrow, its controls leave it for "…" in
     * `ROW_OVERFLOW`'s order — the three menus, then the marks from the right
     * — until the rest fits; Block type, the count and Export never leave.
     * While a control has the focus (`lockRole`), its reason stands in the row
     * in one of the forms `lockForms` gives, never under it:
     *
     * - beside the tools, whole, where it fits there;
     * - else, for a source box or a property's field, in the refused tools'
     *   place (`mep-row-lock-inrow`: they give way, nothing moves into "…"),
     *   whole, or — cut even there — its short form, which keeps its keys;
     * - else, for a button, its short form beside the tools where that fits,
     *   else no note: the tools only dim, the reason their tooltips and the
     *   row's description.
     *
     * Measured, not set by a width, so it holds for any font and label; and
     * measured again only when what it was measured for changed
     * (`rowLayoutKey`).
     */
    private layoutRow(): void {
        if (this.destroyed) {
            return;
        }
        const key = this.rowLayoutKey();
        if (key === this.layoutKey) {
            return;
        }
        const before = this.moved.join(',');
        const role = this.lockRole;
        const forms = role === null ? null : lockForms(role);
        const note = this.lockNote;
        const text = note.firstElementChild as HTMLElement;
        this.row.classList.remove(LOCK_INROW_CLASS);
        note.hidden = true;
        describeAs(this.row, forms?.full ?? null);
        if (forms === null) {
            note.classList.remove(LOCK_FLASH_CLASS);
            clearTimeout(this.flashTimer);
        }
        // A running export names its format: short while the tools are measured, so the label moves none of them.
        const running = this.host.exporting();
        this.exportLabel.textContent = running === null ? EXPORT_LABEL : exportBusyLabel(running, 'short');
        for (const control of ROW_OVERFLOW) {
            this.showInRow(control);
        }
        this.moreGroup.hidden = true;
        let moved: RowControl[] = [];
        if (overflows(this.row)) {
            // "…" counts from the first measurement that moves anything.
            this.moreGroup.hidden = false;
            moved = moveUntilFits(ROW_OVERFLOW, () => !overflows(this.row), c => this.showInRow(c), c => this.moveToMore(c));
            if (moved.length === 0) {
                this.moreGroup.hidden = true;
            }
        }
        if (forms !== null) {
            const whole = () => !overflows(note) && !overflows(this.row);
            note.hidden = false;
            text.textContent = forms.full;
            if (!whole()) {
                if (role === 'button') {
                    text.textContent = forms.short;
                    note.hidden = !whole();
                } else {
                    // The refused tools give way: nothing of them is in the row, nor in "…".
                    for (const control of ROW_OVERFLOW) {
                        this.showInRow(control);
                    }
                    moved = [];
                    this.moreGroup.hidden = true;
                    this.row.classList.add(LOCK_INROW_CLASS);
                    if (overflows(note)) {
                        text.textContent = forms.short;
                    }
                }
            }
        }
        // Its hover: the whole reason, where the short form shows.
        this.tips.refresh(note);
        // The whole busy label only where the row has the room without moving a tool or cutting the reason.
        if (running !== null) {
            this.exportLabel.textContent = exportBusyLabel(running, 'full');
            if (overflows(this.row) || (!note.hidden && overflows(note))) {
                this.exportLabel.textContent = exportBusyLabel(running, 'short');
            }
        }
        this.moved = moved;
        const { marks, menus } = moreOrder(moved);
        this.moreDivider.hidden = marks.length === 0 || menus.length === 0;
        this.more.children = menus.map(id => this.rowMenus.get(id) as Menu);
        this.layoutKey = this.rowLayoutKey();
        if (moved.join(',') !== before && this.menus.some(m => !m.panel.hidden)) {
            // A menu open over a row that changed stands where nothing opens it now.
            this.closeAll();
        }
    }

    /** What the row's layout depends on, besides the controls themselves: its width, the count, the block type's label, the lock, the running export. */
    private rowLayoutKey(): string {
        const said = this.row.querySelector<HTMLElement>('.mep-row-said');
        const blockType = this.rowMenus.get('block-type')?.face?.textContent ?? '';
        return [this.row.clientWidth, said?.offsetWidth ?? 0, blockType, this.lockRole ?? '', this.host.exporting() ?? ''].join('|');
    }

    /** `control` back in the row, its entry in "…" hidden; a menu is top-level again. */
    private showInRow(control: RowControl): void {
        const el = this.rowControls.get(control) as HTMLElement;
        el.hidden = false;
        (el.parentElement as HTMLElement).hidden = false;
        (this.overflowEntries.get(control) as HTMLElement).hidden = true;
        const menu = this.rowMenus.get(control as ToolbarMenu);
        if (menu) {
            menu.parent = undefined;
        }
    }

    /** `control` out of the row and into "…"; a group whose controls all left goes with its divider. */
    private moveToMore(control: RowControl): void {
        const el = this.rowControls.get(control) as HTMLElement;
        el.hidden = true;
        const group = el.parentElement as HTMLElement;
        group.hidden = Array.from(group.children).every(c => (c as HTMLElement).hidden);
        (this.overflowEntries.get(control) as HTMLElement).hidden = false;
        const menu = this.rowMenus.get(control as ToolbarMenu);
        if (menu) {
            menu.parent = this.more;
        }
    }

    /**
     * "…"'s face: refused under the lock as every selection tool is; a dot
     * when a mark in it is on; its name what it holds, in its menu's order —
     * marks, then menus — the ones on said so.
     */
    private updateMore(lock: string | null): void {
        const { marks, menus } = moreOrder(this.moved);
        const on = marks.filter(id => this.rowControls.get(id)?.classList.contains('mep-active'));
        const name = (id: RowControl) => (this.rowMenus.has(id as ToolbarMenu) ? MENU_LABELS[id as ToolbarMenu] : TOOLBAR_ACTIONS.find(a => a.id === id)?.label ?? id);
        setState(this.moreFace, lock === null, false);
        this.moreFace.classList.toggle('mep-has-on', on.length > 0);
        this.moreFace.setAttribute('aria-label', moreName('row', [...marks, ...menus].map(name), on.map(name)));
        this.tipOfControl.set(this.moreFace, plainTip('More', lock));
        this.tips.refresh(this.moreFace);
        if (lock !== null && !this.more.panel.hidden) {
            this.closeAll();
        }
    }

    /** A refused tool was pressed while the row is locked: its reason is pointed at for a moment, not a silent nothing. */
    private flashLock(): void {
        if (this.lockNote.hidden) {
            return;
        }
        this.lockNote.classList.remove(LOCK_FLASH_CLASS);
        // Read the layout so the animation starts again on a second press.
        void this.lockNote.offsetWidth;
        this.lockNote.classList.add(LOCK_FLASH_CLASS);
        clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => this.lockNote.classList.remove(LOCK_FLASH_CLASS), LOCK_FLASH_MS);
    }

    destroy(): void {
        this.destroyed = true;
        this.rowSize?.disconnect();
        clearTimeout(this.cardTimer);
        clearTimeout(this.flashTimer);
        clearTimeout(this.focusTimer);
        clearTimeout(this.bubbleTimer);
        this.closeFieldBar();
        this.slot.destroy();
        this.tips.release();
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.row.remove();
        this.bubble.remove();
        this.layer.remove();
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    // -- the row and the bubble ------------------------------------------------

    private buildRow(): HTMLElement {
        const row = div('mep-toolbar');
        row.setAttribute('role', 'toolbar');
        row.setAttribute('aria-label', 'Formatting');
        for (const group of ROW_LAYOUT) {
            const box = div('mep-row-group');
            for (const item of group) {
                if (item === 'marks') {
                    for (const action of TOOLBAR_ACTIONS.filter(inRow)) {
                        const button = this.markButton(action);
                        this.rowControls.set(action.id, button);
                        box.append(button);
                    }
                } else {
                    const face = this.menuFace(item);
                    this.rowControls.set(item, face);
                    box.append(face);
                }
            }
            row.append(box);
        }
        row.append(this.moreGroup = this.buildMore());
        // The lock's reason (`layoutRow`), while the row is refused: in the
        // row, beside the tools or in their place, never over them. Its hover
        // is the whole reason where it shows the short form.
        this.lockNote = span('mep-row-lock');
        this.lockNote.hidden = true;
        this.lockNote.append(span('mep-row-lock-text'));
        this.tips.attach(this.lockNote, () => {
            const full = this.lockRole === null ? null : lockForms(this.lockRole).full;
            return full === null || this.lockNote.textContent === full ? null : plainTip(full);
        });
        // The row's right end: what is about the document as a whole, not the
        // text at the selection — what the page says of it (the diagnostics
        // count, `diagnostics.ts`, in its slot), then Export.
        const status = div('mep-row-status');
        const exportGroup = div('mep-row-export');
        exportGroup.append(this.exportFace());
        status.append(div('mep-row-said'), exportGroup);
        row.append(this.lockNote, status);
        return row;
    }

    /**
     * **Export ▾**: a menu face as the others are, the `export` codicon
     * before its label; its menu lists the formats as plain text, then the
     * export's settings. Each entry is the host's (`ToolbarHost.exportDocument`).
     */
    private exportFace(): HTMLElement {
        const menu = this.newMenu('export', EXPORT_LABEL, 'document');
        menu.alignEnd = true;
        for (const entry of EXPORT_ENTRIES) {
            if (entry.separated) {
                menu.panel.append(separator());
            }
            const item = this.entry(menu);
            item.dataset.export = entry.id;
            item.append(span('mep-entry-label', entry.label));
            if (entry.detail) {
                item.append(span('mep-entry-detail', entry.detail));
            }
            if (entry.exports) {
                this.formatItems.push(item);
            }
            menu.commands.set(item, () => entry.run(this.host));
            item.addEventListener('click', e => {
                e.preventDefault();
                this.runCommand(menu, item);
            });
            item.addEventListener('mouseenter', () => followPointer(menu.panel, item));
            menu.panel.append(item);
        }
        const face = this.faceFor(menu, EXPORT_LABEL);
        this.exportLabel = face.querySelector('.mep-face-label') as HTMLElement;
        const icon = span('mep-face-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.append(...lensLabelNodes('$(export)'));
        face.prepend(icon);
        face.dataset.scope = menu.scope;
        return face;
    }

    private buildBubble(): HTMLElement {
        const bubble = div('mep-bubble mep-layer');
        bubble.setAttribute('role', 'toolbar');
        bubble.setAttribute('aria-label', 'Format selection');
        bubble.hidden = true;
        for (const action of TOOLBAR_ACTIONS.filter(inBubble)) {
            bubble.append(this.markButton(action));
        }
        return bubble;
    }

    /** A mark's button: its glyph is the element the mark renders as, held to the button's size. */
    private markButton(action: ToolbarAction): HTMLElement {
        const button = div('mep-tool mep-mark-tool');
        button.dataset.action = action.id;
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        button.append(sampleHolder(action.sample));
        // Named for a screen reader by its word and its delimiter spoken ("Italic, asterisk"), its key as ARIA spells it.
        button.setAttribute('aria-label', ariaLabelOf(action));
        if (action.key !== undefined) {
            button.setAttribute('aria-keyshortcuts', ariaKeyshortcuts(action.key, macKeys()));
        }
        this.tips.attach(button, () => this.tipOfControl.get(button) ?? null);
        const tool = { action, el: button };
        button.addEventListener('click', e => {
            e.preventDefault();
            this.activate(tool);
        });
        button.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.activate(tool);
            }
        });
        this.tools.push(tool);
        return button;
    }

    private menuFace(id: ToolbarMenu): HTMLElement {
        const menu = this.buildMenu(id, TOOLBAR_ACTIONS.filter(a => menuOf(a) === id));
        this.rowMenus.set(id, menu);
        return this.faceFor(menu, MENU_LABELS[id]);
    }

    /**
     * "…" (`layoutRow`), in a group of its own after the row's last group,
     * hidden while nothing moved. Its menu holds an entry for every control
     * that may leave the row, each hidden while that control is in the row:
     * the marks in row order — glyph, word, syntax and key, checked when on —
     * a divider, then the menus in row order, each opening its own menu as a
     * submenu. Hung from the face's right edge, as Export's is.
     */
    private buildMore(): HTMLElement {
        const more = this.newMenu('more', 'More', 'selection');
        more.alignEnd = true;
        this.more = more;
        for (const action of TOOLBAR_ACTIONS.filter(inRow)) {
            const item = this.menuEntry(more, action);
            item.setAttribute('role', 'menuitemcheckbox');
            item.setAttribute('aria-checked', 'false');
            if (action.key !== undefined) {
                item.append(span('mep-entry-key', keyLabel(action.key, macKeys())));
            }
            item.hidden = true;
            this.overflowEntries.set(action.id, item);
            more.panel.append(item);
        }
        this.moreDivider = separator();
        this.moreDivider.hidden = true;
        more.panel.append(this.moreDivider);
        // In row order, whatever order they leave in.
        for (const id of moreOrder(ROW_OVERFLOW).menus) {
            const item = this.hostEntry(more, this.rowMenus.get(id) as Menu);
            item.hidden = true;
            this.overflowEntries.set(id, item);
            more.panel.append(item);
        }
        const face = moreControl('row');
        // Shown and hidden with its group.
        face.hidden = false;
        this.wireFace(more, face);
        this.moreFace = face;
        const group = div('mep-row-group mep-row-more');
        group.hidden = true;
        group.append(face);
        return group;
    }

    /** A row menu's entry in "…": its name and a chevron; it opens the menu itself, as a submenu, while the face is out of the row. */
    private hostEntry(more: Menu, menu: Menu): HTMLElement {
        const item = this.entry(more);
        item.classList.add('mep-submenu-item');
        item.dataset.submenu = menu.id;
        item.setAttribute('aria-haspopup', 'menu');
        item.setAttribute('aria-expanded', 'false');
        const glyph = span('mep-entry-glyph');
        glyph.setAttribute('aria-hidden', 'true');
        item.append(glyph, span('mep-entry-label', MENU_LABELS[menu.id as ToolbarMenu]), chevronNode('right'));
        menu.opener = item;
        item.addEventListener('mouseenter', () => {
            this.hideCard();
            followPointer(more.panel, item);
            this.openMenu(menu, false);
        });
        item.addEventListener('click', e => {
            e.preventDefault();
            this.openMenu(menu, false);
        });
        return item;
    }

    /** A top-level menu's face in the row: `label` and a chevron; it opens the menu on a press, Enter, Space or the down arrow. */
    private faceFor(menu: Menu, label: string): HTMLElement {
        const face = div('mep-tool mep-menu-face');
        face.append(span('mep-face-label', label), chevronNode());
        this.wireFace(menu, face);
        return face;
    }

    /** `face` opens `menu`: on a press, Enter, Space or the down arrow; named and described by its hover. */
    private wireFace(menu: Menu, face: HTMLElement): void {
        face.dataset.menu = menu.id;
        face.setAttribute('role', 'button');
        face.setAttribute('aria-haspopup', 'menu');
        face.setAttribute('aria-expanded', 'false');
        face.tabIndex = 0;
        this.tips.attach(face, () => this.tipOfControl.get(face) ?? null);
        menu.face = face;
        face.addEventListener('click', e => {
            e.preventDefault();
            if (menu.panel.hidden) {
                this.openMenu(menu, false);
            } else {
                this.closeAll();
            }
        });
        face.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.openMenu(menu, true);
            } else if (e.key === 'Escape' && !menu.panel.hidden) {
                e.preventDefault();
                this.closeAll();
            }
        });
    }

    /**
     * A block-type face names the type the selection is in, as text; a locked
     * one says why. Any other face is disabled when none of its entries applies.
     * `lock`: a node view's control has the focus, and why the row is refused (`controlLock`).
     */
    private updateFace(menu: Menu, stateOf: (a: ToolbarAction) => ActionState, lock: string | null): void {
        const face = menu.face as HTMLElement;
        const all = [...menu.tools, ...menu.children.flatMap(c => c.tools)];
        let label = MENU_LABELS[menu.id];
        let reason: string | null = null;
        let enabled: boolean;
        if (menu.id === 'block-type') {
            // Named also while locked: a requirement heading is still a heading.
            const current = currentBlock(this.view.state);
            const active = menu.tools.map(t => t.action).find(a => a.apply.kind === 'block' && isCurrent(current, a.apply.node, a.apply.level));
            face.dataset.shows = active?.id ?? '';
            label = active?.label ?? label;
            reason = lock ?? blockLockReason(this.view.state);
            enabled = reason === null;
        } else {
            enabled = all.some(t => stateOf(t.action).enabled);
            reason = enabled ? null : all.map(t => stateOf(t.action).reason).find(r => r !== null) ?? null;
        }
        (face.querySelector('.mep-face-label') as HTMLElement).textContent = label;
        setState(face, enabled, false);
        const title = menu.id === 'block-type' && label !== MENU_LABELS[menu.id] ? `${MENU_LABELS[menu.id]}: ${label}` : label;
        this.tipOfControl.set(face, plainTip(title, reason));
        this.tips.refresh(face);
        if (!enabled && !menu.panel.hidden) {
            this.closeAll();
        }
    }

    /**
     * Export's face, read from the lock model (`rowLock` for its scope, the
     * document): offered beside a locked row, its tooltip saying what the
     * focus changes (an open box applied first). While an export runs it says
     * which — a spinning codicon, `Exporting PDF…` or `PDF…` as the row has
     * the room (`layoutRow` sets the label), busy, the whole in its tooltip —
     * and in its menu the running format spins, the others are refused saying
     * what they wait for; the settings are not.
     */
    private updateDocumentFace(menu: Menu, place: FocusPlace): void {
        const face = menu.face as HTMLElement;
        const { refusal, note } = rowLock(place, menu.scope);
        const running = this.host.exporting();
        setState(face, refusal === null, false);
        const icon = face.querySelector('.mep-face-icon') as HTMLElement;
        if (icon.dataset.busy !== String(running !== null)) {
            icon.dataset.busy = String(running !== null);
            icon.replaceChildren(...(running === null ? lensLabelNodes('$(export)') : spinner()));
        }
        face.setAttribute('aria-busy', String(running !== null));
        this.tipOfControl.set(face, running === null ? plainTip(EXPORT_LABEL, refusal ?? note) : plainTip(exportBusyLabel(running, 'full'), refusal ?? exportBusyNote(running)));
        this.tips.refresh(face);
        // A menu entry has no hover; a refused one says why to a screen reader.
        for (const item of this.formatItems) {
            const mine = running !== null && item.dataset.export === running;
            setState(item, running === null, false);
            describeAs(item, running === null ? null : mine ? exportBusyLabel(running, 'full') : exportBusyNote(running));
            item.querySelector(':scope > .mep-entry-busy')?.remove();
            if (mine) {
                const busy = span('mep-entry-busy');
                busy.setAttribute('aria-hidden', 'true');
                busy.append(...spinner());
                item.prepend(busy);
            }
            const detail = item.querySelector<HTMLElement>(':scope > .mep-entry-detail');
            if (detail) {
                detail.textContent = mine ? EXPORT_RUNNING_DETAIL : EXPORT_ENTRIES.find(e => e.id === item.dataset.export)?.detail ?? '';
            }
        }
    }

    // -- menus -----------------------------------------------------------------

    /** An empty menu's panel in the layer, hidden, named `label`. */
    private newMenu(id: Menu['id'], label: string, scope: RowScope, parent?: Menu): Menu {
        const panel = div('mep-menu');
        panel.dataset.menu = id;
        panel.setAttribute('role', 'menu');
        panel.setAttribute('aria-label', label);
        panel.hidden = true;
        this.layer.append(panel);
        const menu: Menu = { id, panel, items: [], tools: [], commands: new Map(), scope, parent, children: [] };
        this.menus.push(menu);
        panel.addEventListener('keydown', e => this.menuKey(menu, e));
        return menu;
    }

    private buildMenu(id: ToolbarMenu | ToolbarSubmenu, actions: readonly ToolbarAction[], parent?: Menu): Menu {
        const menu = this.newMenu(id, MENU_LABELS[id], 'selection', parent);
        const panel = menu.panel;

        for (const action of actions) {
            const sub = parent ? null : submenuOf(action);
            if (sub !== null) {
                if (!menu.children.some(c => c.id === sub)) {
                    const child = this.buildMenu(sub, actions.filter(a => submenuOf(a) === sub), menu);
                    menu.children.push(child);
                    panel.append(this.submenuEntry(menu, child));
                }
                continue;
            }
            if (action.separated) {
                panel.append(separator());
            }
            // The aliases wait behind "More types…", drawn where their group starts.
            if (action.alias !== undefined && menu.more === undefined) {
                panel.append(this.moreEntry(menu, actions.filter(a => a.alias !== undefined).length));
            }
            const item = this.menuEntry(menu, action);
            if (action.alias !== undefined) {
                item.hidden = true;
                menu.more?.hidden.push(item);
            }
            panel.append(item);
        }
        return menu;
    }

    /**
     * "More types… (16)": pressed — a click, `Enter` or `Space` — the entries
     * behind it show in place, the focus goes to the first of them and it is
     * scrolled into view, and it reads "Fewer types"; pressed again, they go.
     * The menu closes with them hidden (`closeMenu`).
     */
    private moreEntry(menu: Menu, count: number): HTMLElement {
        const item = this.entry(menu);
        item.classList.add('mep-more-item');
        item.dataset.more = 'collapsed';
        item.setAttribute('aria-expanded', 'false');
        const glyph = span('mep-entry-glyph');
        glyph.setAttribute('aria-hidden', 'true');
        item.append(glyph, span('mep-entry-label', MORE_TYPES(count)), chevronNode('down'));
        menu.more = { item, hidden: [], count };
        item.addEventListener('click', e => {
            e.preventDefault();
            this.toggleMore(menu);
        });
        item.addEventListener('mouseenter', () => {
            this.hideCard();
            followPointer(menu.panel, item);
        });
        return item;
    }

    private toggleMore(menu: Menu, expand = menu.more?.item.dataset.more !== 'expanded'): void {
        const more = menu.more;
        if (!more) {
            return;
        }
        more.item.dataset.more = expand ? 'expanded' : 'collapsed';
        more.item.setAttribute('aria-expanded', String(expand));
        (more.item.querySelector('.mep-entry-label') as HTMLElement).textContent = expand ? FEWER_TYPES : MORE_TYPES(more.count);
        more.item.querySelector('.mep-menu-caret')?.replaceWith(chevronNode(expand ? 'up' : 'down'));
        for (const item of more.hidden) {
            item.hidden = !expand;
        }
        if (menu.panel.hidden) {
            return;
        }
        this.place(menu);
        if (expand) {
            const first = more.hidden.find(reachable);
            first?.focus({ preventScroll: true });
            first?.scrollIntoView({ block: 'nearest' });
        }
    }

    private entry(menu: Menu): HTMLElement {
        const item = div('mep-menu-item');
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
        menu.items.push(item);
        return item;
    }

    /**
     * An entry: the check (`::before`), the glyph — the element it makes at its
     * natural size, clipped to its swatch, never zoomed (`ToolbarAction.glyph`)
     * — the word, which never truncates, and the syntax, which truncates first.
     * A Block type entry draws its word as the element instead (`drawnLabel`).
     */
    private menuEntry(menu: Menu, action: ToolbarAction): HTMLElement {
        const item = this.entry(menu);
        item.dataset.action = action.id;
        const column = span('mep-entry-syntax', action.column ?? action.syntax.split('\n')[0]);
        if (action.drawnLabel) {
            const sample = span('mep-entry-sample');
            sample.append(sampleHolder(action.sample));
            item.append(sample, column);
        } else {
            const label = span('mep-entry-label', action.label);
            const alias = aliasNote(action);
            if (alias !== null) {
                // A space between, so the entry reads "Abstract as Summary", not "Abstractas Summary"; the margin draws the rest of the gap.
                label.append(' ', span('mep-entry-alias', alias));
            }
            item.append(glyphOf(action.glyph === undefined ? action.sample : action.glyph), label, column);
        }
        const tool = { action, el: item };
        menu.tools.push(tool);
        this.tools.push(tool);
        item.addEventListener('click', e => {
            e.preventDefault();
            this.activate(tool);
        });
        item.addEventListener('mouseenter', () => {
            this.closeSubmenus(menu);
            followPointer(menu.panel, item);
            this.scheduleCard(action, item, menu);
        });
        item.addEventListener('mouseleave', () => this.hideCard());
        item.addEventListener('focus', () => this.scheduleCard(action, item, menu));
        item.addEventListener('blur', () => this.hideCard());
        return item;
    }

    /** The entry that opens a submenu: its name and syntax, and a chevron. */
    private submenuEntry(menu: Menu, child: Menu): HTMLElement {
        const item = this.entry(menu);
        item.classList.add('mep-submenu-item');
        item.dataset.submenu = child.id;
        item.setAttribute('aria-haspopup', 'menu');
        item.setAttribute('aria-expanded', 'false');
        item.append(glyphOf(SUBMENU_GLYPH[child.id as ToolbarSubmenu]), span('mep-entry-label', MENU_LABELS[child.id]),
            span('mep-entry-syntax', SUBMENU_SYNTAX[child.id as ToolbarSubmenu]), chevronNode('right'));
        child.opener = item;
        item.addEventListener('mouseenter', () => {
            this.hideCard();
            followPointer(menu.panel, item);
            this.openMenu(child, false);
        });
        item.addEventListener('click', e => {
            e.preventDefault();
            this.openMenu(child, false);
        });
        return item;
    }

    private menuKey(menu: Menu, e: KeyboardEvent): void {
        const focused = document.activeElement as HTMLElement | null;
        const index = focused ? menu.items.indexOf(focused) : -1;
        if (index < 0) {
            return;
        }
        const child = menu.children.find(c => c.opener === focused);
        const move = (step: number) => {
            const count = menu.items.length;
            for (let i = 1; i <= count; i++) {
                const next = menu.items[(((index + step * i) % count) + count) % count];
                if (reachable(next)) {
                    next.focus({ preventScroll: true });
                    return;
                }
            }
        };
        const stop = () => {
            e.preventDefault();
            e.stopPropagation();
        };
        switch (e.key) {
            case 'ArrowDown':
                stop();
                move(1);
                break;
            case 'ArrowUp':
                stop();
                move(-1);
                break;
            case 'Enter':
            case ' ':
                stop();
                if (child) {
                    this.openMenu(child, true);
                } else if (focused === menu.more?.item) {
                    // Not a command: the menu stays open, its hidden entries shown in place.
                    this.toggleMore(menu);
                } else if (focused && menu.commands.has(focused)) {
                    this.runCommand(menu, focused);
                } else {
                    const tool = menu.tools.find(t => t.el === focused);
                    if (tool) {
                        this.activate(tool);
                    }
                }
                break;
            case 'ArrowRight':
                if (child) {
                    stop();
                    this.openMenu(child, true);
                }
                break;
            case 'ArrowLeft':
            case 'Escape':
                if (e.key === 'ArrowLeft' && !menu.parent) {
                    break;
                }
                stop();
                this.closeMenu(menu);
                triggerOf(menu)?.focus();
                break;
            case 'Tab':
                this.closeAll();
                break;
        }
    }

    private openMenu(menu: Menu, focusFirst: boolean): void {
        if (!menu.parent && menu.face && isDisabled(menu.face)) {
            this.flashLock();
            return;
        }
        if (menu.parent) {
            this.closeSubmenus(menu.parent);
            // Last in the layer, so it stands over its parent where it is placed over it (`place`).
            this.layer.append(menu.panel);
        } else {
            this.closeAll();
        }
        menu.panel.hidden = false;
        triggerOf(menu)?.setAttribute('aria-expanded', 'true');
        if (!menu.parent) {
            // A row menu open: the floating layer hides until it closes (`LayerSlot.suppress`).
            this.slot.suppress(true);
            menu.suppressing = true;
        }
        this.fitSamples(menu);
        this.place(menu);
        this.tips.hide();
        if (focusFirst) {
            menu.items.find(reachable)?.focus({ preventScroll: true });
        }
    }

    private closeMenu(menu: Menu): void {
        for (const child of menu.children) {
            this.closeMenu(child);
        }
        if (!menu.panel.hidden) {
            menu.panel.hidden = true;
            // Both: a menu moved into "…" or back while open has had either.
            menu.face?.setAttribute('aria-expanded', 'false');
            menu.opener?.setAttribute('aria-expanded', 'false');
            // It opens again at rest: the canonical entries, the rest behind "More types…".
            this.toggleMore(menu, false);
            menu.panel.scrollTop = 0;
            if (menu.suppressing) {
                // Back without a new rest, where it is still about what the selection is.
                menu.suppressing = undefined;
                this.slot.suppress(false);
            }
        }
        if (this.card.dataset.menu === menu.id) {
            this.hideCard();
        }
    }

    private closeSubmenus(menu: Menu): void {
        for (const child of menu.children) {
            this.closeMenu(child);
        }
    }

    /** Every menu and the card closed, and the hover hidden — but on a scroll (`keepTip`), which the hover follows. */
    private closeAll(keepTip = false): void {
        for (const menu of this.menus) {
            if (!menu.parent) {
                this.closeMenu(menu);
            }
        }
        this.hideCard();
        if (!keepTip) {
            this.tips.hide();
        }
    }

    /**
     * Under its face, or beside its opener's menu (`placement.ts`,
     * `placeMenu`); where neither side of the parent has room (a narrow
     * window, a menu moved into "…"), under its entry, over the parent — the
     * entry it was opened from stays in sight.
     */
    private place(menu: Menu): void {
        if (!menu.parent && menu.face) {
            placeMenu(menu.panel, menu.face, undefined, menu.alignEnd ? 'end' : 'start');
        } else if (placeMenu(menu.panel, menu.opener as HTMLElement, (menu.parent as Menu).panel).side === 'none') {
            placeMenu(menu.panel, menu.opener as HTMLElement);
        }
    }

    /**
     * Every entry is one height. A Block type sample — the entry's label drawn
     * as the element (`drawnLabel`) — is scaled down with `zoom` until it fits
     * the entry, but never below `SAMPLE_ZOOM_FLOOR`: what still stands out is
     * clipped (`editor.css`). An inline one keeps its natural size and is
     * clipped to the entry, as every glyph is (`.mep-entry-glyph`, never
     * zoomed). Measured when the menu opens, so it holds for whatever the
     * stylesheets make of the sample.
     */
    private fitSamples(menu: Menu): void {
        for (const holder of Array.from(menu.panel.querySelectorAll<HTMLElement>('.mep-entry-sample'))) {
            const sample = holder.querySelector<HTMLElement>(`.${SAMPLE_CLASS} > *`);
            if (!sample) {
                continue;
            }
            sample.style.removeProperty('zoom');
            if (getComputedStyle(sample).display.startsWith('inline')) {
                continue;
            }
            const box = holder.getBoundingClientRect();
            const r = sample.getBoundingClientRect();
            const zoom = Math.min(1, r.height > 0 ? box.height / r.height : 1, r.width > 0 ? box.width / r.width : 1);
            if (zoom >= 1) {
                continue;
            }
            // Rounded down, never up into a box a hair too big; never below the floor.
            sample.style.setProperty('zoom', String(Math.max(SAMPLE_ZOOM_FLOOR, Math.floor(zoom * 1000) / 1000)));
        }
    }

    // -- the preview card ------------------------------------------------------

    private scheduleCard(action: ToolbarAction, item: HTMLElement, menu: Menu): void {
        this.hideCard();
        if (!action.preview) {
            return;
        }
        this.cardTimer = setTimeout(() => this.showCard(action, item, menu), PREVIEW_DELAY_MS);
    }

    /**
     * The entry's construct at its natural size, from the cascade, with its
     * syntax beneath. The card is a formatting context of its own and clips what
     * it holds (`editor.css`), and `markdown-extended.css` keeps its margin
     * layout out of it, so a note or a sidebar renders stacked inside the card
     * at any window width instead of floating out of it.
     */
    private showCard(action: ToolbarAction, item: HTMLElement, menu: Menu): void {
        const now = evaluate(action, this.view.state, this.host.includesOffered());
        const preview = now.preview ?? action.preview;
        if (!preview || menu.panel.hidden) {
            return;
        }
        const body = div('mep-preview-body');
        for (const node of preview.nodes) {
            body.append(renderSample(node));
        }
        const syntax = div('mep-preview-syntax');
        syntax.textContent = elideDataUris(preview.markdown);
        this.card.replaceChildren(body, syntax);
        // An entry has no tooltip: that it is written as source, the card says.
        if (isSourceAction(action)) {
            const source = div('mep-preview-source');
            source.textContent = SOURCE_NOTE;
            this.card.append(source);
        }
        // A disabled entry says why where the eye already is, not only in its tooltip.
        if (!now.enabled && now.reason) {
            const why = div('mep-preview-refusal');
            why.textContent = now.reason;
            this.card.append(why);
        }
        this.card.dataset.action = action.id;
        this.card.dataset.menu = menu.id;
        this.card.hidden = false;
        // Beside the menu, else below or above it — never over the menu or the entry; with no room, no card.
        if (!placeCard(this.card, menu.panel, item)) {
            this.hideCard();
        }
    }

    private hideCard(): void {
        clearTimeout(this.cardTimer);
        this.cardTimer = undefined;
        this.card.hidden = true;
        delete this.card.dataset.action;
        delete this.card.dataset.menu;
    }

    // -- acting ----------------------------------------------------------------

    private activate(tool: Tool): void {
        if (isDisabled(tool.el)) {
            this.flashLock();
            return;
        }
        this.closeAll();
        this.run(tool.action);
    }

    /**
     * An entry of a menu of commands (Export's): the menu closes, the focus it
     * held — opened from the keyboard — goes back to its face, and the host runs it.
     */
    private runCommand(menu: Menu, item: HTMLElement): void {
        const command = menu.commands.get(item);
        if (!command || isDisabled(item)) {
            return;
        }
        const held = menu.panel.contains(document.activeElement);
        this.closeAll();
        if (held) {
            menu.face?.focus({ preventScroll: true });
        }
        command();
    }

    private run(action: ToolbarAction): void {
        const view = this.view;
        const apply = action.apply;
        switch (apply.kind) {
            case 'mark':
                toggleMarkup(editorSchema.marks[apply.mark], apply.markup)(view.state, view.dispatch);
                view.focus();
                return;
            case 'wrap-node':
                toggleNote(apply.node)(view.state, view.dispatch);
                view.focus();
                return;
            case 'block':
                blockCommand(apply.node, apply.level)(view.state, view.dispatch);
                view.focus();
                return;
            case 'wrap-source': {
                const tr = wrapSourceTransaction(view.state, apply, this.host.sourceContext());
                if (!tr) {
                    return;
                }
                view.dispatch(tr);
                // The block is source now; the host parses it and sends it back
                // rendered as the preview renders it.
                this.host.flushReparse();
                if (apply.definition !== undefined && tr.selection instanceof NodeSelection) {
                    editRawSourceAt(view, tr.selection.to);
                } else {
                    view.focus();
                }
                return;
            }
            case 'insert-source': {
                const { tr, pos, src } = insertSourceTransaction(view.state, apply.template, this.host.sourceContext());
                view.dispatch(tr);
                this.host.requestRender(src);
                editRawSourceAt(view, pos);
                return;
            }
            case 'insert-wrapper':
                view.dispatch(insertWrapperTransaction(view.state, apply));
                view.focus();
                return;
            case 'insert-table':
                view.dispatch(insertTableTransaction(view.state, apply.columns, apply.rows));
                view.focus();
                return;
            case 'insert-include':
                // VS Code's QuickPick takes the choice; the line comes back as
                // `includeChosen` and is inserted then, at the selection as it is.
                this.host.pickInclude();
                return;
            case 'insert-properties': {
                const tr = insertPropertiesTransaction(view.state, this.host.sourceContext().eol);
                if (tr) {
                    view.dispatch(tr);
                    // The panel is drawn: open it at the name of the first property.
                    addPropertyAt(view.nodeDOM(0));
                }
                return;
            }
            case 'attr-span':
                this.askSpanLiteral();
                return;
            case 'block-attrs':
                this.askBlockAttributes();
                return;
            case 'inline-attrs':
                this.askInlineAttributes();
                return;
            case 'attrs-bubble':
                if (!view.state.selection.empty && currentReadsAttrs() && attributeHolderAt(view.state).inline !== null) {
                    this.askInlineAttributes();
                } else {
                    this.askSpanLiteral();
                }
                return;
            case 'insert-link':
                this.askLink();
                return;
            case 'insert-image':
                // VS Code's open dialog takes the choice; the file comes back as
                // `filesChosen` and goes in then, at the selection as it is.
                this.host.pickImage(files => this.insertPicked(files));
                return;
        }
    }

    // -- the span's field ------------------------------------------------------

    /**
     * **Span with class**: the inline field, in a bar of the object toolbar's
     * kind under the selection, asks for the `{…}` literal — `{.}` with the caret
     * after the dot, so the class is typed at once — and `Enter` makes the
     * selection `[text]{literal}`. The selection stays in the state while the
     * field has the focus; a re-sync meanwhile maps it, so the commit applies to
     * the text it was opened for.
     */
    private askSpanLiteral(): void {
        const view = this.view;
        if (spanLockReason(view.state) !== null) {
            return;
        }
        const step: FieldStep = {
            value: SPAN_FIELD_PREFILL.value,
            caret: SPAN_FIELD_PREFILL.caret,
            label: 'Attributes',
            keys: ATTRIBUTES_FIELD_KEYS,
            commit: value => {
                // Asked before the focus goes back: a refusal keeps the field open with what was typed.
                // The transaction is built after it is back, which may commit a source box. Both are
                // decided in one place (`applySpanRefusal`, `applySpanTransaction`): no refusal, a transaction.
                const refusal = applySpanRefusal(view.state, value);
                if (refusal !== null) {
                    return refusedStep(step, value, refusal);
                }
                view.focus();
                const tr = applySpanTransaction(view.state, value);
                if (tr === null) {
                    // What the focus moved (a source box's commit) changed the answer: the field stays, saying why.
                    return refusedStep(step, value, applySpanRefusal(view.state, value) ?? SPAN_REFUSED);
                }
                view.dispatch(tr);
            },
        };
        this.openFieldBar('span', 'Span attributes', 'span-attributes', step);
    }

    /**
     * **Attributes…**: the inline field, in a bar at the block the caret is in,
     * labelled with that block's name (`Paragraph · Attributes`) and prefilled
     * with its literal — or `{.}`, the caret after the dot — and `Enter` sets it
     * where markdown-it-attrs reads it for that block (`commitAttributes`).
     */
    private askBlockAttributes(): void {
        const target = attributesTargetAt(this.view.state);
        if ('refusal' in target) {
            showHint(this.view, target.refusal, 'refusal');
            return;
        }
        this.openFieldBar('block-attributes', target.name, 'block-attributes', attributesStep(this.view, target));
    }

    /**
     * **Attributes of Code…** (and of a key, a link, emphasis, an image …):
     * the inline field, in a bar at the element the caret is in, labelled with
     * its name (`Code · Attributes`), prefilled as the element's own bar
     * prefills it — the one step every route shares (`holderAttributesStep`).
     * The element's run stays drawn while the field is open.
     */
    private askInlineAttributes(): void {
        const at = currentReadsAttrs() ? attributeHolderAt(this.view.state).inline : null;
        if (at === null) {
            showHint(this.view, currentReadsAttrs() ? INLINE_ATTRS_LOCK : NO_ATTRS_REFUSAL, 'refusal');
            return;
        }
        this.openFieldBar(at.holder.holder, holderNames(at).label, 'inline-attributes', holderAttributesStep(this.view, at), { from: at.object.from, to: at.object.to });
    }

    // -- links and images ------------------------------------------------------

    /**
     * **Insert → Link…** and `Ctrl+K`. In a link, its address, prefilled — the
     * object toolbar's **Edit link…** does the same. Over selected text, the
     * address; at a caret, the text first and then the address (an empty text
     * is the address itself). The address field completes from the host: the
     * workspace's files relative to the document, `#` headings of this document
     * or of the file typed before the `#`. False where no link can be made.
     */
    askLink(): boolean {
        const view = this.view;
        const complete = (query: string) => this.host.linkChoices(query, false);
        const object = objectAtSelection(view.state);
        if (object?.kind === 'link') {
            this.openFieldBar('link', 'Link', 'link-address', {
                value: object.mark.attrs.href as string,
                label: 'Address',
                complete,
                commit: value => {
                    view.focus();
                    const current = currentObject(view.state, object);
                    const tr = current?.kind === 'link' ? changeLinkTransaction(view.state, current, value) : null;
                    if (tr) {
                        view.dispatch(tr);
                    }
                },
            }, { from: object.from, to: object.to });
            return true;
        }
        const reason = insertLockReason(view.state, LINK_LOCK);
        if (reason !== null) {
            showHint(view, reason, 'refusal');
            return false;
        }
        const address = (text: string): FieldStep => ({
            value: '',
            label: 'Address',
            complete,
            commit: href => {
                view.focus();
                if (href.trim() === '') {
                    return;
                }
                const tr = insertLinkTransaction(view.state, text, href);
                if (tr === null) {
                    showHint(view, 'The link cannot be made here: the note around it could not be written back with it.', 'refusal');
                    return;
                }
                view.dispatch(tr);
            },
        });
        this.openFieldBar('link', 'Link', 'link-address', view.state.selection.empty
            ? { value: '', label: 'Text', placeholder: 'Text — empty: the address', commit: text => address(text) }
            : address(''));
        return true;
    }

    /**
     * The files the host chose (**Insert → Image…**) put at the selection as
     * it is now; one image is then selected and its alt text asked for in the
     * field, the file's name prefilled — `Esc` keeps that name.
     */
    private insertPicked(files: readonly LinkedFile[]): void {
        const view = this.view;
        view.focus();
        if (files.length === 0) {
            return;
        }
        const tr = insertFilesTransaction(view.state, files);
        if (tr === null) {
            showHint(view, insertLockReason(view.state, IMAGE_LOCK) ?? 'The image cannot be inserted here.', 'refusal');
            return;
        }
        view.dispatch(tr);
        const sel = view.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type !== editorSchema.nodes.image) {
            return;
        }
        const at = sel.from;
        const node = sel.node;
        this.openFieldBar('image', 'Image', 'image-alt', {
            value: (node.attrs.alt as string | null) ?? '',
            label: 'Alt text',
            commit: alt => {
                view.focus();
                const now = view.state.doc.nodeAt(at);
                const tr2 = now && now.type === node.type && now.attrs.src === node.attrs.src
                    ? editImageTransaction(view.state, at, alt, now.attrs.src as string) : null;
                if (tr2) {
                    view.dispatch(tr2);
                }
            },
        });
    }

    /**
     * A bar of the object toolbar's kind under the selection, holding the
     * inline field for `step` — and, when its commit names another step, the
     * next field in its place. The selection stays in the state while the
     * field has the focus; a re-sync meanwhile maps it, so the commit applies
     * where the field was opened.
     */
    private openFieldBar(object: string, barLabel: string, verb: string, first: FieldStep, range?: { from: number; to: number }): void {
        this.closeFieldBar();
        const view = this.view;
        const bar = div('mep-object-toolbar mep-layer');
        bar.dataset.trigger = 'toolbar';
        bar.dataset.object = object;
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', barLabel);
        bar.addEventListener('mousedown', e => {
            if (!(e.target instanceof HTMLInputElement)) {
                e.preventDefault();
            }
        });
        const label = span('mep-object-label', barLabel);
        // What it edits: the element (`range`), the selection, or — none — the caret.
        const sel = view.state.selection;
        const from = range?.from ?? sel.from;
        const to = range?.to ?? sel.to;
        const key = `field@${from}-${to}`;
        const close = () => {
            if (this.fieldBar?.bar === bar) {
                this.fieldBar = null;
            }
            this.slot.release(key);
            bar.remove();
            clearPendingRange(view);
        };
        const open = (step: FieldStep) => {
            const field = new InlineField({
                value: step.value,
                caret: step.caret,
                label: step.label,
                placeholder: step.placeholder,
                complete: step.complete,
                onCommit: value => {
                    const next = step.commit(value);
                    if (next) {
                        open(next).focus();
                        return;
                    }
                    close();
                },
                onCancel: reason => {
                    close();
                    if (reason === 'escape') {
                        view.focus();
                    }
                },
            });
            field.el.dataset.verb = verb;
            label.textContent = fieldHeading(barLabel, step.label);
            // Its title drawn as every bar's: a muted label, a divider after it.
            bar.replaceChildren(label, barSeparator(), field.el, ...fieldAside(step));
            const again = this.fieldBar?.bar === bar;
            this.fieldBar = { bar, field };
            if (again) {
                // A next step, or a refusal's line: the bar's size changed under the same claim.
                this.slot.contentChanged(key);
            }
            return field;
        };
        this.mount.append(bar);
        const field = open(first);
        // The one floating layer (`placement.ts`): at what it edits — below it, from its
        // last line's start — the bar or bubble that was up gives way. Placed before the
        // field takes the focus, which scrolls it into view.
        const granted = this.slot.request({
            kind: 'field',
            key,
            el: bar,
            anchor: () => (this.fieldBar?.bar !== bar ? null : from === to ? caretRect(view, Math.min(from, view.state.doc.content.size)) : rangeAnchor(view, from, to)),
            valid: () => this.fieldBar?.bar === bar,
            hidden: () => {
                if (this.fieldBar?.bar === bar) {
                    this.closeFieldBar();
                }
            },
        }, { force: true });
        if (!granted) {
            this.closeFieldBar();
            return;
        }
        // What the field acts on stays visible while the field has the focus.
        showPendingRange(view, from, to);
        field.focus();
    }

    private closeFieldBar(): void {
        const open = this.fieldBar;
        this.fieldBar = null;
        open?.field.dispose();
        open?.bar.remove();
        const claim = this.slot.current;
        if (open && claim?.el === open.bar) {
            this.slot.release(claim.key);
        }
    }

    // -- the bubble ------------------------------------------------------------

    private focusLeft(e: FocusEvent): void {
        const to = e.relatedTarget as Element | null;
        if (to && (this.bubble.contains(to) || placeOfElement(this.view, to).kind === 'text')) {
            return;
        }
        this.dropBubble();
    }

    /**
     * Whether the bubble is wanted: a non-empty text selection in editable
     * text, while the editor (or the bubble) has the focus.
     */
    bubbleWanted(): boolean {
        const sel = this.view.state.selection;
        const focused = focusPlace(this.view).kind === 'text' || this.bubble.contains(document.activeElement);
        return focused && sel instanceof TextSelection && !sel.empty
            && sel.$from.parent.inlineContent && sel.$to.parent.inlineContent && !sel.$from.parent.type.spec.code;
    }

    /** The key of the selection now, as the slot knows it (`sel@from-to`). */
    private selectionKey(): string {
        const sel = this.view.state.selection;
        return `sel@${sel.from}-${sel.to}`;
    }

    /**
     * The bubble follows the selection through the slot (`placement.ts`): it
     * shows once a selection has rested `REST_MS` — at once when the pointer
     * that drew it is released — and hides while a keyboard selection grows,
     * so it does not blink on every Shift+arrow. Below the selection's last
     * line, from that line's start, like every layer; where the selection is
     * taller than the window, at its visible edge. Hidden where it is not
     * wanted (`bubbleWanted`).
     */
    private syncBubble(): void {
        if (!this.bubbleWanted()) {
            this.dropBubble();
            return;
        }
        const key = this.selectionKey();
        if (key !== this.bubbleKey) {
            // A new selection: the last one's dismissal ends, and this one waits for its rest.
            this.dropBubble();
            this.bubbleKey = key;
            // A selection the pointer draws waits for its release (`bubbleReleased`).
            if (!this.pointerHeld) {
                this.bubbleTimer = setTimeout(() => {
                    this.bubbleTimer = undefined;
                    this.requestBubble();
                }, REST_MS);
            }
            return;
        }
        if (this.slot.current?.key === key) {
            this.slot.replace();
        }
    }

    /** The pointer button came up: a selection it drew shows its bubble now. */
    private bubbleReleased(): void {
        if (this.bubbleWanted() && this.bubbleKey === this.selectionKey() && this.slot.current?.key !== this.bubbleKey) {
            clearTimeout(this.bubbleTimer);
            this.bubbleTimer = undefined;
            this.requestBubble();
        }
    }

    private requestBubble(): void {
        if (this.destroyed || !this.bubbleWanted()) {
            return;
        }
        const key = this.selectionKey();
        this.bubbleKey = key;
        this.bubble.hidden = false;
        const view = this.view;
        const granted = this.slot.request({
            kind: 'bubble',
            key,
            el: this.bubble,
            anchor: () => {
                const sel = view.state.selection;
                return rangeAnchor(view, sel.from, sel.to);
            },
            valid: () => this.bubbleWanted() && this.selectionKey() === key,
            hidden: () => this.hideBubble(),
        });
        if (!granted) {
            this.hideBubble();
        }
    }

    /** The bubble's selection is over: its wait, its dismissal and its claim end. */
    private dropBubble(): void {
        clearTimeout(this.bubbleTimer);
        this.bubbleTimer = undefined;
        if (this.bubbleKey !== null) {
            this.slot.caretLeft(this.bubbleKey);
            this.slot.release(this.bubbleKey);
            this.bubbleKey = null;
        }
        this.hideBubble();
    }

    private hideBubble(): void {
        this.bubble.hidden = true;
        this.tips.hide(this.bubble);
    }
}

const toolbarViews = new WeakMap<EditorView, ToolbarView>();

/** The status slot at the right end of the view's formatting row, before Export; `null` without a toolbar. */
export function toolbarStatusSlot(view: EditorView): HTMLElement | null {
    return view.dom.parentElement?.querySelector<HTMLElement>(':scope > .mep-toolbar > .mep-row-status > .mep-row-said') ?? null;
}

/**
 * Whether the selection of `view` wants the bubble (`bubbleWanted`): a
 * non-empty selection has no caret bar, so the object toolbar shows none
 * meanwhile, also while the bubble waits for the selection's rest.
 */
export function selectionWantsBubble(view: EditorView): boolean {
    return toolbarViews.get(view)?.bubbleWanted() ?? false;
}

/** Have the toolbar of `view` read the page's state again (Export busy or not), without a transaction through every plugin. */
export function refreshToolbar(view: EditorView): void {
    toolbarViews.get(view)?.update(view);
}

/**
 * The toolbar and the bubble, as a plugin: its view is built with the editor's
 * and follows every state it takes. `Ctrl+K` (`Cmd+K`) is **Insert → Link…**;
 * the key is kept from VS Code, whose `Ctrl+K` starts a chord.
 */
export function toolbarPlugin(host: ToolbarHost): Plugin {
    return new Plugin({
        view: view => {
            const toolbar = new ToolbarView(view, host);
            toolbarViews.set(view, toolbar);
            return toolbar;
        },
        props: {
            handleKeyDown(view, event) {
                if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
                    return false;
                }
                event.preventDefault();
                event.stopPropagation();
                toolbarViews.get(view)?.askLink();
                return true;
            },
        },
    });
}
