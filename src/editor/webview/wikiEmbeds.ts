import { InputRule } from 'prosemirror-inputrules';
import { Fragment, Mark, Node, ResolvedPos, Slice } from 'prosemirror-model';
import { EditorState, Plugin } from 'prosemirror-state';
import { WIKI_EMBED_MARKERS } from '../../syntax/markers';
import { editorSchema } from '../schema';
import { RAW_TEXT_MARKS } from '../serialize';

/**
 * A wiki embed typed as text (`![[img.png]]`), or in plain text pasted from
 * outside the editor, becomes the atom the editor reads one as (`wiki_embed`,
 * `markdownItWikiEmbed.ts`), so it is saved as written instead of as escaped
 * text. Only where the engine reads embeds (the page's `enabled`), never in
 * code or under superscript or subscript, whose text is read as it is, and
 * only an embed of the shape the plugin reads: `![[`, a name with no bracket
 * and no line break, `]]`.
 *
 * Text that is already in the document is never made an embed: a cut and
 * paste or a drag inside the editor carries its own nodes (an atom stays one,
 * literal text stays text), and the rule fires on the `]` just typed, not on
 * the end of a composition.
 */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME = '[^[\\]\\n\\ufffc]+';
const EMBED_SOURCE = `${escape(WIKI_EMBED_MARKERS.open)}${NAME}${escape(WIKI_EMBED_MARKERS.close)}`;
const EMBED = new RegExp(EMBED_SOURCE, 'g');
const EMBED_TYPED = new RegExp(`${EMBED_SOURCE}$`);

function rawMarked(marks: readonly Mark[]): boolean {
    return marks.some(m => RAW_TEXT_MARKS.has(m.type.name));
}

/** The marks text typed or pasted at `$pos` takes. */
function marksAt(state: EditorState, $pos: ResolvedPos): readonly Mark[] {
    return state.storedMarks ?? $pos.marks();
}

/** `text` as text and wiki embed atoms, each carrying `marks`; `null` when it holds no embed or `marks` cannot hold one. */
export function textWithEmbeds(text: string, marks: readonly Mark[]): Node[] | null {
    if (rawMarked(marks)) {
        return null;
    }
    const nodes: Node[] = [];
    let at = 0;
    EMBED.lastIndex = 0;
    for (let m = EMBED.exec(text); m !== null; m = EMBED.exec(text)) {
        if (m.index > at) {
            nodes.push(editorSchema.text(text.slice(at, m.index), marks));
        }
        nodes.push(editorSchema.nodes.wiki_embed.create({ source: m[0] }, null, marks));
        at = m.index + m[0].length;
    }
    if (at === 0) {
        return null;
    }
    if (at < text.length) {
        nodes.push(editorSchema.text(text.slice(at), marks));
    }
    return nodes;
}

/**
 * Whether `[from, to)` is one run of plain text in one parent (a textblock, a
 * note's part): no node boundary (a note's part, a sidebar), no atom, one set
 * of marks. An input rule's text before the caret reads across all of them.
 */
function oneTextRun(state: EditorState, from: number, to: number): boolean {
    const $from = state.doc.resolve(from);
    const $to = state.doc.resolve(to);
    if ($from.parent !== $to.parent || !$from.parent.inlineContent) {
        return false;
    }
    let first: readonly Mark[] | null = null;
    let plain = true;
    $from.parent.slice($from.parentOffset, $to.parentOffset).content.forEach(node => {
        plain = plain && node.isText && (first === null || Mark.sameSet(first, node.marks));
        first = first ?? node.marks;
    });
    return plain;
}

/**
 * The input rule: the `]` that closes `![[name]]`, typed — one character, the
 * rest of the embed already one run of plain text before the caret — makes
 * it an atom carrying the marks typed text takes there.
 */
export function wikiEmbedInputRule(enabled: () => boolean): InputRule {
    return new InputRule(EMBED_TYPED, (state, match, start, end) => {
        // `end - start` is what of the match is in the document: all but the
        // typed character. The end of a composition runs the rules with nothing
        // typed, over text already there: it makes no embed.
        if (!enabled() || end - start !== match[0].length - 1 || !oneTextRun(state, start, end)) {
            return null;
        }
        const marks = marksAt(state, state.doc.resolve(end));
        if (rawMarked(marks)) {
            return null;
        }
        return state.tr.replaceWith(start, end, editorSchema.nodes.wiki_embed.create({ source: match[0] }, null, marks));
    }, { inCodeMark: false });
}

/**
 * Plain text pasted from outside the editor (the clipboard holds no HTML of
 * the editor's): its lines are paragraphs, as ProseMirror's own reading makes
 * them, and its embeds atoms. ProseMirror does not ask in a code block; a
 * drop is no paste, and the plugin reads only what a `paste` event brought.
 */
export function wikiEmbedPastePlugin(enabled: () => boolean): Plugin {
    let pasting = false;
    return new Plugin({
        props: {
            handleDOMEvents: {
                paste() {
                    pasting = true;
                    setTimeout(() => {
                        pasting = false;
                    });
                    return false;
                },
            },
            clipboardTextParser(text, $context, _plain, view) {
                const marks = marksAt(view.state, $context);
                if (!pasting || !enabled() || $context.parent.type.spec.code === true || rawMarked(marks)) {
                    return null as unknown as Slice;
                }
                const lines = text.split(/(?:\r\n?|\n)+/);
                if (!lines.some(line => textWithEmbeds(line, marks) !== null)) {
                    return null as unknown as Slice;
                }
                const paragraphs = lines.map(line => editorSchema.nodes.paragraph.create(null,
                    textWithEmbeds(line, marks) ?? (line === '' ? [] : [editorSchema.text(line, marks)])));
                return new Slice(Fragment.from(paragraphs), 1, 1);
            },
        },
    });
}

/**
 * A slice's inline content as one line for a note's part: its text and its
 * wiki embed atoms, with `marks`, the textblocks joined by a space, any other
 * leaf as its text. An atom stays one and text stays text: nothing is made an
 * embed here (`wikiEmbedPastePlugin` did that for text pasted from outside).
 * Under code, superscript or subscript an atom is its source as text.
 */
export function inlineForNote(slice: Slice, marks: readonly Mark[]): Node[] {
    const nodes: Node[] = [];
    const raw = rawMarked(marks);
    const pushText = (text: string) => {
        if (text !== '') {
            nodes.push(editorSchema.text(text, marks));
        }
    };
    let first = true;
    slice.content.descendants(node => {
        if (node.isTextblock) {
            if (!first) {
                pushText(' ');
            }
            first = false;
            return true;
        }
        if (node.isText) {
            pushText(node.text ?? '');
        } else if (node.type === editorSchema.nodes.wiki_embed && !raw) {
            nodes.push(editorSchema.nodes.wiki_embed.create(node.attrs, null, marks));
        } else if (node.isLeaf) {
            pushText(node.type.spec.leafText?.(node) ?? ' ');
        }
        return true;
    });
    return nodes;
}
