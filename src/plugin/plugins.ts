import { MarkdownItTOC } from './markdownItTOC';
import { MarkdownItContainer } from './markdownItContainer';
import { MarkdownItAnchorLink } from './markdownItAnchorLink';
import { MarkdownItExportHelper } from './markdownItExportHelper';
import { MarkdownItAdmonition } from './markdownItAdmonition';
import { MarkdownItAttrs } from './markdownItAttrs';
import { Config } from '../services/common/config';
import { MarkdownIt } from '../@types/markdown-it';
import { INLINE_PLUGINS, MULTIMD_TABLE_OPTIONS } from './inlinePlugins';

// Import all external markdown-it plugins statically for bundling
import markdownItAbbr from 'markdown-it-abbr';
import markdownItCheckbox from 'markdown-it-checkbox';
import markdownItIb from 'markdown-it-ib';
import markdownItDeflist from 'markdown-it-deflist';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItMultimdTable from 'markdown-it-multimd-table';
import markdownItHtml5Embed from 'markdown-it-html5-embed';
import markdownItTableOfContents from 'markdown-it-table-of-contents';
import markdownItCjkFriendly from 'markdown-it-cjk-friendly';

interface MarkdownItPlugin {
    /** Its name in the registry below (`markdown-it-sidenote`). */
    name: string;
    plugin: (md: MarkdownIt, ...args: any[]) => void;
    args: any[];
}

const myPlugins: Record<string, any> = {
    'markdown-it-toc': MarkdownItTOC,
    'markdown-it-container': MarkdownItContainer,
    'markdown-it-admonition': MarkdownItAdmonition,
    'markdown-it-anchor': MarkdownItAnchorLink,
    'markdown-it-helper': MarkdownItExportHelper,
    // The plugins with an inline rule, which the Visual Editor's page runs too
    // (`inlinePlugins.ts`): footnote, sup-alt, sub-alt, kbd, mark, sidenote,
    // bracketed-spans.
    ...INLINE_PLUGINS,
    // External plugins - now statically imported for bundling
    'markdown-it-abbr': markdownItAbbr,
    'markdown-it-checkbox': markdownItCheckbox,
    // Wrapped: leaves the spans markdown-it-multimd-table laid out alone.
    'markdown-it-attrs': MarkdownItAttrs,
    'markdown-it-ib': markdownItIb,
    'markdown-it-deflist': markdownItDeflist,
    'markdown-it-emoji': markdownItEmoji,
    'markdown-it-multimd-table': markdownItMultimdTable,
    'markdown-it-html5-embed': markdownItHtml5Embed,
    'markdown-it-table-of-contents': markdownItTableOfContents,
    'markdown-it-cjk-friendly': markdownItCjkFriendly,
}

export const plugins: MarkdownItPlugin[] = [
    // YAML front matter is handled natively: VS Code's built-in markdown preview
    // renders/hides it (per `markdown.preview.frontMatter`), and the export
    // pipeline strips it in MarkdownDocument. We intentionally do NOT register
    // markdown-it-front-matter here, as it conflicts with the built-in renderer.
    // $('markdown-it-toc'),
    // $('markdown-it-anchor'), // MarkdownItAnchorLink requires MarkdownItTOC
    $('markdown-it-table-of-contents', { includeLevel: Config.instance.tocLevels }),
    $('markdown-it-container'),
    $('markdown-it-admonition'),
    $('markdown-it-footnote'),
    $('markdown-it-abbr'),
    $('markdown-it-sup-alt'),
    $('markdown-it-sub-alt'),
    $('markdown-it-checkbox'),
    $('markdown-it-attrs'),
    $('markdown-it-kbd'),
    $('markdown-it-ib'),
    $('markdown-it-mark'),
    $('markdown-it-deflist'),
    $('markdown-it-emoji'),
    $('markdown-it-multimd-table', MULTIMD_TABLE_OPTIONS),
    // Registered once per syntax: markdown-it-html5-embed 0.3.3 keeps the
    // default image rule and the default link rule in one hoisted `var`, so
    // with both options in one call every image is rendered by the link's
    // default and loses its alt text (`<img alt="">`).
    $('markdown-it-html5-embed', { html5embed: { useImageSyntax: true } }),
    $('markdown-it-html5-embed', { html5embed: { useLinkSyntax: true } }),
    $('markdown-it-sidenote'),
    $('markdown-it-helper'),
    $('markdown-it-bracketed-spans'),
    // Make CommonMark emphasis (**bold**, *italic*) work correctly adjacent to
    // CJK (Chinese/Japanese/Korean) characters and punctuation.
    $('markdown-it-cjk-friendly')
].filter(p => !!p);

function $(name: string, ...args: any[]): MarkdownItPlugin | undefined {
    if (Config.instance.disabledPlugins.some(d => `markdown-it-${d}` === name)) {return;}
    
    const plugin = myPlugins[name];
    
    return plugin ? { name, plugin, args } : undefined;
}