/* eslint-disable @typescript-eslint/naming-convention -- the serializer tables are keyed by the schema's node names, which ProseMirror spells in snake_case */
import { MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown';
import { Mark, Node } from 'prosemirror-model';
import { INLINE_MARKERS, KBD_MARKERS, NOTE_SEPARATOR, NOTE_SYNTAX } from '../syntax/markers';
import { NOTE_SYNTAX_CHARS } from './attrs';
import { MDTable, TableAlign as MDTableAlign } from '../services/table/mdTable';
import { NOTE_NODES, SOURCE_NODES, TableAlign, editorSchema } from './schema';
import { HOLD_CLOSE, HOLD_OPEN, HOLD_RE, width, wrapInline } from './wrap';

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
 * The parts of a note whose text needs more than CommonMark escaping, because
 * `markdownItSidenote.ts` finds their ends in the raw source, before any
 * backslash escape is read: a reference ends at the first `|`, a left
 * sidebar at the next `$`, a right one at the next `@`. Those characters are
 * written as numeric character references there, which the inline parser of
 * the part turns back into the character. A note ends at its marker pair,
 * which the escape of `ESCAPE_EXTRA` breaks up in text (`\+\+`); in a link's
 * destination and title, which take no backslash escape, a run of the marker
 * character is percent-encoded or a character reference (`breakMarkerRuns`),
 * and a bare or angle link holding it is written inline. Text under the
 * raw marks — code, and the terminator under sup and sub — has no escape at
 * all; the editor refuses to make it (`unwritableInNote`).
 */
type NotePart = 'ref' | 'body' | 'left' | 'right';

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

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/**
 * What prosemirror-markdown's CommonMark escaping does not cover and this
 * engine would otherwise read as syntax: an HTML tag or entity (`html: true`),
 * `==mark==`, `^sup^`, `++sidenote++`, `!!marginal note!!`, the sidebars'
 * `$`/`@` (the sidebar rule pairs any two in a paragraph) and an emoji
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
    return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * `*`/`**` unless the source wrote `_`/`__` (`markdown-it-ib` renders the two
 * differently, so the delimiter is content). `_` cannot open or close inside a
 * word, so an edit that glued the span to a letter falls back to `*` — for both
 * ends, decided over the whole span, so they always match.
 */
function emphasisDelimiter(mark: Mark, parent: Node, index: number, opening: boolean, star: string): string {
    const markup = String(mark.attrs.markup || star);
    if (!markup.startsWith('_')) {
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
        open: '[',
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
                if (/(^|[^\\])!$/.test(st.out)) {
                    st.out = st.out.slice(0, -1) + '\\!';
                }
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
    kbd: { open: HOLD_OPEN + KBD_MARKERS.open, close: KBD_MARKERS.close + HOLD_CLOSE, mixable: true },
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
        // Never at a line start: the note's opening marker is before it.
        state.text(partText(st.notePart, state.esc(text, false)), false);
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

/** The terminator each note part must not hold raw (`PART_TERMINATORS`), by the node holding the part's text. */
const TERMINATOR_OF_PART: Readonly<Record<string, string>> = {
    note_ref: PART_TERMINATORS.ref?.raw ?? '|',
    left_sidebar: PART_TERMINATORS.left?.raw ?? '$',
    right_sidebar: PART_TERMINATORS.right?.raw ?? '@',
};

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
    for (const part of marker === null ? [note] : parts) {
        const terminator = TERMINATOR_OF_PART[part.type.name] ?? null;
        let reason: string | null = null;
        part.forEach(child => {
            if (reason !== null || !child.isText) {
                return;
            }
            const text = child.text ?? '';
            const code = child.marks.some(m => m.type.name === 'code');
            const raw = code || child.marks.some(m => RAW_TEXT_MARKS.has(m.type.name));
            const span = child.marks.find(m => m.type.name === 'attr_span' && NOTE_SYNTAX_CHARS.test(m.attrs.literal as string));
            if (span !== undefined) {
                reason = `An attribute span in a note cannot hold ${span.attrs.literal as string}: its literal is written as it is, and the notes plugin would read a marker in it.`;
            } else if (raw && terminator !== null && text.includes(terminator)) {
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
 * Why a note or sidebar between `from` and `to` cannot be written so that it
 * reads back as itself, or `null` — the one thing the serializer cannot do,
 * so the editor refuses the edit that would make it (`webview/notes.ts`)
 * rather than save a document the next parse restructures: a raw mark over a
 * note, or text under a raw mark that holds the part's terminator or the
 * note's marker pair.
 */
export function unwritableInNote(doc: Node, from = 0, to = doc.content.size): string | null {
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
    return reason;
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

/** The plugin refuses a reference with no text (`++ |note++` is prose); an image counts, as its source is not blank. */
function writableReference(ref: Node): boolean {
    let writable = ref.textContent.trim() !== '';
    ref.forEach(child => {
        writable = writable || child.type.name === 'image';
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
    state.text(marker, false);
    renderPart(state, node, part);
    state.text(marker, false);
}

/**
 * In a table cell a `|` in text is a cell boundary to the table plugin, so it
 * is escaped where every other character the engine would read as syntax is:
 * in the text, the alt text and a sidebar's text, as `\|`. What is written
 * verbatim — code, an attribute span's literal — gets no escape; a `|` there
 * has no spelling and is not made (`unwritableInTable`).
 */
const ESCAPE_IN_CELL = new RegExp(`${ESCAPE_EXTRA.source}|\\|`, 'g');

function inlineSerializer(fromBlockStart: boolean, inTableCell = false): MarkdownSerializer {
    return new MarkdownSerializer({
        ...inlineNodes,
        paragraph(state, node) {
            internals(state).inTableCell = inTableCell;
            state.renderInline(node, fromBlockStart);
            state.closeBlock(node);
        },
    }, marks, { escapeExtraCharacters: inTableCell ? ESCAPE_IN_CELL : ESCAPE_EXTRA });
}

const inlineAtStart = inlineSerializer(true);
const inlineMidLine = inlineSerializer(false);
const inlineInCell = inlineSerializer(false, true);

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

/** One cell's inline content as the tidy form writes it (see above), unpadded. */
export function tableCellMarkdown(cell: Node): string {
    const paragraph = editorSchema.nodes.paragraph.create(null, cell.content);
    const written = inlineInCell.serialize(editorSchema.topNodeType.create(null, [paragraph]))
        .replace(BACKSLASH_BEFORE_CODE, '&#92;')
        .replace(HOLD_RE, '')
        .replace(/\r?\n/g, ' ')
        .trim();
    return READS_AS_DELIMITER.test(written) ? `\\${written}` : written;
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
    return (fromBlockStart ? inlineAtStart : inlineMidLine).serialize(doc);
}

function blockSerializer(options: SerializeOptions): MarkdownSerializer {
    return new MarkdownSerializer({
        ...inlineNodes,
        paragraph(state, node) {
            // Flush the pending block separator and write the line prefix first,
            // so the column the first line starts at is known.
            state.write();
            const st = internals(state);
            const column = width(st.out.slice(st.out.lastIndexOf('\n') + 1));
            const limit = (node.attrs.wrapWidth as number | null)
                ?? Math.max(options.defaultWrap, (node.attrs.lineWidth as number | null) ?? 0);
            const lines = wrapInline(inlineMarkdown(node, true), limit - column, limit - width(st.delim));
            state.text(lines.join('\n'), false);
            state.closeBlock(node);
        },
        heading(state, node) {
            const suffix = node.attrs.attrsSuffix as string | null;
            // A heading is one line; a hard break a note inside it holds is a space here.
            let text = inlineMarkdown(node, false).replace(HOLD_RE, '').replace(/\\\n/g, ' ').replace(/\s+$/, '');
            if (suffix === null && /(^| )#+$/.test(text)) {
                // A trailing ` #` run is an ATX closing sequence and would be dropped.
                text = text.replace(/#+$/, run => '\\' + run);
            }
            const line = '#'.repeat(node.attrs.level as number) + ' ' + ((node.attrs.reqPrefix as string | null) ?? '') + text;
            state.write(suffix === null ? line.replace(/\s+$/, '') : line.replace(/\s+$/, '') + ' ' + suffix);
            state.closeBlock(node);
        },
        blockquote(state, node) {
            state.wrapBlock('> ', null, node, () => state.renderContent(node));
        },
        bullet_list(state, node) {
            const bullet = String(node.attrs.bullet || '-');
            state.renderList(node, '  ', () => bullet + ' ');
        },
        ordered_list(state, node) {
            const start = Number(node.attrs.order ?? 1);
            const delimiter = String(node.attrs.delimiter || '.');
            const maxWidth = String(start + node.childCount - 1).length;
            const space = state.repeat(' ', maxWidth + 2);
            state.renderList(node, space, i => {
                const n = String(start + i);
                return state.repeat(' ', maxWidth - n.length) + n + delimiter + ' ';
            });
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
            let markup = String(node.attrs.markup ?? '```');
            if (markup === '' && content.trim() !== '') {
                // Indented, as written.
                state.text(content.split('\n').map(l => (l === '' ? '' : '    ' + l)).join('\n'), false);
                state.closeBlock(node);
                return;
            }
            if (markup === '' || (markup.startsWith('`') && params.includes('`'))) {
                markup = markup.startsWith('~') ? markup : (params.includes('`') ? '~~~' : '```');
            }
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
 * Whether a paragraph ends where a literal can be added after a space on its
 * last line: it has text, and no hard break ends it — after one the literal
 * would open a line of its own, which the plugin reads as another block's.
 */
function endsInText(paragraph: Node | null): boolean {
    return paragraph !== null && paragraph.type.name === 'paragraph' && paragraph.content.size > 0
        && paragraph.lastChild?.type.name !== 'hard_break';
}

/**
 * Whether a quote can carry a literal: markdown-it-attrs gives a `> {…}` line
 * to the quote only through the soft break of the paragraph it ends — a quote
 * whose last block is a list, code or a nested quote would hand it to that.
 * The serializer writes it only then, the fidelity plugin takes it off a quote
 * an edit left without one, and the page refuses to give one to such a quote.
 */
export function quoteTakesLiteral(quote: Node): boolean {
    return endsInText(quote.lastChild);
}

/**
 * Whether a list item can carry a literal: it is written at the end of the
 * item's first paragraph (`- text {.a}`), so the item must start with one that
 * ends in text. Read by the serializer, the fidelity plugin and the page alike.
 */
export function itemTakesLiteral(item: Node): boolean {
    return endsInText(item.firstChild);
}

/**
 * A changed top-level block's text with its attribute literal where it stood
 * (`attrsPlacement`, see `AttrsPlacement` in `blocks.ts`): after a space at the
 * end of its last line, on a line of its own under it, or — for a list — under a
 * blank line. A list whose last item the literal would no longer reach through
 * a lazy line (a second block in it, a nested list the plugin would hand the
 * literal to) takes the blank-line form, which the plugin always gives the
 * list. A quote's is `> {…}` under its last paragraph, inside it; a table's is
 * always under a blank line, the one form the plugin reads whatever follows.
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
        return quoteTakesLiteral(node) ? `${text}\n> ${suffix}` : text;
    }
    if (name === 'table') {
        return `${text}\n\n${suffix}`;
    }
    return placement === 'end' ? `${text.replace(/[ \t]+$/, '')} ${suffix}` : `${text}\n${suffix}`;
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
 * A `gap` of `null` — a node the UI inserted — is one blank line. Then the
 * `tail`. A changed block is written with the document's `eol` and ends with
 * one, so a changed last line of a file that had no final newline gains one.
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
    const atLineStart = () => out === '' || out.endsWith('\n') || out.endsWith('\r');
    doc.forEach(node => {
        const name = node.type.name;
        const src = node.attrs.src as string | null | undefined;
        let body: string;
        if (name === 'front_matter' || SOURCE_NODES.has(name) || (src !== null && src !== undefined)) {
            body = src ?? '';
        } else {
            const text = withBlockSuffix(node, serializer.serialize(editorSchema.topNodeType.create(null, [node])));
            body = text === '' ? '' : text.replace(/\r?\n/g, eol) + eol;
        }
        if (body === '') {
            blocks.push({ start: out.length, body: '' });
            return;
        }
        if (!atLineStart()) {
            out += eol;
        }
        const gap = node.attrs.gap as string | null | undefined;
        out += gap === null || gap === undefined ? (out === '' ? '' : eol) : gap;
        blocks.push({ start: out.length, body });
        out += body;
    });
    if (tail !== '' && !atLineStart()) {
        out += eol;
    }
    return { text: out + tail, blocks };
}
