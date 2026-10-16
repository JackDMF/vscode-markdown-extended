import * as assert from 'assert';
import { UNDO_BINDING, keyLabel } from '../../../src/editor/keys';

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
});
