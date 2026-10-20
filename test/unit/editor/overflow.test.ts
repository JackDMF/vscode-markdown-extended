import * as assert from 'assert';
import { moreName, moveUntilFits } from '../../../src/editor/webview/overflow';

/**
 * The one "…" mechanism of the row and the bars (`overflow.ts`): the loop
 * that moves controls until the rest fits, and the name "…" gives what it holds.
 */
suite('Editor overflow: "…" in the row and the bars', () => {
    /** A container that fits once at most `room` of its items show. */
    function container(items: string[], room: number) {
        const hidden = new Set<string>();
        const log: string[] = [];
        return {
            hidden,
            log,
            fits: () => items.length - hidden.size <= room,
            show: (t: string) => { hidden.delete(t); log.push(`show ${t}`); },
            hide: (t: string) => { hidden.add(t); log.push(`hide ${t}`); },
        };
    }

    test('nothing moves when everything fits', () => {
        const c = container(['a', 'b', 'c'], 3);
        assert.deepStrictEqual(moveUntilFits(['c', 'b', 'a'], c.fits, c.show, c.hide), []);
        assert.strictEqual(c.hidden.size, 0);
    });

    test('items move in the order given and the loop stops at the first fit', () => {
        const c = container(['a', 'b', 'c', 'd'], 2);
        assert.deepStrictEqual(moveUntilFits(['d', 'c', 'b', 'a'], c.fits, c.show, c.hide), ['d', 'c']);
        assert.deepStrictEqual([...c.hidden].sort(), ['c', 'd']);
    });

    test('everything is shown before the first measurement: an item hidden before is back when it fits now', () => {
        const c = container(['a', 'b', 'c'], 3);
        c.hidden.add('a');
        c.hidden.add('b');
        assert.deepStrictEqual(moveUntilFits(['a', 'b', 'c'], c.fits, c.show, c.hide), []);
        assert.strictEqual(c.hidden.size, 0);
        assert.deepStrictEqual(c.log, ['show a', 'show b', 'show c']);
    });

    test('nothing fits: every item of the order moves, and no more', () => {
        const c = container(['a', 'b', 'keep'], 0);
        assert.deepStrictEqual(moveUntilFits(['a', 'b'], c.fits, c.show, c.hide), ['a', 'b']);
        assert.ok(!c.hidden.has('keep'));
    });

    test('"…" names what it holds, an item that is on marked so', () => {
        assert.strictEqual(moreName('row', []), 'More');
        assert.strictEqual(moreName('row', ['Formatting', 'Annotation', 'Insert', 'Code'], ['Code']), 'More: Formatting, Annotation, Insert, Code (on)');
        assert.strictEqual(moreName('row', ['Formatting', 'Code']), 'More: Formatting, Code');
        assert.strictEqual(moreName('bar', []), 'More actions');
        assert.strictEqual(moreName('bar', ['Edit source', 'Delete table']), 'More actions: Edit source, Delete table');
    });
});
