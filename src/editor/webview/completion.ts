/**
 * Completion while typing (ARCHITECTURE.md, *Completion, diagnostics and
 * hover*): the completion providers VS Code holds for the document — Req
 * Explorer's requirement ids, the built-in Markdown's paths and anchors — asked
 * at the caret's source position and listed under the caret.
 *
 * **When it asks.** A provider's trigger characters are in its registration,
 * which no API hands to another extension; so the page asks with every
 * non-word character typed (80 ms after it, one question in flight, a newer one
 * waiting behind it and the older answer dropped), and the host drops empty
 * answers cheaply. `Ctrl+Space` asks with none. A letter never opens the list;
 * while it is open, letters filter it (`filterText`, else the label, by prefix)
 * and ask again when a provider said its list is incomplete.
 *
 * **Which keys accept.** `Tab` always; `Enter` as VS Code's
 * `editor.acceptSuggestionOnEnter` for Markdown says, which the host posts
 * (`completionSettings`): `on` accepts, `off` closes the list and leaves the
 * key to the text (a new line), `smart` accepts only where accepting changes
 * the text (`enterAccepts`).
 *
 * **A space at a textblock's end.** The serializer drops it, so the host
 * would hold the text without it and the caret after it would map only
 * approximately. Asked there, the list holds it (`holding`): the page writes
 * that textblock's closing spaces (`keepTrailingSpace`) while the question is
 * on its way, and again while an accepted item is on its way back — so the
 * providers see "1. " and the item's range covers it. Not while the list
 * stands open: the answer lets go at once, and the edit that drops the space
 * goes at once too, so another writer's change, a save or the window closing
 * meanwhile finds the file as typing alone leaves it. A document the host
 * parsed while the space was in its text marks that block edited
 * (`dropSentSpace`), so the next edit drops it there too; a save lets go
 * first.
 *
 * **What accepting does.** Nothing on the page: the item's edit is the
 * provider's, applied by the host to the source (`applyCompletion`), and the
 * block comes back as any writer's change does, the caret where the host says
 * the insertion ends. The page shows what the source will say, never its own
 * guess of it.
 */
import { Node } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, PluginView, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { WORD_CHARACTER } from '../../syntax/markers';
import { PositionMap, caretOf } from '../positions';
import type { AcceptOnEnter, CompletionEntry, HostMessage, WebviewMessage } from '../protocol';
import { CompletionListView } from './completionList';
import { showHint } from './hint';
import { placeLayer } from './placement';

/** How long the typing rests after a trigger before the providers are asked. */
export const COMPLETION_ASK_DELAY_MS = 80;

/** How long an answer is waited for before the question counts as lost and another may be asked. */
const COMPLETION_TIMEOUT_MS = 2000;

/** The list's footer: its keys, as the field's list says its own (`COMPLETION_KEYS`). */
export const CARET_COMPLETION_KEYS = '↹ ↵ accept · Esc close';

/** The footer where Enter does not accept (`acceptSuggestionOnEnter: off`): Tab alone. */
export const CARET_COMPLETION_KEYS_TAB = '↹ accept · Esc close';

/** The footer for the setting: `↵` named only where Enter may accept. */
export function caretCompletionKeys(acceptOnEnter: AcceptOnEnter): string {
    return acceptOnEnter === 'off' ? CARET_COMPLETION_KEYS_TAB : CARET_COMPLETION_KEYS;
}

/** Whether `ch` is part of a word — a letter, a digit, `_` — and so filters an open list rather than asking. */
export function isWordCharacter(ch: string): boolean {
    return Array.from(ch).length === 1 && WORD_CHARACTER.test(ch);
}

/** An item the list shows, with its index in the host's answer (what `applyCompletion` names). */
export interface ListedCompletion {
    index: number;
    entry: CompletionEntry;
}

/**
 * The items that match what was typed since the items' range began: those
 * whose `filterText` — else label — starts with it, ignoring case, in the
 * host's order. Everything for nothing typed.
 */
export function filterCompletions(items: readonly CompletionEntry[], query: string): ListedCompletion[] {
    const q = query.toLowerCase();
    return items
        .map((entry, index) => ({ index, entry }))
        .filter(({ entry }) => (entry.filterText ?? entry.label).toLowerCase().startsWith(q));
}

/**
 * What a key does to an open list of `count` rows with row `chosen` chosen.
 * `dismiss` closes the list and leaves the key to the text.
 */
