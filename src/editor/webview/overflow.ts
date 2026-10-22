/**
 * The one "…" mechanism the formatting row and the object bars share (wave 2,
 * #2, Daniel 2026-10-19): a container that is too narrow never scrolls and
 * never spills; the next control of a priority list leaves it for a "…"
 * menu until the rest fits. The row and a bar each bring their own order
 * (`ROW_OVERFLOW` in `toolbar/actions.ts`, `overflowOrder` in `verbs.ts`) and
 * their own way of hiding a control; the loop, the measurement, the "…"
 * control and its name are here, once.
 *
 * No DOM at module level: the loop and the name are read by the unit suite.
 */

import { lensLabelNodes } from './lenses';
import { describeAs } from './tooltip';

/**
 * Hide the items of `order`, in that order, until `fits()` answers yes.
 * Every item is shown first, so a container grown wide gets back what it had
 * given away. Returns what moved, in `order`'s order.
 */
export function moveUntilFits<T>(order: readonly T[], fits: () => boolean, show: (t: T) => void, hide: (t: T) => void): T[] {
    for (const item of order) {
        show(item);
    }
    const moved: T[] = [];
    for (const item of order) {
        if (fits()) {
            break;
        }
        hide(item);
        moved.push(item);
    }
    return moved;
}

/**
 * The loop all three containers — the row, the bubble, a bar — fit with: "…"
 * is out while everything is shown; where that overflows, "…" comes in and
 * `order`'s items leave until the rest fits; where nothing could leave, "…"
 * goes again. `setMore` draws or removes the "…" control (its group, its
 * face): it is in the container while `order`'s items are measured, and not
 * while all of them are. Returns what moved, in `order`'s order.
 */
export function fitWithMore<T>(
    order: readonly T[],
    overflowing: () => boolean,
    show: (t: T) => void,
    hide: (t: T) => void,
    setMore: (shown: boolean) => void,
): T[] {
    setMore(false);
    for (const item of order) {
        show(item);
    }
    if (!overflowing()) {
        return [];
    }
    // "…" counts from the first measurement that moves anything.
    setMore(true);
    const moved = moveUntilFits(order, () => !overflowing(), show, hide);
    if (moved.length === 0) {
        setMore(false);
    }
    return moved;
}

/** What an entry of a "…" menu is, wherever the menu hangs (the row's, the bubble's, a bar's). */
export interface MoreEntryOptions {
    /** A menu entry, one a check marks (a mark that may be on), or one of a choice. */
    role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
    /** `aria-checked` and the active class, for the roles that have a check. */
    checked?: boolean;
    /** It opens a menu of its own. */
    opens?: boolean;
    /** Why it cannot be chosen: it is drawn disabled and says why. */
    refusal?: string | null;
    /** What the entry says beyond its whole label: its description. Inside "…" the label is whole, so there is no hover. */
    description?: string | null;
}

/**
 * The skeleton of an entry of a "…" menu — the one the row, the bubble and a
 * bar's menu share (their three copies had drifted): a menu item with its
 * role, its check, its refusal and what it is described as. The caller adds
 * what it shows — a glyph, the word, the syntax, a chevron, the keys. It has
 * no floating tooltip: the word is whole in a menu, and what a hover would
 * add goes into `aria-description` (`describeAs`).
 */
export function buildMoreEntry(options: MoreEntryOptions = {}): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mep-menu-item';
    el.tabIndex = -1;
    if (options.opens) {
        el.setAttribute('aria-haspopup', 'menu');
    }
    setMoreEntryState(el, {
        role: options.role ?? 'menuitem',
        checked: options.checked,
        // An entry built with no refusal says nothing of being refused: `aria-disabled` is for the update that follows.
        refusal: options.refusal ? options.refusal : undefined,
        description: options.description,
    });
    return el;
}

/** What an entry of a "…" menu is and shows, to be set again as the state it shows changes (`setMoreEntryState`). */
export interface MoreEntryState extends Pick<MoreEntryOptions, 'role' | 'checked' | 'description'> {
    /** The active class alone, for an entry that has no check (a menu's current type); `checked`, where given, decides it. */
    active?: boolean;
    /** Why it cannot be chosen, `''` when there is nothing to say: drawn disabled. `null` offers it again; `undefined` leaves it as it is. */
    refusal?: string | null;
}

