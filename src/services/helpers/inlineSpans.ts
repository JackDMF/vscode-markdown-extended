import { isLineStartSyntax } from '../../editor/wrap';
import { INLINE_MARKERS, WORD_CHARACTER, isHalfMarker, opensInsideWords } from '../../syntax/markers';

/**
 * What the text editor's inline toggles read in a document: the spans an
 * inline marker formats on a line, and which lines hold text a marker may be
 * written into. Kept apart from `toggleFormat.ts`, and free of `vscode`, so the
 * rules can be tested as text.
 */

/** A formatted span on a line, markers included, as offsets in the line. */
export interface InlineSpan {
    start: number;
    end: number;
}

/**
 * The spans a marker formats on one line, left to right, each closed by the
 * nearest marker that can close it. A span holds at least one character, with
 * no whitespace inside either marker; a span of one character is not of the
 * marker's own character (`*****` is no span), and a longer one does not start
 * or end with the marker itself (`****` is an empty pair). A marker opens at
 * the start of a run of its character and closes at the run's end. Where it is
 * half of a longer one (`*` of `**`), that run is one or three long, so
 * `**bold**` is no italics but `***bold***` and `*see **this***` are. A code
 * span's backticks are exactly the marker; `_` neither opens nor
 * closes next to a word character; a `^` after `[` begins a footnote
 * reference, not a superscript.
 */
export function findSpans(text: string, marker: string): InlineSpan[] {
    const c = marker[0];
    const length = marker.length;
    const half = isHalfMarker(marker);
    const exact = marker === INLINE_MARKERS.codeInline;
    const shy = !opensInsideWords(marker);
    const runBefore = (i: number) => { let n = 0; while (text[i - 1 - n] === c) {n++;} return n; };
    const runAfter = (i: number) => { let n = 0; while (text[i + n] === c) {n++;} return n; };
    const isWord = (ch: string | undefined) => !!ch && WORD_CHARACTER.test(ch);
    const runFits = (run: number) => exact ? run === length : run === 1 || run === 3;
    // a marker opens at the start of a run of its character, and closes at its end.
    const opensAt = (i: number) => {
        if (!text.startsWith(marker, i) || runBefore(i) > 0) {return false;}
        if (c === '^' && text[i - 1] === '[') {return false;}
        if (shy && isWord(text[i - 1])) {return false;}
        return !(half || exact) || runFits(runAfter(i));
    };
    // `at` is where the closing marker starts.
    const closesAt = (at: number) => {
        if (!text.startsWith(marker, at) || runAfter(at + length) > 0) {return false;}
        if (c === '^' && text[at - 1] === '[') {return false;}
        if (shy && isWord(text[at + length])) {return false;}
        return !(half || exact) || runFits(runBefore(at + length));
    };
    // the text inside: no space at either end, and not starting or ending with
    // the marker itself, so an empty pair `****` opens no span.
    const holds = (from: number, to: number) => {
        if (to - from === 1) {return !/\s/.test(text[from]) && text[from] !== c;}
        if (to <= from || /\s/.test(text[from]) || /\s/.test(text[to - 1])) {return false;}
        return half || exact || (!text.startsWith(marker, from) && !text.startsWith(marker, to - length));
    };
    const spans: InlineSpan[] = [];
    let i = 0;
    while (i < text.length) {
        let closed = -1;
        if (opensAt(i)) {
            for (let at = i + length + 1; at + length <= text.length; at++) {
                if (closesAt(at) && holds(i + length, at)) {closed = at; break;}
            }
        }
        if (closed < 0) {i++; continue;}
        spans.push({ start: i, end: closed + length });
        i = closed + length;
    }
    return spans;
}

