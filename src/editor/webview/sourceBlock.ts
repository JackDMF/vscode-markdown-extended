/**
 * A source block selected as a whole (wave 3 #5a). It is not edited as text,
 * so a key that would replace or remove the selection — a character, a paste,
 * Backspace, Delete — would have taken the block with it, silently. The key is
 * refused at the block, saying why and what changes it (Edit source); Enter
 * keeps what it did before (a new paragraph after the block), and the bar's
 * Delete block stays the way to remove it.
 *
 * Selecting one is said to a screen reader, with the key to its actions; the
 * bar shows the same title, so it is drawn nowhere (`announceHint`).
 */
import { EditorState, NodeSelection, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { editorSchema } from '../schema';
import { announceHint, showHint } from './hint';

/** The source block the selection is, or `null`. */
function selectedSourceBlock(state: EditorState): NodeSelection | null {
    const sel = state.selection;
    return sel instanceof NodeSelection && sel.node.type === editorSchema.nodes.raw_block ? sel : null;
}

/** Why a source block is one, in words (`construct`, `sourceReason.ts`), or `null`. */
function reasonOf(sel: NodeSelection): string | null {
    return (sel.node.attrs.construct as string | null) ?? null;
}

/** The refusal for a key that would replace or remove the selected source block, a `paragraph` as rendered or another `block`. */
export function sourceRefusal(reason: string | null, noun: 'paragraph' | 'block'): string {
    return `This ${noun} is source${reason ? ` (${reason})` : ''} — Edit source to change it`;
}

/** What selecting a source block says to a screen reader. */
export function sourceAnnouncement(reason: string | null): string {
    return `Source block${reason ? `, ${reason}` : ''} — Alt+Enter for actions`;
}

function refuse(view: EditorView, sel: NodeSelection): true {
    const dom = view.nodeDOM(sel.from);
    const near = dom instanceof Element ? dom : undefined;
    // A paragraph as the host renders it (one `<p>`), else a block: a table, a list, a definition list.
    // Not counting what another extension's renderer adds out of sight (a mermaid config span, `aria-hidden`).
    const rendered = Array.from(near?.querySelector(':scope > .mep-atom-content')?.children ?? []).filter(el => el.getAttribute('aria-hidden') !== 'true');
    const noun = rendered.length === 1 && rendered[0].tagName === 'P' ? 'paragraph' : 'block';
    showHint(view, sourceRefusal(reasonOf(sel), noun), 'refusal', near);
    return true;
}

export function sourceBlockPlugin(): Plugin {
    return new Plugin({
        props: {
            handleKeyDown(view, event) {
                const sel = selectedSourceBlock(view.state);
                if (sel === null || (event.key !== 'Backspace' && event.key !== 'Delete') || event.isComposing) {
                    return false;
                }
                return refuse(view, sel);
            },
            handleTextInput(view) {
                const sel = selectedSourceBlock(view.state);
                return sel !== null && refuse(view, sel);
            },
            handlePaste(view) {
                const sel = selectedSourceBlock(view.state);
                return sel !== null && refuse(view, sel);
            },
        },
        view: () => ({
            update(view, prev) {
                if (view.state.selection.eq(prev.selection)) {
                    return;
                }
                const sel = selectedSourceBlock(view.state);
                if (sel !== null) {
                    announceHint(view, sourceAnnouncement(reasonOf(sel)));
                }
            },
        }),
    });
}
