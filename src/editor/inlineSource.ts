import { Environment, MarkdownIt, Token } from '../@types/markdown-it';
import { INLINE_MARKERS } from '../syntax/markers';
import { ENTITY, Lines, NEWLINE, NOTE_ANCHORS, UNMATCHABLE, Unit, align, normalize } from './alignment';

/**
 * A document's lines and inline spans as the engine reads them, for the text
 * editor's inline toggles.
 *
 * The toggles write markers into text and take them out again, so they need
 * three facts the preview already has: which lines are text a marker can go
 * into, where on a line that text is, and which spans a marker formats. All
 * three are read from the tokens of the engine the Visual Editor parses with
 * (`engine.ts`), never re-derived from the characters: a code span's `**`, an
 * escaped `\*`, a fence inside a list or a quote, an HTML block, an
 * admonition's body and a footnote's continuation are what the engine says
 * they are.
 *
 * **Lines** come from the block tokens' maps. A fence, indented code, an HTML
 * block, the front matter and a math block are `literal`; a line an inline
 * token maps is `text`; any other line a token maps, or a line no token maps
 * that holds more than whitespace (a link reference definition, a container's
 * closing `:::`), is `structure`; a line of whitespace is `blank`. Literal
 * wins over text, text over structure.
 *
 * **Text and spans** come from an inline token's children, which carry no
 * positions. The children's text is aligned with the block's source as the
 * Visual Editor aligns a block (`alignment.ts`): each text character is a
 * unit, a code span's characters (its backtick runs included) and inline
 * HTML's are units nothing may be written into, an image is its `![alt]`, an
 * emoji or a footnote reference one unit that matches nothing, and the
 * delimiters — markers, a line's prefix, a link's URL — are what the alignment
 * leaves between units. A table row is its cells joined by `|`s.
 *
 * A code span stands where its backtick runs matched. Any other span's
 * markers are found in the gap the alignment leaves where its tokens stand:
 * the opening marker the last of its kind before the span's first unit, the
 * closing one the first after its last, an inner span claiming its run first
 * so `***x***` is two spans with markers of their own. The search never leaves
 * the gap, which holds no text, so removing a span's markers cannot remove
 * text. Where a marker is not found there, or the block was too large to align
 * exactly, the span is not exact.
 *
 * Each block is aligned the first time one of its lines is asked about.
 */

export type LineKind = 'text' | 'blank' | 'literal' | 'structure';

/**
 * A stretch of one line's text a marker may be written at either end of, as
 * document offsets (CRLF-true): it starts and ends with a text character, and
 * holds no code, HTML, link boundary or line prefix. `continues` says that
 * between it and the stretch before it on the line stand only what a pair of
 * markers may enclose whole — another span's markers, a code span, an image,
 * an emoji, a footnote reference — so a selection over both is one part.
 */
export interface TextStretch {
    start: number;
    end: number;
    continues: boolean;
}

/** A span the engine formats, as document offsets, its markers included. */
export interface SourceSpan {
    start: number;
    end: number;
    /** The marker as written: a code span's backtick run is as long as it was written. */
    markup: string;
    /** Whether both markers were found where the tokens say, in an exactly aligned block. */
    exact: boolean;
}

export interface InlineSource {
    kindOf(line: number): LineKind;
    /** The line's text stretches, in order; none unless the line is `text`. */
    textOn(line: number): TextStretch[];
    /** The spans of `marker` that touch the line; for `` ` ``, every code span. */
    spansOn(line: number, marker: string): SourceSpan[];
    /** The lines `[start, end)` of the outermost block a token maps over the line; the line alone when none does. */
    blockOf(line: number): { start: number; end: number };
}

/** The document `text` read with `md`, the engine the Visual Editor parses with. */
export function readInlineSource(md: MarkdownIt, text: string, env: Environment = {}): InlineSource {
    return new DocumentInlineSource(text, md.parse(text, env));
}

