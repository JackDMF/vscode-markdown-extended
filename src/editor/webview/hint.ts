/**
 * The caret hint: a line of text beside the caret for a moment, in the page's
 * status role so a screen reader announces it. One per editor view.
 *
 * Two tones. A **refusal** says why an edit was not applied (`notesPlugin`'s
 * filter); a **neutral** one announces the result of a verb that leaves
 * nothing visible behind but a disappearance ("Note removed — Ctrl+Z", the
 * object toolbar). Both are the same element: one place beside the caret where
 * the page speaks, not two that could stand on each other. A hint that reports
 * a change of the document, with the key that undoes it (`showChangeHint`), is
 * stale at the next change — typing, an undo, a redo — and goes then; every
 * other hint, a refusal said in either tone, stays its time.
 */
import { Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

export type HintTone = 'refusal' | 'neutral';

/** How long a hint stays, by tone: a reason is read, a confirmation glanced at. */
const HINT_MS: Readonly<Record<HintTone, number>> = { refusal: 3500, neutral: 3000 };

class CaretHint {
    private readonly el: HTMLElement;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly view: EditorView) {
        this.el = document.createElement('div');
        this.el.className = 'mep-hint';
        this.el.setAttribute('role', 'status');
        this.el.hidden = true;
        view.dom.parentElement?.append(this.el);
    }

    show(text: string, tone: HintTone, near?: Element, change = false): void {
        const base = (this.el.offsetParent ?? document.body).getBoundingClientRect();
        // Beside the caret, or beside the control that spoke when the focus is in one (a property row).
        const at = near ? near.getBoundingClientRect() : this.view.coordsAtPos(this.view.state.selection.head);
        this.el.textContent = text;
        this.el.dataset.tone = tone;
        this.el.dataset.change = change ? 'true' : 'false';
        this.el.hidden = false;
        this.el.style.left = `${Math.max(0, at.left - base.left)}px`;
        this.el.style.top = `${at.bottom - base.top + 4}px`;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.el.hidden = true;
        }, HINT_MS[tone]);
    }

    /** Hide a hint that reported a change and is showing: the document changed since. */
    staleAfterChange(): void {
        if (!this.el.hidden && this.el.dataset.change === 'true') {
            clearTimeout(this.timer);
            this.el.hidden = true;
        }
    }

    destroy(): void {
        clearTimeout(this.timer);
        this.el.remove();
    }
}

const hints = new WeakMap<EditorView, CaretHint>();

/** Show `text` beside the caret of `view`, or under `near`; a no-op for a view built without `hintPlugin`. */
export function showHint(view: EditorView, text: string, tone: HintTone, near?: Element): void {
    hints.get(view)?.show(text, tone, near);
}

/**
 * Show `text`, which reports a change just made to the document (`Embed is
 * text — Ctrl+Z`), beside the caret of `view`: neutral, and gone at the next
 * change of the document, which makes it stale.
 */
export function showChangeHint(view: EditorView, text: string): void {
    hints.get(view)?.show(text, 'neutral', undefined, true);
}

/** The key that undoes, as the platform names it, for a hint that offers the undo. */
export function undoKey(): string {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd+Z' : 'Ctrl+Z';
}

/** The hint's element for the view, made with the view and removed with it. */
export function hintPlugin(): Plugin {
    return new Plugin({
        view(editorView) {
            const hint = new CaretHint(editorView);
            hints.set(editorView, hint);
            return {
                // Before the plugins after it, whose views may show a hint for this very change.
                update(view, prevState) {
                    if (view.state.doc !== prevState.doc) {
                        hint.staleAfterChange();
                    }
                },
                destroy() {
                    hints.delete(editorView);
                    hint.destroy();
                },
            };
        },
    });
}
