import * as assert from 'assert';
import { sweep, threeRunCases, twoRunCases } from './roundTripSweep';

/**
 * The save's verdict held to the real engine over a fixed subset of the
 * brute-force sweep (`roundTripSweep.ts`): no case it lets through reads back
 * otherwise, and no case it refuses reads back as the model. The full sweep is
 * `node out/test/sweep/inlineRoundTrip.js`.
 */
suite('Editor inline round trip: the verdict agrees with the engine (a subset of the sweep)', () => {
    test('two runs side by side, every 25th case', function () {
        this.timeout(60000);
        const tally = sweep(twoRunCases(), 25);
        assert.ok(tally.cases > 500, `${tally.cases} cases`);
        assert.deepStrictEqual({ corrupt: tally.corrupt, overRefused: tally.overRefused }, { corrupt: [], overRefused: [] });
    });

    test('three runs side by side, every 400th case', function () {
        this.timeout(60000);
        const tally = sweep(threeRunCases(), 400);
        assert.ok(tally.cases > 300, `${tally.cases} cases`);
        assert.deepStrictEqual({ corrupt: tally.corrupt, overRefused: tally.overRefused }, { corrupt: [], overRefused: [] });
    });
});

suite('Editor inline round trip: with VS Code\'s typographer on', () => {
    test('two runs side by side, every 25th case', function () {
        this.timeout(60000);
        const tally = sweep(twoRunCases(), 25, 3, true);
        assert.ok(tally.cases > 500, `${tally.cases} cases`);
        assert.deepStrictEqual({ corrupt: tally.corrupt, overRefused: tally.overRefused }, { corrupt: [], overRefused: [] });
    });

    test('three runs side by side, every 400th case', function () {
        this.timeout(60000);
        const tally = sweep(threeRunCases(), 400, 7, true);
        assert.deepStrictEqual({ corrupt: tally.corrupt, overRefused: tally.overRefused }, { corrupt: [], overRefused: [] });
    });
});
