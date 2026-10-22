/**
 * The one hover the editor's controls show — the formatting row, the bubble
 * and the object bars: an editor hover widget (the workbench's hover colours,
 * the code font for a delimiter or an element, keybinding labels for a key),
 * drawn from a `Tip` (`tips.ts`). It shows once the pointer has rested on a
 * control for `HOVER_DELAY_MS` — the number the language hover waits too — and
 * at once when the keyboard brings the focus there; it never catches the
 * pointer, and it goes on a press, a key, or when the pointer or the focus
 * leaves. No control of the row, the bubble or the bars carries a `title`:
 * the OS tooltip came after the OS's delay, in the OS's font, and could draw
 * neither the code nor the keys.
 *
 * What the hover shows, the control's `aria-description` says (`tipText`),
 * written by the same call: a screen reader hears the refusal a sighted
 * reader sees, and the two cannot drift apart — but for a key the control's
 * `aria-keyshortcuts` names already, which is not said twice.
 */
import { MODIFIER_KEYS } from '../keys';
import { Tip, TipPart, tipText, withoutKeys } from '../tips';
import { HOVER_DELAY_MS } from './hover';
import { placeTip } from './placement';

export const TOOLTIP_CLASS = 'mep-tooltip';

const byMount = new WeakMap<HTMLElement, Tooltips>();

/**
 * `el`'s `aria-description`, written only where it changes (`null` removes it):
 * a menu entry's refusal and the row's controls are described on every update.
 */
export function describeAs(el: HTMLElement, text: string | null): void {
    if (text === null || text === '') {
        if (el.hasAttribute('aria-description')) {
            el.removeAttribute('aria-description');
        }
    } else if (el.getAttribute('aria-description') !== text) {
        el.setAttribute('aria-description', text);
    }
}