const RANK: Record<LineKind, number> = { blank: 0, structure: 1, text: 2, literal: 3 };
const KINDS: LineKind[] = ['blank', 'structure', 'text', 'literal'];

/** Block tokens whose lines are shown as written. */
const LITERAL_BLOCKS: ReadonlySet<string> = new Set(['fence', 'code_block', 'html_block', 'front_matter']);

/** The markers of the spans a selection may run across: every inline toggle's but the code span's, whose content is not text. */
const PAIR_MARKERS: ReadonlySet<string> = new Set<string>(Object.values(INLINE_MARKERS).filter(m => m !== INLINE_MARKERS.codeInline));

function isLiteral(token: Token): boolean {
    if (LITERAL_BLOCKS.has(token.type)) {
        return true;
    }
    // A plugin's raw block, `$$` math among them: content of its own and no inline children.
    return /_block(?:_eqno)?$/.test(token.type) && token.content !== '' && !token.children?.length;
}

/** What a unit is to a stretch: text, something a pair of markers may enclose whole, or a boundary. */
const TEXT = 2;
const ENCLOSED = 1;
const BOUNDARY = 0;

/** One inline block: the inline tokens of a paragraph, a heading, a cell's row, and the lines they map. */
interface Group {
    first: number;
    end: number;
    inlines: Token[];
    row: boolean;
    read?: Reading;
}

interface Reading {
    stretches: Map<number, TextStretch[]>;
    spans: SourceSpan[];
}

/** A span as the tokens give it: its marker and the units before which its markers stand. */
interface TokenSpan {
    markup: string;
    /** The number of units emitted before its opening and its closing token, and the order the tokens came in. */
    open: number;
    close: number;
    openOrder: number;
    closeOrder: number;
}

interface Emitted {
    units: Unit[];
    /** Per unit: `TEXT`, `ENCLOSED` or `BOUNDARY`. */
    roles: number[];
    /** Per unit: the strongest of the tokens before it since the unit before — 1 a pair's marker, 2 a boundary. */
    barriers: number[];
    spans: TokenSpan[];
    codes: CodeUnits[];
}

/** A code span's units, `[start, end)`: its backtick runs and its content. */
interface CodeUnits {
    markup: string;
    start: number;
    end: number;
}

class DocumentInlineSource implements InlineSource {
    private readonly lines: Lines;
    private readonly kinds: Uint8Array;
    private readonly groupOf: Int32Array;
    private readonly groups: Group[] = [];
    private readonly blockStart: Int32Array;
    private readonly blockEnd: Int32Array;

    constructor(private readonly text: string, tokens: Token[]) {
        this.lines = new Lines(text);
        const count = this.lines.count;
        const rank = new Uint8Array(count);
        this.groupOf = new Int32Array(count).fill(-1);
        this.blockStart = new Int32Array(count).fill(-1);
        this.blockEnd = new Int32Array(count).fill(-1);
        const claim = (from: number, to: number, kind: LineKind) => {
            for (let line = Math.max(0, from); line < Math.min(to, count); line++) {
                rank[line] = Math.max(rank[line], RANK[kind]);
            }
        };
        let outerEnd = -1;
        tokens.forEach((token, index) => {
            if (!token.map) {
                return;
            }
            const [from, to] = token.map;
            // Tokens come in document order: one that starts past the last outer block is the next outer one.
            if (from >= outerEnd) {
                for (let line = Math.max(0, from); line < Math.min(to, count); line++) {
                    this.blockStart[line] = from;
                    this.blockEnd[line] = to;
                }
                outerEnd = Math.max(to, from + 1);
            }
            if (isLiteral(token)) {
                claim(from, to, 'literal');
            } else if (token.type === 'inline') {
                // A definition's term maps no line of its own ([n, n]): it is its line.
                const end = Math.max(to, from + 1);
                claim(from, end, 'text');
                this.addInline(token, from, end, tokens[index - 1]);
            } else {
                claim(from, to, 'structure');
            }
        });
        this.kinds = new Uint8Array(count);
        for (let line = 0; line < count; line++) {
            const blank = rank[line] < RANK.text && /^\s*$/.test(text.slice(this.lines.startOf(line), this.lines.endOf(line)));
            this.kinds[line] = blank ? RANK.blank : Math.max(rank[line], RANK.structure);
        }
    }

