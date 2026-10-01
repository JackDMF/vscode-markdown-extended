import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";

// Our own rule in place of markdown-it-checkbox's, rendering the same markup
// (`<input type="checkbox" id="checkboxN"><label for="checkboxN">…</label>`)
// from the same tokens, so stylesheets, the export and the Visual Editor see
// no difference. The plugin's rule dropped the text before a box (`para [ ]
// mid` rendered only the box and `mid`), took a box out of any token with
// content — a code span included — and ran after `text_join`, so an escaped
// `\[x\]` was a box too. This one runs before the join, where an escaped
// bracket is still a `text_special` token of its own: a box is written in one
// text token, at the start of the text or after whitespace, and followed by
// whitespace. Its label is the rest of the text, up to the next token that is
// not text, as the plugin's was.
const BOX = /(^|\s)\[(x|\s|_|-)\]\s/i;

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
function withBoxes(children: Token[], make: (checked: boolean, label: Token[]) => Token[]): Token[] | undefined {
    let result: Token[] | undefined;
    let i = 0;
    while (i < children.length) {
        if (!isText(children[i])) { i++; continue; }
        let end = i;
        while (isText(children[end + 1])) { end++; }
        const found = findBox(children, i, end);
        if (found) {
            result ??= children.slice(0, i);
            const [at, match] = found;
            const token = children[at];
            const start = match.index + match[1].length;
            result.push(...children.slice(i, at));
            if (start > 0) { result.push(text(token, token.content.slice(0, start))); }
            const label = [text(token, token.content.slice(match.index + match[0].length)), ...children.slice(at + 1, end + 1)];
            result.push(...make(match[2].toLowerCase() === 'x', label));
        } else if (result) {
            result.push(...children.slice(i, end + 1));
        }
        i = end + 1;
        // Non-text tokens up to the next run, kept as they are.
        while (i < children.length && !isText(children[i])) {
            if (result) { result.push(children[i]); }
            i++;
        }
    }
    return result;
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
        // same token still is.
        const later = /\s\[(x|\s|_|-)\]\s/i.exec(token.content);
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
