import { MarkdownIt } from '../@types/markdown-it';
// DO NOT USE, or ESBuild will wrap it with an object and break the plugin.
// import * as container from 'markdown-it-container';
const container = require('markdown-it-container');

export function MarkdownItContainer(md: MarkdownIt) {
    md.use(container, "container", { validate: validate, render: render });
}

function validate(): boolean {
    return true;
}

function render(tokens: any, idx: any): string {
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
    return str.replace(/"/g, '&quot;',)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}