    kindOf(line: number): LineKind {
        return line >= 0 && line < this.kinds.length ? KINDS[this.kinds[line]] : 'blank';
    }

    textOn(line: number): TextStretch[] {
        if (this.kindOf(line) !== 'text' || this.groupOf[line] < 0) {
            return [];
        }
        return this.reading(this.groups[this.groupOf[line]]).stretches.get(line) ?? [];
    }

    spansOn(line: number, marker: string): SourceSpan[] {
        if (this.kindOf(line) !== 'text' || this.groupOf[line] < 0) {
            return [];
        }
        const from = this.lines.startOf(line);
        const to = this.lines.endOf(line);
        const code = marker === INLINE_MARKERS.codeInline;
        return this.reading(this.groups[this.groupOf[line]]).spans
            .filter(s => (code ? s.markup.startsWith(marker) : s.markup === marker) && s.start <= to && s.end >= from);
    }

    blockOf(line: number): { start: number; end: number } {
        const inside = line >= 0 && line < this.blockStart.length && this.blockStart[line] >= 0;
        return inside ? { start: this.blockStart[line], end: this.blockEnd[line] } : { start: line, end: line + 1 };
    }

    /** An inline token joins the group before it when both are cells of one table row. */
    private addInline(token: Token, first: number, end: number, before: Token | undefined): void {
        const cell = before !== undefined && (before.type === 'th_open' || before.type === 'td_open');
        const last = this.groups[this.groups.length - 1];
        if (cell && last?.row && last.first === first && last.end === end) {
            last.inlines.push(token);
            return;
        }
        this.groups.push({ first, end, inlines: [token], row: cell });
        for (let line = first; line < Math.min(end, this.groupOf.length); line++) {
            if (this.groupOf[line] < 0) {
                this.groupOf[line] = this.groups.length - 1;
            }
        }
    }

    private reading(group: Group): Reading {
        if (group.read === undefined) {
            group.read = this.read(group);
        }
        return group.read;
    }

