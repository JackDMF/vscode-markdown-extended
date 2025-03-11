import { MarkdownItTOC } from './markdownItTOC';
import { MarkdownItContainer } from './markdownItContainer';
import { MarkdownItAnchorLink } from './markdownItAnchorLink';
import { MarkdownItExportHelper } from './markdownItExportHelper';
import { MarkdownItAdmonition } from './markdownItAdmonition';
import { config } from '../services/common/config';
import * as MarkdownItSidenote from './markdownItSidenote';
import { MarkdownIt } from '../@types/markdown-it';

interface markdownItPlugin {
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
}

export var plugins: markdownItPlugin[] = [
    // $('markdown-it-toc'),
    // $('markdown-it-anchor'), // MarkdownItAnchorLink requires MarkdownItTOC
    $('markdown-it-table-of-contents', { includeLevel: config.tocLevels }),
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

function $(name: string, ...args: any[]): markdownItPlugin | undefined {
    if (config.disabledPlugins.some(d => `markdown-it-${d}` === name)) return;
    
    const plugin = myPlugins[name] || (() => {
        try { return require(name); } 
        catch (e) { console.error(`Plugin ${name} fehlgeschlagen:`, e); }
    })();
    
    return plugin ? { plugin, args } : undefined;
}