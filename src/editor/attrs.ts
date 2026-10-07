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
 * One rule is the extension's own, not the plugin's: a brace that is the text's
 * (`isTextBrace`, `src/syntax/attrsLiteral.ts`) is no literal. The preview's
 * wrapper of the plugin keeps such a brace from it, and `parseAttrsLiteral`
 * reads it so, so the preview and the editor agree.
 *
 * What the port does not model is where a literal is read. The plugin reads a
 * fence's literal off its info string and a table's off the raw text of the
 * paragraph under it, but a paragraph's, a heading's, a list's, a quote's, a
 * rule's and a span's off the tokens markdown-it's inline rules made of it —
 * and there a `\`, an entity, a code span, emphasis, HTML, a URL or a plugin's
 * markup cuts it into pieces the plugin no longer sees as attributes, so the
 * preview shows it as text. `parseAttrsLiteral` only parses; whether the
 * preview reads a literal in a place is asked of markdown-it-attrs itself, in
 * the smallest source for that place (`attrsReadAt`), and that one answer is
 * what the host's parse recognises a literal by (`blocks.ts`), what the
 * Attributes field accepts and what a copy keeps (`withoutId`).
 */

import { findLeftDelimiter, findRightDelimiter, isTextBrace, isUnescapedDoubleQuote } from '../syntax/attrsLiteral';
import { InlineEngineDefinition, attrsEngineFor, currentInlineDefinition } from './inlineEngine';

export { findLeftDelimiter, findRightDelimiter };

/** One attribute as the plugin reads it: `[name, value]`. */
export type AttrPair = [string, string];

/**
 * The `{…}` a text or a line ends with as markdown-it-attrs finds it — from the
 * last `{` outside a quoted value, through the end, trailing spaces aside —
 * when it is a literal the plugin takes as attributes (`parseAttrsLiteral`);
 * `null` otherwise; a quoted `}` (`{title="a}"}`) is read as the plugin reads
 * it. The plugin reads so a fence's info string and a rule's line, which no
 * inline rule cuts, and this is the one reader of those and of a text that
 * would lose its end to an attribute list; a literal at the end of inline text
 * is the one the plugin took off its last text token (`takenLiteral`,
 * `blocks.ts`). Whether the preview reads it where it stands is the caller's
 * question (`attrsReadAt`).
 */
export function endLiteralOf(text: string): string | null {
    const trimmed = text.replace(/[ \t]+$/, '');
    const start = findLeftDelimiter(trimmed);
    if (start < 0) {
        return null;
    }
    const literal = trimmed.slice(start);
    return parseAttrsLiteral(literal) === null ? null : literal;
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
 * The attribute pairs of `literal` when it is a whole `{…}` the plugin's
 * `getAttrs` takes as attributes: one line, `{` first, the first `}` outside
 * quotes last, long enough (`{.}` and `{#}` are not; `{a}` is), giving at
 * least one attribute, and no brace of the text's own (`isTextBrace`:
 * `{a = 1}`). `null` otherwise. It parses only: whether the preview reads the
 * literal where it stands is the place's question (`attrsReadAt`).
 */
