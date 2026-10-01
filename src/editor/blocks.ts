import { Token } from '../@types/markdown-it';
import { AttrPair, NOTE_SYNTAX_CHARS, endLiteralOf, findRightDelimiter, hasInnerBrace, joinAttrs, normalizedLiteral, parseAttrsLiteral, sameAttrs } from './attrs';

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

/**
 * The `{…}` a line ends with as markdown-it-attrs finds it — the last `{`
 * outside a quoted value, through the line's end — when it is a literal the
 * plugin takes as attributes and no brace of the text's own (`isTextBrace`);
 * `null` otherwise. Unlike `findAttrsSuffix` it reads a quoted `}`
 * (`{title="a}"}`) as the plugin does.
 */
export function findEndLiteral(line: string): string | null {
    return endLiteralOf(line);
}

/**
 * Where a block's `{…}` stands in its source, which a changed block is written
 * back in (`serialize.ts`):
 *
 * - `end` — at the end of the block's last line, after a space: a paragraph's
 *   `text {.a}`, a heading's `# Title {#id}`, a fence's opening line
 *   ```` ```js {.a} ````, a rule's `--- {#id}`;
 * - `line` — on a line of its own right after the block's last line: a
 *   paragraph's or a list's `{.a}` below its text, which the plugin reads
 *   through the soft break before it; a quote's `> {.a}` under its last
 *   paragraph, inside the quote; a table's `{.a}` right under its last row;
 * - `blank` — on a line of its own after a blank line, which the plugin reads
 *   for a list and a table only (a paragraph there would be a paragraph of its
 *   own). A changed table is always written so: the `line` form is read only
 *   while nothing follows it on the next line.
 *
 * A list item's literal is none of these: it stands at the end of the item's
 * first paragraph, at any depth (`recoverItemLiterals`), and is the item's
 * `literal`, not a top-level block's `attrsSuffix`.
 */
export type AttrsPlacement = 'end' | 'line' | 'blank';

/** A top-level block's attribute literal, verbatim, and where it was written. */
export interface BlockAttrs {
    suffix: string;
    placement: AttrsPlacement;
}

/** A line that closes a container opened with `markup`: only colons, at least as many, and spaces (markdown-it-container). */
export function isContainerClose(line: string | undefined, markup: string): boolean {
    if (line === undefined) {
        return false;
    }
    const m = /^[ \t]{0,3}(:+)[ \t]*$/.exec(line);
    return m !== null && m[1].length >= markup.length;
}

/** The same test on a line inside a quote or a list item, whose prefix (`> `, indentation) is stripped first. */
function isNestedContainerClose(line: string | undefined, markup: string): boolean {
    return line !== undefined && isContainerClose(withoutBlockPrefix(line), markup);
}

/**
 * A line without what the blocks around it put before its own text: the
 * indentation and every quote's `>` — `  > {.a}` is `{.a}`. What a container's
 * closing fence, a quote's literal and a list item's lone literal line are
 * read from.
 */
