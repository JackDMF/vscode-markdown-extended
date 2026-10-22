/**
 * The page's hint: a line of text for a moment beside what it is about, and
 * one status region that says it to a screen reader. One per editor view.
 *
 * Two tones. A **refusal** says why something was not done, then what to do
 * (#10): one component — the hover widget's surface, an amber bar, the
 * message with its values in muted mono — in three placements: at the caret
 * (or at an element there: a property row, a selected block), at a pressed
 * control (a row tool, a bar's verb: under the row or the bar), at a pressed
 * menu entry (beside the menu). The fourth placement, in a field, is the
 * field's own line (`fieldRow.ts`), drawn with the same bar. A refusal goes
 * at the next caret move, press, focus elsewhere, mode change or document
 * from the host — whatever comes first after the gesture that caused it (it
 * is *armed* one frame later) — else after its time, which grows with its
 * length (`refusalMs`). The same refusal again is placed and timed anew and
 * said again, unless it is a repeat at the same place within a second (a
 * held key).
 *
 * A **neutral** hint announces the result of a verb that leaves nothing
 * visible behind but a disappearance ("Note deleted — Ctrl+Z"). A hint that
 * reports a change of the document, with the key that undoes it
 * (`showChangeHint`), is stale at the next change and goes then; one that says
 * what an edit did to a paragraph (`showParagraphHint`) stays while the caret
 * is in that paragraph, until an undo or redo; any other neutral hint stays
 * its time.
 *
 * The drawn hint is `aria-hidden`: what is heard is the persistent, visually
 * hidden `.mep-live` region, emptied and set again on the next frame so a
 * repeat is announced too.
 */
