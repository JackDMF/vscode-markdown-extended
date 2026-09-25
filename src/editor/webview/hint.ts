/**
 * The caret hint: a line of text beside the caret for a moment, in the page's
 * status role so a screen reader announces it. One per editor view.
 *
 * Two tones. A **refusal** says why an edit was not applied (`notesPlugin`'s
 * filter); a **neutral** one announces the result of a verb that leaves
 * nothing visible behind but a disappearance ("Note removed — Ctrl+Z", the
 * object toolbar). Both are the same element: one place beside the caret where
 * the page speaks, not two that could stand on each other.
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

    show(text: string, tone: HintTone): void {
        const base = (this.el.offsetParent ?? document.body).getBoundingClientRect();
        const at = this.view.coordsAtPos(this.view.state.selection.head);
        this.el.textContent = text;
        this.el.dataset.tone = tone;
        this.el.hidden = false;
        this.el.style.left = `${Math.max(0, at.left - base.left)}px`;
        this.el.style.top = `${at.bottom - base.top + 4}px`;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.el.hidden = true;
        }, HINT_MS[tone]);
    }

    destroy(): void {
        clearTimeout(this.timer);
        this.el.remove();
    }
}

const hints = new WeakMap<EditorView, CaretHint>();

/** Show `text` beside the caret of `view`; a no-op for a view built without `hintPlugin`. */
export function showHint(view: EditorView, text: string, tone: HintTone): void {
    hints.get(view)?.show(text, tone);
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
                destroy() {
                    hints.delete(editorView);
                    hint.destroy();
                },
            };
        },
    });
}
