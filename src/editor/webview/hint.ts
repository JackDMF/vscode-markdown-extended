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
 * stale at the next change — typing, an undo, a redo — and goes then; one that
 * says what an edit did to a paragraph (`showParagraphHint`: an emoji made
 * text) stays while the caret is in that paragraph, until an undo or redo;
 * every other hint, a refusal said in either tone, stays its time. A refusal
 * already showing is not said again: the second is the first.
 */
import { EditorState, Plugin, PluginKey } from 'prosemirror-state';
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

    show(text: string, tone: HintTone, near?: Element, kind: HintKind = 'plain'): void {
        if (tone === 'refusal' && kind === 'plain' && this.showing() && this.el.textContent === text && this.el.dataset.tone === tone) {
            return;
        }
        const base = (this.el.offsetParent ?? document.body).getBoundingClientRect();
        // Beside the caret, or beside the control that spoke when the focus is in one (a property row).
        const at = near ? near.getBoundingClientRect() : this.view.coordsAtPos(this.view.state.selection.head);
        this.el.textContent = text;
        this.el.dataset.tone = tone;
        this.el.dataset.kind = kind;
        this.el.hidden = false;
        this.el.style.left = `${Math.max(0, at.left - base.left)}px`;
        this.el.style.top = `${at.bottom - base.top + 4}px`;
        clearTimeout(this.timer);
        if (kind !== 'paragraph') {
            this.timer = setTimeout(() => {
                this.el.hidden = true;
            }, HINT_MS[tone]);
        }
    }

    /** Whether a hint is showing, and of `kind` where one is given. */
    showing(kind?: HintKind): boolean {
        return !this.el.hidden && (kind === undefined || this.el.dataset.kind === kind);
    }

    hide(): void {
        clearTimeout(this.timer);
        this.el.hidden = true;
    }

    /** Hide a hint that reported a change and is showing: the document changed since. */
    staleAfterChange(): void {
        if (this.showing('change')) {
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

/** How long a hint stays: its time (`plain`), until the next change (`change`), while the caret is in its paragraph (`paragraph`). */
type HintKind = 'plain' | 'change' | 'paragraph';

/** The meta on a transaction whose paragraph a hint is about (`showParagraphHint`): the one its selection is in. */
export const HINT_PARAGRAPH_META = 'mepHintParagraph';

/** prosemirror-history's meta key: an undo or redo ends a paragraph's hint. */
const HISTORY_META = 'history$';

/** Where the paragraph a hint is about stands (before it), followed through the edits; `null` for none. */
const hintKey = new PluginKey<number | null>('mepHint');

/** Before the paragraph `state`'s caret is in: the textblock holding the selection's head. */
function paragraphOf(state: EditorState): number {
    const $head = state.selection.$head;
    return $head.depth === 0 ? -1 : $head.before();
}

/** Show `text` beside the caret of `view`, or under `near`; a no-op for a view built without `hintPlugin`. */
export function showHint(view: EditorView, text: string, tone: HintTone, near?: Element): void {
    hints.get(view)?.show(text, tone, near);
}

/**
 * Show `text`, which reports a change just made to the document (`Embed is
 * text — Ctrl+Z`), beside the caret of `view`: neutral, and gone at the next
 * change of the document, which makes it stale.
 */
export function showChangeHint(view: EditorView, text: string, near?: Element): void {
    hints.get(view)?.show(text, 'neutral', near, 'change');
}

/**
 * Show `text`, which says what the transaction carrying `HINT_PARAGRAPH_META`
 * did to the paragraph the caret is in (`:)Z is no longer an emoji — Ctrl+Z`),
 * beside the caret of `view`: neutral, and there while the caret stays in that
 * paragraph, until an undo or a redo.
 */
export function showParagraphHint(view: EditorView, text: string): void {
    hints.get(view)?.show(text, 'neutral', undefined, 'paragraph');
}

/** The key that undoes, as the platform names it, for a hint that offers the undo. */
export function undoKey(): string {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd+Z' : 'Ctrl+Z';
}

/** The hint's element for the view, made with the view and removed with it. */
export function hintPlugin(): Plugin {
    return new Plugin<number | null>({
        key: hintKey,
        state: {
            init: () => null,
            apply(tr, at, _old, state) {
                if (tr.getMeta(HINT_PARAGRAPH_META) === true) {
                    return paragraphOf(state);
                }
                if (tr.getMeta(HISTORY_META) !== undefined || at === null) {
                    return null;
                }
                return tr.mapping.map(at, -1);
            },
        },
        view(editorView) {
            const hint = new CaretHint(editorView);
            hints.set(editorView, hint);
            return {
                // Before the plugins after it, whose views may show a hint for this very change.
                update(view, prevState) {
                    if (view.state.doc !== prevState.doc) {
                        hint.staleAfterChange();
                    }
                    // A paragraph's hint, once the caret has left that paragraph or an undo or redo ended it.
                    const at = hintKey.getState(view.state);
                    if (hint.showing('paragraph') && (at === null || at !== paragraphOf(view.state))) {
                        hint.hide();
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
