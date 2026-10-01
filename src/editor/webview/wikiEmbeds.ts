import { InputRule } from 'prosemirror-inputrules';
import { Fragment, Mark, Node, Slice } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { editorSchema } from '../schema';
import { RAW_TEXT_MARKS } from '../serialize';

/**
 * A wiki embed typed or pasted as text (`![[img.png]]`) becomes the atom the
 * editor reads one as (`wiki_embed`, `markdownItWikiEmbed.ts`), so it is saved
 * as written instead of as escaped text. Only where the engine reads embeds
 * (`readsWikiEmbeds`: the page asks `enabled`), only outside code, superscript
 * and subscript, whose text is read as it is, and only an embed of the shape
 * the plugin reads: `![[`, a name with no bracket and no line break, `]]`.
 */
const EMBED = /!\[\[[^[\]\n￼]+\]\]/g;

function rawMarked(marks: readonly Mark[]): boolean {
    return marks.some(m => RAW_TEXT_MARKS.has(m.type.name));
}

/** `text` as text and wiki embed atoms, each carrying `marks`; `null` when it holds no embed. */
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

/** `fragment` with the embeds in its text made atoms, except inside a code block. */
function embedsInFragment(fragment: Fragment, inCode: boolean): Fragment {
    const out: Node[] = [];
    fragment.forEach(node => {
        if (node.isText) {
            const parts = inCode ? null : textWithEmbeds(node.text ?? '', node.marks);
            out.push(...(parts ?? [node]));
            return;
        }
        out.push(node.copy(embedsInFragment(node.content, inCode || node.type.spec.code === true)));
    });
    return Fragment.from(out);
}

/** The input rule: the `]]` that closes `![[name]]` makes it an atom. */
export function wikiEmbedInputRule(enabled: () => boolean): InputRule {
    return new InputRule(/!\[\[[^[\]\n￼]+\]\]$/, (state, match, start, end) => {
        const marks = state.doc.resolve(start).marks();
        if (!enabled() || rawMarked(marks)) {
            return null;
        }
        return state.tr.replaceWith(start, end, editorSchema.nodes.wiki_embed.create({ source: match[0] }, null, marks));
    }, { inCodeMark: false });
}

/** Pasted text: its embeds become atoms (the page's own copy already carries them). */
export function wikiEmbedPastePlugin(enabled: () => boolean): Plugin {
    return new Plugin({
        props: {
            transformPasted(slice) {
                return enabled() ? new Slice(embedsInFragment(slice.content, false), slice.openStart, slice.openEnd) : slice;
            },
        },
    });
}
