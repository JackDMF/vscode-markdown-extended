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

/** Export's tooltip under each lock: what pressing it then takes of the open control, as a save does. */
const EXPORT_TITLE: Record<string, string> = {
    [LOCK_SOURCE]: 'Export\nApplies the open source box first',
    [LOCK_PROPERTY]: 'Export\nApplies the values typed first; a property not yet added with Enter is left out',
    [LOCK_BUTTON]: 'Export',
};

/** Each control of the formatting row: whether it is refused, and its tooltip; the reason shown, and the row's description. */
export function rowState(page: puppeteer.Page) {
    return page.$eval('.mep-toolbar', row => ({
        tools: Array.from(row.querySelectorAll('[aria-disabled]')).map(el => ({
            id: (el as HTMLElement).dataset.action ?? (el as HTMLElement).dataset.menu ?? el.className,
            disabled: el.getAttribute('aria-disabled') === 'true',
            title: (el.getAttribute('aria-description') ?? ''),
            // What it acts on (`RowScope`): only Export says, the whole document.
            document: (el as HTMLElement).dataset.scope === 'document',
        })),
        reason: (() => {
            const lock = row.querySelector('.mep-row-lock') as HTMLElement | null;
            return lock && !lock.hidden && lock.getBoundingClientRect().width > 0 ? lock.textContent : null;
        })(),
        description: row.getAttribute('aria-description'),
    }));
}

/**
 * Every control of the row that acts on the selection refused, each saying
 * `reason`, and the row showing it at its end; Export, which acts on the whole
 * document, offered still, its tooltip noting what it takes of the open control.
 * At a width where the whole reason stands in the row (`assertReasonShown` for the narrow ones).
 */
export async function assertRowLocked(page: puppeteer.Page, when: string, reason: string): Promise<void> {
    const state = await rowState(page);
    const selection = state.tools.filter(s => !s.document);
    assert.ok(selection.length > 0, 'the row has controls');
    assert.deepStrictEqual(selection.filter(s => !s.disabled || !s.title.endsWith(`\n${reason}`)), [], `${when}: every control of the row refused with the reason`);
    assert.deepStrictEqual(state.tools.filter(s => s.document).map(s => ({ id: s.id, disabled: s.disabled, title: s.title })), [
        { id: 'export', disabled: false, title: EXPORT_TITLE[reason] },
    ], `${when}: Export is offered, saying what it takes of the open control`);
    assert.strictEqual(state.reason, reason, `${when}: the row shows the whole reason (a wide row)`);
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

/** Each reason's short form (`lockForms`): what the row shows where the whole reason does not fit — never without its keys. */
export const LOCK_SHORT: Record<string, string> = {
    [LOCK_SOURCE]: `Source · ${MOD_NAME}+Enter · Esc`,
    [LOCK_PROPERTY]: 'Property · Enter · Esc',
    [LOCK_BUTTON]: 'Outside the text',
};

/**
 * Where the reason stands (wave 2 #2; it is never under the row, and the page
 * never moves): `beside` the tools, whole; `inrow`, whole, in the refused
 * tools' place (they give way); `short`, its short form, whole — in their
 * place for a box or a field, beside them for a button; `hidden`, a button's
 * lock with no room: the tools only dim.
 */
export type ReasonPlace = 'beside' | 'inrow' | 'short' | 'hidden';

/**
 * The reason shown as `where` says, the row describing itself with the whole
 * of it, nothing under the row and the row not scrolled; and Export and the
 * diagnostics count where they stood before the lock (`before`, from `rowBoxes`).
 */
export async function assertReasonShown(page: puppeteer.Page, when: string, reason: string, where: ReasonPlace, before?: RowBoxes): Promise<void> {
    const layout = await reasonLayout(page);
    assert.strictEqual(layout.description, reason, `${when}: the row describes itself with the whole reason`);
    assert.strictEqual(layout.scrolls, false, `${when}: the row does not scroll`);
    if (where === 'hidden') {
        assert.strictEqual(layout.shown, false, `${when}: no note`);
        assert.strictEqual(layout.inrow, false, `${when}: the tools stay, dimmed`);
    } else {
        assert.ok(layout.shown && layout.lock.width > 0, `${when}: the reason is shown`);
        assert.strictEqual(layout.text, where === 'short' ? LOCK_SHORT[reason] : reason, `${when}: the form shown`);
        assert.ok(layout.whole, `${when}: whole, never cut`);
        assert.ok(layout.lock.top >= layout.row.top - 0.5 && layout.lock.bottom <= layout.row.bottom + 0.5, `${when}: in the row, nothing under it`);
        const inrow = where === 'inrow' || (where === 'short' && reason !== LOCK_BUTTON);
        assert.strictEqual(layout.inrow, inrow, `${when}: ${inrow ? 'in the refused tools\' place' : 'beside the tools'}`);
        if (!inrow) {
            const covered = layout.tools.filter(t => t.left < layout.lock.right && t.right > layout.lock.left);
            assert.deepStrictEqual(covered.map(t => t.id), [], `${when}: the reason covers no tool`);
        } else {
            assert.deepStrictEqual(layout.tools.map(t => t.id), ['export'], `${when}: the selection's tools gave way, Export stays`);
        }
    }
    if (layout.countFull !== null) {
        assert.ok(layout.countFull, `${when}: the diagnostics count stays whole`);
    }
    if (before) {
        assert.deepStrictEqual(layout.boxes, before, `${when}: Export and the count did not move`);
    }
}

export interface Box {
    id: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/** What the lock never moves: Export, and the diagnostics count. */
export interface RowBoxes {
    export: Box;
    count: Box | null;
}

/** Where Export and the count stand now, to compare with them under a lock. */
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
        const count = row.querySelector('.mep-diag-count:not([hidden])') as HTMLElement | null;
        const exportFace = row.querySelector('.mep-menu-face[data-menu="export"]') as HTMLElement;
        return {
            row: box(row),
            lock: box(lock),
            shown: !lock.hidden && lock.getClientRects().length > 0,
            text: lock.textContent,
            whole: lock.scrollWidth <= lock.clientWidth + 1,
            inrow: row.classList.contains('mep-row-lock-inrow'),
            scrolls: row.scrollWidth > row.clientWidth,
            description: row.getAttribute('aria-description'),
            tools: Array.from(row.querySelectorAll<HTMLElement>('.mep-tool')).filter(el => el.getClientRects().length > 0)
                .map(el => place(el, el.dataset.action ?? el.dataset.menu ?? '')),
            boxes: { export: place(exportFace, 'export'), count: count ? place(count, 'count') : null },
            countFull: count ? count.scrollWidth <= count.clientWidth + 1 && count.getBoundingClientRect().width > 0 : null,
        };
    });
}

