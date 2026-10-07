import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import markdownItAttrs from 'markdown-it-attrs';
import { findLeftDelimiter, isTextBrace, textBraceCloses, withoutTextBraceEnd } from '../syntax/attrsLiteral';
import { EXPLICIT_ID, explicitHeadingId, headingIds } from '../syntax/headingSlug';
import { hasEnabledRule } from './shared';

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

/**
 * Whether `md` reads `{…}` as attributes: markdown-it-attrs' `curly_attributes`
 * core rule is registered and enabled. Only that rule decides, because the
 * fact fails safe one way only: taken as on where it is off, the page escapes
 * a brace the preview would have shown as text; taken as off where it is on,
 * the page writes `{.x}` plain and the preview takes the user's text as
 * attributes. So an engine with the wrapper's text-brace rules off, or with
 * another extension's copy of the plugin, still reads as on.
 */
export function readsAttrs(md: MarkdownIt): boolean {
    return hasEnabledRule(md.core.ruler, 'curly_attributes');
}

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
    // What the plugin does is read off the tokens right around its own rule, whatever
    // another plugin inserts before it later (the notes' rule does): the rule is wrapped.
    const rules = (md.core.ruler as unknown as { __rules__: { name: string; fn: (state: StateBase) => void }[] }).__rules__;
    const curly = rules.find(rule => rule.name === 'curly_attributes')?.fn;
    if (curly !== undefined) {
        md.core.ruler.at('curly_attributes', (state: StateBase) => {
            const watch = watchTokens(state.tokens);
            curly(state);
            watch();
        });
    }
}

/**
 * What markdown-it-attrs did, read off the tokens around its rule: the
 * attributes it gave each token (`attrsGivenTo`), each `{…}` it cut off a text
 * token (`attrsCutsIn`) and the text it took one off the end of
 * (`textBeforeAttrs`). The Visual Editor reads them — which `{…}` the plugin
 * took, where the text spelled it, and which token it gave it to. What it gave
 * is kept in the token's `meta`, which travels with a token the notes plugin
 * copies out of the inline parse of a note's text; what it cut, by the inline
 * token, as markdown-it joins a text token with an escape after it into a new
 * token once the plugin is done (`text_join`).
 *
 * Only what can change is remembered, so a parse costs the preview next to
 * nothing more: the attributes of the tokens that had some when the plugin
 * began, and the content of the text tokens holding a `{` — the only ones the
 * plugin cuts — with the token before each.
 */
const GIVEN = 'mepAttrsGiven';

/**
 * A `{…}` markdown-it-attrs cut off a text token: the token's `text` before
 * the plugin cut anything off it — a verbatim run of the source, as the inline
 * rules make every text token — and where the `{…}` stood in it, `[from, to)`.
 * `end` for one cut off its end (the plugin's "end of block" and "list item
 * end": a block's, an item's), else off its start, right after the token
 * `after` names (a closing tag — a span's `]`, emphasis, a link — inline code
 * or an image), `first` when no `{…}` was cut there before it: a span's own
 * literal is the first after its `span_close`.
 *
 * Recorded as the plugin met the tokens, inside its rule, while the text
 * braces are split (`mep_text_braces_aside` runs before the rule and
 * `mep_text_braces_back` joins the pieces after it): a text token holding a
 * text brace is then pieces, each but the first starting at a text brace's
 * `}` (`splitText`). So `text` is the piece the plugin cut — a verbatim run
 * still, but shorter than the token the finished parse holds — and `from`
 * and `to` are in that piece. A cut at the start is only ever in a first
 * piece (the others start with `}`), so its `after` is the token before the
 * whole text token; a text brace is never cut, so no cut spans two pieces.
 * `textBeforeAttrs` is such a piece too.
 */
export interface AttrsCut {
    text: string;
    from: number;
    to: number;
    end: boolean;
    after: string | null;
    first: boolean;
}

/** The last text token of each inline token whose end the plugin cut a `{…}` off, as it was before. */
const takenAtEnd = new WeakMap<Token, string>();
/** The `{…}`s the plugin cut off the text tokens of each inline token (`attrsCutsIn`). */
const cutsIn = new WeakMap<Token, AttrsCut[]>();