import { EditorState, NodeSelection, Plugin, PluginKey, Selection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { UNDO_BINDING, keyLabel } from '../keys';
import { REANNOUNCE_GAP_MS, refusalMs } from '../refusal';
import { Said, saidParts, saidText } from '../tips';
import { placeOfElement } from './focusPlace';
import { Placement, Rect, VIEWPORT, caretRect, placeAtControl, placeAtEntry, placeLayer, readFrame } from './placement';
import { partNode } from './tooltip';

export type HintTone = 'refusal' | 'neutral';

/** How long a neutral hint stays: a confirmation is glanced at. A refusal's time is `refusalMs`. */
const NEUTRAL_MS = 3000;

/** Where a refusal stands: at the caret (or at `near` there), under a pressed control, beside a pressed menu entry. */
export type RefusalPlace =
    | { at: 'caret'; near?: Element }
    | { at: 'control'; el: HTMLElement }
    | { at: 'menu-entry'; el: HTMLElement; menu: HTMLElement };

/** The surfaces a control stands on; the row and the menus are `position: fixed`, the bubble and the bars stand in the mount. */
const SURFACES = '.mep-toolbar, .mep-bubble, .mep-object-toolbar, .mep-menu';
const FIXED_SURFACES = '.mep-toolbar, .mep-menu';

function rectOf(r: DOMRect): Rect {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

class CaretHint {
    private readonly el: HTMLElement;
    private readonly live: HTMLElement;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private sayFrame = 0;
    private armFrame = 0;
    /** Whether the hint showing is a refusal: only a refusal is ended by the dismiss rule. */
    private refusal = false;
    /** Whether the refusal showing may be ended: from the frame after it was shown. */
    private armed = false;
    /** The selection the refusal showing was made at; a different one ends it. */
    private shownSel: Selection | null = null;
    /** The control or entry the refusal showing stands at, for `dismissRefusal(view, within)`. */
    private anchorEl: Element | null = null;
    /** The last announcement: what, where, when — a repeat within `REANNOUNCE_GAP_MS` at the same place is not said again. */
    private lastSaid: { text: string; x: number; y: number; time: number } | null = null;
    private readonly listeners: [EventTarget, string, EventListener][] = [];

    constructor(private readonly view: EditorView) {
        this.el = document.createElement('div');
        this.el.className = 'mep-hint';
        this.el.setAttribute('aria-hidden', 'true');
        this.el.hidden = true;
        this.live = document.createElement('div');
        this.live.className = 'mep-live';
        this.live.setAttribute('role', 'status');
        this.live.setAttribute('aria-live', 'polite');
        this.live.setAttribute('aria-atomic', 'true');
        const mount = view.dom.parentElement;
        mount?.append(this.el, this.live);
        // Each returns at once unless an armed refusal shows: nothing per keystroke.
        this.listen(document, 'pointerdown', () => {
            if (this.armedRefusal()) {
                this.dismiss();
            }
        });
        this.listen(document, 'focusin', e => {
            if (this.armedRefusal() && e.target !== this.view.dom) {
                this.dismiss();
            }
        });
        this.listen(document, 'focusout', e => {
            if (this.armedRefusal() && e.target instanceof Element && placeOfElement(this.view, e.target).kind === 'control') {
                this.dismiss();
            }
        });
        this.listen(window, 'resize', () => {
            if (this.refusal && this.showing() && this.el.hasAttribute('data-fixed')) {
                this.dismiss();
            }
        });
    }

    private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
        target.addEventListener(type, fn, true);
        this.listeners.push([target, type, fn]);
    }

    private armedRefusal(): boolean {
        return this.refusal && this.armed && !this.el.hidden;
    }

    /** A neutral hint (`kind` its lifetime) at the caret, or under `near`. */
    show(text: Said, tone: HintTone, near?: Element, kind: HintKind = 'plain'): void {
        if (tone === 'refusal') {
            this.refuse(text, { at: 'caret', near });
            return;
        }
        this.render(text, 'neutral', kind);
        const p = this.placeCaret(near);
        this.endRefusal();
        this.announce(saidText(text), p);
        clearTimeout(this.timer);
        if (kind !== 'paragraph') {
            this.timer = setTimeout(() => this.hide(), NEUTRAL_MS);
        }
    }

    /** A refusal at `place`: drawn, placed, timed, armed on the next frame, and said unless it repeats itself at once. */
    refuse(message: Said, place: RefusalPlace): void {
        const text = saidText(message);
        this.render(message, 'refusal', 'plain');
        let p: Placement | null;
        if (place.at === 'caret') {
            p = this.placeCaret(place.near);
            this.anchorEl = place.near ?? null;
        } else {
            p = this.placeAt(place);
            this.anchorEl = place.el;
        }
        this.refusal = true;
        this.armed = false;
        this.shownSel = this.view.state.selection;
        cancelAnimationFrame(this.armFrame);
        this.armFrame = requestAnimationFrame(() => {
            this.armed = true;
        });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.hide(), refusalMs(text));
        this.announce(text, p);
    }

    private render(message: Said, tone: HintTone, kind: HintKind): void {
        this.el.replaceChildren(...saidParts(message).map(partNode));
        this.el.dataset.tone = tone;
        this.el.dataset.kind = kind;
        this.el.hidden = false;
    }

    /** At the caret's line — a selected node's box for a node selection — or under `near`: placed as a layer, under the line, else above it, off every open layer. */
    private placeCaret(near?: Element): Placement | null {
        this.el.dataset.at = 'caret';
        this.el.removeAttribute('data-fixed');
        const mount = this.el.parentElement;
        if (mount === null) {
            return null;
        }
        let at: Rect;
        const sel = this.view.state.selection;
        if (near) {
            at = rectOf(near.getBoundingClientRect());
        } else if (sel instanceof NodeSelection && this.view.nodeDOM(sel.from) instanceof Element) {
            at = rectOf((this.view.nodeDOM(sel.from) as Element).getBoundingClientRect());
        } else {
            at = caretRect(this.view, sel.head);
        }
        // Measured at the mount's left edge: its width is its text's, not the room left where it stood.
        this.el.style.left = '0px';
        this.el.style.top = '0px';
        const p = placeLayer(this.el, at, { view: this.view, mount, space: 'mount', caret: near === undefined });
        this.el.toggleAttribute('data-flipped', p.side === 'above');
        return p;
    }

    /** Under a pressed control (in the row's coordinates where the row is fixed), or beside a pressed menu entry. */
    private placeAt(place: Exclude<RefusalPlace, { at: 'caret' }>): Placement | null {
        const mount = this.el.parentElement;
        if (mount === null) {
            return null;
        }
        this.el.dataset.at = place.at;
        this.el.removeAttribute('data-flipped');
        const surface = place.at === 'menu-entry' ? place.menu : place.el.closest(SURFACES) ?? place.el;
        const fixed = place.at === 'menu-entry' || surface.matches(FIXED_SURFACES);
        this.el.toggleAttribute('data-fixed', fixed);
        this.el.style.left = '0px';
        this.el.style.top = '0px';
        const size = { width: this.el.offsetWidth, height: this.el.offsetHeight };
        const control = rectOf(place.el.getBoundingClientRect());
        const p = place.at === 'menu-entry'
            ? placeAtEntry(size, rectOf(place.menu.getBoundingClientRect()), control, VIEWPORT())
            : placeAtControl(size, control, rectOf(surface.getBoundingClientRect()), fixed ? VIEWPORT() : readFrame(mount));
        const base = fixed ? { left: 0, top: 0 } : mount.getBoundingClientRect();
        this.el.style.left = `${p.x - base.left}px`;
        this.el.style.top = `${p.y - base.top}px`;
        return p;
    }

    /** Say `text` in the live region: emptied now, set on the next frame, so the same words are announced again. */
    private announce(text: string, p: Placement | null): void {
        const x = Math.round(p?.x ?? 0);
        const y = Math.round(p?.y ?? 0);
        const now = performance.now();
        const last = this.lastSaid;
        if (last !== null && last.text === text && last.x === x && last.y === y && now - last.time < REANNOUNCE_GAP_MS) {
            return;
        }
        this.lastSaid = { text, x, y, time: now };
        this.say(text);
    }

    /** The live region only: emptied now, `text` set on the next frame. */
    say(text: string): void {
        this.live.textContent = '';
        cancelAnimationFrame(this.sayFrame);
        this.sayFrame = requestAnimationFrame(() => {
            this.live.textContent = text;
        });
    }

    /** Whether a hint is showing, and of `kind` where one is given. */
    showing(kind?: HintKind): boolean {
        return !this.el.hidden && (kind === undefined || this.el.dataset.kind === kind);
    }

    /** Whether a refusal is showing. */
    showingRefusal(): boolean {
        return this.refusal && !this.el.hidden;
    }

    hide(): void {
        clearTimeout(this.timer);
        this.el.hidden = true;
        // What is said next is said, whatever was said last: the repeat guard is for a hint still showing (a held key).
        this.lastSaid = null;
        this.endRefusal();
    }

    /** End the refusal showing: hidden, its time and its pending announcement cancelled. */
    dismiss(within?: Element): void {
        if (!this.showingRefusal() || (within !== undefined && !(this.anchorEl !== null && within.contains(this.anchorEl)))) {
            return;
        }
        cancelAnimationFrame(this.sayFrame);
        this.hide();
    }

    private endRefusal(): void {
        this.refusal = false;
        this.armed = false;
        this.shownSel = null;
        this.anchorEl = null;
        cancelAnimationFrame(this.armFrame);
    }

    /** The plugin's per-transaction look: until armed the refusal follows the selection; armed, a different selection ends it. O(1). */
    selectionChanged(state: EditorState): void {
        if (!this.showingRefusal()) {
            return;
        }
        if (!this.armed) {
            this.shownSel = state.selection;
        } else if (this.shownSel !== null && !state.selection.eq(this.shownSel)) {
            this.dismiss();
        }
    }

    /** Hide a hint that reported a change and is showing: the document changed since. */
    staleAfterChange(): void {
        if (this.showing('change')) {
            this.hide();
        }
    }

    /** Hide a hint that stands above the caret's line (`data-flipped`): the document changed since. */
    hideFlipped(): void {
        if (this.showing() && this.el.hasAttribute('data-flipped')) {
            this.hide();
        }
    }

    destroy(): void {
        clearTimeout(this.timer);
        cancelAnimationFrame(this.sayFrame);
        cancelAnimationFrame(this.armFrame);
        for (const [target, type, fn] of this.listeners) {
            target.removeEventListener(type, fn, true);
        }
        this.el.remove();
        this.live.remove();
    }
}

