/* eslint-disable @typescript-eslint/naming-convention -- the serializer tables are keyed by the schema's node names, which ProseMirror spells in snake_case */
import { MarkdownSerializer, MarkdownSerializerState } from 'prosemirror-markdown';
import { Mark, Node } from 'prosemirror-model';
import { SOURCE_NODES, editorSchema } from './schema';
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
}

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
function destination(href: string): string {
    const decoded = href.replace(/(?:%[89A-Fa-f][0-9A-Fa-f])+/g, seq => {
        try {
            return decodeURIComponent(seq);
        } catch {
            return seq;
        }
    });
    // A space or control character ends a destination; markdown-it never
    // produces one, but a link the UI set can hold one.
    return decoded
        .replace(/[\x00-\x20\x7f]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
        .replace(/[()]/g, '\\$&');
}

function titlePart(title: string | null): string {
    return title ? ` "${title.replace(/"/g, '\\"')}"` : '';
}

/**
 * How a link is written: a bare URL stays bare and an `<…>` autolink stays one,
 * as long as the link is still one unmarked text node that can be written that
 * way; otherwise `[text](destination)`.
 */
function linkForm(mark: Mark, parent: Node, index: number): LinkForm {
    const node = parent.child(index);
    const markup = mark.attrs.markup as string | null;
    if (markup === null || !node.isText || mark.attrs.title) {
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
            const form = linkForm(mark, parent, index);
            const st = internals(state);
            st.linkForm = form;
            if (form === 'inline') {
                return '[';
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
            return HOLD_OPEN + '](' + destination(mark.attrs.href as string) + titlePart(mark.attrs.title as string | null) + ')' + HOLD_CLOSE;
        },
        mixable: true,
    },
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
        state.text(text, !internals(state).inAutolink);
    },
    image(state, node) {
        const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
        state.write('![' + state.esc(alt ?? '') + ']' + HOLD_OPEN + '(' + destination(src) + titlePart(title) + ')' + HOLD_CLOSE);
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
};

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
            let text = inlineMarkdown(node, false).replace(HOLD_RE, '').replace(/\s+$/, '');
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
