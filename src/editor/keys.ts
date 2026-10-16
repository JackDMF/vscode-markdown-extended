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
