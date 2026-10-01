import { MarkdownIt, StateBase, Token } from '../@types/markdown-it';
import markdownItTableOfContents from 'markdown-it-table-of-contents';
import { headingText, slugBuilder, TextToken } from '../syntax/headingSlug';

// markdown-it-table-of-contents links a heading by a slug of its own: percent-
// encoded, never de-duplicated (`What is new?` → `#what-is-new%3F`, a third
// `Setup` → `#setup`). VS Code's preview gives the heading another id
// (`what-is-new`, `setup-2`), so the link landed nowhere. The ids are therefore
// computed here, once per parse, by the preview's own rule
// (`src/syntax/headingSlug.ts`) over every heading of the document in order —
// at every level, as the preview counts them, not only the levels the TOC
// lists. Each TOC body carries them on its `meta`, which also lets the Visual
// Editor render a TOC block alone and still list the document's headings.
//
// An explicit `{#id}` (markdown-it-attrs) is not used: the preview's heading
// rule sets every heading's id from its slug and overwrites the one the author
// wrote, so `## Title {#custom}` is `id="title"` there, and the TOC links that.

const HEADINGS = 'mepTocHeadings';
const TITLE = 'mepTocTitle';

/** `@[toc]`, the marker of markdown-it-toc, optionally with a title: `@[toc](Contents)`. */
const ALIAS = /^@\[toc\](?:\(\s*([^)]*?)\s*\))?\s*$/i;

interface BlockState extends StateBase {
    bMarks: number[];
    eMarks: number[];
    tShift: number[];
    sCount: number[];
    blkIndent: number;
    line: number;
    push(type: string, tag: string, nesting: number): Token;
}

interface CoreState extends StateBase {
    Token: new (type: string, tag: string, nesting: number) => Token;
}

type Meta = Record<string, unknown> | null | undefined;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItTableOfContents(md: MarkdownIt, options: Record<string, unknown> = {}) {
    md.use(markdownItTableOfContents, {
        ...options,
        // The entry's text is the heading's, as the preview reads it (emoji
        // included), written as text: rendering it again as Markdown linkified
        // a URL into a link inside the entry's link, and runs every
        // `md.render` wrapper (the built-in Mermaid's config span) once per entry.
        getTokensText: (tokens: TextToken[]) => headingText({ type: 'inline', content: '', children: tokens }),
        format: (content: string) => md.utils.escapeHtml(content),
    });
    md.block.ruler.before('toc', 'mep_toc_alias', alias, { alt: ['paragraph', 'reference', 'blockquote'] });
    md.core.ruler.push('mep_toc_headings', (state: StateBase) => anchorHeadings(state as CoreState));

    const body = md.renderer.rules.toc_body;
    md.renderer.rules.toc_body = (tokens, idx, opts, env, self) => {
        const meta = tokens[idx].meta as Meta;
        const headings = (meta?.[HEADINGS] as Token[] | undefined) ?? tokens;
        const title = meta?.[TITLE] as string | undefined;
        const heading = title ? `<p class="table-of-contents-title">${md.utils.escapeHtml(title)}</p>` : '';
        return heading + body(headings, idx, opts, env, self);
    };
}

/**
 * The headings the TOC lists, each `heading_open` a copy carrying the id the
 * preview gives it. The plugin uses an id it finds on a heading as the link,
 * so it never slugs one itself. The `html_block` before a heading goes along,
 * for the plugin's `<!-- omit from toc -->`.
 */
function anchorHeadings(state: CoreState) {
    const bodies = state.tokens.filter(t => t.type === 'toc_body');
    if (bodies.length === 0) { return; }
    const slug = slugBuilder();
    const headings: Token[] = [];
    state.tokens.forEach((token, i) => {
        if (token.type !== 'heading_open') { return; }
        const inline = state.tokens[i + 1];
        const open = new state.Token('heading_open', token.tag, 1);
        open.attrs = [['id', slug(headingText(inline))]];
        const before = state.tokens[i - 1];
        if (before?.type === 'html_block') { headings.push(before); }
        headings.push(open, inline, new state.Token('heading_close', token.tag, -1));
    });
    for (const body of bodies) {
        body.meta = { ...((body.meta as Meta) ?? {}), [HEADINGS]: headings };
    }
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
