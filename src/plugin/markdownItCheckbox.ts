import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import markdownItCheckbox from 'markdown-it-checkbox';

// markdown-it-checkbox turns a text token holding `[ ] label` into the box and
// its label, and drops whatever stood before the box: `para [ ] mid` renders
// only the box and `mid`. It also asks for a space after the box, so a bare
// `[ ]` or `[x]` — the whole of a table cell, or of a paragraph — is never a
// box (qjebbs/vscode-markdown-extended#158). Before its rule runs, the text
// before a box is therefore split into a token of its own, and a box that ends
// its line gets the space the plugin asks for; its label stays empty.
//
// The plugin runs after `text_join`, which has already merged an escaped
// `\[x\]` into the text around it. Where the escapes were is noted before the
// join, and the text is split at them too, so the plugin never sees a bracket
// the author escaped as the edge of a box.
const BOX = /\[(x|\s|_|-)\](?=\s|$)/i;
const ESCAPES = 'mepCheckboxEscapes';

type TokenConstructor = new (type: string, tag: string, nesting: number) => Token;
type Meta = Record<string, unknown> | null | undefined;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItCheckbox(md: MarkdownIt, ...args: any[]) {
    md.use(markdownItCheckbox, ...args);
    md.core.ruler.before('text_join', 'mep_checkbox_escapes', (state: StateBase) => {
        for (const token of state.tokens) {
            if (token.type === 'inline' && token.children) { noteEscapes(token.children); }
        }
    });
    md.core.ruler.before('checkbox', 'mep_checkbox_split', (state: StateBase) => {
        for (const token of state.tokens) {
            if (token.type === 'inline' && token.children) {
                token.children = split(token.children, state.Token as TokenConstructor);
            }
        }
    });
}

function isText(token: Token | undefined): boolean {
    return !!token && (token.type === 'text' || token.type === 'text_special');
}

// `text_join` keeps the last token of each run of text, so the offsets of the
// run's escaped brackets are noted on that one.
function noteEscapes(children: Token[]) {
    let offset = 0;
    let escapes: number[] = [];
    children.forEach((child, i) => {
        if (!isText(child)) { return; }
        if (child.type === 'text_special' && (child.content === '[' || child.content === ']')) {
            escapes.push(offset);
        }
        offset += child.content.length;
        if (isText(children[i + 1])) { return; }
        if (escapes.length) { child.meta = { ...((child.meta as Meta) ?? {}), [ESCAPES]: escapes }; }
        offset = 0;
        escapes = [];
    });
}

// The offsets a text token is cut at: after an escaped `[`, before an escaped
// `]` — so neither is inside a token with the rest of a box — and before the
// first box of each piece in between.
function cuts(content: string, escapes: number[]): number[] {
    const result = new Set<number>();
    for (const at of escapes) { result.add(content[at] === '[' ? at + 1 : at); }
    const bounds = [0, ...[...result].sort((a, b) => a - b), content.length];
    for (let i = 0; i < bounds.length - 1; i++) {
        const match = BOX.exec(content.slice(bounds[i], bounds[i + 1]));
        if (match) { result.add(bounds[i] + match.index); }
    }
    return [...result].filter(at => at > 0 && at < content.length).sort((a, b) => a - b);
}

function split(children: Token[], textToken: TokenConstructor): Token[] {
    const result: Token[] = [];
    children.forEach((child, i) => {
        if (child.type !== 'text') { result.push(child); return; }
        const meta = child.meta as Meta;
        const escapes = (meta?.[ESCAPES] as number[] | undefined) ?? [];
        if (meta) { delete meta[ESCAPES]; }
        const content = child.content;
        let start = 0;
        for (const at of cuts(content, escapes)) {
            const piece = new textToken('text', '', 0);
            piece.content = content.slice(start, at);
            result.push(piece);
            start = at;
        }
        child.content = content.slice(start);
        // A box followed by more of its line (`[ ]**bold**`) is not bare.
        const bare = BOX.exec(child.content);
        if (bare && bare.index === 0 && bare[0].length === child.content.length && endsLine(children[i + 1])) {
            child.content += ' ';
        }
        result.push(child);
    });
    return result;
}

function endsLine(next: Token | undefined): boolean {
    return !next || next.type === 'softbreak' || next.type === 'hardbreak';
}
