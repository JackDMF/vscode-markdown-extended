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
    /** Its opening token's attributes (markdown-it-attrs' `{…}`), as `attrsOf` gives them. */
    attrs: string;
}

/** A mapped block token of a part read with `readPart`: its type, nesting, lines `[first, end)` and attributes (`attrsOf`). */
export interface BlockToken {
    type: string;
    nesting: number;
    first: number;
    end: number;
    attrs: string;
}

export interface InlineSource {
    kindOf(line: number): LineKind;
    /** The line's text stretches, in order; none unless the line is `text`. */
    textOn(line: number): TextStretch[];
    /** The spans of `marker` that touch the line; for `` ` ``, every code span. */
    spansOn(line: number, marker?: string): SourceSpan[];
    /**
     * The lines `[start, end)` of the top-level block that holds the line;
     * the line alone for a blank line outside every block, and the whole
     * document (`whole`) for a line no top-level block holds — a footnote's
     * definition, whose body the tokens place after every block.
     */
    blockOf(line: number): { start: number; end: number; whole?: boolean };
    /**
     * Some lines of this document — a block, written over — read as they read
     * in it: with its engine, its environment and its definitions. The part's
     * `structure` lists its mapped block tokens.
     */
    readPart(text: string): InlineSource;
    /** Each mapped block token, of a part read with `readPart`; empty for a document. */
    readonly structure: readonly BlockToken[];
    /**
     * Each inline token of a part read with `readPart`, with what it holds
     * besides text and the markers of the spans a toggle writes (`InlineContent`);
     * empty for a document.
     */
    readonly inlines: readonly InlineContent[];
    /**
     * What the text itself defines, as one comparable string: each reference's
     * label with its destination and title, each footnote's label, each
     * abbreviation with its expansion. Empty where it defines nothing.
     */
    readonly defines: string;
    /** How many lines the text has. */
    readonly lineCount: number;
    /** The line an offset of the text stands on. */
    lineOf(offset: number): number;
    /** The same document, a later version of its text, read again where it changed (`update`). */
    update(text: string): InlineSource;
}

/**
 * An inline token (a paragraph's, a heading's, a cell's), lines `[first, end)`,
 * and each child that is neither text nor a span's marker a toggle writes —
 * a link's or an image's destination, inline HTML, math, a code span, an
 * emoji, a footnote reference with its note, an abbreviation, a line break —
 * as its type, markup, info, content and attributes (`attrsOf`).
 */
export interface InlineContent {
    first: number;
    end: number;
    tokens: readonly string[];
    /**
     * Each element's (a link's, a task's label, in the order they open) text
     * it holds itself, code spans' included and whitespace left out, so no
     * text goes from one element to another unseen.
     */
    texts: readonly string[];
}

