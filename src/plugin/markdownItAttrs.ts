import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import markdownItAttrs from 'markdown-it-attrs';
import { findLeftDelimiter, isTextBrace, textBraceCloses, withoutTextBraceEnd } from '../syntax/attrsLiteral';
import { EXPLICIT_ID, explicitHeadingId } from '../syntax/headingSlug';

// markdown-it-attrs recomputes a table's cells from every `rowspan` and
// `colspan` it finds, to honour its own `{rowspan=2}`. It cannot tell those
// from the spans markdown-it-multimd-table has already laid out (`^^`, `||`),
// and with two spanning columns it hides whole rows — every cell from the
// fourth spanned row on (jackdmf/vscode-markdown-extended#3). The spans
// already on a cell when attrs runs are therefore set aside for its rule and
// put back after it, so attrs only lays out the spans it set itself.
const SPANS = ['rowspan', 'colspan'];
const STASH = 'mepTableSpans';

type Meta = Record<string, unknown> | null | undefined;

// markdown-it-attrs takes a `{…}` that ends a block, or starts the text after
// inline markup, for attributes, and drops it from the text: a PowerShell
// hashtable `@{height = 65}` in a table cell renders as `@`
// (qjebbs/vscode-markdown-extended#146). A brace that is the text's own
// (`isTextBrace`, `src/syntax/attrsLiteral.ts`, the rule the Visual Editor
// reads literals by) is kept from attrs' rule:
//
// - in inline text, the text token is split right before the brace's `}`, so
//   no text token attrs reads holds the whole brace — however often it strips
//   a literal off the end (a list item's, then its paragraph's) — and joined
//   again right after attrs' rule, so the rules after it (typographer,
//   linkify) see the text as they would without the split;
// - where attrs reads a whole string instead — an inline's content for a
//   `{…}` paragraph or a `--- {…}` rule, a fence's or a container's info — the
//   string is changed so attrs' test fails, and put back from what it was;
// - a bracketed span whose `{…}` is such a brace (`[x]{a = b}`) is no span:
//   its brackets are put back as text, as a `[x]` followed by anything else is.
interface Held {
    token: Token;
    field: 'content' | 'info';
    original: string;
    held: string;
}

interface TextBraces {
    held: Held[];
    /** The pieces of every text token split, by the token whose children they are. */
    split: Map<Token, Set<Token>>;
}

const textBraces = new WeakMap<StateBase, TextBraces>();

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItAttrs(md: MarkdownIt, ...args: any[]) {
    md.use(markdownItAttrs, ...args);
    md.core.ruler.before('curly_attributes', 'mep_table_spans_aside', (state: StateBase) => setAside(state.tokens));
    md.core.ruler.after('curly_attributes', 'mep_table_spans_back', (state: StateBase) => putBack(state.tokens));
    md.core.ruler.before('curly_attributes', 'mep_text_braces_aside', (state: StateBase) => {
        textBraces.set(state, holdTextBraces(state));
    });
    md.core.ruler.after('curly_attributes', 'mep_text_braces_back', (state: StateBase) => {
        const braces = textBraces.get(state);
        textBraces.delete(state);
        for (const { token, field, original, held } of braces?.held ?? []) {
            if (token[field] === held) { token[field] = original; }
        }
        for (const [inline, pieces] of braces?.split ?? []) {
            inline.children = unsplit(inline.children, pieces);
            // A span's text brace starts a text attrs reads, so it was split: its inline is one of these.
            textBraceSpansAsText(state, inline.children);
        }
    });
    md.core.ruler.after('curly_attributes', 'mep_explicit_heading_id', (state: StateBase) => keepHeadingIds(state.tokens));
    wrapFence(md);
    wrapHeading(md);
}

// An explicit `{#id}` on a heading is the id the author links it by (Req
// Explorer writes `## FR-1: Name {#fr-1}`), but VS Code's heading rule, which
// wraps every rule the extensions installed, sets each heading's id from its
// slug before it calls the rule it wrapped — `fr-1-name` in the preview, in
// `markdown.api.render` and in the exports. The id attrs read is therefore
// kept under the token's `meta` (`explicitHeadingId`, `src/syntax/headingSlug.ts`),
// where a render cannot overwrite it, and the heading rule installed here —
// the one VS Code's calls — sets it back. VS Code has slugged the heading by
// then, so the headings after it count its slug as they did; the slug it set
// is kept as a second anchor at the start of the heading's content
// (`<a id="fr-1-name"></a>`), so a link written to the slug still lands, and
// so does the one VS Code's language server completes, which knows only slugs.
//
// Two limits, both outside what this rule can see: an id a core rule of
// another plugin sets on a heading before `curly_attributes` is read as the
// author's; and a `heading_open` rule another extension installs after this
// one runs between VS Code's and this one, and reads the slug as the id.

/** Every heading's explicit id, kept under its `meta`. */
function keepHeadingIds(tokens: Token[]) {
    for (const token of tokens) {
        if (token.type !== 'heading_open') { continue; }
        const id = token.attrGet('id');
        if (id) { setMeta(token, EXPLICIT_ID, id); }
    }
}

/**
 * `value` under `key` of the token's `meta`, written into the object already
 * there, as Req Explorer's marks are: a plugin holding that object keeps
 * seeing its own data. A `meta` that is not an object belongs to nobody and
 * is replaced.
 */
function setMeta(token: Token, key: string, value: unknown) {
    if (typeof token.meta !== 'object' || token.meta === null) {
        token.meta = { [key]: value };
        return;
    }
    (token.meta as Record<string, unknown>)[key] = value;
}