/** The plugin's own reading of a `{…}` at a text's start and of the last `{` in it (`utils.js`), with its options. */
interface AttrsUtils {
    hasDelimiters(where: 'start', options: object): (str: string) => boolean;
    findLeftDelimiter(str: string, options: object): number;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const utils = require('markdown-it-attrs/utils.js') as AttrsUtils;
/** Its default options: the registry and the page register it without any (`plugins.ts`, `attrsEngineFor`). */
const OPTIONS = { leftDelimiter: '{', rightDelimiter: '}', allowedAttributes: [], allowedAttributeValues: [] };
const startsWithAttrs = utils.hasDelimiters('start', OPTIONS);

/**
 * Remember what of `tokens` the plugin may change; the function returned
 * records what it did. A text token's cuts are told from its content before
 * and after, by the plugin's own order: right after a closing tag, inline code
 * or an image it cuts every `{…}` it reads at the start, to the first `}`
 * (the "inline attributes" and "inline nesting 0" patterns, which it retries),
 * before any pattern cuts the end; each cut off the end takes the last `{`
 * through the end, a space before it dropped.
 */
function watchTokens(tokens: Token[]): () => void {
    const had = new Map<Token, string[][]>();
    const remember = (token: Token) => {
        if (token.attrs) {
            had.set(token, token.attrs.map(([n, v]) => [n, v]));
        }
    };
    const watched: { inline: Token; children: Token[]; texts: Map<Token, { content: string; after: Token | undefined }> }[] = [];
    for (const token of tokens) {
        remember(token);
        if (token.type !== 'inline' || !token.children || !token.content.includes('{')) {
            continue;
        }
        const texts = new Map<Token, { content: string; after: Token | undefined }>();
        token.children.forEach((child, j, children) => {
            remember(child);
            if (child.type === 'text' && child.content.includes('{')) {
                texts.set(child, { content: child.content, after: children[j - 1] });
            }
        });
        if (texts.size > 0) {
            watched.push({ inline: token, children: token.children.slice(), texts });
        }
    }
    return () => {
        const note = (token: Token) => {
            if (!token.attrs) {
                return;
            }
            const was = had.get(token);
            const added = was === undefined ? token.attrs : token.attrs.filter(([name, value]) => !was.some(([n, v]) => n === name && v === value));
            if (added.length > 0) {
                setMeta(token, GIVEN, added.map(([name, value]) => [name, value]));
            }
        };
        for (const token of tokens) {
            note(token);
        }
        for (const { inline, children, texts } of watched) {
            children.forEach(note);
            const now = new Set(inline.children ?? []);
            const cuts: AttrsCut[] = [];
            let endText: string | null = null;
            for (const [child, { content, after }] of texts) {
                const read = cutsOf(content, now.has(child) ? child.content : null, after);
                cuts.push(...read.cuts);
                endText = read.endText ?? endText;
            }
            if (cuts.length > 0) {
                cutsIn.set(inline, cuts);
            }
            if (endText !== null) {
                takenAtEnd.set(inline, endText);
            }
        }
    };
}

/**
 * The cuts the plugin made to a text token, read off its content `before` and
 * `after` (`null`: taken out whole, `` `x`{.c} `` or a `{…}` line after a
 * soft break), and its content before the first cut off its end; none where
 * the two do not fit the plugin's order.
 */
function cutsOf(before: string, after: string | null, tag: Token | undefined): { cuts: AttrsCut[]; endText: string | null } {
    const cuts: AttrsCut[] = [];
    let base = 0;
    let rest = before;
    if (tag !== undefined && (tag.nesting === -1 || tag.type === 'image' || tag.type === 'code_inline')) {
        while (startsWithAttrs(rest) && (after === null || rest !== after)) {
            const length = rest.indexOf('}') + 1;
            cuts.push({ text: before, from: base, to: base + length, end: false, after: tag.type, first: cuts.length === 0 });
            base += length;
            rest = rest.slice(length);
        }
    }
    if (after === null) {
        if (rest.startsWith('{') && rest.endsWith('}')) {
            cuts.push({ text: before, from: base, to: base + rest.length, end: false, after: null, first: false });
        } else if (rest !== '') {
            return { cuts: [], endText: null };
        }
        return { cuts, endText: null };
    }
    let endText: string | null = null;
    const ends: AttrsCut[] = [];
    while (rest !== after) {
        const at = utils.findLeftDelimiter(rest, OPTIONS);
        if (at < 0 || !rest.endsWith('}') || !rest.startsWith(after)) {
            return { cuts: [], endText: null };
        }
        endText ??= rest;
        ends.push({ text: before, from: base + at, to: base + rest.length, end: true, after: null, first: false });
        rest = rest.slice(0, at);
        if (rest.endsWith(' ')) {
            rest = rest.slice(0, -1);
        }
    }
    return { cuts: [...cuts, ...ends], endText };
}

/**
 * The attributes markdown-it-attrs gave `token` (a token of the stream or an
 * inline token's child): every one it has that it did not have, with that
 * value, when the plugin began — a class it joined to one there already is
 * given with the joined value.
 */
export function attrsGivenTo(token: Token): [string, string][] {
    return ((token.meta as Meta)?.[GIVEN] as [string, string][] | undefined) ?? [];
}

/**
 * The `{…}`s markdown-it-attrs cut off the text tokens of `inline` (an inline
 * token), by token in order and each token's in the order cut (`AttrsCut`) —
 * one it took out whole with its text token too (right after inline code or an
 * image, or a `{…}` line after a soft break). Not those it cut in the inline
 * parse of a note's text, which markdown-it-attrs reads on its own.
 */
export function attrsCutsIn(inline: Token): readonly AttrsCut[] {
    return cutsIn.get(inline) ?? [];
}

/**
 * The text token of `inline` (an inline token) whose end markdown-it-attrs
 * cut a `{…}` off — the last, when it cut more — as it was before, or `null`
 * when the plugin took nothing off the end of any. Where a text brace split
 * that token, it is the piece after the brace's `}` (`AttrsCut`): what the
 * plugin read, and found the last `{` in.
 */
export function textBeforeAttrs(inline: Token): string | null {
    return takenAtEnd.get(inline) ?? null;
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
// The anchor is the heading's `anchor` by `headingIds` — none when some
// heading's explicit id is that slug — and it is written only when the id
// VS Code set is that slug: an id another rule set (`perma-0`) is no slug.
// VS Code's preview follows a fragment from another document only to an
// element of its own source map, so the anchor carries the heading's
// `data-line` and `code-line` class. That puts it in the preview's scroll
// sync too (VS Code 1.140's `media/index.js`):
// - editor → preview, and the active-line marker, take the last element at or
//   before a line: for the heading's own line the heading, for a line between
//   it and the next block the anchor — the marker then stands on the anchor
//   (its bar one text line high, not the heading's height), and a fractional
//   line inside the heading scrolls to the heading's top;
// - preview → editor skips the anchor, which has no size, and measures the
//   heading only down to the anchor inside it (one pixel): with a block after
//   the heading it interpolates to that block as before, but with none it
//   divides by that pixel and runs far past the document's end. The anchor
//   therefore joins the source map only when a mapped block follows the
//   heading; a last heading's anchor is a plain `<a id>`, which a link in the
//   same preview finds and one from another document's preview does not.
//
// Three limits, all outside what this rule can see: an id a core rule of
// another plugin sets on a heading before `curly_attributes` is read as the
// author's; a `heading_open` rule another extension installs after this one
// runs between VS Code's and this one, and reads the slug as the id; and a
// render without VS Code's slug builder (`env.slugifier`) slugs repeats its
// own way, so a repeated heading's slug is not the one `headingIds` counts,
// and it gets no second anchor.

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

/** A rendered stream's second anchors by their heading's index, and the index of its last source-mapped block token. */
interface StreamAnchors {
    anchors: Map<number, string>;
    lastMapped: number;
}

/** Read once per stream. */
const anchorsOf = new WeakMap<Token[], StreamAnchors>();

function secondAnchors(tokens: Token[]): StreamAnchors {
    let read = anchorsOf.get(tokens);
    if (!read) {
        let lastMapped = -1;
        tokens.forEach((t, i) => {
            if (t.map && t.type !== 'inline') { lastMapped = i; }
        });
        read = { anchors: new Map(headingIds(tokens).filter(h => h.anchor !== null).map(h => [h.index, h.anchor])), lastMapped };
        anchorsOf.set(tokens, read);
    }
    return read;
}

/** The heading renderer, giving a heading its explicit id back and keeping its slug as a second anchor. */
function wrapHeading(md: MarkdownIt) {
    const open = md.renderer.rules.heading_open;
    md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const id = explicitHeadingId(token);
        // VS Code's rule set the slug; without it (an engine of its own) the id is attrs' and no anchor is written.
        const set = id !== null ? token.attrGet('id') : null;
        if (id !== null) { token.attrSet('id', id); }
        const html = open ? open(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
        const stream = id !== null ? secondAnchors(tokens) : null;
        const anchor = stream?.anchors.get(idx);
        if (anchor === undefined || set !== anchor) { return html; }
        const line = token.attrGet('data-line');
        // In the source map only with a mapped block after the heading (`heading_close` is idx + 2).
        const sourceMap = line !== null && stream.lastMapped > idx + 2 ? ` class="code-line" data-line="${md.utils.escapeHtml(line)}"` : '';
        return `${html}<a id="${md.utils.escapeHtml(anchor)}"${sourceMap}></a>`;
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
