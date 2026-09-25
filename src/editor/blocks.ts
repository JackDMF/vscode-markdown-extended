import { Token } from '../@types/markdown-it';

/**
 * The token stream → top-level source blocks step of the rich editor.
 *
 * Fidelity is a property of top-level blocks: each one keeps the exact slice of
 * the file it was read from, and a block nobody touched is written back from
 * that slice. This module decides where those slices are and which blocks the
 * editor may edit at all. It knows nothing of ProseMirror.
 */

// ---------------------------------------------------------------------------
// Source lines
// ---------------------------------------------------------------------------

/** One line of the original text, with the terminator it had in the file. */
export interface SourceLine {
    text: string;
    /** `\r\n`, `\n`, `\r`, or `''` for a last line without a terminator. */
    eol: string;
}

/**
 * Split the text into lines that index exactly as markdown-it's token `map`s do.
 *
 * markdown-it's `normalize` rule rewrites every `\r\n` and lone `\r` to `\n`
 * inside `state.src` before any block rule runs, so a slice of `state.src` has
 * lost the file's line endings. The maps still count lines the same way, so the
 * original text is split on the same three terminators and each line keeps its
 * own. A terminator at the very end opens no further line, as in markdown-it.
 */
export function splitLines(text: string): SourceLine[] {
    const lines: SourceLine[] = [];
    const re = /\r\n|\r|\n/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        lines.push({ text: text.slice(start, m.index), eol: m[0] });
        start = m.index + m[0].length;
    }
    if (start < text.length) {
        lines.push({ text: text.slice(start), eol: '' });
    }
    return lines;
}

/** The text of lines `[start, end)`, terminators included. */
export function sliceLines(lines: readonly SourceLine[], start: number, end: number): string {
    let out = '';
    for (let i = start; i < end && i < lines.length; i++) {
        out += lines[i].text + lines[i].eol;
    }
    return out;
}

/** Whether markdown-it treats the line as blank: nothing but spaces and tabs. */
export function isBlankLine(line: SourceLine | undefined): boolean {
    return line !== undefined && /^[ \t]*$/.test(line.text);
}

