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
 * **What accepting does.** Nothing on the page: the item's edit is the
 * provider's, applied by the host to the source (`applyCompletion`), and the
 * block comes back as any writer's change does, the caret where the host says
 * the insertion ends. The page shows what the source will say, never its own
 * guess of it.
 */
import { EditorState, Plugin, PluginKey, PluginView, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { WORD_CHARACTER } from '../../syntax/markers';
import { PositionMap, caretOf } from '../positions';
import type { CompletionEntry, HostMessage, WebviewMessage } from '../protocol';
import { CompletionListView } from './completionList';
import { showHint } from './hint';

/** How long the typing rests after a trigger before the providers are asked. */
export const COMPLETION_ASK_DELAY_MS = 80;

/** How long an answer is waited for before the question counts as lost and another may be asked. */
const COMPLETION_TIMEOUT_MS = 2000;

/** The list's footer: its keys, as the field's list says its own (`COMPLETION_KEYS`). */
export const CARET_COMPLETION_KEYS = '↹ ↵ accept · Esc close';

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

/** What a key does to an open list of `count` rows with row `chosen` chosen. */
export type ListKeyAction = { kind: 'move'; chosen: number } | { kind: 'accept'; chosen: number } | { kind: 'close' } | null;

/**
 * The list's keys: `↓`/`↑` move (wrapping), `Tab` and `Enter` accept the
 * chosen row, `Esc` closes; any other key — and any with `Ctrl`, `Alt` or
 * `Cmd` — is the text's.
 */
export function listKeyAction(key: string, count: number, chosen: number, modifiers: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}): ListKeyAction {
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
            return { kind: 'accept', chosen: Math.max(0, chosen) };
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
}

/** Where the open list's items begin, mapped through every transaction: what was typed since is the query. */
const anchorKey = new PluginKey<number | null>('mepCompletionAnchor');

interface Open {
    requestId: number;
    items: readonly CompletionEntry[];
    incomplete: boolean;
    shown: ListedCompletion[];
}

let listSeq = 0;