export class Tooltips {
    private readonly el: HTMLElement;
    private readonly tips = new WeakMap<HTMLElement, { tip: () => Tip | null; place: TipPlace; described: boolean }>();
    /** The control whose hover is shown. */
    private owner: HTMLElement | null = null;
    /** The control whose rest is being waited for, and the wait. */
    private pending: HTMLElement | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * The pointer came last, not a key — a press, or a move: a focus now is
     * the pointer's (a menu entry taking it under the pointer, `followPointer`)
     * and shows no hover. Any other focus is the keyboard's — Tab, `Alt+Enter`'s
     * first verb — whether or not the browser draws it `:focus-visible` (it
     * does not count a chord).
     */
    private pointerLast = false;
    /** The window lost the focus: the focus it gives back when it returns is no one's move, and shows nothing. */
    private refocusing = false;
    /** The views that hold it (`for`); the last to `release` it takes it down. */
    private holders = 0;
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];

    /** One per mount, shared by the row, the bubble and the bars: each view that takes it releases it (`release`). */
    static for(mount: HTMLElement): Tooltips {
        let tips = byMount.get(mount);
        if (tips === undefined) {
            tips = new Tooltips(mount);
            byMount.set(mount, tips);
        }
        tips.holders++;
        return tips;
    }

    private constructor(private readonly mount: HTMLElement) {
        this.el = document.createElement('div');
        this.el.className = TOOLTIP_CLASS;
        this.el.setAttribute('role', 'tooltip');
        this.el.hidden = true;
        mount.append(this.el);
        // A key acts — the hover would stand over what it changes. On the window and
        // capturing, so a handler that stops the key (Esc on a card, Ctrl+S) still lets it be seen.
        this.listen(window, 'keydown', e => {
            // A modifier alone neither hides the hover nor makes a focus the keyboard's.
            if (!MODIFIER_KEYS.has((e as KeyboardEvent).key)) {
                this.pointerLast = false;
                this.refocusing = false;
                this.hide();
            }
        }, true);
        this.listen(window, 'mousedown', () => {
            this.pointerLast = true;
            this.refocusing = false;
        }, true);
        this.listen(window, 'mousemove', () => {
            this.pointerLast = true;
        }, true);
        // Before any control's own `mouseenter` (a menu entry focused under the pointer, `followPointer`):
        // the browser sends the pointer's arrival ahead of its move, and capturing on the window runs first.
        this.listen(window, 'mouseover', () => {
            this.pointerLast = true;
        }, true);
        // A scroll moves the control: the hover follows it while it is in the window
        // (the row scrolling a control focused by Tab into view), and goes once it is not.
        this.listen(window, 'scroll', () => this.follow(), true);
        this.listen(window, 'blur', () => {
            this.refocusing = true;
            this.hide();
        });
    }

    /**
     * `el` shows `tip()` on a rest and on keyboard focus, and says it as its
     * `aria-description` from now on; `null` is no hover and no description.
     * `place`: under the control, or beside it — a menu's entry, whose hover
     * under it would cover the next entry. `described` false: the hover only,
     * no `aria-description` — for a control whose `aria-label` already says it.
     */
    attach(el: HTMLElement, tip: () => Tip | null, place: TipPlace = 'below', described = true): void {
        const first = !this.tips.has(el);
        this.tips.set(el, { tip, place, described });
        this.describe(el);
        if (!first) {
            return;
        }
        el.addEventListener('mouseenter', () => {
            // The pointer came: a focus it gives now (`followPointer`) is its, not the keyboard's.
            this.pointerLast = true;
            this.cancel();
            this.pending = el;
            this.timer = setTimeout(() => {
                this.pending = null;
                this.timer = undefined;
                this.show(el);
            }, HOVER_DELAY_MS);
        });
        el.addEventListener('mouseleave', () => this.hideFor(el));
        el.addEventListener('mousedown', () => this.hideFor(el));
        el.addEventListener('focus', () => {
            if (!this.pointerLast && !this.refocusing) {
                this.show(el);
            }
        });
        el.addEventListener('blur', () => this.hideFor(el));
    }

    /** Read the tip of an attached element again: its description follows, and a hover it shows is redrawn in place — no other control's wait ends. */
    refresh(el: HTMLElement): void {
        if (!this.tips.has(el)) {
            return;
        }
        this.describe(el);
        if (this.owner === el && !this.el.hidden) {
            const tip = this.tips.get(el)?.tip() ?? null;
            if (tip === null || !this.drawable(el)) {
                this.hideShown();
                return;
            }
            this.el.replaceChildren(...drawTip(tip));
            this.position(el);
        }
    }

    /** Hide the hover — with `within`, only one shown or waited for by a control inside it (a bar going leaves the row's hover be). */
    hide(within?: HTMLElement): void {
        if (within !== undefined) {
            if (this.pending !== null && within.contains(this.pending)) {
                this.cancel();
            }
            if (this.owner === null || !within.contains(this.owner)) {
                return;
            }
        }
        this.cancel();
        this.hideShown();
    }

    /** A view that took it (`for`) is done with it; the last one takes it down. */
    release(): void {
        if (this.holders <= 0) {
            return;
        }
        if (--this.holders > 0) {
            return;
        }
        this.hide();
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.listeners.length = 0;
        this.el.remove();
        byMount.delete(this.mount);
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    private cancel(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.pending = null;
    }

    /** The shown hover goes; a wait for another control does not. */
    private hideShown(): void {
        this.owner = null;
        this.el.hidden = true;
    }

    /** A scroll: the shown hover placed again at its control, which may have moved; gone where the control left the window. */
    private follow(): void {
        const owner = this.owner;
        if (owner === null || this.el.hidden) {
            return;
        }
        const r = owner.getBoundingClientRect();
        if (!this.drawable(owner) || r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
            this.hideShown();
        } else {
            this.position(owner);
        }
    }

    /** `el` lost the pointer or the focus: its wait ends, and its hover goes. */
    private hideFor(el: HTMLElement): void {
        if (this.pending === el) {
            this.cancel();
        }
        if (this.owner === el) {
            this.hideShown();
        }
    }

    private describe(el: HTMLElement): void {
        const entry = this.tips.get(el);
        if (entry?.described === false) {
            return;
        }
        const tip = entry?.tip() ?? null;
        describeAs(el, tip === null ? null : tipText(el.hasAttribute('aria-keyshortcuts') ? withoutKeys(tip) : tip));
    }

    /** Whether `el` can have its hover: it is drawn (not gone, its bar not hidden), and its own menu is not open (the hover would stand over it). */
    private drawable(el: HTMLElement): boolean {
        return el.getClientRects().length > 0 && el.getAttribute('aria-expanded') !== 'true';
    }

    /** The hover for `el`, drawn and placed; any other control's wait ends: one hover at a time. Its own hover goes where it cannot have one now. */
    private show(el: HTMLElement): void {
        this.cancel();
        const tip = this.tips.get(el)?.tip() ?? null;
        if (tip === null || !this.drawable(el)) {
            if (this.owner === el) {
                this.hideShown();
            }
            return;
        }
        if (!this.el.isConnected) {
            this.mount.append(this.el);
        }
        this.el.replaceChildren(...drawTip(tip));
        this.owner = el;
        this.el.hidden = false;
        this.position(el);
    }

    /**
     * The shown hover under `el`, its left edge at the control's — above the
     * control where there is no room below; or, `beside`, right of it at its
     * top, left of it where there is no room right: the one policy
     * (`placement.ts`, `placeTip`), in the window's frame.
     */
    private position(el: HTMLElement): void {
        // Measured at the window's corner: its width is its own, not what room is left where it stood.
        this.el.style.left = '0px';
        this.el.style.top = '0px';
        placeTip(this.el, el, this.tips.get(el)?.place ?? 'below');
    }
}

