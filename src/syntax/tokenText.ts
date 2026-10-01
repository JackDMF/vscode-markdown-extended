/**
 * The text of a run of markdown-it inline tokens, as the preview shows it:
 * text, escapes (`text_special`, which `text_join` leaves inside an image's
 * children), inline code and wiki embeds (`wiki_embed`, which the Visual
 * Editor's engine keeps as a token of its own, `markdownItWikiEmbed.ts`; its
 * `content` is the embed's text).
 *
 * One reader for every place that takes a heading's or an image's text from
 * tokens — the editor's alt text (`src/editor/parse.ts`), a heading's slug
 * (`src/editor/host/links.ts`), the table of contents' entries
 * (`src/plugin/plugins.ts`) — so the editor's engine and the preview's agree on
 * it although only one of them keeps embeds as tokens.
 *
 * It imports nothing but types, as `markers.ts` does.
 */
import type { Token } from '../@types/markdown-it';

const TEXT_TOKENS: ReadonlySet<string> = new Set(['text', 'text_special', 'code_inline', 'wiki_embed']);

export interface TokenTextOptions {
    /** Count an emoji's rendered character, as a heading's slug does. Default `false`. */
    emoji?: boolean;
    /** Read the children of a token that has them (an image's alt text). Default `true`. */
    nested?: boolean;
}

export function tokenText(tokens: readonly Token[] | null | undefined, options: TokenTextOptions = {}): string {
    const nested = options.nested !== false;
    let out = '';
    for (const t of tokens ?? []) {
        if (TEXT_TOKENS.has(t.type) || (options.emoji === true && t.type === 'emoji')) {
            out += t.content;
        } else if (nested && t.children && t.children.length > 0) {
            out += tokenText(t.children, options);
        }
    }
    return out;
}
