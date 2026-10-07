import { Node } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import { NOTE_SYNTAX, WIKI_EMBED_MARKERS } from '../syntax/markers';
import { Alignment, ENTITY, Lines, NEWLINE, NOTE_ANCHORS, Normalized, UNMATCHABLE, Unit, align, normalize } from './alignment';
import { NotePart, SerializeOptions, SerializedLayout, WikiEmbedPlace, serializeLayout, writtenWikiEmbed } from './serialize';

/**
 * Where a place in the page stands in the document's text, and back.
 *
 * The page holds a ProseMirror document; the host, VS Code and every other
 * extension hold text. Completion, diagnostics, hover and "which requirement is
 * the caret in" all need to cross between the two, and this module is the one
 * answer to it — pure, so the page and the tests ask the same code. The page
 * owns the map, since only it holds the nodes a position is in: it reports its
 * caret with it and answers the host's `map` requests (`webview/main.ts`),
 * which is how the session's `toSource`/`toPage` are answered.
 *
 * **The text is the one the page would write.** `serializeLayout` — the loop
 * `serializeDocument` is — gives the document's text and where each top-level
 * node's body stands in it: an untouched block's `src`, an edited block's fresh
 * serialization (wrapped by `wrap.ts` at its width, in the document's line
 * ending), which is exactly what the host holds once the page's edit has
 * landed. Offsets are read from there, never counted here a second time.
 *
 * **Coordinates** are `vscode.Position`'s: a 0-based line and a 0-based
 * character counted in UTF-16 code units, which is also how ProseMirror counts
 * text. A line ends at `\r\n`, `\n` or a lone `\r`, as VS Code and markdown-it
 * both split them; a character past a line's end is its end. The source may be
 * CRLF: each block's body is aligned with its line breaks read as one `\n`
 * (markdown-it's own normalization), and the offsets found are mapped back to
 * the body as written, so a position never falls between `\r` and `\n`.
 *
 * **Inside a block the page's text is aligned with the source's.** Delimiters
 * (`*`, `**`, `` ` ``, `[…](…)`, `{…}`, `++`, `|`, a heading's `# ` and its
 * `ID: ` prefix, a list's bullets and indentation) are in the source and not in
 * the page; a character written as a reference (`&#124;` in a note's reference)
 * or a soft break (a space in the page, a line break in the source) is in the
 * page and not the source. Rather than count delimiters by hand — a second
 * serializer — the block's page text (one unit per UTF-16 code unit, one per
 * inline leaf) and its source are aligned as two sequences: an affine-gap
 * alignment (Gotoh) that first maximizes the characters matched and then
 * minimizes the number of gap runs, where a gap run that starts a source line
 * (a line's prefix: `- `, `> `, `1. `, `# `, indentation, an admonition's
 * header) is free, and ties go to the earlier match. Four kinds of anchor with
 * no page position of their own help it: a line break before every textblock
 * but the first, a note's markers and separator (`NOTE_SYNTAX`,
 * `NOTE_SEPARATOR` — read from where the syntax is stated), so the text of one
 * part cannot be matched into another, and a table's line breaks and `|`s
 * (`visitTable`: a cell is a textblock that starts after a `|`, not on a line
 * of its own). A wiki embed, an atom, matches its source's `!`, the rest of
 * its plain name anchors it, and its spelling runs to its closing `]]`
 * however the place spelled it; a source position right after that is after
 * the atom.
 * The alignment runs in a band around the
 * diagonal (the source is the page text plus delimiters); a block too large for
 * the band's budget is aligned greedily instead and every answer in it is
 * approximate.
 *
 * **A position between two characters** maps to just after the one before it
 * when that is matched — so the caret after typed text is after that text,
 * before any closing delimiter — else to just before the one after it; one
 * after a matched line break maps before the next character, so a wrapped
 * list item's second line starts after its indentation. "After" a character
 * is after its whole spelling: an escape's (`\*`) ends with the character, an
 * entity whose first character it is (`&amp;` for `&`) at its `;`. Back from
 * the source, the same two rules in the same order. So for every text position
 * the two directions agree, except where the page holds more positions than the
 * source has (two spaces the serializer writes as one). A source position
 * strictly inside a delimiter — inside a line's prefix across a line break
 * (a wrapped item's indentation, a quote's `> `), where a soft break's space
 * may have matched one of the prefix's spaces, or inside an entity's tail — is
 * found by the same rules but answered as approximate.
 *
 * **A known limit: ties.** Where a run of the page's text also occurs inside
 * a delimiter beside it at equal cost — a link's text repeated in its URL, for
 * one — the alignment cannot tell the copies apart and takes the earlier
 * match; a position there can land in the delimiter's copy, answered as
 * exact. The free line prefix settles the common cases (a numbered item whose
 * text starts with its digit, a heading's `ID: ` prefix); the rest is left.
 *
 * **Atoms map to their whole slice** — a source block, an injected block, the
 * front matter, a rule: the position before one is its slice's start, the one
 * after it its end (before the final line break). A source position inside an
 * atom maps to the position before it, approximately.
 *
 * **Never throws.** What cannot be mapped at all — a position outside the
 * document, a non-integer — answers `null`; what can be mapped only to the
 * nearest place answers that place with `approximate: true`: a page position
 * with no matched character near it (an empty paragraph, the end of a heading
 * after a badge, between the items of a list), a source position in a
 * delimiter, a gap between blocks or the tail, past the end of a line or of
 * the text, inside an atom, and anything in a greedily aligned block.
 */