const hints = new WeakMap<EditorView, CaretHint>();

/** How long a hint stays: its time (`plain`), until the next change (`change`), while the caret is in its paragraph (`paragraph`). A refusal is always `plain`. */
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

/** Show a refusal `message` at `place` (the caret unless given); a no-op for a view built without `hintPlugin`. */
export function showRefusal(view: EditorView, message: Said, place: RefusalPlace = { at: 'caret' }): void {
    hints.get(view)?.refuse(message, place);
}

/** End the refusal showing in `view` — any, or only one standing at an element inside `within` (a menu closing). */
export function dismissRefusal(view: EditorView, within?: Element): void {
    hints.get(view)?.dismiss(within);
}

/** Say `text` to a screen reader only, through the live region, drawn nowhere: what the page already shows is not shown twice. */
export function announceHint(view: EditorView, text: string): void {
    hints.get(view)?.say(text);
}

/** Show `text` beside the caret of `view`, or under `near`; a refusal is `showRefusal` at the caret. A no-op for a view built without `hintPlugin`. */
export function showHint(view: EditorView, text: Said, tone: HintTone, near?: Element): void {
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

/** Whether the platform names the editing modifier Cmd (macOS), not Ctrl. */
export function macKeys(): boolean {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** The key that undoes — the page keymap's own binding (`keys.ts`) — as the platform names it, for a hint that offers the undo. */
export function undoKey(): string {
    return keyLabel(UNDO_BINDING, macKeys());
}

/**
 * The one pattern of a hint that reports a change and offers its undo:
 * "<Object> <past participle> — <undo key>" (`Image deleted — Ctrl+Z`).
 */
export function undoHint(done: string): string {
    return `${done} — ${undoKey()}`;
}

/** The key that applies a source box, as the platform names it. */
export function applyKey(): string {
    return macKeys() ? 'Cmd+Enter' : 'Ctrl+Enter';
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
                    // A refusal ends at the next caret move once armed (O(1): `Selection.eq`).
                    hint.selectionChanged(view.state);
                    if (view.state.doc !== prevState.doc) {
                        hint.staleAfterChange();
                        // A hint flipped above the caret's line stands over the text being typed: the next change takes it away.
                        hint.hideFlipped();
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