/** A line's block prefix: indentation, a quote's `>`, a bullet and its task box, a number, a heading's `#`s, a definition's `:` or `~`. */
const BLOCK_PREFIX = /^[^\S\n]*(?:(?:>|[-*+](?=\s)(?:[^\S\n]+\[[ xX]\](?=\s))?|\d{1,9}[.)](?=\s)|#{1,6}(?=\s)|[:~](?=\s))[^\S\n]*)*/;
const LIST_ITEM = /^[^\S\n]*(?:[-*+]|\d{1,9}[.)])\s/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MATH_FENCE = /^\s*\$\$/;
const MATH_LINE = /^\s*\$\$.+\$\$\s*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[^\S\n]*\1){2,}[^\S\n]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[^\S\n]*$/;
const HTML_START = /^ {0,3}<[A-Za-z/!?]/;
const TABLE_DELIMITER = /^[^\S\n]*\|?[^\S\n]*:?-+:?[^\S\n]*(?:\|[^\S\n]*:?-+:?[^\S\n]*)*\|?[^\S\n]*$/;
const OWN_LINE = /^\s*(?:!!!|:::)|^ {0,3}\[[^\]]+\]:/;
const INDENTED = /^(?: {4}|\t)/;

/**
 * What a line is to an inline marker: `text` it may be written into after the
 * line's block prefix (`prefix` characters: a bullet and its task box, a
 * number, `#`, `>`, a definition's `:`); `literal`, where a marker would be
 * shown as written — a fence and the code or math it holds, indented code, an
 * HTML block; or `structure`, a line that is a block's syntax rather than text
 * — a table row, a setext underline, a thematic break, an admonition's or a
 * container's opening line, a footnote or link definition.
 */
export interface LineStart {
    kind: 'text' | 'literal' | 'structure';
    prefix: number;
}

/**
 * What each line of a document is to an inline marker, read from its first
 * line on. A line whose first word `isLineStartSyntax` (`src/editor/wrap.ts`)
 * calls a block's syntax is a fence, a break, a table row, an HTML block or a
 * container, or else that syntax is its prefix.
 */
export function lineStarts(lines: string[]): LineStart[] {
    const starts: LineStart[] = [];
    let fence: string | undefined;
    let math = false;
    let html = false;
    let table = false;
    let code = false;
    let list = false;
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        const blank = !line.trim();
        let kind: LineStart['kind'] = 'text';
        if (fence) {
            kind = 'literal';
            if (FENCE.exec(line)?.[1].startsWith(fence)) {fence = undefined;}
        } else if (math) {
            kind = 'literal';
            if (MATH_FENCE.test(line)) {math = false;}
        } else if (blank) {
            html = table = false;
        } else if (html) {
            kind = 'literal';
        } else if (INDENTED.test(line) && !list && (code || n === 0 || !lines[n - 1].trim())) {
            kind = 'literal';
            code = true;
        } else {
            code = false;
            const word = line.trim().split(/\s+/)[0];
            const syntax = isLineStartSyntax(word);
            const fenced = syntax ? FENCE.exec(line) : null;
            if (fenced) {
                kind = 'literal';
                fence = fenced[1];
            } else if (syntax && HTML_START.test(line)) {
                kind = 'literal';
                html = true;
            } else if (MATH_FENCE.test(line)) {
                kind = 'literal';
                math = !MATH_LINE.test(line);
            } else if (syntax && (THEMATIC_BREAK.test(line) || SETEXT_UNDERLINE.test(line) || word.startsWith('|') || word.startsWith(':::'))) {
                kind = 'structure';
                table = table || word.startsWith('|');
            } else if (OWN_LINE.test(line)) {
                kind = 'structure';
            } else if (line.includes('|') && (table || TABLE_DELIMITER.test(line))) {
                kind = 'structure';
                // the header row above the delimiter row is the table's too.
                if (!table && n > 0 && lines[n - 1].includes('|')) {starts[n - 1] = { ...starts[n - 1], kind: 'structure' };}
                table = true;
            }
            if (LIST_ITEM.test(line)) {list = true;}
            else if (!INDENTED.test(line)) {list = false;}
        }
        starts.push({ kind, prefix: kind === 'text' ? BLOCK_PREFIX.exec(line)[0].length : 0 });
    }
    return starts;
}