export type ListKeyAction = { kind: 'move'; chosen: number } | { kind: 'accept'; chosen: number } | { kind: 'close' } | { kind: 'dismiss' } | null;

/**
 * Whether `Enter` accepts `entry`, as VS Code's text editor decides it
 * (`acceptSuggestionOnEnter`): always with `on`, never with `off`; with
 * `smart` only where accepting changes the text — a list asked for with
 * `Ctrl+Space`, a snippet or an item with additional edits always does,
 * otherwise only an item whose insertion differs from what was typed since
 * its range began (`typed`). `Ctrl+Space` stands for VS Code's explicitly
 * triggered list, whose Enter `smart` leaves alone.
 */
export function enterAccepts(acceptOnEnter: AcceptOnEnter, entry: CompletionEntry | undefined, typed: string, manual: boolean): boolean {
    if (acceptOnEnter !== 'smart') {
        return acceptOnEnter === 'on';
    }
    return manual || entry === undefined || entry.snippetOrEdits === true || typed !== entry.insertText;
}

/**
 * The list's keys: `↓`/`↑` move (wrapping), `Tab` accepts the chosen row,
 * `Enter` too unless `enterAccepts` is false — it then closes the list and is
 * the text's — `Esc` closes; any other key — and any with `Ctrl`, `Alt` or
 * `Cmd` — is the text's.
 */
export function listKeyAction(key: string, count: number, chosen: number, modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}, enterAcceptsRow = true): ListKeyAction {
    if (count <= 0 || modifiers.ctrl || modifiers.alt || modifiers.meta) {
        return null;
    }
    switch (key) {
        case 'ArrowDown':
            return { kind: 'move', chosen: (chosen + 1) % count };
        case 'ArrowUp':
            return { kind: 'move', chosen: chosen <= 0 ? count - 1 : chosen - 1 };
        case 'Tab':
            return modifiers.shift ? null : { kind: 'accept', chosen: Math.max(0, chosen) };
        case 'Enter':
            return enterAcceptsRow ? { kind: 'accept', chosen: Math.max(0, chosen) } : { kind: 'dismiss' };
        case 'Escape':
            return { kind: 'close' };
        default:
            return null;
    }
}

/** What the list needs from the page. */
export interface CompletionPort {
    /** The version of the document shown, `undefined` without one. */
    version(): number | undefined;
    /** Send the pending edit now, so the host holds the page's text. */
    flush(): void;
    /** The position map of the document shown now. */
    map(): PositionMap | undefined;
    post(message: WebviewMessage): void;
    /** VS Code's `editor.acceptSuggestionOnEnter` for Markdown, as the host last posted it. */
    acceptOnEnter(): AcceptOnEnter;
    /** The page's text changed with no transaction — a held space let go (`holding`): send it now. */
    textChanged(): void;
}

/**
 * Where the open list's items begin (`anchor`: what was typed since is the
 * query) and where the caret stood when the list was last asked for
 * (`asked`), both mapped through every transaction.
 */
interface Places {
    anchor: number | null;
    asked: number | null;
}

const placesKey = new PluginKey<Places>('mepCompletionAnchor');

/**
 * Whether the selection is a caret at its textblock's end right after a
 * space: the place whose space the serializer drops, unless it is held
 * (`keepTrailingSpace`).
 */
export function afterClosingSpace(selection: Selection): boolean {
    if (!(selection instanceof TextSelection) || !selection.empty) {
        return false;
    }
    const $head = selection.$head;
    const before = $head.nodeBefore;
    return $head.parent.isTextblock && $head.parentOffset === $head.parent.content.size && before !== null && before.isText && (before.text ?? '').endsWith(' ');
}

interface Open {
    requestId: number;
    items: readonly CompletionEntry[];
    incomplete: boolean;
    shown: ListedCompletion[];
    /** Asked for with `Ctrl+Space`, not by a character typed: VS Code's explicitly triggered list. */
    manual: boolean;
}

let listSeq = 0;

