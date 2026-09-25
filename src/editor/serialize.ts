/* eslint-disable @typescript-eslint/naming-convention -- the serializer tables are keyed by the schema's node names, which ProseMirror spells in snake_case */
import { MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown';
import { Mark, Node } from 'prosemirror-model';
import { INLINE_MARKERS, KBD_MARKERS, NOTE_SEPARATOR, NOTE_SYNTAX } from '../syntax/markers';
import { NOTE_NODES, SOURCE_NODES, editorSchema } from './schema';
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
function destination(href: string, part?: NotePart, noteMarker?: string): string {
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
    return breakMarkerRuns(safe, noteMarker, percent);
}

/** A link's or image's `(destination "title")` content, as a note part can hold it. */
function target(st: StateInternals, href: string, title: string | null): string {
    const titled = breakMarkerRuns(partText(st.notePart, titlePart(title)), st.noteMarker, ch => MARKER_REFERENCES[ch] ?? ch);
    return destination(href, st.notePart, st.noteMarker) + titled;
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
    const { notePart: part, noteMarker } = internals(state);
    // Bare and angle forms are written unescaped, which a note part cannot
    // take when the URL holds its terminator or the note's marker character.
    if (markup === null || !node.isText || mark.attrs.title || (part !== undefined && PART_TERMINATORS[part] !== null)
        || (noteMarker !== undefined && ((node.text ?? '') + (mark.attrs.href as string)).includes(noteMarker))) {
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
            if (raw && terminator !== null && text.includes(terminator)) {
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

function inlineSerializer(fromBlockStart: boolean): MarkdownSerializer {
    return new MarkdownSerializer({
        ...inlineNodes,
        paragraph(state, node) {
            state.renderInline(node, fromBlockStart);
            state.closeBlock(node);
        },
    }, marks, { escapeExtraCharacters: ESCAPE_EXTRA });
}

const inlineAtStart = inlineSerializer(true);
const inlineMidLine = inlineSerializer(false);

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
            state.renderContent(node);
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
            state.write(fence + params + '\n');
            state.text(content, false);
            state.write('\n');
            state.write(fence);
            state.closeBlock(node);
        },
        horizontal_rule(state, node) {
            state.write(String(node.attrs.markup || '---'));
            state.closeBlock(node);
        },
    }, marks, { escapeExtraCharacters: ESCAPE_EXTRA });
}

/** One editable node written by rule, with `\n` line breaks and no trailing newline. */
export function serializeNode(node: Node, options: SerializeOptions): string {
    const doc = editorSchema.topNodeType.create(null, [node]);
    return blockSerializer(options).serialize(doc);
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
    const { doc, eol, tail } = parsed;
    const serializer = blockSerializer(options);
    let out = '';
    const atLineStart = () => out === '' || out.endsWith('\n') || out.endsWith('\r');
    doc.forEach(node => {
        const name = node.type.name;
        const src = node.attrs.src as string | null | undefined;
        let body: string;
        if (name === 'front_matter' || SOURCE_NODES.has(name) || (src !== null && src !== undefined)) {
            body = src ?? '';
        } else {
            const text = serializer.serialize(editorSchema.topNodeType.create(null, [node]));
            body = text === '' ? '' : text.replace(/\r?\n/g, eol) + eol;
        }
        if (body === '') {
            return;
        }
        if (!atLineStart()) {
            out += eol;
        }
        const gap = node.attrs.gap as string | null | undefined;
        out += gap === null || gap === undefined ? (out === '' ? '' : eol) : gap;
        out += body;
    });
    if (tail !== '' && !atLineStart()) {
        out += eol;
    }
    return out + tail;
}
