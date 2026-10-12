import * as assert from 'assert';
import * as puppeteer from 'puppeteer';

/**
 * The formatting row while a control in the text — an open source box, the
 * properties panel — has the focus: what the page says, written here as the
 * person reads it, and the asserts the page suites share.
 */

/** The key the platform names for applying a box (`Ctrl+Enter`, `Cmd+Enter` on macOS); the browser runs on this machine. */
export const MOD_NAME = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

/** The row's reason while a source box — a raw block's, the YAML of the properties — has the focus. */
export const LOCK_SOURCE = `Editing source · ${MOD_NAME}+Enter apply · Esc cancel`;

/** The row's reason while a property's own field (a value, a new name) has it. */
export const LOCK_PROPERTY = 'Editing a property · Enter apply · Esc cancel';

/** The row's reason while a button of the panel has it — after `Esc` out of the YAML box. */
export const LOCK_BUTTON = 'Focus is outside the text · Esc or click into the text';

const REASONS = [LOCK_SOURCE, LOCK_PROPERTY, LOCK_BUTTON];

/** Each control of the formatting row: whether it is refused, and its tooltip; the reason shown, and the row's description. */
export function rowState(page: puppeteer.Page) {
    return page.$eval('.mep-toolbar', row => ({
        tools: Array.from(row.querySelectorAll('[aria-disabled]')).map(el => ({
            id: (el as HTMLElement).dataset.action ?? (el as HTMLElement).dataset.menu ?? el.className,
            disabled: el.getAttribute('aria-disabled') === 'true',
            title: (el as HTMLElement).title,
        })),
        reason: (() => {
            const lock = row.querySelector('.mep-row-lock') as HTMLElement | null;
            return lock && !lock.hidden && lock.getBoundingClientRect().width > 0 ? lock.textContent : null;
        })(),
        description: row.getAttribute('aria-description'),
    }));
}

/** Every control of the row refused, each saying `reason`, and the row showing it at its end. */
export async function assertRowLocked(page: puppeteer.Page, when: string, reason: string): Promise<void> {
    const state = await rowState(page);
    assert.ok(state.tools.length > 0, 'the row has controls');
    assert.deepStrictEqual(state.tools.filter(s => !s.disabled || !s.title.endsWith(`\n${reason}`)), [], `${when}: every control of the row refused with the reason`);
    assert.strictEqual(state.reason, reason, `${when}: the row shows the reason`);
    assert.strictEqual(state.description, reason, `${when}: and describes itself with it`);
}

/** The row offered again: no reason shown, Bold enabled. */
export async function assertRowFree(page: puppeteer.Page, when: string): Promise<void> {
    const state = await rowState(page);
    assert.deepStrictEqual(state.tools.filter(s => REASONS.some(r => s.title.includes(r))), [], `${when}: no control gives a lock's reason`);
    assert.strictEqual(state.reason, null, `${when}: no reason shown`);
    assert.strictEqual(state.description, null, `${when}: no description`);
    assert.strictEqual(state.tools.find(s => s.id === 'bold')?.disabled, false, `${when}: Bold is offered`);
}

/**
 * Where the shown reason stands: `beside` the tools in the row, where it fits
 * there, or `below` them on a line of its own under the row. Either way it is
 * shown whole (cut with an ellipsis only where even its own line is too
 * narrow), it covers no tool, and the tools and the diagnostics count stand
 * where they stood before the lock (`before`, from `rowBoxes`).
 */
export async function assertReasonShown(page: puppeteer.Page, when: string, where: 'beside' | 'below', before?: RowBoxes): Promise<void> {
    const layout = await reasonLayout(page);
    assert.ok(layout.lock.width > 0 && layout.lock.height > 0, `${when}: the reason is shown`);
    assert.ok(layout.whole || layout.ellipsis, `${when}: the reason is whole, or cut with an ellipsis`);
    if (where === 'below') {
        assert.ok(layout.lock.top >= layout.row.bottom - 0.5, `${when}: the reason is on its own line under the row (${layout.lock.top} < ${layout.row.bottom})`);
        assert.ok(layout.whole || layout.lock.width >= layout.viewport - 32, `${when}: cut only where its own line is too narrow`);
    } else {
        assert.ok(layout.lock.top < layout.row.bottom && layout.lock.bottom <= layout.row.bottom + 0.5, `${when}: the reason is in the row, beside the tools`);
        assert.ok(layout.whole, `${when}: and whole there`);
    }
    const covered = layout.boxes.tools.filter(t => t.left < layout.lock.right && t.right > layout.lock.left && t.top < layout.lock.bottom && t.bottom > layout.lock.top);
    assert.deepStrictEqual(covered.map(t => t.id), [], `${when}: the reason covers no tool`);
    if (layout.countFull !== null) {
        assert.ok(layout.countFull, `${when}: the diagnostics count stays whole`);
    }
    if (before) {
        assert.deepStrictEqual(layout.boxes, before, `${when}: the tools and the count did not move`);
    }
}

export interface Box {
    id: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** The row's tools, and its diagnostics count, where they stand. */
export interface RowBoxes {
    tools: Box[];
    count: Box | null;
}

/** Where the row's tools and count stand now, to compare with them under a lock. */
export async function rowBoxes(page: puppeteer.Page): Promise<RowBoxes> {
    return (await reasonLayout(page)).boxes;
}

function reasonLayout(page: puppeteer.Page) {
    return page.$eval('.mep-toolbar', row => {
        const box = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        const place = (el: Element, id: string) => {
            const b = box(el);
            return { id, left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        };
        const lock = row.querySelector('.mep-row-lock') as HTMLElement;
        const style = getComputedStyle(lock);
        const view = box(row);
        const tools = Array.from(row.querySelectorAll('.mep-tool'))
            .map(el => place(el, (el as HTMLElement).dataset.action ?? (el as HTMLElement).dataset.menu ?? ''))
            .filter(t => t.right > view.left && t.left < view.right);
        const count = row.querySelector('.mep-diag-count:not([hidden])') as HTMLElement | null;
        return {
            row: view,
            viewport: window.innerWidth,
            lock: box(lock),
            whole: lock.scrollWidth <= lock.clientWidth + 1,
            ellipsis: style.textOverflow === 'ellipsis' && style.overflow === 'hidden',
            boxes: { tools, count: count ? place(count, 'count') : null },
            countFull: count ? count.scrollWidth <= count.clientWidth + 1 && count.getBoundingClientRect().width > 0 : null,
        };
    });
}
