/**
 * Editing inside a container or an admonition: the keys that leave one or take
 * it away, and the admonition's title bar.
 *
 * - **Enter** in an empty paragraph that is the wrapper's last block leaves the
 *   wrapper, as it leaves a quote or a list: the paragraph moves after it, the
 *   caret with it (the wrapper keeps the paragraph when it is its only block,
 *   since it cannot be empty). An empty paragraph elsewhere in it gets a new
 *   paragraph after it: the default would split the wrapper in two, and two
 *   admonitions with one title are nobody's intention.
 * - **Backspace** at the start of the wrapper's first paragraph, when that
 *   paragraph is empty, removes the wrapper and keeps its blocks — a new
 *   admonition taken back with the key that took back its first character.
 *
 * **The title bar** is `p.admonition-title`, the first child of
 * `div.admonition`, as the plugin renders it and the stylesheet targets it
 * (`.admonition > .admonition-title`). A content hole must be the only child of
 * its element, so the schema cannot draw it; it is a widget at the start of the
 * admonition's content, not editable, which the title's verb in the object
 * toolbar changes. A click on it selects the admonition, whose bar then offers
 * that verb.
 */
import { DOMSerializer, Node } from 'prosemirror-model';
import { keymap } from 'prosemirror-keymap';
import { Command, NodeSelection, Plugin, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { WRAPPER_NODES, admonitionTitleSpec, editorSchema } from '../schema';
import { unwrapTransaction } from './objects';

const nodes = editorSchema.nodes;

/** The empty paragraph the caret is in, directly inside a wrapper: the paragraph's depth and the wrapper. */
function emptyParagraphInWrapper(state: Parameters<Command>[0]): { depth: number; wrapper: Node } | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) {
        return null;
    }
    const $cursor = sel.$from;
    if ($cursor.parent.type !== nodes.paragraph || $cursor.parent.content.size !== 0 || $cursor.depth < 2) {
        return null;
    }
    const wrapper = $cursor.node(-1);
    return WRAPPER_NODES.has(wrapper.type.name) ? { depth: $cursor.depth, wrapper } : null;
}

/** `Enter` in an empty paragraph of a wrapper (see above). */
export const leaveWrapper: Command = (state, dispatch) => {
    const found = emptyParagraphInWrapper(state);
    if (found === null) {
        return false;
    }
    const $cursor = state.selection.$from;
    const last = $cursor.index(-1) === found.wrapper.childCount - 1;
    if (dispatch) {
        const tr = state.tr;
        if (!last) {
            const at = $cursor.after();
            tr.insert(at, nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, at + 1));
        } else {
            let after = $cursor.after(-1);
            if (found.wrapper.childCount > 1) {
                tr.delete($cursor.before(), $cursor.after());
                after -= $cursor.parent.nodeSize;
            }
            tr.insert(after, nodes.paragraph.create());
            tr.setSelection(TextSelection.create(tr.doc, after + 1));
        }
        dispatch(tr.scrollIntoView());
    }
    return true;
};

/** `Backspace` at the start of a wrapper's first paragraph, when it is empty (see above). */
export const unwrapFromStart: Command = (state, dispatch) => {
    const found = emptyParagraphInWrapper(state);
    if (found === null || state.selection.$from.index(-1) !== 0) {
        return false;
    }
    const tr = unwrapTransaction(state, state.selection.$from.before(-1));
    if (tr === null) {
        return false;
    }
    dispatch?.(tr);
    return true;
};

/** The keys of a container or an admonition, ahead of the Markdown keys and the base keymap. */
export function wrapperKeymap(): Plugin {
    return keymap({ Enter: leaveWrapper, Backspace: unwrapFromStart });
}

/** The title bars of every admonition that has a title, as widgets at the start of its content. */
function titleDecorations(doc: Node): DecorationSet {
    const decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
        if (node.type === nodes.admonition && node.attrs.title !== '') {
            const title = node.attrs.title as string;
            decorations.push(Decoration.widget(pos + 1, (view: EditorView, getPos) => titleElement(view, title, getPos), {
                side: -1,
                key: `admonition-title:${title}`,
                ignoreSelection: true,
                stopEvent: () => true,
                // No `ProseMirror-widget` class: the element is the plugin's, as it renders it.
                raw: true,
            }));
        }
        // Admonitions are in blocks, never in text.
        return !node.isTextblock;
    });
    return DecorationSet.create(doc, decorations);
}

function titleElement(view: EditorView, title: string, getPos: () => number | undefined): HTMLElement {
    const el = DOMSerializer.renderSpec(document, admonitionTitleSpec(title)).dom as HTMLElement;
    el.addEventListener('mousedown', e => {
        e.preventDefault();
        const at = getPos();
        if (at === undefined) {
            return;
        }
        // The widget stands at the start of the admonition's content.
        const pos = at - 1;
        const node = view.state.doc.nodeAt(pos);
        if (node?.type === nodes.admonition) {
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
            view.focus();
        }
    });
    return el;
}

/** The admonitions' title bars, kept with the document. */
export function admonitionTitlesPlugin(): Plugin<DecorationSet> {
    return new Plugin<DecorationSet>({
        state: {
            init: (_config, state) => titleDecorations(state.doc),
            apply: (tr, set, _old, state) => (tr.docChanged ? titleDecorations(state.doc) : set),
        },
        props: {
            decorations(state) {
                return this.getState(state);
            },
        },
    });
}
