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
    return readBrace(str, start).spaced;
}

/**
 * The index of the closing `}` of every brace in `str` that is the text's own
 * (`isTextBrace`), in one pass: from a `{` to the first `}` outside a quoted
 * value, as markdown-it-attrs reads it — a `{` inside is read as part of it
 * (`{a = {b}` is one brace) — and on from that `}`.
 */
export function textBraceCloses(str: string): number[] {
    const out: number[] = [];
    for (let open = str.indexOf('{'); open >= 0; ) {
        const reading = readBrace(str, open);
        if (reading.close < 0) {
            break;
        }
        if (reading.spaced) {
            out.push(reading.close);
        }
        open = str.indexOf('{', reading.close + 1);
    }
    return out;
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