    private read(group: Group): Reading {
        const base = this.lines.startOf(group.first);
        const body = this.text.slice(base, this.lines.endOf(Math.min(group.end, this.lines.count) - 1));
        const norm = normalize(body);
        const src = norm.src;
        const { units, roles, barriers, spans, codes } = emit(group);
        const { toSource, toUnit, exact } = align(src, units);
        settleRuns(src, units, roles, toSource, toUnit, spans);
        const at = (index: number) => base + norm.toBody[index];

        // Where the spelling of the character at `i` ends: past an entity whose first character it is.
        const spellingEnd = (i: number): number => {
            if (src.charCodeAt(i) === 38) {
                ENTITY.lastIndex = i;
                const m = ENTITY.exec(src);
                if (m !== null) {
                    let tail = true;
                    for (let k = i + 1; tail && k < i + m[0].length; k++) {
                        tail = toUnit[k] < 0;
                    }
                    if (tail) {
                        return i + m[0].length;
                    }
                }
            }
            return i + 1;
        };

        const stretches = new Map<number, TextStretch[]>();
        let run: { first: number; last: number; continues: boolean } | null = null;
        const close = () => {
            if (run === null) {
                return;
            }
            let start = toSource[run.first];
            // An escaped first character starts at its backslash.
            if (start > 0 && src.charCodeAt(start - 1) === 92 && toUnit[start - 1] < 0) {
                start--;
            }
            const stretch = { start: at(start), end: at(spellingEnd(toSource[run.last])), continues: run.continues };
            const line = this.lines.positionAt(stretch.start).line;
            const onLine = stretches.get(line);
            if (onLine === undefined) {
                stretches.set(line, [{ ...stretch, continues: false }]);
            } else {
                onLine.push(stretch);
            }
            run = null;
        };
        let level = 0;
        let seen = false;
        for (let j = 0; j < units.length; j++) {
            level = Math.max(level, barriers[j]);
            if (roles[j] === TEXT && toSource[j] >= 0) {
                if (run !== null && level === 0) {
                    run.last = j;
                } else {
                    const continues = seen && level <= 1;
                    close();
                    run = { first: j, last: j, continues };
                }
                seen = true;
                level = 0;
            } else {
                level = Math.max(level, roles[j] === ENCLOSED ? 1 : 2);
            }
        }
        close();

        // The gap before unit `u`: from past the last matched unit before it to the first matched one from it on.
        const lo = new Int32Array(units.length + 1);
        const hi = new Int32Array(units.length + 1);
        let previous = 0;
        for (let u = 0; u <= units.length; u++) {
            lo[u] = previous;
            if (u < units.length && toSource[u] >= 0) {
                previous = spellingEnd(toSource[u]);
            }
        }
        let next = src.length;
        for (let u = units.length; u >= 0; u--) {
            if (u < units.length && toSource[u] >= 0) {
                next = toSource[u];
            }
            hi[u] = next;
        }
        interface Claim { span: number; markup: string; order: number; found: number }
        const gaps = new Map<number, { lo: number; hi: number; opens: Claim[]; closes: Claim[] }>();
        const gapOf = (u: number) => {
            let gap = gaps.get(lo[u]);
            if (gap === undefined) {
                gap = { lo: lo[u], hi: Math.max(lo[u], hi[u]), opens: [], closes: [] };
                gaps.set(lo[u], gap);
            }
            return gap;
        };
        const opens: Claim[] = [];
        const closes: Claim[] = [];
        spans.forEach((span, index) => {
            const open = { span: index, markup: span.markup, order: span.openOrder, found: -1 };
            const shut = { span: index, markup: span.markup, order: span.closeOrder, found: -1 };
            gapOf(span.open).opens.push(open);
            gapOf(span.close).closes.push(shut);
            opens.push(open);
            closes.push(shut);
        });
        for (const gap of gaps.values()) {
            // Closing markers in the order their tokens came, from the gap's start;
            // opening ones from its end, innermost (last) first.
            let from = gap.lo;
            let to = gap.hi;
            for (const claim of gap.closes.sort((a, b) => a.order - b.order)) {
                const found = src.indexOf(claim.markup, from);
                if (found >= 0 && found + claim.markup.length <= to) {
                    claim.found = found;
                    from = found + claim.markup.length;
                }
            }
            for (const claim of gap.opens.sort((a, b) => b.order - a.order)) {
                const found = src.lastIndexOf(claim.markup, to - claim.markup.length);
                if (found >= from && to - claim.markup.length >= 0) {
                    claim.found = found;
                    to = found;
                }
            }
        }
        const sourceSpans = spans.map((span, index): SourceSpan => {
            const open = opens[index];
            const shut = closes[index];
            const found = open.found >= 0 && shut.found >= 0 && open.found < shut.found;
            const start = open.found >= 0 ? open.found : lo[span.open];
            const end = shut.found >= 0 ? shut.found + span.markup.length : hi[span.close];
            return { start: at(start), end: at(Math.max(start, end)), markup: span.markup, exact: exact && found };
        });
        for (const code of codes) {
            // Exact when each backtick run is matched where it was written, one character after another.
            const length = code.markup.length;
            const runAt = (first: number) => {
                for (let k = 1; k < length; k++) {
                    if (toSource[first + k] !== toSource[first] + k) {
                        return -1;
                    }
                }
                return toSource[first];
            };
            const open = runAt(code.start);
            const close = runAt(code.end - length);
            const found = open >= 0 && close > open;
            const start = open >= 0 ? open : lo[code.start];
            const end = close >= 0 ? close + length : hi[code.end];
            sourceSpans.push({ start: at(start), end: at(Math.max(start, end)), markup: code.markup, exact: exact && found });
        }
        return { stretches, spans: sourceSpans };
    }
}

