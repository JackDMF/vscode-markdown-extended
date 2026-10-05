import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import markdownItAttrs from 'markdown-it-attrs';

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

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItAttrs(md: MarkdownIt, ...args: any[]) {
    md.use(markdownItAttrs, ...args);
    md.core.ruler.before('curly_attributes', 'mep_table_spans_aside', (state: StateBase) => setAside(state.tokens));
    md.core.ruler.after('curly_attributes', 'mep_table_spans_back', (state: StateBase) => putBack(state.tokens));
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
                const meta = (token.meta as Meta) ?? {};
                meta[GIVEN] = added.map(([name, value]) => [name, value]);
                token.meta = meta;
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
 * when the plugin took nothing off the end of any.
 */
export function textBeforeAttrs(inline: Token): string | null {
    return takenAtEnd.get(inline) ?? null;
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
        token.meta = { ...((token.meta as Meta) ?? {}), [STASH]: spans };
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