function withoutBlockPrefix(line: string): string {
    return line.replace(/^[\s>]*/, '');
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

/**
 * The token markdown-it-container opens this extension's containers with: the
 * extension registers the one container name `container` and accepts any info
 * (`markdownItContainer.ts`), so every `::: …` block opens with this type.
 * Another extension's container name is another type, and stays raw.
 */
export const CONTAINER_OPEN = 'container_container_open';
export const CONTAINER_CLOSE = 'container_container_close';

/**
 * Why a container written with a `{…}` on its `:::` line is a source block: the
 * preview draws the literal on the container's `div` (`markdownItContainer.ts`),
 * and the container node has no slot to keep it in.
 */
const CONTAINER_ATTRS_REASON = 'container attributes on its ::: line, which the container node does not keep';

/** Top-level tokens that can open an editable block. Anything else at top level is a raw block. */
export const EDITABLE_TOP_LEVEL_TOKENS: ReadonlySet<string> = new Set([
    'paragraph_open', 'heading_open', 'bullet_list_open', 'ordered_list_open',
    'blockquote_open', 'fence', 'code_block', 'hr',
    CONTAINER_OPEN, 'admonition_open', 'table_open',
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
    CONTAINER_OPEN, CONTAINER_CLOSE,
    'admonition_open', 'admonition_close', 'admonition_title_open', 'admonition_title_close',
]);

/** The block tokens that open a node holding blocks of its own: a container, an admonition. */
const WRAPPER_OPEN_TOKENS: ReadonlySet<string> = new Set([CONTAINER_OPEN, 'admonition_open']);
const WRAPPER_CLOSE_TOKENS: ReadonlySet<string> = new Set([CONTAINER_CLOSE, 'admonition_close']);

/**
 * How deep containers and admonitions may nest and still be edited in place: a
 * top-level one, and one level inside it. The fence-length rule nests
 * containers arbitrarily, but every level is one more fence the serializer has
 * to lengthen and one more indentation to get right; deeper stays a source block.
 */
export const MAX_WRAPPER_DEPTH = 2;

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
    // `[text]{…}`: markdown-it-bracketed-spans makes the span, markdown-it-attrs gives it the attributes.
    'span_open', 'span_close',
]);

/** The tokens that open and close a note or a sidebar, which the schema holds one level deep. */
export const NOTE_OPEN_TOKENS: ReadonlySet<string> = new Set(['sidenote_open', 'marginal_note_open', 'left_sidebar_open', 'right_sidebar_open']);
const NOTE_CLOSE_TOKENS: ReadonlySet<string> = new Set(['sidenote_close', 'marginal_note_close', 'left_sidebar_close', 'right_sidebar_close']);

/**
 * The attributes a token carries as part of what it is, which the schema has a
 * slot for. Anything beyond them came from a `{…}` literal (`markdown-it-attrs`):
 * the editor keeps that literal where it can say where it was written — a span's
 * (`[text]{…}`), a top-level block's (`recoverBlockAttrs`), a heading's — and
 * leaves any other element carrying one (a list item, a nested paragraph, a
 * link, emphasis) a source block, since a re-serialization would lose it.
 */
const ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = {
    ordered_list_open: ['start'],
    link_open: ['href', 'title'],
    image: ['src', 'alt', 'title'],
};

/** The token's attributes that came from a `{…}` literal, as `[name, value]` pairs. */
function literalAttrs(token: Token): AttrPair[] {
    const allowed = ALLOWED_ATTRS[token.type] ?? [];
    return (token.attrs ?? []).filter(([name]) => !allowed.includes(name)).map(([name, value]) => [name, String(value)]);
}

function attrsAllowed(token: Token): boolean {
    return literalAttrs(token).length === 0;
}

/** The index of the token closing the one opened at `open`, by nesting. */
function closingIndex(tokens: readonly Token[], open: number): number {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
        depth += tokens[i].nesting;
        if (depth === 0) {
            return i;
        }
    }
    return tokens.length - 1;
}

/** The first line after a wrapper's own lines: a container's closing fence (or where it was closed), an admonition's end. */
function wrapperEnd(tokens: readonly Token[], open: number): number {
    const t = tokens[open];
    if (t.type === CONTAINER_OPEN) {
        return t.map ? t.map[1] : Number.MAX_SAFE_INTEGER;
    }
    const close = tokens[closingIndex(tokens, open)];
    return close.map ? close.map[1] : Number.MAX_SAFE_INTEGER;
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
    /** For an editable block: its `{…}` literal and where it stands, or `null` (`recoverBlockAttrs`). */
    attrs: BlockAttrs | null;
    /** For an editable block: the literal of each attribute span in it, in token order (`recoverSpanLiterals`). */
    spanLiterals: string[];
    /** For an editable block: the literal of each list item carrying one, in token order (`recoverItemLiterals`). */
    itemLiterals: string[];
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
    /** An editable block's attribute literal (`attrsSuffix`), or `null`. */
    attrs: BlockAttrs | null;
    /** The literal of every attribute span in the block, in token order. */
    spanLiterals: string[];
    /** The literal of every list item in the block that carries one, in token order. */
    itemLiterals: string[];
    /** Where the block's lines end when that is past its tokens' map: a container's closing fence, a list's or a table's literal after it. */
    endLine: number | null;
}

