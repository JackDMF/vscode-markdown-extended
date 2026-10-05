// eslint-disable-next-line @typescript-eslint/naming-convention
import * as MarkdownItSidenote from './markdownItSidenote';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItSupAlt from 'markdown-it-sup-alt';
import markdownItSubAlt from 'markdown-it-sub-alt';
import markdownItKbd from 'markdown-it-kbd';
import markdownItMark from 'markdown-it-mark';
import markdownItBracketedSpans from 'markdown-it-bracketed-spans';

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
 * - The block plugins (container, admonition, deflist, the tables, the table
 *   of contents) and markdown-it-html5-embed, which only renders: they read no
 *   inline text.
 * - The core rules that run after the inline parse — markdown-it-emoji,
 *   markdown-it-abbr, markdown-it-checkbox, markdown-it-attrs (and its wrapper)
 *   — and markdown-it-ib, which only renders: they rewrite text tokens or move
 *   attributes onto tokens the inline parse made, and never make or unmake a
 *   sidebar's tokens.
 * - markdown-it-cjk-friendly: it changes which emphasis delimiters open and
 *   close, and an emphasis delimiter never takes a sidebar's marker.
 * - The export helper (`markdownItExportHelper.ts`), which reads the file
 *   system for the export and is no part of reading the text.
 */
export const INLINE_PLUGINS = {
    'markdown-it-footnote': markdownItFootnote,
    'markdown-it-sup-alt': markdownItSupAlt,
    'markdown-it-sub-alt': markdownItSubAlt,
    'markdown-it-kbd': markdownItKbd,
    'markdown-it-mark': markdownItMark,
    'markdown-it-sidenote': MarkdownItSidenote.default,
    'markdown-it-bracketed-spans': markdownItBracketedSpans,
} as const;

/** The registry name of a plugin the page runs. */
export type InlinePluginName = keyof typeof INLINE_PLUGINS;

export function isInlinePlugin(name: string): name is InlinePluginName {
    return Object.prototype.hasOwnProperty.call(INLINE_PLUGINS, name);
}