class CaretCompletion implements PluginView {
    private list: CompletionListView | null = null;
    private open: Open | null = null;
    private inFlight: { requestId: number; timer: ReturnType<typeof setTimeout>; manual: boolean } | null = null;
    /** A question asked while another was in flight: asked when that one is answered, whose answer is then dropped. */
    private queued: { trigger?: string; manual: boolean } | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private awaitingApply: number | null = null;
    /** The textblock at `asked` keeps its closing spaces (`afterClosingSpace`): a question asked there, or an item accepted there, on its way. */
    private holding = false;
    /** A held space went to the host — the held textblock's text without it — and no document has come back since: one that comes may hold it (`dropSentSpace`). */
    private spaceSent: string | null = null;
    private seq = 0;
    private readonly mount: HTMLElement;
    private readonly onBeforeInput = (e: Event) => this.input(e as InputEvent);
    private readonly onFocusOut = (e: FocusEvent) => {
        if (!this.list || !(e.relatedTarget instanceof globalThis.Node) || !this.list.el.contains(e.relatedTarget)) {
            this.close();
        }
    };

    constructor(private readonly view: EditorView, private readonly port: CompletionPort) {
        this.mount = view.dom.parentElement as HTMLElement;
        view.dom.addEventListener('beforeinput', this.onBeforeInput);
        view.dom.addEventListener('focusout', this.onFocusOut);
    }

    get isOpen(): boolean {
        return this.open !== null;
    }

    /** The rows listed now: for tests. */
    get listed(): readonly CompletionEntry[] {
        return this.open?.shown.map(s => s.entry) ?? [];
    }

    /** The textblock whose closing spaces the page writes now, `null` for none. */
    get held(): Node | null {
        const asked = this.holding ? placesKey.getState(this.view.state)?.asked : null;
        if (asked == null) {
            return null;
        }
        const doc = this.view.state.doc;
        const parent = doc.resolve(Math.min(asked, doc.content.size)).parent;
        return parent.isTextblock ? parent : null;
    }

    /** Whether a held space is in the page's text now: the held textblock still ends in one. */
    get holdsSpace(): boolean {
        const last = this.held?.lastChild;
        return last?.isText === true && (last.text ?? '').endsWith(' ');
    }

    update(): void {
        if (this.open) {
            this.refilter();
        }
    }

    destroy(): void {
        clearTimeout(this.timer);
        if (this.inFlight) {
            clearTimeout(this.inFlight.timer);
        }
        this.view.dom.removeEventListener('beforeinput', this.onBeforeInput);
        this.view.dom.removeEventListener('focusout', this.onFocusOut);
        this.list?.remove();
    }

