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
 * At whatever width: the shown reason covers no tool of the row, is cut with
 * an ellipsis where it does not fit, and leaves the diagnostics count, when
 * there is one, whole and uncovered beside it.
 */
export async function assertReasonFits(page: puppeteer.Page, when: string): Promise<void> {
    const layout = await page.$eval('.mep-toolbar', row => {
        const box = (el: Element) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
        };
        const lock = row.querySelector('.mep-row-lock') as HTMLElement;
        const style = getComputedStyle(lock);
        const view = box(row);
        const tools = Array.from(row.querySelectorAll('.mep-tool'))
            .map(el => ({ id: (el as HTMLElement).dataset.action ?? (el as HTMLElement).dataset.menu ?? '', ...box(el) }))
            .filter(t => t.right > view.left && t.left < view.right);
        const count = row.querySelector('.mep-diag-count:not([hidden])');
        return {
            lock: box(lock),
            ellipsis: style.textOverflow === 'ellipsis' && style.overflow === 'hidden',
            tools,
            count: count ? { ...box(count), full: (count as HTMLElement).scrollWidth <= (count as HTMLElement).clientWidth + 1 } : null,
        };
    });
    assert.ok(layout.ellipsis, `${when}: a reason that does not fit is cut with an ellipsis`);
    if (layout.lock.width > 0) {
        const covered = layout.tools.filter(t => t.left < layout.lock.right && t.right > layout.lock.left);
        assert.deepStrictEqual(covered.map(t => t.id), [], `${when}: the reason covers no tool`);
    }
    if (layout.count) {
        assert.ok(layout.count.width > 0 && layout.count.full, `${when}: the diagnostics count stays whole`);
        assert.ok(layout.lock.width === 0 || layout.lock.right <= layout.count.left + 0.5, `${when}: the reason stops before the count`);
    }
}
