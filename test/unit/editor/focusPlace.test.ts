import * as assert from 'assert';
import { DeclaredControl, placeOf } from '../../../src/editor/webview/focusPlace';

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
 * Where the editing focus is, read from the focused element and what the node
 * views declare as their controls: the one answer every bar reads
 * (`focusPlace.ts`).
 */
suite('Editor focus place', () => {
    // The page: the mount holds the row, the bars and the view's root; the
    // root holds the text, the node views' controls, and what renderings and
    // other extensions put in it.
    const body = new FakeElement();
    const mount = new FakeElement(body);
    const row = new FakeElement(mount);
    const rowButton = new FakeElement(row);
    const bar = new FakeElement(mount);
    const barField = new FakeElement(bar);
    const root = new FakeElement(mount);
    const atom = new FakeElement(root);
    const box = new FakeElement(atom);
    const panel = new FakeElement(root);
    const panelField = new FakeElement(panel);
    const panelButton = new FakeElement(panel);
    const renderedLink = new FakeElement(atom);
    const lens = new FakeElement(root);
    const elsewhere = new FakeElement(body);

    const declared = new Map<FakeElement, DeclaredControl>([
        [box, { pos: 7, field: true }],
        [panelField, { pos: 0, field: true }],
        [panelButton, { pos: 0, field: false }],
    ]);
    const read = {
        control: (el: FakeElement) => declared.get(el) ?? null,
        inlineField: (el: FakeElement) => el === barField,
    };
    const at = (active: FakeElement | null, withMount: FakeElement | null = mount) => placeOf(active, root, withMount, read);

    test('the editable root itself is the text', () => {
        assert.deepStrictEqual(at(root), { kind: 'text' });
    });

    test('a control a node view declares is a control, a field or a button, with the position of its block', () => {
        assert.deepStrictEqual(at(box), { kind: 'control', control: { pos: 7, field: true } });
        assert.deepStrictEqual(at(panelField), { kind: 'control', control: { pos: 0, field: true } });
        assert.deepStrictEqual(at(panelButton), { kind: 'control', control: { pos: 0, field: false } });
    });

    test('anything else inside the root — a lens, a link in a rendering, the atom itself — is content, not a control', () => {
        assert.deepStrictEqual(at(lens), { kind: 'content' });
        assert.deepStrictEqual(at(renderedLink), { kind: 'content' });
        assert.deepStrictEqual(at(atom), { kind: 'content' });
    });

    test('inside the mount but outside the root is the chrome; an inline field there says so', () => {
        assert.deepStrictEqual(at(rowButton), { kind: 'chrome', field: false });
        assert.deepStrictEqual(at(bar), { kind: 'chrome', field: false });
        assert.deepStrictEqual(at(barField), { kind: 'chrome', field: true });
    });

    test('outside the mount, or nothing focused, is away', () => {
        assert.deepStrictEqual(at(body), { kind: 'away' });
        assert.deepStrictEqual(at(elsewhere), { kind: 'away' });
        assert.deepStrictEqual(at(null), { kind: 'away' });
        assert.deepStrictEqual(at(mount, null), { kind: 'away' }, 'no mount: nothing is chrome');
    });
});