function raw(reason: string): Classification {
    return { kind: 'raw', reason, injectedKind: null, mark: null, attrs: null, spanLiterals: [], itemLiterals: [], endLine: null };
}

// ---------------------------------------------------------------------------
// Pipe tables
// ---------------------------------------------------------------------------

/**
 * The tokens a pipe table is made of. markdown-it-multimd-table emits these
 * for its extensions too — a colspan is a `td` with a `colspan` attribute, a
 * multi-line row a `tr` whose map spans lines, holding block tokens — so the
 * token types say nothing on their own; `pipeTableNotEditableBecause` reads
 * the shape.
 */
const TABLE_TOKENS: ReadonlySet<string> = new Set([
    'table_open', 'table_close', 'thead_open', 'thead_close', 'tbody_open', 'tbody_close',
    'tr_open', 'tr_close', 'th_open', 'th_close', 'td_open', 'td_close', 'inline',
]);

/** The notes whose reference ends at `|`, which in a table is a cell boundary (`schema.ts`, *Tables*). */
const NOTES_WITH_REFERENCE: ReadonlySet<string> = new Set(['sidenote_open', 'marginal_note_open']);

/** A GFM delimiter cell: dashes, a colon at either end for the alignment. multimd also reads `=` and a trailing `+`. */
const GFM_DELIMITER_CELL = /^:?-+:?$/;

/** The cells of a delimiter row as written, outer pipes optional: it holds no escape and no code, so a split on `|` is exact. */
function delimiterCells(line: string): string[] {
    let row = line.trim();
    if (row.startsWith('|')) {
        row = row.slice(1);
    }
    if (row.endsWith('|')) {
        row = row.slice(0, -1);
    }
    return row.split('|').map(c => c.trim());
}

/**
 * Why a table the multimd plugin read is not a plain pipe table, or `null`
 * when it is one: the header row, the delimiter row, body rows, one line each,
 * every cell a plain `th`/`td` holding one line of inline content. Everything
 * else the plugin reads stays a source block — a colspan (`||`) or rowspan
 * (`^^`) cell, a multi-line row (`\` at a line's end), a caption (`[…]`), a
 * headerless table, a second header row, a second body after a blank line, a
 * `=` or `+` in the delimiter row, a row with a cell count the header does not
 * have — read from the tokens where they show it (the attributes, the
 * caption's and `tbody`'s tokens, a `tr`'s map), from the delimiter row's
 * slice where only the source does (`=`, a delimiter the tokens normalized).
 * The table is the whole group; attributes on the table itself are
 * `recoverBlockAttrs`' to refuse.
 */