/** Where a control's hover stands: under it, or beside it. */
export type TipPlace = 'below' | 'beside';

/**
 * One part of a tip drawn: words as text, a `code` part in `<code>`, a key chord spelled as `tipText`
 * spells it (` — Ctrl+I`). The one renderer of a part — the tip's note and the field's aside (a keys
 * line, a refusal's reason, `FieldRow`) draw with it; the tip's own line sets a chord apart as chips instead.
 */
export function partNode(part: TipPart): string | Node {
    if (typeof part === 'string') {
        return part;
    }
    if ('code' in part) {
        const code = document.createElement('code');
        code.textContent = part.code;
        return code;
    }
    return ` — ${part.keys}`;
}

/** A tip's nodes: its words with the code parts in `<code>`, the keys as keybinding labels, the note on a line of its own. */
function drawTip(tip: Tip): Node[] {
    const line = document.createElement('span');
    line.className = 'mep-tip-line';
    const nodes: Node[] = [line];
    for (const part of tip.parts) {
        if (typeof part === 'string' || 'code' in part) {
            line.append(partNode(part));
        } else {
            const keys = document.createElement('span');
            keys.className = 'mep-keys';
            // Spaced as `tipText` spells it; the space at the start of the chip line is not drawn.
            keys.append(' — ');
            part.keys.split('+').forEach((key, i) => {
                if (i > 0) {
                    keys.append('+');
                }
                const chip = document.createElement('span');
                chip.className = 'mep-key';
                chip.textContent = key;
                keys.append(chip);
            });
            nodes.push(keys);
        }
    }
    if (tip.note && tip.note.length > 0) {
        const note = document.createElement('span');
        note.className = 'mep-tip-note';
        if (typeof tip.note === 'string') {
            note.textContent = tip.note;
        } else {
            // A note that names syntax sets it in the code font, as the line does; a key chord is spelled as `tipText` spells it.
            note.append(...tip.note.map(partNode));
        }
        nodes.push(note);
    }
    return nodes;
}
