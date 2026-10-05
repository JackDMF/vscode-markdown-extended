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
            const had = remember(state.tokens);
            curly(state);
            noteWhatItDid(state.tokens, had);
        });
    }
}

/**
 * What markdown-it-attrs did, read off the tokens around its rule rather than
 * by redoing its search: the attributes it gave each token (`attrsGivenTo`)
 * and the text it took a `{…}` off the end of (`textBeforeAttrs`). The Visual
 * Editor reads both — which `{…}` the plugin took, and which token it gave it
 * to. What it gave is kept in the token's `meta`, which travels with a token
 * the notes plugin copies out of the inline parse of a note's text.
 */
const GIVEN = 'mepAttrsGiven';

/** The last text token of each inline token whose end the plugin cut a `{…}` off, as it was before. */
const takenAtEnd = new WeakMap<Token, string>();

/** Each token's attributes and, for a text token, its content, as the plugin found them. */
function remember(tokens: Token[]): Map<Token, { attrs: string[][] | null; content: string | null }> {
    const had = new Map<Token, { attrs: string[][] | null; content: string | null }>();
    for (const token of tokens) {
        had.set(token, { attrs: token.attrs ? token.attrs.map(([n, v]) => [n, v]) : null, content: null });
        for (const child of token.children ?? []) {
            had.set(child, { attrs: child.attrs ? child.attrs.map(([n, v]) => [n, v]) : null, content: child.type === 'text' ? child.content : null });
        }
    }
    return had;
}

function noteWhatItDid(tokens: Token[], had: Map<Token, { attrs: string[][] | null; content: string | null }>) {
    const note = (token: Token) => {
        const was = had.get(token);
        const added = (token.attrs ?? []).filter(([name, value]) => !(was?.attrs ?? []).some(([n, v]) => n === name && v === value));
        if (added.length > 0) {
            const meta = (token.meta as Meta) ?? {};
            meta[GIVEN] = added.map(([name, value]) => [name, value]);
            token.meta = meta;
        }
    };
    for (const token of tokens) {
        note(token);
        for (const child of token.children ?? []) {
            note(child);
            // A span's `{…}` is cut off the start of the text after it, a block's off the end of what is left.
            const content = had.get(child)?.content ?? null;
            const at = content === null ? -1 : content.indexOf(child.content);
            if (content !== null && at >= 0 && content.length - at > child.content.length) {
                takenAtEnd.set(token, content.slice(at));
            }
        }
    }
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