/** The heading renderer, giving a heading its explicit id back and keeping its slug as a second anchor. */
function wrapHeading(md: MarkdownIt) {
    const open = md.renderer.rules.heading_open;
    md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const id = explicitHeadingId(token);
        // VS Code's rule set the slug; without it (an engine of its own) the id is attrs' and there is no slug here.
        const slug = id !== null ? token.attrGet('id') : null;
        if (id !== null) { token.attrSet('id', id); }
        const html = open ? open(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
        return slug && slug !== id ? `${html}<a id="${md.utils.escapeHtml(slug)}"></a>` : html;
    };
}

/** A new text token holding `content`, at `level`. */
function textToken(state: StateBase, content: string, level: number): Token {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const token: Token = new (state as any).Token('text', '', 0);
    token.content = content;
    token.level = level;
    return token;
}

/** The text token split right before the `}` of each brace of its own (`textBraceCloses`); `null` when it has none. */
function splitText(state: StateBase, token: Token): Token[] | null {
    const closes = textBraceCloses(token.content);
    if (closes.length === 0) { return null; }
    const pieces: Token[] = [];
    let from = 0;
    for (const at of [...closes, token.content.length]) {
        pieces.push(textToken(state, token.content.slice(from, at), token.level));
        from = at;
    }
    return pieces;
}

/** The children with every run of split pieces attrs left standing side by side joined into its first. */
function unsplit(children: Token[], pieces: Set<Token>): Token[] {
    const out: Token[] = [];
    for (const child of children) {
        const last = out[out.length - 1];
        if (last && pieces.has(last) && pieces.has(child)) {
            last.content += child.content;
        } else {
            out.push(child);
        }
    }
    return out;
}

/**
 * Every bracketed span attrs gave nothing because its `{…}` is a brace of the
 * text's own, made text again: `[` and `]` around its content, the brace after it.
 */
function textBraceSpansAsText(state: StateBase, children: Token[]) {
    for (let i = 0; i < children.length; i++) {
        const close = children[i];
        const next = children[i + 1];
        if (close.type !== 'span_close' || next?.type !== 'text' || !next.content.startsWith('{') || !isTextBrace(next.content, 0)) {
            continue;
        }
        let depth = 0;
        let open = i;
        for (; open >= 0; open--) {
            depth += children[open].nesting;
            if (depth === 0) { break; }
        }
        if (open < 0 || children[open].type !== 'span_open' || (children[open].attrs?.length ?? 0) > 0) {
            continue;
        }
        children[open] = textToken(state, '[', children[open].level);
        children[i] = textToken(state, ']', close.level);
    }
}

/**
 * The fence renderer, given a fence's info without a brace of the text's own
 * it ends with: ```` ```{a = b} ```` names no language, ```` ```js{a = b} ````
 * `js` — not `{a` or `js{a`. The token keeps its info as written.
 */
function wrapFence(md: MarkdownIt) {
    const fence = md.renderer.rules.fence;
    if (!fence) { return; }
    md.renderer.rules.fence = (...args: Parameters<typeof fence>) => {
        const token = args[0][args[1]];
        const info = token.info;
        const shown = withoutTextBraceEnd(info);
        if (shown === info.trim()) { return fence(...args); }
        token.info = shown;
        try {
            return fence(...args);
        } finally {
            token.info = info;
        }
    };
}

function holdTextBraces(state: StateBase): TextBraces {
    const held: Held[] = [];
    const split = new Map<Token, Set<Token>>();
    const hold = (token: Token, field: Held['field'], value: string) => {
        held.push({ token, field, original: token[field], held: value });
        token[field] = value;
    };
    for (const token of state.tokens) {
        if (token.type === 'inline') {
            if (token.content.includes('{') && textBraceCloses(token.content).length > 0) {
                // A string attrs' `only` and rule tests cannot match: it no longer starts with the `{`, or the dashes.
                hold(token, 'content', `\n${token.content}`);
            }
            const pieces = new Set<Token>();
            const children = (token.children ?? []).flatMap(c => {
                const parts = c.type === 'text' && c.content.includes('{') ? splitText(state, c) : null;
                parts?.forEach(p => pieces.add(p));
                return parts ?? [c];
            });
            if (pieces.size > 0) {
                token.children = children;
                split.set(token, pieces);
            }
        } else if (token.block && token.info) {
            const start = findLeftDelimiter(token.info);
            if (start >= 0 && isTextBrace(token.info, start)) {
                // attrs' `end` test needs the `}` last.
                hold(token, 'info', `${token.info} `);
            }
        }
    }
    return { held, split };
}

function isCell(token: Token): boolean {
    return token.type === 'td_open' || token.type === 'th_open';
}

function setAside(tokens: Token[]) {
    for (const token of tokens) {
        if (!isCell(token) || !token.attrs) { continue; }
        const spans = token.attrs.filter(([name]) => SPANS.includes(name));
        if (!spans.length) { continue; }
        token.attrs = token.attrs.filter(([name]) => !SPANS.includes(name));
        setMeta(token, STASH, spans);
    }
}

function putBack(tokens: Token[]) {
    for (const token of tokens) {
        const meta = token.meta as Meta;
        const spans = meta?.[STASH] as string[][] | undefined;
        if (!meta || !spans) { continue; }
        delete meta[STASH];
        // A span the author also wrote as `{rowspan=…}` is attrs' to keep.
        for (const [name, value] of spans) {
            if (token.attrGet(name) === null) { token.attrSet(name, value); }
        }
    }
}