/** A place in the document's text: 0-based line and UTF-16 character, as `vscode.Position`. */
export interface SourcePosition {
    line: number;
    character: number;
}

export interface SourceRange {
    start: SourcePosition;
    end: SourcePosition;
}

/** Whether a value the page sent is a position: two non-negative integers. */
export function validPosition(position: unknown): position is SourcePosition {
    const p = position as Partial<SourcePosition> | null | undefined;
    return typeof p === 'object' && p !== null
        && Number.isInteger(p.line) && Number.isInteger(p.character) && (p.line as number) >= 0 && (p.character as number) >= 0;
}

/** Whether a value the page sent is a range: two positions. */
export function validRange(range: unknown): range is SourceRange {
    const r = range as Partial<SourceRange> | null | undefined;
    return typeof r === 'object' && r !== null && validPosition(r.start) && validPosition(r.end);
}

/** A range as the page and the protocol carry it, from anything shaped like one (a `vscode.Range`). */
export function toSourceRange(range: { start: SourcePosition; end: SourcePosition }): SourceRange {
    return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

/** A source position with whether it is only the nearest one found. */
export interface MappedSourcePosition extends SourcePosition {
    approximate: boolean;
}

/** A ProseMirror position with whether it is only the nearest one found. */
export interface MappedPagePosition {
    pos: number;
    approximate: boolean;
}

export interface MappedPageRange {
    from: number;
    to: number;
    approximate: boolean;
}

/** The mapping for one document and the text it serializes to. */
export interface PositionMap {
    /** The document's text, as the page would write it. */
    readonly text: string;
    /** Where the page position `pos` stands in `text`; `null` for a position outside the document. */
    sourcePositionOf(pos: number): MappedSourcePosition | null;
    /** The page position a source position stands at, or the nearest one; `null` for a position that is not one. */
    pagePositionOf(position: SourcePosition): MappedPagePosition | null;
    /** `pagePositionOf` for both ends, in document order. */
    pageRangeOf(range: SourceRange): MappedPageRange | null;
    /**
     * The 0-based line of `text` top-level node `index`'s body starts on, as
     * the layout placed it — after the separator its seam was written with,
     * however that was widened; past the last node, the line the last body ends on.
     */
    blockLine(index: number): number;
}

/** The mapping for the document `parsed` holds, against the text it serializes to with `options`. */
export function createPositionMap(parsed: { doc: Node; eol: '\n' | '\r\n'; tail: string }, options: SerializeOptions): PositionMap {
    return new DocumentPositions(parsed.doc, serializeLayout(parsed, options));
}

/**
 * The caret the page reports: the selection's head as a source position, for a
 * text selection whose head is in text. `null` for a node selection (an atom,
 * an image, a badge), a gap cursor, Ctrl+A, and whenever the mapping is only
 * approximate — a caret that may be wrong is not reported as right.
 */
export function caretOf(selection: Selection, map: PositionMap): SourcePosition | null {
    if (!(selection instanceof TextSelection) || !holdsText(selection.$head.parent)) {
        return null;
    }
    const mapped = map.sourcePositionOf(selection.head);
    return mapped === null || mapped.approximate ? null : { line: mapped.line, character: mapped.character };
}

/**
 * Whether a position whose parent is `node` is a position in text: a textblock,
 * a note's reference or body, a sidebar. A note itself holds its two parts,
 * not text, although its content is inline — a position between them is none.
 */
export function holdsText(node: Node): boolean {
    return node.inlineContent && node.type.contentMatch.matchType(node.type.schema.nodes.text) !== null;
}

// ---------------------------------------------------------------------------
// Units: a block's page text as a sequence
// ---------------------------------------------------------------------------

const AMPERSAND = 38;
/** What a line's prefix is made of, besides the line break: indentation and a quote's `>`. */
const PREFIX_CHARS: ReadonlySet<number> = new Set([NEWLINE, 32, 9, 62]);

/** The note part each child of a note node is, by index, and the marker the note is written with. */
const NOTE_PARTS: Readonly<Record<string, { parts: readonly NotePart[]; marker?: string }>> = {
    sidenote: { parts: ['ref', 'body'], marker: NOTE_SYNTAX.sidenote.marker.charAt(0) },
    marginal_note: { parts: ['ref', 'body'], marker: NOTE_SYNTAX.marginalNote.marker.charAt(0) },
    left_sidebar: { parts: ['left'] },
    right_sidebar: { parts: ['right'] },
};

function collectUnits(block: Node): Unit[] {
    const units: Unit[] = [];
    // An untouched block is its source, an embed in it spelled as read; a changed one is written by rule.
    const written = (block.attrs.src ?? null) === null;
    const anchor = (text: string) => {
        for (let k = 0; k < text.length; k++) {
            units.push({ pos: -1, code: text.charCodeAt(k) });
        }
    };
    const visit = (node: Node, pos: number, place: WikiEmbedPlace): void => {
        if (node.isText) {
            const text = node.text ?? '';
            for (let k = 0; k < text.length; k++) {
                units.push({ pos: pos + k, code: text.charCodeAt(k) });
            }
            return;
        }
        if (node.type.name === 'wiki_embed') {
            // The atom matches its source's `!`, and its spelling runs to the
            // `]]` that closes it (`spellingEnd`), as an entity's runs to its
            // `;`: the position before it is the source's start, the one after
            // it its end. The spelling it has in this place anchors it: as read
            // in an untouched block, as `writtenWikiEmbed` writes it in a changed
            // one (`\|` in a cell, `&#124;` in a note's reference).
            const read = node.attrs.source as string;
            const source = written ? writtenWikiEmbed(read, place) : read;
            units.push({ pos, code: source.charCodeAt(0), spelledTo: WIKI_EMBED_MARKERS.close });
            anchor(source.slice(1));
            return;
        }
        if (node.isLeaf) {
            // A hard break is a line break in the source (`\` or two spaces before it).
            units.push({ pos, code: node.type.name === 'hard_break' ? NEWLINE : UNMATCHABLE });
            return;
        }
        if (node.type.name === 'table') {
            visitTable(node, pos);
            return;
        }
        if (node.isTextblock && units.length > 0) {
            anchor('\n');
        }
        const note = NOTE_ANCHORS[node.type.name];
        if (note) {
            anchor(note.open);
        }
        const parts = NOTE_PARTS[node.type.name];
        node.forEach((child, offset, index) => {
            if (note?.between !== undefined && index === 1) {
                anchor(note.between);
            }
            const part = parts === undefined ? place : { ...place, notePart: parts.parts[Math.min(index, parts.parts.length - 1)], noteMarker: parts.marker ?? place.noteMarker };
            visit(child, pos + 1 + offset, part);
        });
        if (note) {
            anchor(note.close);
        }
    };
    /**
     * A table's rows are its lines and its cells the text between `|`s, so
     * the anchors are those: a line break before every row but the first, a
     * `|` before every cell and after the last, and the delimiter row — as
     * many `|`s as it has, between two line breaks — after the header. The
     * padding and the delimiter row's dashes are delimiter runs. A cell is a
     * textblock, but its text starts after a `|`, not on a line of its own.
     */
    const visitTable = (table: Node, pos: number): void => {
        table.forEach((row, rowOffset, r) => {
            const rowPos = pos + 1 + rowOffset;
            if (r > 0) {
                anchor('\n');
            }
            row.forEach((cell, cellOffset) => {
                anchor('|');
                const cellPos = rowPos + 1 + cellOffset;
                cell.forEach((child, childOffset) => visit(child, cellPos + 1 + childOffset, { inTableCell: true }));
            });
            anchor('|');
            if (r === 0) {
                // The delimiter row follows the header whether or not a body does, one `|` per boundary of the header's cells.
                anchor('\n' + '|'.repeat(row.childCount + 1));
            }
        });
    };
    visit(block, 0, {});
    return units;
}

// ---------------------------------------------------------------------------
// One block
// ---------------------------------------------------------------------------

/** A block's units aligned with its body, positions relative to the block's start. */
class BlockMap {
    private readonly units: Unit[];
    /** Unit indices with a page position, in position order. */
    private readonly positioned: number[] = [];
    private readonly unitAt = new Map<number, number>();
    private readonly norm: Normalized;
    private readonly alignment: Alignment;
    /** For each matched source index, where the spelling of its character ends: one past it, or past a whole `&amp;`. */
    private readonly spellingEnd: Int32Array;
    /** For each normalized position, whether it stands inside a delimiter: a line's prefix, an entity's tail. */
    private readonly inside: Uint8Array;
    /** The unit of the atom whose spelling ends at a normalized position (a wiki embed's `]]`). */
    private readonly atomEndingAt = new Map<number, number>();

    constructor(block: Node, readonly body: string) {
        this.units = collectUnits(block);
        this.units.forEach((unit, index) => {
            if (unit.pos >= 0) {
                this.positioned.push(index);
                this.unitAt.set(unit.pos, index);
            }
        });
        this.norm = normalize(body);
        this.alignment = align(this.norm.src, this.units);
        const src = this.norm.src;
        const { toUnit } = this.alignment;
        this.spellingEnd = new Int32Array(src.length);
        this.inside = new Uint8Array(src.length + 1);
        for (let i = 0; i < src.length; i++) {
            this.spellingEnd[i] = i + 1;
        }
        // A run of line-prefix characters across a line break that holds a
        // character nothing matched is one delimiter — a wrapped line's break
        // and indentation, a quote's `\n> ` — even where the soft break's
        // space matched one of its spaces: no place strictly inside it is text.
        for (let a = 0; a < src.length;) {
            if (!PREFIX_CHARS.has(src.charCodeAt(a))) {
                a++;
                continue;
            }
            let b = a;
            let lineBreak = false;
            let gap = false;
            while (b < src.length && PREFIX_CHARS.has(src.charCodeAt(b))) {
                lineBreak = lineBreak || src.charCodeAt(b) === NEWLINE;
                gap = gap || toUnit[b] < 0;
                b++;
            }
            if (lineBreak && gap) {
                this.inside.fill(1, a + 1, b);
            }
            a = b;
        }
        // A character spelled as an entity whose first character it is
        // (`&amp;` for `&`) matches that first character: its spelling runs to
        // the `;`, as an escape's (`\*`) runs to the character.
        // An atom spelled by a run of source (a wiki embed) runs to its closing marker.
        this.units.forEach((unit, j) => {
            const i = this.alignment.toSource[j];
            const close = unit.spelledTo === undefined || i < 0 ? -1 : src.indexOf(unit.spelledTo, i + 1);
            if (close >= 0) {
                const end = close + (unit.spelledTo as string).length;
                this.spellingEnd[i] = end;
                this.inside.fill(1, i + 1, end);
                this.atomEndingAt.set(end, j);
            }
        });
        for (let i = 0; i < src.length; i++) {
            if (src.charCodeAt(i) !== AMPERSAND || toUnit[i] < 0) {
                continue;
            }
            ENTITY.lastIndex = i;
            const m = ENTITY.exec(src);
            const end = m === null ? -1 : i + m[0].length;
            let tail = end > 0;
            for (let k = i + 1; tail && k < end; k++) {
                tail = toUnit[k] < 0;
            }
            if (tail) {
                this.spellingEnd[i] = end;
                this.inside.fill(1, i + 1, end);
            }
        }
    }

    /** The body offset a position `rel` inside the block stands at. */
    toBody(rel: number): { offset: number; exact: boolean } | null {
        const { toSource, exact } = this.alignment;
        const src = this.norm.src;
        const prev = this.unitAt.get(rel - 1);
        const next = this.unitAt.get(rel);
        const ps = prev === undefined ? -1 : toSource[prev];
        const ns = next === undefined ? -1 : toSource[next];
        let local = -1;
        if (ps >= 0 && src.charCodeAt(ps) !== NEWLINE) {
            local = this.spellingEnd[ps];
        } else if (ns >= 0) {
            local = ns;
        } else if (ps >= 0) {
            local = this.spellingEnd[ps];
        }
        if (local >= 0) {
            return { offset: this.norm.toBody[local], exact: exact && this.inside[local] === 0 };
        }
        const near = this.nearestSource(rel);
        return near === null ? null : { offset: this.norm.toBody[near], exact: false };
    }

    /** The position relative to the block's start a body offset stands at. */
    toPage(offset: number): { rel: number; exact: boolean } | null {
        const { toUnit, exact } = this.alignment;
        const src = this.norm.src;
        const l = this.norm.fromBody[Math.max(0, Math.min(offset, this.body.length))];
        const before = l > 0 ? toUnit[l - 1] : -1;
        const after = l < src.length ? toUnit[l] : -1;
        const beforePos = before >= 0 ? this.units[before].pos : -1;
        const afterPos = after >= 0 ? this.units[after].pos : -1;
        // Inside a delimiter the place is only near one: the rules below still find it.
        const within = exact && this.inside[l] === 0;
        // Right after an atom's spelling: after the atom, wherever it stands in its block.
        const atom = this.atomEndingAt.get(l);
        if (atom !== undefined) {
            return { rel: this.units[atom].pos + 1, exact: within };
        }
        if (beforePos >= 0 && src.charCodeAt(l - 1) !== NEWLINE) {
            return { rel: beforePos + 1, exact: within };
        }
        if (afterPos >= 0) {
            return { rel: afterPos, exact: within };
        }
        if (beforePos >= 0) {
            return { rel: beforePos + 1, exact: within };
        }
        const near = this.nearestPage(l);
        return near === null ? null : { rel: near, exact: false };
    }

    /** The normalized source index nearest the page position `rel` that a matched unit gives. */
    private nearestSource(rel: number): number | null {
        const { toSource } = this.alignment;
        let low = 0;
        let high = this.positioned.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (this.units[this.positioned[mid]].pos < rel) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        let left: { at: number; distance: number } | null = null;
        for (let k = low - 1; k >= 0; k--) {
            const unit = this.positioned[k];
            if (toSource[unit] >= 0) {
                left = { at: toSource[unit] + 1, distance: rel - (this.units[unit].pos + 1) };
                break;
            }
        }
        let right: { at: number; distance: number } | null = null;
        for (let k = low; k < this.positioned.length; k++) {
            const unit = this.positioned[k];
            if (toSource[unit] >= 0) {
                right = { at: toSource[unit], distance: this.units[unit].pos - rel };
                break;
            }
        }
        const pick = left === null ? right : right === null || left.distance <= right.distance ? left : right;
        return pick === null ? null : pick.at;
    }

    /** The page position nearest the normalized source index `l` that a matched character gives. */
    private nearestPage(l: number): number | null {
        const { toUnit } = this.alignment;
        const posOf = (i: number) => (toUnit[i] >= 0 ? this.units[toUnit[i]].pos : -1);
        let left: { rel: number; distance: number } | null = null;
        for (let i = l - 1; i >= 0; i--) {
            if (posOf(i) >= 0) {
                left = { rel: posOf(i) + 1, distance: l - (i + 1) };
                break;
            }
        }
        let right: { rel: number; distance: number } | null = null;
        for (let i = l; i < this.norm.src.length; i++) {
            if (posOf(i) >= 0) {
                right = { rel: posOf(i), distance: i - l };
                break;
            }
        }
        const pick = left === null ? right : right === null || left.distance <= right.distance ? left : right;
        return pick === null ? null : pick.rel;
    }
}

/**
 * The alignment of each block node with the body it was last aligned against.
 * A node is immutable and its positions are relative to its own start, so an
 * alignment outlives every edit elsewhere, the block moving included; the
 * page's caret reports re-align only the block that was typed in.
 */
const blockMaps = new WeakMap<Node, BlockMap>();

function blockMapOf(node: Node, body: string): BlockMap {
    const known = blockMaps.get(node);
    if (known && known.body === body) {
        return known;
    }
    const made = new BlockMap(node, body);
    blockMaps.set(node, made);
    return made;
}

/**
 * The text the textblock at `pos` in `doc` was read from: its slice of its
 * top-level block's `src`, found by the same alignment as every other
 * position, or `null` when the block holds no `src` (an edit has cleared it,
 * and the text it was read from is no longer known). A top-level textblock's
 * is its whole `src`. For a refusal that names the file's spelling of a
 * paragraph as its cause (`EditOrigin.sourceOf` in `serialize.ts`).
 */
export function textblockSource(doc: Node, pos: number): string | null {
    try {
        const $pos = doc.resolve(pos);
        const textblock = doc.nodeAt(pos);
        const index = $pos.index(0);
        const block = doc.child(index);
        const src = block.attrs.src as string | null | undefined;
        if (textblock === null || !textblock.isTextblock || typeof src !== 'string') {
            return null;
        }
        if ($pos.depth === 0) {
            return src;
        }
        const offset = $pos.posAtIndex(index, 0);
        const map = blockMapOf(block, src);
        const from = map.toBody(pos + 1 - offset);
        const to = map.toBody(pos + textblock.nodeSize - 1 - offset);
        return from === null || to === null ? null : src.slice(from.offset, Math.max(from.offset, to.offset));
    } catch {
        return null;
    }
}

/** The length of the line terminator a body ends with. */
function terminatorLength(body: string): number {
    return body.endsWith('\r\n') ? 2 : body.endsWith('\n') || body.endsWith('\r') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

class DocumentPositions implements PositionMap {
    readonly text: string;
    private readonly lines: Lines;
    /** The ProseMirror position each top-level node starts at. */
    private readonly starts: number[] = [];

    constructor(private readonly doc: Node, private readonly layout: SerializedLayout) {
        this.text = layout.text;
        this.lines = new Lines(layout.text);
        doc.forEach((_child, offset) => {
            this.starts.push(offset);
        });
    }

    sourcePositionOf(pos: number): MappedSourcePosition | null {
        try {
            return this.source(pos);
        } catch {
            return null;
        }
    }

    pagePositionOf(position: SourcePosition): MappedPagePosition | null {
        try {
            return this.page(position);
        } catch {
            return null;
        }
    }

    pageRangeOf(range: SourceRange): MappedPageRange | null {
        const start = range ? this.pagePositionOf(range.start) : null;
        const end = range ? this.pagePositionOf(range.end) : null;
        if (start === null || end === null) {
            return null;
        }
        return { from: Math.min(start.pos, end.pos), to: Math.max(start.pos, end.pos), approximate: start.approximate || end.approximate };
    }

    blockLine(index: number): number {
        const blocks = this.layout.blocks;
        if (index < blocks.length) {
            return this.lines.positionAt(blocks[Math.max(0, index)].start).line;
        }
        const last = blocks[blocks.length - 1];
        return this.lines.positionAt(last === undefined ? 0 : last.start + last.body.length).line;
    }

    private at(offset: number, approximate: boolean): MappedSourcePosition {
        return { ...this.lines.positionAt(offset), approximate };
    }

    /** Whether top-level node `index` writes anything. */
    private written(index: number): boolean {
        return index >= 0 && index < this.layout.blocks.length && this.layout.blocks[index].body !== '';
    }

    private bodyStart(index: number): number {
        return this.layout.blocks[index].start;
    }

    /** Where a node's body ends: before its last line's terminator. */
    private bodyEnd(index: number): number {
        const { start, body } = this.layout.blocks[index];
        return start + body.length - terminatorLength(body);
    }

    private source(pos: number): MappedSourcePosition | null {
        const doc = this.doc;
        if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) {
            return null;
        }
        const $pos = doc.resolve(pos);
        if ($pos.depth === 0) {
            return this.atBoundary($pos.index(0));
        }
        const index = $pos.index(0);
        if (!this.written(index)) {
            return this.nearestWritten(index);
        }
        const node = doc.child(index);
        const found = blockMapOf(node, this.layout.blocks[index].body).toBody(pos - this.starts[index]);
        if (found === null) {
            return this.at(this.bodyStart(index), true);
        }
        return this.at(this.bodyStart(index) + found.offset, !found.exact || !holdsText($pos.parent));
    }

    /** A position between top-level nodes: an atom's end after it, else the next node's start. */
    private atBoundary(index: number): MappedSourcePosition {
        const before = index - 1;
        if (before >= 0 && this.doc.child(before).isLeaf && this.written(before)) {
            return this.at(this.bodyEnd(before), false);
        }
        if (this.written(index)) {
            return this.at(this.bodyStart(index), false);
        }
        return this.nearestWritten(index);
    }

    /** The start of the next node that writes something, else the end of the previous one. */
    private nearestWritten(index: number): MappedSourcePosition {
        for (let k = index; k < this.layout.blocks.length; k++) {
            if (this.written(k)) {
                return this.at(this.bodyStart(k), true);
            }
        }
        for (let k = index - 1; k >= 0; k--) {
            if (this.written(k)) {
                return this.at(this.bodyEnd(k), true);
            }
        }
        return this.at(0, true);
    }

    private page(position: SourcePosition): MappedPagePosition | null {
        const at = this.lines.offsetAt(position);
        if (at === null) {
            return null;
        }
        const o = at.offset;
        let previous = -1;
        for (let k = 0; k < this.layout.blocks.length; k++) {
            if (!this.written(k)) {
                continue;
            }
            if (o < this.bodyStart(k)) {
                // In the gap before node `k`: the nearer of its start and the previous node's end.
                const toNext = this.bodyStart(k) - o;
                const toPrevious = previous < 0 ? Infinity : o - this.bodyEnd(previous);
                const mapped = toPrevious <= toNext ? this.pageAt(previous, this.bodyEnd(previous)) : this.pageAt(k, this.bodyStart(k));
                return { pos: mapped.pos, approximate: true };
            }
            if (o <= this.bodyEnd(k)) {
                const mapped = this.pageAt(k, o);
                return { pos: mapped.pos, approximate: mapped.approximate || at.approximate };
            }
            previous = k;
        }
        if (previous >= 0) {
            // The last node's line break, or the tail.
            return { pos: this.pageAt(previous, this.bodyEnd(previous)).pos, approximate: true };
        }
        return { pos: 0, approximate: true };
    }

    /** The page position of offset `o` in the body of node `index`. */
    private pageAt(index: number, o: number): MappedPagePosition {
        const node = this.doc.child(index);
        const start = this.starts[index];
        if (node.isLeaf) {
            if (o === this.bodyStart(index)) {
                return { pos: start, approximate: false };
            }
            if (o === this.bodyEnd(index)) {
                return { pos: start + node.nodeSize, approximate: false };
            }
            return { pos: start, approximate: true };
        }
        const found = blockMapOf(node, this.layout.blocks[index].body).toPage(o - this.bodyStart(index));
        return found === null ? { pos: start, approximate: true } : { pos: start + found.rel, approximate: !found.exact };
    }
}
