import * as assert from 'assert';
import { lastResortY } from '../../../src/editor/webview/objectToolbar';

/**
 * Where a block's bar goes when no place is free: above the block, where it
 * can be seen — never under the formatting row, where it could be neither
 * seen nor clicked — and always by position, never by moving the layout.
 */
suite('Editor object toolbar: the last resort', () => {
    // A bar 28px high; the row's edge at 27; a window 800px high.
    const at = (aboveY: number, belowY: number) => lastResortY(aboveY, belowY, 28, 27, 800);

    test('above the block where that is below the row', () => {
        assert.strictEqual(at(100, 300), 100);
        assert.strictEqual(at(27, 300), 27, 'right at the row\'s edge is still clear of it');
    });

    test('below the block where above is under the row', () => {
        assert.strictEqual(at(10, 300), 300);
    });

    test('at the row\'s edge where below is past the window\'s bottom too', () => {
        assert.strictEqual(at(10, 790), 31);
        assert.strictEqual(at(-400, 1200), 31);
    });
});
