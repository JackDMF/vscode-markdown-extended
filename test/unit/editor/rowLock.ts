import * as assert from 'assert';
import * as puppeteer from 'puppeteer';

/**
 * The formatting row while a control in the text — an open source box, the
 * properties panel — has the focus: what the page says, written here as the
 * person reads it, and the asserts the page suites share.
 */

/** The key the platform names for applying a box (`Ctrl+Enter`, `Cmd+Enter` on macOS); the browser runs on this machine. */
const MOD_NAME = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';

/** The row's reason while a source box or a property's field has the focus. */
export const LOCK_FIELD = `Editing source · ${MOD_NAME}+Enter apply · Esc cancel`;

/** The row's reason while a button of the panel has it — after `Esc` out of the YAML box. */
export const LOCK_BUTTON = 'Focus is outside the text · Esc or click into the text';

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
    assert.deepStrictEqual(state.tools.filter(s => s.title.includes(LOCK_FIELD) || s.title.includes(LOCK_BUTTON)), [], `${when}: no control gives a lock's reason`);
    assert.strictEqual(state.reason, null, `${when}: no reason shown`);
    assert.strictEqual(state.description, null, `${when}: no description`);
    assert.strictEqual(state.tools.find(s => s.id === 'bold')?.disabled, false, `${when}: Bold is offered`);
}
