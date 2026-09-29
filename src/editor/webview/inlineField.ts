/**
 * A one-line input that edits one value in place — a link's URL, an image's
 * source, a note's Markdown — inside the object toolbar, and anywhere else a
 * value is asked for where it is used (a span's or a block's `{…}`, an admonition's title,
 * the toolbar's Span with class). `InlineChoice`, below, is the same for a value out of a
 * list (an admonition's type).
 *
 * The contract is small on purpose: it opens prefilled with the value selected;
 * `Enter` commits, `Esc` cancels, and the focus moving elsewhere in the page
 * cancels too, so a click elsewhere never applies a half-typed value. The
 * window losing the focus is not that: Alt+Tab away to copy a URL and back
 * finds the field as it was, and focused again. Exactly one of `onCommit` and
 * `onCancel` is called, once. Keys typed in it are its own: they do not reach
 * ProseMirror, and `Ctrl+Z` undoes the typing rather than reaching VS Code,
 * whose undo would revert the document. `Ctrl+S` is still the page's save — it
 * is taken on the window, before the field sees it — and saves the document as
 * it is, without the field's value.
 */
import { CompletionListView } from './completionList';

/** One completion a field may take: `value` goes into the field, `label` and `detail` are what the list shows. */
export interface Completion {
    value: string;
    label: string;
    detail?: string;
    kind?: string;
}

/** Where a field's completions come from: the choices for what the field holds now (a link's: the host's `linkChoices`). */
export type Completer = (query: string) => Promise<readonly Completion[]>;

/**
 * One value a verb or an action asks for, and what follows it: `commit`
 * returns the next step to ask — a new link's text, then its address — or
 * nothing when the last one is in. The bar that shows the field shows the next
 * one in its place.
 */
export interface FieldStep {
    value: string;
    caret?: number;
    label: string;
    placeholder?: string;
    complete?: Completer;
    commit(value: string): FieldStep | void;
}

export interface InlineFieldOptions {
    /** What the field starts with, selected, so typing replaces it. */
    value: string;
    /** Where the caret goes instead of selecting the value: `{.}` with the caret after the dot, to type a class. */
    caret?: number;
    /** The field's accessible name, and its placeholder unless `placeholder` says more. */
    label: string;
    /** What the empty field says: what an empty value means (a link's text: the address). */
    placeholder?: string;
    /**
     * Completion (a link's path): asked as the field opens and after each
     * change, the answer to the latest question listed under the field. `↓`/`↑`
     * choose, `Tab` or a click takes the choice into the field and asks again
     * (a file, then its `#` headings), `Enter` on a chosen one takes it and
     * commits, `Esc` closes the list first.
     */
    complete?: Completer;
    /** `Enter`: the value as typed. The field is already closed. */
    onCommit(value: string): void;
    /** `Esc`, or the focus leaving the field. The field is already closed. */
    onCancel(reason: 'escape' | 'blur'): void;
}

/**
 * What a bar says while it shows a field: the object, and the value asked for
 * — *Link · Address*, *Image · Alt text* — since a prefilled field shows no
 * placeholder; the object alone where its name already says it (*Span
 * attributes*).
 */
export function fieldHeading(object: string, field: string): string {
    return object === '' || object.toLowerCase().endsWith(field.toLowerCase()) ? object || field : `${object} · ${field}`;
}

/** The completion list's footer: its keys, the glyphs VS Code's own keybinding labels use. */
export const COMPLETION_KEYS = '↹ complete · ↵ set · Esc close';

/** How long the typing rests before a field asks for completions again. */
const COMPLETION_DELAY_MS = 80;

/**
 * What the field and the choice share: the element, the one-shot finish, and
 * the rule that the window going away is not a move in the page.
 */
abstract class InlineControl<E extends HTMLInputElement | HTMLSelectElement> {
    /** The control; the caller puts it where it belongs, then calls `focus`. */
    readonly el: E;
    private done = false;
    /** Set while the window is away with the control open: its return gives it the focus back. */
    private awaitingWindow: (() => void) | null = null;

