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

/** An `=` with a space beside it, at `i`. */
function spacedEquals(str: string, i: number): boolean {
    return str.charAt(i) === '=' && (str.charAt(i - 1) === ' ' || str.charAt(i + 1) === ' ');
}

/**
 * Whether the `{` at `start` is the text's own brace rather than an attribute
 * literal (qjebbs/vscode-markdown-extended#146): before its closing `}` it
 * holds an `=` outside quotes with a space beside it — `@{height = 65}`, a
 * PowerShell hashtable — which no attribute list is written with
 * (`{height=65}`, `{title="a = b"}`). markdown-it-attrs would take it for
 * attributes and drop it from the text.
 */
export function isTextBrace(str: string, start: number): boolean {
    let quoted = false;
    for (let i = start + 1; i < str.length; i++) {
        if (isUnescapedDoubleQuote(str, i)) {
            quoted = !quoted;
        } else if (!quoted && str.charAt(i) === '}') {
            return false;
        } else if (!quoted && spacedEquals(str, i)) {
            return true;
        }
    }
    return false;
}

/**
 * The index of the closing `}` of every brace in `str` that is the text's own
 * (`isTextBrace`), in one pass. A `{` read the plugin's way — quotes counted
 * from the start of the string, the last `{` before a `}` the one it closes.
 */
export function textBraceCloses(str: string): number[] {
    const out: number[] = [];
    let quoted = false;
    let open = -1;
    let spaced = false;
    for (let i = 0; i < str.length; i++) {
        if (isUnescapedDoubleQuote(str, i)) {
            quoted = !quoted;
        } else if (quoted) {
            continue;
        } else if (str.charAt(i) === '{') {
            open = i;
            spaced = false;
        } else if (str.charAt(i) === '}' && open >= 0) {
            if (spaced) {
                out.push(i);
            }
            open = -1;
        } else if (open >= 0 && spacedEquals(str, i)) {
            spaced = true;
        }
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
