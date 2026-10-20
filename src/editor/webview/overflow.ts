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
