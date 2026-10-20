import * as assert from 'assert';
import { Frame, GAP, HideReason, LayerClaim, LayerSlot, Rect, moved, placeBeside, placeMenuAt, placeStacked, probeBand, rekeyed } from '../../../src/editor/webview/placement';

/**
 * The one placement policy every floating layer reads (`placement.ts`): below
 * the anchor at its start, else above; never under the row, past the window,
 * on the caret's line or on another open layer; text breaks a tie, else below.
 * Pure geometry: a frame 26…604 wide under a row ending at 27, a window 250
 * high, a layer 400 × 28.
 */
suite('Editor placement: the policy', () => {
    const frame: Frame = { columnLeft: 26, layerEdge: 604, ceiling: 27, floor: 250 };
    const size = { width: 400, height: 28 };
    const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

    test('s1: an anchor at the window\'s bottom flips the layer above it, at its start', () => {
        const anchor = rect(60, 200, 300, 244);
        assert.deepStrictEqual(placeStacked(size, anchor, frame), { x: 60, y: 200 - GAP - 28, side: 'above' });
    });

    test('s2: below on the caret\'s line goes above; above under the row too goes below the caret\'s line', () => {
        const anchor = rect(80, 100, 140, 118);
        const caret = rect(26, 120, 604, 142);
        assert.deepStrictEqual(placeStacked(size, anchor, frame, { caret }), { x: 80, y: 100 - GAP - 28, side: 'above' });
        const high = rect(80, 40, 140, 58);
        const caretUnder = rect(26, 60, 604, 82);
        assert.deepStrictEqual(placeStacked(size, high, frame, { caret: caretUnder }), { x: 80, y: 82 + GAP, side: 'caret' });
    });

    test('s3: the bubble goes below its selection; one spanning the window sticks to the visible edge, off the caret', () => {
        assert.deepStrictEqual(placeStacked(size, rect(120, 100, 300, 118), frame), { x: 120, y: 122, side: 'below' });
        const tall = rect(40, -300, 500, 900);
        assert.deepStrictEqual(placeStacked(size, tall, frame), { x: 40, y: 250 - 32, side: 'edge' });
        const caret = rect(26, 210, 604, 232);
        assert.deepStrictEqual(placeStacked(size, tall, frame, { caret }), { x: 40, y: 27 + GAP, side: 'edge' });
    });

    test('s4: a field anchored to the caret\'s line stands below it at the caret\'s x', () => {
        assert.deepStrictEqual(placeStacked(size, rect(212, 120, 213, 140), frame), { x: 204, y: 144, side: 'below' });
        assert.deepStrictEqual(placeStacked({ width: 200, height: 28 }, rect(212, 120, 213, 140), frame), { x: 212, y: 144, side: 'below' });
    });

    test('s6: a heading just under the row has its bar below it, not over the row', () => {
        const heading = rect(26, 31, 400, 55);
        assert.deepStrictEqual(placeStacked(size, heading, frame, { caret: rect(26, 29, 604, 57) }), { x: 26, y: 59, side: 'below' });
    });

    test('s7: the layer edge stops the layer short of a lane; an anchor left of the column starts at the column', () => {
        const lane = { ...frame, layerEdge: 526 };
        assert.strictEqual(placeStacked(size, rect(300, 100, 340, 118), lane).x, 526 - 400);
        assert.strictEqual(placeStacked(size, rect(10, 100, 40, 118), frame).x, 26);
    });

    test('the tie-break: text under below takes above; text under both, or under neither, keeps below', () => {
        const anchor = rect(60, 100, 300, 118);
        const coveredBelow = (band: Rect) => band.top >= 118;
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: coveredBelow }).side, 'above');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: () => true }).side, 'below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: () => false }).side, 'below');
        assert.deepStrictEqual(probeBand(10, 20, size), { left: 6, top: 16, right: 414, bottom: 52 });
    });

    test('an open layer under the anchor sends the layer above', () => {
        const anchor = rect(60, 100, 300, 118);
        assert.strictEqual(placeStacked(size, anchor, frame, { avoid: [rect(0, 130, 600, 160)] }).side, 'above');
    });

    test('beside: right where it fits, else left, else stacked, else none; the top kept inside the frame', () => {
        const card = { width: 100, height: 60 };
        const menu = rect(200, 40, 380, 200);
        assert.deepStrictEqual(placeBeside(card, menu, 80, frame), { x: 384, y: 80, side: 'right' });
        assert.strictEqual(placeBeside(card, rect(140, 40, 560, 120), 80, frame).side, 'left');
        assert.deepStrictEqual(placeBeside(card, rect(26, 40, 600, 120), 60, frame), { x: 26, y: 124, side: 'below' });
        assert.strictEqual(placeBeside(card, rect(26, 40, 600, 120), 60, frame, {}, 'none').side, 'none');
        assert.strictEqual(placeBeside(card, rect(26, 31, 600, 240), 60, frame).side, 'none', 'no room anywhere');
        assert.strictEqual(placeBeside(card, menu, 230, frame).y, 250 - 60, 'clamped to the floor');
        assert.strictEqual(placeBeside(card, menu, 0, frame).y, 27 + GAP, 'clamped under the ceiling');
    });

    test('moved: from nothing, or by a pixel', () => {
        assert.strictEqual(moved(null, { x: 1, y: 1, side: 'below' }), true);
        assert.strictEqual(moved({ x: 1, y: 1, side: 'below' }, { x: 1.4, y: 1, side: 'above' }), false);
        assert.strictEqual(moved({ x: 1, y: 1, side: 'below' }, { x: 1, y: 2, side: 'below' }), true);
    });

    test('a menu under its opener — its right edge at the opener\'s for \'end\' — flips above where the window ends', () => {
        const viewport: Frame = { columnLeft: 0, layerEdge: 800, ceiling: 0, floor: 600 };
        const panel = { width: 260, height: 200 };
        assert.deepStrictEqual(placeMenuAt(panel, rect(700, 0, 780, 26), viewport, 'end'), { x: 520, y: 30, side: 'below' });
        assert.deepStrictEqual(placeMenuAt(panel, rect(100, 500, 180, 526), viewport), { x: 100, y: 500 - GAP - 200, side: 'above' });
    });

    test('r1-6: an anchor out of the window at the bottom only, no place qualifying, keeps the layer at the visible edge, off the caret', () => {
        const runsOut = rect(60, 60, 300, 400);
        const caret = rect(26, 215, 604, 245);
        assert.deepStrictEqual(placeStacked(size, runsOut, frame, { caret }), { x: 60, y: 27 + GAP, side: 'edge' });
        assert.deepStrictEqual(placeStacked(size, runsOut, frame), { x: 60, y: 250 - GAP - 28, side: 'edge' });
    });

    test('r1-6b: where nothing else qualifies and under the caret\'s line does not fit, the layer goes above it, never on it', () => {
        const anchor = rect(80, 100, 140, 118);
        const caret = rect(26, 235, 604, 248);
        const blocked = [rect(0, 60, 700, 160)];
        assert.deepStrictEqual(placeStacked(size, anchor, frame, { caret, avoid: blocked }), { x: 80, y: 235 - GAP - 28, side: 'caret' });
        // Under the caret's line where that fits.
        assert.deepStrictEqual(placeStacked(size, anchor, frame, { caret: rect(26, 170, 604, 190), avoid: blocked }), { x: 80, y: 190 + GAP, side: 'caret' });
    });

    test('r2-2: the clamp into the window comes only after under and above the caret\'s line both failed', () => {
        const anchor = rect(80, 30, 140, 48);
        const short: Frame = { columnLeft: 26, layerEdge: 604, ceiling: 27, floor: 80 };
        assert.deepStrictEqual(placeStacked(size, anchor, short, { caret: rect(26, 40, 604, 62) }), { x: 80, y: 80 - 28, side: 'caret' });
    });

    test('r2-1: an anchor wholly above the window pins nothing to its edge, one wholly below neither', () => {
        const above = rect(60, -200, 300, -150);
        const below = rect(60, 400, 300, 450);
        const caret = rect(26, 100, 604, 122);
        assert.strictEqual(placeStacked(size, above, frame).side, 'below');
        assert.ok(placeStacked(size, above, frame).y < frame.ceiling, 'it stays out of the window with its anchor');
        assert.strictEqual(placeStacked(size, below, frame).side, 'below');
        assert.ok(placeStacked(size, below, frame).y >= frame.floor, 'it stays out of the window with its anchor');
        assert.deepStrictEqual(placeStacked(size, above, frame, { caret }), { x: 60, y: 126, side: 'caret' });
        assert.deepStrictEqual(placeStacked(size, below, frame, { caret }), { x: 60, y: 126, side: 'caret' });
        // Running out of the window while still in it keeps the edge rule.
        assert.strictEqual(placeStacked(size, rect(60, -200, 300, 120), frame, { avoid: [rect(0, 0, 700, 400)] }).side, 'edge');
    });

    test('r1-13: text under both sides: below, but above for an inline object\'s bar; a side free of text always wins', () => {
        const anchor = rect(60, 100, 300, 118);
        const below = (band: Rect) => band.top >= 118;
        const above = (band: Rect) => band.bottom <= 100;
        const both = () => true;
        const none = () => false;
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: both }).side, 'below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: both, bothCovered: 'above' }).side, 'above');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: both, bothCovered: 'below' }).side, 'below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: none, bothCovered: 'above' }).side, 'below', 'free on both sides: below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: below, bothCovered: 'above' }).side, 'above', 'text only below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: above, bothCovered: 'above' }).side, 'below', 'text only above: the free side, below');
    });

    test('r2-5: dismissal keys follow a change in one go: two that shift onto each other do not collide, a deleted one ends', () => {
        const keys = ['bar@link@10', 'bar@link@14', 'hover@table@30', 'sel@3-5'];
        const moves = new Map<string, string | null>([['bar@link@10', 'bar@link@14'], ['bar@link@14', 'bar@link@18'], ['hover@table@30', null]]);
        assert.deepStrictEqual(Array.from(rekeyed(keys, moves)).sort(), ['bar@link@14', 'bar@link@18', 'sel@3-5']);
        // One after the other, the first move would have been eaten by the second.
        const oneByOne = new Set(keys);
        for (const [from, to] of moves) {
            if (oneByOne.delete(from) && to !== null) {
                oneByOne.add(to);
            }
        }
        assert.notDeepStrictEqual(Array.from(oneByOne).sort(), ['bar@link@14', 'bar@link@18', 'sel@3-5']);
    });
});

