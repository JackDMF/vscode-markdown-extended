import shortcuts from 'markdown-it-emoji/lib/data/shortcuts.mjs';

/**
 * markdown-it-emoji's shortcuts (`:)`, `;-)`, `<3`, `8-)` …), as the escape the
 * serializer gives them in text, read from the plugin's own table.
 *
 * The plugin reads a shortcut in a text token when the characters around it
 * are a space, punctuation or a control character — or nothing, at the
 * token's edge, where it looks at no neighbour. The serializer's escapes make
 * such edges: `5$:)` written as `5\$:)` is `5$` and a smiley to the host. So
 * each shortcut is broken by one backslash escape at a single character — its
 * first `:` or `;`, else its first `<` or `-` — wherever the host could read
 * it, which the table test in `serialize.test.ts` proves by the host's parse.
 *
 * Half of the plugin's rule is restated here, the half that leaves a shortcut
 * alone: a letter, digit or mark right before or after it (`http://x`,
 * `C:/path`, `10:30`, `a:)b`). That half holds on the save's text as on the
 * host's token, since a letter is never escaped nor split from its neighbour
 * by the serializer. The other half — punctuation and token edges — is not
 * restated: every other occurrence is escaped, a symbol beside it (`$`, `^`)
 * included, because the serializer may have escaped that symbol.
 */

/** Where an alias is broken: its first `:` or `;`, else its first `<` or `-`. */
function splitIndex(alias: string): number {
    const index = alias.search(/[:;]/) >= 0 ? alias.search(/[:;]/) : alias.search(/[<-]/);
    if (index < 0) {
        throw new Error(`markdown-it-emoji's shortcut ${JSON.stringify(alias)} has no character the escape breaks it at`);
    }
    return index;
}

/** `text` as a literal in a regex with the `u` flag, where `\-` is not an escape. */
function quote(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const LETTER = '[\\p{L}\\p{N}\\p{M}]';

/** The alternative escaping `alias`'s split character where the host could read the alias. */
function aliasEscape(alias: string): string {
    const at = splitIndex(alias);
    const before = quote(alias.slice(0, at));
    const after = quote(alias.slice(at + 1));
    return `${before === '' ? '' : `(?<=${before})`}(?<!${LETTER}${before})${quote(alias.charAt(at))}${after === '' ? '' : `(?=${after})`}(?!${after}${LETTER})`;
}

const table: Record<string, string[]> = shortcuts;

/**
 * One alternative per alias of the plugin's table, for the serializer's
 * escapes (`ESCAPE_EXTRA`); a regex source needing the `u` flag. Throws at
 * load if an alias has no character to break it at.
 */
export const SHORTCUT_ESCAPE_SOURCE: string = Object.values(table).flat().map(aliasEscape).join('|');
