// eslint-disable-next-line @typescript-eslint/naming-convention
import * as MarkdownItSidenote from './markdownItSidenote';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItSupAlt from 'markdown-it-sup-alt';
import markdownItSubAlt from 'markdown-it-sub-alt';
import markdownItKbd from 'markdown-it-kbd';
import { MarkdownItWikiEmbed } from './markdownItWikiEmbed';
import markdownItMark from 'markdown-it-mark';
import markdownItBracketedSpans from 'markdown-it-bracketed-spans';
import { MarkdownItContainer } from './markdownItContainer';
import { MarkdownItAdmonition } from './markdownItAdmonition';
import markdownItMultimdTable from 'markdown-it-multimd-table';

/**
 * The plugins of the registry (`plugins.ts`) that add an inline rule, by their
 * registry name: the ones that decide what the inline parser reads where, and
 * so whether a `$…$` or `@…@` is read as a sidebar and where it ends. The
 * registry takes them from here, and the Visual Editor's page runs the same
 * ones (`src/editor/inlineEngine.ts`), so that its check of an edit
 * (`unwritableInNote`) reads a paragraph as the host's engine does.
 *
 * Left out, each for a reason the page's check can rely on:
 *
 * - The block plugins but those of `PAGE_BLOCK_PLUGINS` (deflist, the table
 *   of contents) and markdown-it-html5-embed, which only renders: they read
 *   no inline text, and the editor writes none of their blocks.
 * - The core rules that run after the inline parse — markdown-it-emoji,
 *   markdown-it-abbr, markdown-it-checkbox, markdown-it-attrs (and its wrapper)
 *   — and markdown-it-ib, which only renders: they rewrite text tokens or move
 *   attributes onto tokens the inline parse made, and never make or unmake a
 *   sidebar's tokens. markdown-it-emoji's shortcuts would still change what
 *   the page's text means; the serializer escapes its whole table where no
 *   letter, digit or mark stands beside it (`emojiShortcuts.ts`), so text the
 *   page writes reads as no emoji, a shortcut at a linkified URL's edge
 *   excepted (`inlineEngine.ts`).
 * - markdown-it-cjk-friendly: it changes which emphasis delimiters open and
 *   close, and an emphasis delimiter never takes a sidebar's marker.
 * - The export helper (`markdownItExportHelper.ts`), which reads the file
 *   system for the export and is no part of reading the text.
 */
export const INLINE_PLUGINS = {
    'markdown-it-footnote': markdownItFootnote,
    'markdown-it-sup-alt': markdownItSupAlt,
    'markdown-it-sub-alt': markdownItSubAlt,
    // Before kbd: `![[...]]` is a wiki embed, read as literal text, never a key.
    'markdown-it-wiki-embed': MarkdownItWikiEmbed,
    'markdown-it-kbd': markdownItKbd,
    'markdown-it-mark': markdownItMark,
    'markdown-it-sidenote': MarkdownItSidenote.default,
    'markdown-it-bracketed-spans': markdownItBracketedSpans,
} as const;

/** The options the registry runs markdown-it-multimd-table with (`plugins.ts`), and so the page. */
export const MULTIMD_TABLE_OPTIONS = { multiline: true, rowspan: true, headerless: true };

/**
 * The registry's block plugins the page runs too, by their registry name: the
 * page reads back a whole block as the save writes it (`unitsOf` in
 * `serialize.ts`) — a container's or an admonition's body inside its fence,
 * a table's rows and the `{…}` line under them as the host's table plugin
 * reads them.
 */
export const PAGE_BLOCK_PLUGINS = {
    'markdown-it-container': MarkdownItContainer,
    'markdown-it-admonition': MarkdownItAdmonition,
    'markdown-it-multimd-table': markdownItMultimdTable,
} as const;

/** Every plugin of the registry the page runs. */
export const PAGE_PLUGINS = { ...PAGE_BLOCK_PLUGINS, ...INLINE_PLUGINS } as const;

/**
 * The page's plugins in the registry's order, with the arguments the registry
 * gives them: what the page reads with until the host has posted its own
 * (`DEFAULT_INLINE_ENGINE`).
 */
export const PAGE_PLUGINS_IN_ORDER: readonly { name: string; args: unknown[] }[] = [
    { name: 'markdown-it-container', args: [] },
    { name: 'markdown-it-admonition', args: [] },
    { name: 'markdown-it-footnote', args: [] },
    { name: 'markdown-it-sup-alt', args: [] },
    { name: 'markdown-it-sub-alt', args: [] },
    { name: 'markdown-it-wiki-embed', args: [] },
    { name: 'markdown-it-kbd', args: [] },
    { name: 'markdown-it-mark', args: [] },
    { name: 'markdown-it-multimd-table', args: [MULTIMD_TABLE_OPTIONS] },
    { name: 'markdown-it-sidenote', args: [] },
    { name: 'markdown-it-bracketed-spans', args: [] },
];

/** The registry name of a plugin the page runs. */
export type PagePluginName = keyof typeof PAGE_PLUGINS;

export function isPagePlugin(name: string): name is PagePluginName {
    return Object.prototype.hasOwnProperty.call(PAGE_PLUGINS, name);
}
