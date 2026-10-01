/**
 * markdown-it-attrs' `{…}` literal, read the way the plugin reads it.
 *
 * The one piece of syntax the page must understand without the engine: an
 * attribute span (`[text]{.a}`) and a block's attribute suffix are drawn with
 * the attributes their literal gives, and a literal typed into a field has to be
 * checked where no parser is. Everything else about a literal — where it stands,
 * what it attaches to — is the host's parse (`blocks.ts`); this module only
 * turns a literal into attribute pairs and back.
 *
 * `readAttrs` is a port of the plugin's `getAttrs`, `findRightDelimiter` and
 * `findLeftDelimiter` (markdown-it-attrs 4.5, `utils.js`), with the default
 * delimiters and no allow-list — the extension registers the plugin without
 * options. `attrs.test.ts` holds the port to the plugin: every literal it
 * lists is rendered through the real engine and must give the same attributes.
 *
 * One rule is the extension's own, not the plugin's: a brace that is the text's
 * (`isTextBrace`, `src/syntax/attrsLiteral.ts`) is no literal. The preview's
 * wrapper of the plugin keeps such a brace from it, and this module reads it so,
 * so the preview and the editor agree.
 *
 * It imports only that module, which imports nothing, so the page can load it.
 */

import { findLeftDelimiter, findRightDelimiter, isTextBrace, isUnescapedDoubleQuote } from '../syntax/attrsLiteral';

export { findLeftDelimiter, findRightDelimiter };

/** One attribute as the plugin reads it: `[name, value]`. */
export type AttrPair = [string, string];

/**
 * The `{…}` a text or a line ends with as markdown-it-attrs finds it — from the
 * last `{` outside a quoted value, through the end, trailing spaces aside —
 * when it is a literal the plugin takes as attributes (`parseAttrsLiteral`);
 * `null` otherwise. Unlike `findAttrsSuffix` (`blocks.ts`) it reads a quoted
 * `}` (`{title="a}"}`) as the plugin does. A text ending in one would lose its
 * end to an attribute list.
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
 * The attribute pairs of `literal` when it is a whole `{…}` the plugin accepts
 * as attributes: one line, `{` first, the first `}` outside quotes last, long
 * enough (`{.}` and `{#}` are not; `{a}` is), and giving at least one
 * attribute, and no brace of the text's own (`isTextBrace`: `{a = 1}`). `null` otherwise —
 * the plugin would leave it as text, or take it and add nothing.
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
 * A literal that the plugin reads as exactly `attrs` (a token's joined
 * attributes): `{#id .a .b key="v"}`. The form written when the literal an
 * author wrote could not be recovered from the source (`blocks.ts`).
 */
export function normalizedLiteral(attrs: readonly AttrPair[]): string {
    const parts: string[] = [];
    const id = attrs.find(([n]) => n === 'id');
    if (id && id[1] !== '' && !/[\s{}"]/.test(id[1])) {
        parts.push(`#${id[1]}`);
    }
    for (const [name, value] of attrs) {
        if (name === 'id' && parts[0] === `#${value}`) {
            continue;
        }
        if ((name === 'class' || name === 'css-module') && value.split(' ').every(v => v !== '' && !/[{}"]/.test(v))) {
            const dot = name === 'class' ? '.' : '..';
            parts.push(...value.split(' ').map(v => dot + v));
            continue;
        }
        parts.push(/[\s}]/.test(value) || value === '' ? `${name}="${value}"` : `${name}=${value}`);
    }
    return `{${parts.join(' ')}}`;
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
