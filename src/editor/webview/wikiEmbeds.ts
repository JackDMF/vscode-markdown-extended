import { InputRule, inputRules } from 'prosemirror-inputrules';
import { DOMSerializer, Fragment, Mark, Node, Slice } from 'prosemirror-model';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { WIKI_EMBED_MARKERS } from '../../syntax/markers';
import { escapeRegExp } from '../../syntax/regExp';
import { editorSchema } from '../schema';
import { RAW_TEXT_MARKS } from '../serialize';

/**
 * A wiki embed typed as text (`![[img.png]]`), or in text pasted from outside
 * this editor, becomes the atom the editor reads one as (`wiki_embed`,
 * `markdownItWikiEmbed.ts`), so it is saved as written instead of as escaped
 * text. Only where the engine reads embeds (the page's `enabled`), never in
 * code or under superscript or subscript, whose text is read as it is, and
 * only an embed of the shape the plugin reads: `![[`, a name with no bracket
 * and no line break, `]]`.
 *
 * Text that is already in the document is never made an embed: a drag inside
 * the editor carries its own nodes, and so does a paste of the editor's own
 * copy — an atom stays one, literal text stays text; and the input rule fires
 * on the `]` just typed, not on the end of a composition. A copy is the
 * editor's own by its HTML, which carries this editor's marker (`OWN_COPY`,
 * set by any Visual Editor, before a restart or after). A paste as plain text
 * (Ctrl+Shift+V) brings only the text, and there a copy is the editor's own
 * when its text is the text of the last copy made in this webview. Two limits
 * follow: a plain paste of a copy made in any other Visual Editor page
 * (another document's, or this document's before it was reopened) converts
 * like outside text, and outside text that is the same as this webview's last
 * copy is taken as that copy on a plain paste.
 */
const EMBED_SOURCE = `${escapeRegExp(WIKI_EMBED_MARKERS.open)}[^[\\]\\n\\ufffc]+${escapeRegExp(WIKI_EMBED_MARKERS.close)}`;
const EMBED = new RegExp(EMBED_SOURCE, 'g');
const EMBED_TYPED = new RegExp(`${EMBED_SOURCE}$`);

function rawMarked(marks: readonly Mark[]): boolean {
    return marks.some(m => RAW_TEXT_MARKS.has(m.type.name));
}

/** The source each embed found in text is made an atom with, or `null` to leave it text. */
type PickEmbed = (found: string) => string | null;

/**
 * `text` as text and wiki embed atoms, each carrying `marks`; `null` when it
 * holds no embed or `marks` cannot hold one. `pick` decides each embed found,
 * in order (default: every one, as written).
 */
export function textWithEmbeds(text: string, marks: readonly Mark[], pick: PickEmbed = found => found): Node[] | null {
    if (rawMarked(marks)) {
        return null;
    }
    const nodes: Node[] = [];
    let at = 0;
    EMBED.lastIndex = 0;
    for (let m = EMBED.exec(text); m !== null; m = EMBED.exec(text)) {
        const source = pick(m[0]);
        if (source === null) {
            continue;
        }
        if (m.index > at) {
            nodes.push(editorSchema.text(text.slice(at, m.index), marks));
        }
        nodes.push(editorSchema.nodes.wiki_embed.create({ source }, null, marks));
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

/** `fragment` with the embeds in its text made atoms, each with its text's marks, except inside a code block. */
function embedsInFragment(fragment: Fragment, inCode: boolean, pick: PickEmbed): Fragment {
    const out: Node[] = [];
    fragment.forEach(node => {
        if (node.isText) {
            out.push(...((inCode ? null : textWithEmbeds(node.text ?? '', node.marks, pick)) ?? [node]));
            return;
        }
        out.push(node.copy(embedsInFragment(node.content, inCode || node.type.spec.code === true, pick)));
    });
    return Fragment.from(out);
}

/** A slice's text as the clipboard holds it, line breaks folded, so a copy and its paste compare equal. */
function clipboardText(slice: Slice): string {
    return slice.content.textBetween(0, slice.content.size, '\n\n').replace(/\r\n?/g, '\n').replace(/\n+/g, '\n').trim();
}

/** Every embed-shaped run of a fragment, in order: an atom's source, or `null` for literal text. */
function embedsIn(fragment: Fragment): (string | null)[] {
    const found: (string | null)[] = [];
    fragment.descendants(node => {
        if (node.type === editorSchema.nodes.wiki_embed) {
            found.push(node.attrs.source as string);
        } else if (node.isText) {
            EMBED.lastIndex = 0;
            for (let m = EMBED.exec(node.text ?? ''); m !== null; m = EMBED.exec(node.text ?? '')) {
                found.push(null);
            }
        }
        return true;
    });
    return found;
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
        const marks = state.storedMarks ?? state.doc.resolve(end).marks();
        if (rawMarked(marks)) {
            return null;
        }
        return state.tr.replaceWith(start, end, editorSchema.nodes.wiki_embed.create({ source: match[0] }, null, marks));
    }, { inCodeMark: false });
}

