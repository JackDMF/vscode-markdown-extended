import { MarkdownIt, RuleBlock, RuleInline, Token } from '../@types/markdown-it';

/**
 * VS Code's math, as far as it decides what is math: the tokenizer of
 * `@vscode/markdown-it-katex` (0.1.x, as VS Code 1.140's `markdown-math`
 * extension bundles it), without KaTeX and without rendering.
 *
 * The host's engine runs the real extension (`extend`), which reads a `$…$`
 * as math ahead of the sidebar rule and of markdown-it-attrs. The page does not
 * bundle it, so where the definition says it runs (`InlineEngineDefinition.math`)
 * the page's engine runs this stand-in instead (`createInlineEngine`): the same
 * rules, registered where the extension registers them, deciding what is math
 * by the same delimiter rules. So a literal holding a `$` is judged by what the
 * preview does with it (`$5 - $10` is no math, `$x$` is), and so is a left
 * sidebar (`$…$`), one answer for both.
 *
 * Ported as the extension calls it (`extendMarkdownIt`): fenced ` ```math `
 * blocks on, which changes only the renderer; bare `\begin` blocks and math in
 * HTML blocks off. A unit test holds the stand-in to the real extension over a
 * corpus of `$` strings.
 */

/** markdown-it's inline state, as far as the rules read it. */
interface InlineState {
    src: string;
    pos: number;
    pending: string;
    tokens: Token[];
    push(type: string, tag: string, nesting: number): Token;
}

/** markdown-it's block state, as far as the rules read it. */
interface BlockState {
    src: string;
    bMarks: number[];
    eMarks: number[];
    tShift: number[];
    blkIndent: number;
    line: number;
    push(type: string, tag: string, nesting: number): Token;
    getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
}

function isWhitespace(ch: string): boolean {
    return /^\s$/u.test(ch);
}

function isWordChar(ch: string): boolean {
    return /^[\w\d]$/u.test(ch);
}

/**
 * Whether the `$` at `pos` can open or close inline math: it opens unless a
 * `$`, a `\` or a word character stands before it, and closes unless a `$` or
 * a word character stands after it (`isValidInlineDelim`).
 */
function inlineDelimiter(state: InlineState, pos: number): { canOpen: boolean; canClose: boolean } {
    const prev = state.src[pos - 1] as string | undefined;
    const ch = state.src[pos];
    const next = state.src[pos + 1] as string | undefined;
    if (ch !== '$') {
        return { canOpen: false, canClose: false };
    }
    const canOpen = prev !== '$' && prev !== '\\' && (prev === undefined || isWhitespace(prev) || !isWordChar(prev));
    const canClose = next !== '$' && (next === undefined || isWhitespace(next) || !isWordChar(next));
    return { canOpen, canClose };
}

/** Whether the `$$` at `pos` can open or close display math inline: no `$` and no `\` before it, no third `$` after (`isValidBlockDelim`). */
function blockDelimiter(state: InlineState, pos: number): boolean {
    const prev = state.src[pos - 1];
    return state.src[pos] === '$' && prev !== '$' && prev !== '\\' && state.src[pos + 1] === '$' && state.src[pos + 2] !== '$';
}

/** The first `delimiter` at or after `from` that no `\` escapes, or -1. */
function unescapedAt(src: string, delimiter: string, from: number): number {
    let match = from;
    while ((match = src.indexOf(delimiter, match)) !== -1) {
        let pos = match - 1;
        while (src[pos] === '\\') {
            pos -= 1;
        }
        if ((match - pos) % 2 === 1) {
            break;
        }
        match += delimiter.length;
    }
    return match;
}

/**
 * `$…$` (`inlineMath`): from a `$` that can open to the first unescaped `$`
 * after it, when that one can close and something stands between. Every `$`
 * it passes over is text; it declines only after an HTML opening tag.
 */
