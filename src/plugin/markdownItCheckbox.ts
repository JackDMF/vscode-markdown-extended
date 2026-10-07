import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import { VOID_ELEMENTS } from '../syntax/voidElements';

// Our own rule in place of markdown-it-checkbox's, rendering the same markup
// (`<input type="checkbox" id="checkboxN"><label for="checkboxN">…</label>`)
// from the same tokens, so stylesheets, the export and the Visual Editor see
// no difference. The plugin's rule dropped the text before a box (`para [ ]
// mid` rendered only the box and `mid`), took a box out of any token with
// content — a code span included — and ran after `text_join`, so an escaped
// `\[x\]` was a box too. This one runs before the join, where an escaped
// bracket is still a `text_special` token of its own: a box is written in one
// text token, at the start of the text or after whitespace, and followed by
// whitespace. Its label is the task's whole text after it, formatting
// included — up to the next box outside any element the label takes in, or
// the end of the element the box stands in, an HTML one included — where the
// plugin's stopped at the first token that was not text (`[ ] task **one**`
// labelled only `task `, and a bold task nothing). A box inside an element the
// label takes in (`[ ] a *b [x] c*`, a line's start included) stays text, as
// no label holds another.
const BOX = /(^|\s)\[(x|\s|_|-)\]\s/i;

// The foreign-content elements whose `/>` closes them, as in HTML.
const SELF_CLOSING_FOREIGN = new Set(['svg', 'math']);

type TokenConstructor = new (type: string, tag: string, nesting: number) => Token;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItCheckbox(md: MarkdownIt) {
    // Per engine and never reset, as in the plugin.
    let lastId = 0;
    md.core.ruler.before('text_join', 'checkbox', (state: StateBase) => {
        const textToken = state.Token as TokenConstructor;
        for (const token of state.tokens) {
            if (token.type !== 'inline' || !token.children) { continue; }
            const children = withBoxes(token.children, (checked, label) => box(textToken, `checkbox${lastId++}`, checked, label));
            if (children) { token.children = children; }
        }
    });
}

function isText(token: Token | undefined): boolean {
    return !!token && (token.type === 'text' || token.type === 'text_special');
}

// The children with each run of text's first box made, or undefined when
// there is none.
function withBoxes(tokens: Token[], make: (checked: boolean, label: Token[]) => Token[]): Token[] | undefined {
    // A copy: the text a label takes in before the next box is cut from that box's token.
    const children = tokens.slice();
    let result: Token[] | undefined;
    let i = 0;
    while (i < children.length) {
        if (!isText(children[i])) {
            result?.push(children[i]);
            i++;
            continue;
        }
        let end = i;
        while (isText(children[end + 1])) { end++; }
        const found = findBox(children, i, end);
        if (!found) {
            result?.push(...children.slice(i, end + 1));
            i = end + 1;
            continue;
        }
        result ??= children.slice(0, i);
        const [at, match] = found;
        const token = children[at];
        const start = match.index + match[1].length;
        result.push(...children.slice(i, at));
        if (start > 0) { result.push(text(token, token.content.slice(0, start))); }
        const label = [text(token, token.content.slice(match.index + match[0].length)), ...children.slice(at + 1, end + 1)];
        const [stop, next] = labelEnd(children, end + 1);
        label.push(...children.slice(end + 1, stop));
        i = stop;
        if (next) {
            // The text before the next box is this label's; the box starts its token.
            const [nextAt, nextMatch] = next;
            const nextToken = children[nextAt];
            const before = nextMatch.index + nextMatch[1].length;
            label.push(...children.slice(stop, nextAt));
            if (before > 0) { label.push(text(nextToken, nextToken.content.slice(0, before))); }
            children[nextAt] = text(nextToken, nextToken.content.slice(before));
            i = nextAt;
        }
        // A line break before the next box stays outside the label.
        let close = label.length;
        while (close > 0 && isBreak(label[close - 1])) { close--; }
        result.push(...make(match[2].toLowerCase() === 'x', label.slice(0, close)), ...label.slice(close));
    }
    return result;
}

function isBreak(token: Token): boolean {
    return token.type === 'softbreak' || token.type === 'hardbreak';
}

// Where a label that takes in children from `from` on ends: before the close
// of the element its box stands in, an HTML element's closing tag included, at
// the next box outside the elements it takes in (returned with its run's
// start), or at the end. A box inside an element the label takes in stays
// text, as no label holds another. Inline HTML is a token of its own per tag,
// so its elements are followed by tag name.
function labelEnd(children: Token[], from: number): [number, [number, RegExpExecArray]?] {
    let depth = 0;
    // The HTML elements the label opens, innermost last.
    const opened: string[] = [];
    let j = from;
    while (j < children.length) {
        const token = children[j];
        if (depth === 0 && token.nesting < 0) { return [j]; }
        const tag = token.type === 'html_inline' ? htmlTag(token.content) : undefined;
        if (tag?.closing) {
            const at = opened.lastIndexOf(tag.name);
            if (at >= 0) {
                opened.length = at;
            } else if (depth === 0) {
                // An element opened before the label.
                return [j];
            }
        } else if (tag) {
            opened.push(tag.name);
        }
        if (depth === 0 && opened.length === 0 && isText(token)) {
            let end = j;
            while (isText(children[end + 1])) { end++; }
            const found = findBox(children, j, end);
            if (found) { return [j, found]; }
            j = end + 1;
            continue;
        }
        depth += token.nesting;
        j++;
    }
    return [j];
}

// An inline HTML tag that opens or closes an element, by its lower-cased
// name; undefined for a void tag, a comment or the like. A slash closes
// nothing but a void element's tag: `<span/>` opens a span, as in HTML.
// Foreign content is the exception: `<svg/>` and `<math/>` close themselves.
function htmlTag(content: string): { name: string, closing: boolean } | undefined {
    const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(content);
    if (!match) { return undefined; }
    const name = match[2].toLowerCase();
    if (VOID_ELEMENTS.has(name)) { return undefined; }
    if (!match[1] && SELF_CLOSING_FOREIGN.has(name) && /\/>$/.test(content)) { return undefined; }
    return { name, closing: !!match[1] };
}

// The first box in children[from..to], one run of text: in a text token,
// at the start of the run or after whitespace.
function findBox(children: Token[], from: number, to: number): [number, RegExpExecArray] | undefined {
    for (let at = from; at <= to; at++) {
        const token = children[at];
        if (token.type !== 'text') { continue; }
        const match = BOX.exec(token.content);
        if (!match) { continue; }
        const before = at === from ? '' : children[at - 1].content.slice(-1);
        if (match[1] || at === from || /\s/.test(before)) { return [at, match]; }
        // A box right after an escape (`\*[x] a`) is no box; one later in the
        // same token still is. Same groups as BOX, so the caller reads both alike.
        const later = /(\s)\[(x|\s|_|-)\]\s/i.exec(token.content);
        if (later) { return [at, later]; }
    }
    return undefined;
}

function text(like: Token, content: string): Token {
    const token = Object.assign(Object.create(Object.getPrototypeOf(like)), like) as Token;
    token.content = content;
    return token;
}

function box(textToken: TokenConstructor, id: string, checked: boolean, label: Token[]): Token[] {
    const input = new textToken('checkbox_input', 'input', 0);
    input.attrs = [['type', 'checkbox'], ['id', id]];
    if (checked) { input.attrs.push(['checked', 'true']); }
    const open = new textToken('label_open', 'label', 1);
    open.attrs = [['for', id]];
    return [input, open, ...label, new textToken('label_close', 'label', -1)];
}