/**
 * The input rule in a plugin of its own, so a note's own text insertion
 * (`notes.ts`) can run it and nothing else — no block rule there — and
 * `undoInputRule` (Backspace) still gives back what was typed.
 */
export function wikiEmbedInputRules(enabled: () => boolean): Plugin {
    return inputRules({ rules: [wikiEmbedInputRule(enabled)] });
}

/** Run the embed input rule of `plugin` (`wikiEmbedInputRules`) for `text` typed over `[from, to)`; whether it made an embed. */
export function runWikiEmbedInput(plugin: Plugin, view: EditorView, from: number, to: number, text: string): boolean {
    type Handle = (this: Plugin, view: EditorView, from: number, to: number, text: string, deflt: () => unknown) => boolean;
    const handle = plugin.props.handleTextInput as Handle | undefined;
    return handle?.call(plugin, view, from, to, text, () => view.state.tr.insertText(text, from, to)) === true;
}

/** The attribute every top-level element of this editor's copied HTML carries. */
export const OWN_COPY = 'data-mep-copy';

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose content is text, up to their own end tag: a `<` in it opens nothing. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);
/** Elements of the page around a fragment, which are no part of it. */
const OUTSIDE_FRAGMENT = new Set(['meta', 'link', 'base', 'script', 'style', 'title']);
/**
 * Elements a clipboard puts around a fragment, and so looks through while
 * they carry no marker: a document's (Windows' CF_HTML) and the table
 * ProseMirror wraps a copied cell or row in, so it parses outside a table.
 */
const WRAPPERS = new Set(['html', 'head', 'body', 'table', 'tbody', 'tr']);

