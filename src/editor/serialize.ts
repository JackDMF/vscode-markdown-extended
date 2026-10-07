/* eslint-disable @typescript-eslint/naming-convention -- the serializer tables are keyed by the schema's node names, which ProseMirror spells in snake_case */
import { MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown';
import { Mark, Node } from 'prosemirror-model';
import type { Mapping } from 'prosemirror-transform';
import { ALPHANUMERIC, INLINE_MARKERS, KBD_MARKERS, NOTE_SEPARATOR, NOTE_SYNTAX, opensInsideWords, plainWikiEmbed, sidebarCanClose, sidebarCanOpen } from '../syntax/markers';
import { AttrPair, NOTE_SYNTAX_CHARS, fenceHolder, joinAttrs, parseAttrsLiteral, sameAttrs } from './attrs';
import { Token } from '../@types/markdown-it';
import { AttrsCut, attrsCutsIn, attrsGivenTo } from '../plugin/markdownItAttrs';
import { MDTable, TableAlign as MDTableAlign } from '../services/table/mdTable';
import { NOTE_NODES, SOURCE_NODES, TableAlign, editorSchema } from './schema';
import { HOLD_CLOSE, HOLD_OPEN, HOLD_RE, characterCount, wrapInline } from './wrap';
import { MarkdownIt } from '../@types/markdown-it';
import { CHARACTER_REFERENCE } from '../plugin/markdownItSidenote';
import { InlineEngineDefinition, ReadSidebar, attrsEngineFor, currentInlineDefinition, currentInlineEngine, currentReadsWikiEmbeds, readSidebars, setCurrentInlineDefinition, sidebarsIn } from './inlineEngine';

/**
 * Writing the editor's document back to Markdown.
 *
 * A top-level block that still has its `src` is emitted as that slice, byte for
 * byte; so are front matter, raw blocks and an expansion's directive line, which
 * are never re-serialized. Only an editable block whose `src` the fidelity
 * plugin cleared is written by the rules below, and those rules are chosen to be
 * **stable**: serializing a changed block, parsing the result and serializing
 * again yields the same text, so a block saved twice is one diff, not two.
 */

export interface SerializeOptions {
    /**
     * The width a paragraph with no `wrapWidth` of its own is wrapped at: a new
     * one at exactly this, one that was a single line at the larger of this and
     * that line's width (`lineWidth`). The host passes its setting (default 90).
     */
    defaultWrap: number;
}

/** The parts of prosemirror-markdown's state it keeps internal but a wrapping serializer has to read. Stable since 1.0. */
interface StateInternals {
    out: string;
    delim: string;
    inAutolink: boolean | undefined;
    /** Whether the list being written is tight (`renderList`). */
    inTightList: boolean | undefined;
    /** Which form the link being written takes; this module's own field. */
    linkForm?: LinkForm;
    /** Which part of a note is being written, when one is; this module's own field (see `writeNote`). */
    notePart?: NotePart;
    /** The marker character of the note being written (`+`, `!`), when one is; this module's own field. */
    noteMarker?: string;
    /** Whether a table cell is being written (`writeTable`); this module's own field. */
    inTableCell?: boolean;
    /** prosemirror-markdown's own: write the pending block separator, `size` newlines' worth. */
    flushClose(size?: number): void;
}

/**
 * `text` with every marker character that stands in a run of two or more
 * replaced — each run would be the note's closing marker to the plugin's raw
 * search, escaped or not. A single one pairs with nothing: a destination ends
 * at `)`, a title at `"`.
 */
function breakMarkerRuns(text: string, ch: string | undefined, replace: (ch: string) => string): string {
    if (ch === undefined) {
        return text;
    }
    const run = new RegExp(`\\${ch}{2,}`, 'g');
    return text.replace(run, found => Array.from(found, replace).join(''));
}

/**
 * The parts of a note whose text needs more than CommonMark escaping. A
 * reference ends at the first `|`, which `markdownItSidenote.ts` finds in the
 * raw source before any backslash escape is read; a left sidebar ends at the
 * first `$`, a right one at the first `@`, that the inline parser reads as a
 * marker (`sidebarCanClose`), outside code, links and escapes. Those
 * characters are written as numeric character references in their part,
 * which the inline parser of the part turns back into the character, and
 * which no rule reads as a marker. A note ends at its marker pair,
 * which the escape of `ESCAPE_EXTRA` breaks up in text (`\+\+`); in a link's
 * destination and title, which take no backslash escape, a run of the marker
 * character is percent-encoded or a character reference (`breakMarkerRuns`),
 * and a bare or angle link holding it is written inline. Text under the
 * raw marks — code, and the terminator under sup and sub — has no escape at
 * all; the editor refuses to make it (`unwritableInNote`). In a sidebar
 * nothing is refused: the sidebar rule skips a code span whole, and text under
 * superscript and subscript keeps the backslash escape (`\$`), which their
 * plugins unescape and read no character reference in.
 */
export type NotePart = 'ref' | 'body' | 'left' | 'right';

/** Where a wiki embed is written: a table cell, a note's part and the note's marker (`writtenWikiEmbed`; the positions read it too). */
export interface WikiEmbedPlace {
    inTableCell?: boolean;
    notePart?: NotePart;
    noteMarker?: string;
}

/** The character each part must not hold raw, as the escaped form `esc` gives it, and what it is written as instead. */
const PART_TERMINATORS: Readonly<Record<NotePart, { escaped: RegExp; raw: string; entity: string } | null>> = {
    ref: { escaped: /\|/g, raw: '|', entity: '&#124;' },
    body: null,
    left: { escaped: /\\\$/g, raw: '$', entity: '&#36;' },
    right: { escaped: /\\@/g, raw: '@', entity: '&#64;' },
};

function internals(state: MarkdownSerializerState): StateInternals {
    return state as unknown as StateInternals;
}

/**
 * A wiki embed's source as it is written where it stands. It starts from the
 * plain form (`plainWikiEmbed`: the encodings below read back, every other
 * escape kept), and encodes only a character the place reads as its own
 * syntax: in a table cell a `|` no backslash precedes (the table plugin's
 * reading: any backslash before it escapes it) as `\|` and a bare backtick as
 * `&#96;`; in a note's part its terminator (`PART_TERMINATORS`), bare or
 * escaped (the notes plugin finds it in the raw source either way), and a run
 * of the note's marker character as character references. The embed plugin
 * reads its name with escapes and references resolved
 * (`markdownItWikiEmbed.ts`), so each form is the same embed to it and to Foam,
 * and a block read from the file is written back as it was read.
 */
export function writtenWikiEmbed(source: string, place: WikiEmbedPlace): string {
    // A source as characters: an escape pair is one, `\|` stands for `|`.
    const units = plainWikiEmbed(source).match(/\\.|[^]/g) ?? [];
    const charOf = (unit: string) => (unit.length === 2 ? unit[1] : unit);
    const terminator = place.notePart === undefined ? null : PART_TERMINATORS[place.notePart];
    const marker = place.noteMarker;
    const written = units.map((unit, i) => {
        const ch = charOf(unit);
        if (terminator !== null && ch === terminator.raw) {
            return terminator.entity;
        }
        if (marker !== undefined && ch === marker && (charOf(units[i - 1] ?? '') === marker || charOf(units[i + 1] ?? '') === marker)) {
            return MARKER_REFERENCES[ch] ?? unit;
        }
        if (place.inTableCell && unit === '`') {
            return '&#96;';
        }
        return unit;
    }).join('');
    return place.inTableCell ? written.replace(/(?<!\\)\|/g, '\\|') : written;
}

/**
 * Escape a `!` that ends the output, unless a backslash already escapes it,
 * before a `[` that would make it part of the next construct: `![` an image,
 * `![[` a wiki embed. An escaped backslash (`\\!`) leaves the `!` bare, so the
 * backslashes before it are counted.
 */
function escapeTrailingBang(st: StateInternals): void {
    if (!st.out.endsWith('!')) {
        return;
    }
    let backslashes = 0;
    while (st.out.charAt(st.out.length - 2 - backslashes) === '\\') {
        backslashes++;
    }
    if (backslashes % 2 === 0) {
        st.out = st.out.slice(0, -1) + '\\!';
    }
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * What prosemirror-markdown's CommonMark escaping does not cover and this
 * engine would otherwise read as syntax: an HTML tag or entity (`html: true`),
 * `==mark==`, `^sup^`, `++sidenote++`, `!!marginal note!!`, the sidebars'
 * `$`/`@` (every one, although the sidebar rule reads only those its
 * flanking allows as markers: `sidebarCanOpen`, `sidebarCanClose`) and an emoji
 * shortcode. Each gets a CommonMark backslash escape, which every rule
 * respects because the escape is consumed before they see the character.
 */
const ESCAPE_EXTRA = /<(?=[A-Za-z/!?])|&(?=#?[0-9A-Za-z]+;)|=(?==)|(?<==)=|\+(?=\+)|(?<=\+)\+|!(?=!)|(?<=!)!|[$@^]|:(?=[A-Za-z_+-][\w+-]*:)/g;

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

type LinkForm = 'bare' | 'angle' | 'inline';

/** The range of sibling indices `[from, to)` a mark covers continuously around `index`. */
function markSpan(mark: Mark, parent: Node, index: number): [number, number] {
    let from = index;
    while (from > 0 && mark.isInSet(parent.child(from - 1).marks)) {
        from--;
    }
    let to = index + 1;
    while (to < parent.childCount && mark.isInSet(parent.child(to).marks)) {
        to++;
    }
    return [from, to];
}

/**
 * Whether the text node at `index` touches the span with a letter or digit. A
 * neighbour carrying the same kind of mark (the other delimiter style) is
 * separated from the span by its own delimiter, so it does not count.
 */
function gluedAt(mark: Mark, parent: Node, index: number, side: 'before' | 'after'): boolean {
    if (index < 0 || index >= parent.childCount) {
        return false;
    }
    const node = parent.child(index);
    if (!node.isText || node.marks.some(m => m.type === mark.type)) {
        return false;
    }
    const ch = side === 'before' ? (node.text ?? '').slice(-1) : (node.text ?? '').slice(0, 1);
    return ALPHANUMERIC.test(ch);
}

/**
 * `*`/`**` unless the source wrote `_`/`__` (`markdown-it-ib` renders the two
 * differently, so the delimiter is content). `_` cannot open or close inside a
 * word, so an edit that glued the span to a letter falls back to `*` — for both
 * ends, decided over the whole span, so they always match.
 */
function emphasisDelimiter(mark: Mark, parent: Node, index: number, opening: boolean, star: string): string {
    const markup = String(mark.attrs.markup || star);
    if (opensInsideWords(markup)) {
        return star;
    }
    const at = opening ? index : Math.max(0, index - 1);
    const [from, to] = markSpan(mark, parent, Math.min(at, parent.childCount - 1));
    const glued = gluedAt(mark, parent, from - 1, 'before') || gluedAt(mark, parent, to, 'after');
    // linkify takes a trailing `_` into a URL (`https://x/a_`), never a `*`.
    const last = parent.child(to - 1);
    const endsInUrl = last.isText && /(?:[A-Za-z][\w+.-]*:\/\/|www\.)\S*$|[^\s@]+@[^\s@]+$/.test(last.text ?? '');
    return glued || endsInUrl ? star : markup;
}

/** The destination as markdown-it read it, with non-ASCII percent escapes (which it added) decoded back to what the author wrote. */
function destination(href: string, part?: NotePart, noteMarker?: string, inTableCell = false): string {
    const decoded = href.replace(/(?:%[89A-Fa-f][0-9A-Fa-f])+/g, seq => {
        try {
            return decodeURIComponent(seq);
        } catch {
            return seq;
        }
    });
    // A space or control character ends a destination; markdown-it never
    // produces one, but a link the UI set can hold one.
    const written = decoded
        .replace(/[\x00-\x20\x7f]/g, percent)
        .replace(/[()]/g, '\\$&');
    // Inside a note part its terminator, and a run of the note's marker
    // character (`C++`), are percent-encoded: a URL takes no character reference.
    const terminator = part === undefined ? null : PART_TERMINATORS[part];
    const safe = terminator === null ? written : written.split(terminator.raw).join(percent(terminator.raw));
    // In a table cell a `|` is a cell boundary and a backtick opens code for
    // the table plugin's row scan, backslash or not; a URL takes neither raw.
    return breakMarkerRuns(inTableCell ? safe.replace(/[|`]/g, percent) : safe, noteMarker, percent);
}

/** A link's or image's `(destination "title")` content, as a note part and a table cell can hold it. */
function target(st: StateInternals, href: string, title: string | null): string {
    // A backtick in a title would open code for the table plugin's row scan; the title takes an escape.
    // In a table cell a `|` in a title is a boundary to the row scan, and it takes an escape.
    const titleText = st.inTableCell && title ? title.replace(/[`|]/g, '\\$&') : title;
    const titled = breakMarkerRuns(partText(st.notePart, titlePart(titleText)), st.noteMarker, ch => MARKER_REFERENCES[ch] ?? ch);
    return destination(href, st.notePart, st.noteMarker, st.inTableCell) + titled;
}

function percent(ch: string): string {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Text as a note part can hold it: its terminator as a character reference
 * (`PART_TERMINATORS`) — the backslash escape `esc` wrote for it, or the raw
 * character where nothing escaped it (a link title).
 */
function partText(part: NotePart | undefined, escaped: string): string {
    const terminator = part === undefined ? null : PART_TERMINATORS[part];
    return terminator === null ? escaped : escaped.replace(terminator.escaped, terminator.entity).split(terminator.raw).join(terminator.entity);
}

function titlePart(title: string | null): string {
    return title ? ` "${title.replace(/"/g, '\\"')}"` : '';
}

/**
 * How a link is written: a bare URL stays bare and an `<…>` autolink stays one,
 * as long as the link is still one unmarked text node that can be written that
 * way; otherwise `[text](destination)`.
 */
function linkForm(state: MarkdownSerializerState, mark: Mark, parent: Node, index: number): LinkForm {
    const node = parent.child(index);
    const markup = mark.attrs.markup as string | null;
    const { notePart: part, noteMarker, inTableCell } = internals(state);
    // Bare and angle forms are written unescaped, which a note part cannot
    // take when the URL holds its terminator or the note's marker character,
    // nor a table cell when it holds a `|` or a backtick.
    const spelled = (node.text ?? '') + (mark.attrs.href as string);
    if (markup === null || !node.isText || mark.attrs.title || (part !== undefined && PART_TERMINATORS[part] !== null)
        || (noteMarker !== undefined && spelled.includes(noteMarker)) || (inTableCell && /[|`]/.test(spelled))) {
        return 'inline';
    }
    if (node.marks[node.marks.length - 1] !== mark) {
        return 'inline';
    }
    if (index + 1 < parent.childCount && mark.isInSet(parent.child(index + 1).marks)) {
        return 'inline';
    }
    const text = node.text ?? '';
    const href = mark.attrs.href as string;
    if (markup === 'linkify' && text !== '' && !/\s/.test(text)) {
        return 'bare';
    }
    if (markup === 'autolink' && (text === href || `mailto:${text}` === href) && !/[\s<>]/.test(text)) {
        return 'angle';
    }
    return 'inline';
}

function backtickFence(text: string): { open: string; close: string } {
    let longest = 0;
    for (const run of text.match(/`+/g) ?? []) {
        longest = Math.max(longest, run.length);
    }
    const ticks = '`'.repeat(longest + 1);
    // CommonMark strips one space from each side when both are there; pad so
    // the content survives, and so a backtick at an edge is not read as fence.
    const pad = text.startsWith('`') || text.endsWith('`')
        || (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '') ? ' ' : '';
    return { open: ticks + pad, close: pad + ticks };
}

const marks: ConstructorParameters<typeof MarkdownSerializer>[1] = {
    // The decoration is Req Explorer's wrapper; only the text it wraps is in the file.
    req_ref: { open: '', close: '', mixable: true },
    // `[text]{literal}`, the literal as it was read (`blocks.ts`). No line break
    // may fall between `]` and `{`, nor inside the literal: they are held.
    // Mixable, as a link is: a span in a link's text and a link in a span's are
    // written nested (`[see [term]{.x}](url)`), not as the one closed to open the other.
    attr_span: {
        // prosemirror-markdown escapes a `!` before a `[` only when no
        // backslash precedes it; an escaped backslash leaves the `!` bare.
        open(state) {
            escapeTrailingBang(internals(state));
            return '[';
        },
        close: (_state, mark) => HOLD_OPEN + ']' + (mark.attrs.literal as string) + HOLD_CLOSE,
        mixable: true,
    },
    em: {
        open: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, true, '*'),
        close: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, false, '*'),
        mixable: true,
        expelEnclosingWhitespace: true,
    },
    strong: {
        open: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, true, '**'),
        close: (_state, mark, parent, index) => emphasisDelimiter(mark, parent, index, false, '**'),
        mixable: true,
        expelEnclosingWhitespace: true,
    },
    link: {
        open(state, mark, parent, index) {
            const form = linkForm(state, mark, parent, index);
            const st = internals(state);
            st.linkForm = form;
            if (form === 'inline') {
                // The whole link is one run: the corpus keeps a link on one line,
                // and one that cannot fit is no evidence of the paragraph's width
                // (`measureWrapWidth` holds it the same way). With the hold marker
                // first, prosemirror-markdown no longer sees the `[` after a `!`
                // that would make it an image, so that `!` is escaped here.
                escapeTrailingBang(st);
                return HOLD_OPEN + '[';
            }
            // Written unescaped: a backslash inside a URL is part of the URL.
            st.inAutolink = true;
            return form === 'angle' ? HOLD_OPEN + '<' : HOLD_OPEN;
        },
        close(state, mark) {
            const st = internals(state);
            const form = st.linkForm ?? 'inline';
            st.linkForm = undefined;
            st.inAutolink = undefined;
            if (form === 'bare') {
                return HOLD_CLOSE;
            }
            if (form === 'angle') {
                return '>' + HOLD_CLOSE;
            }
            return '](' + target(st, mark.attrs.href as string, mark.attrs.title as string | null) + ')' + HOLD_CLOSE;
        },
        mixable: true,
    },
    // Delimiter runs like emphasis, with the same flanking rules.
    strike: { open: INLINE_MARKERS.strikethrough, close: INLINE_MARKERS.strikethrough, mixable: true, expelEnclosingWhitespace: true },
    mark: { open: INLINE_MARKERS.mark, close: INLINE_MARKERS.mark, mixable: true, expelEnclosingWhitespace: true },
    // No line break inside any of these three (the plugins refuse one), so
    // each is a held run the wrapper keeps on one line, as a code span is.
    // Mixable, so emphasis inside a key is written inside it (`[[a *b*]]`),
    // not as a second key inside the emphasis.
    // A key right after a `!` would be read as a wiki embed's `![[…]]`
    // where the engine reads embeds (`InlineEngineDefinition.wikiEmbeds`), so
    // there that `!` is escaped, as a link's is.
    kbd: {
        open(state) {
            if (currentReadsWikiEmbeds()) {
                escapeTrailingBang(internals(state));
            }
            return HOLD_OPEN + KBD_MARKERS.open;
        },
        close: KBD_MARKERS.close + HOLD_CLOSE,
        mixable: true,
    },
    sup: { open: HOLD_OPEN + INLINE_MARKERS.superscript, close: INLINE_MARKERS.superscript + HOLD_CLOSE },
    sub: { open: HOLD_OPEN + INLINE_MARKERS.subscript, close: INLINE_MARKERS.subscript + HOLD_CLOSE },
    code: {
        open: (_state, _mark, parent, index) => HOLD_OPEN + backtickFence(parent.child(index).text ?? '').open,
        close: (_state, _mark, parent, index) => backtickFence(parent.child(index - 1).text ?? '').close + HOLD_CLOSE,
        escape: false,
    },
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

type NodeSerializers = ConstructorParameters<typeof MarkdownSerializer>[0];

/** The inline node serializers, shared by the block serializer and the inline-only one. */
const inlineNodes: NodeSerializers = {
    text(state, node) {
        const text = (node.text ?? '').replace(HOLD_RE, '');
        const st = internals(state);
        if (st.notePart === undefined || st.inAutolink) {
            state.text(text, !st.inAutolink);
            return;
        }
        // Superscript and subscript in a sidebar keep the backslash escape:
        // their plugins read no character reference, the sidebar rule reads
        // an escaped marker as no end, and the plugins unescape it.
        const sidebarRaw = (st.notePart === 'left' || st.notePart === 'right') && node.marks.some(m => m.type.name === 'sup' || m.type.name === 'sub');
        // Never at a line start: the note's opening marker is before it.
        state.text(sidebarRaw ? state.esc(text, false) : partText(st.notePart, state.esc(text, false)), false);
    },
    wiki_embed(state, node) {
        const st = internals(state);
        // A `!` before it would pair with the embed's own: escaped, or in a
        // marginal note (which finds `!!` in the raw source) a reference.
        if (st.noteMarker === '!') {
            referenceMarkerAt(st, st.out.length - 1, '!', 0);
        } else {
            escapeTrailingBang(st);
        }
        // Its source, as it was written, held on one line (`writtenWikiEmbed`).
        state.text(HOLD_OPEN + writtenWikiEmbed(node.attrs.source as string, st) + HOLD_CLOSE, false);
    },
    image(state, node) {
        const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
        const st = internals(state);
        state.write(HOLD_OPEN + '![' + partText(st.notePart, state.esc(alt ?? '')) + '](' + target(st, src, title) + ')' + HOLD_CLOSE);
    },
    hard_break(state, node, parent, index) {
        // As prosemirror-markdown does: a trailing hard break has no line to break to.
        for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
                state.write('\\\n');
                return;
            }
        }
    },
    // The badge is Req Explorer's; the file holds nothing for it.
    inline_atom() { /* writes nothing */ },
    sidenote(state, node) {
        writeNote(state, node, NOTE_SYNTAX.sidenote.marker);
    },
    marginal_note(state, node) {
        writeNote(state, node, NOTE_SYNTAX.marginalNote.marker);
    },
    left_sidebar(state, node) {
        writeSidebar(state, node, NOTE_SYNTAX.leftSidebar.marker, 'left');
    },
    right_sidebar(state, node) {
        writeSidebar(state, node, NOTE_SYNTAX.rightSidebar.marker, 'right');
    },
};

// ---------------------------------------------------------------------------
// Notes and sidebars
// ---------------------------------------------------------------------------

/**
 * The character reference a note's marker character is written as where it
 * would touch the closing marker. The plugin finds that marker by searching
 * the raw source for the pair (`++`, `!!`), so a body ending in `+` closes the
 * note one character early — escaped with a backslash as much as without.
 */
const MARKER_REFERENCES: Readonly<Record<string, string>> = { '+': '&#43;', '!': '&#33;' };

/**
 * Written right after a marker. prosemirror-markdown escapes a `!` that ends
 * the output when a `[` follows (`![` would be an image), which turns the
 * second `!` of `!!` into `\!`; an empty held run ends the output instead,
 * and the wrapper strips it with the other hold markers.
 */
const MARKER_GUARD = HOLD_OPEN + HOLD_CLOSE;

/**
 * The marks whose text is written as it is: a code span unescaped, `^sup^` and
 * `~sub~` as plain text their plugins read with backslash escapes only (no
 * character references).
 */
export const RAW_TEXT_MARKS: ReadonlySet<string> = new Set(['code', 'sup', 'sub']);

/** The terminator a reference must not hold under a raw mark (`PART_TERMINATORS`): the plugin finds it in the raw source. */
const REFERENCE_TERMINATOR = PART_TERMINATORS.ref?.raw ?? '|';

/** Why `note` cannot be written so that it reads back as itself, or `null`. */
function noteUnwritable(note: Node): string | null {
    if (note.marks.some(m => RAW_TEXT_MARKS.has(m.type.name))) {
        return 'Superscript, subscript and inline code cannot hold a note: their text is written as it is, and the note would not survive a save.';
    }
    const name = note.type.name;
    const marker = name === 'sidenote' ? NOTE_SYNTAX.sidenote.marker : name === 'marginal_note' ? NOTE_SYNTAX.marginalNote.marker : null;
    const parts: Node[] = [];
    note.forEach(child => {
        parts.push(child);
    });
    // A part holds no note or sidebar (`note_inline`), so its text is all there is to check.
    for (const part of marker === null ? [note] : parts) {
        // Only a reference's `|` is found in the raw source. A sidebar's end
        // is found by the inline parser, which skips a code span whole and
        // reads the backslash escape superscript and subscript keep there.
        const terminator = part.type.name === 'note_ref' ? REFERENCE_TERMINATOR : undefined;
        let reason: string | null = null;
        part.forEach(child => {
            if (reason !== null || !child.isText) {
                return;
            }
            const text = child.text ?? '';
            const code = child.marks.some(m => m.type.name === 'code');
            const raw = child.marks.some(m => RAW_TEXT_MARKS.has(m.type.name));
            const span = child.marks.find(m => m.type.name === 'attr_span' && NOTE_SYNTAX_CHARS.test(m.attrs.literal as string));
            if (span !== undefined) {
                reason = `An attribute span in a note cannot hold ${span.attrs.literal as string}: its literal is written as it is, and the notes plugin would read a marker in it.`;
            } else if (raw && terminator !== undefined && text.includes(terminator)) {
                reason = `Inline code, superscript and subscript in this part of a note cannot hold "${terminator}": the notes plugin reads it as the part's end, and nothing escapes it there.`;
            } else if (code && marker !== null && text.includes(marker)) {
                reason = `Inline code in a note cannot hold "${marker}": the notes plugin reads it as the note's end, and nothing escapes it there.`;
            }
        });
        if (reason !== null) {
            return reason;
        }
    }
    return null;
}

/**
 * Why a wiki embed between `from` and `to` cannot be written so that it reads
 * back as itself, or `null`: one under inline code, superscript or subscript
 * (`RAW_TEXT_MARKS`), whose text is read as it is, so the embed would be text
 * after a save. The editor refuses the edit that makes it (`webview/notes.ts`).
 */
export function unwritableEmbed(doc: Node, from = 0, to = doc.content.size): string | null {
    let reason: string | null = null;
    const start = Math.max(0, Math.min(from, to));
    const end = Math.min(doc.content.size, Math.max(from, to));
    doc.nodesBetween(start, end, node => {
        if (reason === null && node.type.name === 'wiki_embed' && node.marks.some(m => RAW_TEXT_MARKS.has(m.type.name))) {
            reason = 'A wiki embed cannot be inline code, superscript or subscript: their text is written as it is, and the embed would be plain text after a save.';
        }
        return reason === null;
    });
    return reason;
}

/**
 * Why a note or sidebar between `from` and `to` cannot be written so that it
 * reads back as itself, or `null` — the one thing the serializer cannot do,
 * so the editor refuses the edit that would make it (`webview/notes.ts`)
 * rather than save a document the next parse restructures: a raw mark over a
 * note, text under a raw mark that holds a reference's `|` or the note's
 * marker pair, or a block the save would write so that it does not read back
 * as it is shown (`unitRefusal`).
 *
 * Nothing about what the parser reads is modelled; the save's own text is
 * read. Each top-level block the save will write again — with the edit's
 * `origin` exactly those it then writes by rule (`rewritten`: a list, a quote
 * or a table is written whole, the items and cells the edit did not touch
 * included, and a block it keeps, a copy of one whose literal and ids it keeps
 * included, is written as it was read; `doc` is then the document as the save
 * writes it); without it every one the range touches — is written by the
 * save's own writer, wrap included, in the parts the parser reads apart
 * (`unitsOf`: a list's items, a table's rows, a quote's, a container's and an
 * admonition's blocks), and each part is parsed by the
 * page's engine, built from the host's definition (`setInlineEngine`), whole
 * — block rules, inline rules, markdown-it-attrs, VS Code's math as its
 * stand-in. What comes back must be what the page shows (`unitVerdict`):
 * every sidebar it holds, and every attribute literal — the block's, an
 * item's, a heading's, a span's — as the attributes it gives, and nothing
 * else read as either. So **a document the parser produced is always
 * writable** wherever the editor writes it as it was read; where the editor
 * writes it otherwise — a character reference written as its character, a
 * line the wrap breaks before a `{…}` — the parse sees the outcome, and the
 * edit is refused with its cause (`origin`, the edit's starting document).
 * Every refusal the editor asks — the notes filter, the toolbar's disabled
 * buttons, the object bar's verbs — goes through here with the transaction's
 * origin (`noteRefusal`).
 */
export function unwritableInNote(doc: Node, from = 0, to = doc.content.size, origin?: EditOrigin): string | null {
    let reason: string | null = null;
    const start = Math.max(0, Math.min(from, to));
    const end = Math.min(doc.content.size, Math.max(from, to));
    doc.nodesBetween(start, end, node => {
        if (reason !== null) {
            return false;
        }
        if (NOTE_NODES.has(node.type.name)) {
            reason = noteUnwritable(node);
            return false;
        }
        return true;
    });
    if (reason !== null) {
        return reason;
    }
    // With the edit's origin, what is checked is exactly what the save writes again: every part of each
    // block it rewrites, the edit's neighbours too, and none of a block it keeps — a copy of a whole block
    // is the same node, written from its `src` as it was read unless its literal or id is stripped.
    const blocks: { node: Node; offset: number; copyOf?: number | null }[] = [];
    if (origin?.rewritten !== undefined) {
        blocks.push(...origin.rewritten);
    } else {
        doc.forEach((node, offset) => {
            if (offset + node.nodeSize > start && offset <= end) {
                blocks.push({ node, offset });
            }
        });
    }
    // Whether `[from, to)` lies outside the edit's range: only written again beside it.
    const outside = (from: number, to: number) => to <= start || from >= Math.max(end, start + 1);
    for (const block of blocks) {
        for (const [index, unit] of unitsOf(block.node).entries()) {
            if (origin?.rewritten === undefined && outside(block.offset + unit.from, block.offset + unit.to)) {
                continue;
            }
            const verdict = unitVerdict(unit);
            if (verdict !== null) {
                const failed = verdict.lost?.at ?? verdict.mismatch?.at;
                const textblock = unit.textblocks.find(t => t.node === failed);
                const beside = textblock === undefined
                    ? outside(block.offset + unit.from, block.offset + unit.to)
                    : outside(block.offset + textblock.pos, block.offset + textblock.pos + textblock.node.nodeSize);
                return unitRefusal(block, unit, index, verdict, beside, origin);
            }
        }
    }
    return null;
}

/** A part's inline content, written by the same rules as a paragraph's, with the part's own terminator (`PART_TERMINATORS`). */
function renderPart(state: MarkdownSerializerState, parent: Node, part: NotePart): void {
    const st = internals(state);
    const outer = st.notePart;
    st.notePart = part;
    try {
        state.renderInline(parent, false);
    } finally {
        st.notePart = outer;
    }
}

/** The plugin refuses a reference with no text (`++ |note++` is prose); an image or a wiki embed counts, as its source is not blank. */
function writableReference(ref: Node): boolean {
    let writable = ref.textContent.trim() !== '';
    ref.forEach(child => {
        writable = writable || child.type.name === 'image' || child.type.name === 'wiki_embed';
    });
    return writable;
}

/** Replace the marker character at `at` in the output — and the backslash escaping it, if one does — by its character reference. */
function referenceMarkerAt(st: StateInternals, at: number, ch: string, from: number): void {
    if (at < from || st.out.charAt(at) !== ch) {
        return;
    }
    let backslashes = 0;
    while (at - 1 - backslashes >= from && st.out.charAt(at - 1 - backslashes) === '\\') {
        backslashes++;
    }
    const start = at - (backslashes % 2);
    st.out = st.out.slice(0, start) + MARKER_REFERENCES[ch] + st.out.slice(at + 1);
}

/**
 * `++reference|note++` or `!!reference|note!!`. The reference and the body are
 * written by the paragraph's rules, each as a part (`renderPart`); a reference
 * with nothing the plugin would accept is written as `&nbsp;`, so the note
 * stays a note. A marker character right before the note, at the start of the
 * reference (where `!!!` could open an admonition) or at the end of the body
 * (where it would pair with the closing marker) is written as a character
 * reference.
 */
function writeNote(state: MarkdownSerializerState, node: Node, marker: string): void {
    const st = internals(state);
    const ch = marker.charAt(0);
    // Text ending in the marker character would open the note one character early (`Wow!!!a|b!!`).
    state.write();
    referenceMarkerAt(st, st.out.length - 1, ch, 0);
    state.text(marker + MARKER_GUARD, false);
    const refStart = st.out.length;
    const outerMarker = st.noteMarker;
    st.noteMarker = ch;
    try {
        if (writableReference(node.child(0))) {
            renderPart(state, node.child(0), 'ref');
        } else {
            state.text('&nbsp;', false);
        }
        referenceMarkerAt(st, refStart, ch, refStart);
        state.text(NOTE_SEPARATOR, false);
        const bodyStart = st.out.length;
        renderPart(state, node.child(1), 'body');
        referenceMarkerAt(st, st.out.length - 1, ch, bodyStart);
    } finally {
        st.noteMarker = outerMarker;
    }
    state.text(marker + MARKER_GUARD, false);
}

/**
 * `$body$` or `@body@`: the body a part whose marker is a character reference
 * inside it. The spaces the corpus writes inside the markers (`$ … $`) are the
 * body's own text and are written as they are read, so `$x$` stays `$x$`.
 */
function writeSidebar(state: MarkdownSerializerState, node: Node, marker: string, part: NotePart): void {
    const st = internals(state);
    state.write();
    const open = st.out.length;
    state.text(marker, false);
    renderPart(state, node, part);
    state.text(marker, false);
    seamCollector?.push({ node, open, close: st.out.length });
}

/** Where a sidebar's markers stand in the output being written: before the opening one, after the closing one. */
interface SidebarSeam {
    node: Node;
    open: number;
    close: number;
}

/**
 * Where an edit started: the document a transaction was applied to and how it
 * moved positions (`Transaction.before`, `Transaction.mapping`), so that a
 * refusal can say whether the edit or the file's own spelling is the cause
 * (`unwritableInNote`).
 */
export interface EditOrigin {
    doc: Node;
    mapping: Mapping;
    /**
     * The top-level blocks of the edited document the save writes by rule,
     * with their offsets (`FidelityPlan.rewritten` in `fidelity.ts`, the plan
     * that clears their `src`): exactly their textblocks are checked, the ones
     * outside the edit's range included and none of a block the save keeps.
     * For a copy of a whole block, `copyOf` is that block's offset in `doc`,
     * whose textblocks the copy's were read as.
     */
    rewritten?: readonly { node: Node; offset: number; copyOf?: number | null }[];
    /**
     * The text the textblock at a position of `doc` was read from
     * (`textblockSource` in `positions.ts`), or `null` where it is no longer
     * known: whether that text spells a character as a reference decides
     * which cause a refusal names.
     */
    sourceOf?: (pos: number) => string | null;
}

/** Where each sidebar's markers stand while `writtenTextblock` writes a textblock. */
let seamCollector: SidebarSeam[] | null = null;

/** Why a sidebar right after a letter or digit is not made. */
export const SIDEBAR_GLUED_BEFORE = 'A sidebar right after a letter or digit would not be read as a sidebar: put a space before it.';
/** Why a left sidebar right before a digit is not made. */
export const SIDEBAR_GLUED_AFTER = 'A left sidebar right before a digit would not be read as a sidebar: put a space after it.';
/** Why a sidebar right after a URL is not made. */
export const SIDEBAR_GLUED_URL = 'A sidebar right after a web address would be read as part of the address: put a space before it.';
/** Why an edit is refused in a line whose character reference, written as its character, changes what is a sidebar. */
export const SIDEBAR_REWRITTEN_REFERENCE = 'This line spells a character as a character reference (&#…;), which the editor writes as the character itself, and saved that way a sidebar here would not read back as it is shown: edit the line once in the text editor to unlock it.';
/** Why an edit is refused in a line the editor would write so that a sidebar does not read back, for another reason than a character reference. */
export const SIDEBAR_REWRITTEN = 'Written by the editor, this line would not read a sidebar back as it is shown, edited or not: edit the line once in the text editor to unlock it.';
/** Why a sidebar is not made that would not read back, for none of the reasons above. */
export const SIDEBAR_NOT_READ = 'After this edit a sidebar here would not be read back as a sidebar.';
/** Why an edit is refused after which text would read as a sidebar the editor does not show. */
export const SIDEBAR_MADE = 'After this edit text here would be read as a sidebar, which the editor does not show (a $…$ or @…@ in a web address, say).';
/** Why an edit is refused after which VS Code's math would read text here as a formula, which the editor does not show. */
export const MATH_MADE = 'After this edit VS Code\'s math would read text here as a formula ($…$), which the editor does not show (a $…$ a web address no longer holds, say).';
/** Why a left sidebar is not made, nor an edit applied that leaves one, that VS Code's math would read as math (`InlineEngineDefinition.math`). */
export const SIDEBAR_LEFT_MATH = 'Left sidebars need markdown.math.enabled off: math reads $…$.';

/** What a block is called in a refusal that names it. */
const BLOCK_NOUNS: Readonly<Record<string, string>> = {
    bullet_list: 'list',
    ordered_list: 'list',
    blockquote: 'quote',
    table: 'table',
    container: 'container',
    admonition: 'admonition',
};

/**
 * Why an edit is refused that makes the save write the whole `block` again
 * (a list, a quote, a table: `EditOrigin.rewritten`) while another of its
 * textblocks, `textblock`, written by the editor, would not read a sidebar
 * back as it is shown — the file's spelling of that one, which the edit does
 * not touch: with `reference`, a character reference the editor writes as
 * the character.
 */
export function sidebarRewrittenBeside(block: Node, textblock: Node, reference: boolean): string {
    const whole = BLOCK_NOUNS[block.type.name] ?? 'block';
    const part = textblock.type.name === 'table_cell' || textblock.type.name === 'table_header' ? 'cell' : textblock.type.name === 'heading' ? 'heading' : 'paragraph';
    const cause = reference ? `: that ${part} spells a character as a character reference (&#…;), which the editor writes as the character itself` : '';
    return `This edit makes the editor write the whole ${whole} again, and another ${part} of it would then not read a sidebar back as it is shown${cause}. Edit that ${part} once in the text editor to unlock this ${whole}.`;
}

/** The sidebars the engine read in a text, by the text: a textblock is parsed once however often it is asked about. */
const readCache = new Map<string, ReadSidebar[]>();
/** How many texts `readCache` keeps; the oldest is dropped first. */
const READ_CACHE_SIZE = 512;
/**
 * Read textblocks with the engine `definition` describes — the host's, posted
 * with each document (`inlineEngineDefinition`): its linkify and typographer
 * settings, the registry's plugins the page runs, whether VS Code's math
 * claims `$`, whether it reads wiki embeds and whether it reads attributes.
 * The literals the page writes are read back with it too (`attrs.ts`,
 * `readUnit`): the engine is one, `currentInlineEngine`, and `attrsEngineFor`
 * is it with markdown-it-attrs where the definition's `attrs` says the host
 * runs it, and it alone where not. The save and the check of an edit write by
 * it alike: whether a `!` before a key is escaped is its `wikiEmbeds`, read
 * where the key is written, and whether a `{…}` is escaped or a literal line
 * kept apart from the next block is its `attrs`.
 */
export function setInlineEngine(definition: InlineEngineDefinition): void {
    if (!setCurrentInlineDefinition(definition)) {
        return;
    }
    readCache.clear();
    escapeCache.clear();
    cellCache = new WeakMap();
    writtenCache = new WeakMap();
    forgetReadBack();
}

function engine(): MarkdownIt {
    return currentInlineEngine();
}

/** The sidebars the page's engine reads in `text` (`readSidebars`), remembered by the text. */
function sidebarsRead(text: string): ReadSidebar[] {
    let read = readCache.get(text);
    if (read === undefined) {
        read = readSidebars(engine(), text);
        if (readCache.size >= READ_CACHE_SIZE) {
            readCache.delete(readCache.keys().next().value as string);
        }
    } else {
        readCache.delete(text);
    }
    readCache.set(text, read);
    return read;
}

/** The sidebars the page's engine reads in `text` with linkify off: whether a URL is what took one (`lostReason`). */
function sidebarsReadWithoutLinkify(text: string): ReadSidebar[] {
    const md = engine() as MarkdownIt & { set(options: { linkify: boolean }): void };
    md.set({ linkify: false });
    try {
        return readSidebars(md, text);
    } finally {
        md.set({ linkify: currentInlineDefinition().linkify });
    }
}

/** The inline rules of VS Code's math, as the page's engine runs them (`useMathStandIn`). */
const MATH_RULES = ['math_inline', 'math_inline_block'];

/** The sidebars the page's engine reads in `text` without VS Code's math: whether math is what took one (`lostReason`). */
function sidebarsReadWithoutMath(text: string): ReadSidebar[] {
    const md = engine();
    md.inline.ruler.disable(MATH_RULES);
    try {
        return readSidebars(md, text);
    } finally {
        md.inline.ruler.enable(MATH_RULES);
    }
}

/** The textblocks whose inline content the parser reads, where a sidebar can stand or be read. */
const INLINE_TEXTBLOCKS: ReadonlySet<string> = new Set(['paragraph', 'heading', 'table_cell', 'table_header']);

/**
 * A textblock's inline content as the save writes it, unwrapped and with the
 * wrapper's hold markers taken out, and where each sidebar it holds stands in
 * that text: its kind, its opening marker and its closing marker. A paragraph
 * is written in the line-start form, as `blockSerializer` writes it
 * (`paragraphMarkdown`); a heading and a table cell by the save's own writers,
 * `headingText` and `cellText`, which carry each marker's place through their
 * last touches (`Spelled`). What the read-back compares a sidebar's text by
 * (`sidebarVerdict`) and a refusal says what stands beside a marker by
 * (`lostReason`); what is parsed is the save's own text (`unitsOf`).
 */
function writtenTextblock(textblock: Node): { text: string; sidebars: ReadSidebar[] } {
    const seams: SidebarSeam[] = [];
    const name = textblock.type.name;
    let inline: string;
    seamCollector = seams;
    try {
        inline = name === 'heading' ? inlineMarkdown(textblock, false) : name === 'paragraph' ? paragraphMarkdown(textblock) : cellMarkdown(textblock);
    } finally {
        seamCollector = null;
    }
    const spelled: Spelled = { text: inline, at: seams.flatMap(seam => [seam.open, seam.close - 1]) };
    let written: Spelled;
    if (name === 'heading') {
        written = headingText(textblock, spelled);
    } else if (name === 'paragraph') {
        written = respelled(spelled, HOLD_RE, () => '');
    } else {
        written = cellText(textblock, spelled);
    }
    return { text: written.text, sidebars: seams.map((seam, i) => ({ kind: seam.node.type.name, open: written.at[2 * i], close: written.at[2 * i + 1] })) };
}

/**
 * Text being written, and places in it that a check follows through the
 * writer's last touches (`respelled`): where each sidebar's markers stand, in
 * `writtenTextblock`; none when the save writes the same text.
 */
interface Spelled {
    text: string;
    at: number[];
}

/**
 * `spelled` with every match of the global `pattern` replaced, and each place
 * moved by what the replacements before it added or took away; a place inside
 * a match moves to where its replacement starts.
 */
function respelled(spelled: Spelled, pattern: RegExp, replace: (match: string) => string): Spelled {
    const moves: { start: number; end: number; before: number; after: number }[] = [];
    let text = '';
    let last = 0;
    let shift = 0;
    for (const match of spelled.text.matchAll(pattern)) {
        const start = match.index ?? 0;
        const replacement = replace(match[0]);
        text += spelled.text.slice(last, start) + replacement;
        last = start + match[0].length;
        moves.push({ start, end: last, before: shift, after: shift + replacement.length - match[0].length });
        shift += replacement.length - match[0].length;
    }
    text += spelled.text.slice(last);
    const at = spelled.at.map(place => {
        let moved = place;
        for (const move of moves) {
            if (place < move.start) {
                break;
            }
            moved = place < move.end ? move.start + move.before : place + move.after;
        }
        return moved;
    });
    return { text, at };
}

/** A `#` run ending a heading's text, which its line would read as a closing sequence. */
const CLOSING_HASHES = /#+$/g;

/**
 * A heading's text as its line writes it after the `#`s and the space: its
 * requirement id's prefix, then its inline content on one line — a hard break
 * a note inside it holds is a space — with a trailing `#` run escaped where no
 * suffix follows it, and a `{…}` the plugin would take off its text escaped
 * (`escapedLiterals`). The one spelling
 * the save (`blockSerializer`) and the check of an edit (`writtenTextblock`)
 * both write.
 */
function headingText(node: Node, inline: Spelled): Spelled {
    let text = respelled(respelled(respelled(inline, HOLD_RE, () => ''), /\\\n/g, () => ' '), /\s+$/g, () => '');
    if ((node.attrs.attrsSuffix as string | null) === null && /(^| )#+$/.test(text.text)) {
        text = respelled(text, CLOSING_HASHES, run => '\\' + run);
    }
    const prefix = (node.attrs.reqPrefix as string | null) ?? '';
    const escaped = escapedLiterals(node, prefix + text.text, 'heading');
    // A marker after an escaped brace moves by its backslash.
    return { text: escaped.text, at: text.at.map(place => place + prefix.length + escaped.at.filter(at => at <= place + prefix.length).length) };
}

function sameSidebar(a: ReadSidebar, b: ReadSidebar): boolean {
    return a.kind === b.kind && a.open === b.open && a.close === b.close;
}

/**
 * Where a part does not read back as the sidebars it holds (`sidebarVerdict`):
 * the textblock `at`, as the save writes it unwrapped (`written`, which the
 * reason reads what stands beside a marker in), and the sidebar of it not read
 * back (`lost`) — none when a sidebar is read that the page does not show.
 */
interface SidebarMismatch {
    written: { text: string; sidebars: ReadSidebar[] };
    lost?: ReadSidebar;
    at: Node;
    /** Not a sidebar but a formula is read that the page does not show. */
    math?: boolean;
}

/** Each textblock as the save writes it (`writtenTextblock`), by the node; made anew with the engine. */
let writtenCache = new WeakMap<Node, { text: string; sidebars: ReadSidebar[] }>();

/** `writtenTextblock`, remembered by the node. */
function writtenOf(textblock: Node): { text: string; sidebars: ReadSidebar[] } {
    let written = writtenCache.get(textblock);
    if (written === undefined) {
        written = writtenTextblock(textblock);
        writtenCache.set(textblock, written);
    }
    return written;
}

/**
 * Why a sidebar the parser does not read back where it stands is lost, said
 * as what to do: for a left one, VS Code's math reading its `$…$` as math —
 * with a space beside each glued marker it comes back only without the math
 * rules, so no space helps —
 * else a letter or digit before its marker, a digit after a left one's closer
 * (`sidebarCanOpen`, `sidebarCanClose`), or a web address that reads it in —
 * the sidebar comes back with linkify off.
 */
function lostReason(text: string, lost: ReadSidebar): string {
    const marker = text.charAt(lost.open);
    const gluedBefore = lost.open > 0 && !sidebarCanOpen(text.charAt(lost.open - 1), marker);
    const gluedAfter = lost.close + 1 < text.length && !sidebarCanClose(marker, text.charAt(lost.close + 1));
    if (lost.kind === 'left_sidebar' && currentInlineDefinition().math) {
        // First, as the spaces the glued hints ask for would not help: with them, math is what takes it.
        const shift = gluedBefore ? 1 : 0;
        const spaced = `${text.slice(0, lost.open)}${gluedBefore ? ' ' : ''}${text.slice(lost.open, lost.close + 1)}${gluedAfter ? ' ' : ''}${text.slice(lost.close + 1)}`;
        const moved: ReadSidebar = { kind: lost.kind, open: lost.open + shift, close: lost.close + shift };
        if (!sidebarsRead(spaced).some(r => sameSidebar(r, moved)) && sidebarsReadWithoutMath(spaced).some(r => sameSidebar(r, moved))) {
            return SIDEBAR_LEFT_MATH;
        }
    }
    if (gluedBefore) {
        return SIDEBAR_GLUED_BEFORE;
    }
    if (gluedAfter) {
        return SIDEBAR_GLUED_AFTER;
    }
    if (currentInlineDefinition().linkify && sidebarsReadWithoutLinkify(text).some(r => sameSidebar(r, lost))) {
        return SIDEBAR_GLUED_URL;
    }
    return SIDEBAR_NOT_READ;
}

/**
 * Why the save cannot write `unit`, the part `index` of the top-level `block`,
 * so that it reads back as it is shown, its `verdict` given: an
 * attribute literal it does not read back, or text it reads as one, named in
 * the reason; then a sidebar. When the same part of the document the edit
 * started from already read back otherwise (`origin`), the cause is how the
 * file spells it, which the editor rewrites — a character reference it writes
 * as the character (`h&#116;tp://e.com/$x$`, an address once written out,
 * takes the sidebar in), when the text that textblock was read from holds one
 * (`EditOrigin.sourceOf`), else unnamed; for a literal, that literal — and the
 * reason says so: it is edited in the text editor once. Nothing is let through
 * on that account, a literal's removal included: an edit applies exactly when
 * the save then reads back what the page shows. Where what fails is only
 * written again beside the edit (`beside`: a textblock outside its range), the
 * reason names the block the edit rewrites whole.
 */
function unitRefusal(block: { node: Node; offset: number; copyOf?: number | null }, unit: WrittenUnit, index: number, verdict: UnitVerdict, beside: boolean, origin?: EditOrigin): string {
    const before = origin === undefined ? null : unitBefore(origin, block, unit, index);
    if (verdict.lost !== null) {
        if (before?.verdict.lost == null) {
            return literalLostReason(verdict.lost);
        }
        // The part named is the one the named literal stands on or in, in the document the edit started from.
        return beside ? literalRewrittenBeside(block.node, before.verdict.lost.at ?? verdict.lost.at ?? block.node, before.verdict.lost) : literalRewritten(before.verdict.lost);
    }
    const mismatch = verdict.mismatch as SidebarMismatch;
    const old = before?.verdict.mismatch ?? null;
    if (origin !== undefined && before !== null && old !== null) {
        const source = origin.sourceOf?.(before.positionOf(old.at)) ?? null;
        const reference = source !== null && CHARACTER_REFERENCE.test(source);
        if (beside) {
            return sidebarRewrittenBeside(block.node, mismatch.at, reference);
        }
        return reference ? SIDEBAR_REWRITTEN_REFERENCE : SIDEBAR_REWRITTEN;
    }
    return mismatch.lost !== undefined ? lostReason(mismatch.written.text, mismatch.lost) : mismatch.math ? MATH_MADE : SIDEBAR_MADE;
}

/**
 * The part of the document an edit started from that `unit` (part `index` of
 * `block` in the edited one) was made of, with its verdict and where a
 * textblock of it stands there: a copy's own part `index` of the block it
 * copies (`copyOf`), else the part holding the position the unit's start maps
 * back to. `null` where there is none.
 */
function unitBefore(origin: EditOrigin, block: { node: Node; offset: number; copyOf?: number | null }, unit: WrittenUnit, index: number): { verdict: UnitVerdict; positionOf: (node: Node) => number } | null {
    let oldBlock: Node | null;
    let oldOffset: number;
    let oldUnit: WrittenUnit | undefined;
    if (block.copyOf !== undefined && block.copyOf !== null) {
        oldOffset = block.copyOf;
        oldBlock = origin.doc.nodeAt(oldOffset);
        oldUnit = oldBlock === null ? undefined : unitsOf(oldBlock)[index];
    } else {
        const pos = Math.min(origin.mapping.invert().map(block.offset + unit.from + 1, -1), origin.doc.content.size);
        const $old = origin.doc.resolve(pos);
        if ($old.depth === 0 && pos >= origin.doc.content.size) {
            return null;
        }
        oldOffset = $old.depth === 0 ? pos : $old.before(1);
        oldBlock = origin.doc.nodeAt(oldOffset);
        oldUnit = oldBlock === null ? undefined : unitsOf(oldBlock).find(u => u.from <= pos - oldOffset && pos - oldOffset < u.to);
    }
    const verdict = oldUnit === undefined ? null : unitVerdict(oldUnit);
    if (oldUnit === undefined || verdict === null) {
        return null;
    }
    const textblocks = oldUnit.textblocks;
    return { verdict, positionOf: node => oldOffset + (textblocks.find(t => t.node === node)?.pos ?? 0) };
}

/** Why an edit is refused after which text would be read as attributes no literal gives. */
export const LITERAL_MADE = 'After this edit text here would be read as attributes, which the editor does not show.';

/**
 * Why an edit is refused after which the literal `lost` names would not read
 * back where the save writes it — a `$` in it pairing with another as math or
 * a left sidebar, inline code or a link reaching into it, a line break the
 * wrap puts before it — or, `literal` `null`, text would be read as
 * attributes.
 */
export function literalLostReason(lost: LiteralLoss): string {
    if (lost.literal === null) {
        return LITERAL_MADE;
    }
    return `After this edit the preview would not read ${lost.literal} back as written: read with the rest of its block — a $ pairing with another $ as math or a left sidebar, say, code reaching into it, or a line break before it — it would be shown as text.`;
}

/** Why an edit is refused in a line whose literal `lost` names already does not read back as it is shown, edited or not — or, `literal` `null`, which already reads text as attributes. */
export function literalRewritten(lost: LiteralLoss): string {
    if (lost.literal === null) {
        return 'Written by the editor, this line would read text here as attributes the editor does not show, edited or not: edit the line once in the text editor to unlock it.';
    }
    return `Written by the editor, this line would not read ${lost.literal} back as written, edited or not: remove that literal, or edit the line once in the text editor to unlock it.`;
}

/**
 * `literalRewritten` for another part of a block the edit makes the save write
 * whole (`sidebarRewrittenBeside`): `textblock` the node the literal is written
 * on or in — a cell, a heading, a paragraph, an item — or the block itself
 * for its own literal (a list's, a table's, a quote's).
 */
export function literalRewrittenBeside(block: Node, textblock: Node, lost: LiteralLoss): string {
    const whole = BLOCK_NOUNS[block.type.name] ?? 'block';
    const name = textblock.type.name;
    if (lost.literal !== null && !textblock.isTextblock && name !== 'list_item') {
        return `This edit makes the editor write the whole ${whole} again, and the ${whole}'s own literal ${lost.literal} would then not read back as written. Remove that literal, or edit the ${whole} once in the text editor to unlock it.`;
    }
    const part = name === 'table_cell' || name === 'table_header' ? 'cell' : name === 'heading' ? 'heading' : name === 'list_item' ? 'item' : name === 'paragraph' ? 'paragraph' : 'part';
    if (lost.literal === null) {
        return `This edit makes the editor write the whole ${whole} again, and another ${part} of it would then read text as attributes the editor does not show. Edit that ${part} once in the text editor to unlock this ${whole}.`;
    }
    return `This edit makes the editor write the whole ${whole} again, and another ${part} of it would then not read ${lost.literal} back as written. Remove that literal, or edit that ${part} once in the text editor to unlock this ${whole}.`;
}

/**
 * In a table cell a `|` in text is a cell boundary to the table plugin, so it
 * is escaped where every other character the engine would read as syntax is:
 * in the text, the alt text and a sidebar's text, as `\|`. What is written
 * verbatim — code, an attribute span's literal — gets no escape; a `|` there
 * has no spelling and is not made (`unwritableInTable`).
 */
const ESCAPE_IN_CELL = new RegExp(`${ESCAPE_EXTRA.source}|\\|`, 'g');

function inlineSerializer(fromBlockStart: boolean, inTableCell: boolean): MarkdownSerializer {
    return new MarkdownSerializer({
        ...inlineNodes,
        paragraph(state, node) {
            internals(state).inTableCell = inTableCell;
            state.renderInline(node, fromBlockStart);
            state.closeBlock(node);
        },
    }, marks, { escapeExtraCharacters: inTableCell ? ESCAPE_IN_CELL : ESCAPE_EXTRA });
}

const inlineSerializers = new Map<string, MarkdownSerializer>();

/** The inline serializer for a line's start or its middle, or a table cell. */
function inlineFor(fromBlockStart: boolean, inTableCell: boolean): MarkdownSerializer {
    const key = `${fromBlockStart}/${inTableCell}`;
    let serializer = inlineSerializers.get(key);
    if (serializer === undefined) {
        serializer = inlineSerializer(fromBlockStart, inTableCell);
        inlineSerializers.set(key, serializer);
    }
    return serializer;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/*
 * A changed pipe table is written in **the tidy form**: the one the
 * extension's own **Format Table** writes (`src/services/table`), read from
 * there rather than stated twice, so a table the editor saved and a table the
 * text editor formatted are the same text:
 *
 * - one line per row — the header row, the delimiter row, the body rows — each
 *   `| cell | cell |`, outer pipes written, one space inside each pipe;
 * - a column is as wide as its widest cell, counted in monospace columns (a
 *   CJK character is two), and at least as wide as its delimiter needs — 1
 *   unaligned, 2 left or right, 3 centred; every cell is padded to it: an
 *   unaligned or left-aligned column's cells with spaces after the text, a
 *   right-aligned column's before it, a centred column's on both sides (the
 *   odd space after);
 * - the delimiter row carries the alignment: `---` none, `:--` left, `:-:`
 *   centre, `--:` right, as many dashes as the column is wide;
 * - a cell is its inline Markdown on one line, trimmed, as the plugin trims
 *   it: a `|` in its text is escaped as `\|` where the text is escaped
 *   (`ESCAPE_IN_CELL`); an empty cell is its padding, so never `||`, which
 *   the plugin reads as a colspan; a cell whose text reads as a delimiter cell
 *   (`---`, `:-:`) has its first character escaped, or a row of them would
 *   read as a delimiter row; `^^`, the plugin's rowspan, is escaped as every
 *   `^` is (`ESCAPE_EXTRA`).
 *
 * The plugin finds the cell boundaries in the raw line before any inline
 * parse: a `|` after a backslash is no boundary, one inside single-backtick
 * code is none either, one inside a longer fence is. So a cell also writes a
 * link's destination with `|` and a backtick percent-encoded, and a `|` or a
 * backtick in a link title escaped (a raw backtick opens code for the row scan); a bare or
 * angle link holding either is written inline; a backslash right before a code
 * span (text ending in `\`) is `&#92;`, because the row scan reads `\\` as
 * escaping the backtick after it and then takes the span's closing backtick
 * for an opening one. What has no spelling at all — code, or an attribute
 * span's literal, holding a `|` — is not made (`unwritableInTable`), and a
 * table the file holds such code in stays a source block (`blocks.ts`).
 *
 * An untouched table is its slice, as every block is, so a table written in
 * any other form stays in it until it is edited.
 */

/** A backslash pair — a text's escaped `\` — right before a code span opens (`` `…` ``), holds between. */
const BACKSLASH_BEFORE_CODE = new RegExp(`\\\\\\\\(?=[${HOLD_CLOSE}]*${HOLD_OPEN}\`)`, 'g');

/** A cell's text that the plugin would read as a delimiter cell (GFM's, or multimd's `=` and `+`). */
const READS_AS_DELIMITER = /^:?(?:-+|=+):?\+?$/;

/** One cell's inline content as its row writes it, hold markers included, before the tidy form's last touches (`tableCellMarkdown`). */
function cellMarkdown(cell: Node): string {
    const paragraph = editorSchema.nodes.paragraph.create(null, cell.content);
    return inlineFor(false, true).serialize(editorSchema.topNodeType.create(null, [paragraph]));
}

/** Each cell as `tableCellMarkdown` writes it, by the node: a table is written whole for every keystroke in it (`unitsOf`). Made anew with the engine, which decides its escapes (`setInlineEngine`). */
let cellCache = new WeakMap<Node, string>();

/** One cell's inline content as the tidy form writes it (see above), unpadded. Remembered by the node. */
export function tableCellMarkdown(cell: Node): string {
    let written = cellCache.get(cell);
    if (written === undefined) {
        written = cellText(cell, { text: cellMarkdown(cell), at: [] }).text;
        cellCache.set(cell, written);
    }
    return written;
}

/**
 * A cell's inline content, as its row wrote it (`cellMarkdown`), given the
 * tidy form's last touches, and a `{…}` in its text the plugin would take as
 * the cell's attributes, or anything's in it, escaped (`escapedLiterals`):
 * the one spelling the save (`tableCellMarkdown`) and the check of an edit
 * (`writtenTextblock`) both write. `cell` is the node it is written from.
 */
function cellText(cell: Node, inline: Spelled): Spelled {
    let written = respelled(inline, BACKSLASH_BEFORE_CODE, () => '&#92;');
    written = respelled(written, HOLD_RE, () => '');
    written = respelled(written, /\r?\n/g, () => ' ');
    written = respelled(written, /^\s+|\s+$/g, () => '');
    if (READS_AS_DELIMITER.test(written.text)) {
        written = { text: `\\${written.text}`, at: written.at.map(place => place + 1) };
    }
    const escaped = escapedLiterals(cell, written.text, 'cell');
    // A marker after an escaped brace moves by its backslash.
    return { text: escaped.text, at: written.at.map(place => place + escaped.at.filter(at => at <= place).length) };
}

/** The formatter's alignment for a column's. */
const FORMATTER_ALIGN: Readonly<Record<Exclude<TableAlign, null>, MDTableAlign>> = {
    left: MDTableAlign.Left,
    center: MDTableAlign.Center,
    right: MDTableAlign.Right,
};

/**
 * The lines of a table in the tidy form. The header row is the first row,
 * whatever its cells' type, and a column's alignment is its header cell's (the
 * page keeps the column's other cells equal to it). A cell spanning columns,
 * which a pipe table has no spelling for and the schema never parses, is
 * written as itself and empty cells after it, so the rows stay rectangular.
 */
export function tableLines(table: Node): string[] {
    const rows: { text: string; align: TableAlign }[][] = [];
    table.forEach(row => {
        const cells: { text: string; align: TableAlign }[] = [];
        row.forEach(cell => {
            cells.push({ text: tableCellMarkdown(cell), align: (cell.attrs.align as TableAlign | undefined) ?? null });
            for (let k = 1; k < ((cell.attrs.colspan as number | undefined) ?? 1); k++) {
                cells.push({ text: '', align: null });
            }
        });
        rows.push(cells);
    });
    const formatted = new MDTable(rows.map(r => r.map(c => c.text)), 1);
    formatted.aligns = Array.from({ length: formatted.columnCount }, (_, c) => {
        const align = rows[0]?.[c]?.align ?? null;
        return align === null ? MDTableAlign.Auto : FORMATTER_ALIGN[align];
    });
    return formatted.stringify().split('\n');
}

/** Why a cell holds no line break: said wherever a hard break is refused, by key (`webview/tables.ts`) or by any other edit. */
export const CELL_BREAK_REFUSAL = 'A table cell holds one line: a pipe table has no line break inside a cell.';

/**
 * Why a table between `from` and `to` cannot be written so that it reads back
 * as itself, or `null` — what the tidy form above has no spelling for, which
 * the page refuses to make (`webview/tables.ts`), as it refuses an unwritable
 * note: a hard break in a cell (a sidebar can hold one), code holding a `|`,
 * an attribute span whose literal holds a `|` or a backtick.
 */
export function unwritableInTable(doc: Node, from = 0, to = doc.content.size): string | null {
    let reason: string | null = null;
    const start = Math.max(0, Math.min(from, to));
    const end = Math.min(doc.content.size, Math.max(from, to));
    doc.nodesBetween(start, end, node => {
        if (reason !== null) {
            return false;
        }
        if (node.type.name !== 'table') {
            return !node.isTextblock;
        }
        node.descendants(child => {
            if (reason !== null) {
                return false;
            }
            if (child.type.name === 'hard_break') {
                reason = CELL_BREAK_REFUSAL;
            } else if (child.isText && (child.text ?? '').includes('|') && child.marks.some(m => m.type.name === 'code')) {
                reason = 'Inline code in a table cell cannot hold "|": the table plugin splits the row at it, and nothing escapes it there.';
            } else {
                const span = child.marks.find(m => m.type.name === 'attr_span' && /[|`]/.test(m.attrs.literal as string));
                if (span !== undefined) {
                    reason = `An attribute span in a table cell cannot hold ${span.attrs.literal as string}: its literal is written as it is, and the table plugin would read a cell boundary or code in it.`;
                }
            }
            return true;
        });
        return false;
    });
    return reason;
}

/** A textblock's inline content as one line of Markdown, hold markers included, hard breaks as `\` + newline. */
function inlineMarkdown(node: Node, fromBlockStart: boolean): string {
    const paragraph = editorSchema.nodes.paragraph.create(null, node.content);
    const doc = editorSchema.topNodeType.create(null, [paragraph]);
    return inlineFor(fromBlockStart, false).serialize(doc);
}

/**
 * A paragraph's inline content as the save writes it before wrapping it: in
 * the line-start form, as a paragraph starts a line. The one call both the
 * save (`blockSerializer`) and the check of an edit (`writtenTextblock`) make.
 */
function paragraphMarkdown(node: Node): string {
    return inlineMarkdown(node, true);
}

/**
 * The fence a fenced code block is written with, before it is lengthened past
 * a run in its content: its own, unless it has none (an emptied indented
 * block) or holds an info string with a backtick, which no backtick fence
 * takes — tildes then, backticks otherwise. Where its literal is read
 * (`fenceHolder`) is decided by the same fence.
 */
export function fenceOf(node: Node): string {
    const params = String(node.attrs.params ?? '');
    const markup = String(node.attrs.markup ?? '```');
    if (markup === '' || (markup.startsWith('`') && params.includes('`'))) {
        return params.includes('`') ? '~~~' : '```';
    }
    return markup;
}

/**
 * Where the save writes `node`'s literal, as `attrsReadAt` knows it: the
 * node's name, a fenced code block's by the fence it is written with
 * (`fenceHolder`, `fenceOf`). What the Attributes field and a copy judge a
 * literal by (`literalPlaceOf`, `withoutId`).
 */
export function literalHolder(node: Node): string {
    return node.type.name === 'code_block' ? fenceHolder(fenceOf(node)) : node.type.name;
}

function blockSerializer(options: SerializeOptions): MarkdownSerializer {
    return new MarkdownSerializer({
        ...inlineNodes,
        paragraph(state, node) {
            // Flush the pending block separator and write the line prefix first,
            // so the column the first line starts at is known.
            state.write();
            const st = internals(state);
            const column = characterCount(st.out.slice(st.out.lastIndexOf('\n') + 1));
            const limit = (node.attrs.wrapWidth as number | null)
                ?? Math.max(options.defaultWrap, (node.attrs.lineWidth as number | null) ?? 0);
            const wrapped = wrapInline(paragraphMarkdown(node), limit - column, limit - characterCount(st.delim)).join('\n');
            state.text(escapedLiterals(node, wrapped, 'paragraph').text, false);
            state.closeBlock(node);
        },
        heading(state, node) {
            const suffix = node.attrs.attrsSuffix as string | null;
            // One line (`headingText`); a trailing ` #` run is an ATX closing sequence and is escaped there.
            const line = '#'.repeat(node.attrs.level as number) + ' ' + headingText(node, { text: inlineMarkdown(node, false), at: [] }).text;
            state.write(suffix === null ? line.replace(/\s+$/, '') : line.replace(/\s+$/, '') + ' ' + suffix);
            state.closeBlock(node);
        },
        blockquote(state, node) {
            state.wrapBlock('> ', null, node, () => state.renderContent(node));
        },
        bullet_list(state, node) {
            const { indent, marker } = listMarkers(node);
            state.renderList(node, indent, marker);
        },
        ordered_list(state, node) {
            const { indent, marker } = listMarkers(node);
            state.renderList(node, indent, marker);
        },
        list_item(state, node) {
            const literal = node.attrs.literal as string | null;
            if (literal === null || !itemTakesLiteral(node)) {
                state.renderContent(node);
                return;
            }
            // `- text {.a}`: after a space at the end of the first paragraph's
            // last line, where markdown-it-attrs gives it to the item; not wrapped.
            node.forEach((child, _offset, i) => {
                state.render(child, node, i);
                if (i === 0) {
                    const st = internals(state);
                    st.out = `${st.out.replace(/[ \t]+$/, '')} ${literal}`;
                }
            });
        },
        code_block(state, node) {
            const content = node.textContent;
            const params = String(node.attrs.params ?? '');
            if (String(node.attrs.markup ?? '```') === '' && content.trim() !== '') {
                // Indented, as written.
                state.text(content.split('\n').map(l => (l === '' ? '' : '    ' + l)).join('\n'), false);
                state.closeBlock(node);
                return;
            }
            const markup = fenceOf(node);
            const ch = markup[0];
            let longest = 0;
            for (const run of content.match(new RegExp(`^ {0,3}\\${ch}+`, 'gm')) ?? []) {
                longest = Math.max(longest, run.trim().length);
            }
            const fence = longest >= markup.length ? ch.repeat(longest + 1) : markup;
            // A fence's attribute literal stands on its opening line (`blocks.ts`).
            const suffix = node.attrs.attrsSuffix as string | null;
            state.write(fence + params + (suffix ? ` ${suffix}` : '') + '\n');
            state.text(content, false);
            state.write('\n');
            state.write(fence);
            state.closeBlock(node);
        },
        horizontal_rule(state, node) {
            state.write(String(node.attrs.markup || '---'));
            state.closeBlock(node);
        },
        table(state, node) {
            // The tidy form (above); never wrapped, since a row is one line.
            state.text(tableLines(node).join('\n'), false);
            state.closeBlock(node);
        },
        container(state, node) {
            // `::: name info`, the body at the container's own indentation, and the fence again.
            // The body is written first with the fence as it was, and the fence
            // lengthened afterwards if a line of it would close the container.
            const st = internals(state);
            const markup = String(node.attrs.markup || ':::');
            const name = node.attrs.name as string;
            state.write();
            const openAt = st.out.length;
            state.write(markup + (name === '' ? '' : ` ${name}`) + (node.attrs.info as string));
            state.ensureNewLine();
            const bodyAt = st.out.length;
            if (!onlyEmptyParagraph(node)) {
                state.renderContent(node);
            }
            st.flushClose(1);
            const fence = containerFence(markup, st.out.slice(bodyAt), st.delim);
            if (fence !== markup) {
                st.out = st.out.slice(0, openAt) + fence + st.out.slice(openAt + markup.length);
            }
            state.write(fence);
            state.closeBlock(node);
        },
        admonition(state, node) {
            // `!!! type "Title"`, the body indented by four (the plugin's `blkIndent + 4`).
            state.write(admonitionHeader(node));
            if (onlyEmptyParagraph(node)) {
                // A body of one empty paragraph is no line at all, not a line of spaces.
                state.closeBlock(node);
                return;
            }
            state.ensureNewLine();
            state.wrapBlock(ADMONITION_INDENT, null, node, () => state.renderContent(node));
        },
    }, marks, { escapeExtraCharacters: ESCAPE_EXTRA });
}

/**
 * How a list writes its items (`renderList`): the indent of an item's
 * continuation lines and the marker of item `i` — `- ` (the list's bullet),
 * or the number right-aligned to the widest one, its delimiter and a space.
 * The one spelling the list writers and the read-back of an item
 * (`itemMarkdown`) use.
 */
function listMarkers(node: Node): { indent: string; marker: (i: number) => string } {
    if (node.type.name === 'bullet_list') {
        const bullet = String(node.attrs.bullet || '-');
        return { indent: '  ', marker: () => `${bullet} ` };
    }
    const start = Number(node.attrs.order ?? 1);
    const delimiter = String(node.attrs.delimiter || '.');
    const maxWidth = String(start + node.childCount - 1).length;
    return {
        indent: ' '.repeat(maxWidth + 2),
        marker: i => {
            const n = String(start + i);
            return ' '.repeat(maxWidth - n.length) + n + delimiter + ' ';
        },
    };
}

/** How far an admonition's body is indented: `markdownItAdmonition.ts` reads it at `blkIndent + 4`. */
export const ADMONITION_INDENT = '    ';

/** Whether a container's or an admonition's whole body is one empty paragraph, as a new one is. */
function onlyEmptyParagraph(node: Node): boolean {
    return node.childCount === 1 && node.child(0).type.name === 'paragraph' && node.child(0).content.size === 0;
}

/**
 * An admonition's opening line: as it was written while its type and title are
 * what the line says (`header`), else `!!! type "Title"` — the quoted form, which
 * the plugin reads for every title, a first word that is a type included — or
 * `!!! type` for none.
 */
export function admonitionHeader(node: Node): string {
    const header = node.attrs.header as string | null;
    if (header !== null) {
        return header;
    }
    const title = node.attrs.title as string;
    return `${String(node.attrs.markup || '!!!')} ${node.attrs.type as string}${title === '' ? '' : ` "${title}"`}`;
}

/**
 * The fence a container is written with: `markup`, as written, unless a line of
 * its written `body` would close it early — markdown-it-container ends a
 * container at the first line of colons at least as long as its fence, less
 * than four columns in, whatever block the line belongs to: a nested
 * container's fence, a line of colons in a code block, a paragraph's. Then one
 * colon longer than the longest such line. `delim` is the prefix every body
 * line carries from the blocks around the container (`> ` in a quote).
 */
export function containerFence(markup: string, body: string, delim = ''): string {
    const bare = delim.replace(/\s+$/, '');
    let longest = 0;
    for (const line of body.replace(HOLD_RE, '').split('\n')) {
        const own = line.startsWith(delim) ? line.slice(delim.length) : line.startsWith(bare) ? line.slice(bare.length) : line;
        const m = /^ {0,3}(:+)[ \t]*$/.exec(own);
        if (m) {
            longest = Math.max(longest, m[1].length);
        }
    }
    return longest >= markup.length ? ':'.repeat(longest + 1) : markup;
}

/** The list forms a `{…}` under the last line is read back for: every item's first paragraph a lazy line away from it, no nested list the plugin could give it to. */
function listTakesLineLiteral(list: Node): boolean {
    let nested = false;
    list.descendants(n => {
        nested = nested || n.type.name === 'bullet_list' || n.type.name === 'ordered_list';
        return !nested;
    });
    const last = list.lastChild;
    // An empty last item is no paragraph the `{…}` line could continue: it would be one of its own.
    return !nested && last !== null && last.childCount === 1 && last.child(0).type.name === 'paragraph' && last.child(0).content.size > 0;
}

/**
 * Where a textblock's text is written, as the parser meets it: a paragraph
 * alone, a heading after its `#`, a cell in a one-column table's header row.
 * The text stands between the two strings.
 */
const LITERAL_CONTEXTS: Readonly<Record<'paragraph' | 'heading' | 'cell', readonly [string, string]>> = {
    paragraph: ['', ''],
    heading: ['# ', ''],
    cell: ['| ', ' |\n| - |'],
};

/** Each text's escapes (`literalEscapes`), by where it is written and the text; the oldest is dropped first. */
const escapeCache = new Map<string, number[]>();
/** How many texts `escapeCache` keeps. */
const ESCAPE_CACHE_SIZE = 512;

/**
 * `written`, a paragraph's, a heading's or a cell's text as the save writes it
 * (`where`), with every `{…}` the page shows as text that markdown-it-attrs
 * would take as attributes written as text, `\{x\}`. Asked of the plugin, not
 * of the line: the text is parsed as the save writes it, wrap included, and
 * every `{…}` the plugin cut off a text token (`attrsCutsIn`) is one the page
 * shows as text — but a span's own literal, the first cut right after its
 * `]`. That covers each place the plugin takes one: off the end of the last
 * text, which it reaches past an escape (`b {x}\$` takes `{x}`) or emphasis —
 * the block's — the line the wrap left it alone on, and right after emphasis,
 * a link, inline code, an image or a span (`see *a*{.c}`, anywhere in the
 * line). A literal of the block, an item's or a heading's is written after
 * this text and is not in it, so a `{…}` it would take once that literal is
 * removed is escaped too. One the plugin takes in a note's text, which it
 * reads in a parse of its own, is not: the edit filter refuses it
 * (`unitVerdict`).
 *
 * The `{…}` escaped is where the cut text token stands in the written text —
 * the inline rules make every text token a verbatim run of it — and the parse
 * is asked again: an escape is kept when the plugin then takes one `{…}` less
 * and every span's literal still, so a copy of the same text elsewhere in the
 * line (`a {x}[{x}](u)`) is never the one escaped. Until it takes none.
 * Remembered by the text.
 */
function escapedLiterals(node: Node, written: string, where: keyof typeof LITERAL_CONTEXTS): Spelled {
    if (!node.textContent.includes('}') || !written.includes('{')) {
        return { text: written, at: [] };
    }
    const key = `${where}\u0000${written}`;
    let at = escapeCache.get(key);
    if (at === undefined) {
        at = literalEscapes(written, LITERAL_CONTEXTS[where]);
        if (escapeCache.size >= ESCAPE_CACHE_SIZE) {
            escapeCache.delete(escapeCache.keys().next().value as string);
        }
    } else {
        escapeCache.delete(key);
    }
    escapeCache.set(key, at);
    return { text: at.reduceRight((text, place) => `${text.slice(0, place)}\\${text.slice(place)}`, written), at };
}

/** The `{…}`s markdown-it-attrs cut off text in a parse: those the page shows as text (`made`), and how many span literals it read. */
interface LiteralCuts {
    made: AttrsCut[];
    spans: number;
}

/** What the page's engine with markdown-it-attrs cuts off text in `text` (`LiteralCuts`). */
function literalCutsIn(text: string): LiteralCuts {
    const found: LiteralCuts = { made: [], spans: 0 };
    for (const token of attrsEngineFor(currentInlineDefinition()).parse(text, {})) {
        if (token.type !== 'inline') {
            continue;
        }
        for (const cut of attrsCutsIn(token)) {
            if (!cut.end && cut.first && cut.after === 'span_close') {
                found.spans++;
            } else {
                found.made.push(cut);
            }
        }
    }
    return found;
}

/**
 * Where `escapedLiterals` puts a backslash in `written`, in order: before the
 * `{` and the `}` of each `{…}` it escapes. `context` is what stands before
 * and after the text as the parser meets it (`LITERAL_CONTEXTS`).
 */
function literalEscapes(written: string, [before, after]: readonly [string, string]): number[] {
    const at: number[] = [];
    let text = written;
    // Each UTF-16 unit's place in `written` (the strings are sliced by unit, so not `Array.from(written)`, which walks code points and comes up short by one per astral character); -1 for a backslash put in.
    let origin = Array.from({ length: written.length }, (_, i) => i);
    let cuts = literalCutsIn(before + text + after);
    while (cuts.made.length > 0) {
        let next: { text: string; origin: number[]; places: number[]; cuts: LiteralCuts } | null = null;
        for (const cut of cuts.made) {
            const literal = cut.text.slice(cut.from, cut.to);
            for (const place of placesOf(before + text + after, cut)) {
                const start = place - before.length;
                const end = start + literal.length - 1;
                if (start < 0 || end >= text.length || origin[start] < 0 || origin[end] < 0) {
                    continue;
                }
                const escaped = `${text.slice(0, start)}\\${text.slice(start, end)}\\${text.slice(end)}`;
                const again = literalCutsIn(before + escaped + after);
                if (again.made.length < cuts.made.length && again.spans === cuts.spans) {
                    next = { text: escaped, origin: [...origin.slice(0, start), -1, ...origin.slice(start, end), -1, ...origin.slice(end)], places: [origin[start], origin[end]], cuts: again };
                    break;
                }
            }
            if (next !== null) {
                break;
            }
        }
        if (next === null) {
            // None the escape would take back: the edit filter refuses what is left (`unitVerdict`).
            break;
        }
        text = next.text;
        origin = next.origin;
        at.push(...next.places);
        cuts = next.cuts;
    }
    // Every place is a unit of `written` (`origin` maps only kept units); were one not, no escapes: the edit filter refuses what is left (`unitVerdict`), as when none would take a cut back.
    if (at.some(place => !Number.isInteger(place) || place < 0 || place >= written.length)) {
        return [];
    }
    return at.sort((a, b) => a - b);
}

/**
 * Where the `{…}` of `cut` may stand in `text`, first where its whole text
 * token stands, then wherever the `{…}` alone does; in order.
 */
function placesOf(text: string, cut: AttrsCut): number[] {
    const literal = cut.text.slice(cut.from, cut.to);
    const places: number[] = [];
    for (let at = text.indexOf(cut.text); at >= 0; at = text.indexOf(cut.text, at + 1)) {
        places.push(at + cut.from);
    }
    for (let at = text.indexOf(literal); at >= 0; at = text.indexOf(literal, at + 1)) {
        if (!places.includes(at)) {
            places.push(at);
        }
    }
    return places;
}
/** Whether a node is a paragraph holding nothing: what `Enter` leaves, or text deleted to be typed again. */
function isEmptyParagraph(node: Node): boolean {
    return node.type.name === 'paragraph' && node.content.size === 0;
}

/**
 * The block a quote's `> {…}` line would follow: its last block that is not an
 * empty paragraph — an empty one writes a bare `>` line, which reads back as
 * nothing, so the literal is written before it — or `null` when there is none.
 */
function quoteLiteralHost(quote: Node): Node | null {
    for (let i = quote.childCount - 1; i >= 0; i--) {
        if (!isEmptyParagraph(quote.child(i))) {
            return quote.child(i);
        }
    }
    return null;
}

/**
 * Whether a quote can carry a literal: markdown-it-attrs gives a `> {…}` line
 * to the quote only through the soft break of the paragraph it ends — after a
 * list, code or a nested quote the same line is that block's. The serializer
 * writes it only when that paragraph has text, and the page gives a literal
 * only to such a quote.
 */
export function quoteTakesLiteral(quote: Node): boolean {
    return quoteLiteralHost(quote)?.type.name === 'paragraph';
}

/**
 * Whether a quote has lost the place for its literal for good: it ends in a
 * block other than a paragraph. A quote holding only empty paragraphs keeps its
 * literal — its text was deleted to be typed again — though it is written only
 * once there is text again. The fidelity plugin drops a quote's literal on this.
 */
export function quoteLostLiteral(quote: Node): boolean {
    const host = quoteLiteralHost(quote);
    return host !== null && host.type.name !== 'paragraph';
}

/**
 * Whether a list item can carry a literal: it is written at the end of the
 * item's first paragraph (`- text {.a}`), so the item must start with one —
 * an empty one (`- {.a}`) or one ending in a hard break too, which the plugin
 * reads as the item's all the same. Read by the serializer, the fidelity
 * plugin and the page alike.
 */
export function itemTakesLiteral(item: Node): boolean {
    return item.firstChild?.type.name === 'paragraph';
}

/**
 * A changed top-level block's text with its attribute literal where it stood
 * (`attrsPlacement`, see `AttrsPlacement` in `blocks.ts`): after a space at the
 * end of its last line, on a line of its own under it, or — for a list — under a
 * blank line. A list whose last item the literal would no longer reach through
 * a lazy line (a second block in it, a nested list the plugin would hand the
 * literal to) takes the blank-line form, which the plugin always gives the
 * list. A quote's is `> {…}` under its last paragraph with text, inside it; a
 * table's is under it or under a blank line, as it stood. Whether the next
 * block's first line may follow a `{…}` line of its own straight is the
 * parser's to say, on the pair as written (`seamHolds` in `serializeLayout`).
 * A heading and a fence write theirs themselves; an empty paragraph is the
 * literal alone, which the plugin reads as the same empty paragraph.
 */
function withBlockSuffix(node: Node, text: string): string {
    const suffix = node.attrs.attrsSuffix as string | null | undefined;
    const name = node.type.name;
    if (!suffix || name === 'heading' || name === 'code_block') {
        return text;
    }
    if (text === '') {
        return suffix;
    }
    const placement = (node.attrs.attrsPlacement as string | null) ?? 'end';
    if (name === 'bullet_list' || name === 'ordered_list') {
        return text + (placement === 'line' && listTakesLineLiteral(node) ? '\n' : '\n\n') + suffix;
    }
    if (name === 'blockquote') {
        // Before the bare `>` lines trailing empty paragraphs write, which read back as nothing.
        return quoteTakesLiteral(node) ? `${text.replace(/(\n>[ \t]*)+$/, '')}\n> ${suffix}` : text;
    }
    if (name === 'table') {
        return `${text}${placement === 'line' ? '\n' : '\n\n'}${suffix}`;
    }
    return placement === 'end' ? `${text.replace(/[ \t]+$/, '')} ${suffix}` : `${text}\n${suffix}`;
}

/** The literal of each attribute span in `node`'s inline content, notes' included, in order: one per run of one mark. */
function spanLiteralsIn(node: Node): string[] {
    const out: string[] = [];
    const walk = (parent: Node) => {
        let open: Mark | null = null;
        parent.forEach(child => {
            const mark = child.marks.find(m => m.type.name === 'attr_span') ?? null;
            if (mark !== null && (open === null || !mark.eq(open))) {
                out.push(mark.attrs.literal as string);
            }
            open = mark;
            if (!child.isLeaf) {
                walk(child);
            }
        });
    };
    walk(node);
    return out;
}

/** The attributes a literal gives, joined as the plugin joins them (`joinAttrs`); none for no literal. */
function literalPairs(literal: string | null | undefined): AttrPair[] {
    return joinAttrs((literal ? parseAttrsLiteral(literal) : null) ?? []);
}

/** An attribute list as a key that ignores its order. */
function attrsKey(list: readonly AttrPair[]): string {
    return JSON.stringify([...list].map(([n, v]) => [n, v]).sort());
}

// ---------------------------------------------------------------------------
// Reading back what the save writes
// ---------------------------------------------------------------------------

/**
 * The options the save writes with on this page (`setWriteOptions`): the
 * read-back writes each block as the save does, wrap included.
 */
let writeOptions: SerializeOptions = { defaultWrap: 90 };
/** `blockSerializer(writeOptions)`, made when first asked. */
let writer: MarkdownSerializer | null = null;

/**
 * Write with `options` from now on, as the page's save does (the host's
 * `defaultWrap`, posted with each document): what the edit filter reads back
 * is the text the save will write.
 */
export function setWriteOptions(options: SerializeOptions): void {
    if (options.defaultWrap === writeOptions.defaultWrap) {
        return;
    }
    writeOptions = { ...options };
    writer = null;
    forgetReadBack();
}

function currentWriter(): MarkdownSerializer {
    writer ??= blockSerializer(writeOptions);
    return writer;
}

/**
 * A part of a top-level block's save that the parser reads on its own as it
 * reads it in the whole (`unitsOf`): its text as the save writes it, the
 * literals the save writes in it, its textblocks, and where it stands.
 */
interface WrittenUnit {
    text: string;
    /**
     * What its reading depends on, by which it is remembered: its text, or for
     * a table's row the cells' texts — the padding the tidy form gives each
     * cell to its column's width, which the table rule trims off every cell,
     * changes all rows when one cell widens its column.
     */
    key: string;
    /** The node the unit is written from, by which its verdict is remembered with its text (`unitVerdict`). */
    anchor: Node;
    /** The literals written in it, in the order the parser meets the tokens markdown-it-attrs gives them to. */
    literals: { literal: string; token: string; node: Node }[];
    /** Its textblocks whose inline content the parser reads, in order, at their position from the top-level block's (`0` for the block itself). */
    textblocks: { node: Node; pos: number }[];
    /** Where it stands from the top-level block's position: `[from, to)`. */
    from: number;
    to: number;
}

/** The token markdown-it-attrs gives a node's literal to. */
const LITERAL_TOKENS: Readonly<Record<string, string>> = {
    paragraph: 'paragraph_open',
    heading: 'heading_open',
    bullet_list: 'bullet_list_open',
    ordered_list: 'ordered_list_open',
    list_item: 'list_item_open',
    blockquote: 'blockquote_open',
    table: 'table_open',
    code_block: 'fence',
    horizontal_rule: 'hr',
};

/**
 * The literals the save writes for `node` and what it holds, in document
 * order, as `blockSerializer` writes them: a top-level block's (`top`)
 * `attrsSuffix` (`withBlockSuffix`; a quote's only while it takes one,
 * `quoteTakesLiteral`; an indented code block's never), a heading's at any
 * depth, a list item's while it takes one (`itemTakesLiteral`).
 */
function writtenLiterals(node: Node, top: boolean, out: WrittenUnit['literals'] = []): WrittenUnit['literals'] {
    const name = node.type.name;
    const suffix = node.attrs.attrsSuffix as string | null | undefined;
    const indented = name === 'code_block' && String(node.attrs.markup ?? '```') === '' && node.textContent.trim() !== '';
    if (suffix && (top || name === 'heading') && !(name === 'blockquote' && !quoteTakesLiteral(node)) && !indented) {
        out.push({ literal: suffix, token: LITERAL_TOKENS[name] ?? `${name}_open`, node });
    }
    const literal = name === 'list_item' ? node.attrs.literal as string | null : null;
    if (literal && itemTakesLiteral(node)) {
        out.push({ literal, token: 'list_item_open', node });
    }
    if (!node.isTextblock) {
        node.forEach(child => {
            writtenLiterals(child, false, out);
        });
    }
    return out;
}

/** The textblocks in `node` (itself included) whose inline content the parser reads, at their position from `base`, as `node` stands at `base`. */
function inlineTextblocks(node: Node, base: number): WrittenUnit['textblocks'] {
    if (node.isTextblock) {
        return INLINE_TEXTBLOCKS.has(node.type.name) ? [{ node, pos: base }] : [];
    }
    const out: WrittenUnit['textblocks'] = [];
    node.descendants((child, rel) => {
        if (child.isTextblock && INLINE_TEXTBLOCKS.has(child.type.name)) {
            out.push({ node: child, pos: base + 1 + rel });
        }
        return !child.isTextblock;
    });
    return out;
}

/** The parts of each top-level block, by the node (`unitsOf`); made anew with the engine and the options. */
let unitsCache = new WeakMap<Node, WrittenUnit[]>();
/** An item's text as its list writes it (`itemMarkdown`), by the item and how its list writes it. */
let itemCache = new WeakMap<Node, { key: string; text: string }>();

/**
 * A list item as `renderList` writes it in its list — its marker, its
 * continuation lines' indent, the list's tightness — without the separator
 * before it: the very calls the list writer makes for it, on a state of its
 * own.
 */
function itemMarkdown(list: Node, item: Node, index: number, indent: string, marker: string): string {
    const tight = list.attrs.tight as boolean | undefined;
    const key = `${indent}\u0000${marker}\u0000${String(tight)}`;
    const known = itemCache.get(item);
    if (known !== undefined && known.key === key) {
        return known.text;
    }
    const serializer = currentWriter();
    const State = MarkdownSerializerState as unknown as new (nodes: unknown, marks: unknown, options: unknown) => MarkdownSerializerState;
    const state = new State(serializer.nodes, serializer.marks, serializer.options);
    const st = internals(state);
    st.inTightList = tight;
    state.wrapBlock(indent, marker, list, () => state.render(item, list, index));
    itemCache.set(item, { key, text: st.out });
    return st.out;
}

/**
 * The parts of the top-level `block` the save writes, each as the parser
 * reads it on its own exactly as it reads it in the block: a list's items,
 * each as `renderList` writes it (`itemMarkdown`) — markdown-it reads an item
 * by its own lines, which the writer indents — and the list's literal with
 * the last (`withBlockSuffix`); a table's rows, each under the table's header
 * and delimiter rows as `tableLines` writes them, the table's literal with
 * the last; a quote's, a container's and an admonition's blocks, each inside
 * the wrapper as it writes them (`wrapperUnits`); any other block whole
 * (`serializeNode`), and none of a block that is written as it was read
 * (`SOURCE_NODES`). A keystroke in a long list, table or wrapper so writes and
 * parses one part again, not all. Remembered by the node.
 */
function unitsOf(block: Node): WrittenUnit[] {
    const known = unitsCache.get(block);
    if (known !== undefined) {
        return known;
    }
    const name = block.type.name;
    // The block's own literal, given to the block itself (not the stand-in it is read from), so a refusal names it as the block's.
    const ownLiteral = () => writtenLiterals(block.type.create({ ...block.attrs }), true).map(literal => ({ ...literal, node: block }));
    let units: WrittenUnit[] = [];
    const wrapped = WRAPPERS.has(name) ? wrapperUnits(block) : null;
    if (SOURCE_NODES.has(name)) {
        // Written as it was read, always.
    } else if (wrapped !== null) {
        units = wrapped;
    } else if (name === 'bullet_list' || name === 'ordered_list') {
        const { indent, marker } = listMarkers(block);
        const listLiteral = ownLiteral();
        block.forEach((item, offset, i) => {
            const last = i === block.childCount - 1;
            const text = itemMarkdown(block, item, i, indent, marker(i));
            const written = last ? withBlockSuffix(block, text) : text;
            units.push({
                text: written,
                key: written,
                anchor: item,
                literals: [...(last ? listLiteral : []), ...writtenLiterals(item, false)],
                textblocks: inlineTextblocks(item, 1 + offset),
                from: 1 + offset,
                to: 1 + offset + item.nodeSize,
            });
        });
    } else if (name === 'table') {
        const lines = tableLines(block);
        const head = block.firstChild;
        const headCells = head === null ? [] : inlineTextblocks(head, 1);
        const cells = (row: Node | null) => {
            const out: string[] = [];
            row?.forEach(cell => {
                out.push(tableCellMarkdown(cell));
            });
            return JSON.stringify(out);
        };
        const headKey = cells(head);
        block.forEach((row, offset, i) => {
            const last = i === block.childCount - 1;
            const text = i === 0 ? `${lines[0]}\n${lines[1]}` : `${lines[0]}\n${lines[1]}\n${lines[i + 1]}`;
            const suffix = last ? withBlockSuffix(block, '\u0000') : '';
            units.push({
                text: last ? withBlockSuffix(block, text) : text,
                key: `${headKey}\n${i === 0 ? '' : cells(row)}\n${suffix}`,
                anchor: row,
                literals: last ? ownLiteral() : [],
                textblocks: i === 0 ? headCells : [...headCells, ...inlineTextblocks(row, 1 + offset)],
                from: 1 + offset,
                to: 1 + offset + row.nodeSize,
            });
        });
    } else {
        const text = serializeNode(block, writeOptions);
        units.push({
            text,
            key: text,
            anchor: block,
            literals: writtenLiterals(block, true),
            textblocks: inlineTextblocks(block, 0),
            from: 0,
            to: block.nodeSize,
        });
    }
    unitsCache.set(block, units);
    return units;
}

/** The blocks that write their blocks inside them by a prefix or a fence (`wrapperUnits`). */
const WRAPPERS: ReadonlySet<string> = new Set(['blockquote', 'container', 'admonition']);

/** A wrapper's block as its wrapper writes it (`wrappedMarkdown`), by the block and the wrapper's prefix. */
let wrappedCache = new WeakMap<Node, { key: string; text: string }>();

/**
 * A block of a quote or an admonition as its wrapper writes it, with the
 * wrapper's `prefix` on each line (`wrapBlock`, as `blockSerializer` writes
 * them), or of a container at its own indentation: the very calls the
 * wrapper's writer makes for it, on a state of its own, without the separator
 * before it.
 */
function wrappedMarkdown(wrapper: Node, child: Node, index: number, prefix: string | null): string {
    const key = prefix ?? '\u0000';
    const known = wrappedCache.get(child);
    if (known !== undefined && known.key === key) {
        return known.text;
    }
    const serializer = currentWriter();
    const State = MarkdownSerializerState as unknown as new (nodes: unknown, marks: unknown, options: unknown) => MarkdownSerializerState;
    const state = new State(serializer.nodes, serializer.marks, serializer.options);
    if (prefix === null) {
        state.render(child, wrapper, index);
    } else {
        state.wrapBlock(prefix, null, wrapper, () => state.render(child, wrapper, index));
    }
    const text = internals(state).out;
    wrappedCache.set(child, { key, text });
    return text;
}

/**
 * A quote's, a container's or an admonition's parts, as lists are read by
 * item: each block in it, written as the wrapper writes it
 * (`wrappedMarkdown`), inside the wrapper — after the `> ` it writes on each
 * line, between a container's fences (lengthened as its writer lengthens them
 * past a line of colons, `containerFence`), under an admonition's opening
 * line. markdown-it reads each of them inside the wrapper as it reads it among
 * the others: the wrapper writes a blank line between two. A quote's literal
 * is written as its `> {…}` line after the paragraph that takes it
 * (`quoteLiteralHost`, `withBlockSuffix`) and read with it. `null` — the
 * wrapper read whole — for a container's or an admonition's literal, which
 * the editor never writes but keeps.
 */
function wrapperUnits(block: Node): WrittenUnit[] | null {
    const name = block.type.name;
    const suffix = (block.attrs.attrsSuffix as string | null | undefined) ?? null;
    if (suffix !== null && name !== 'blockquote') {
        return null;
    }
    const host = suffix !== null && quoteTakesLiteral(block) ? quoteLiteralHost(block) : null;
    const units: WrittenUnit[] = [];
    block.forEach((child, offset, i) => {
        let text: string;
        if (name === 'blockquote') {
            text = wrappedMarkdown(block, child, i, '> ') + (child === host ? `\n> ${suffix}` : '');
        } else if (name === 'admonition') {
            text = `${admonitionHeader(block)}\n${wrappedMarkdown(block, child, i, ADMONITION_INDENT)}`;
        } else {
            const markup = String(block.attrs.markup || ':::');
            const container = block.attrs.name as string;
            const body = wrappedMarkdown(block, child, i, null);
            const fence = containerFence(markup, body);
            text = `${fence}${container === '' ? '' : ` ${container}`}${block.attrs.info as string}\n${body}\n${fence}`;
        }
        units.push({
            text,
            key: text,
            anchor: child,
            literals: [...(child === host ? [{ literal: suffix as string, token: 'blockquote_open', node: block }] : []), ...writtenLiterals(child, false)],
            textblocks: inlineTextblocks(child, 1 + offset),
            from: 1 + offset,
            to: 1 + offset + child.nodeSize,
        });
    });
    return units;
}
/** What the page's engine reads in a part's text (`readUnit`). */
interface UnitRead {
    /** Each token of the stream markdown-it-attrs gave attributes, in order, with what it gave. */
    blocks: { type: string; given: AttrPair[] }[];
    /** Each attribute span read, in order, with what markdown-it-attrs gave it, and the inline token it stands in (`inlines`). */
    spans: { given: AttrPair[]; inline: number }[];
    /** Each sidebar read, in order, its kind, its text between the markers (`sidebarBody`) and the inline token it stands in. */
    sidebars: { kind: string; body: string; inline: number }[];
    /** How many inline tokens it holds, an admonition's title's aside: one per paragraph with text, heading and cell. */
    inlines: number;
    /** Whether markdown-it-attrs gave attributes to an inline token other than a span. */
    madeInline: boolean;
    /** Whether VS Code's math (its stand-in) read a formula: the page holds none in a block it edits. */
    math: boolean;
}

/** What each part's text reads as, by the text; the oldest is dropped first. */
const unitReadCache = new Map<string, UnitRead>();
/** How many texts `unitReadCache` keeps: more than a long list's items, so typing in one never parses the others again. */
const UNIT_READ_CACHE_SIZE = 4096;

/**
 * A sidebar's text between its markers as the read-back compares it: every run
 * of white space one space — the wrap breaks a line at a space — and no
 * backslash escape, which the wrap adds to a word it puts at a line start.
 */
function sidebarBody(text: string): string {
    return text.replace(/\\(?=[^\s\w])/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * `text`, a part as the save writes it, parsed whole by the page's engine with
 * markdown-it-attrs where the host runs it (`attrsEngineFor`), as the preview
 * reads it: what the plugin gave each token (`attrsGivenTo`) — nothing where
 * it does not run — every span and every sidebar. Remembered by the text.
 */
function readUnit(text: string, key = text): UnitRead {
    let read = unitReadCache.get(key);
    if (read !== undefined) {
        unitReadCache.delete(key);
        unitReadCache.set(key, read);
        return read;
    }
    const tokens = attrsEngineFor(currentInlineDefinition()).parse(text, {});
    read = { blocks: [], spans: [], sidebars: [], inlines: 0, madeInline: false, math: false };
    const found = read;
    const walk = (children: readonly Token[]) => {
        for (const child of children) {
            const given = attrsGivenTo(child).map(([n, v]) => [n, v] as AttrPair);
            if (child.type === 'span_open') {
                found.spans.push({ given, inline: found.inlines });
            } else if (given.length > 0) {
                found.madeInline = true;
            }
            found.math ||= child.type.startsWith('math_');
            walk(child.children ?? []);
        }
    };
    tokens.forEach((token, i) => {
        found.math ||= token.type.startsWith('math_');
        if (token.type !== 'inline') {
            const given = attrsGivenTo(token).map(([n, v]) => [n, v] as AttrPair);
            if (given.length > 0) {
                found.blocks.push({ type: token.type, given });
            }
            return;
        }
        // An admonition's title is its node's string, not a textblock: nothing in it is read back.
        if (tokens[i - 1]?.type === 'admonition_title_open') {
            return;
        }
        walk(token.children ?? []);
        for (const sidebar of sidebarsIn([token])) {
            found.sidebars.push({ kind: sidebar.kind, body: sidebarBody(token.content.slice(sidebar.open + 1, sidebar.close)), inline: found.inlines });
        }
        found.inlines++;
    });
    if (unitReadCache.size >= UNIT_READ_CACHE_SIZE) {
        unitReadCache.delete(unitReadCache.keys().next().value as string);
    }
    unitReadCache.set(key, read);
    return read;
}

/**
 * What a run of tokens reads as, for comparing the leader's reading in a pair
 * with its reading alone: every token's kind, text and attributes, its inline
 * children's too — not its `map`, which takes in the blank lines after it.
 */
function readingOf(tokens: readonly Token[]): string {
    const one = (token: Token): unknown[] => [token.type, token.tag, token.nesting, token.content, token.markup, token.info, token.attrs, (token.children ?? []).map(one)];
    return JSON.stringify(tokens.map(one));
}

/**
 * Whether a seam holds (`seamHolds`), by a digest of the leader, the separator
 * and the follower (`textKey`) — not the texts, which for a long list beside a
 * paragraph being typed in would keep a copy of the list per keystroke; the
 * oldest is dropped first.
 */
const seamCache = new Map<string, boolean>();
/** How many seams `seamCache` keeps: a document's seams several times over. */
const SEAM_CACHE_SIZE = 1024;

/** A 53-bit digest of `text` (cyrb53) and its length, for a cache key that does not hold the text. */
function textKey(text: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${text.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * Whether the page's engine with markdown-it-attrs (`attrsEngineFor`, the one
 * `readUnit` reads with) reads `leader + separator + follower` as two blocks
 * meeting where they were written: no top-level token's `map` crosses the
 * follower's first line, and either a top-level token opens on that line or
 * — a follower that yields no token, a reference definition — the leader's
 * tokens are what the leader alone reads as. Without the second half a
 * follower the leader swallowed would hold: a `{.a}` paragraph under a table
 * yields no token because markdown-it-attrs gave its class to the table. A
 * top-level block starts with the parser's block state fresh, so the pair
 * reads as it reads in the document. Remembered by a digest of the three texts.
 */
export function seamHolds(leader: string, separator: string, follower: string): boolean {
    const key = `${textKey(leader)}|${JSON.stringify(separator)}|${textKey(follower)}`;
    const known = seamCache.get(key);
    if (known !== undefined) {
        seamCache.delete(key);
        seamCache.set(key, known);
        return known;
    }
    // markdown-it reads `\r\n` as one line break, so counting `\n` counts its lines.
    const line = ((leader + separator).match(/\n/g) ?? []).length;
    const md = attrsEngineFor(currentInlineDefinition());
    const tokens = md.parse(leader + separator + follower, {});
    const mapOf = (token: Token) => token.map as number[] | null;
    let holds = !tokens.some(token => {
        const map = mapOf(token);
        return token.level === 0 && map !== null && map[0] < line && line < map[1];
    });
    if (holds && !tokens.some(token => token.level === 0 && mapOf(token)?.[0] === line)) {
        const next = tokens.findIndex(token => token.level === 0 && (mapOf(token)?.[0] ?? -1) >= line);
        holds = readingOf(next < 0 ? tokens : tokens.slice(0, next)) === readingOf(md.parse(leader, {}));
    }
    if (seamCache.size >= SEAM_CACHE_SIZE) {
        seamCache.delete(seamCache.keys().next().value as string);
    }
    seamCache.set(key, holds);
    return holds;
}

/** The kind and marker (`-`, `*`, `+`, or the delimiter `.`, `)`) of the top-level list `text` opens with, or with `last` ends with; `null` where it does not. */
function listMarkerOf(text: string, last: boolean): { kind: string; marker: string } | null {
    const top = attrsEngineFor(currentInlineDefinition()).parse(text, {}).filter(token => token.level === 0);
    const token = last ? top[top.length - 1] : top[0];
    const kind = /^(bullet|ordered)_list_(?:open|close)$/.exec(token?.type ?? '');
    return kind === null ? null : { kind: kind[1], marker: token.markup };
}

/**
 * `follower`, which opens with a list of the kind `leader` ends with, written
 * with each other marker for that list — CommonMark starts a new list at a
 * changed bullet or delimiter, which no number of blank lines does — in order
 * of preference: a marker the list after it (`next`) opens with comes last, so
 * the new list does not join that one. Only the list's own items change, at the
 * line and column their `list_item_open` token gives; every other character of
 * the follower, its `src` included, is kept. None where the pair is no such pair
 * or an item's marker is not where its token says.
 */
function remarkedList(leader: string, follower: string, next: () => string | null): string[] {
    const ends = listMarkerOf(leader, true);
    const opens = listMarkerOf(follower, false);
    if (ends === null || opens === null || ends.kind !== opens.kind) {
        return [];
    }
    const after = listMarkerOf(next() ?? '', false);
    const markers = (opens.kind === 'bullet' ? ['-', '*', '+'] : ['.', ')']).filter(m => m !== ends.marker);
    markers.sort((a, b) => Number(a === after?.marker) - Number(b === after?.marker));
    const tokens = attrsEngineFor(currentInlineDefinition()).parse(follower, {});
    const close = tokens.findIndex(token => token.level === 0 && token.nesting === -1);
    const items = tokens.slice(0, close).filter(token => token.type === 'list_item_open' && token.level === 1);
    const out: string[] = [];
    for (const marker of markers) {
        const lines = follower.split('\n');
        for (const item of items) {
            const line = (item.map as number[])[0];
            if (lines[line] === undefined) {
                return [];
            }
            // The marker after the item's indent and, for an ordered item, its number.
            const at = (/^[ \t]*\d*/.exec(lines[line]) as RegExpExecArray)[0].length;
            if (lines[line][at] !== item.markup) {
                return [];
            }
            lines[line] = lines[line].slice(0, at) + marker + lines[line].slice(at + 1);
        }
        out.push(lines.join('\n'));
    }
    return out;
}

/**
 * A literal that does not read back as written, or — `literal` `null` — text
 * the parser reads as attributes no literal gives; `at`, the node it is
 * written on or in, where it is known.
 */
export interface LiteralLoss {
    literal: string | null;
    at?: Node;
}

/** Where a part does not read back as it is shown (`unitVerdict`): the first literal, else the first sidebar. */
interface UnitVerdict {
    lost: LiteralLoss | null;
    mismatch: SidebarMismatch | null;
}

/**
 * Each item of `wanted` matched, in order, to the next item of `found` that is
 * the same (`same`): the first wanted one that is not there, and the first
 * found one no wanted one took.
 */
function matchInOrder<W, F>(wanted: readonly W[], found: readonly F[], same: (w: W, f: F) => boolean): { missing?: W; extra?: F } {
    const taken = new Set<number>();
    let from = 0;
    let missing: W | undefined;
    for (const w of wanted) {
        let i = from;
        while (i < found.length && !same(w, found[i])) {
            i++;
        }
        if (i < found.length) {
            taken.add(i);
            from = i + 1;
        } else {
            missing ??= w;
        }
    }
    const extra = found.find((_, i) => !taken.has(i));
    return { missing, extra };
}

/** The verdict of each part, by the node it is written from, with the text it was given for. */
let verdictCache = new WeakMap<Node, { key: string; verdict: UnitVerdict | null }>();

/**
 * How `unit`, as the save writes it, reads back, if not as the page shows it
 * (`readUnit`): the first literal the page shows that does not come back on
 * the token markdown-it-attrs gives it to — a block's, an item's, a heading's,
 * a span's — or the first attributes read that no literal gives (`lost`);
 * then the first sidebar not read back, or read that the page does not show
 * (`mismatch`). `null` when it reads back as shown — at once, without a parse,
 * when its text holds neither a `{` nor a sidebar's marker. Remembered by the
 * node with the text.
 */
function unitVerdict(unit: WrittenUnit): UnitVerdict | null {
    const known = verdictCache.get(unit.anchor);
    if (known !== undefined && known.key === unit.key) {
        return known.verdict;
    }
    let verdict: UnitVerdict | null = null;
    if (/[{$@]/.test(unit.text)) {
        const read = readUnit(unit.text, unit.key);
        verdict = { lost: literalVerdict(unit, read), mismatch: sidebarVerdict(unit, read) };
        if (verdict.lost === null && verdict.mismatch === null) {
            verdict = null;
        }
    }
    verdictCache.set(unit.anchor, { key: unit.key, verdict });
    return verdict;
}

/**
 * The textblock of `unit` that the inline token `index` of its parse
 * (`UnitRead.inlines`) stands for: the parser makes one of each paragraph
 * with text, heading and cell, in order — when the counts agree; else, as
 * for a block-level token (`index` undefined), the unit's first.
 */
function textblockOfInline(unit: WrittenUnit, read: UnitRead, index?: number): Node {
    const shown = unit.textblocks.filter(({ node }) => node.type.name !== 'paragraph' || writtenOf(node).text.trim() !== '');
    return (index !== undefined && shown.length === read.inlines ? shown[index]?.node : undefined) ?? unit.textblocks[0]?.node ?? unit.anchor;
}

/** The first literal of `unit` that `read` does not give back, its spans' first, or attributes it reads that none gives. */
function literalVerdict(unit: WrittenUnit, read: UnitRead): LiteralLoss | null {
    const spans = unit.textblocks.flatMap(({ node }) => spanLiteralsIn(node).map(literal => ({ literal, key: attrsKey(literalPairs(literal)), at: node })));
    const spanMatch = matchInOrder(spans, read.spans, (w, f) => w.key === attrsKey(f.given));
    if (spanMatch.missing !== undefined) {
        return { literal: spanMatch.missing.literal, at: spanMatch.missing.at };
    }
    const blockMatch = matchInOrder(unit.literals, read.blocks, (w, f) => w.token === f.type && sameAttrs(f.given, literalPairs(w.literal)));
    if (blockMatch.missing !== undefined) {
        return { literal: blockMatch.missing.literal, at: blockMatch.missing.node };
    }
    if (spanMatch.extra !== undefined || blockMatch.extra !== undefined || read.madeInline) {
        return { literal: null, at: textblockOfInline(unit, read, spanMatch.extra?.inline) };
    }
    return null;
}

/**
 * The first sidebar of `unit` that `read` does not read back, else the first
 * it reads that `unit` does not hold, else a formula VS Code's math reads in
 * it (a `$…$` the page holds as text, which a web address held until the
 * edit, say); `null` when they are the same.
 */
function sidebarVerdict(unit: WrittenUnit, read: UnitRead): SidebarMismatch | null {
    const held = unit.textblocks.flatMap(({ node }) => {
        const written = writtenOf(node);
        return written.sidebars.map(sidebar => ({ sidebar, written, at: node, body: sidebarBody(written.text.slice(sidebar.open + 1, sidebar.close)) }));
    });
    const match = matchInOrder(held, read.sidebars, (w, f) => w.sidebar.kind === f.kind && w.body === f.body);
    if (match.missing !== undefined) {
        return { written: match.missing.written, lost: match.missing.sidebar, at: match.missing.at };
    }
    if (match.extra !== undefined || read.math) {
        const at = textblockOfInline(unit, read, match.extra?.inline);
        return { written: writtenOf(at), at, math: match.extra === undefined };
    }
    return null;
}

/** Forget every part, read and verdict: the engine or the options they were made with changed. */
function forgetReadBack(): void {
    unitsCache = new WeakMap();
    itemCache = new WeakMap();
    wrappedCache = new WeakMap();
    verdictCache = new WeakMap();
    unitReadCache.clear();
    seamCache.clear();
}

/**
 * The first literal the top-level `block` holds that does not read back as it
 * is, or text it would read as attributes, once the save writes it — read as
 * the edit filter reads it (`unitVerdict`) — or `null`: the one question
 * `attrsReadAt` cannot answer, the literal alone. A literal is judged where it
 * is written with everything the preview reads with it — `A [x]{title="a $b"}
 * c. {title="d$ e"}` is math under VS Code's math and a left sidebar without
 * it, either literal alone is neither.
 */
export function literalNotReadBack(block: Node): LiteralLoss | null {
    for (const unit of unitsOf(block)) {
        const lost = unitVerdict(unit)?.lost ?? null;
        if (lost !== null) {
            return lost;
        }
    }
    return null;
}

/**
 * Whether every literal the top-level `block` holds reads back as it is
 * (`literalNotReadBack`). Asked by the Attributes field and a span's
 * (`literalsReadBackRefusal`) and of a copy's literal (`fidelity.ts`).
 */
export function literalsReadBack(block: Node): boolean {
    return literalNotReadBack(block) === null;
}

/**
 * One inline node written on its own, as in the middle of a line — a note's
 * `++reference|note++`, say — by the same rules a paragraph holding it is
 * written with, the node's own marks included. Hold markers are stripped; a
 * hard break inside is `\` + newline.
 */
export function serializeInline(node: Node): string {
    return inlineMarkdown(editorSchema.nodes.paragraph.create(null, node), false).replace(HOLD_RE, '');
}

/** One editable node written by rule, with `\n` line breaks and no trailing newline. */
export function serializeNode(node: Node, options: SerializeOptions): string {
    const doc = editorSchema.topNodeType.create(null, [node]);
    return withBlockSuffix(node, blockSerializer(options).serialize(doc));
}

/**
 * Write the document back to text.
 *
 * Each top-level node contributes its `gap` and then its body: its `src` when it
 * has one, its serialization when it is an editable node whose `src` was
 * cleared, nothing when it is an injected atom (or an editable node left empty).
 * A `gap` of `null` — a node the UI inserted — is one blank line, or what the
 * parser needs to read the pair as two (`serializeLayout`). Then the
 * `tail`. A changed block is written with the document's `eol` and ends with
 * one, so a changed last line of a file that had no final newline gains one.
 * What the engine reads as syntax is escaped by the engine the page reads
 * with (`setInlineEngine`), whether it reads wiki embeds among it.
 */
export function serializeDocument(parsed: { doc: Node; eol: '\n' | '\r\n'; tail: string }, options: SerializeOptions): string {
    return serializeLayout(parsed, options).text;
}

/** Where one top-level node's text stands in the text `serializeLayout` writes. */
export interface BlockSpan {
    /** The offset of the node's body in the text: after its gap and any separator. */
    start: number;
    /**
     * The body as written — its `src`, or its serialization with the document's
     * `eol` and a final one — and `''` for a node that writes nothing (an
     * injected atom, an editable node left empty), whose `start` is where it
     * would have stood.
     */
    body: string;
}

/** The document's text and, for every top-level node in order, where its body stands in it. */
export interface SerializedLayout {
    text: string;
    blocks: BlockSpan[];
}

/**
 * `serializeDocument`, with the place of every top-level node's body in the
 * result: the one loop that decides the text, so the position mapping
 * (`positions.ts`) reads the offsets from where they are made rather than
 * counting them a second time.
 */
export function serializeLayout(parsed: { doc: Node; eol: '\n' | '\r\n'; tail: string }, options: SerializeOptions): SerializedLayout {
    const { doc, eol, tail } = parsed;
    const serializer = blockSerializer(options);
    const blocks: BlockSpan[] = [];
    let out = '';
    // The last node that wrote a body: the leader of the next seam. A node that writes nothing makes no seam of its own.
    // `remarked`: its text is not the one it was read or would be written as, so the seam after it is new too.
    let prev: { node: Node; body: string; remarked: boolean } | null = null;
    const endsLine = (text: string) => text.endsWith('\n') || text.endsWith('\r');
    const lines = (text: string) => (text.match(/\n/g) ?? []).length;
    /** Whether a node is written by rule: an editable node an edit cleared the `src` of. */
    const byRule = (node: Node): boolean => {
        const src = node.attrs.src as string | null | undefined;
        return node.type.name !== 'front_matter' && !SOURCE_NODES.has(node.type.name) && (src === null || src === undefined);
    };
    /** A node's text: its `src`, or its serialization with the document's `eol` and a final one. */
    const bodyOf = (node: Node): string => {
        if (!byRule(node)) {
            return (node.attrs.src as string | null | undefined) ?? '';
        }
        const text = withBlockSuffix(node, serializer.serialize(editorSchema.topNodeType.create(null, [node])));
        return text === '' ? '' : text.replace(/\r?\n/g, eol) + eol;
    };
    /**
     * A seam the parser does not read as two blocks, mended by the first rung
     * it does: one blank line, two, then (a list after a list of its kind) the
     * follower's own text with its items' marker changed (`remarkedList`). A
     * rung never narrows the separator. `next` is the text of the block after
     * the follower, whose list a new marker should not join.
     */
    const mended = (leader: string, lead: string, sep: string, body: string, next: () => string | null): { sep: string; body: string } => {
        const blank = lead + eol;
        for (const wider of [blank, blank + eol]) {
            if (lines(wider) > lines(sep) && seamHolds(leader, wider, body)) {
                return { sep: wider, body };
            }
        }
        const otherSep = lines(sep) >= lines(blank) ? sep : blank;
        for (const remarked of remarkedList(leader, body, next)) {
            if (seamHolds(leader, otherSep, remarked)) {
                return { sep: otherSep, body: remarked };
            }
        }
        // Nothing on the ladder holds (an indented code block under a list): written as it would have been. Reporting it is a follow-up.
        return { sep, body };
    };
    /** The body of the first node after `index` that writes one, or `null`. */
    const bodyAfter = (index: number): string | null => {
        for (let j = index + 1; j < doc.childCount; j++) {
            const body = bodyOf(doc.child(j));
            if (body !== '') {
                return body;
            }
        }
        return null;
    };
    // Whether a node between `prev` and the next body wrote nothing: the two meet where the file never had them meet.
    let skipped = false;
    doc.forEach((node, _offset, index) => {
        let body = bodyOf(node);
        if (body === '') {
            blocks.push({ start: out.length, body: '' });
            skipped = prev !== null;
            return;
        }
        let sep = '';
        let remarked = false;
        if (prev !== null) {
            const lead = endsLine(prev.body) ? '' : eol;
            const gap = node.attrs.gap as string | null | undefined;
            sep = lead + (gap === null || gap === undefined ? eol : gap);
            // A seam this write makes new is read back; one the file holds (both from their slices, the gap kept, nothing between) is not.
            const isNew = gap === null || gap === undefined || skipped || prev.remarked || byRule(prev.node) || byRule(node);
            if (isNew && !seamHolds(prev.body, sep, body)) {
                const written = body;
                ({ sep, body } = mended(prev.body, lead, sep, body, () => bodyAfter(index)));
                remarked = body !== written;
            }
        } else {
            sep = (node.attrs.gap as string | null | undefined) ?? '';
        }
        out += sep;
        blocks.push({ start: out.length, body });
        out += body;
        prev = { node, body, remarked };
        skipped = false;
    });
    if (tail !== '' && out !== '' && !endsLine(out)) {
        out += eol;
    }
    return { text: out + tail, blocks };
}
