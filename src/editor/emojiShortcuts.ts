import shortcuts from 'markdown-it-emoji/lib/data/shortcuts.mjs';

/**
 * markdown-it-emoji's shortcuts (`:)`, `;-)`, `<3`, `8-)` …), broken in the
 * text the serializer writes, read from the plugin's own table.
 *
 * The plugin reads a shortcut in a text token when the characters around it
 * are a space, punctuation or a control character — or nothing, at the
 * token's edge, where it looks at no neighbour. The serializer's escapes make
 * such edges (`5$:)` written as `5\$:)` is `5$` and a smiley to the host), and
 * so does the host's linkify at a link's start and end (`http://x.com:)`). So
 * each shortcut is broken by one backslash escape at a single character — its
 * first `:` or `;`, else its first `<` or `-` — wherever the host could read
 * it, which the table tests in `serialize.test.ts` prove by the host's parse.
 *
 * Half of the plugin's rule is restated here, the half that leaves a shortcut
 * alone: a letter, digit or mark right before or after it (`http://x`,
 * `C:/path`, `10:30`, `a:)b`). That half holds on the save's text as on the
 * host's token, since a letter is never escaped nor split from its neighbour
 * by the serializer — except at a link's edge, which the caller names, as the
 * host's engine read it. The other half — punctuation and token edges — is
 * not restated: every other occurrence is escaped, a symbol beside it (`$`,
 * `^`) included, because the serializer may have escaped that symbol.
 */

/**
 * Each alias of the plugin's table with where it is broken: its first `:` or
 * `;`, else its first `<` or `-`. Throws at load if an alias has no character
 * to break it at.
 */
export const SHORTCUT_SPLITS: readonly { alias: string; at: number }[] = Object.values(shortcuts as Record<string, string[]>).flat().map(alias => {
    const colon = alias.search(/[:;]/);
    const at = colon >= 0 ? colon : alias.search(/[<-]/);
    if (at < 0) {
        throw new Error(`markdown-it-emoji's shortcut ${JSON.stringify(alias)} has no character the escape breaks it at`);
    }
    return { alias, at };
});

const LETTER_BEFORE = /[\p{L}\p{N}\p{M}]$/u;
const LETTER_AFTER = /^[\p{L}\p{N}\p{M}]/u;

/** Whether the character at `index` of `text` is escaped: an odd run of backslashes before it. */
function escapedAt(text: string, index: number): boolean {
    let run = 0;
    while (index - run - 1 >= 0 && text.charCodeAt(index - run - 1) === 0x5c) {
        run++;
    }
    return run % 2 === 1;
}

/**
 * Where in `escaped` — text as `esc` wrote it — a backslash goes: before the
 * split character of every shortcut the host could read in it. `links` are
 * the links the host reads in it, `[start, end)` each: a shortcut overlapping
 * one is not read (the plugin skips a link's text) and is left; one touching
 * an edge of one is escaped though a letter stands beside it. A shortcut
 * whose split character is escaped already is broken already.
 */
export function shortcutEscapes(escaped: string, links: readonly (readonly [number, number])[]): Set<number> {
    const at = new Set<number>();
    for (const { alias, at: split } of SHORTCUT_SPLITS) {
        for (let start = escaped.indexOf(alias); start >= 0; start = escaped.indexOf(alias, start + 1)) {
            const end = start + alias.length;
            const index = start + split;
            if (at.has(index) || escapedAt(escaped, index) || links.some(([from, to]) => start < to && end > from)) {
                continue;
            }
            const atLinkEdge = links.some(([from, to]) => start === to || end === from);
            // Two code units either side, so a letter outside the BMP is seen whole.
            const glued = LETTER_BEFORE.test(escaped.slice(Math.max(0, start - 2), start)) || LETTER_AFTER.test(escaped.slice(end, end + 2));
            if (atLinkEdge || !glued) {
                at.add(index);
            }
        }
    }
    return at;
}
