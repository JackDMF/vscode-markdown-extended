import * as assert from 'assert';
import { Frame, GAP, Rect, moved, placeBeside, placeMenuAt, placeStacked, probeBand } from '../../../src/editor/webview/placement';

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
});
