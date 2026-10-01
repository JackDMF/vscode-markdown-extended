import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import { WIKI_EMBED_MARKERS, WIKI_EMBED_TOKENS_OPTION } from '../syntax/markers';

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
// The token's `content` is the embed's text as markdown-it would have read it
// without this rule — escapes and character references resolved
// (`![[img.png\|300]]` in a table is `![[img.png|300]]`) — and `meta.source`
// its source as written. Just before `text_join`, after the rules that rewrite
// text (typographer, emoji, linkify) have passed it by, the token becomes plain
// text and joins the text around it, so an extension that renders embeds from
// text (Foam) finds it. An engine whose options set `WIKI_EMBED_TOKENS_OPTION`
// (the Visual Editor's) keeps the token, which it edits as one atom. The notes
// plugin parses a note's parts with the same engine, so a note's embed is kept
// or joined by the same option.
//
// A `{…}` right after an embed stays text: Foam and Obsidian have no
// attributes on an embed, and markdown-it-attrs would otherwise read it as the
// paragraph's (`![[x]]{.cls}`). Its `{` is pushed as `text_special`, which
// attrs does not read and `text_join` makes text again.
export const WIKI_EMBED_TOKEN = 'wiki_embed';

const OPEN = WIKI_EMBED_MARKERS.open;
const CLOSE = WIKI_EMBED_MARKERS.close;
const BRACKET_OPEN = 0x5b;
const BRACKET_CLOSE = 0x5d;
const NEWLINE = 0x0a;
const BRACE_OPEN = 0x7b;

type Push = (type: string, tag: string, nesting: number) => Token;

/** markdown-it's `utils`, which the typings leave out. */
type Utils = { unescapeAll(str: string): string; escapeHtml(str: string): string };

function utils(md: MarkdownIt): Utils {
    return (md as unknown as { utils: Utils }).utils;
}

function wikiEmbed(state: StateBase, silent: boolean): boolean {
    const src = state.src;
    const start = state.pos as number;
    const max = state.posMax as number;
    if (!src.startsWith(OPEN, start)) { return false; }
    // Forward to the first bracket or line break: each attempt stops at the
    // next `[`, so a line of unclosed `![[a ` is read in linear time.
    let at = start + OPEN.length;
    while (at < max) {
        const code = src.charCodeAt(at);
        if (code === BRACKET_OPEN || code === NEWLINE) { return false; }
        if (code === BRACKET_CLOSE) { break; }
        at++;
    }
    if (at === start + OPEN.length || at + CLOSE.length > max || !src.startsWith(CLOSE, at)) { return false; }
    const end = at + CLOSE.length;
    if (!silent) {
        const push = state.push as Push;
        const source = src.slice(start, end);
        const token = push.call(state, WIKI_EMBED_TOKEN, '', 0);
        token.content = utils(state.md as MarkdownIt).unescapeAll(source);
        token.meta = { source };
        if (end < max && src.charCodeAt(end) === BRACE_OPEN) {
            const brace = push.call(state, 'text_special', '', 0);
            brace.content = '{';
            brace.markup = '{';
            state.pos = end + 1;
            return true;
        }
    }
    state.pos = end;
    return true;
}

function joinAsText(tokens: Token[] | null | undefined): void {
    for (const token of tokens ?? []) {
        if (token.type === WIKI_EMBED_TOKEN) {
            token.type = 'text';
        }
        // An image's alt text is its children.
        joinAsText(token.children);
    }
}

/** Whether `md` reads wiki embeds: this plugin is registered, not disabled. */
export function readsWikiEmbeds(md: MarkdownIt): boolean {
    return md.inline.ruler.getRules('').includes(wikiEmbed);
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItWikiEmbed(md: MarkdownIt) {
    md.inline.ruler.before('image', WIKI_EMBED_TOKEN, wikiEmbed);
    md.core.ruler.before('text_join', WIKI_EMBED_TOKEN, (state: StateBase) => {
        if ((md as unknown as { options: Record<string, unknown> }).options[WIKI_EMBED_TOKENS_OPTION]) { return; }
        for (const token of state.tokens) {
            if (token.type === 'inline') { joinAsText(token.children); }
        }
    });
    // Where the token is kept, everything rendered from it shows the text the
    // preview shows: the rule for the element, and markdown-it's own reader of
    // an element's text (an image's alt), which reads only `text` tokens.
    md.renderer.rules[WIKI_EMBED_TOKEN] = (tokens: Token[], idx: number) => utils(md).escapeHtml(tokens[idx].content);
    const renderer = md.renderer as unknown as { renderInlineAsText(tokens: Token[], ...rest: unknown[]): string };
    const asText = renderer.renderInlineAsText;
    renderer.renderInlineAsText = function (this: unknown, tokens: Token[], ...rest: unknown[]): string {
        const read = tokens.some(t => t.type === WIKI_EMBED_TOKEN)
            ? tokens.map(t => (t.type === WIKI_EMBED_TOKEN ? { ...t, type: 'text' } as Token : t))
            : tokens;
        return asText.call(this, read, ...rest);
    };
}
