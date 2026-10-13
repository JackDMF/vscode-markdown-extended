import * as assert from 'assert';
import { DeclaredControl, FocusPlace, controlLock, panelRole, placeOf, rowLock } from '../../../src/editor/webview/focusPlace';

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
        [box, { pos: 7, role: 'source' }],
        [panelField, { pos: 0, role: 'property' }],
        [panelButton, { pos: 0, role: 'button' }],
    ]);
    const read = {
        control: (el: FakeElement) => declared.get(el) ?? null,
        inlineField: (el: FakeElement) => el === barField,
    };
    const at = (active: FakeElement | null, withMount: FakeElement | null = mount) => placeOf(active, root, withMount, read);

    test('the editable root itself is the text', () => {
        assert.deepStrictEqual(at(root), { kind: 'text' });
    });

    test('a control a node view declares is a control — a source box, a property\'s field or a button — with the position of its block', () => {
        assert.deepStrictEqual(at(box), { kind: 'control', control: { pos: 7, role: 'source' } });
        assert.deepStrictEqual(at(panelField), { kind: 'control', control: { pos: 0, role: 'property' } });
        assert.deepStrictEqual(at(panelButton), { kind: 'control', control: { pos: 0, role: 'button' } });
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

    test('in the properties panel: the YAML box is a source box, any other text a property\'s field, the native date input too, the rest a button', () => {
        assert.strictEqual(panelRole({ tag: 'TEXTAREA', sourceBox: true }), 'source');
        assert.strictEqual(panelRole({ tag: 'INPUT', type: 'text', sourceBox: false }), 'property');
        assert.strictEqual(panelRole({ tag: 'INPUT', type: 'date', sourceBox: false }), 'property');
        assert.strictEqual(panelRole({ tag: 'TEXTAREA', sourceBox: false }), 'property');
        assert.strictEqual(panelRole({ tag: 'INPUT', type: 'checkbox', sourceBox: false }), 'button');
        assert.strictEqual(panelRole({ tag: 'BUTTON', sourceBox: false }), 'button');
        assert.strictEqual(panelRole({ tag: 'SPAN', sourceBox: false }), 'button', 'a chip or a copyable id: pressed, not typed in');
    });

    test('a control in the text refuses what acts on the selection, with its reason, and never what acts on the whole document (Export)', () => {
        const places: FocusPlace[] = [
            { kind: 'text' }, { kind: 'chrome', field: false }, { kind: 'content' }, { kind: 'away' },
            { kind: 'control', owner: null, role: 'source' }, { kind: 'control', owner: null, role: 'property' }, { kind: 'control', owner: null, role: 'button' },
        ];
        assert.deepStrictEqual(places.map(p => rowLock(p, 'selection')), [
            null, null, null, null, controlLock('source'), controlLock('property'), controlLock('button'),
        ]);
        assert.deepStrictEqual(places.map(p => rowLock(p, 'document')), places.map(() => null));
    });
});