/**
 * The one writer of an entry's role, check, refusal and description — the
 * skeleton `buildMoreEntry` makes and the row's `update` keeps current, so an
 * entry is the same thing at its birth and after. A property that is not given
 * is left as it is; the description is read with the refusal after it, and
 * written only where it changes (`describeAs`).
 */
export function setMoreEntryState(el: HTMLElement, state: MoreEntryState): void {
    if (state.role !== undefined) {
        el.setAttribute('role', state.role);
    }
    if (state.checked !== undefined) {
        el.setAttribute('aria-checked', String(state.checked));
    }
    const active = state.checked ?? state.active;
    if (active !== undefined) {
        el.classList.toggle('mep-active', active);
    }
    if (state.refusal !== undefined) {
        const refused = state.refusal !== null;
        el.classList.toggle('mep-disabled', refused);
        el.setAttribute('aria-disabled', String(refused));
    }
    if (state.refusal !== undefined || state.description !== undefined) {
        const said = [state.description, state.refusal].filter((s): s is string => s !== undefined && s !== null && s !== '').join('\n');
        describeAs(el, said);
    }
}

/**
 * The focus, kept across a fit. A control that is hidden or taken out of its
 * container — a measurement does that to "…" — gives its focus up at once,
 * to the body, and whatever listens for the focus leaving a bubble or a bar
 * hears it there and then. So the focus rests on `holder` (the container,
 * focusable for it) while the fit runs, and is on the control again after,
 * where the control is in the container and shown; where it is not, `holder`
 * keeps it. Call it before the fit; call what it returns after.
 */
export function holdFocus(el: HTMLElement | null, holder?: HTMLElement): () => void {
    const held = el !== null && document.activeElement === el;
    if (held) {
        holder?.focus({ preventScroll: true });
    }
    return () => {
        if (!held || el === null || document.activeElement === el) {
            return;
        }
        const target = el.isConnected && el.closest('[hidden]') === null ? el : holder;
        target?.focus({ preventScroll: true });
    };
}

/** Whether `el`'s content stands past its box, with half a pixel of slack for subpixel widths. */
export function overflows(el: HTMLElement): boolean {
    return el.scrollWidth > el.clientWidth + 0.5;
}

/**
 * The "…" control, `$(ellipsis)` on a toolbar control: in the row a menu face
 * (`mep-tool mep-menu-face mep-more-face`, `data-menu="more"`), on a bar a verb
 * button (`mep-object-verb mep-object-more`). It opens a menu; its name says
 * what it holds (`moreName`). Hidden until something moved into it.
 */
export function moreControl(kind: 'row' | 'bar'): HTMLElement {
    const el = kind === 'row' ? document.createElement('div') : document.createElement('button');
    if (kind === 'row') {
        el.className = 'mep-tool mep-menu-face mep-more-face';
        el.dataset.menu = 'more';
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
    } else {
        (el as HTMLButtonElement).type = 'button';
        // No `data-verb`: it is no verb of the object's, and what lists a bar's verbs leaves it out.
        el.className = 'mep-object-verb mep-object-more';
        el.tabIndex = -1;
    }
    el.setAttribute('aria-haspopup', 'menu');
    el.setAttribute('aria-expanded', 'false');
    el.setAttribute('aria-label', moreName(kind, []));
    const icon = document.createElement('span');
    icon.className = 'mep-face-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.append(...lensLabelNodes('$(ellipsis)'));
    el.append(icon);
    el.hidden = true;
    return el;
}

/**
 * The "…" control's accessible name: what it holds, an item that is on marked
 * so — `More: Formatting, Annotation, Insert, Code (on)` in the row,
 * `More actions: Edit source, Delete table` on a bar.
 */
export function moreName(kind: 'row' | 'bar', names: readonly string[], on: readonly string[] = []): string {
    const head = kind === 'row' ? 'More' : 'More actions';
    return names.length === 0 ? head : `${head}: ${names.map(n => (on.includes(n) ? `${n} (on)` : n)).join(', ')}`;
}
