import * as assert from 'assert';
import { EditorState } from 'prosemirror-state';
import { editorSchema } from '../../../src/editor/schema';
import { mappedSelectionKey } from '../../../src/editor/webview/toolbar/toolbar';
import { Frame, GAP, HideReason, LayerClaim, LayerSlot, Rect, moved, placeAtControl, placeAtEntry, placeBeside, placeMenuAt, placeStacked, probeBand, rekeyed } from '../../../src/editor/webview/placement';

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

    test('r3-2: a submenu under its entry has no gap to it: the band would be the next entry\'s', () => {
        const viewport: Frame = { columnLeft: 0, layerEdge: 800, ceiling: 0, floor: 600 };
        const panel = { width: 260, height: 200 };
        assert.deepStrictEqual(placeMenuAt(panel, rect(100, 100, 360, 126), viewport, 'start', 0), { x: 100, y: 126, side: 'below' });
        assert.deepStrictEqual(placeMenuAt(panel, rect(100, 500, 360, 526), viewport, 'start', 0), { x: 100, y: 300, side: 'above' });
    });

    test('r4-1: a menu taller than the room on both sides goes below, else above, never over its opener, its height shrunk to that room', () => {
        const viewport: Frame = { columnLeft: 0, layerEdge: 800, ceiling: 0, floor: 400 };
        const tall = { width: 260, height: 500 };
        // More room below (400 - 126 = 274 against 100): below the entry, scrolling.
        assert.deepStrictEqual(placeMenuAt(tall, rect(100, 100, 360, 126), viewport, 'start', 0), { x: 100, y: 126, side: 'below', maxHeight: 274 });
        // More room above (300 against 400 - 326 = 74): above it, from the ceiling down to the entry.
        assert.deepStrictEqual(placeMenuAt(tall, rect(100, 300, 360, 326), viewport, 'start', 0), { x: 100, y: 0, side: 'above', maxHeight: 300 });
        // A gap away: the room is what is left of it.
        assert.deepStrictEqual(placeMenuAt(tall, rect(100, 300, 360, 326), viewport), { x: 100, y: 0, side: 'above', maxHeight: 300 - GAP });
        // A tie goes below.
        assert.strictEqual(placeMenuAt(tall, rect(100, 190, 360, 210), viewport, 'start', 0).side, 'below');
        // A menu that fits is not shrunk.
        assert.strictEqual(placeMenuAt({ width: 260, height: 100 }, rect(100, 100, 360, 126), viewport, 'start', 0).maxHeight, undefined);
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

    test('r1-13 (#15 review 2, Daniel: below wherever free, above only where below is text and above is not): text under both sides keeps below, for every layer', () => {
        const anchor = rect(60, 100, 300, 118);
        const below = (band: Rect) => band.top >= 118;
        const above = (band: Rect) => band.bottom <= 100;
        const both = () => true;
        const none = () => false;
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: both }).side, 'below', 'text under both: below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: none }).side, 'below', 'free on both sides: below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: below }).side, 'above', 'text only below');
        assert.strictEqual(placeStacked(size, anchor, frame, { covered: above }).side, 'below', 'text only above: the free side, below');
    });

    test('#15 review 2: prefer "above" (the bubble in a note\'s body in the margin) takes above wherever it qualifies, else below the anchor', () => {
        // The anchor runs from the selected line's top to the note body's last line.
        const anchor = rect(60, 100, 300, 160);
        const none = () => false;
        const above = placeStacked(size, anchor, frame, { covered: none, prefer: 'above' });
        assert.deepStrictEqual([above.side, above.y + size.height <= 100], ['above', true], 'above the selected line, the free side below notwithstanding');
        const top = rect(60, frame.ceiling + 4, 300, frame.ceiling + 60);
        const low = placeStacked(size, top, frame, { covered: none, prefer: 'above' });
        assert.deepStrictEqual([low.side, low.y >= frame.ceiling + 60], ['below', true], 'no room above: below the body\'s last line');
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

/** Where a refusal stands at what was pressed (#10): under the control at the surface's bottom, beside a menu at the entry, else above the menu. */
suite('Editor placement: a refusal at a control or a menu entry', () => {
    const viewport: Frame = { columnLeft: 0, layerEdge: 1280, ceiling: 0, floor: 800 };
    const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom });

    test('under the pressed control at its left, GAP under the surface, keeping off no layer', () => {
        const bold = rect(200, 4, 228, 28);
        const row = rect(0, 0, 1280, 32);
        assert.deepStrictEqual(placeAtControl({ width: 300, height: 24 }, bold, row, viewport), { x: 200, y: 32 + GAP, side: 'below' });
        // At the window's right end it is clamped into the window, never past it.
        assert.deepStrictEqual(placeAtControl({ width: 300, height: 24 }, rect(1250, 4, 1276, 28), row, viewport), { x: 980, y: 36, side: 'below' });
        // A bar at the window's floor: above the control.
        const verb = rect(100, 770, 160, 790);
        assert.deepStrictEqual(placeAtControl({ width: 300, height: 24 }, verb, rect(90, 766, 400, 794), viewport), { x: 100, y: 770 - GAP - 24, side: 'above' });
    });

    test('beside the menu at the entry\'s top: right where there is room, else left', () => {
        const size = { width: 260, height: 40 };
        const menu = rect(300, 36, 500, 300);
        const entry = rect(304, 120, 496, 142);
        assert.deepStrictEqual(placeAtEntry(size, menu, entry, viewport), { x: 500 + GAP, y: 120, side: 'right' });
        const exportMenu = rect(1080, 36, 1276, 200);
        assert.deepStrictEqual(placeAtEntry(size, exportMenu, rect(1084, 80, 1272, 102), viewport), { x: 1080 - GAP - 260, y: 80, side: 'left' });
    });

    test('no room beside the menu: above it at its right end, never at the window\'s floor', () => {
        const narrow: Frame = { columnLeft: 0, layerEdge: 520, ceiling: 0, floor: 800 };
        const size = { width: 300, height: 40 };
        const menu = rect(260, 60, 516, 300);
        const p = placeAtEntry(size, menu, rect(264, 200, 512, 222), narrow);
        assert.deepStrictEqual(p, { x: 516 - 300, y: 60 - GAP - 40, side: 'above' });
        assert.ok(p.y + size.height <= menu.top, 'not over the menu');
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
        rekeyAll(moves: ReadonlyMap<string, string | null>): void;
        wouldGrant(claim: Pick<LayerClaim, 'kind' | 'key' | 'el'>, opts?: { force?: boolean }): boolean;
        suppress(on: boolean): void;
        dismissedOf(prefix: string): string[];
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

    test('wave 3 follow-up: a change of the document moves the occupant\'s key with the dismissals; one mapped to nothing is left to its owner', () => {
        const slot = bare();
        slot.occupant = claim('bubble', 'sel@3-5', false);
        slot.dismiss('sel@9-12');
        slot.rekeyAll(new Map([['sel@3-5', 'sel@20-22'], ['sel@9-12', 'sel@26-29']]));
        assert.strictEqual(slot.occupant?.key, 'sel@20-22', 'the bubble is about the moved selection');
        assert.deepStrictEqual(slot.dismissedOf('sel@'), ['sel@26-29']);
        slot.rekeyAll(new Map([['sel@20-22', null]]));
        assert.strictEqual(slot.occupant?.key, 'sel@20-22', 'its owner\'s valid() ends it');
    });

    test('wave 3 follow-up: wouldGrant answers as request does, before anything is drawn', () => {
        const slot = bare();
        assert.strictEqual(slot.wouldGrant(claim('bar', 'bar@link@3')), true, 'an empty slot');
        slot.dismiss('bar@link@3');
        assert.strictEqual(slot.wouldGrant(claim('bar', 'bar@link@3')), false, 'dismissed');
        assert.strictEqual(slot.wouldGrant(claim('bar', 'bar@link@3'), { force: true }), true, 'Alt+Enter');
        const field = claim('field', 'field@3-3', false);
        slot.occupant = field;
        assert.strictEqual(slot.wouldGrant(claim('bar', 'bar@table@9')), false, 'a field holds the slot');
        assert.strictEqual(slot.wouldGrant(claim('hover', 'hover@table@9')), false);
        assert.strictEqual(slot.wouldGrant(claim('field', 'field@5-5')), true, 'a field takes a field\'s place');
        assert.strictEqual(slot.wouldGrant(field), true, 'the occupant asking again');
        slot.occupant = null;
        slot.suppress(true);
        assert.strictEqual(slot.wouldGrant(claim('bubble', 'sel@1-4')), false, 'a row menu is open');
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

suite('Editor placement: the bubble\'s key through a change', () => {
    const doc = editorSchema.node('doc', null, [editorSchema.node('paragraph', null, [editorSchema.text('Alpha beta gamma.')])]);
    const state = EditorState.create({ doc });

    test('an insertion before the selection moves its key; one inside widens it; deleting it ends it', () => {
        const before = state.tr.insertText('Hey ', 1);
        assert.strictEqual(mappedSelectionKey('sel@7-11', [before]), 'sel@11-15');
        const inside = state.tr.insertText('x', 9);
        assert.strictEqual(mappedSelectionKey('sel@7-11', [inside]), 'sel@7-12');
        const gone = state.tr.delete(5, 13);
        assert.strictEqual(mappedSelectionKey('sel@7-11', [gone]), null);
    });
});
