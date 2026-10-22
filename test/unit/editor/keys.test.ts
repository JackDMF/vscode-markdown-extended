import * as assert from 'assert';
import { APPLY_BINDING, MODIFIER_KEYS, REDO_BINDINGS, UNDO_BINDING, ariaKeyshortcuts, bindingMatches, keyLabel, typesText } from '../../../src/editor/keys';

/**
 * The key a hint names is the binding the page's keymap binds (`keys.ts`),
 * named as the platform names it: one string, two readers.
 */
suite('Editor keys: a binding as the platform names it', () => {
    test('Mod is Ctrl off a Mac and Cmd on one; a letter key is upper case', () => {
        assert.strictEqual(keyLabel('Mod-z', false), 'Ctrl+Z');
        assert.strictEqual(keyLabel('Mod-z', true), 'Cmd+Z');
        assert.strictEqual(keyLabel('Mod-Enter', false), 'Ctrl+Enter');
        assert.strictEqual(keyLabel('Mod-Shift-z', false), 'Ctrl+Shift+Z');
    });

    test('the apply binding spells the source box\'s key exactly as it was written before: Cmd+Enter on a Mac, Ctrl+Enter elsewhere (#10 R8b)', () => {
        assert.strictEqual(APPLY_BINDING, 'Mod-Enter');
        assert.strictEqual(keyLabel(APPLY_BINDING, true), 'Cmd+Enter');
        assert.strictEqual(keyLabel(APPLY_BINDING, false), 'Ctrl+Enter');
        assert.deepStrictEqual([ariaKeyshortcuts(APPLY_BINDING, true), ariaKeyshortcuts(APPLY_BINDING, false)], ['Meta+Enter', 'Control+Enter']);
    });

    test('the undo binding is the one the undo hints name', () => {
        assert.strictEqual(UNDO_BINDING, 'Mod-z');
        assert.strictEqual(keyLabel(UNDO_BINDING, false), 'Ctrl+Z');
    });

    test('a key event matches the binding it names, Mod by the platform, and no other', () => {
        const chord = (key: string, m: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) =>
            ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
        assert.ok(bindingMatches(UNDO_BINDING, chord('z', { ctrlKey: true }), false));
        assert.ok(bindingMatches(UNDO_BINDING, chord('z', { metaKey: true }), true));
        assert.ok(!bindingMatches(UNDO_BINDING, chord('z', { ctrlKey: true }), true), 'Ctrl+Z is no undo on a Mac');
        assert.ok(!bindingMatches(UNDO_BINDING, chord('Z', { ctrlKey: true, shiftKey: true }), false), 'with Shift it is the redo');
        assert.ok(REDO_BINDINGS.some(b => bindingMatches(b, chord('Z', { ctrlKey: true, shiftKey: true }), false)));
        assert.ok(REDO_BINDINGS.some(b => bindingMatches(b, chord('y', { ctrlKey: true }), false)));
        assert.ok(!bindingMatches(UNDO_BINDING, chord('z'), false), 'no modifier, no undo');
    });

    test('a binding as aria-keyshortcuts spells it: Control or Meta by the platform, a key by its value, + and space by name', () => {
        assert.strictEqual(ariaKeyshortcuts('Mod-i', false), 'Control+I');
        assert.strictEqual(ariaKeyshortcuts('Mod-i', true), 'Meta+I');
        assert.strictEqual(ariaKeyshortcuts('Mod-b', false), 'Control+B');
        assert.strictEqual(ariaKeyshortcuts('Mod-`', false), 'Control+`');
        assert.strictEqual(ariaKeyshortcuts('Mod-+', false), 'Control+Plus');
        assert.strictEqual(ariaKeyshortcuts('Mod- ', false), 'Control+Space');
        assert.strictEqual(ariaKeyshortcuts('Mod-Shift-z', false), 'Control+Shift+Z');
    });

    test('r1: one modifier set names AltGraph and CapsLock too; a modifier alone types nothing', () => {
        for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']) {
            assert.ok(MODIFIER_KEYS.has(key), key);
            assert.strictEqual(typesText({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), false, key);
        }
    });

    test('r1: a character made with AltGr or Option is typing; a shortcut or an Alt command is not', () => {
        const press = (key: string, m: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}, altGraph = false) =>
            typesText({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m, getModifierState: k => altGraph && k === 'AltGraph' });
        assert.ok(press('a'));
        assert.ok(press('A', { shiftKey: true }));
        assert.ok(press('Backspace'));
        assert.ok(press('Enter'));
        // A German layout on Windows: AltGr is Ctrl+Alt with the AltGraph state on.
        for (const key of ['{', '}', '[', ']', '@', '\\', '~']) {
            assert.ok(press(key, { ctrlKey: true, altKey: true }, true), `AltGr ${key}`);
        }
        assert.ok(press('{', { altKey: true }), 'Option on a Mac');
        assert.ok(!press('b', { ctrlKey: true }), 'Ctrl+B');
        assert.ok(!press('b', { metaKey: true }), 'Cmd+B');
        assert.ok(!press('Enter', { altKey: true }), 'Alt+Enter opens the bar');
        assert.ok(!press('ArrowLeft', { altKey: true }), 'Alt+arrow');
        assert.ok(!press('x', { ctrlKey: true, altKey: true }), 'Ctrl+Alt+X without the AltGraph state is a shortcut');
        assert.ok(!press('Enter', { ctrlKey: true, altKey: true }, true), 'AltGr with a named key types nothing');
    });

    test('r2-6: deleting is typing with any modifier; paste and cut are typing, other shortcuts are not', () => {
        const press = (key: string, m: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) =>
            typesText({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
        for (const key of ['Backspace', 'Delete']) {
            assert.ok(press(key), key);
            assert.ok(press(key, { ctrlKey: true }), `Ctrl+${key} deletes a word`);
            assert.ok(press(key, { metaKey: true }), `Cmd+${key}`);
            assert.ok(press(key, { altKey: true }), `Alt+${key}`);
            assert.ok(press(key, { ctrlKey: true, shiftKey: true }), `Ctrl+Shift+${key}`);
        }
        assert.ok(press('v', { ctrlKey: true }), 'Ctrl+V');
        assert.ok(press('V', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+V');
        assert.ok(press('v', { metaKey: true }), 'Cmd+V');
        assert.ok(press('x', { ctrlKey: true }), 'Ctrl+X');
        assert.ok(press('x', { metaKey: true }), 'Cmd+X');
        assert.ok(!press('c', { ctrlKey: true }), 'copy changes nothing');
        assert.ok(!press('z', { ctrlKey: true }), 'Ctrl+Z is the editor\'s own undo');
        assert.ok(!press('v', { ctrlKey: true, altKey: true }), 'Ctrl+Alt+V is no paste');
        assert.ok(press('v'), 'v alone is a character');
    });

    test('r3-3: of the named keys only Backspace, Delete, Enter and Tab type; the arrows, Escape, Home, End, Page and the F-keys do not', () => {
        const press = (key: string, m: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) =>
            typesText({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
        for (const key of ['Backspace', 'Delete', 'Enter', 'Tab', 'a', ' ', '€']) {
            assert.ok(press(key), key);
        }
        assert.ok(press('Tab', { shiftKey: true }), 'Shift+Tab outdents');
        for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'F1', 'F5', 'F12', 'ContextMenu', 'Dead', 'Unidentified']) {
            assert.ok(!press(key), key);
            assert.ok(!press(key, { shiftKey: true }), `Shift+${key} selects, it changes nothing`);
        }
        assert.ok(!press('Tab', { altKey: true }), 'Alt+Tab is the window switcher');
    });
});