function pipeTableNotEditableBecause(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[]): string | null {
    let head = 0;
    let bodies = 0;
    let section: 'thead' | 'tbody' | null = null;
    let headerRows = 0;
    let columns = -1;
    let cells = 0;
    let headerLine = -1;
    for (let i = group.start + 1; i < group.end - 1; i++) {
        const t = tokens[i];
        if (!TABLE_TOKENS.has(t.type)) {
            return t.type.startsWith('caption') ? 'table caption (multimd)' : `${t.type} in a table cell: a multi-line row (multimd)`;
        }
        if (injectionMarkOf(t) !== undefined) {
            return `injected ${t.type} inside a table`;
        }
        switch (t.type) {
            case 'thead_open':
                head++;
                section = 'thead';
                break;
            case 'tbody_open':
                bodies++;
                section = 'tbody';
                break;
            case 'thead_close':
            case 'tbody_close':
                section = null;
                break;
            case 'tr_open':
                if (!t.map || t.map[1] - t.map[0] !== 1) {
                    return 'table row on more than one line (multimd)';
                }
                if (section === 'thead') {
                    headerRows++;
                    headerLine = t.map[0];
                }
                cells = 0;
                break;
            case 'tr_close':
                if (columns < 0) {
                    columns = cells;
                } else if (cells !== columns) {
                    return `table row of ${cells} cells under a header of ${columns}`;
                }
                break;
            case 'th_open':
            case 'td_open': {
                cells++;
                const extra = (t.attrs ?? []).filter(([name, value]) => !(name === 'style' && /^text-align:(left|center|right)$/.test(String(value))));
                if (extra.length > 0) {
                    return `table cell with ${extra.map(([name]) => name).join(', ')} (multimd)`;
                }
                if (tokens[i + 1]?.type !== 'inline' || tokens[i + 2]?.type !== t.type.replace('_open', '_close')) {
                    return 'table cell holding blocks (multimd)';
                }
                break;
            }
            case 'inline': {
                const children = t.children ?? [];
                const because = inlineNotEditable(children);
                if (because !== null) {
                    return `${because} in a table cell`;
                }
                for (const child of children) {
                    if (NOTES_WITH_REFERENCE.has(child.type)) {
                        return `${child.type} in a table cell: its | is a cell boundary`;
                    }
                    if (child.type === 'hardbreak' || child.type === 'softbreak') {
                        return `${child.type} in a table cell`;
                    }
                    if (child.type === 'code_inline' && child.content.includes('|')) {
                        return 'code holding | in a table cell: the table plugin splits a row at it in some code spans and not in others';
                    }
                }
                break;
            }
        }
    }
    if (head !== 1 || headerRows !== 1) {
        return head === 0 ? 'headerless table (multimd)' : 'table with more than one header row (multimd)';
    }
    if (bodies > 1) {
        return 'table with a second body after a blank line (multimd)';
    }
    const delimiter = delimiterCells(lines[headerLine + 1]?.text ?? '');
    if (delimiter.length !== columns || !delimiter.every(c => GFM_DELIMITER_CELL.test(c))) {
        return 'table delimiter row that is not GFM\'s (multimd)';
    }
    return null;
}

/** Why the group cannot be edited, or `null` when it can. */
function notEditableBecause(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[]): string | null {
    if (tokens[group.start].type === 'table_open') {
        return pipeTableNotEditableBecause(tokens, group, lines);
    }
    /** The first line after each enclosing container's or admonition's own lines, innermost last. */
    const wrapperEnds: number[] = [];
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
        if (WRAPPER_OPEN_TOKENS.has(t.type)) {
            if (wrapperEnds.length >= MAX_WRAPPER_DEPTH) {
                return `${t.type} nested more than one level deep`;
            }
            if (t.type === 'admonition_open' && /\s/.test(t.info.trim())) {
                // `!!! warning big "Title"`: a second class the node has no slot for.
                return 'admonition with more than one class';
            }
            if (t.type === CONTAINER_OPEN && i !== group.start) {
                // A nested container its own fence does not close ends where
                // its parent does (equal fences: the first `:::` closes the
                // outer one), and the lines after it are no longer what they seem.
                const end = t.map ? t.map[1] : -1;
                const parentEnd = wrapperEnds.length > 0 ? wrapperEnds[wrapperEnds.length - 1] : Number.MAX_SAFE_INTEGER;
                if (end < 0 || end >= parentEnd || !isNestedContainerClose(lines[end]?.text, t.markup)) {
                    return 'container closed by its parent, not by a fence of its own';
                }
            }
            wrapperEnds.push(wrapperEnd(tokens, i));
        } else if (WRAPPER_CLOSE_TOKENS.has(t.type)) {
            wrapperEnds.pop();
        }
        if (injectionMarkOf(t) !== undefined) {
            return `injected ${t.type} nested inside an authored block`;
        }
        // The top-level opener's literal is `recoverBlockAttrs`'s, a list item's `recoverItemLiterals`'.
        if (i !== group.start && t.type !== 'heading_open' && t.type !== 'list_item_open' && !attrsAllowed(t)) {
            return t.type === CONTAINER_OPEN ? CONTAINER_ATTRS_REASON : `attributes on ${t.type}`;
        }
        if (t.type !== 'inline') {
            continue;
        }
        const inTitle = tokens[i - 1]?.type === 'admonition_title_open';
        // The title is written back as the string it is, so content another
        // extension put there would be lost; and it is held to the same rules
        // as any inline content, so a title the editor could not edit as text
        // does not ride along in an editable block.
        if (inTitle && (t.children ?? []).some(c => injectionMarkOf(c) !== undefined)) {
            return 'injected content in an admonition title';
        }
        const because = inlineNotEditable(t.children ?? []);
        if (because !== null) {
            return inTitle ? `${because} in an admonition title` : because;
        }
    }
    return null;
}

