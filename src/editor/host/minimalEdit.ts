/**
 * One replacement that turns `before` into `after`: the offsets `[start, end)`
 * in `before` and the text that replaces them.
 */
export interface MinimalReplacement {
    start: number;
    end: number;
    text: string;
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The smallest single replacement between two texts: everything outside the
 * common prefix and the common suffix.
 *
 * The webview sends the whole document back and the host writes only the span
 * that differs, because a `WorkspaceEdit` replacing the whole buffer would move
 * every other view's cursor, fold and diagnostic to the top of the file, and
 * would record the whole file as one change in the document's undo stack.
 *
 * Returns `null` when the texts are equal, so the caller writes nothing — the
 * document stays clean when nothing changed.
 *
 * A boundary never falls inside a `\r\n` pair or a surrogate pair. Either would
 * describe a replacement VS Code cannot represent: a position between `\r` and
 * `\n` does not exist in a `TextDocument`, and half a character is not text.
 */
export function minimalReplacement(before: string, after: string): MinimalReplacement | null {
    if (before === after) {
        return null;
    }
    const limit = Math.min(before.length, after.length);

    let prefix = 0;
    while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
        prefix++;
    }
    // Step back off a split pair: the shared `\r` or high surrogate belongs to
    // the replaced span when the characters after it differ.
    if (prefix > 0) {
        const last = before.charCodeAt(prefix - 1);
        if ((last === 0x0d && (before.charCodeAt(prefix) === 0x0a || after.charCodeAt(prefix) === 0x0a))
            || isHighSurrogate(last)) {
            prefix--;
        }
    }

    let suffix = 0;
    while (suffix < limit - prefix
        && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) {
        suffix++;
    }
    if (suffix > 0) {
        const first = before.charCodeAt(before.length - suffix);
        const beforeFirst = before.charCodeAt(before.length - suffix - 1);
        const afterFirst = after.charCodeAt(after.length - suffix - 1);
        if ((first === 0x0a && (beforeFirst === 0x0d || afterFirst === 0x0d)) || isLowSurrogate(first)) {
            suffix--;
        }
    }

    return {
        start: prefix,
        end: before.length - suffix,
        text: after.slice(prefix, after.length - suffix),
    };
}
