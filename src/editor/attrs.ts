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
 * It imports nothing, so the page can load it.
 */

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
 * enough (`{.}` and `{#}` are not; `{a}` is), and giving at least one
 * attribute. `null` otherwise — the plugin would leave it as text, or take it
 * and add nothing.
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
 * back: bare when nothing in it ends the value or the list — whitespace, `{`,
 * `}`, `"` — and in quotes otherwise, and when empty. A `=`, `'`, `.` or `#`
 * in a value ends nothing, so it stays bare. The plugin does not unescape: `\"`
 * inside quotes is read as the two characters `\"`, so a value that holds one
 * is written as it is. A `"` with no backslash before it (an even run of them
 * does not count) is escaped, and so is a trailing odd backslash, which would
 * escape the closing quote: no literal reads back as exactly those values, and
 * this one at least stays an attribute list.
 */
function attrValue(value: string): string {
    if (value !== '' && !/[\s{}"]/.test(value)) {
        return value;
    }
    let out = '';
    let slashes = 0;
    for (const ch of value) {
        out += ch === '"' && slashes % 2 === 0 ? '\\"' : ch;
        slashes = ch === '\\' ? slashes + 1 : 0;
    }
    return `"${out}${slashes % 2 === 1 ? '\\' : ''}"`;
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
        if ((name === 'class' || name === 'css-module') && value.split(' ').every(v => v !== '' && !/[{}"]/.test(v) && !(name === 'class' && v.startsWith('.')))) {
            const dot = name === 'class' ? '.' : '..';
            parts.push(...value.split(' ').map(v => dot + v));
            continue;
        }
        parts.push(`${name}=${attrValue(value)}`);
    }
    return `{${parts.join(' ')}}`;
}

/**
 * `literal` without the id it gives, read as the plugin reads it: `{.wide #w}`
 * is `{.wide}` (written as `normalizedLiteral` writes it), `{#w}` is `null`,
 * nothing being left. A literal that gives no id, or that the plugin does not
 * take as attributes, is returned as it is. What a copy keeps of a literal: an
 * id must not be written twice, a class may (`fidelity.ts`).
 */
export function withoutId(literal: string): string | null {
    const pairs = parseAttrsLiteral(literal);
    if (pairs === null || pairs.every(([name]) => name !== 'id')) {
        return literal;
    }
    const rest = pairs.filter(([name]) => name !== 'id');
    return rest.length === 0 ? null : normalizedLiteral(rest);
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
