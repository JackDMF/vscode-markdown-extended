/**
 * Hard-wrapping a changed paragraph, and reading back the width a paragraph was
 * wrapped at. Both halves live here because they have to agree: the width the
 * parser reads off a paragraph the serializer wrote must make the serializer
 * write that paragraph the same way again, or a block saved twice is two diffs.
 */

/**
 * Private-use characters bracketing text a line break must not fall inside: a
 * code span (a newline there becomes a space in the rendered code) and a link's
 * `](destination "title")`, image included (a newline between `]` and `(` ends
 * the link). They exist only between the inline serializer and the wrapper.
 */
export const HOLD_OPEN = String.fromCharCode(0xe000);
export const HOLD_CLOSE = String.fromCharCode(0xe001);
export const HOLD_RE = new RegExp(`[${HOLD_OPEN}${HOLD_CLOSE}]`, 'g');
const LEADING_HOLDS = new RegExp(`^[${HOLD_OPEN}${HOLD_CLOSE}]*`);

/** Code points, not UTF-16 units, and no hold markers: the width a reader counts. */
export function width(s: string): number {
    return Array.from(s.replace(HOLD_RE, '')).length;
}

/**
 * A word that must not begin a line: at a line start it would open a list, a
 * heading, a quote, a fence, a setext underline, a table, an HTML block, a
 * definition or a container instead of continuing the paragraph.
 */
export function isLineStartSyntax(word: string): boolean {
    const w = word.replace(HOLD_RE, '');
    // Whole-word markers: a bullet, a setext underline (any run of `-` or `=`),
    // a thematic break, an ATX opener, an ordered-list marker. `*emphasis*` or
    // `-foo` at a line start is none of these.
    return /^(?:[*+]|-+|=+|\*{3,}|_{3,}|#{1,6}|\d{1,9}[.)])$/.test(w) || /^(?:[>|<:~]|`{3,})/.test(w);
}

/** Escape a word that has to begin a line anyway (the first of the paragraph, or after a hard break). */
export function escapeLineStart(word: string): string {
    if (!isLineStartSyntax(word)) {
        return word;
    }
    const lead = LEADING_HOLDS.exec(word)?.[0] ?? '';
    const rest = word.slice(lead.length);
    const list = /^(\d{1,9})([.)])$/.exec(rest);
    if (list) {
        return `${lead}${list[1]}\\${list[2]}`;
    }
    return `${lead}\\${rest}`;
}

/** An unbreakable run of the line: a word, plus every following word that may not begin a line. */
interface Chunk {
    text: string;
    /** The spaces before it on the unwrapped line; `''` for the first. */
    sep: string;
}

function splitChunks(line: string): Chunk[] {
    const words: Chunk[] = [];
    let depth = 0;
    let current = '';
    let sep = '';
    let pendingSep = '';
    for (const ch of line) {
        if (ch === HOLD_OPEN) {
            depth++;
        } else if (ch === HOLD_CLOSE) {
            depth = Math.max(0, depth - 1);
        }
        if (ch === ' ' && depth === 0) {
            if (current !== '') {
                words.push({ text: current, sep });
                current = '';
                sep = '';
            }
            pendingSep += ch;
            continue;
        }
        if (current === '' && pendingSep !== '') {
            // A run of spaces is written as one: broken, it would come back as
            // one space (a softbreak), so a run kept elsewhere would wrap the
            // next save differently. HTML shows one space either way.
            sep = words.length === 0 ? '' : ' ';
            pendingSep = '';
        }
        current += ch;
    }
    if (current !== '') {
        words.push({ text: current, sep });
    }
    if (words.length > 0) {
        words[0] = { text: escapeLineStart(words[0].text), sep: '' };
    }
    const chunks: Chunk[] = [];
    for (const word of words) {
        const last = chunks[chunks.length - 1];
        if (last !== undefined && isLineStartSyntax(word.text)) {
            last.text += word.sep + word.text;
        } else {
            chunks.push({ ...word });
        }
    }
    return chunks;
}

/**
 * Greedy-wrap a paragraph's inline Markdown (hold markers included, hard breaks
 * as `\` + newline). `first` is the room on the first line, `rest` on every
 * following one. A line breaks only between chunks, so it overruns the room
 * only when it is a single chunk — which is what `measureWrapWidth` relies on.
 * Spaces at a break are dropped: two of them at a line end would be a hard
 * break.
 */
