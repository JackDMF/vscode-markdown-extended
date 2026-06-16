import { MarkdownItTOC } from './markdownItTOC';
import { MarkdownItContainer } from './markdownItContainer';
import { MarkdownItAnchorLink } from './markdownItAnchorLink';
import { MarkdownItExportHelper } from './markdownItExportHelper';
import { MarkdownItAdmonition } from './markdownItAdmonition';
import { config } from '../services/common/config';

interface markdowItPlugin {
    plugin: Function,
    args: object[],
}

let myPlugins: Record<string, Function> = {
    'markdown-it-toc': MarkdownItTOC,
    'markdown-it-container': MarkdownItContainer,
    'markdown-it-admonition': MarkdownItAdmonition,
    'markdown-it-anchor': MarkdownItAnchorLink,
    'markdown-it-helper': MarkdownItExportHelper,
}

// Static require map MUST be defined before plugins array (esbuild bundles var hoisting)
const pluginRequireMap: Record<string, any> = {
    'markdown-it-table-of-contents': require('markdown-it-table-of-contents'),
    'markdown-it-footnote': require('markdown-it-footnote'),
    'markdown-it-abbr': require('markdown-it-abbr'),
    'markdown-it-sup': require('markdown-it-sup'),
    'markdown-it-sub': require('markdown-it-sub'),
    'markdown-it-checkbox': require('markdown-it-checkbox'),
    'markdown-it-attrs': require('markdown-it-attrs'),
    'markdown-it-kbd': require('markdown-it-kbd'),
    'markdown-it-underline': require('markdown-it-underline'),
    'markdown-it-mark': require('markdown-it-mark'),
    'markdown-it-deflist': require('markdown-it-deflist'),
    'markdown-it-emoji': require('markdown-it-emoji'),
    'markdown-it-multimd-table': require('markdown-it-multimd-table'),
    'markdown-it-html5-embed': require('markdown-it-html5-embed'),
    'markdown-it-bracketed-spans': require('markdown-it-bracketed-spans'),
};

function $(name: string, ...args: any[]): markdowItPlugin | undefined {
    for (let d of config.disabledPlugins) {
        if ('markdown-it-' + d == name) return undefined;
    }
    let plugin = myPlugins[name];
    if (!plugin) plugin = pluginRequireMap[name];
    if (!plugin) return undefined;
    return {
        plugin: plugin,
        args: args,
    }
}

export var plugins: markdowItPlugin[] = [
    // $('markdown-it-toc'),
    // $('markdown-it-anchor'), // MarkdownItAnchorLink requires MarkdownItTOC
    $('markdown-it-table-of-contents', { includeLevel: config.tocLevels }),
    $('markdown-it-container'),
    $('markdown-it-admonition'),
    $('markdown-it-footnote'),
    $('markdown-it-abbr'),
    $('markdown-it-sup'),
    $('markdown-it-sub'),
    $('markdown-it-checkbox'),
    $('markdown-it-attrs'),
    $('markdown-it-kbd'),
    $('markdown-it-underline'),
    $('markdown-it-mark'),
    $('markdown-it-deflist'),
    $('markdown-it-emoji'),
    $('markdown-it-multimd-table', { multiline: true, rowspan: true, headerless: true }),
    $('markdown-it-html5-embed', { html5embed: { useImageSyntax: true, useLinkSyntax: true } }),
    $('markdown-it-helper'),
    $('markdown-it-bracketed-spans')
].filter(p => !!p);