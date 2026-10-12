import * as assert from 'assert';
import { placeOf } from '../../../src/editor/webview/focusPlace';

/** An element as `placeOf` reads one: its parent, and `contains` as the DOM answers it (an element contains itself). */
class FakeElement {
    constructor(readonly parent: FakeElement | null = null) { }
    contains(other: unknown): boolean {
        for (let el = other as FakeElement | null; el; el = el.parent) {
            if (el === this) {
                return true;
            }
        }
        return false;
    }
}

/**
 * Where the editing focus is, read from the focused element alone: the one
 * answer every bar reads (`focusPlace.ts`).
 */
suite('Editor focus place', () => {
    // The page: the mount holds the row, the bars and the view's root; the
    // root holds the text and the node views' controls.
    const body = new FakeElement();
    const mount = new FakeElement(body);
    const row = new FakeElement(mount);
    const rowButton = new FakeElement(row);
    const bar = new FakeElement(mount);
    const barField = new FakeElement(bar);
    const root = new FakeElement(mount);
    const atom = new FakeElement(root);
    const box = new FakeElement(atom);
    const elsewhere = new FakeElement(body);

    test('the editable root itself is the text', () => {
        assert.strictEqual(placeOf(root, root, mount), 'text');
    });

    test('anything else inside the root is a control of a node view: a source box, a property\'s field', () => {
        assert.strictEqual(placeOf(box, root, mount), 'control');
        assert.strictEqual(placeOf(atom, root, mount), 'control');
    });

    test('inside the mount but outside the root is the chrome: the row, a bar, a bar\'s field', () => {
        assert.strictEqual(placeOf(rowButton, root, mount), 'chrome');
        assert.strictEqual(placeOf(barField, root, mount), 'chrome');
        assert.strictEqual(placeOf(bar, root, mount), 'chrome');
    });

    test('outside the mount, or nothing focused, is away', () => {
        assert.strictEqual(placeOf(body, root, mount), 'away');
        assert.strictEqual(placeOf(elsewhere, root, mount), 'away');
        assert.strictEqual(placeOf(null, root, mount), 'away');
        assert.strictEqual(placeOf(mount, root, null), 'away', 'no mount: nothing is chrome');
    });
});