/** Why an inline token's children cannot be edited in place, or `null` when they can. */
function inlineNotEditable(children: readonly Token[]): string | null {
    let noteDepth = 0;
    let spanDepth = 0;
    for (const child of children) {
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
        if (child.type === 'span_open') {
            if (spanDepth > 0) {
                // One mark type cannot hold itself: a span in a span has no place.
                return 'attribute span inside another';
            }
            if (!child.attrs || child.attrs.length === 0) {
                return 'bracketed span with no attributes';
            }
            spanDepth++;
            continue;
        }
        if (child.type === 'span_close') {
            spanDepth--;
            continue;
        }
        if (!attrsAllowed(child)) {
            return `attributes on ${child.type}`;
        }
    }
    return null;
}

/** The top-level openers whose `{…}` the editor keeps as `attrsSuffix`, written back where it stood. */
const SUFFIX_BLOCKS: ReadonlySet<string> = new Set([
    'paragraph_open', 'heading_open', 'bullet_list_open', 'ordered_list_open', 'fence', 'hr', 'blockquote_open', 'table_open',
]);

/**
 * The first line after `last` that is not blank, before `nextStart` (the first
 * line a later block's tokens claim), with its text trimmed: where a list's or
 * a table's literal stands when no token's map holds it. `null` when there is none.
 */
function lineAfter(lines: readonly SourceLine[], last: number, nextStart: number): { at: number; text: string } | null {
    let k = last + 1;
    while (k < nextStart && isBlankLine(lines[k])) {
        k++;
    }
    return k < nextStart && lines[k] !== undefined ? { at: k, text: lines[k].text.trim() } : null;
}

/** The index of the opening token matching the closing one at `close`, by nesting. */
function openingIndex(tokens: readonly Token[], close: number): number {
    let depth = 0;
    for (let i = close; i >= 0; i--) {
        depth += tokens[i].nesting;
        if (depth === 0) {
            return i;
        }
    }
    return 0;
}

/**
 * The attribute literal of a top-level block, recovered verbatim from its lines
 * and where it stands (`AttrsPlacement`), or why it cannot be kept: the literal
 * is not where the editor could write it back, or it does not read as the
 * attributes the token has (a second literal the plugin merged in, a spelling
 * the source holds and the token does not show). A heading keeps its existing
 * rule: a trailing `{…}` on its line, whatever it holds — Req Explorer's anchors.
 *
 * `nextStart` is the first line a later block's tokens claim: a list's literal
 * after a blank line (`blank`) is in no token's map, since the plugin removes
 * the paragraph it was, and belongs to the list only when nothing else stands
 * between.
 */
