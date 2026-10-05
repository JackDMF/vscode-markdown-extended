/**
 * markdown-it-attrs' `{…}` literal, read the way the plugin reads it.
 *
 * An attribute span (`[text]{.a}`) and a block's attribute suffix are drawn
 * with the attributes their literal gives, and a literal typed into a field is
 * checked before it is written. Everything else about a literal — where it
 * stands, what it attaches to — is the host's parse (`blocks.ts`); this module
 * only turns a literal into attribute pairs and back.
 *
 * `readAttrs` is a port of the plugin's `getAttrs`, `findRightDelimiter` and
 * `findLeftDelimiter` (markdown-it-attrs 4.5, `utils.js`), with the default
 * delimiters and no allow-list — the extension registers the plugin without
 * options. `attrs.test.ts` holds the port to the plugin: every literal it
 * lists is rendered through the real engine and must give the same attributes.
 *
 * What the port does not model is asked of the engine. markdown-it's inline
 * rules read a literal before the plugin does, and a `\`, an entity, a code
 * span, emphasis, HTML, a URL or a plugin's markup inside it cuts it into
 * tokens the plugin no longer sees as attributes, so the preview shows it as
 * text: `parseAttrsLiteral` accepts a literal only when the page's own engine
 * (`currentInlineEngine`) leaves it one text. A literal the editor rewrites is
 * read back by markdown-it-attrs itself (`readsBackAs`).
 */

import { Token } from '../@types/markdown-it';
import { currentAttrsEngine, currentInlineEngine } from './inlineEngine';

/** One attribute as the plugin reads it: `[name, value]`. */
export type AttrPair = [string, string];

function isUnescapedDoubleQuote(str: string, i: number): boolean {
    if (str.charAt(i) !== '"') {
        return false;
    }
    let slashes = 0;
    for (let n = i - 1; n >= 0 && str.charAt(n) === '\\'; n--) {
        slashes++;
    }
    return slashes % 2 === 0;
}

/** The first `}` at or after `start` outside a quoted value, or -1. */
export function findRightDelimiter(str: string, start: number): number {
    let quoted = false;
    for (let i = start; i < str.length; i++) {
        if (isUnescapedDoubleQuote(str, i)) {
            quoted = !quoted;
            continue;
        }
        if (!quoted && str.charAt(i) === '}') {
            return i;
        }
    }
    return -1;
}

/** The last `{` outside a quoted value, or -1. */
export function findLeftDelimiter(str: string): number {
    let start = -1;
    let quoted = false;
    for (let i = 0; i < str.length; i++) {
        if (isUnescapedDoubleQuote(str, i)) {
            quoted = !quoted;
            continue;
        }
        if (!quoted && str.charAt(i) === '{') {
            start = i;
        }
    }
    return start;
}

/**
 * The attribute pairs of the `{…}` starting at `start`, as the plugin's
 * `getAttrs` reads them: `.a` is a class, `..a` a CSS module, `#a` the id,
 * `key=value` or `key="a value"` anything else; a space separates pairs.
 */