/** The document `text` read with `md`, the engine the Visual Editor parses with, in `env` (`engineEnvironment`). */
export function readInlineSource(md: MarkdownIt, text: string, env: Environment = {}): InlineSource {
    return DocumentIndex.read(md, text, env, false);
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

/** A top-level block: the lines `[start, end)` its first token maps. Shifted in place when an edit above it moves it. */
interface Block {
    start: number;
    end: number;
    type: string;
}

/**
 * One inline block: the inline tokens of a paragraph, a heading, a table
 * row's cells, and the lines `[first, end)` they map. `block` is the top-level
 * block it stands in, `null` for one the tokens place after the document's
 * blocks (a footnote's body). Its tokens are kept only while it is read; a
 * group read again parses its block again.
 */
interface Group {
    first: number;
    end: number;
    row: boolean;
    block: Block | null;
    inlines?: Token[];
    read?: Reading;
}

/** A group's stretches and spans, as offsets from the start of its first line, so a group moved by an edit above it keeps them. */
interface Reading {
    /** By line, counted from the group's first. */
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
    attrs: string;
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
    attrs: string;
}

/** What one parse of some lines gives: each line's rank, its groups and its top-level blocks, lines counted from `offset`. */
interface Scan {
    rank: Uint8Array;
    groups: Group[];
    groupOf: (Group | undefined)[];
    blocks: Block[];
    /** Whether a token maps lines outside every top-level block: a footnote's body, which the tokens place last. */
    orphans: boolean;
}

/** Lines `update` read again: old lines `[startLine, endOld)`, now `[startLine, endNew)`, read as `scan`, in place of the old blocks `[first, after)`. */
interface Region {
    startLine: number;
    endOld: number;
    endNew: number;
    scan: Scan;
    first: number;
    after: number;
}

function scan(tokens: Token[], count: number, offset: number, keepTokens: boolean): Scan {
    const rank = new Uint8Array(count);
    const groupOf: (Group | undefined)[] = new Array(count);
    const groups: Group[] = [];
    const blocks: Block[] = [];
    let orphans = false;
    const claim = (from: number, to: number, kind: LineKind) => {
        for (let line = Math.max(offset, from); line < Math.min(to, offset + count); line++) {
            rank[line - offset] = Math.max(rank[line - offset], RANK[kind]);
        }
    };
    let current: Block | null = null;
    // markdown-it-footnote moves every footnote's body after the document's blocks.
    let tail = false;
    tokens.forEach((token, index) => {
        tail = tail || token.type === 'footnote_block_open';
        if (!token.map) {
            return;
        }
        const from = token.map[0] + offset;
        const to = token.map[1] + offset;
        // A token opening at level 0 starts a top-level block; every token up
        // to its close is in it and widens it (an admonition's opening token
        // maps its title line alone).
        let block: Block | null = current;
        if (tail) {
            orphans = true;
            block = null;
        } else if (current === null || (token.level === 0 && token.nesting >= 0)) {
            current = { start: from, end: Math.max(to, from + 1), type: token.type };
            blocks.push(current);
            block = current;
        } else {
            current.end = Math.max(current.end, to);
        }
        if (isLiteral(token)) {
            claim(from, to, 'literal');
        } else if (token.type === 'inline') {
            // A definition's term maps no line of its own ([n, n]): it is its line.
            const end = Math.max(to, from + 1);
            claim(from, end, 'text');
            const before = tokens[index - 1];
            const cell = before !== undefined && (before.type === 'th_open' || before.type === 'td_open');
            const last = groups[groups.length - 1];
            if (cell && last?.row && last.first === from && last.end === end) {
                last.inlines?.push(token);
                return;
            }
            const group: Group = { first: from, end, row: cell, block, inlines: keepTokens || block === null ? [token] : undefined };
            groups.push(group);
            for (let line = Math.max(offset, from); line < Math.min(end, offset + count); line++) {
                groupOf[line - offset] ??= group;
            }
        } else {
            claim(from, to, 'structure');
        }
    });
    return { rank, groups, groupOf, blocks, orphans };
}

/** The definitions a parse leaves in its environment, which the inline rules of every later block read. */
interface Definitions {
    references: Record<string, unknown>;
    footnotes: string[];
    abbreviations: Record<string, unknown>;
}

function definitionsOf(env: Environment): Definitions {
    const e = env as { references?: Record<string, unknown>; footnotes?: { refs?: Record<string, unknown> }; abbreviations?: Record<string, unknown> };
    return {
        references: { ...(e.references ?? {}) },
        footnotes: Object.keys(e.footnotes?.refs ?? {}),
        abbreviations: { ...(e.abbreviations ?? {}) },
    };
}

/**
 * An environment for parsing part of a document: `base` (`engineEnvironment`)
 * with the document's definitions, so a reference, a footnote reference and an
 * abbreviation read in the part as they read in the whole.
 */
function seeded(base: Environment, definitions: Definitions): Environment {
    const refs: Record<string, number> = {};
    for (const label of definitions.footnotes) {
        refs[label] = -1;
    }
    return {
        ...base,
        references: { ...definitions.references },
        ...(definitions.footnotes.length ? { footnotes: { refs } } : {}),
        ...(Object.keys(definitions.abbreviations).length ? { abbreviations: { ...definitions.abbreviations } } : {}),
    };
}

/**
 * Some lines of a document parsed as the lines they are there, not as a
 * document of their own: after a blank line, so a part starting with `---` is
 * no front matter, which only a document's first line opens. The maps count
 * from the part's first line again.
 */
function parsePart(md: MarkdownIt, text: string, env: Environment): Token[] {
    const tokens = md.parse('\n' + text, env);
    for (const token of tokens) {
        if (token.map) {
            token.map = [token.map[0] - 1, token.map[1] - 1];
        }
    }
    return tokens;
}

/** A part's inline tokens and what each holds besides text and spans' markers (`InlineContent`). */
function contentsOf(tokens: Token[], env: Environment): InlineContent[] {
    const notes = (env as { footnotes?: { list?: { content?: string }[] } }).footnotes?.list ?? [];
    const contents: InlineContent[] = [];
    for (const token of tokens) {
        if (token.type !== 'inline' || !token.map) {
            continue;
        }
        const held: string[] = [];
        const texts: string[] = [];
        // The elements open around a child, by their place in `texts`.
        const open: number[] = [];
        for (const child of token.children ?? []) {
            if (open.length > 0 && (child.type === 'text' || child.type === 'code_inline')) {
                // A code span's text counts with the text: a code span written or taken out keeps it in its element.
                texts[open[open.length - 1]] += child.content.replace(/\s+/g, '');
            }
            if (child.type === 'text' || (child.nesting !== 0 && PAIR_MARKERS.has(child.markup))) {
                continue;
            }
            if (child.nesting > 0) {
                open.push(texts.push('') - 1);
            } else if (child.nesting < 0) {
                open.pop();
            }
            // An inline note's text is not among the children: it is the footnote's.
            const id = (child.meta as { id?: number } | null)?.id;
            const note = child.type.startsWith('footnote_ref') && id !== undefined ? notes[id]?.content ?? '' : '';
            held.push(JSON.stringify([child.type, child.markup, child.info, child.content, attrsOf(child), note]));
        }
        contents.push({ first: token.map[0], end: Math.max(token.map[1], token.map[0] + 1), tokens: held, texts });
    }
    return contents;
}

/** The attribute a plugin numbers anew on every parse, by the type of the token it gives it to: a task's box's `id` and its label's `for`. */
const NUMBERED: Readonly<Record<string, string>> = { checkbox_input: 'id', label_open: 'for' };

/**
 * A token's attributes — what markdown-it-attrs' `{…}` gives the element it
 * stands after, a block's or a span's — as one comparable string, `''` for
 * none. An attribute numbered on every parse (`NUMBERED`) is left out, by its
 * token's type, so no other token's `id` is.
 */
function attrsOf(token: Token): string {
    const numbered = NUMBERED[token.type];
    const attrs = (token.attrs ?? []).filter(([name]) => name !== numbered);
    return attrs.length ? JSON.stringify(attrs) : '';
}

/**
 * What `text` itself defines (`InlineSource.defines`). Read by the block rules
 * alone, which define, in an environment of `base` with no definitions, so a
 * definition the document makes elsewhere does not hide one the text loses.
 */
function definedBy(md: MarkdownIt, text: string, base: Environment): string {
    const env = { ...base } as Record<string, unknown>;
    delete env.references;
    delete env.footnotes;
    delete env.abbreviations;
    try {
        md.block.parse(('\n' + text).replace(/\r\n?/g, '\n').replace(/\0/g, '�'), md, env, []);
    } catch {
        md.parse('\n' + text, env);
    }
    const e = env as { references?: Record<string, unknown>; footnotes?: { refs?: Record<string, unknown> }; abbreviations?: Record<string, unknown> };
    const sorted = (o: Record<string, unknown> | undefined) => Object.keys(o ?? {}).sort().map(k => [k, o?.[k]]);
    const defined = [sorted(e.references), Object.keys(e.footnotes?.refs ?? {}).sort(), sorted(e.abbreviations)];
    return defined.some(d => d.length > 0) ? JSON.stringify(defined) : '';
}

/** A document read below this size keeps its tokens; a larger one parses a block again to read it. */
const KEEP_TOKENS = 200_000;
/** How many top-level blocks' tokens a large document keeps for reading their groups. */
const BLOCK_CACHE = 4;
/** A line that may define a reference, a footnote or an abbreviation: `[label]:`, `[^label]:`, `*[label]:`, after a prefix; a label may hold an escaped bracket (`[p\]q]:`). */
const DEFINITION = /\[(?:[^\]\\]|\\[\s\S])*\]\s*:/;
/** How many more top-level blocks an incremental read takes in before it reads the whole document instead. */
const MAX_EXTENSIONS = 8;

