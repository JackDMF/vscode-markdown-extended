import * as assert from 'assert';
import { MODIFIER_KEYS, REDO_BINDINGS, UNDO_BINDING, ariaKeyshortcuts, bindingMatches, keyLabel, typesText } from '../../../src/editor/keys';

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
});
