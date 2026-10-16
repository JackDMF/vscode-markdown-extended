/**
 * The key bindings the page's keymap binds and its hints name — one string,
 * two readers: `plugins.ts` binds `UNDO_BINDING` to the undo, and a hint that
 * offers the undo ("Image deleted — Ctrl+Z", `hint.ts`) names the same binding
 * through `keyLabel`. So the key a hint names is the key that undoes, by
 * construction. The host cannot say otherwise: VS Code's own `undo` command
 * does not reach the page, whose keymap is what undoes, and no extension API
 * reads a command's keybinding.
 *
 * No ProseMirror and no DOM here, so every module can read it.
 */

/** What undoes in the page (`plugins.ts`), in ProseMirror's keymap notation. */
export const UNDO_BINDING = 'Mod-z';

/** What redoes in the page (`plugins.ts`). */
export const REDO_BINDINGS: readonly string[] = ['Mod-y', 'Mod-Shift-z'];

/** The keys of a keyboard event a binding is matched against. */
export interface KeyChord {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}

/**
 * Whether `e` is the chord `binding` names, `Mod` being Cmd on a Mac (`mac`)
 * and Ctrl elsewhere — the third reader of the bindings: a source box's
 * textarea keeps its own undo for the very keys the page's keymap undoes and
 * redoes with (`nodeViews.ts`, `isUndoRedo`).
 */
export function bindingMatches(binding: string, e: KeyChord, mac: boolean): boolean {
    const parts = binding.split(/-(?!$)/);
    const key = parts.pop() ?? '';
    const has = (m: string) => parts.includes(m);
    const ctrl = has('Ctrl') || (has('Mod') && !mac);
    const meta = has('Cmd') || has('Meta') || (has('Mod') && mac);
    return e.key.toLowerCase() === key.toLowerCase() && e.ctrlKey === ctrl && e.metaKey === meta && e.shiftKey === has('Shift') && e.altKey === has('Alt');
}

/**
 * A ProseMirror binding as the platform names it: `Mod-z` → `Ctrl+Z` or
 * `Cmd+Z` (`mac`), `Mod-Enter` → `Ctrl+Enter`, `Mod-Shift-z` → `Ctrl+Shift+Z`.
 */
export function keyLabel(binding: string, mac: boolean): string {
    const parts = binding.split(/-(?!$)/);
    const key = parts.pop() ?? '';
    const modifiers = parts.map(m => {
        switch (m) {
            case 'Mod':
                return mac ? 'Cmd' : 'Ctrl';
            case 'Cmd':
            case 'Meta':
                return 'Cmd';
            case 'Ctrl':
            case 'Control':
                return 'Ctrl';
            default:
                return m;
        }
    });
    return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join('+');
}