    protected constructor(el: E, label: string, private readonly callbacks: { onCommit(value: string): void; onCancel(reason: 'escape' | 'blur'): void }) {
        el.setAttribute('aria-label', label);
        el.addEventListener('keydown', e => this.onKey(e as KeyboardEvent));
        el.addEventListener('blur', () => this.onBlur());
        // ProseMirror and the page keep out of the control.
        for (const type of ['mousedown', 'click', 'input', 'paste', 'copy', 'cut', 'keypress', 'keyup']) {
            el.addEventListener(type, e => e.stopPropagation());
        }
        this.el = el;
    }

    /** Take the focus. */
    abstract focus(): void;

    /** Whether it has been committed or cancelled. */
    get closed(): boolean {
        return this.done;
    }

    /** Remove it without committing or cancelling: its owner is going away. */
    dispose(): void {
        this.done = true;
        this.stopAwaitingWindow();
        this.teardown();
        this.el.remove();
    }

    /** A key the control takes before `Enter` and `Esc` are read; true when it did. */
    protected handleKey(_e: KeyboardEvent): boolean {
        return false;
    }

    /** The control is going: whatever it drew beside itself goes with it. */
    protected teardown(): void {
        // Nothing beside the control by default.
    }

    /**
     * A blur while the page itself still has the focus is the focus moving to
     * something else in the page: a cancel. One while it has not is the window
     * going away (another application, a VS Code panel): the control stays, and
     * takes the focus again when the window comes back.
     */
    private onBlur(): void {
        if (this.done) {
            return;
        }
        if (document.hasFocus()) {
            this.finish(null, 'blur');
            return;
        }
        if (this.awaitingWindow === null) {
            this.awaitingWindow = () => {
                this.stopAwaitingWindow();
                if (!this.done && this.el.isConnected) {
                    this.el.focus();
                }
            };
            window.addEventListener('focus', this.awaitingWindow);
        }
    }

    private stopAwaitingWindow(): void {
        if (this.awaitingWindow !== null) {
            window.removeEventListener('focus', this.awaitingWindow);
            this.awaitingWindow = null;
        }
    }

    private onKey(e: KeyboardEvent): void {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            // The page's save, taken on the window before this listener runs.
            return;
        }
        e.stopPropagation();
        if (this.handleKey(e)) {
            return;
        }
        if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            this.finish(this.el.value, 'escape');
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.finish(null, 'escape');
        }
    }

    protected finish(value: string | null, reason: 'escape' | 'blur'): void {
        if (this.done) {
            return;
        }
        this.done = true;
        this.stopAwaitingWindow();
        this.teardown();
        this.el.remove();
        if (value === null) {
            this.callbacks.onCancel(reason);
        } else {
            this.callbacks.onCommit(value);
        }
    }
}

let listSeq = 0;

export class InlineField extends InlineControl<HTMLInputElement> {
    /** The completion list under the field, while it shows choices. */
    private list: CompletionListView | null = null;
    private choices: readonly Completion[] = [];
    /** The chosen entry of the list; `-1` for none, so `Enter` commits what is typed. */
    private chosen = -1;
    /** The latest question asked: an answer to an earlier one is not shown. */
    private asked = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly listId = `mep-completions-${++listSeq}`;