function mathInline(state: InlineState, silent: boolean): boolean {
    if (state.src[state.pos] !== '$') {
        return false;
    }
    const last = state.tokens[state.tokens.length - 1] as Token | undefined;
    if (last?.type === 'html_inline' && /^<\w+.+[^/]>$/.test(last.content)) {
        return false;
    }
    if (!inlineDelimiter(state, state.pos).canOpen) {
        if (!silent) {
            state.pending += '$';
        }
        state.pos += 1;
        return true;
    }
    const start = state.pos + 1;
    const match = unescapedAt(state.src, '$', start);
    if (match === -1) {
        if (!silent) {
            state.pending += '$';
        }
        state.pos = start;
        return true;
    }
    if (match - start === 0) {
        if (!silent) {
            state.pending += '$$';
        }
        state.pos = start + 1;
        return true;
    }
    if (!inlineDelimiter(state, match).canClose) {
        if (!silent) {
            state.pending += '$';
        }
        state.pos = start;
        return true;
    }
    if (!silent) {
        const token = state.push('math_inline', 'math', 0);
        token.markup = '$';
        token.content = state.src.slice(start, match);
    }
    state.pos = match + 1;
    return true;
}

/** `$$…$$` inside a line (`inlineMathBlock`), by the same scheme with `$$`. */
function mathInlineBlock(state: InlineState, silent: boolean): boolean {
    if (state.src.slice(state.pos, state.pos + 2) !== '$$') {
        return false;
    }
    if (!blockDelimiter(state, state.pos)) {
        if (!silent) {
            state.pending += '$$';
        }
        state.pos += 2;
        return true;
    }
    const start = state.pos + 2;
    const match = unescapedAt(state.src, '$$', start);
    if (match === -1) {
        if (!silent) {
            state.pending += '$$';
        }
        state.pos = start;
        return true;
    }
    if (match - start === 0) {
        if (!silent) {
            state.pending += '$$$$';
        }
        state.pos = start + 2;
        return true;
    }
    if (!blockDelimiter(state, match)) {
        if (!silent) {
            state.pending += '$$';
        }
        state.pos = start;
        return true;
    }
    if (!silent) {
        const token = state.push('math_block', 'math', 0);
        token.block = true;
        token.markup = '$$';
        token.content = state.src.slice(start, match);
    }
    state.pos = match + 2;
    return true;
}

/** A `$$` block (`blockMath`): from a line starting with `$$` to the line holding the closing `$$`, or the end of its container. */
function mathBlock(state: BlockState, start: number, end: number, silent: boolean): boolean {
    let found = false;
    let pos = state.bMarks[start] + state.tShift[start];
    let max = state.eMarks[start];
    if (pos + 2 > max || state.src.slice(pos, pos + 2) !== '$$') {
        return false;
    }
    pos += 2;
    let firstLine = state.src.slice(pos, max);
    const closers = [...firstLine.matchAll(/\$\$/g)];
    if (closers.length === 1 && closers[0].index === firstLine.length - 2) {
        firstLine = firstLine.trim().slice(0, -2);
        found = true;
    } else if (closers.length > 1) {
        return false;
    }
    if (silent) {
        return true;
    }
    let lastLine: string | undefined;
    let next = start;
    while (!found) {
        next++;
        if (next >= end) {
            break;
        }
        pos = state.bMarks[next] + state.tShift[next];
        max = state.eMarks[next];
        if (pos < max && state.tShift[next] < state.blkIndent) {
            break;
        }
        const line = state.src.slice(pos, max).trim();
        if (line.slice(-2) === '$$') {
            lastLine = state.src.slice(pos, state.src.slice(0, max).lastIndexOf('$$'));
            found = true;
        } else if (line.includes('$$')) {
            lastLine = state.src.slice(pos, state.src.slice(0, max).trim().indexOf('$$'));
            found = true;
        }
    }
    state.line = next + 1;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = (firstLine && firstLine.trim() ? firstLine + '\n' : '') + state.getLines(start + 1, next, state.tShift[start], true) + (lastLine && lastLine.trim() ? lastLine : '');
    token.map = [start, state.line];
    token.markup = '$$';
    return true;
}

/**
 * The math rules added to `md` where the extension adds them: `math_inline`
 * and then `math_inline_block` right after `escape` (so the second runs
 * first), `math_block` after `blockquote`, interrupting what it interrupts.
 */
export function useMathStandIn(md: MarkdownIt): MarkdownIt {
    md.inline.ruler.after('escape', 'math_inline', mathInline as unknown as RuleInline);
    md.inline.ruler.after('escape', 'math_inline_block', mathInlineBlock as unknown as RuleInline);
    md.block.ruler.after('blockquote', 'math_block', mathBlock as unknown as RuleBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
    return md;
}
