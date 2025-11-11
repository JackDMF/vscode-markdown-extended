import { MarkdownItTOC } from './markdownItTOC';
import { MarkdownItContainer } from './markdownItContainer';
import { MarkdownItAnchorLink } from './markdownItAnchorLink';
import { MarkdownItExportHelper } from './markdownItExportHelper';
import { MarkdownItAdmonition } from './markdownItAdmonition';
import { Config } from '../services/common/config';
// eslint-disable-next-line @typescript-eslint/naming-convention
import * as MarkdownItSidenote from './markdownItSidenote';
import { MarkdownIt } from '../@types/markdown-it';

// Import all external markdown-it plugins statically for bundling
import markdownItFootnote from 'markdown-it-footnote';
import markdownItAbbr from 'markdown-it-abbr';
import markdownItSupAlt from 'markdown-it-sup-alt';
import markdownItSubAlt from 'markdown-it-sub-alt';
import markdownItCheckbox from 'markdown-it-checkbox';
import markdownItAttrs from 'markdown-it-attrs';
import markdownItKbd from 'markdown-it-kbd';
import markdownItIb from 'markdown-it-ib';
import markdownItMark from 'markdown-it-mark';
import markdownItDeflist from 'markdown-it-deflist';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItMultimdTable from 'markdown-it-multimd-table';
import markdownItHtml5Embed from 'markdown-it-html5-embed';
import markdownItBracketedSpans from 'markdown-it-bracketed-spans';
import markdownItTableOfContents from 'markdown-it-table-of-contents';

interface MarkdownItPlugin {
    plugin: (md: MarkdownIt, ...args: any[]) => void;
    args: any[];
}

const myPlugins: Record<string, any> = {
    'markdown-it-toc': MarkdownItTOC,
    'markdown-it-container': MarkdownItContainer,
    'markdown-it-admonition': MarkdownItAdmonition,
    'markdown-it-anchor': MarkdownItAnchorLink,
    'markdown-it-helper': MarkdownItExportHelper,
    'markdown-it-sidenote': MarkdownItSidenote.default,
    // External plugins - now statically imported for bundling
    'markdown-it-footnote': markdownItFootnote,
    'markdown-it-abbr': markdownItAbbr,
    'markdown-it-sup-alt': markdownItSupAlt,
    'markdown-it-sub-alt': markdownItSubAlt,
    'markdown-it-checkbox': markdownItCheckbox,
    'markdown-it-attrs': markdownItAttrs,
    'markdown-it-kbd': markdownItKbd,
    'markdown-it-ib': markdownItIb,
    'markdown-it-mark': markdownItMark,
    'markdown-it-deflist': markdownItDeflist,
    'markdown-it-emoji': markdownItEmoji,
    'markdown-it-multimd-table': markdownItMultimdTable,
    'markdown-it-html5-embed': markdownItHtml5Embed,
    'markdown-it-bracketed-spans': markdownItBracketedSpans,
    'markdown-it-table-of-contents': markdownItTableOfContents,
}

export const plugins: MarkdownItPlugin[] = [
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
    $('markdown-it-multimd-table', { multiline: true, rowspan: true, headerless: true }),
    $('markdown-it-html5-embed', { html5embed: { useImageSyntax: true, useLinkSyntax: true } }),
    $('markdown-it-sidenote'),
    $('markdown-it-helper'),
    $('markdown-it-bracketed-spans')
].filter(p => !!p);

function $(name: string, ...args: any[]): MarkdownItPlugin | undefined {
    if (Config.instance.disabledPlugins.some(d => `markdown-it-${d}` === name)) {return;}
    
    const plugin = myPlugins[name];
    
    return plugin ? { plugin, args } : undefined;
}