class DocumentIndex implements InlineSource {
    readonly lines: Lines;
    private kinds: Uint8Array;
    private groupOf: (Group | undefined)[];
    private blocks: Block[];
    private blockAt: (Block | undefined)[];
    private readonly blockTokens = new Map<Block, Token[]>();
    readonly structure: readonly BlockToken[];
    readonly inlines: readonly InlineContent[];
    private defined: string | undefined;

    private constructor(
        readonly text: string,
        private readonly md: MarkdownIt,
        private readonly base: Environment,
        readonly definitions: Definitions,
        parts: { scan: Scan; structure?: BlockToken[]; inlines?: InlineContent[] },
    ) {
        this.lines = new Lines(text);
        this.structure = parts.structure ?? [];
        this.inlines = parts.inlines ?? [];
        this.kinds = new Uint8Array(0);
        this.groupOf = [];
        this.blocks = [];
        this.blockAt = [];
        this.install(parts.scan);
    }

    /**
     * The whole of `text`, read with one parse. A `part` of a document is
     * parsed as one (`parsePart`) and keeps each mapped block token's type
     * and lines and what each inline token holds, for comparing two readings
     * of it.
     */
    static read(md: MarkdownIt, text: string, base: Environment, part: boolean): DocumentIndex {
        const env: Environment = { ...base };
        const tokens = part ? parsePart(md, text, env) : md.parse(text, env);
        const count = new Lines(text).count;
        const parts = {
            scan: scan(tokens, count, 0, text.length < KEEP_TOKENS),
            structure: part
                ? tokens.filter(t => t.map && t.type !== 'inline').map(t => ({ type: t.type, nesting: t.nesting, first: t.map[0], end: t.map[1], attrs: attrsOf(t) }))
                : undefined,
            inlines: part ? contentsOf(tokens, env) : undefined,
        };
        return new DocumentIndex(text, md, base, definitionsOf(env), parts);
    }