/**
 * The slot's bookkeeping without a page: an instance with the state `request`
 * and `vacate` read, its placing never reached (a claim whose anchor is gone,
 * or one that is refused).
 */
suite('Editor placement: the slot\'s state', () => {
    interface Bare {
        occupant: LayerClaim | null;
        request(claim: LayerClaim, opts?: { force?: boolean }): boolean;
        onFreed(listener: () => void): () => void;
        dismiss(key: string): void;
    }
    const bare = (): Bare => {
        const slot = Object.create(LayerSlot.prototype) as Bare;
        Object.assign(slot, { dismissed: new Set<string>(), menuOpen: false, placed: null, destroyed: false, freed: new Set<() => void>(), listeners: [] });
        slot.occupant = null;
        return slot;
    };
    const claim = (kind: LayerClaim['kind'], key: string, anchorGone = true, log: string[] = []): LayerClaim => ({
        kind,
        key,
        el: { hidden: false } as unknown as HTMLElement,
        anchor: () => (anchorGone ? null : { left: 0, top: 0, right: 1, bottom: 1 }),
        valid: () => true,
        hidden: (reason: HideReason) => {
            log.push(`${key}:${reason}`);
        },
    });
    const later = () => new Promise<void>(resolve => setTimeout(resolve, 20));

    test('r2-4: a bar\'s claim does not displace a field\'s — the typed text would be lost — unless forced', () => {
        const slot = bare();
        const log: string[] = [];
        slot.occupant = claim('field', 'field@3-3', true, log);
        assert.strictEqual(slot.request(claim('bar', 'bar@link@3'), {}), false);
        assert.strictEqual(slot.occupant?.key, 'field@3-3', 'the field still holds the slot');
        assert.deepStrictEqual(log, [], 'and was not told to hide');
        assert.strictEqual(slot.request(claim('bubble', 'sel@3-5')), false);
        assert.strictEqual(slot.request(claim('hover', 'hover@table@9')), false);
        assert.deepStrictEqual(log, []);
        slot.request(claim('bar', 'bar@link@3'), { force: true });
        assert.deepStrictEqual(log, ['field@3-3:displaced'], 'Alt+Enter takes it');
    });

    test('r2-8: a claim whose anchor is gone on an empty slot announces nothing; one that displaced an occupant does', async () => {
        const slot = bare();
        let heard = 0;
        slot.onFreed(() => {
            heard++;
        });
        assert.strictEqual(slot.request(claim('bubble', 'sel@1-4')), false);
        await later();
        assert.strictEqual(heard, 0, 'nobody left, nobody to tell');
        slot.occupant = claim('bar', 'bar@link@3', false);
        assert.strictEqual(slot.request(claim('bubble', 'sel@1-4')), false);
        await later();
        assert.strictEqual(heard, 1, 'the bar was displaced and the slot is free again');
    });
});
