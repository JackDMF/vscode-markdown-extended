/**
 * Where markdown-it-attrs' `{…}` literal starts and ends, and the one rule the
 * extension adds to its reading: a brace that is the text's own.
 *
 * Two places read it: the preview's wrapper of the plugin
 * (`src/plugin/markdownItAttrs.ts`), which keeps such a brace from the plugin,
 * and the Visual Editor's port of the plugin (`src/editor/attrs.ts`), which
 * reads a literal without the engine. Both import this module, so the preview
 * and the editor cannot disagree about what is a literal.
 *
 * It imports nothing — neither `vscode` nor markdown-it — because the editor's
 * webview loads it too.
 */

/** Whether the character at `i` is a `"` no odd run of backslashes escapes, as the plugin tests it. */
export function isUnescapedDoubleQuote(str: string, i: number): boolean {
    if (str.charAt(i) !== '"') {
        return false;
    }
    let slashes = 0;
    for (let n = i - 1; n >= 0 && str.charAt(n) === '\\'; n--) {
        slashes++;
    }
    return slashes % 2 === 0;
}

/** The first `}` at or after `start` outside a quoted value, or -1 (the plugin's `findRightDelimiter`). */
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

/** The last `{` outside a quoted value, or -1 (the plugin's `findLeftDelimiter`). */
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

/** What `readBrace` finds of the `{…}` at an index. */
export interface BraceReading {
    /** The `}` that closes it, outside a quoted value; -1 when none does. */
    close: number;
    /** The index of every `=` that separates a key from its value. */
    separators: number[];
    /** Whether a space stands beside one of those `=` (`isTextBrace`). */
    spaced: boolean;
}

/**
 * The `{…}` at `open` read as markdown-it-attrs' `getAttrs` reads it, up to
 * the first `}` outside a quoted value: a pair is a key, an `=` and a value,
 * `.a` and `#a` start a value at once, a space ends a pair, and a `"` opens a
 * quoted value only where the value is still empty. Only the `=` read while
 * reading a key separates; one inside a value is the value's (`{data-h=YQ==}`).
 */
export function readBrace(str: string, open: number): BraceReading {
    const allowedKeyChars = /[^\t\n\f />"'=]/;
    const separators: number[] = [];
    let spaced = false;
    let key = '';
    let value = '';
    let parsingKey = true;
    let quoted = false;
    for (let i = open + 1; i < str.length; i++) {
        const ch = str.charAt(i);
        if (!quoted && ch === '}') {
            return { close: i, separators, spaced };
        }
        if (ch === '=' && parsingKey) {
            parsingKey = false;
            separators.push(i);
            spaced = spaced || str.charAt(i - 1) === ' ' || str.charAt(i + 1) === ' ';
            continue;
        }
        if ((ch === '.' || ch === '#') && key === '') {
            if (ch === '.' && str.charAt(i + 1) === '.') {
                i += 1;
            }
            key = ch;
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
            if (key !== '') {
                key = '';
                value = '';
                parsingKey = true;
            }
            continue;
        }
        if (parsingKey && ch.search(allowedKeyChars) === -1) {
            continue;
        }
        if (parsingKey) {
            key += ch;
        } else {
            value += ch;
        }
    }
    return { close: -1, separators, spaced };
}

/**
 * Whether the `{` at `start` is the text's own brace rather than an attribute
 * literal (qjebbs/vscode-markdown-extended#146): a space stands beside an `=`
 * that separates a key from its value — `@{height = 65}`, a PowerShell
 * hashtable — which no attribute list is written with (`{height=65}`,
 * `{title="a = b"}`, `{data-h=YQ==}`). markdown-it-attrs would take it for
 * attributes and drop it from the text.
 */
export function isTextBrace(str: string, start: number): boolean {
    const reading = readBrace(str, start);
    return reading.close >= 0 && reading.spaced;
}

/**
 * How many end literals markdown-it-attrs strips off one text at most: a list
 * item's (`list item end`), then its paragraph's (`end of block`).
 */
const END_READINGS = 2;

/**
 * The index of the `}` attrs' test finds for every literal it would read off
 * `str` that is a brace of the text's own (`isTextBrace`) — the places to split
 * the text so that test fails. They are the literals it reads, the way it reads
 * them, and no others:
 *
 * - at the start (after inline markup, `*em*{…}`): from the `{` to the first `}`
 *   outside quotes, then again from after a literal it took (`*em*{.a}{.b}`);
 * - at the end: from the **last** `{` outside quotes to a `}` that ends the
 *   text, then again from the end of what is left once it took one — so
 *   `x {y = {a=b}` ends in the literal `{a=b}`, which is attributes.
 */
export function textBraceCloses(str: string): number[] {
    const out: number[] = [];
    let offset = 0;
    let rest = str;
    while (rest.startsWith('{')) {
        const close = findRightDelimiter(rest, 2);
        if (close < 0) {
            break;
        }
        if (readBrace(rest, 0).spaced) {
            out.push(offset + close);
            break;
        }
        // The rule cuts the literal off at the first `}`, quoted or not.
        const cut = rest.indexOf('}') + 1;
        offset += cut;
        rest = rest.slice(cut);
    }
    let end = str;
    for (let n = 0; n < END_READINGS; n++) {
        const open = findLeftDelimiter(end);
        if (open < 0 || findRightDelimiter(end, open + 2) !== end.length - 1) {
            break;
        }
        if (readBrace(end, open).spaced) {
            if (!out.includes(end.length - 1)) {
                out.push(end.length - 1);
            }
            break;
        }
        // What is left once the literal is taken: the text before it, less one space.
        end = end.slice(0, open);
        if (end.endsWith(' ')) {
            end = end.slice(0, -1);
        }
    }
    return out.sort((a, b) => a - b);
}

/**
 * The brace at `start` with the spaces beside each separating `=` taken out:
 * `{width = 50%}` → `{width=50%}`, the attribute list its author meant.
 */
export function tightenedBrace(str: string, start: number): string {
    let out = str;
    for (const at of [...readBrace(str, start).separators].reverse()) {
        let from = at;
        while (out.charAt(from - 1) === ' ') { from--; }
        let to = at + 1;
        while (out.charAt(to) === ' ') { to++; }
        out = `${out.slice(0, from)}=${out.slice(to)}`;
    }
    return out;
}

/**
 * The text without the brace of its own it ends with (`{a = b}`), trailing
 * spaces aside; the text, trimmed, when it ends in none. What a container's
 * class is made of (`::: note {a = b}` is `class="note"`, as it was while
 * markdown-it-attrs took such a brace off the info): braces are no class names.
 */
export function withoutTextBraceEnd(text: string): string {
    const trimmed = text.trim();
    const start = findLeftDelimiter(trimmed);
    const closes = start >= 0 && findRightDelimiter(trimmed, start + 1) === trimmed.length - 1;
    return closes && isTextBrace(trimmed, start) ? trimmed.slice(0, start).trim() : trimmed;
}