export function wrapInline(inline: string, first: number, rest: number): string[] {
    const out: string[] = [];
    const segments = inline.split('\n');
    segments.forEach((segment, k) => {
        const hardBreak = k < segments.length - 1 && segment.endsWith('\\');
        const body = (hardBreak ? segment.slice(0, -1) : segment).replace(/^ +/, '').replace(/ +$/, '');
        let line = '';
        let lineWidth = 0;
        splitChunks(body).forEach((chunk, i) => {
            const room = out.length === 0 ? first : rest;
            const candidate = lineWidth + width(chunk.sep) + width(chunk.text);
            if (i > 0 && candidate > room) {
                out.push(line);
                line = chunk.text;
                lineWidth = width(chunk.text);
                return;
            }
            line += chunk.sep + chunk.text;
            lineWidth = i === 0 ? width(chunk.text) : candidate;
        });
        out.push(hardBreak ? line + '\\' : line);
    });
    return out.map(l => l.replace(HOLD_RE, ''));
}

/**
 * Whether a line of a paragraph's content (container prefixes removed) holds a
 * place `wrapInline` could have broken it: a space outside a code span, a link
 * destination or an autolink, followed by a word that may begin a line.
 */
export function hasBreakOpportunity(content: string): boolean {
    const line = content.trim();
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === '`') {
            const run = /^`+/.exec(line.slice(i))?.[0] ?? '`';
            const close = line.indexOf(run, i + run.length);
            i = close === -1 ? i + run.length : close + run.length;
            continue;
        }
        if (line.startsWith('](', i)) {
            let depth = 0;
            let j = i + 1;
            for (; j < line.length; j++) {
                if (line[j] === '\\') {
                    j++;
                } else if (line[j] === '(') {
                    depth++;
                } else if (line[j] === ')' && --depth === 0) {
                    break;
                }
            }
            i = j + 1;
            continue;
        }
        const autolink = ch === '<' ? /^<[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*>/.exec(line.slice(i)) : null;
        if (autolink) {
            i += autolink[0].length;
            continue;
        }
        if (ch === ' ') {
            let j = i;
            while (line[j] === ' ') {
                j++;
            }
            const word = /^\S*/.exec(line.slice(j))?.[0] ?? '';
            if (word !== '' && !isLineStartSyntax(word)) {
                return true;
            }
            i = j;
            continue;
        }
        i++;
    }
    return false;
}

/**
 * The width a paragraph was wrapped at, read off its lines: `lines` are the full
 * source lines (prefixes included, since the serializer measures the same way),
 * `content` the same lines as markdown-it's inline content has them.
 *
 * The widest line that could have been broken — a line of one unbreakable
 * chunk overruns any width and is no evidence of it. That is the smallest width
 * at which greedy wrapping reproduces the lines, so a paragraph this serializer
 * wrote is written the same way again. When no line could have been broken,
 * the narrowest line: every chunk then stays on a line of its own. A paragraph
 * of one line carries no evidence of a width and gets `null`; see
 * `measureLineWidth` for what the serializer uses instead.
 */
export function measureWrapWidth(lines: readonly string[], content: readonly string[]): number | null {
    if (lines.length < 2) {
        return null;
    }
    let widest = 0;
    let narrowest = Infinity;
    lines.forEach((raw, i) => {
        const w = width(raw.replace(/[ \t]+$/, ''));
        narrowest = Math.min(narrowest, w);
        if (hasBreakOpportunity(content[i] ?? raw)) {
            widest = Math.max(widest, w);
        }
    });
    if (widest > 0) {
        return widest;
    }
    return Number.isFinite(narrowest) && narrowest > 0 ? narrowest : null;
}

/**
 * The width of a one-line paragraph, or `null` for any other. The serializer
 * wraps such a paragraph at the larger of this and its default: a short line
 * says nothing about the width (taken as one, every later edit would wrap after
 * a few words), and a long one says the author does not wrap — or that this
 * serializer wrote it at a wider `wrapWidth`, which the same rule reproduces.
 */
export function measureLineWidth(lines: readonly string[]): number | null {
    return lines.length === 1 ? width(lines[0].replace(/[ \t]+$/, '')) : null;
}