    get defines(): string {
        this.defined ??= DEFINITION.test(this.text) ? definedBy(this.md, this.text, this.base) : '';
        return this.defined;
    }

    lineOf(offset: number): number {
        return this.lines.positionAt(offset).line;
    }

    private install(s: Scan): void {
        const count = this.lines.count;
        this.kinds = new Uint8Array(count);
        for (let line = 0; line < count; line++) {
            const blank = s.rank[line] < RANK.text && /^\s*$/.test(this.text.slice(this.lines.startOf(line), this.lines.endOf(line)));
            this.kinds[line] = blank ? RANK.blank : Math.max(s.rank[line], RANK.structure);
        }
        this.groupOf = s.groupOf;
        this.blocks = s.blocks;
        this.blockAt = new Array(count);
        for (const block of this.blocks) {
            for (let line = block.start; line < Math.min(block.end, count); line++) {
                this.blockAt[line] = block;
            }
        }
    }

    get lineCount(): number {
        return this.lines.count;
    }

    readPart(text: string): InlineSource {
        return DocumentIndex.read(this.md, text, seeded(this.base, this.definitions), true);
    }

    kindOf(line: number): LineKind {
        return line >= 0 && line < this.kinds.length ? KINDS[this.kinds[line]] : 'blank';
    }

    textOn(line: number): TextStretch[] {
        const group = this.kindOf(line) === 'text' ? this.groupOf[line] : undefined;
        if (group === undefined) {
            return [];
        }
        const base = this.lines.startOf(group.first);
        return (this.reading(group).stretches.get(line - group.first) ?? [])
            .map(s => ({ start: s.start + base, end: s.end + base, continues: s.continues }));
    }

    spansOn(line: number, marker?: string): SourceSpan[] {
        const group = this.kindOf(line) === 'text' ? this.groupOf[line] : undefined;
        if (group === undefined) {
            return [];
        }
        const base = this.lines.startOf(group.first);
        const from = this.lines.startOf(line) - base;
        const to = this.lines.endOf(line) - base;
        const code = marker === INLINE_MARKERS.codeInline;
        return this.reading(group).spans
            .filter(s => (marker === undefined || (code ? s.markup.startsWith(marker) : s.markup === marker)) && s.start <= to && s.end >= from)
            .map(s => ({ ...s, start: s.start + base, end: s.end + base }));
    }