    /** `Ctrl+Space` asks; the list's keys while it is open. True when the key was the list's. */
    keydown(e: KeyboardEvent): boolean {
        if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.key === ' ' || e.code === 'Space')) {
            e.preventDefault();
            e.stopPropagation();
            clearTimeout(this.timer);
            this.ask(undefined, true);
            return true;
        }
        if (!this.open || !this.list || e.isComposing) {
            return false;
        }
        const row = this.open.shown[Math.max(0, this.list.chosen)];
        const enter = e.key !== 'Enter' || enterAccepts(this.port.acceptOnEnter(), row?.entry, this.typed() ?? '', this.open.manual);
        const action = listKeyAction(e.key, this.open.shown.length, this.list.chosen, { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey }, enter);
        if (action === null) {
            return false;
        }
        if (action.kind === 'dismiss') {
            // The key goes on to the editor's keymaps: Enter makes its new line.
            this.close();
            return false;
        }
        e.preventDefault();
        e.stopPropagation();
        if (action.kind === 'move') {
            this.list.choose(action.chosen);
        } else if (action.kind === 'accept') {
            this.accept(this.open.shown[action.chosen]);
        } else {
            this.close();
        }
        return true;
    }

    /** The host's `completions`: shown when it answers the question in flight and none waits behind it. */
    answered(msg: Extract<HostMessage, { type: 'completions' }>): void {
        if (!this.inFlight || msg.requestId !== this.inFlight.requestId) {
            return;
        }
        const { manual } = this.inFlight;
        clearTimeout(this.inFlight.timer);
        this.inFlight = null;
        if (this.queued) {
            const queued = this.queued;
            this.queued = null;
            this.ask(queued.trigger, queued.manual);
            return;
        }
        if (msg.version !== this.port.version() || msg.items.length === 0) {
            this.close();
            return;
        }
        const state = this.view.state;
        const selection = state.selection;
        const map = this.port.map();
        // The caret left the textblock it was asked in, or went back before that place (Enter, a click): the answer is not for it.
        const asked = placesKey.getState(state)?.asked;
        if (!(selection instanceof TextSelection) || !selection.empty || !map || asked == null || asked < selection.$head.start() || asked > selection.head) {
            this.close();
            return;
        }
        // Where the items begin: the first one's range, when it is in the caret's own text and before it.
        let anchor = selection.head;
        const start = msg.items[0].range ? map.pagePositionOf(msg.items[0].range.start) : null;
        if (start && !start.approximate && start.pos <= selection.head && start.pos >= selection.$head.start()) {
            anchor = start.pos;
        }
        this.open = { requestId: msg.requestId, items: msg.items, incomplete: msg.incomplete, shown: [], manual };
        // The update this dispatch makes draws the list (`refilter`).
        this.view.dispatch(state.tr.setMeta(placesKey, { anchor }).setMeta('addToHistory', false));
        // The anchor was read from the text with the space; the list stands without it (`accept` holds it again).
        this.release();
    }

    /** The host's `completionApplied`: the caret to where the insertion ends, in the document it posted just before. */
    applied(msg: Extract<HostMessage, { type: 'completionApplied' }>): void {
        if (msg.requestId !== this.awaitingApply) {
            return;
        }
        this.awaitingApply = null;
        // Applied, the document is the host's; refused, the next edit drops the space again.
        this.release();
        if (msg.caret === null) {
            showHint(this.view, 'Completion not applied — the text changed meanwhile. Ask again.', 'refusal');
            return;
        }
        const map = this.port.map();
        if (msg.version !== this.port.version() || !map) {
            return;
        }
        const at = map.pagePositionOf(msg.caret);
        if (at === null) {
            return;
        }
        const doc = this.view.state.doc;
        const selection = TextSelection.near(doc.resolve(Math.min(at.pos, doc.content.size)));
        this.view.focus();
        this.view.dispatch(this.view.state.tr.setSelection(selection).setMeta('addToHistory', false).scrollIntoView());
    }

    /**
     * A new document from the host: what the list was for is gone, and so is
     * any hold — the document is the host's. One parsed while a held space was
     * in the host's text may hold it (`dropSentSpace`).
     */
    documentShown(): void {
        this.close();
        this.holding = false;
        if (this.spaceSent !== null) {
            this.dropSentSpace();
        }
    }

    /**
     * A document the host parsed from a text with a held space in it reads
     * that block as untouched, its `src` holding the space, which the save
     * would then write. The textblock is found again by its text — the held
     * one without its closing spaces — in a block with a `src` whose text has
     * a space right after the textblock's end, the one nearest `asked` (which
     * the resync may have moved off it); that block is marked edited (`src`
     * cleared), so the next edit writes it by rule and drops the space.
     */
    private dropSentSpace(): void {
        const sent = this.spaceSent;
        this.spaceSent = null;
        const state = this.view.state;
        const map = this.port.map();
        if (sent === null || !map) {
            return;
        }
        const lines = map.text.split(/\r\n|\r|\n/);
        const asked = placesKey.getState(state)?.asked ?? 0;
        const doc = state.doc;
        let best = -1;
        doc.descendants((node, pos) => {
            if (!node.isTextblock) {
                return true;
            }
            if (node.textContent !== sent) {
                return false;
            }
            const index = doc.resolve(pos).index(0);
            const top = doc.resolve(pos).posAtIndex(index, 0);
            const at = (doc.child(index).attrs.src ?? null) === null ? null : map.sourcePositionOf(pos + node.nodeSize - 1);
            if (at && !at.approximate && lines[at.line]?.charAt(at.character) === ' ' && (best < 0 || Math.abs(top - asked) < Math.abs(best - asked))) {
                best = top;
            }
            return false;
        });
        const block = best < 0 ? null : doc.nodeAt(best);
        if (block !== null) {
            this.view.dispatch(state.tr.setNodeMarkup(best, undefined, { ...block.attrs, src: null }).setMeta('addToHistory', false));
        }
    }

    /**
     * Close the list. Its anchor stays in the state, unread, until the next
     * list sets its own: closing runs inside updates. A held space is let go
     * unless a question or an accepted item is still on its way, or the caller
     * keeps it (`accept`).
     */
    close(keepHold = false): void {
        this.open = null;
        this.list?.remove();
        this.list = null;
        if (!keepHold && !this.inFlight && this.awaitingApply === null) {
            this.release();
        }
    }

    /** A save is about to write the text: a held space goes first, and the list it was held for closes. */
    beforeSave(): void {
        if (!this.holdsSpace) {
            return;
        }
        this.close();
        this.holding = false;
    }

    /** Hold the caret's closing spaces, when it stands after one at its textblock's end; `asked` set to it. */
    private hold(selection: TextSelection): void {
        this.holding = afterClosingSpace(selection);
        // The flush right after sends it.
        if (this.holding) {
            this.spaceSent = selection.$head.parent.textContent.replace(/ +$/, '');
        }
        this.view.dispatch(this.view.state.tr.setMeta(placesKey, { asked: selection.head }).setMeta('addToHistory', false));
    }

    /** Let a held space go: the page's text drops it, and the edit that says so goes now. */
    private release(): void {
        if (!this.holding) {
            return;
        }
        this.holding = false;
        this.port.textChanged();
    }

    /** A character typed (any path, a note's own input handler included): a non-word one asks, a letter filters. */
    private input(e: InputEvent): void {
        if (e.inputType !== 'insertText' || typeof e.data !== 'string' || e.data === '') {
            return;
        }
        const ch = [...e.data].pop() as string;
        if (!isWordCharacter(ch)) {
            this.schedule(ch, false);
        } else if (this.open?.incomplete) {
            // Asked again for the same list: as it was asked for.
            this.schedule(undefined, this.open.manual);
        }
    }

    private schedule(trigger: string | undefined, manual: boolean): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.ask(trigger, manual);
        }, COMPLETION_ASK_DELAY_MS);
    }

    /** What was typed since the open list's anchor, up to the caret; `null` without one. */
    private typed(): string | null {
        const state = this.view.state;
        const anchor = placesKey.getState(state)?.anchor;
        const selection = state.selection;
        if (anchor == null || !(selection instanceof TextSelection) || !selection.empty || anchor > selection.head || anchor < selection.$head.start()) {
            return null;
        }
        return state.doc.textBetween(anchor, selection.head, '', '￼');
    }

    /** Ask the host at the caret, after the pending edit, so the position is in the text it holds. */
    private ask(trigger: string | undefined, manual: boolean): void {
        const version = this.port.version();
        if (version === undefined) {
            return;
        }
        if (this.inFlight) {
            this.queued = { trigger, manual };
            return;
        }
        const selection = this.view.state.selection;
        if (!(selection instanceof TextSelection) || !selection.empty) {
            if (!this.open) {
                this.release();
            }
            return;
        }
        this.hold(selection);
        this.port.flush();
        const map = this.port.map();
        const caret = map ? caretOf(this.view.state.selection, map) : null;
        if (caret === null) {
            if (!this.open) {
                this.release();
            }
            return;
        }
        const requestId = ++this.seq;
        const timer = setTimeout(() => {
            if (this.inFlight?.requestId === requestId) {
                this.inFlight = null;
                this.queued = null;
                if (!this.open) {
                    this.release();
                }
            }
        }, COMPLETION_TIMEOUT_MS);
        this.inFlight = { requestId, timer, manual };
        this.port.post({ type: 'complete', requestId, baseVersion: version, position: caret, ...(trigger !== undefined ? { triggerCharacter: trigger } : {}) });
    }

    /**
     * Accept a row: the host applies it to the source; the list closes at
     * once. A space at the caret's textblock end is held until the host
     * answers, so the text the item is applied to still holds it.
     */
    private accept(row: ListedCompletion | undefined): void {
        const open = this.open;
        this.close(true);
        const version = this.port.version();
        const selection = this.view.state.selection;
        if (!open || !row || version === undefined || !(selection instanceof TextSelection)) {
            this.close();
            return;
        }
        if (afterClosingSpace(selection)) {
            this.hold(selection);
        }
        this.port.flush();
        const map = this.port.map();
        const caret = map ? caretOf(this.view.state.selection, map) : null;
        if (caret === null) {
            this.close();
            return;
        }
        this.awaitingApply = open.requestId;
        this.port.post({ type: 'applyCompletion', requestId: open.requestId, index: row.index, baseVersion: version, position: caret });
    }

    /** The list for the text typed since its anchor, under the caret; closed when the caret left it or nothing matches. */
    private refilter(): void {
        const open = this.open;
        const state = this.view.state;
        const anchor = placesKey.getState(state)?.anchor;
        const selection = state.selection;
        if (!open || anchor == null || !(selection instanceof TextSelection) || !selection.empty) {
            this.close();
            return;
        }
        const $head = selection.$head;
        if (anchor > $head.pos || anchor < $head.start()) {
            this.close();
            return;
        }
        const query = state.doc.textBetween(anchor, $head.pos, '', '￼');
        const previous = this.list && this.list.chosen >= 0 ? open.shown[this.list.chosen]?.index : undefined;
        open.shown = filterCompletions(open.items, query);
        if (open.shown.length === 0) {
            this.close();
            return;
        }
        if (!this.list) {
            this.list = new CompletionListView(`mep-caret-completions-${++listSeq}`, 'Completions', caretCompletionKeys(this.port.acceptOnEnter()), i => this.accept(this.open?.shown[i]));
            this.list.el.classList.add('mep-caret-completions');
            this.mount.append(this.list.el);
        }
        // The setting may have changed since the list was made.
        this.list.footer = caretCompletionKeys(this.port.acceptOnEnter());
        const chosen = Math.max(0, open.shown.findIndex(s => s.index === previous));
        this.list.render(open.shown.map(s => ({ label: s.entry.label, detail: s.entry.detail, kind: s.entry.kind })), chosen);
        this.place(anchor, $head.pos);
    }

    /**
     * Under the caret's line, starting where the items begin; above it when
     * below has no room — every layer's rule (`placeLayer`): under the row,
     * inside the layer edge, off the other open layers.
     */
    private place(anchor: number, head: number): void {
        if (!this.list) {
            return;
        }
        const start = this.view.coordsAtPos(anchor);
        const caret = this.view.coordsAtPos(head);
        placeLayer(this.list.el, { left: start.left, top: caret.top, right: Math.max(start.left, caret.right), bottom: caret.bottom }, { view: this.view, mount: this.mount, space: 'mount' });
    }
}