function recoverBlockAttrs(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[], nextStart: number): { attrs: BlockAttrs | null; endLine: number | null } | string {
    const open = tokens[group.start];
    const wanted = literalAttrs(open);
    if (wanted.length === 0) {
        return { attrs: null, endLine: null };
    }
    if (open.type === CONTAINER_OPEN) {
        return CONTAINER_ATTRS_REASON;
    }
    if (!SUFFIX_BLOCKS.has(open.type) || !open.map) {
        return `attributes on ${open.type}`;
    }
    const reads = (literal: string | null): literal is string => {
        const pairs = literal === null ? null : parseAttrsLiteral(literal);
        return pairs !== null && sameAttrs(joinAttrs(pairs), wanted);
    };
    const [start, end] = open.map;
    const last = trimTrailingBlank(lines, start, end) - 1;
    const lastText = lines[last]?.text.trim() ?? '';
    const where = `${open.type.replace(/_open$/, '')} attributes not written where the editor can keep them`;
    switch (open.type) {
        case 'heading_open': {
            const suffix = findAttrsSuffix(lines[start]?.text ?? '');
            return suffix === null ? 'heading attributes that are not written as a trailing {…} on its line' : { attrs: { suffix, placement: 'end' }, endLine: null };
        }
        case 'fence': {
            const literal = findEndLiteral(lines[start]?.text ?? '');
            return reads(literal) ? { attrs: { suffix: literal, placement: 'end' }, endLine: null } : where;
        }
        case 'hr': {
            const literal = findEndLiteral(open.markup);
            return reads(literal) ? { attrs: { suffix: literal, placement: 'end' }, endLine: null } : where;
        }
        case 'paragraph_open': {
            if (last > start && reads(lastText)) {
                return { attrs: { suffix: lastText, placement: 'line' }, endLine: null };
            }
            const literal = findEndLiteral(lines[last]?.text ?? '');
            return reads(literal) ? { attrs: { suffix: literal, placement: 'end' }, endLine: null } : where;
        }
        case 'blockquote_open': {
            // The `{…}` line under the quote's last paragraph (`> {.a}`, or a
            // lazy `{.a}`): the plugin takes it through the soft break before it
            // and gives it to the outermost block the closing tokens after it
            // end — the quote, when that paragraph is its own last block.
            const close = group.end - 1;
            const paragraphClose = close - 1;
            if (tokens[paragraphClose]?.type !== 'paragraph_close' || tokens[paragraphClose].level !== open.level + 1) {
                return where;
            }
            const paragraph = tokens[openingIndex(tokens, paragraphClose)];
            if (!paragraph.map) {
                return where;
            }
            const literalLine = trimTrailingBlank(lines, paragraph.map[0], paragraph.map[1]) - 1;
            const literal = withoutBlockPrefix(lines[literalLine]?.text ?? '').trim();
            return literalLine === last && literalLine > paragraph.map[0] && reads(literal)
                ? { attrs: { suffix: literal, placement: 'line' }, endLine: null }
                : where;
        }
        case 'table_open': {
            // Under the table, or under a blank line after it: the plugin
            // removes the paragraph the literal was, so no token's map holds it.
            const after = lineAfter(lines, last, nextStart);
            if (after !== null && reads(after.text)) {
                return { attrs: { suffix: after.text, placement: after.at > last + 1 ? 'blank' : 'line' }, endLine: after.at + 1 };
            }
            return where;
        }
        default: {
            // A list: the literal under its last line, or under a blank line after it.
            if (last > start && reads(lastText)) {
                return { attrs: { suffix: lastText, placement: 'line' }, endLine: null };
            }
            const after = lineAfter(lines, last, nextStart);
            if (after !== null && after.at > last + 1 && reads(after.text)) {
                return { attrs: { suffix: after.text, placement: 'blank' }, endLine: after.at + 1 };
            }
            return where;
        }
    }
}

/**
 * The literal of every list item in the group that carries one, in token
 * order, or why one cannot be kept. markdown-it-attrs gives a list item the
 * `{…}` at the end of its first paragraph (`- text {.a}`, its "list item end"
 * rule) — at any depth, in a quote or a container too — so that is where it is
 * read, verbatim, and where `serialize.ts` writes it back. A lone `{…}` line
 * closing that paragraph is the list's (`- text` + `{.a}`, `recoverBlockAttrs`),
 * so the item's literal is on the line before it.
 */
