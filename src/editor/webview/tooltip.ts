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
import { Tip, tipText, withoutKeys } from '../tips';
import { HOVER_DELAY_MS } from './hover';

export const TOOLTIP_CLASS = 'mep-tooltip';

/** Between the control and its hover. */
const GAP = 4;

/** The keys that only modify another: none of them hides the hover, nor makes a focus the keyboard's. */
const MODIFIERS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta']);

const byMount = new WeakMap<HTMLElement, Tooltips>();

export class Tooltips {
    private readonly el: HTMLElement;
    private readonly tips = new WeakMap<HTMLElement, { tip: () => Tip | null; place: TipPlace }>();
    /** The control whose hover is shown. */
    private owner: HTMLElement | null = null;
    /** The control whose rest is being waited for, and the wait. */
    private pending: HTMLElement | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * A pointer press came last, not a key: a focus now is the pointer's (a
     * menu entry taking it under the pointer, `followPointer`) and shows no
     * hover. Any other focus is the keyboard's — Tab, `Alt+Enter`'s first verb
     * — whether or not the browser draws it `:focus-visible` (it does not
     * count a chord).
     */
    private pointerDown = false;
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
        // A key acts — the hover would stand over what it changes. A scroll moves the
        // control: the hover follows it while it is in the window (the row scrolling a
        // control focused by Tab into view), and goes once it is not.
        this.listen(document, 'keydown', e => {
            if (!MODIFIERS.has((e as KeyboardEvent).key)) {
                this.pointerDown = false;
                this.hide();
            }
        }, true);
        this.listen(document, 'mousedown', () => {
            this.pointerDown = true;
        }, true);
        this.listen(window, 'scroll', () => this.follow(), true);
        this.listen(window, 'blur', () => this.hide());
    }

    /**
     * `el` shows `tip()` on a rest and on keyboard focus, and says it as its
     * `aria-description` from now on; `null` is no hover and no description.
     * `place`: under the control, or beside it — a menu's entry, whose hover
     * under it would cover the next entry.
     */
    attach(el: HTMLElement, tip: () => Tip | null, place: TipPlace = 'below'): void {
        const first = !this.tips.has(el);
        this.tips.set(el, { tip, place });
        this.describe(el);
        if (!first) {
            return;
        }
        el.addEventListener('mouseenter', () => {
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
            if (!this.pointerDown) {
                this.show(el);
            }
        });
        el.addEventListener('blur', () => this.hideFor(el));
    }

    /** Read the tip of an attached element again: its description follows, and a hover it shows is redrawn. */
    refresh(el: HTMLElement): void {
        if (!this.tips.has(el)) {
            return;
        }
        this.describe(el);
        if (this.owner === el && !this.el.hidden) {
            this.show(el);
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
        this.owner = null;
        this.el.hidden = true;
    }

    /** A view that took it (`for`) is done with it; the last one takes it down. */
    release(): void {
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

    private follow(): void {
        const owner = this.owner;
        if (owner === null || this.el.hidden) {
            return;
        }
        const r = owner.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) {
            this.hide();
        } else {
            this.show(owner);
        }
    }

    /** `el` lost the pointer or the focus: its wait ends, and its hover goes. */
    private hideFor(el: HTMLElement): void {
        if (this.pending === el) {
            this.cancel();
        }
        if (this.owner === el) {
            this.hide();
        }
    }

    private describe(el: HTMLElement): void {
        const tip = this.tips.get(el)?.tip() ?? null;
        if (tip === null) {
            el.removeAttribute('aria-description');
        } else {
            el.setAttribute('aria-description', tipText(el.hasAttribute('aria-keyshortcuts') ? withoutKeys(tip) : tip));
        }
    }

    /**
     * The hover under `el`, its left edge at the control's, kept inside the
     * window — above the control where there is no room below; or, `beside`,
     * right of it at its top, left of it where there is no room right. Not
     * while the control's own menu is open (it would stand over the menu) or
     * the control is not drawn (gone, or its bar hidden). Any other control's
     * wait ends: one hover at a time.
     */
    private show(el: HTMLElement): void {
        this.cancel();
        const attached = this.tips.get(el);
        const tip = attached?.tip() ?? null;
        if (attached === undefined || tip === null || el.getClientRects().length === 0 || el.getAttribute('aria-expanded') === 'true') {
            return;
        }
        if (!this.el.isConnected) {
            this.mount.append(this.el);
        }
        this.el.replaceChildren(...drawTip(tip));
        this.owner = el;
        this.el.hidden = false;
        this.el.style.left = '0px';
        this.el.style.top = '0px';
        const r = el.getBoundingClientRect();
        const width = this.el.offsetWidth;
        const height = this.el.offsetHeight;
        let left: number;
        let top: number;
        if (attached.place === 'beside') {
            left = r.right + GAP + width <= window.innerWidth ? r.right + GAP : r.left - GAP - width;
            top = r.top;
        } else {
            const below = r.bottom + GAP;
            left = r.left;
            top = below + height <= window.innerHeight ? below : r.top - GAP - height;
        }
        this.el.style.left = `${Math.max(0, Math.min(left, window.innerWidth - width))}px`;
        this.el.style.top = `${Math.max(0, Math.min(top, window.innerHeight - height))}px`;
    }
}

/** Where a control's hover stands: under it, or beside it. */
export type TipPlace = 'below' | 'beside';

/** A tip's nodes: its words with the code parts in `<code>`, the keys as keybinding labels, the note on a line of its own. */
function drawTip(tip: Tip): Node[] {
    const line = document.createElement('span');
    line.className = 'mep-tip-line';
    const nodes: Node[] = [line];
    for (const part of tip.parts) {
        if (typeof part === 'string') {
            line.append(part);
        } else if ('code' in part) {
            const code = document.createElement('code');
            code.textContent = part.code;
            line.append(code);
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
    if (tip.note) {
        const note = document.createElement('span');
        note.className = 'mep-tip-note';
        note.textContent = tip.note;
        nodes.push(note);
    }
    return nodes;
}
