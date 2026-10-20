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
 *
 * Limit: `bindingMatches` compares `e.key` only, so on a non-Latin layout, where
 * the Z key does not type `z`, it misses the chord ProseMirror's keymap still
 * finds by `keyCode` (a follow-up).
 */

/** What undoes in the page (`plugins.ts`), in ProseMirror's keymap notation. */
export const UNDO_BINDING = 'Mod-z';

/** What redoes in the page (`plugins.ts`). */
export const REDO_BINDINGS: readonly string[] = ['Mod-y', 'Mod-Shift-z'];

/** The keys that only modify another: none of them acts, hides a hover, or types — one set for every reader (the bars, the row, the tooltips, the language card). */
export const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** The keys of a keyboard event a binding is matched against. */
export interface KeyChord {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}

/** A keyboard event as far as `typesText` reads it. */
export interface TypingKey extends KeyChord {
    /** Absent in a fake event: AltGr is then not told from Ctrl+Alt. */
    getModifierState?(key: string): boolean;
}

/**
 * Whether a key going down is meant to change the text: a character or an
 * editing key (Backspace, Enter), not a modifier on its own, not a shortcut
 * (Ctrl or Cmd, not both), not an Alt command (Alt+Enter, Alt+arrow). Deleting
 * is typing whatever is held with it (Ctrl+Backspace deletes a word), and so
 * are the two shortcuts that change the text with no character of their own:
 * Ctrl or Cmd with V (paste) or X (cut). A
 * character made with Alt — Option on a Mac, AltGr on a German layout, which a
 * Windows browser reports as Ctrl+Alt with the AltGraph state on (`{ } [ ] @ \ ~`)
 * — is typing: a one-character key.
 */
export function typesText(e: TypingKey): boolean {
    if (MODIFIER_KEYS.has(e.key)) {
        return false;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
        return true;
    }
    const altGraph = e.getModifierState?.('AltGraph') === true;
    if (!altGraph && e.ctrlKey !== e.metaKey) {
        const key = e.key.toLowerCase();
        return !e.altKey && (key === 'v' || key === 'x');
    }
    return e.altKey || altGraph ? e.key.length === 1 : true;
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

/** The keys `aria-keyshortcuts` cannot write as themselves: `+` joins its keys, and a space separates shortcuts. */
const ARIA_KEY_NAMES: Readonly<Record<string, string>> = { '+': 'Plus', ' ': 'Space' };

/**
 * A binding as `aria-keyshortcuts` spells it — the fourth reader: `Mod-i` →
 * `Control+I` or `Meta+I` (`mac`), Mod-backtick → ``Control+` `` — key values
 * (`KeyboardEvent.key`), the backtick as the character.
 */
export function ariaKeyshortcuts(binding: string, mac: boolean): string {
    const parts = binding.split(/-(?!$)/);
    const key = parts.pop() ?? '';
    const modifiers = parts.map(m => {
        switch (m) {
            case 'Mod':
                return mac ? 'Meta' : 'Control';
            case 'Cmd':
            case 'Meta':
                return 'Meta';
            case 'Ctrl':
            case 'Control':
                return 'Control';
            default:
                return m;
        }
    });
    return [...modifiers, ARIA_KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)].join('+');
}