/** The top-level elements of a fragment of HTML, whether each carries `OWN_COPY`, or `null` where its tags do not close. */
function topLevelMarks(html: string): boolean[] | null {
    const marks: boolean[] = [];
    const open: { name: string; wrapper: boolean }[] = [];
    const topLevel = () => open.every(e => e.wrapper);
    /** Where `pattern` ends in the HTML from `from`, or its end. */
    const endOf = (pattern: RegExp, from: number): number => {
        pattern.lastIndex = from;
        const found = pattern.exec(html);
        return found === null ? html.length : found.index + found[0].length;
    };
    const endTag = /<\/([^\s/>]+)[^>]*(?:>|$)/y;
    const startTag = /<([^\s/>]+)/y;
    // An attribute: its name, and a value that is quoted or runs to a space or the tag's end.
    const attribute = /[\s/]*(?:([^\s/>=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)?/y;
    let i = 0;
    while (i < html.length) {
        const next = html.indexOf('<', i);
        // Text outside every element is no copy of ours.
        if (/\S/.test(html.slice(i, next < 0 ? html.length : next)) && topLevel()) {
            marks.push(false);
        }
        if (next < 0) {
            break;
        }
        i = next;
        const after = html[i + 1] ?? '';
        if (html.startsWith('<!--', i)) {
            i = endOf(/-->/g, i + 4);
        } else if (after === '!' || after === '?') {
            i = endOf(/>/g, i + 2);
        } else if (after === '/' && /[a-z]/i.test(html[i + 2] ?? '')) {
            endTag.lastIndex = i;
            const end = endTag.exec(html) as RegExpExecArray;
            const index = open.map(e => e.name).lastIndexOf(end[1].toLowerCase());
            if (index >= 0) {
                open.length = index;
            }
            i += end[0].length;
        } else if (/[a-z]/i.test(after)) {
            startTag.lastIndex = i;
            const tag = startTag.exec(html) as RegExpExecArray;
            const name = tag[1].toLowerCase();
            const attributes = new Set<string>();
            i += tag[0].length;
            while (i < html.length && html[i] !== '>') {
                attribute.lastIndex = i;
                const found = attribute.exec(html) as RegExpExecArray;
                if (found[1] !== undefined) {
                    attributes.add(found[1].toLowerCase());
                }
                i += found[0].length;
                // A character no attribute starts with.
                if (found[0] === '' && html[i] !== '>') {
                    i++;
                }
            }
            i++;
            const marked = attributes.has(OWN_COPY);
            if (topLevel() && (marked || !(WRAPPERS.has(name) || OUTSIDE_FRAGMENT.has(name)))) {
                marks.push(marked);
            }
            if (RAW_TEXT_ELEMENTS.has(name)) {
                i = endOf(new RegExp(`</${name}[\\s/>][^>]*>`, 'gi'), i);
            } else if (!VOID_ELEMENTS.has(name)) {
                open.push({ name, wrapper: WRAPPERS.has(name) && !marked });
            }
        } else {
            // A `<` that opens nothing is text.
            if (topLevel()) {
                marks.push(false);
            }
            i++;
        }
    }
    return open.some(e => !e.wrapper) ? null : marks;
}

/**
 * Whether HTML from the clipboard is a copy of this editor's: it has an
 * element, and every top-level element of it carries `OWN_COPY`. The HTML is
 * read as HTML is — the marker's name in a comment, in an attribute's value or
 * in text is no marker, and an attribute's name is the same in any case. A
 * fragment mixing marked and unmarked elements is not our own copy, so what
 * came from outside in it is not left as literal text.
 */
export function isOwnCopyHtml(html: string): boolean {
    const marks = topLevelMarks(html);
    return marks !== null && marks.length > 0 && marks.every(m => m);
}

/** The schema's serializer, with `OWN_COPY` set on each top-level element of what it serializes. */
class OwnCopySerializer extends DOMSerializer {
    serializeFragment(fragment: Fragment, options: { document?: Document } = {}, target?: HTMLElement | DocumentFragment): HTMLElement | DocumentFragment {
        const dom = super.serializeFragment(fragment, options, target);
        // A node's content is serialized into its own element (`target`); only the top level is marked.
        if (target === undefined) {
            dom.childNodes.forEach(child => {
                if (child.nodeType === 1) {
                    (child as Element).setAttribute(OWN_COPY, '');
                }
            });
        }
        return dom;
    }
}

/**
 * A paste of text from outside this editor — a browser's, Obsidian's, VS
 * Code's text editor's or another ProseMirror editor's (whose copy is HTML),
 * or plain text — has the embeds in its text made atoms, each with its text's
 * marks, as ProseMirror's own reading gives them. A paste of this editor's own
 * copy keeps what it carried: its atoms are atoms and its literal text stays
 * literal. As HTML a copy is the editor's own when every top-level element of
 * it carries `OWN_COPY` (`clipboardSerializer`, `isOwnCopyHtml`); as plain text (Ctrl+Shift+V, which brings only
 * `text/plain`), when its text is the text of the last copy or cut made here
 * (`clipboardTextSerializer` during a `copy` or `cut` event — a drag
 * serializes too, and is no copy). A drop is no paste: the decision belongs to
 * a paste event, and is cleared once the paste's own handling is over. Never
 * into a code block.
 */
export function wikiEmbedPastePlugin(enabled: () => boolean): Plugin {
    let pasting = false;
    let ownHtml = false;
    let copying = false;
    let lastCopy: { text: string; embeds: (string | null)[] } | null = null;
    // The copy serializes in this event's handling; one that does not (an empty
    // selection) leaves no copy behind for the next drag.
    const copy = () => {
        copying = true;
        queueMicrotask(() => {
            copying = false;
        });
        return false;
    };
    return new Plugin({
        props: {
            clipboardSerializer: new OwnCopySerializer(DOMSerializer.nodesFromSchema(editorSchema), DOMSerializer.marksFromSchema(editorSchema)),
            clipboardTextSerializer(slice) {
                if (copying) {
                    copying = false;
                    lastCopy = { text: clipboardText(slice), embeds: embedsIn(slice.content) };
                }
                // ProseMirror's own text for a copy.
                return slice.content.textBetween(0, slice.content.size, '\n\n');
            },
            handleDOMEvents: {
                copy,
                cut: copy,
                paste() {
                    pasting = true;
                    ownHtml = false;
                    // The paste parses in this event's handling; whatever does not
                    // (an image the images plugin takes, a paste ProseMirror leaves
                    // to the browser) leaves no decision behind.
                    queueMicrotask(() => {
                        pasting = false;
                        ownHtml = false;
                    });
                    return false;
                },
            },
            transformPastedHTML(html) {
                ownHtml = pasting && isOwnCopyHtml(html);
                return html;
            },
            transformPasted(slice, view, asText) {
                const isPaste = pasting;
                const isOwnHtml = ownHtml;
                pasting = false;
                ownHtml = false;
                if (!isPaste || !enabled() || view.state.selection.$from.parent.type.spec.code === true
                    || !slice.content.textBetween(0, slice.content.size, '\n').includes(WIKI_EMBED_MARKERS.open)) {
                    return slice;
                }
                if (!asText && isOwnHtml) {
                    return slice;
                }
                const own = asText && lastCopy !== null && clipboardText(slice) === lastCopy.text;
                // The editor's own copy as text: each run is an atom where the copy had one.
                const embeds = own ? [...(lastCopy as { embeds: (string | null)[] }).embeds] : null;
                const ownCount = embeds === null ? 0 : embedsIn(slice.content).length;
                if (embeds !== null && ownCount !== embeds.length) {
                    return slice;
                }
                const pick: PickEmbed = embeds === null ? found => found : () => embeds.shift() ?? null;
                return new Slice(embedsInFragment(slice.content, false, pick), slice.openStart, slice.openEnd);
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
