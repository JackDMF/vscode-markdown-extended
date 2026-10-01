import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import { WIKI_EMBED_MARKERS, WIKI_EMBED_META } from '../syntax/markers';

// A wiki embed, `![[path/to/img.png]]`, read as one run of literal text
// (qjebbs/vscode-markdown-extended#168). markdown-it-kbd read its `[[…]]` as a
// key and rendered `!<kbd>path/to/img.png</kbd>`, so Foam, whose embed rule
// searches the text of the finished parse, never saw its embed.
//
// The rule starts at the `!`. A `!` a backslash escapes was taken by the
// escape rule before it, and the closing `!!` of a marginal note by the notes
// rule (`!!ref|note!![[Ctrl]]` keeps its key). It comes before `image`, so
// `![[x]](y)` is the embed and the text `(y)`, as Foam reads it, not an image.
// The name holds no bracket and no line break, as Foam's own rule asks, so
// `![[x [[Ctrl]] y]]` is no embed: a `!` and a key.
//
// The token is turned into plain text just before `text_join`, after the
// rules that rewrite text (typographer, emoji, linkify) have passed it by, so
// the embed's name reaches the page, and Foam, exactly as written.
const RULE = 'wiki_embed';
const OPEN = WIKI_EMBED_MARKERS.open;
const CLOSE = WIKI_EMBED_MARKERS.close;

function tokenize(state: StateBase, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos as number;
    const max = state.posMax as number;
    if (!src.startsWith(OPEN, start)) { return false; }
    const end = src.indexOf(CLOSE, start + OPEN.length);
    if (end < 0 || end + CLOSE.length > max) { return false; }
    const name = src.slice(start + OPEN.length, end);
    if (!name || /[[\]\n]/.test(name)) { return false; }
    if (!silent) {
        const push = state.push as (type: string, tag: string, nesting: number) => Token;
        push.call(state, RULE, '', 0).content = src.slice(start, end + CLOSE.length);
    }
    state.pos = end + CLOSE.length;
    return true;
}

function asText(tokens: Token[] | null | undefined): boolean {
    let found = false;
    for (const token of tokens ?? []) {
        if (token.type === RULE) {
            token.type = 'text';
            found = true;
        }
        // An image's alt text is its children.
        found = asText(token.children) || found;
    }
    return found;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItWikiEmbed(md: MarkdownIt) {
    md.inline.ruler.before('image', RULE, tokenize);
    const toText = (state: StateBase) => {
        for (const token of state.tokens) {
            if (token.type === 'inline' && asText(token.children)) {
                token.meta = { ...((token.meta as Record<string, unknown> | null) ?? {}), [WIKI_EMBED_META]: true };
            }
        }
    };
    try {
        md.core.ruler.before('text_join', RULE, toText);
    } catch {
        // markdown-it before 13 has no `text_join`.
        md.core.ruler.push(RULE, toText);
    }
    // Should a plugin keep the token from reaching the core rule, it is still the text it was.
    md.renderer.rules[RULE] = (tokens: Token[], idx: number) => md.utils.escapeHtml(tokens[idx].content);
}