function recoverItemLiterals(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[]): string[] | string {
    const out: string[] = [];
    for (let i = group.start; i < group.end; i++) {
        const t = tokens[i];
        const wanted = t.type === 'list_item_open' ? literalAttrs(t) : [];
        if (wanted.length === 0) {
            continue;
        }
        const paragraph = tokens[i + 1];
        if (paragraph?.type !== 'paragraph_open' || !paragraph.map) {
            return 'list item attributes not at the end of its first paragraph';
        }
        // An empty item (`- {.a}`) is written back as it is; a literal after a hard break
        // is the item's too, but the serializer writes no trailing hard break, so the
        // text would change: that item stays a source block.
        const children = (tokens[i + 2]?.children ?? []).filter(c => c.type !== 'text' || c.content !== '');
        if (children.length > 0 && children[children.length - 1].type === 'hardbreak') {
            return 'list item attributes after a line break';
        }
        let line = trimTrailingBlank(lines, paragraph.map[0], paragraph.map[1]) - 1;
        const bare = withoutBlockPrefix(lines[line]?.text ?? '').trim();
        if (line > paragraph.map[0] && parseAttrsLiteral(bare) !== null) {
            line--;
        }
        const literal = findEndLiteral(lines[line]?.text ?? '');
        const pairs = literal === null ? null : parseAttrsLiteral(literal);
        if (literal === null || pairs === null || !sameAttrs(joinAttrs(pairs), wanted)) {
            return 'list item attributes not written where the editor can keep them';
        }
        out.push(literal);
    }
    return out;
}

/**
 * The literal of every attribute span in the group (`[text]{…}`), in the order
 * of their `span_open` tokens, recovered verbatim from the block's lines.
 *
 * Inline tokens carry no line map, so each span is matched to the next `]{…}`
 * in the source whose literal reads as exactly the attributes its token has;
 * a `]{…}` that reads otherwise (inside a code span, say) is passed over. Where
 * no occurrence matches — an entity or a backslash escape markdown-it decoded
 * inside the literal, so the source spells it as the token does not — the
 * span is written in the normalized form `{#id .a .b key="v"}`, which reads as
 * the same attributes: a changed block then shows that form in its diff, and
 * only for that span.
 *
 * A span inside a note may not hold the characters the notes plugin searches
 * the raw source for; such a block stays a source block.
 */
function recoverSpanLiterals(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[], endLine: number): string[] | string {
    const spans: { token: Token; inNote: boolean }[] = [];
    /** The lines of admonition titles: a title is its node's string, and a span in it is no mark (`parse.ts` skips its tokens). */
    const titleLines = new Set<number>();
    for (let i = group.start; i < group.end; i++) {
        if (tokens[i - 1]?.type === 'admonition_title_open') {
            const map = tokens[i].map;
            for (let l = map ? map[0] : 0; map && l < map[1]; l++) {
                titleLines.add(l);
            }
            continue;
        }
        let noteDepth = 0;
        for (const child of tokens[i].type === 'inline' ? tokens[i].children ?? [] : []) {
            if (NOTE_OPEN_TOKENS.has(child.type)) {
                noteDepth++;
            } else if (NOTE_CLOSE_TOKENS.has(child.type)) {
                noteDepth--;
            } else if (child.type === 'span_open') {
                spans.push({ token: child, inNote: noteDepth > 0 });
            }
        }
    }
    if (spans.length === 0 || group.map === null) {
        return [];
    }
    const firstLine = group.map[0];
    const lineRange = Array.from({ length: Math.max(0, endLine - firstLine) }, (_, k) => firstLine + k);
    const src = lineRange.map(l => (titleLines.has(l) ? '' : (lines[l]?.text ?? '')) + (lines[l]?.eol ?? '')).join('');
    const out: string[] = [];
    let from = 0;
    for (const { token, inNote } of spans) {
        const wanted = literalAttrs(token);
        let literal: string | null = null;
        for (let at = src.indexOf(']{', from); at >= 0 && literal === null; at = src.indexOf(']{', at + 1)) {
            const close = findRightDelimiter(src, at + 3);
            const candidate = close < 0 ? null : src.slice(at + 1, close + 1);
            const pairs = candidate === null ? null : parseAttrsLiteral(candidate);
            if (candidate !== null && pairs !== null && sameAttrs(joinAttrs(pairs), wanted)) {
                literal = candidate;
                from = close + 1;
            }
        }
        const written = literal ?? normalizedLiteral(joinAttrs(wanted));
        if (hasInnerBrace(written)) {
            // markdown-it-attrs reads a quoted `}` into the value but cuts the
            // text after the span at the first `}`: what follows it stays in
            // the paragraph as text, and every save would write it again.
            return 'attribute span whose literal holds a quoted }';
        }
        if (inNote && NOTE_SYNTAX_CHARS.test(written)) {
            return 'attribute span in a note whose literal holds a note marker';
        }
        out.push(written);
    }
    return out;
}

