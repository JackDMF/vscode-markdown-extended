import { MarkdownIt } from '../@types/markdown-it';
import * as container from 'markdown-it-container';

/**
 * Markdown-it plugin wrapper for markdown-it-container with custom validation and rendering.
 * This plugin is compatible with markdown-it's plugin system - do NOT call md.use() inside it.
 * 
 * @param md - The markdown-it instance
 */
export function MarkdownItContainer(md: MarkdownIt): void {
    // Apply the container plugin directly (not via md.use())
    // This is the proper way to write a markdown-it plugin
    const containerPlugin = container as any;
    containerPlugin(md, "container", { validate: validate, render: render });
}

function validate(): boolean {
    return true;
}

function render(tokens, idx): string {
    if (tokens[idx].nesting === 1) {
        // opening tag 
        let cls = escape(tokens[idx].info.trim());
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