const instances = new WeakMap<EditorView, CaretCompletion>();

/** Deliver the host's `completions` or `completionApplied` to the view's list. */
export function completionMessage(view: EditorView, msg: Extract<HostMessage, { type: 'completions' | 'completionApplied' }>): void {
    const list = instances.get(view);
    if (msg.type === 'completions') {
        list?.answered(msg);
    } else {
        list?.applied(msg);
    }
}

/** A new document arrived: an open list closes. */
export function completionDocumentShown(view: EditorView): void {
    instances.get(view)?.documentShown();
}

/** The host's settings for the list changed: an open list says its keys afresh. */
export function completionSettingsChanged(view: EditorView): void {
    instances.get(view)?.update();
}

/** The textblock whose closing spaces the page writes now (`keepTrailingSpace`), `null` for none. */
export function completionHeld(view: EditorView): Node | null {
    return instances.get(view)?.held ?? null;
}

/** A save is about to write the page's text: a space held for the list goes first. */
export function completionBeforeSave(view: EditorView): void {
    instances.get(view)?.beforeSave();
}

/** Whether the view's list is open: the hover waits while it is. */
export function completionOpen(view: EditorView): boolean {
    return instances.get(view)?.isOpen ?? false;
}

/** The rows the view's list shows: for tests. */
export function completionsListed(view: EditorView): readonly CompletionEntry[] {
    return instances.get(view)?.listed ?? [];
}

/**
 * The list, as a plugin placed before the editor's keymaps, so `Enter`,
 * `Tab` and the arrows are the list's while it is open. `Ctrl+Space` is kept
 * from VS Code, which would open its own suggest widget on nothing.
 */
export function completionPlugin(port: CompletionPort): Plugin<Places> {
    return new Plugin<Places>({
        key: placesKey,
        state: {
            init: () => ({ anchor: null, asked: null }),
            apply(tr, value) {
                const set = tr.getMeta(placesKey) as Partial<Places> | undefined;
                const map = (pos: number | null) => (pos !== null && tr.docChanged ? tr.mapping.map(pos, -1) : pos);
                const mapped = tr.docChanged ? { anchor: map(value.anchor), asked: map(value.asked) } : value;
                return set === undefined ? mapped : { ...mapped, ...set };
            },
        },
        view: view => {
            const list = new CaretCompletion(view, port);
            instances.set(view, list);
            return list;
        },
        props: {
            handleKeyDown(view, event) {
                return instances.get(view)?.keydown(event) ?? false;
            },
        },
    });
}

/** For tests: the anchor the state holds. */
export function completionAnchor(state: EditorState): number | null {
    return placesKey.getState(state)?.anchor ?? null;
}
