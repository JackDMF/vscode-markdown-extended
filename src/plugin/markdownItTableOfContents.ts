import { MarkdownIt, StateBase, Token } from '../@types/markdown-it';
import markdownItTableOfContents from 'markdown-it-table-of-contents';
import { headingText, slugBuilder, TextToken } from '../syntax/headingSlug';

// markdown-it-table-of-contents links a heading by a slug of its own: percent-
// encoded, never de-duplicated (`What is new?` → `#what-is-new%3F`, a third
// `Setup` → `#setup`). VS Code's preview gives the heading another id
// (`what-is-new`, `setup-2`), so the link landed nowhere. The ids are therefore
// computed here by the preview's own rule (`src/syntax/headingSlug.ts`), at
// render time — when every core rule has had its say about a heading's text
// (markdown-it-checkbox takes `[x]` out of `## [x] Done`) — over every heading
// of the document in order, at every level, as the preview counts them, with
// one builder per render. The plugin is handed copies of the headings carrying
// those ids, and it links a heading by an id it finds on it; it never slugs.
//
// An explicit `{#id}` (markdown-it-attrs) is not used: the preview's heading
// rule sets every heading's id from its slug and overwrites the one the author
// wrote, so `## Title {#custom}` is `id="title"` there, and the TOC links that.
//
// A heading whose slug is empty (`## ???`, `## 🚀`) has `id=""` in the
// preview: nothing a link can name (`href="#"` goes to the top of the page), so
// its entry is its text, unlinked. A heading with no text at all
// (`## ![](x.png)`) has no entry; it still counts for the repeats after it.

const STATE = 'mepTocState';
const TITLE = 'mepTocTitle';

/**
 * `@[toc]`, the marker of markdown-it-toc, optionally with a title:
 * `@[toc](Contents)`, `@[toc](Contents (draft))` — parentheses nested one deep.
 */
const ALIAS = /^@\[toc\](?:\(\s*((?:[^()]|\([^()]*\))*?)\s*\))?\s*$/i;

interface BlockState extends StateBase {
    bMarks: number[];
    eMarks: number[];
    tShift: number[];
    sCount: number[];
    blkIndent: number;
    line: number;
    push(type: string, tag: string, nesting: number): Token;
}

type Meta = Record<string, unknown> | null | undefined;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItTableOfContents(md: MarkdownIt, options: Record<string, unknown> = {}) {
    md.use(markdownItTableOfContents, {
        ...options,
        // Every heading the plugin sees carries its id already; one without
        // (an empty slug) stays unlinked rather than getting the plugin's slug.
        slugify: () => '',
        // The entry's text is the heading's, as the preview reads it (emoji
        // included), written as text: rendering it again as Markdown linkified
        // a URL into a link inside the entry's link, and runs every
        // `md.render` wrapper (the built-in Mermaid's config span) once per entry.
        getTokensText: (tokens: TextToken[]) => headingText({ type: 'inline', content: '', children: tokens }),
        format: (content: string) => md.utils.escapeHtml(content),
    });
    md.block.ruler.before('toc', 'mep_toc_alias', alias, { alt: ['paragraph', 'reference', 'blockquote'] });
    // The parse's state, so a TOC rendered without the rest of the document
    // (the Visual Editor renders a source block's tokens alone) still lists
    // its headings: `state.tokens` is read at render time, as the parse left it.
    md.core.ruler.push('mep_toc_state', (state: StateBase) => {
        for (const token of state.tokens) {
            if (token.type === 'toc_body') {
                token.meta = { ...((token.meta as Meta) ?? {}), [STATE]: state };
            }
        }
    });

    const body = md.renderer.rules.toc_body;
    md.renderer.rules.toc_body = (tokens, idx, opts, env, self) => {
        const meta = tokens[idx].meta as Meta;
        const stream = (meta?.[STATE] as StateBase | undefined)?.tokens ?? tokens;
        const title = meta?.[TITLE] as string | undefined;
        const heading = title ? `<p class="table-of-contents-title">${md.utils.escapeHtml(title)}</p>` : '';
        return heading + body(anchoredHeadings(stream), idx, opts, env, self);
    };
}

/**
 * The headings the TOC lists, each `heading_open` a copy carrying the id the
 * preview gives it, counted over every heading of `stream` as one render does.
 * The `html_block` before a heading goes along, for the plugin's
 * `<!-- omit from toc -->`.
 */
function anchoredHeadings(stream: Token[]): Token[] {
    const slug = slugBuilder();
    const headings: Token[] = [];
    stream.forEach((token, i) => {
        if (token.type !== 'heading_open') { return; }
        const inline = stream[i + 1];
        const text = headingText(inline);
        const id = slug(text);
        if (text.trim() === '') { return; }
        const open = copy(token, 'heading_open', 1);
        if (id !== '') { open.attrs = [['id', id]]; }
        const before = stream[i - 1];
        if (before?.type === 'html_block') { headings.push(before); }
        headings.push(open, inline, copy(token, 'heading_close', -1));
    });
    return headings;
}

/** A bare token of `type` with the heading's tag, made by the heading's own constructor. */
function copy(heading: Token, type: string, nesting: number): Token {
    const make = heading.constructor as new (type: string, tag: string, nesting: number) => Token;
    return new make(type, heading.tag, nesting);
}

/** `@[toc]` on a line of its own: the same tokens as `[[TOC]]`, and the title in brackets if one is written. */
function alias(state: BlockState, startLine: number, _endLine: number, silent: boolean): boolean {
    if (state.sCount[startLine] - state.blkIndent >= 4) { return false; }
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (state.src.charCodeAt(start) !== 0x40 /* @ */) { return false; }
    const match = ALIAS.exec(state.src.slice(start, state.eMarks[startLine]));
    if (!match) { return false; }
    if (silent) { return true; }
    state.line = startLine + 1;
    const open = state.push('toc_open', 'toc', 1);
    open.markup = '@[toc]';
    open.map = [startLine, state.line];
    const body = state.push('toc_body', '', 0);
    body.map = [startLine, state.line];
    body.children = [];
    if (match[1]) { body.meta = { [TITLE]: match[1] }; }
    state.push('toc_close', 'toc', -1);
    return true;
}
