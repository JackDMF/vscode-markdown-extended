import { MarkdownIt, Token } from '../@types/markdown-it';
// Use default import for CommonJS module
import toc = require('markdown-it-table-of-contents');
import { slugify } from './shared';
import { config } from '../services/common/config';

/**
 * Markdown-it plugin for table of contents with anchor links.
 * This plugin is compatible with markdown-it's plugin system - do NOT call md.use() inside it.
 * 
 * @param md - The markdown-it instance
 */
export function MarkdownItTOC(md: MarkdownIt): void {
    md.renderer.rules.tocAnchor = renderHtml;
    md.core.ruler.push("tocAnchor", tocAnchorWorker);
    
    // Apply the toc plugin directly (not via md.use())
    // markdown-it-table-of-contents is a CommonJS module that exports a function directly
    toc(md, { slugify: slugify, includeLevel: config.tocLevels });
}

function renderHtml(tokens: Token[], idx: number) {
    // console.log("request anchor for:", idx, tokens[idx].content);
    let token = tokens[idx];
    if (token.type !== "tocAnchor") return tokens[idx].content;
    return `<a for="toc-anchor" id="${slugify(token.content)}"></a>`;
}

function tocAnchorWorker(state: any) {
    let tokens: Token[] = [];
    state.tokens.map((t, i, ts) => {
        if (t.type == "heading_open") {
            let anchor = new state.Token("tocAnchor", "a", 0);
            anchor.content = ts[i + 1].content;
            tokens.push(anchor);
        }
        tokens.push(t);
    });
    state.tokens = tokens;
}