    blockOf(line: number): { start: number; end: number; whole?: boolean } {
        const block = this.blockAt[line];
        if (block !== undefined) {
            return { start: block.start, end: block.end };
        }
        // A line no top-level block holds — a footnote's definition — is read only with the whole document.
        const loose = this.kindOf(line) !== 'blank';
        return loose ? { start: 0, end: this.lines.count, whole: true } : { start: line, end: line + 1 };
    }

    /**
     * `text`, a later version of this document, read again where it changed:
     * each stretch of changed lines from one top-level block before it,
     * through the block after it, further while the parse's last block is not
     * the old one there, and the rest kept, moved by the lines the edit added.
     * Stretches whose readings meet are read as one; with as many lines as
     * before, every changed line is a stretch of its own, so a toggle at many
     * cursors reads only the blocks it wrote in. The whole document is read
     * again when an edit touches the front matter or a line no top-level block
     * holds (a reference, footnote or abbreviation definition), or a part read
     * defines something or places a footnote's body — and when the regions
     * that meet take in more than half the document, which one parse reads
     * for less.
     */
    update(text: string): DocumentIndex {
        if (text === this.text) {
            return this;
        }
        const full = () => DocumentIndex.read(this.md, text, this.base, false);
        if (this.blocks.length === 0) {
            return full();
        }
        const lines = new Lines(text);
        const delta = lines.count - this.lines.count;
        let stretches = this.changedLines(text, lines);
        if (2 * this.reach(stretches) > this.lines.count) {
            return full();
        }
        // A stretch's region is read once, however many rounds it stays as it is.
        const read = new Map<string, Region | undefined>();
        const regionOf = (stretch: { first: number; last: number }) => {
            const key = `${stretch.first}:${stretch.last}`;
            if (!read.has(key)) {
                read.set(key, this.region(text, lines, stretch.first, stretch.last, delta));
            }
            return read.get(key);
        };
        for (;;) {
            const regions: Region[] = [];
            for (const stretch of stretches) {
                const region = regionOf(stretch);
                if (region === undefined) {
                    return full();
                }
                regions.push(region);
            }
            // Every run of regions that meet becomes one stretch, in one pass.
            const merged: { first: number; last: number }[] = [];
            let meets = false;
            let covered = 0;
            let runStart = 0;
            let runEnd = -1;
            regions.forEach((region, k) => {
                if (merged.length > 0 && region.startLine < runEnd) {
                    merged[merged.length - 1].last = stretches[k].last;
                    runEnd = Math.max(runEnd, region.endOld);
                    meets = true;
                    return;
                }
                covered += Math.max(0, runEnd - runStart);
                merged.push({ ...stretches[k] });
                runStart = region.startLine;
                runEnd = region.endOld;
            });
            covered += Math.max(0, runEnd - runStart);
            if (!meets) {
                return this.spliced(text, lines, regions);
            }
            if (2 * covered > this.lines.count) {
                return full();
            }
            stretches = merged;
        }
    }

    /**
     * The old lines `text` changes, in stretches: one from the first changed
     * line to the last when the line count changed, else each run of changed
     * lines.
     */
    private changedLines(text: string, lines: Lines): { first: number; last: number }[] {
        const oldText = this.text;
        let prefix = 0;
        const limit = Math.min(oldText.length, text.length);
        while (prefix < limit && oldText.charCodeAt(prefix) === text.charCodeAt(prefix)) {
            prefix++;
        }
        let suffix = 0;
        while (suffix < limit - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === text.charCodeAt(text.length - 1 - suffix)) {
            suffix++;
        }
        const first = this.lines.positionAt(prefix).line;
        const last = this.lines.positionAt(oldText.length - suffix).line;
        if (lines.count !== this.lines.count) {
            return [{ first, last }];
        }
        // A line with its terminator, as it was and as it is.
        const same = (line: number) => {
            const a = this.lines.startOf(line), b = lines.startOf(line);
            const aEnd = line + 1 < this.lines.count ? this.lines.startOf(line + 1) : oldText.length;
            const bEnd = line + 1 < lines.count ? lines.startOf(line + 1) : text.length;
            if (aEnd - a !== bEnd - b) {
                return false;
            }
            for (let k = 0; k < aEnd - a; k++) {
                if (oldText.charCodeAt(a + k) !== text.charCodeAt(b + k)) {
                    return false;
                }
            }
            return true;
        };
        const stretches: { first: number; last: number }[] = [];
        for (let line = first; line <= last; line++) {
            if (same(line)) {
                continue;
            }
            const previous = stretches[stretches.length - 1];
            if (previous !== undefined && previous.last === line - 1) {
                previous.last = line;
            } else {
                stretches.push({ first: line, last: line });
            }
        }
        return stretches.length ? stretches : [{ first, last }];
    }

