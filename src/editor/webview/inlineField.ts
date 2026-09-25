/**
 * A one-line input that edits one value in place — a link's URL, an image's
 * source, a note's Markdown — inside the object toolbar, and anywhere else a
 * value is asked for where it is used (a class or an attribute, later).
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

export interface InlineFieldOptions {
    /** What the field starts with, selected, so typing replaces it. */
    value: string;
    /** Where the caret goes instead of selecting the value: `{.}` with the caret after the dot, to type a class. */
    caret?: number;
    /** The field's accessible name, and its placeholder. */
    label: string;
    /** `Enter`: the value as typed. The field is already closed. */
    onCommit(value: string): void;
    /** `Esc`, or the focus leaving the field. The field is already closed. */
    onCancel(reason: 'escape' | 'blur'): void;
}

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
        this.el.remove();
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
        this.el.remove();
        if (value === null) {
            this.callbacks.onCancel(reason);
        } else {
            this.callbacks.onCommit(value);
        }
    }
}

export class InlineField extends InlineControl<HTMLInputElement> {
    constructor(private readonly options: InlineFieldOptions) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mep-inline-field';
        input.value = options.value;
        input.placeholder = options.label;
        input.spellcheck = false;
        // Wide enough for the value, within what the stylesheet allows.
        input.size = Math.max(12, Math.min(60, options.value.length + 2));
        super(input, options.label, options);
    }

    /** Take the focus, the value selected — or the caret where the options put it. */
    focus(): void {
        this.el.focus();
        if (this.options.caret === undefined) {
            this.el.select();
        } else {
            this.el.setSelectionRange(this.options.caret, this.options.caret);
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
