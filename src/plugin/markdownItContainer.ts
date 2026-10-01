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
// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItContainer(md: MarkdownIt): void {
    // Apply the container plugin directly (not via md.use())
    // markdown-it-container is a CommonJS module that exports a function directly
    container(md, "container", { validate: validate, render: render });
}

function validate(): boolean {
    return true;
}

/**
 * The container's `div`, rendered from its token so that what markdown-it-attrs
 * put there from a `{…}` on the `:::` line reaches it (qjebbs/vscode-markdown-extended#126):
 * the info, trimmed, is the first of its classes, the literal's classes after it,
 * then its id and other attributes. The renderer escapes every value. The token
 * keeps its own attributes, so a second render gives the same `div`.
 */
function render(tokens, idx, options, env, self): string {
    const token = tokens[idx];
    if (token.nesting !== 1) {
        return self.renderToken(tokens, idx, options, env, self);
    }
    const own = token.attrs;
    const classes = [token.info.trim(), token.attrGet('class') ?? ''].filter(c => c !== '');
    token.attrs = [['class', classes.join(' ')], ...(own ?? []).filter(([name]) => name !== 'class')];
    try {
        return self.renderToken(tokens, idx, options, env, self);
    } finally {
        token.attrs = own;
    }
}