/**
 * Where text and a marker share a run of one character (`~~~x~~~` read as a
 * `~` and a strikethrough), which characters are the text's is a tie the
 * alignment settles to the earlier ones — right before a marker's gap, wrong
 * after one: `x ~~a~~~` would give the closing `~~` the text's place. Text
 * that a span's marker stands right before is moved to the run's end, so the
 * marker keeps the characters next to the gap it was written in. The same tie
 * between an escaped character and a marker beside it (`\**a*`) goes to the
 * escape.
 */
function settleRuns(src: string, units: readonly Unit[], roles: readonly number[], toSource: Int32Array, toUnit: Int32Array, spans: readonly TokenSpan[]): void {
    const markerAt = new Set<number>();
    for (const span of spans) {
        markerAt.add(span.open);
        markerAt.add(span.close);
    }
    for (const first of markerAt) {
        const at = toSource[first];
        if (at < 0) {
            continue;
        }
        const c = src.charCodeAt(at);
        // The text's characters of the run, from the marker on, one after another.
        let count = 1;
        while (first + count < toSource.length && !markerAt.has(first + count)
            && toSource[first + count] === at + count && src.charCodeAt(at + count) === c) {
            count++;
        }
        let end = at + count;
        while (end < src.length && src.charCodeAt(end) === c && toUnit[end] < 0) {
            end++;
        }
        // Only text inside one run: it moves to the run's end.
        const shift = end - (at + count);
        if (shift <= 0) {
            continue;
        }
        for (let k = count - 1; k >= 0; k--) {
            toUnit[at + k] = -1;
            toSource[first + k] = at + k + shift;
            toUnit[at + k + shift] = first + k;
        }
    }
    // An escaped character is always text, so a `\*` left unmatched near a
    // matched, unescaped `*` — nothing but `*`s and backslashes between them —
    // means the text took a marker's `*`: it gets the escaped one. Backward
    // from left to right, then forward from right to left, so matches stay in order.
    const move = (unit: number, to: number) => {
        toUnit[toSource[unit]] = -1;
        toSource[unit] = to;
        toUnit[to] = unit;
    };
    const escapedAt = (i: number, c: number) => i > 0 && src.charCodeAt(i) === c && src.charCodeAt(i - 1) === 92 && toUnit[i] < 0 && toUnit[i - 1] < 0;
    const between = (from: number, to: number, c: number) => {
        for (let i = from; i < to; i++) {
            if (src.charCodeAt(i) !== c && src.charCodeAt(i) !== 92) {
                return false;
            }
        }
        return true;
    };
    const misplaced = (unit: number) => {
        const at = toSource[unit];
        return at >= 0 && roles[unit] === TEXT && isAsciiPunctuation(units[unit].code) && !(at > 0 && src.charCodeAt(at - 1) === 92);
    };
    let previous = -1;
    for (let u = 0; u < units.length; u++) {
        if (misplaced(u)) {
            const c = units[u].code;
            for (let i = previous + 2; i < toSource[u]; i++) {
                if (escapedAt(i, c) && between(i + 1, toSource[u], c)) {
                    move(u, i);
                    break;
                }
            }
        }
        previous = toSource[u] >= 0 ? toSource[u] : previous;
    }
    let next = src.length;
    for (let u = units.length - 1; u >= 0; u--) {
        if (misplaced(u)) {
            const c = units[u].code;
            for (let i = next - 1; i > toSource[u]; i--) {
                if (escapedAt(i, c) && between(toSource[u] + 1, i - 1, c)) {
                    move(u, i);
                    break;
                }
            }
        }
        next = toSource[u] >= 0 ? toSource[u] : next;
    }
}

