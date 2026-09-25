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
 * start, at a block's right edge (`Anchor`); below its last line when there is
 * no room above (under the sticky formatting row) — and never over the line
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
import { Plugin, PluginView, TextSelection, Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ADMONITION_TYPES } from '../../syntax/markers';
import { containerClass } from '../schema';
import { editRawSourceAt } from './nodeViews';
import { HintTone, showHint, undoKey } from './hint';
import { InlineChoice, InlineField } from './inlineField';
import { NoteNodeName, unwrapNote } from './notes';
import {
    EditorObject, NOTE_CONVERSION, blockAttrsRefusal, changeAdmonitionTransaction, changeBlockAttrsTransaction, changeContainerTransaction,
    changeImageTransaction, changeLinkTransaction, changeSpanTransaction, containerNameOf, convertNoteRefusal, convertNoteTransaction, currentObject,
    deleteObjectTransaction, isBlockObject, isBlockPlaced, literalPlaceOf, literalRefusal, noteSource, objectAtSelection, objectOfNode, removeLinkTransaction,
    removeSpanTransaction, sameObject, unwrapTransaction,
} from './objects';
import { SourceContext, inlineSourceTransaction } from './toolbar/commands';

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
}

/** How long the caret rests in an inline object before its toolbar shows. */
export const INLINE_DELAY_MS = 400;

/** How long the pointer may be off a block and its bar before the bar goes: time to cross the gap between them. */
const HOVER_GRACE_MS = 300;

/** Between the bar and the line it sits above or below. */
const GAP = 4;

/** One verb as the bar draws it. */
interface Verb {
    /** `data-verb`: what tests and stylesheets name it by. */
    id: string;
    label: string;
    title: string;
    /** Why it cannot be chosen here, shown in its tooltip; `null` when it can. */
    refusal?: string | null;
    /** A verb that runs at once. */
    run?(): void;
    /** A verb that asks for a value first, in the inline field. */
    field?: { value: string; label: string; commit(value: string): void };
    /** A verb that asks for one of a list of values, in the inline choice. */
    choice?: { value: string; label: string; options: readonly { value: string; label: string }[]; commit(value: string): void };
}

interface Presentation {
    label: string;
    title: string;
    verbs: Verb[];
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

/** What a block carrying an attribute literal is called in its bar's label. */
const BLOCK_LABELS: Readonly<Record<string, string>> = {
    paragraph: 'Paragraph',
    heading: 'Heading',
    bullet_list: 'List',
    ordered_list: 'List',
    code_block: 'Code block',
    horizontal_rule: 'Rule',
};

function isSidebar(name: NoteNodeName): boolean {
    return name === 'left_sidebar' || name === 'right_sidebar';
}

/** One bar: a label and verbs, or a label and the inline field. */
class ObjectBar {
    readonly el: HTMLElement;
    object: EditorObject | null = null;
    private field: InlineField | InlineChoice | null = null;
    private signature = '';
    private buttons: { verb: Verb; el: HTMLButtonElement }[] = [];