    /**
     * How many old lines the stretches' regions take in at least, before any
     * is read: each from the top-level block before it through the block
     * after it, those that meet counted once.
     */
    private reach(stretches: { first: number; last: number }[]): number {
        let covered = 0;
        let runStart = 0;
        let runEnd = 0;
        for (const stretch of stretches) {
            const before = this.blocks[Math.max(0, this.blockAfter(stretch.first, 'end') - 1)];
            const after = this.blocks[this.blockAfter(stretch.last, 'start')];
            const start = Math.min(before.start, stretch.first);
            const end = Math.max(after === undefined ? this.lines.count : after.end, stretch.last + 1);
            if (start < runEnd) {
                runEnd = Math.max(runEnd, end);
                continue;
            }
            covered += runEnd - runStart;
            runStart = start;
            runEnd = end;
        }
        return covered + runEnd - runStart;
    }

    /** The index of the first top-level block whose end (or start) is after `line`. */
    private blockAfter(line: number, by: 'end' | 'start'): number {
        let low = 0;
        let high = this.blocks.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if ((by === 'end' ? this.blocks[mid].end : this.blocks[mid].start) > line) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        return low;
    }

    /**
     * Old lines `firstOld`..`lastOld` changed (the lines after moved by
     * `delta`), read again: from one top-level block before them, and back
     * over every block a line written there could join, as the parse starts
     * after a blank line; through the block after them, and further until the
     * parse's last block is the old one there. `undefined` where only the
     * whole document can be read again.
     */
    private region(text: string, lines: Lines, firstOld: number, lastOld: number, delta: number): Region | undefined {
        const oldText = this.text;
        // A definition changed or made by the edit (a reference's, an abbreviation's) reads in every block.
        const defines = (t: Lines, source: string, from: number, to: number) => {
            for (let line = from; line <= to && line < t.count; line++) {
                if (DEFINITION.test(source.slice(t.startOf(line), t.endOf(line)))) {
                    return true;
                }
            }
            return false;
        };
        if (defines(this.lines, oldText, firstOld, lastOld) || defines(lines, text, firstOld, lastOld + delta)) {
            return undefined;
        }
        // A footnote's body is placed after every block, and only while something refers to it.
        if (this.definitions.footnotes.length > 0) {
            const near = (t: Lines, source: string, from: number, to: number) => {
                const start = t.startOf(Math.min(from, t.count - 1));
                const end = t.endOf(Math.max(0, Math.min(to, t.count - 1)));
                return /\[\^|\^\[/.test(source.slice(Math.max(0, start - 64), end + 64));
            };
            if (near(this.lines, oldText, firstOld, lastOld) || near(lines, text, firstOld, lastOld + delta)) {
                return undefined;
            }
        }
        const changed = this.blockAfter(firstOld, 'end');
        let startLine = Math.min(this.blocks[Math.max(0, changed - 1)].start, firstOld);
        while (startLine > 0 && (this.blockAt[startLine - 1] !== undefined || this.kindOf(startLine - 1) !== 'blank')) {
            const block = this.blockAt[startLine - 1];
            if (block === undefined) {
                return undefined;
            }
            startLine = block.start;
        }
        const first = this.blockAfter(startLine - 1, 'start');
        let last = this.blockAfter(lastOld, 'start');
        for (let extension = 0; extension <= MAX_EXTENSIONS; extension++) {
            const atEnd = last >= this.blocks.length;
            const endOld = atEnd ? this.lines.count : this.blocks[last].end;
            const endNew = endOld + delta;
            if (endNew <= startLine) {
                return undefined;
            }
            for (let line = startLine; line < endOld; line++) {
                const block = this.blockAt[line];
                // A definition, a footnote's body, the front matter: read with the whole document.
                if ((block === undefined && this.kindOf(line) !== 'blank') || block?.type === 'front_matter') {
                    return undefined;
                }
            }
            const from = lines.startOf(startLine);
            const to = endNew >= lines.count ? text.length : lines.startOf(endNew);
            // A definition in the part may stop being one, or start, with the blocks around it.
            if (DEFINITION.test(text.slice(from, to)) || DEFINITION.test(oldText.slice(this.lines.startOf(startLine), endOld >= this.lines.count ? oldText.length : this.lines.startOf(endOld)))) {
                return undefined;
            }
            const env = seeded(this.base, this.definitions);
            // From the document's first line the part is the document's start, where front matter opens.
            const tokens = startLine === 0 ? this.md.parse(text.slice(from, to), env) : parsePart(this.md, text.slice(from, to), env);
            const s = scan(tokens, endNew - startLine, startLine, false);
            const defined = definitionsOf(env);
            // A label the part defines that the document did not.
            const more = (labels: string[], old: string[]) => {
                const known = new Set(old);
                return labels.some(label => !known.has(label));
            };
            const definesMore = more(Object.keys(defined.references), Object.keys(this.definitions.references))
                || more(defined.footnotes, this.definitions.footnotes)
                || more(Object.keys(defined.abbreviations), Object.keys(this.definitions.abbreviations));
            if (s.orphans || definesMore) {
                return undefined;
            }
            const lastBlock = s.blocks[s.blocks.length - 1];
            const old = atEnd ? undefined : this.blocks[last];
            const lined = atEnd || (lastBlock !== undefined && old !== undefined
                && lastBlock.start === old.start + delta && lastBlock.end === old.end + delta && lastBlock.type === old.type);
            if (lined) {
                return { startLine, endOld, endNew, scan: s, first, after: atEnd ? this.blocks.length : last + 1 };
            }
            last++;
        }
        return undefined;
    }

    /**
     * This index with each region's old lines `[startLine, endOld)` replaced
     * by its reading and its old blocks `[first, after)` by the reading's, the
     * lines and blocks after a region moved by the lines it added.
     */
    private spliced(text: string, lines: Lines, regions: Region[]): DocumentIndex {
        const next = Object.create(DocumentIndex.prototype) as DocumentIndex;
        const self = next as unknown as Record<string, unknown>;
        self.text = text;
        self.md = this.md;
        self.base = this.base;
        self.definitions = this.definitions;
        self.lines = lines;
        self.structure = [];
        self.inlines = [];
        self.defined = undefined;
        self.blockTokens = new Map<Block, Token[]>();
        const count = lines.count;
        const rank = new Uint8Array(count);
        const groupOf: (Group | undefined)[] = new Array(count);
        const blocks: Block[] = [];
        let shift = 0;
        let oldLine = 0;
        let oldBlock = 0;
        // A group or block an edit above moves is a copy, so this index's own stay as they are.
        const movedBlocks = new Map<Block, Block>();
        const movedGroups = new Map<Group, Group>();
        const keep = (to: number, toBlock: number) => {
            for (let k = oldBlock; k < toBlock; k++) {
                const block = this.blocks[k];
                if (shift !== 0) {
                    const copy = { ...block, start: block.start + shift, end: block.end + shift };
                    movedBlocks.set(block, copy);
                    blocks.push(copy);
                } else {
                    blocks.push(block);
                }
            }
            for (let line = oldLine; line < to; line++) {
                rank[line + shift] = this.kinds[line];
                let group = this.groupOf[line];
                if (group !== undefined && shift !== 0) {
                    let copy = movedGroups.get(group);
                    if (copy === undefined) {
                        copy = { ...group, first: group.first + shift, end: group.end + shift, block: group.block === null ? null : movedBlocks.get(group.block) ?? group.block };
                        movedGroups.set(group, copy);
                    }
                    group = copy;
                }
                groupOf[line + shift] = group;
            }
        };
        for (const region of regions) {
            keep(region.startLine, region.first);
            for (let line = region.startLine; line < region.endNew; line++) {
                rank[line] = region.scan.rank[line - region.startLine];
                groupOf[line] = region.scan.groupOf[line - region.startLine];
            }
            blocks.push(...region.scan.blocks);
            shift = region.endNew - region.endOld;
            oldLine = region.endOld;
            oldBlock = region.after;
        }
        keep(this.lines.count, this.blocks.length);
        // Ranks outside the regions are the final kinds already; `install` keeps blank as blank.
        next.install({ rank, groupOf, groups: [], blocks, orphans: false });
        // A block's tokens map lines from its start: they serve its moved copy as well.
        const kept = new Set(blocks);
        for (const [block, tokens] of this.blockTokens) {
            const now = movedBlocks.get(block) ?? block;
            if (kept.has(now)) {
                next.blockTokens.set(now, tokens);
            }
        }
        return next;
    }

    private reading(group: Group): Reading {
        if (group.read === undefined) {
            group.read = readGroup(this.text, this.lines, group, this.inlinesOf(group));
            if (group.block !== null) {
                group.inlines = undefined;
            }
        }
        return group.read;
    }

    /** A group's inline tokens: kept, or from its block parsed again. */
    private inlinesOf(group: Group): Token[] {
        if (group.inlines !== undefined || group.block === null) {
            return group.inlines ?? [];
        }
        const block = group.block;
        let tokens = this.blockTokens.get(block);
        if (tokens === undefined) {
            const from = this.lines.startOf(block.start);
            const to = block.end >= this.lines.count ? this.text.length : this.lines.startOf(block.end);
            tokens = parsePart(this.md, this.text.slice(from, to), seeded(this.base, this.definitions));
            if (this.blockTokens.size >= BLOCK_CACHE) {
                this.blockTokens.delete(this.blockTokens.keys().next().value as Block);
            }
            this.blockTokens.set(block, tokens);
        }
        const found = scan(tokens, block.end - block.start, block.start, true).groups
            .find(g => g.first === group.first && g.end === group.end);
        return found?.inlines ?? [];
    }
}

/** A group's stretches and spans, aligned with its lines of `text`. */
function readGroup(text: string, lines: Lines, group: Group, inlines: Token[]): Reading {
    const base = lines.startOf(group.first);
    const body = text.slice(base, lines.endOf(Math.min(group.end, lines.count) - 1));
    const norm = normalize(body);
    const src = norm.src;
    const { units, roles, barriers, spans, codes } = emit(inlines, group.row);
    const { toSource, toUnit, exact } = align(src, units);
    settleRuns(src, units, roles, toSource, toUnit, spans);
    const at = (index: number) => norm.toBody[index];
    const lineOf = (offset: number) => lines.positionAt(base + offset).line - group.first;

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
        const line = lineOf(stretch.start);
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
        return { start: at(start), end: at(Math.max(start, end)), markup: span.markup, exact: exact && found, attrs: span.attrs };
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
        sourceSpans.push({ start: at(start), end: at(Math.max(start, end)), markup: code.markup, exact: exact && found, attrs: code.attrs });
    }
    return { stretches, spans: sourceSpans };
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
function emit(inlines: readonly Token[], row: boolean): Emitted {
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
    const stack: { markup: string; at: number; order: number; pair: boolean; autolink: boolean; attrs: string }[] = [];
    let autolinks = 0;
    for (const inline of inlines) {
        if (row) {
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
                stack.push({ markup: child.markup, at: units.length, order: order++, pair, autolink, attrs: attrsOf(child) });
                autolinks += autolink ? 1 : 0;
                continue;
            }
            if (child.nesting === -1) {
                const top = stack.pop();
                autolinks -= top?.autolink ? 1 : 0;
                barrier = Math.max(barrier, top?.pair ? 1 : 2);
                if (top?.pair) {
                    spans.push({ markup: top.markup, open: top.at, close: units.length, openOrder: top.order, closeOrder: order++, attrs: top.attrs });
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
                    codes.push({ markup: child.markup, start, end: units.length, attrs: attrsOf(child) });
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
    if (row) {
        chars('|', BOUNDARY);
    }
    return { units, roles, barriers, spans, codes };
}