/** The line ending a changed block is written with: `\r\n` if the file has one anywhere, else `\n`. */
export function detectEol(text: string): '\n' | '\r\n' {
    return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * The literal `{…}` attribute suffix at the end of a heading's source line, or
 * `null`. `markdown-it-attrs` moves it into `heading_open.attrs` and strips it
 * from the inline text, so the serializer has to get it from the line to write
 * it back as it was — the anchor is a locator Req Explorer owns, never prose.
 */
export function findAttrsSuffix(line: string): string | null {
    const m = /(\{[^{}\r\n]*\})[ \t]*$/.exec(line);
    return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Injection marks (Req Explorer SPEC §10.2, FRS-RXE-097)
// ---------------------------------------------------------------------------

/** The key under `token.meta` Req Explorer's marks live under. */
export const INJECTION_META_KEY = 'reqExplorer';

/**
 * What a token Req Explorer's preview plugin injected stands for. Mirrors
 * `InjectionMark` in req-explorer's `markdownInjection.ts`; the two repositories
 * share the contract, not the code.
 */
export type InjectionMark =
    /**
     * `path` is the snippet file the body was read from (absolute, as Req
     * Explorer's host loaded it) and `lang` the variant that answered; both are
     * absent when `missing` is set, so nothing offers to open a file that is not
     * there (SPEC §10.2, `CR-RXE-127`). Optional here because a Req Explorer
     * older than that change marks expansions without them.
     */
    | { rule: 'req-includes'; kind: 'expansion'; snippet: string; line: number; path?: string; lang?: string; missing?: true }
    | { rule: 'req-status-badges'; kind: 'atom'; artifact: string }
    | { rule: 'req-status-badges'; kind: 'decoration'; text: string }
    | { rule: 'req-reading-styles'; kind: 'atom' };

/**
 * A token's injection mark, or `undefined` for authored content. The key is
 * shared with whatever else writes to `meta`, so the shape is checked rather
 * than assumed, as Req Explorer's own reader does.
 */
export function injectionMarkOf(token: Token): InjectionMark | undefined {
    const meta = token.meta as Record<string, unknown> | null | undefined;
    if (typeof meta !== 'object' || meta === null) {
        return undefined;
    }
    const mark = meta[INJECTION_META_KEY] as { rule?: unknown; kind?: unknown } | null | undefined;
    if (typeof mark !== 'object' || mark === null) {
        return undefined;
    }
    if (typeof mark.rule !== 'string' || typeof mark.kind !== 'string') {
        return undefined;
    }
    return mark as InjectionMark;
}

/** Two expansion marks stand for the same directive line. */
function sameExpansion(a: InjectionMark | null, b: InjectionMark | null): boolean {
    return a !== null && b !== null && a.kind === 'expansion' && b.kind === 'expansion'
        && a.snippet === b.snippet && a.line === b.line;
}

// ---------------------------------------------------------------------------
// Known tokens
// ---------------------------------------------------------------------------

/** Top-level tokens that can open an editable block. Anything else at top level is a raw block. */
export const EDITABLE_TOP_LEVEL_TOKENS: ReadonlySet<string> = new Set([
    'paragraph_open', 'heading_open', 'bullet_list_open', 'ordered_list_open',
    'blockquote_open', 'fence', 'code_block', 'hr',
]);

/** Every block-level token an editable block may contain, at any depth. */
export const EDITABLE_BLOCK_TOKENS: ReadonlySet<string> = new Set([
    'paragraph_open', 'paragraph_close',
    'heading_open', 'heading_close',
    'bullet_list_open', 'bullet_list_close',
    'ordered_list_open', 'ordered_list_close',
    'list_item_open', 'list_item_close',
    'blockquote_open', 'blockquote_close',
    'fence', 'code_block', 'hr', 'inline',
]);

/**
 * Every authored inline token an editable block may contain. Req Explorer's
 * injected `html_inline` children (a badge atom, a `req-ref` decoration) are
 * accepted beside these by their mark, never by their type: authored inline
 * HTML is the same token type and makes its block raw.
 */
export const EDITABLE_INLINE_TOKENS: ReadonlySet<string> = new Set([
    'text', 'softbreak', 'hardbreak',
    'em_open', 'em_close', 'strong_open', 'strong_close',
    'code_inline', 'link_open', 'link_close', 'image',
    // The extension's inline syntax: `==`, `^`, `~`, `~~`, `[[…]]` …
    'mark_open', 'mark_close', 'sup_open', 'sup_close', 'sub_open', 'sub_close',
    's_open', 's_close', 'kbd_open', 'kbd_close',
    // … and the note family (`markdownItSidenote.ts`), whose reference and body are inline content.
    'sidenote_open', 'sidenote_ref_open', 'sidenote_ref_close', 'sidenote_content_open', 'sidenote_content_close', 'sidenote_close',
    'marginal_note_open', 'marginal_note_ref_open', 'marginal_note_ref_close',
    'marginal_note_content_open', 'marginal_note_content_close', 'marginal_note_close',
    'left_sidebar_open', 'left_sidebar_close', 'right_sidebar_open', 'right_sidebar_close',
]);

/** The tokens that open and close a note or a sidebar, which the schema holds one level deep. */
export const NOTE_OPEN_TOKENS: ReadonlySet<string> = new Set(['sidenote_open', 'marginal_note_open', 'left_sidebar_open', 'right_sidebar_open']);
const NOTE_CLOSE_TOKENS: ReadonlySet<string> = new Set(['sidenote_close', 'marginal_note_close', 'left_sidebar_close', 'right_sidebar_close']);

/**
 * The attributes a token may carry and still be editable. The schema has a slot
 * for these and nothing else; any other attribute (`markdown-it-attrs` on a
 * paragraph, a list item or a span) would be lost by a re-serialization.
 * `heading_open` is checked separately, against its source line.
 */
const ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = {
    ordered_list_open: ['start'],
    link_open: ['href', 'title'],
    image: ['src', 'alt', 'title'],
};

function attrsAllowed(token: Token): boolean {
    if (!token.attrs || token.attrs.length === 0) {
        return true;
    }
    const allowed = ALLOWED_ATTRS[token.type] ?? [];
    return token.attrs.every(([name]) => allowed.includes(name));
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * `front_matter` — the YAML block, emitted from its slice unconditionally.
 * `editable` — built from the editable core; untouched it is emitted from its slice, changed it is serialized.
 * `raw` — anything else the file contains; shown as rendered HTML, emitted from its (editable-as-text) slice.
 * `injected` — content the file does not contain at this place; emitted as its directive line or as nothing.
 */
export type BlockKind = 'front_matter' | 'editable' | 'raw' | 'injected';

/**
 * `atom` and `expansion` are Req Explorer's mark kinds; `generated` is a
 * top-level token range no source line accounts for and no mark claims — the
 * footnote list `markdown-it-footnote` appends at the end, for one.
 */
export type InjectedKind = 'atom' | 'expansion' | 'generated';

export interface SourceBlock {
    kind: BlockKind;
    /** Why the block is classified so; for a raw block, the construct that made it raw. */
    reason: string;
    /** The block's top-level tokens, `[start, end)` into the token stream; `[i, i]` for source lines no token covers. */
    tokenRange: [number, number];
    /** The source lines `[start, end)` the block stands for, trailing blank lines excluded; `null` when it stands for none. */
    lineRange: [number, number] | null;
    /** The exact text of `lineRange`, or `null` when there is none. */
    src: string | null;
    /** The text between the previous block's lines and this block's (for the first block: everything before it). `''` for a block with no lines. */
    gap: string;
    /** For an injected block: what kind of injection. */
    injectedKind: InjectedKind | null;
    /** For an injected block: the mark on its first token (`null` for `generated`). */
    mark: InjectionMark | null;
}

export interface GroupedBlocks {
    blocks: SourceBlock[];
    /** The text after the last block's lines; only blank lines, since source lines no token covers become raw blocks. */
    tail: string;
}

interface TokenGroup {
    start: number;
    end: number;
    map: [number, number] | null;
}

/** Split the stream into top-level ranges by nesting, not by `level`: `markdown-it-footnote` emits its tail block with inconsistent levels. */
function topLevelGroups(tokens: readonly Token[]): TokenGroup[] {
    const groups: TokenGroup[] = [];
    let i = 0;
    while (i < tokens.length) {
        const start = i;
        let depth = 0;
        let map: [number, number] | null = null;
        do {
            const t = tokens[i];
            const before = depth;
            depth += t.nesting;
            // Only the tokens at the group's own level describe its lines. The
            // opening token's map is usually the whole range, but not always —
            // MEP's admonition puts the full range on the closing token.
            if ((before === 0 || depth === 0) && t.map && t.map.length === 2) {
                map = map === null
                    ? [t.map[0], t.map[1]]
                    : [Math.min(map[0], t.map[0]), Math.max(map[1], t.map[1])];
            }
            i++;
        } while (depth > 0 && i < tokens.length);
        groups.push({ start, end: i, map });
    }
    return groups;
}

interface Classification {
    kind: BlockKind;
    reason: string;
    injectedKind: InjectedKind | null;
    mark: InjectionMark | null;
}

function raw(reason: string): Classification {
    return { kind: 'raw', reason, injectedKind: null, mark: null };
}

/** Why the group cannot be edited, or `null` when it can. */
function notEditableBecause(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[]): string | null {
    for (let i = group.start; i < group.end; i++) {
        const t = tokens[i];
        if (!EDITABLE_BLOCK_TOKENS.has(t.type)) {
            return `nested ${t.type}`;
        }
        if (t.type === 'heading_open') {
            if (!t.markup.startsWith('#') || !t.map || t.map[1] - t.map[0] !== 1) {
                return 'setext heading: its underline has no place in the heading node';
            }
            if (t.attrs && t.attrs.length > 0 && findAttrsSuffix(lines[t.map[0]]?.text ?? '') === null) {
                return 'heading attributes that are not written as a trailing {…} on its line';
            }
        }
        if (injectionMarkOf(t) !== undefined) {
            return `injected ${t.type} nested inside an authored block`;
        }
        if (t.type !== 'heading_open' && !attrsAllowed(t)) {
            return `attributes on ${t.type}`;
        }
        if (t.type !== 'inline') {
            continue;
        }
        let noteDepth = 0;
        for (const child of t.children ?? []) {
            if (NOTE_OPEN_TOKENS.has(child.type)) {
                if (noteDepth > 0) {
                    // The plugin allows a note of another kind inside a note; the
                    // schema keeps notes one level deep (see schema.ts).
                    return `${child.type} inside another note`;
                }
                noteDepth++;
            } else if (NOTE_CLOSE_TOKENS.has(child.type)) {
                noteDepth--;
            }
            const mark = injectionMarkOf(child);
            if (mark !== undefined) {
                if (mark.kind === 'atom' || (mark.kind === 'decoration' && child.type === 'html_inline')) {
                    continue;
                }
                return `injected inline ${child.type} of kind ${mark.kind}`;
            }
            if (!EDITABLE_INLINE_TOKENS.has(child.type)) {
                return `inline ${child.type}`;
            }
            if (!attrsAllowed(child)) {
                return `attributes on ${child.type}`;
            }
        }
    }
    return null;
}

function classify(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[]): Classification {
    const first = tokens[group.start];
    if (first.type === 'front_matter') {
        return { kind: 'front_matter', reason: 'front matter', injectedKind: null, mark: null };
    }
    const mark = injectionMarkOf(first);
    if (mark !== undefined) {
        const injectedKind: InjectedKind = mark.kind === 'expansion' ? 'expansion' : 'atom';
        return { kind: 'injected', reason: `injected by ${mark.rule}`, injectedKind, mark };
    }
    if (group.map === null) {
        return { kind: 'injected', reason: `${first.type} stands for no source line`, injectedKind: 'generated', mark: null };
    }
    if (!EDITABLE_TOP_LEVEL_TOKENS.has(first.type)) {
        return raw(first.type);
    }
    const because = notEditableBecause(tokens, group, lines);
    if (because !== null) {
        return raw(because);
    }
    return { kind: 'editable', reason: first.type, injectedKind: null, mark: null };
}

/** The end of `[start, end)` with trailing blank lines removed, never below one line. */
function trimTrailingBlank(lines: readonly SourceLine[], start: number, end: number): number {
    let e = Math.min(end, lines.length);
    // A list or blockquote map reaches over the blank line after it; that line
    // belongs to the next block's gap, or a changed list would be written back
    // glued to what follows it.
    while (e > start + 1 && isBlankLine(lines[e - 1])) {
        e--;
    }
    return e;
}

interface LaidOut {
    classification: Classification;
    tokenRange: [number, number];
    lineRange: [number, number] | null;
    gapStart: number;
}

/**
 * Group the top-level token stream of `text` into source blocks.
 *
 * Every line of the file ends up in exactly one place — a block's `src`, a
 * block's `gap`, or the `tail` — so emitting `gap + src` for every block and
 * then the tail reproduces the file. Lines no token accounts for (reference
 * definitions, footnote and abbreviation definitions, a closing marker a plugin
 * left out of its map) become raw blocks of their own, or join the raw block
 * they touch: in a gap they would vanish with whatever block is deleted after
 * them.
 */
export function groupSourceBlocks(tokens: readonly Token[], lines: readonly SourceLine[]): GroupedBlocks {
    const groups = topLevelGroups(tokens);
    const classified = groups.map(g => ({ group: g, classification: classify(tokens, g, lines) }));
    const laid: LaidOut[] = [];
    let cursor = 0;
    let lastMapped: LaidOut | null = null;

    const orphans = (from: number, to: number, nextIsRaw: boolean): { gapStart: number; prependTo: number | null } => {
        let a = from;
        while (a < to && isBlankLine(lines[a])) {
            a++;
        }
        if (a >= to) {
            return { gapStart: from, prependTo: null };
        }
        let b = to;
        while (b > a && isBlankLine(lines[b - 1])) {
            b--;
        }
        if (a === from && lastMapped !== null && lastMapped.classification.kind === 'raw'
            && lastMapped.lineRange !== null && lastMapped.lineRange[1] === from) {
            lastMapped.lineRange[1] = b;
            return { gapStart: b, prependTo: null };
        }
        if (b === to && nextIsRaw) {
            return { gapStart: from, prependTo: a };
        }
        const orphan: LaidOut = {
            classification: raw('source lines no token accounts for'),
            tokenRange: [laid.length === 0 ? 0 : laid[laid.length - 1].tokenRange[1], laid.length === 0 ? 0 : laid[laid.length - 1].tokenRange[1]],
            lineRange: [a, b],
            gapStart: from,
        };
        laid.push(orphan);
        lastMapped = orphan;
        return { gapStart: b, prependTo: null };
    };

    for (const { group, classification } of classified) {
        if (group.map === null) {
            laid.push({ classification, tokenRange: [group.start, group.end], lineRange: null, gapStart: cursor });
            continue;
        }
        let s = group.map[0];
        const e = trimTrailingBlank(lines, s, group.map[1]);
        const prev = lastMapped as LaidOut | null;
        // Every token of one include expansion carries the directive's line; the
        // consecutive top-level groups they form are one atom standing for it.
        if (prev !== null && classification.kind === 'injected' && prev.classification.kind === 'injected'
            && sameExpansion(prev.classification.mark, classification.mark)
            && laid[laid.length - 1] === prev) {
            prev.tokenRange[1] = group.end;
            continue;
        }
        if (s < cursor) {
            // A range that reaches back into lines an earlier block already
            // holds cannot be sliced on its own; it and that block become one
            // raw block, so no line is emitted twice.
            if (prev !== null && laid[laid.length - 1] === prev) {
                prev.classification = raw(`${prev.classification.reason} overlapping ${tokens[group.start].type}`);
                prev.tokenRange[1] = group.end;
                if (prev.lineRange !== null && e > prev.lineRange[1]) {
                    prev.lineRange[1] = e;
                    cursor = e;
                }
                continue;
            }
            // Not adjacent to the block holding those lines: its lines are
            // already emitted there, so it is kept as content that writes nothing.
            laid.push({
                classification: {
                    kind: 'injected',
                    reason: `${tokens[group.start].type} overlapping lines an earlier block holds`,
                    injectedKind: 'generated',
                    mark: null,
                },
                tokenRange: [group.start, group.end],
                lineRange: null,
                gapStart: cursor,
            });
            continue;
        }
        const placed = orphans(cursor, s, classification.kind === 'raw');
        if (placed.prependTo !== null) {
            s = placed.prependTo;
        }
        const block: LaidOut = { classification, tokenRange: [group.start, group.end], lineRange: [s, e], gapStart: placed.gapStart };
        laid.push(block);
        lastMapped = block;
        cursor = e;
    }
    const end = orphans(cursor, lines.length, false);
    const tail = sliceLines(lines, end.gapStart, lines.length);

    const blocks: SourceBlock[] = laid.map(l => ({
        kind: l.classification.kind,
        reason: l.classification.reason,
        tokenRange: l.tokenRange,
        lineRange: l.lineRange,
        src: l.lineRange === null ? null : sliceLines(lines, l.lineRange[0], l.lineRange[1]),
        gap: l.lineRange === null ? '' : sliceLines(lines, l.gapStart, l.lineRange[0]),
        injectedKind: l.classification.injectedKind,
        mark: l.classification.mark,
    }));
    return { blocks, tail };
}