/*
 * Where the row has room for which form depends on the platform's font (Segoe UI on
 * Windows, the system font on macOS: ten pixels and more apart at 400 px). The row is
 * measured, not set by a width (`layoutRow`), and so are the suites: they find the
 * width where a form begins (`narrowestWidth`) and check what is shown against the
 * room the row has (`noteRoom`, `inRowForm`) instead of naming widths that hold for
 * one font only.
 */

/**
 * The narrowest whole width in [`lo`, `hi`] at which `holds` (the page at that
 * width, as the caller sets it) is true; it must be at `hi` and not at `lo`, and
 * the row being monotone in its width, the edge is found by halving.
 */
export async function narrowestWidth(lo: number, hi: number, holds: (width: number) => Promise<boolean>): Promise<number> {
    assert.ok(await holds(hi), `it holds at ${hi}`);
    assert.ok(!(await holds(lo)), `it does not at ${lo}`);
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await holds(mid)) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    return hi;
}

/**
 * The pixels the reason's note could still grow by before the row runs past its
 * box (`overflows`): the note set wider, halving, then given its style back.
 * `null` where no note shows.
 */
export function noteRoom(page: puppeteer.Page): Promise<number | null> {
    return page.$eval('.mep-toolbar', row => {
        const note = row.querySelector('.mep-row-lock') as HTMLElement;
        if (note.hidden || note.getClientRects().length === 0) {
            return null;
        }
        const saved = note.style.cssText;
        const base = note.getBoundingClientRect().width;
        const fits = (extra: number) => {
            note.style.flex = 'none';
            note.style.width = `${base + extra}px`;
            return row.scrollWidth <= row.clientWidth + 0.5;
        };
        let room = 0;
        if (fits(0)) {
            let over = 1024;
            while (over - room > 0.25) {
                const mid = (room + over) / 2;
                if (fits(mid)) {
                    room = mid;
                } else {
                    over = mid;
                }
            }
        }
        note.style.cssText = saved;
        return room;
    });
}

/**
 * For a box or a field whose reason stands in the refused tools' place: the form
 * the room calls for — `inrow` (whole) where the whole reason's extra width over
 * the form shown fits the room left (`noteRoom`), else `short`.
 */
export async function inRowForm(page: puppeteer.Page, reason: string): Promise<'inrow' | 'short'> {
    const extra = await page.$eval('.mep-toolbar .mep-row-lock-text', (text, whole) => {
        const copy = text.cloneNode(true) as HTMLElement;
        copy.textContent = whole as string;
        Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap' });
        (text.parentElement as HTMLElement).append(copy);
        const more = copy.getBoundingClientRect().width - text.getBoundingClientRect().width;
        copy.remove();
        return more;
    }, reason);
    const room = await noteRoom(page);
    assert.notStrictEqual(room, null, 'a note shows');
    return extra <= (room as number) + 0.5 ? 'inrow' : 'short';
}