class CaretCompletion implements PluginView {
    private list: CompletionListView | null = null;
    private open: Open | null = null;
    private inFlight: { requestId: number; timer: ReturnType<typeof setTimeout> } | null = null;
    /** A question asked while another was in flight: asked when that one is answered, whose answer is then dropped. */
    private queued: { trigger?: string } | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private awaitingApply: number | null = null;
    private seq = 0;
    private readonly mount: HTMLElement;
    private readonly onBeforeInput = (e: Event) => this.typed(e as InputEvent);
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
            this.ask(undefined);
            return true;
        }
        if (!this.open || !this.list || e.isComposing) {
            return false;
        }
        const action = listKeyAction(e.key, this.open.shown.length, this.list.chosen, { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
        if (action === null) {
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
        clearTimeout(this.inFlight.timer);
        this.inFlight = null;
        if (this.queued) {
            const { trigger } = this.queued;
            this.queued = null;
            this.ask(trigger);
            return;
        }
        if (msg.version !== this.port.version() || msg.items.length === 0) {
            this.close();
            return;
        }
        const state = this.view.state;
        const selection = state.selection;
        const map = this.port.map();
        if (!(selection instanceof TextSelection) || !selection.empty || !map) {
            this.close();
            return;
        }
        // Where the items begin: the first one's range, when it is in the caret's own text and before it.
        let anchor = selection.head;
        const start = msg.items[0].range ? map.pagePositionOf(msg.items[0].range.start) : null;
        if (start && !start.approximate && start.pos <= selection.head && start.pos >= selection.$head.start()) {
            anchor = start.pos;
        }
        this.open = { requestId: msg.requestId, items: msg.items, incomplete: msg.incomplete, shown: [] };
        // The update this dispatch makes draws the list (`refilter`).
        this.view.dispatch(state.tr.setMeta(anchorKey, anchor).setMeta('addToHistory', false));
    }

    /** The host's `completionApplied`: the caret to where the insertion ends, in the document it posted just before. */
    applied(msg: Extract<HostMessage, { type: 'completionApplied' }>): void {
        if (msg.requestId !== this.awaitingApply) {
            return;
        }
        this.awaitingApply = null;
        if (msg.caret === null) {
            showHint(this.view, 'The completion was not applied: the text changed since it was offered — ask again', 'refusal');
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

    /** A new document from the host: what the list was for is gone. */
    documentShown(): void {
        this.close();
    }

    /** Close the list. Its anchor stays in the state, unread, until the next list sets its own: closing runs inside updates. */
    close(): void {
        this.open = null;
        this.list?.remove();
        this.list = null;
    }

    /** A character typed (any path, a note's own input handler included): a non-word one asks, a letter filters. */
    private typed(e: InputEvent): void {
        if (e.inputType !== 'insertText' || typeof e.data !== 'string' || e.data === '') {
            return;
        }
        const ch = [...e.data].pop() as string;
        if (!isWordCharacter(ch)) {
            this.schedule(ch);
        } else if (this.open?.incomplete) {
            this.schedule(undefined);
        }
    }

    private schedule(trigger: string | undefined): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.ask(trigger);
        }, COMPLETION_ASK_DELAY_MS);
    }

    /** Ask the host at the caret, after the pending edit, so the position is in the text it holds. */
    private ask(trigger: string | undefined): void {
        const version = this.port.version();
        if (version === undefined) {
            return;
        }
        if (this.inFlight) {
            this.queued = { trigger };
            return;
        }
        const selection = this.view.state.selection;
        if (!(selection instanceof TextSelection) || !selection.empty) {
            return;
        }
        this.port.flush();
        const map = this.port.map();
        const caret = map ? caretOf(this.view.state.selection, map) : null;
        if (caret === null) {
            return;
        }
        const requestId = ++this.seq;
        const timer = setTimeout(() => {
            if (this.inFlight?.requestId === requestId) {
                this.inFlight = null;
                this.queued = null;
            }
        }, COMPLETION_TIMEOUT_MS);
        this.inFlight = { requestId, timer };
        this.port.post({ type: 'complete', requestId, baseVersion: version, position: caret, ...(trigger !== undefined ? { triggerCharacter: trigger } : {}) });
    }

    /** Accept a row: the host applies it to the source; the list closes at once. */
    private accept(row: ListedCompletion | undefined): void {
        const open = this.open;
        this.close();
        const version = this.port.version();
        if (!open || !row || version === undefined) {
            return;
        }
        this.port.flush();
        const map = this.port.map();
        const caret = map ? caretOf(this.view.state.selection, map) : null;
        if (caret === null) {
            return;
        }
        this.awaitingApply = open.requestId;
        this.port.post({ type: 'applyCompletion', requestId: open.requestId, index: row.index, baseVersion: version, position: caret });
    }

    /** The list for the text typed since its anchor, under the caret; closed when the caret left it or nothing matches. */
    private refilter(): void {
        const open = this.open;
        const state = this.view.state;
        const anchor = anchorKey.getState(state);
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
            this.list = new CompletionListView(`mep-caret-completions-${++listSeq}`, 'Completions', CARET_COMPLETION_KEYS, i => this.accept(this.open?.shown[i]));
            this.list.el.classList.add('mep-caret-completions');
            this.mount.append(this.list.el);
        }
        const chosen = Math.max(0, open.shown.findIndex(s => s.index === previous));
        this.list.render(open.shown.map(s => ({ label: s.entry.label, detail: s.entry.detail, kind: s.entry.kind })), chosen);
        this.place(anchor, $head.pos);
    }

    /** Under the caret's line, starting where the items begin; above it when below has no room. */
    private place(anchor: number, head: number): void {
        if (!this.list) {
            return;
        }
        const el = this.list.el;
        const base = this.mount.getBoundingClientRect();
        const start = this.view.coordsAtPos(anchor);
        const caret = this.view.coordsAtPos(head);
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        let left = start.left - base.left;
        left = Math.max(0, Math.min(left, base.width - width));
        let top = caret.bottom + 2;
        if (top + height > window.innerHeight && caret.top - 2 - height >= 0) {
            top = caret.top - 2 - height;
        }
        el.style.left = `${left}px`;
        el.style.top = `${top - base.top}px`;
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
export function completionPlugin(port: CompletionPort): Plugin<number | null> {
    return new Plugin<number | null>({
        key: anchorKey,
        state: {
            init: () => null,
            apply(tr, value) {
                const set = tr.getMeta(anchorKey) as number | null | undefined;
                if (set !== undefined) {
                    return set;
                }
                return value !== null && tr.docChanged ? tr.mapping.map(value, -1) : value;
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
    return anchorKey.getState(state) ?? null;
}