    constructor(private readonly options: InlineFieldOptions) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mep-inline-field';
        input.value = options.value;
        input.placeholder = options.placeholder ?? options.label;
        input.spellcheck = false;
        // Wide enough for the value, within what the stylesheet allows.
        input.size = Math.max(12, Math.min(60, options.value.length + 2));
        super(input, options.label, options);
        if (options.complete) {
            input.setAttribute('role', 'combobox');
            input.setAttribute('aria-autocomplete', 'list');
            input.setAttribute('aria-expanded', 'false');
            input.setAttribute('aria-controls', this.listId);
            input.autocomplete = 'off';
            input.addEventListener('input', () => {
                // What is typed now is the value: `Enter` before the next
                // answer commits it, not a choice made for the earlier text.
                this.choose(-1);
                this.scheduleQuery();
            });
        }
    }

    /** Take the focus, the value selected — or the caret where the options put it — and ask for completions. */
    focus(): void {
        this.el.focus();
        if (this.options.caret === undefined) {
            this.el.select();
        } else {
            this.el.setSelectionRange(this.options.caret, this.options.caret);
        }
        if (this.options.complete) {
            this.query();
        }
    }

    /** The completions listed now, as the list shows them. For tests and the bar's redraw. */
    get listed(): readonly Completion[] {
        return this.list === null ? [] : this.choices;
    }

    protected handleKey(e: KeyboardEvent): boolean {
        if (this.list === null || this.choices.length === 0) {
            return false;
        }
        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowUp': {
                e.preventDefault();
                const n = this.choices.length;
                this.choose(e.key === 'ArrowDown' ? (this.chosen + 1) % n : (this.chosen <= 0 ? n - 1 : this.chosen - 1));
                return true;
            }
            case 'Tab':
                if (e.shiftKey) {
                    return false;
                }
                e.preventDefault();
                this.take(this.choices[Math.max(0, this.chosen)]);
                return true;
            case 'Enter':
                if (this.chosen < 0 || e.isComposing) {
                    return false;
                }
                e.preventDefault();
                this.el.value = this.choices[this.chosen].value;
                this.finish(this.el.value, 'escape');
                return true;
            case 'Escape':
                e.preventDefault();
                this.closeList();
                return true;
            default:
                return false;
        }
    }

    protected teardown(): void {
        clearTimeout(this.timer);
        this.asked++;
        this.closeList();
    }

    private scheduleQuery(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.query(), COMPLETION_DELAY_MS);
    }

    private query(): void {
        const complete = this.options.complete;
        if (!complete || this.closed) {
            return;
        }
        const id = ++this.asked;
        const value = this.el.value;
        complete(value).then(items => {
            if (id === this.asked && !this.closed) {
                this.show(items);
            }
        }, () => undefined);
    }

    /** List `items` under the field; none closes the list. */
    private show(items: readonly Completion[]): void {
        this.choices = items;
        this.chosen = -1;
        if (items.length === 0) {
            this.closeList();
            return;
        }
        // The keys, said where the eye is: the list alone does not say that
        // Tab takes a choice and goes on while Enter sets it.
        const view = this.list ?? new CompletionListView(this.listId, this.options.label, COMPLETION_KEYS, i => this.take(this.choices[i]));
        view.render(items);
        if (this.list === null) {
            this.list = view;
            this.el.after(view.el);
        }
        view.el.style.left = `${this.el.offsetLeft}px`;
        view.el.style.minWidth = `${this.el.offsetWidth}px`;
        this.el.setAttribute('aria-expanded', 'true');
        this.el.removeAttribute('aria-activedescendant');
    }

    private choose(index: number): void {
        this.chosen = index;
        const option = this.list?.choose(index);
        if (option) {
            this.el.setAttribute('aria-activedescendant', option.id);
        } else {
            this.el.removeAttribute('aria-activedescendant');
        }
    }

    /** A completion into the field, the caret at its end, the focus kept, and the list asked for again. */
    private take(item: Completion): void {
        this.el.value = item.value;
        this.el.focus();
        this.el.setSelectionRange(item.value.length, item.value.length);
        this.query();
    }

    private closeList(): void {
        this.list?.remove();
        this.list = null;
        this.choices = [];
        this.chosen = -1;
        if (this.options.complete) {
            this.el.setAttribute('aria-expanded', 'false');
            this.el.removeAttribute('aria-activedescendant');
        }
    }
}

export interface InlineChoiceOptions {
    /** The values to choose from, with what each is called; `value` among them is chosen at first. */
    choices: readonly { value: string; label: string }[];
    value: string;
    label: string;
    /** A value picked (a click, the arrow keys and `Enter`). The choice is already closed. */
    onCommit(value: string): void;
    onCancel(reason: 'escape' | 'blur'): void;
}

/**
 * The inline field's counterpart for a value out of a list — an admonition's
 * type: a `<select>` in the bar, with the field's contract. Picking a value
 * commits it at once; `Esc` and the focus moving elsewhere in the page cancel.
 */
export class InlineChoice extends InlineControl<HTMLSelectElement> {
    constructor(options: InlineChoiceOptions) {
        const select = document.createElement('select');
        select.className = 'mep-inline-field mep-inline-choice';
        for (const choice of options.choices) {
            const option = document.createElement('option');
            option.value = choice.value;
            option.textContent = choice.label;
            select.append(option);
        }
        select.value = options.value;
        super(select, options.label, options);
        select.addEventListener('change', () => this.finish(select.value, 'escape'));
    }

    focus(): void {
        this.el.focus();
    }
}