/** The characters a backslash escapes. */
function isAsciiPunctuation(code: number): boolean {
    return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

/** A note's anchors by its token types: `sidenote_open`, `sidenote_content_open`, `sidenote_close`. */
function noteAnchor(type: string): string | undefined {
    const m = /^(.*?)(_content)?_(open|close)$/.exec(type);
    const note = m === null ? undefined : NOTE_ANCHORS[m[1]];
    if (note === undefined || m === null) {
        return undefined;
    }
    if (m[2] !== undefined) {
        return m[3] === 'open' ? note.between : undefined;
    }
    return m[3] === 'open' ? note.open : note.close;
}

/** A group's inline children as units, with what each unit is to a stretch and the spans the tokens open and close. */
function emit(group: Group): Emitted {
    const units: Unit[] = [];
    const roles: number[] = [];
    const barriers: number[] = [];
    const spans: TokenSpan[] = [];
    const codes: CodeUnits[] = [];
    let barrier = 0;
    let order = 0;
    const push = (code: number, role: number) => {
        units.push({ pos: units.length, code });
        roles.push(role);
        barriers.push(barrier);
        barrier = 0;
    };
    const chars = (text: string, role: number) => {
        for (let k = 0; k < text.length; k++) {
            push(text.charCodeAt(k), role);
        }
    };
    const stack: { markup: string; at: number; order: number; pair: boolean; autolink: boolean }[] = [];
    let autolinks = 0;
    for (const inline of group.inlines) {
        if (group.row) {
            chars('|', BOUNDARY);
        }
        for (const child of inline.children ?? []) {
            if (child.nesting === 1) {
                const pair = PAIR_MARKERS.has(child.markup);
                // An autolink's text is its URL.
                const autolink = child.type === 'link_open' && (child.markup === 'autolink' || child.markup === 'linkify');
                barrier = Math.max(barrier, pair ? 1 : 2);
                const anchor = noteAnchor(child.type);
                if (anchor !== undefined) {
                    chars(anchor, BOUNDARY);
                }
                stack.push({ markup: child.markup, at: units.length, order: order++, pair, autolink });
                autolinks += autolink ? 1 : 0;
                continue;
            }
            if (child.nesting === -1) {
                const top = stack.pop();
                autolinks -= top?.autolink ? 1 : 0;
                barrier = Math.max(barrier, top?.pair ? 1 : 2);
                if (top?.pair) {
                    spans.push({ markup: top.markup, open: top.at, close: units.length, openOrder: top.order, closeOrder: order++ });
                }
                const anchor = noteAnchor(child.type);
                if (anchor !== undefined) {
                    chars(anchor, BOUNDARY);
                }
                continue;
            }
            switch (child.type) {
                case 'text':
                    chars(child.content, autolinks > 0 ? BOUNDARY : TEXT);
                    break;
                case 'softbreak':
                case 'hardbreak':
                    push(NEWLINE, BOUNDARY);
                    break;
                case 'code_inline': {
                    // The backtick runs are units too: a space the span strips
                    // from its content could otherwise be taken for the text's.
                    const start = units.length;
                    chars(child.markup + child.content + child.markup, ENCLOSED);
                    codes.push({ markup: child.markup, start, end: units.length });
                    break;
                }
                case 'math_inline':
                    chars(child.content, ENCLOSED);
                    break;
                case 'html_inline':
                    chars(child.content, BOUNDARY);
                    break;
                case 'image':
                    chars(`![${child.content}]`, ENCLOSED);
                    break;
                default:
                    // An emoji, a footnote reference, a task's box: written otherwise than shown.
                    push(UNMATCHABLE, ENCLOSED);
            }
        }
    }
    if (group.row) {
        chars('|', BOUNDARY);
    }
    return { units, roles, barriers, spans, codes };
}