export function readAttrs(str: string, start = 0): AttrPair[] {
    const allowedKeyChars = /[^\t\n\f />"'=]/;
    const attrs: AttrPair[] = [];
    let key = '';
    let value = '';
    let parsingKey = true;
    let quoted = false;
    for (let i = start + 1; i < str.length; i++) {
        if (!quoted && str.charAt(i) === '}') {
            if (key !== '') {
                attrs.push([key, value]);
            }
            break;
        }
        const ch = str.charAt(i);
        if (ch === '=' && parsingKey) {
            parsingKey = false;
            continue;
        }
        if (ch === '.' && key === '') {
            if (str.charAt(i + 1) === '.') {
                key = 'css-module';
                i += 1;
            } else {
                key = 'class';
            }
            parsingKey = false;
            continue;
        }
        if (ch === '#' && key === '') {
            key = 'id';
            parsingKey = false;
            continue;
        }
        if (isUnescapedDoubleQuote(str, i) && value === '' && !quoted) {
            quoted = true;
            continue;
        }
        if (isUnescapedDoubleQuote(str, i) && quoted) {
            quoted = false;
            continue;
        }
        if (ch === ' ' && !quoted) {
            if (key === '') {
                continue;
            }
            attrs.push([key, value]);
            key = '';
            value = '';
            parsingKey = true;
            continue;
        }
        if (parsingKey && ch.search(allowedKeyChars) === -1) {
            continue;
        }
        if (parsingKey) {
            key += ch;
            continue;
        }
        value += ch;
    }
    return attrs;
}

/**
 * The attributes a token ends up with when the plugin adds `pairs` to it
 * (`addAttrs`): classes and CSS modules are joined with a space into the first
 * of their name, any other name set, a later value replacing an earlier one in
 * its place.
 */
export function joinAttrs(pairs: readonly AttrPair[]): AttrPair[] {
    const out: AttrPair[] = [];
    for (const [name, value] of pairs) {
        const at = out.findIndex(([n]) => n === name);
        if (at < 0) {
            out.push([name, value]);
        } else if (name === 'class' || name === 'css-module') {
            out[at] = [name, `${out[at][1]} ${value}`];
        } else {
            out[at] = [name, value];
        }
    }
    return out;
}

/**
 * The attribute pairs of `literal` when it is a whole `{…}` the plugin accepts
 * as attributes: one line, `{` first, the first `}` outside quotes last, long
 * enough (`{.}` and `{#}` are not; `{a}` is), giving at least one attribute,
 * and one text to markdown-it's inline rules (`readsAsOneText`). `null`
 * otherwise — the plugin would leave it as text, or take it and add nothing.
 */
export function parseAttrsLiteral(literal: string): AttrPair[] | null {
    if (!literal.startsWith('{') || !literal.endsWith('}') || /[\r\n]/.test(literal)) {
        return null;
    }
    const first = literal.charAt(1);
    const minimum = first === '.' || first === '#' ? 4 : 3;
    if (literal.length < minimum || findRightDelimiter(literal, 2) !== literal.length - 1) {
        return null;
    }
    const pairs = readAttrs(literal, 0);
    return pairs.length > 0 && readsAsOneText(literal) ? pairs : null;
}

/**
 * Whether the page's engine reads `literal` as one plain text, which is what
 * markdown-it-attrs looks for: its rule runs on the tokens the inline rules
 * made, before anything joins them, so a `\"` (an escape), a `&amp;` (an
 * entity), `` `a` ``, `*a*`, `<b>`, a URL or `^a^` inside the literal leaves
 * it in pieces and the preview shows it as text. Only the inline rules run
 * here, as they do before the plugin; the core rules after them (typographer,
 * the joining of texts) do not.
 */
export function readsAsOneText(literal: string): boolean {
    const md = currentInlineEngine();
    const tokens: Token[] = [];
    md.inline.parse(literal, md, {}, tokens);
    return tokens.length === 1 && tokens[0].type === 'text' && tokens[0].content === literal;
}

/**
 * Whether a `}` stands inside the literal, in a quoted value (`{title="a}b"}`).
 * markdown-it-attrs reads such a value whole but, after a span, cuts the text
 * at the first `}` (`indexOf`, quotes or not): the rest of the literal stays
 * behind in the paragraph as text, and every save would write it again. The
 * editor neither keeps nor makes such a span.
 */
export function hasInnerBrace(literal: string): boolean {
    return literal.indexOf('}') !== literal.length - 1;
}

/**
 * Whether markdown-it-attrs reads `literal` whole after a rule's `---`: it
 * starts reading at the line's **last** `{`, quoted or not, so a `{` inside a
 * value (`{title="x{y"}`) leaves the rule with no attributes at all. A quoted
 * `}` is read correctly there (`--- {title="a}b"}`).
 */
export function readsAsRuleLiteral(literal: string): boolean {
    return literal.lastIndexOf('{') === 0;
}

/** Whether two attribute lists are the same attributes, in any order. */
export function sameAttrs(a: readonly AttrPair[], b: readonly AttrPair[]): boolean {
    const key = (list: readonly AttrPair[]) => JSON.stringify([...list].map(([n, v]) => [n, v]).sort());
    return key(a) === key(b);
}

/**
 * A value written after `name=`, as `readAttrs` and `findRightDelimiter` read it
 * back: bare unless something in it ends the value or the list — whitespace,
 * `{`, `}` — or it is empty or starts with `"`, which would open a quote; in
 * quotes otherwise. A `=`, `'`, `.`, `#` or a `"` after the first character
 * ends nothing, so it stays bare (`k=a"b"`). Nothing is escaped: markdown-it
 * reads a `\` before the plugin does, and a literal holding one is text in the
 * preview. So a value that holds a `\`, or needs quotes and holds a `"`,
 * cannot be written, `null`.
 */
function attrValue(value: string): string | null {
    if (value.includes('\\')) {
        return null;
    }
    if (value !== '' && !/[\s{}]/.test(value) && !value.startsWith('"')) {
        return value;
    }
    return value.includes('"') ? null : `"${value}"`;
}

/**
 * The literal written for `attrs` (a token's joined attributes, or the pairs a
 * literal gives): `{#id .a .b key="v"}`, or `null` when a value cannot be
 * written (`attrValue`). The form written when the literal an author wrote
 * could not be recovered from the source (`blocks.ts`), and a copy's literal
 * without its id (`withoutId`). It is a candidate: where it matters it is read
 * back with the engine (`readsBackAs`), since the port does not know every
 * character the inline rules take (`readsAsOneText`).
 */
export function normalizedLiteral(attrs: readonly AttrPair[]): string | null {
    const parts: string[] = [];
    const id = attrs.find(([n]) => n === 'id');
    if (id && id[1] !== '' && !/[\s{}"\\]/.test(id[1])) {
        parts.push(`#${id[1]}`);
    }
    for (const [name, value] of attrs) {
        if (name === 'id' && parts[0] === `#${value}`) {
            continue;
        }
        if ((name === 'class' || name === 'css-module') && value.split(' ').every(v => v !== '' && !/[{}"\\]/.test(v) && !(name === 'class' && v.startsWith('.')))) {
            const dot = name === 'class' ? '.' : '..';
            parts.push(...value.split(' ').map(v => dot + v));
            continue;
        }
        const written = attrValue(value);
        if (written === null) {
            return null;
        }
        parts.push(`${name}=${written}`);
    }
    return `{${parts.join(' ')}}`;
}

/**
 * What carries a literal, by the name of its node (`SUFFIX_NODES`, a list
 * item's `list_item`) or `span` for an attribute span: the smallest source in
 * which the preview reads a literal where that block's stands, and the token
 * markdown-it-attrs gives it to. A paragraph's literal on a line of its own
 * reads as one at its end, and a list's after a blank line as one under it.
 */
const READ_BACK: Record<string, { source: (literal: string) => string; token: string }> = {
    paragraph: { source: l => `x ${l}`, token: 'paragraph_open' },
    heading: { source: l => `# x ${l}`, token: 'heading_open' },
    'list_item': { source: l => `- x ${l}`, token: 'list_item_open' },
    'bullet_list': { source: l => `- x\n\n${l}`, token: 'bullet_list_open' },
    'ordered_list': { source: l => `1. x\n\n${l}`, token: 'ordered_list_open' },
    'code_block': { source: l => `\`\`\`x ${l}\n\`\`\``, token: 'fence' },
    'horizontal_rule': { source: l => `--- ${l}`, token: 'hr' },
    blockquote: { source: l => `> x\n> ${l}`, token: 'blockquote_open' },
    table: { source: l => `| x |\n| - |\n\n${l}`, token: 'table_open' },
    span: { source: l => `[x]${l}`, token: 'span_open' },
};

/**
 * The attributes markdown-it-attrs gives `holder` (`READ_BACK`) for `literal`,
 * read with the page's engine and the plugin itself (`currentAttrsEngine`);
 * `null` when the literal, or part of it, is left as text, or `holder` is none
 * the editor writes a literal for.
 */
export function readBack(literal: string, holder: string): AttrPair[] | null {
    const shape = Object.prototype.hasOwnProperty.call(READ_BACK, holder) ? READ_BACK[holder] : undefined;
    if (shape === undefined) {
        return null;
    }
    const tokens = currentAttrsEngine().parse(shape.source(literal), {});
    const all = tokens.flatMap(t => [t, ...(t.children ?? [])]);
    if (all.some(t => t.type === 'text' && /[{}]/.test(t.content))) {
        return null;
    }
    const token = all.find(t => t.type === shape.token);
    return token === undefined ? null : (token.attrs ?? []).map(([name, value]) => [name, value] as AttrPair);
}

/** Whether the preview reads `literal` on `holder` as exactly `attrs`, in any order (`readBack`). */
export function readsBackAs(literal: string, holder: string, attrs: readonly AttrPair[]): boolean {
    const read = readBack(literal, holder);
    return read !== null && sameAttrs(read, attrs);
}

/**
 * `literal` without the id it gives, on `holder` (`READ_BACK`): `{.wide #w}` is
 * `{.wide}` (written as `normalizedLiteral` writes it), `{#w}` is `null`,
 * nothing being left. The form is kept only when the engine reads it back on
 * `holder` as exactly what it reads the original as there, less the id
 * (`readsBackAs`); otherwise — a value that needs quotes and holds a `"`, a
 * character the inline rules take — the copy loses the literal, `null`, and
 * never carries one the preview would show as text. A literal that gives no id,
 * or that the plugin does not take as attributes, is returned as it is. What a
 * copy keeps of a literal: an id must not be written twice, a class may
 * (`fidelity.ts`).
 */
export function withoutId(literal: string, holder: string): string | null {
    const pairs = parseAttrsLiteral(literal);
    if (pairs === null || pairs.every(([name]) => name !== 'id')) {
        return literal;
    }
    const rest = pairs.filter(([name]) => name !== 'id');
    const written = rest.length === 0 ? null : normalizedLiteral(rest);
    const wanted = readBack(literal, holder)?.filter(([name]) => name !== 'id');
    return written !== null && wanted !== undefined && readsBackAs(written, holder, wanted) ? written : null;
}

/**
 * Whether the text ends in a `{…}` the plugin would take as attributes of the
 * block or element it ends (its `hasDelimiters('end')`), so a name or title
 * written there would lose its end to an attribute list.
 */
export function endsWithAttrsLiteral(text: string): boolean {
    const trimmed = text.replace(/[ \t]+$/, '');
    const start = findLeftDelimiter(trimmed);
    return start >= 0 && parseAttrsLiteral(trimmed.slice(start)) !== null;
}

/**
 * What an attribute span's literal must not hold inside a note: the characters
 * `markdownItSidenote.ts` searches the raw source for (a part's `|`, `$`, `@`,
 * a note's `+`/`!`). A literal is written as it is, so nothing escapes them.
 */
export const NOTE_SYNTAX_CHARS = /[|+!$@]/;

/** An attribute name the DOM accepts; `setAttribute` throws on any other. */
const DOM_NAME = /^[A-Za-z_][-A-Za-z0-9_.:]*$/;

/**
 * Names the editor does not put on its own elements although the engine renders
 * them: an event handler would run in the editor's page, and these three would
 * change how the element is edited rather than how it looks.
 */
function editorUnsafe(name: string): boolean {
    return /^on/i.test(name) || /^(contenteditable|draggable|tabindex)$/i.test(name);
}

/**
 * The attributes the engine renders for `literal`, as the editor draws them on
 * the element the literal belongs to — class, id, style, `data-*` and the rest,
 * in the plugin's order — so the page's stylesheets style it as they style the
 * preview. Empty for a literal the plugin would not accept.
 */
export function domAttrsOf(literal: string | null | undefined): Record<string, string> {
    const pairs = literal ? parseAttrsLiteral(literal) : null;
    const out: Record<string, string> = {};
    for (const [name, value] of joinAttrs(pairs ?? [])) {
        if (DOM_NAME.test(name) && !editorUnsafe(name)) {
            out[name] = value;
        }
    }
    return out;
}