function classify(tokens: readonly Token[], group: TokenGroup, lines: readonly SourceLine[], nextStart: number): Classification {
    const first = tokens[group.start];
    const none = { attrs: null, spanLiterals: [], itemLiterals: [], endLine: null };
    if (first.type === 'front_matter') {
        return { kind: 'front_matter', reason: 'front matter', injectedKind: null, mark: null, ...none };
    }
    const mark = injectionMarkOf(first);
    if (mark !== undefined) {
        const injectedKind: InjectedKind = mark.kind === 'expansion' ? 'expansion' : 'atom';
        return { kind: 'injected', reason: `injected by ${mark.rule}`, injectedKind, mark, ...none };
    }
    if (group.map === null) {
        return { kind: 'injected', reason: `${first.type} stands for no source line`, injectedKind: 'generated', mark: null, ...none };
    }
    if (!EDITABLE_TOP_LEVEL_TOKENS.has(first.type)) {
        return raw(first.type);
    }
    const because = notEditableBecause(tokens, group, lines);
    if (because !== null) {
        return raw(because);
    }
    const recovered = recoverBlockAttrs(tokens, group, lines, nextStart);
    if (typeof recovered === 'string') {
        return raw(recovered);
    }
    const itemLiterals = recoverItemLiterals(tokens, group, lines);
    if (typeof itemLiterals === 'string') {
        return raw(itemLiterals);
    }
    // markdown-it-container leaves its closing fence out of the map; it is the
    // container's last line, or the container runs to the end of the file.
    let endLine = recovered.endLine;
    if (first.type === CONTAINER_OPEN && isContainerClose(lines[group.map[1]]?.text, first.markup)) {
        endLine = group.map[1] + 1;
    }
    const spanLiterals = recoverSpanLiterals(tokens, group, lines, Math.max(group.map[1], endLine ?? 0));
    if (typeof spanLiterals === 'string') {
        return raw(spanLiterals);
    }
    if (first.type === 'table_open' && spanLiterals.some(l => /[|`]/.test(l))) {
        // A literal is written as it is, and in a row a `|` is a cell boundary and
        // a backtick opens code: the page could not write the table back
        // (`unwritableInTable`), so it is not drawn as one it can edit.
        return raw('attribute span holding | or a backtick in a table cell');
    }
    return { kind: 'editable', reason: first.type, injectedKind: null, mark: null, attrs: recovered.attrs, spanLiterals, itemLiterals, endLine };
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
    // The first line a later group's tokens claim, for a literal that no map holds.
    const nextStarts: number[] = [];
    let next = lines.length;
    for (let i = groups.length - 1; i >= 0; i--) {
        nextStarts[i] = next;
        const map = groups[i].map;
        if (map !== null) {
            next = Math.min(next, map[0]);
        }
    }
    const classified = groups.map((g, i) => ({ group: g, classification: classify(tokens, g, lines, nextStarts[i]) }));
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
        const e = trimTrailingBlank(lines, s, Math.max(group.map[1], classification.endLine ?? 0));
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
                    attrs: null,
                    spanLiterals: [],
                    itemLiterals: [],
                    endLine: null,
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
        attrs: l.classification.attrs,
        spanLiterals: l.classification.spanLiterals,
        itemLiterals: l.classification.itemLiterals,
    }));
    return { blocks, tail };
}
