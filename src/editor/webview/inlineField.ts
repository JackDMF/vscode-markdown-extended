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
    /** The field's accessible name, and its placeholder. */
    label: string;
    /** `Enter`: the value as typed. The field is already closed. */
    onCommit(value: string): void;
    /** `Esc`, or the focus leaving the field. The field is already closed. */
    onCancel(reason: 'escape' | 'blur'): void;
}

export class InlineField {
    /** The input; the caller puts it where it belongs, then calls `focus`. */
    readonly el: HTMLInputElement;
    private done = false;
    /** Set while the window is away with the field open: its return gives the field the focus back. */
    private awaitingWindow: (() => void) | null = null;

    constructor(private readonly options: InlineFieldOptions) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'mep-inline-field';
        input.value = options.value;
        input.placeholder = options.label;
        input.setAttribute('aria-label', options.label);
        input.spellcheck = false;
        // Wide enough for the value, within what the stylesheet allows.
        input.size = Math.max(12, Math.min(60, options.value.length + 2));
        input.addEventListener('keydown', e => this.onKey(e));
        input.addEventListener('blur', () => this.onBlur());
        // ProseMirror and the page keep out of the field.
        for (const type of ['mousedown', 'click', 'input', 'paste', 'copy', 'cut', 'keypress', 'keyup']) {
            input.addEventListener(type, e => e.stopPropagation());
        }
        this.el = input;
    }

    /** Take the focus, the value selected. */
    focus(): void {
        this.el.focus();
        this.el.select();
    }

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
     * going away (another application, a VS Code panel): the field stays, and
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

    private finish(value: string | null, reason: 'escape' | 'blur'): void {
        if (this.done) {
            return;
        }
        this.done = true;
        this.stopAwaitingWindow();
        this.el.remove();
        if (value === null) {
            this.options.onCancel(reason);
        } else {
            this.options.onCommit(value);
        }
    }
}