    constructor(trigger: 'selection' | 'hover', private readonly events: { escape(): void; fieldClosed(committed: boolean): void }) {
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
            presentation.verbs.map(v => [v.id, v.label, v.title, v.refusal ?? null, v.field?.value ?? v.choice?.value ?? null]),
        ]);
        if (!this.field && signature !== this.signature) {
            this.signature = signature;
            this.render(presentation);
        }
        this.el.hidden = false;
    }

    hide(): void {
        this.field?.dispose();
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
            el.textContent = verb.label;
            el.tabIndex = -1;
            el.title = verb.refusal ? `${verb.title}\n${verb.refusal}` : verb.title;
            el.setAttribute('aria-disabled', String(Boolean(verb.refusal)));
            el.addEventListener('click', e => {
                e.preventDefault();
                this.choose(verb);
            });
            return { verb, el };
        });
        this.el.replaceChildren(label, ...this.buttons.map(b => b.el));
    }

    private choose(verb: Verb): void {
        if (verb.refusal) {
            return;
        }
        if (verb.field) {
            this.openField(verb, verb.field);
        } else if (verb.choice) {
            this.openField(verb, verb.choice);
        } else {
            verb.run?.();
        }
    }

    /** The verb's field — or its choice, for a verb with `options` — in place of the verbs, beside the label. */
    private openField(verb: Verb, spec: NonNullable<Verb['field']> | NonNullable<Verb['choice']>): void {
        const label = this.el.querySelector('.mep-object-label');
        const make = 'options' in spec
            ? (callbacks: { onCommit(value: string): void; onCancel(reason: 'escape' | 'blur'): void }) =>
                new InlineChoice({ choices: spec.options, value: spec.value, label: spec.label, ...callbacks })
            : (callbacks: { onCommit(value: string): void; onCancel(reason: 'escape' | 'blur'): void }) =>
                new InlineField({ value: spec.value, label: spec.label, ...callbacks });
        const field = make({
            onCommit: value => {
                this.field = null;
                this.signature = '';
                spec.commit(value);
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
        this.el.replaceChildren(...(label ? [label] : []), field.el);
        field.focus();
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
 * Where the bar is put against, in the window's coordinates: the top of the
 * object's first line and the bottom of its last, and the edge the bar is
 * aligned to — an inline object's start (`left`), a block's right edge
 * (`right`), where the source block's toolbar always sat: blocks are mostly
 * left-aligned (a table, a list), and a bar hanging over the block above at its
 * left would sit on the very thing a click there is aimed at.
 */
interface Anchor {
    top: number;
    bottom: number;
    left?: number;
    right?: number;
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
        const events = {
            escape: () => this.view.focus(),
            fieldClosed: () => this.refresh(),
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
        this.listen(window, 'scroll', () => this.placeAll(), true);
        this.listen(window, 'resize', () => this.placeAll());
        this.refresh();
    }

    update(): void {
        this.refresh();
    }

    destroy(): void {
        this.destroyed = true;
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
            this.selectionBar.show(object, this.present(object));
            this.place(this.selectionBar, object);
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
        const atom = target.closest<HTMLElement>('.mep-atom');
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
        if (object === null || (this.selectionBar.visible && sameObject(object, this.selectionBar.object))) {
            this.hoverBar.hide();
            return;
        }
        this.hoverBar.show(object, this.present(object));
        this.place(this.hoverBar, object);
    }

    // -- placing ---------------------------------------------------------------

    private placeAll(): void {
        for (const bar of [this.selectionBar, this.hoverBar]) {
            if (bar.visible && bar.object) {
                this.place(bar, bar.object);
            }
        }
    }

    /** Where the object's first line starts and its last line ends. */
    private anchor(object: EditorObject): Anchor {
        const view = this.view;
        if (object.kind !== 'link' && object.kind !== 'span') {
            const dom = view.nodeDOM(object.from);
            if (dom instanceof Element) {
                if (isBlockPlaced(object)) {
                    const r = dom.getBoundingClientRect();
                    return { right: r.right - (isBlockObject(object) ? ATOM_INSET : 0), top: r.top, bottom: r.bottom };
                }
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
     * Above the object's first line; below its last when above would be under
     * the sticky row or off the top of the window; on whichever side does not
     * cover the caret's line. While text is selected, below first: the
     * selection bubble is above.
     */
    private place(bar: ObjectBar, object: EditorObject): void {
        const el = bar.el;
        const base = this.mount.getBoundingClientRect();
        const anchor = this.anchor(object);
        const width = el.offsetWidth;
        const height = el.offsetHeight;
        const row = this.mount.querySelector(':scope > .mep-toolbar');
        const ceiling = Math.max(0, row ? row.getBoundingClientRect().bottom : 0);
        const sel = this.view.state.selection;
        const typing = bar === this.selectionBar && sel instanceof TextSelection;
        const caret = typing ? this.view.coordsAtPos(sel.head) : null;
        const covers = (y: number) => caret !== null && y < caret.bottom && y + height > caret.top;
        const fits = (y: number) => y >= ceiling && !covers(y);
        const above = anchor.top - GAP - height;
        const below = anchor.bottom + GAP;
        const order = typing && !sel.empty ? [below, above] : [above, below];
        let y = order.find(fits) ?? order[1];
        if (covers(y) && caret !== null) {
            y = caret.bottom + GAP;
        }
        const edge = anchor.left ?? (anchor.right ?? base.right) - width;
        const x = Math.max(base.left, Math.min(edge, base.right - width));
        el.style.left = `${x - base.left}px`;
        el.style.top = `${y - base.top}px`;
    }

    // -- the verbs -------------------------------------------------------------

    /**
     * Run `make` on the object as it is now; nothing when it is gone. The focus
     * goes back into the text **first**: a field's commit has already removed
     * the input, and the dispatch's own refresh, seeing the focus on the body,
     * would hide the bar and re-arm the inline delay — the bar blinking out and
     * coming back late after every change of a URL or a source.
     */
    private act(object: EditorObject, make: (current: EditorObject) => boolean, hint?: string): void {
        this.view.focus();
        const current = currentObject(this.view.state, object);
        if (current !== null && make(current) && hint !== undefined) {
            this.say(`${hint} — ${undoKey()}`, 'neutral');
        }
    }

    private say(text: string, tone: HintTone): void {
        showHint(this.view, text, tone);
    }

    private present(object: EditorObject): Presentation {
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
                            run: () => this.act(object, () => unwrapNote(name)(view.state, dispatch), sidebar ? 'Sidebar removed' : 'Note removed'),
                        },
                        {
                            id: 'convert-note',
                            label: CONVERT_LABELS[name],
                            title: `Make it a ${NOTE_LABELS[NOTE_CONVERSION[name]].toLowerCase()}, its text kept.`,
                            refusal: convertNoteRefusal(view.state, object.from),
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
                            id: 'change-url',
                            label: 'Change URL',
                            title: 'Link the text to another address (Enter to apply, Esc to cancel).',
                            field: {
                                value: href,
                                label: 'URL',
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
                return {
                    label: 'Image',
                    title: src,
                    verbs: [
                        {
                            id: 'change-source',
                            label: 'Change source',
                            title: 'Show another image here, its alt text kept (Enter to apply, Esc to cancel).',
                            field: {
                                value: src,
                                label: 'Image source',
                                commit: value => this.act(object, current => {
                                    const tr = changeImageTransaction(view.state, current.from, value);
                                    if (tr) {
                                        dispatch(tr);
                                    }
                                    return tr !== null;
                                }),
                            },
                        },
                        { id: 'remove-image', label: 'Remove image', title: 'The image goes from the text.', run: () => this.remove(object, 'Image removed') },
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
                        {
                            id: 'remove-admonition',
                            label: 'Remove admonition, keep content',
                            title: 'The admonition goes; its blocks stay where it stood.',
                            run: () => this.apply(object, current => unwrapTransaction(view.state, current.from), 'Admonition removed'),
                        },
                    ],
                };
            }
            case 'block_attrs': {
                const literal = (object.node.attrs.attrsSuffix as string | null) ?? '';
                return {
                    label: `${BLOCK_LABELS[object.node.type.name] ?? 'Block'} attributes`,
                    title: `${literal}: the attributes the block is rendered with.`,
                    verbs: [
                        {
                            id: 'edit-block-attributes',
                            label: 'Edit block attributes',
                            title: 'The block\'s {…}; empty removes it (Enter to apply, Esc to cancel).',
                            refusal: blockAttrsRefusal(object.node),
                            field: {
                                value: literal,
                                label: 'Attributes',
                                commit: value => this.commitLiteral(object, value,
                                    current => changeBlockAttrsTransaction(view.state, current.from, value), value.trim() === '' ? 'Attributes removed' : undefined),
                            },
                        },
                    ],
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
                    label: 'Source block',
                    title: 'Shown as the preview renders it, edited as Markdown.',
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
                verbs.push(
                    this.showInTextEditor(object),
                    {
                        id: 'delete-directive',
                        label: 'Delete directive',
                        title: `The line <!-- include: ${snippet} --> goes from the file, and the snippet with it; the snippet's own file stays.`,
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
                return { label: 'Front matter', title: 'Written back exactly as it is; tools such as Req Explorer edit it.', verbs: [] };
        }
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
        const place = object.kind === 'span' ? 'span' : object.kind === 'block_attrs' ? literalPlaceOf(object.node) : 'block';
        const refusal = hint !== undefined && value.trim() === '' ? null : literalRefusal(value, place);
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
export function objectToolbarPlugin(host: ObjectToolbarHost): Plugin {
    return new Plugin({
        view(editorView) {
            const toolbar = new ObjectToolbarView(editorView, host);
            toolbarViews.set(editorView, toolbar);
            return toolbar;
        },
        props: {
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
