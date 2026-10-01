import { MarkdownIt, StateBase, Token } from "../@types/markdown-it";
import markdownItAttrs from 'markdown-it-attrs';
import { findLeftDelimiter, isTextBrace, textBraceCloses } from '../syntax/attrsLiteral';

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
//   a literal off the end (a list item's, then its paragraph's). The text is
//   unchanged, and markdown-it's `text_join` joins the tokens again;
// - where attrs reads a whole string instead — an inline's content for a
//   `{…}` paragraph or a `--- {…}` rule, a fence's or a container's info — the
//   string is changed so attrs' test fails, and put back from what it was.
interface Held {
    token: Token;
    field: 'content' | 'info';
    original: string;
    held: string;
}

const heldBack = new WeakMap<StateBase, Held[]>();

/** The start of the paragraph attrs turns into a rule: `---` and a `{` (its `horizontal rule` pattern). */
const RULE_START = /^ {0,3}[-*_]{3,} ?\{[^}]/;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItAttrs(md: MarkdownIt, ...args: any[]) {
    md.use(markdownItAttrs, ...args);
    md.core.ruler.before('curly_attributes', 'mep_table_spans_aside', (state: StateBase) => setAside(state.tokens));
    md.core.ruler.after('curly_attributes', 'mep_table_spans_back', (state: StateBase) => putBack(state.tokens));
    md.core.ruler.before('curly_attributes', 'mep_text_braces_aside', (state: StateBase) => {
        heldBack.set(state, holdTextBraces(state));
    });
    md.core.ruler.after('curly_attributes', 'mep_text_braces_back', (state: StateBase) => {
        for (const { token, field, original, held } of heldBack.get(state) ?? []) {
            if (token[field] === held) { token[field] = original; }
        }
        heldBack.delete(state);
    });
}

/** The text token split right before the `}` of each brace of its own (`textBraceCloses`); itself when it has none. */
function splitText(state: StateBase, token: Token): Token[] {
    const closes = textBraceCloses(token.content);
    if (closes.length === 0) { return [token]; }
    const pieces: Token[] = [];
    let from = 0;
    for (const at of [...closes, token.content.length]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const piece: Token = new (state as any).Token('text', '', 0);
        piece.content = token.content.slice(from, at);
        piece.level = token.level;
        pieces.push(piece);
        from = at;
    }
    return pieces;
}

/** Whether attrs would read the whole string as a brace of the text's own: a `{…}` paragraph's, a rule's. */
function wholeIsTextBrace(content: string): boolean {
    return (content.startsWith('{') && isTextBrace(content, 0))
        || (RULE_START.test(content) && isTextBrace(content, content.lastIndexOf('{')));
}

function holdTextBraces(state: StateBase): Held[] {
    const out: Held[] = [];
    const hold = (token: Token, field: Held['field'], held: string) => {
        out.push({ token, field, original: token[field], held });
        token[field] = held;
    };
    for (const token of state.tokens) {
        if (token.type === 'inline') {
            if (token.content.includes('{') && wholeIsTextBrace(token.content)) {
                // A string attrs' `only` and rule tests cannot match: it no longer starts with the `{`, or the dashes.
                hold(token, 'content', `\n${token.content}`);
            }
            if (token.children?.some(c => c.type === 'text' && c.content.includes('{'))) {
                token.children = token.children.flatMap(c => (c.type === 'text' ? splitText(state, c) : [c]));
            }
        } else if (token.block && token.info) {
            const start = findLeftDelimiter(token.info);
            if (start >= 0 && isTextBrace(token.info, start)) {
                // attrs' `end` test needs the `}` last.
                hold(token, 'info', `${token.info} `);
            }
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
