import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import markdownItAttrs from 'markdown-it-attrs';
import { findLeftDelimiter, isTextBrace } from '../editor/attrs';

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

// markdown-it-attrs takes any `{…}` that ends a block, or starts the text after
// inline markup, for attributes, and drops it from the text: a PowerShell
// hashtable `@{height = 65}` in a table cell renders as `@`
// (qjebbs/vscode-markdown-extended#146). A brace that is the text's own
// (`isTextBrace`, the rule the Visual Editor reads literals by) is therefore
// hidden from attrs' rule behind a private-use character and put back after it.
const MASK = '';

interface Masked {
    token: Token;
    field: 'content' | 'info';
}

const masked = new WeakMap<StateBase, Masked[]>();

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItAttrs(md: MarkdownIt, ...args: any[]) {
    md.use(markdownItAttrs, ...args);
    md.core.ruler.before('curly_attributes', 'mep_table_spans_aside', (state: StateBase) => setAside(state.tokens));
    md.core.ruler.after('curly_attributes', 'mep_table_spans_back', (state: StateBase) => putBack(state.tokens));
    md.core.ruler.before('curly_attributes', 'mep_text_braces_aside', (state: StateBase) => {
        masked.set(state, maskTextBraces(state.tokens));
    });
    md.core.ruler.after('curly_attributes', 'mep_text_braces_back', (state: StateBase) => {
        for (const { token, field } of masked.get(state) ?? []) {
            token[field] = token[field].split(MASK).join('{');
        }
        masked.delete(state);
    });
}

/**
 * The string with every brace attrs would read and that is the text's own
 * masked: the one it starts with (attrs' `start` and `only` readings) and the
 * last one (its `end` reading), again until the last is a literal or none is left.
 */
function maskBraces(str: string): string {
    let out = str;
    if (out.startsWith('{') && isTextBrace(out, 0)) {
        out = MASK + out.slice(1);
    }
    for (let start = findLeftDelimiter(out); start >= 0 && isTextBrace(out, start); start = findLeftDelimiter(out)) {
        out = out.slice(0, start) + MASK + out.slice(start + 1);
    }
    return out;
}

/** Every string attrs reads a literal from: an inline token's content and text children, a block's info. */
function maskTextBraces(tokens: Token[]): Masked[] {
    const out: Masked[] = [];
    const mask = (token: Token, field: Masked['field']) => {
        const value = token[field];
        // A string already holding the mask is left alone, so putting it back cannot change it.
        if (typeof value !== 'string' || !value.includes('{') || value.includes(MASK)) { return; }
        const next = maskBraces(value);
        if (next !== value) {
            token[field] = next;
            out.push({ token, field });
        }
    };
    for (const token of tokens) {
        if (token.type === 'inline') {
            mask(token, 'content');
            for (const child of token.children ?? []) {
                if (child.type === 'text') { mask(child, 'content'); }
            }
        } else if (token.block && token.info) {
            mask(token, 'info');
        }
    }
    return out;
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
