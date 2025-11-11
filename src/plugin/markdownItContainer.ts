import { MarkdownIt } from '../@types/markdown-it';
// Use default import for CommonJS module
// eslint-disable-next-line @typescript-eslint/no-require-imports
import container = require('markdown-it-container');

/**
 * Markdown-it plugin wrapper for markdown-it-container with custom validation and rendering.
 * This plugin is compatible with markdown-it's plugin system - do NOT call md.use() inside it.
 * 
 * @param md - The markdown-it instance
 */
export function MarkdownItContainer(md: MarkdownIt): void {
    // Apply the container plugin directly (not via md.use())
    // markdown-it-container is a CommonJS module that exports a function directly
    container(md, "container", { validate: validate, render: render });
}

function validate(): boolean {
    return true;
}

function render(tokens, idx): string {
    if (tokens[idx].nesting === 1) {
        // opening tag 
        const cls = escape(tokens[idx].info.trim());
        return `<div class="${cls}">\n`;
    } else {
        // closing tag 
        return '</div>\n';
    }
}

function escape(str: string): string {
    return str.replace(/"/g, '&quot;', )
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}