export function parseAttrsLiteral(literal: string): AttrPair[] | null {
    if (!literal.startsWith('{') || !literal.endsWith('}') || /[\r\n]/.test(literal) || isTextBrace(literal, 0)) {
        return null;
    }
    const first = literal.charAt(1);
    const minimum = first === '.' || first === '#' ? 4 : 3;
    if (literal.length < minimum || findRightDelimiter(literal, 2) !== literal.length - 1) {
        return null;
    }
    const pairs = readAttrs(literal, 0);
    return pairs.length > 0 ? pairs : null;
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
 * `{`, `}` — or it holds a `=`, which a brace of the text's own is told by
 * (`isTextBrace`), or it is empty or starts with `"`, which would open a
 * quote; in quotes otherwise. A `'`, `.`, `#` or a `"` after the first
 * character ends nothing, so it stays bare (`k=a"b"`). Nothing is escaped: markdown-it
 * reads a `\` before the plugin does, and a literal holding one is text in the
 * preview. So a value that holds a `\`, or needs quotes and holds a `"`,
 * cannot be written, `null`.
 */
function attrValue(value: string): string | null {
    if (value.includes('\\')) {
        return null;
    }
    if (value !== '' && !/[\s{}=]/.test(value) && !value.startsWith('"')) {
        return value;
    }
    return value.includes('"') ? null : `"${value}"`;
}

/**
 * The literal written for `attrs` (a token's joined attributes, or the pairs a
 * literal gives): `{#id .a .b key="v"}`, or `null` when a value cannot be
 * written (`attrValue`). The form written when the literal an author wrote
 * could not be recovered from the source (`blocks.ts`), and a copy's literal
 * without its id (`withoutId`). The port reads it back as `attrs`, or it is
 * `null`: a bare value with an odd number of `"` (`k=a"b`) would open a quote
 * that runs past the `}`. It is a candidate: whether the preview reads it
 * where it is written is that place's question (`attrsReadAt`).
 */
export function normalizedLiteral(attrs: readonly AttrPair[]): string | null {
    const written = writtenLiteral(attrs);
    const back = written === null ? null : parseAttrsLiteral(written);
    return back !== null && sameAttrs(joinAttrs(back), joinAttrs(attrs)) ? written : null;
}

/** `normalizedLiteral`'s form for `attrs`, before the port reads it back. */
function writtenLiteral(attrs: readonly AttrPair[]): string | null {
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
 * markdown-it-attrs gives it to. The plugin reads a fence's literal off its
 * info string and a table's off the paragraph under it, raw; every other one
 * off the tokens the inline rules made. A fence's is read on the fence it is
 * written on, by its character (`fenceHolder`): an info string after backticks
 * holds no backtick, after tildes it may. A paragraph's literal on a line of
 * its own is one text after a soft break, as at its end; a list's under its
 * last line the same as after a blank line.
 */
const READ_BACK: Record<string, { source: (literal: string) => string; token: string }> = {
    paragraph: { source: l => `x ${l}`, token: 'paragraph_open' },
    heading: { source: l => `# x ${l}`, token: 'heading_open' },
    'list_item': { source: l => `- x ${l}`, token: 'list_item_open' },
    'bullet_list': { source: l => `- x\n\n${l}`, token: 'bullet_list_open' },
    'ordered_list': { source: l => `1. x\n\n${l}`, token: 'ordered_list_open' },
    'code_block': { source: l => `\`\`\`x ${l}\n\`\`\``, token: 'fence' },
    'code_block~': { source: l => `~~~x ${l}\n~~~`, token: 'fence' },
    'horizontal_rule': { source: l => `--- ${l}`, token: 'hr' },
    blockquote: { source: l => `> x\n> ${l}`, token: 'blockquote_open' },
    table: { source: l => `| x |\n| - |\n\n${l}`, token: 'table_open' },
    span: { source: l => `[x]${l}`, token: 'span_open' },
};

/**
 * The holder (`READ_BACK`) of a fence's literal, by the fence it is written on
 * (`markup`, its opening run): `code_block~` after tildes, `code_block` after
 * backticks.
 */
export function fenceHolder(markup: string): string {
    return markup.startsWith('~') ? 'code_block~' : 'code_block';
}

/**
 * The attributes markdown-it-attrs gives `holder` (`READ_BACK`) for `literal`,
 * read with the engine `definition` describes and the plugin itself where the
 * definition says the host runs it (`attrsEngineFor`) — with VS Code's math,
 * when it runs, as its stand-in (`mathStandIn.ts`), which takes a `$…$` it
 * reads as math first; `null` when the literal, or part of it, is left as
 * text — always, where the host reads no attributes — or `holder` is none the
 * editor writes a literal for.
 */
export function readBack(literal: string, holder: string, definition: InlineEngineDefinition = currentInlineDefinition()): AttrPair[] | null {
    const shape = Object.prototype.hasOwnProperty.call(READ_BACK, holder) ? READ_BACK[holder] : undefined;
    if (shape === undefined) {
        return null;
    }
    const tokens = attrsEngineFor(definition).parse(shape.source(literal), {});
    const all = tokens.flatMap(t => [t, ...(t.children ?? [])]);
    if (all.some(t => t.type === 'text' && /[{}]/.test(t.content))) {
        return null;
    }
    const token = all.find(t => t.type === shape.token);
    return token === undefined ? null : (token.attrs ?? []).map(([name, value]) => [name, value] as AttrPair);
}

/**
 * The attributes the preview gives `holder` for `literal` written where that
 * holder's literal stands, or `null` when it gives none of it: the literal
 * does not parse (`parseAttrsLiteral`), or the plugin, reading it there
 * (`readBack`), leaves part of it as text or reads other attributes than it
 * gives. The one answer to "is this a literal here": the host's parse
 * recognises a block's or a span's literal by it (`blocks.ts`), the
 * Attributes field accepts by it (`literalRefusal`), a copy keeps by it
 * (`withoutId`). `definition` is the engine's that read the file, on the host;
 * the page's posted one by default.
 */
export function attrsReadAt(literal: string, holder: string, definition: InlineEngineDefinition = currentInlineDefinition()): AttrPair[] | null {
    const pairs = parseAttrsLiteral(literal);
    if (pairs === null) {
        return null;
    }
    const read = readBack(literal, holder, definition);
    return read !== null && sameAttrs(read, joinAttrs(pairs)) ? read : null;
}

/** Whether the preview reads `literal` on `holder` as exactly `attrs`, in any order (`attrsReadAt`). */
export function readsBackAs(literal: string, holder: string, attrs: readonly AttrPair[], definition: InlineEngineDefinition = currentInlineDefinition()): boolean {
    const read = attrsReadAt(literal, holder, definition);
    return read !== null && sameAttrs(read, attrs);
}

/**
 * `literal` without the id it gives, on `holder` (`READ_BACK`): `{.wide #w}` is
 * `{.wide}` (written as `normalizedLiteral` writes it), `{#w}` is `null`,
 * nothing being left. The form is kept only when the preview reads it on
 * `holder` as exactly what it reads the original as there, less the id
 * (`readsBackAs`); otherwise — a value that needs quotes and holds a `"`, a
 * character the inline rules take there, an original the preview shows as
 * text there — the copy loses the literal, `null`, and never carries one the
 * preview would show as text. A literal that gives no id, or does not parse,
 * is returned as it is. What a copy keeps of a literal: an id must not be
 * written twice, a class may (`fidelity.ts`).
 */
export function withoutId(literal: string, holder: string): string | null {
    const pairs = parseAttrsLiteral(literal);
    if (pairs === null || pairs.every(([name]) => name !== 'id')) {
        return literal;
    }
    const rest = pairs.filter(([name]) => name !== 'id');
    const written = rest.length === 0 ? null : normalizedLiteral(rest);
    const wanted = attrsReadAt(literal, holder)?.filter(([name]) => name !== 'id');
    return written !== null && wanted !== undefined && readsBackAs(written, holder, wanted) ? written : null;
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
 * preview. Empty for a literal that does not parse; a node holds only a
 * literal its place reads (`attrsReadAt`), so the parse is enough here.
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
