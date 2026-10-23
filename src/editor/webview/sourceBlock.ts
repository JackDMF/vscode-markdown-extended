/**
 * A source block against being lost to an edit (wave 3 #5a). It is not edited
 * as text, so anything that would replace or remove it while it is selected as
 * a whole — a character, a paste, Backspace, Delete, macOS's Ctrl+D/Ctrl+H/Alt+D,
 * dictation, the emoji picker, an input method — would have taken it with it,
 * silently. That is refused at the block, saying why and what changes it (Edit
 * source). The guard is on the transaction (`filterTransaction`), so no route
 * past the keys gets through, plus the DOM's own input (`beforeinput`, a
 * composition), which would otherwise change the page before any transaction.
 *
 * What does remove one, on purpose: the bar's Delete block and an emptied Edit
 * source (`SOURCE_VERB_META`), cut (it is on the clipboard), undo and redo, the
 * host's re-sync. A text selection across a source block is replaced as usual,
 * and says the block went with the key that brings it back (`sourceBlockHintPlugin`).
 * Backspace at the start of the paragraph after one, or Delete at the end of the
 * one before, selects it first (`sourceBlockKeymap`); a second press is refused.
 * Enter keeps what it did before (a new paragraph after the block).
 *
 * Selecting one is said to a screen reader, with the key to its actions; the
 * bar shows the same title, so it is drawn nowhere (`announceHint`).
 */
import { Node } from 'prosemirror-model';
import { Command, EditorState, NodeSelection, Plugin, PluginKey, TextSelection, Transaction } from 'prosemirror-state';
import { keymap } from 'prosemirror-keymap';
import { ReplaceAroundStep, ReplaceStep } from 'prosemirror-transform';
import { EditorView } from 'prosemirror-view';
import { HISTORY_META, PRESERVE_SOURCE_META } from '../fidelity';
import { editorSchema } from '../schema';
import { holdsConstruct } from '../sourceReason';
import { VERB, quotedVerb } from '../verbs';
import { announceHint, macKeys, showChangeHint, showRefusal, undoHint } from './hint';

/**
 * Set on a transaction a verb makes on purpose to a source block — the bar's
 * Delete block, Edit source's commit — which may replace or remove it.
 */
export const SOURCE_VERB_META = 'mepSourceVerb';

/** The source block the selection is, or `null`. */
function selectedSourceBlock(state: EditorState): NodeSelection | null {
    const sel = state.selection;
    return sel instanceof NodeSelection && sel.node.type === editorSchema.nodes.raw_block ? sel : null;
}

/** Why a source block is one, in words (`construct`, `sourceReason.ts`), or `null`. */
function reasonOf(sel: NodeSelection): string | null {
    return (sel.node.attrs.construct as string | null) ?? null;
}

/** What a rendered source block is to a reader: its one element's kind, else a block. */
export type SourceKind = 'paragraph' | 'list' | 'quote' | 'table' | 'block';

/**
 * The refusal for an edit that would replace or remove the selected source block, as a
 * clause naming the block and why: "This paragraph holds a footnote", "This definition list
 * is source", "This list is source" when no word says why.
 */
export function sourceRefusal(reason: string | null, kind: SourceKind): string {
    const clause = reason === null ? `This ${kind} is source`
        : holdsConstruct(reason) ? `This ${kind} holds ${reason.slice('has '.length)}`
        : /attributes$/.test(reason) ? `These ${reason} are source`
        : `This ${reason} is source`;
    return `${clause} — change it with ${quotedVerb(VERB.editSource)}`;
}

/** What selecting a source block says to a screen reader. */
export function sourceAnnouncement(reason: string | null): string {
    return `Source block${reason ? `, ${reason}` : ''} — Alt+Enter for actions`;
}

const KINDS: Readonly<Record<string, SourceKind>> = { P: 'paragraph', UL: 'list', OL: 'list', BLOCKQUOTE: 'quote', TABLE: 'table' };

function refuse(view: EditorView, sel: NodeSelection): true {
    const dom = view.nodeDOM(sel.from);
    const near = dom instanceof Element ? dom : undefined;
    // What the host renders: one paragraph, list, quote or table, else a block.
    // Not counting what another extension's renderer adds out of sight (a mermaid config span, `aria-hidden`).
    const rendered = Array.from(near?.querySelector(':scope > .mep-atom-content')?.children ?? []).filter(el => el.getAttribute('aria-hidden') !== 'true');
    const kind = rendered.length === 1 ? KINDS[rendered[0].tagName] ?? 'block' : 'block';
    // The one refusal component (#10), at the selected block.
    showRefusal(view, sourceRefusal(reasonOf(sel), kind), { at: 'caret', near });
    return true;
}

/** The `src` of each source block in `doc` wholly between `from` and `to`, appended to `into`. */
function sourceSrcsIn(doc: Node, from: number, to: number, into: string[]): void {
    if (from < to) {
        doc.nodesBetween(from, to, (node, pos) => {
            if (node.type === editorSchema.nodes.raw_block) {
                if (pos >= from && pos + node.nodeSize <= to) {
                    into.push(node.attrs.src as string);
                }
                return false;
            }
            return !node.isTextblock;
        });
    }
}

/** The `src` of each source block in `content`, appended to `into`. */
function sourceSrcsOf(content: Node['content'], into: string[]): void {
    content.descendants(node => {
        if (node.type === editorSchema.nodes.raw_block) {
            into.push(node.attrs.src as string);
            return false;
        }
        return !node.isTextblock;
    });
}

/**
 * How many source blocks `tr` takes out of the document and does not put back: a block counts
 * as kept only when what the steps insert holds a source block with the same `src` (a block
 * moved by a drag, re-marked by `setNodeMarkup`), so one replaced by another source block still
 * counts as removed. Reads only what the steps replace: a keystroke's few positions.
 */
export function sourceBlocksRemoved(tr: Transaction): number {
    const out: string[] = [];
    const put: string[] = [];
    tr.steps.forEach((step, i) => {
        const doc = tr.docs[i];
        if (step instanceof ReplaceStep) {
            const s = step as unknown as { from: number; to: number; slice: { content: Node['content'] } };
            sourceSrcsIn(doc, s.from, s.to, out);
            sourceSrcsOf(s.slice.content, put);
        } else if (step instanceof ReplaceAroundStep) {
            const s = step as unknown as { from: number; to: number; gapFrom: number; gapTo: number; slice: { content: Node['content'] } };
            sourceSrcsIn(doc, s.from, s.gapFrom, out);
            sourceSrcsIn(doc, s.gapTo, s.to, out);
            sourceSrcsOf(s.slice.content, put);
        }
    });
    // Each inserted block keeps one removed block of its src.
    return out.filter(src => {
        const at = put.indexOf(src);
        if (at >= 0) {
            put.splice(at, 1);
        }
        return at < 0;
    }).length;
}

/** A transaction that may remove a source block without a word: undo/redo, a verb's, the host's re-sync. */
function onPurpose(tr: Transaction): boolean {
    return tr.getMeta(HISTORY_META) !== undefined || tr.getMeta(SOURCE_VERB_META) === true || tr.getMeta(PRESERVE_SOURCE_META) === true;
}

/** Input that replaces or removes a selection; a line break (Enter's) and undo/redo are not. Cut and a drag's move are allowed. */
function replacesSelection(inputType: string): boolean {
    return (inputType.startsWith('insert') && !/^insert(Paragraph|LineBreak|FromPaste|FromDrop)$/.test(inputType))
        || (inputType.startsWith('delete') && inputType !== 'deleteByCut' && inputType !== 'deleteByDrag');
}

/** How many source blocks the last transaction removed that are said (`sourceBlockHintPlugin`). */
const removedKey = new PluginKey<number>('mepSourceBlockRemoved');

export function sourceBlockPlugin(): Plugin {
    let current: EditorView | null = null;
    // Each transaction is counted once, for the filter and for the hint.
    const counted = new WeakMap<Transaction, number>();
    const removed = (tr: Transaction) => {
        let n = counted.get(tr);
        if (n === undefined) {
            n = tr.docChanged && !onPurpose(tr) ? sourceBlocksRemoved(tr) : 0;
            counted.set(tr, n);
        }
        return n;
    };
    const refuseSelected = (view: EditorView) => {
        const sel = selectedSourceBlock(view.state);
        return sel !== null && refuse(view, sel);
    };
    return new Plugin<number>({
        key: removedKey,
        state: {
            init: () => 0,
            // What another plugin appends keeps the count of the edit it follows.
            apply: (tr, value) => tr.getMeta('appendedTransaction') !== undefined ? value : Math.max(0, removed(tr)),
        },
        filterTransaction(tr, state) {
            const sel = selectedSourceBlock(state);
            if (sel === null || tr.getMeta('uiEvent') === 'cut' || removed(tr) <= 0) {
                return true;
            }
            if (current !== null) {
                refuse(current, sel);
            }
            return false;
        },
        props: {
            handleKeyDown(view, event) {
                return !event.isComposing && (event.key === 'Backspace' || event.key === 'Delete') && refuseSelected(view);
            },
            handleTextInput: view => refuseSelected(view),
            handlePaste: view => refuseSelected(view),
            handleDOMEvents: {
                // Text the page gets without a key it could refuse first: dictation, the emoji
                // picker, a text replacement; cancelled before the DOM changes.
                beforeinput(view, event) {
                    if (replacesSelection(event.inputType) && refuseSelected(view)) {
                        event.preventDefault();
                        return true;
                    }
                    return false;
                },
                // An input method: its composition cannot be cancelled, and ProseMirror would move
                // it beside the block, into the text before it. The page stops being editable for
                // the moment it starts, which ends it with nothing written, and is editable again,
                // with the focus and the block still selected, right after.
                compositionstart(view, event) {
                    if (!refuseSelected(view)) {
                        return false;
                    }
                    event.preventDefault();
                    const dom = view.dom as HTMLElement;
                    dom.contentEditable = 'false';
                    setTimeout(() => {
                        dom.contentEditable = String(view.editable);
                        view.focus();
                    });
                    return true;
                },
            },
        },
        view: view => {
            current = view;
            return {
                update(view, prev) {
                    if (view.state.selection.eq(prev.selection)) {
                        return;
                    }
                    const sel = selectedSourceBlock(view.state);
                    if (sel !== null) {
                        announceHint(view, sourceAnnouncement(reasonOf(sel)));
                    }
                },
                destroy() {
                    current = null;
                },
            };
        },
    });
}

/**
 * Says that an edit took source blocks with it — a text selection across one, typed
 * over or deleted; a cut — with the key that brings them back. After `hintPlugin`,
 * whose update clears the previous change's hint.
 */
export function sourceBlockHintPlugin(): Plugin {
    return new Plugin({
        view: () => ({
            update(view, prev) {
                const n = removedKey.getState(view.state) ?? 0;
                if (view.state.doc !== prev.doc && n > 0) {
                    showChangeHint(view, undoHint(n === 1 ? 'Source block removed' : `${n} source blocks removed`));
                }
            },
        }),
    });
}

/** The node position where `$pos`'s textblock meets its sibling on the `dir` side, as `joinBackward`/`joinForward` cut. */
function cutBeside($pos: ReturnType<Node['resolve']>, dir: -1 | 1): ReturnType<Node['resolve']> | null {
    for (let depth = $pos.depth - 1; depth >= 0; depth--) {
        if (dir < 0 ? $pos.index(depth) > 0 : $pos.index(depth) < $pos.node(depth).childCount - 1) {
            return $pos.doc.resolve(dir < 0 ? $pos.before(depth + 1) : $pos.after(depth + 1));
        }
        if ($pos.node(depth).type.spec.isolating) {
            break;
        }
    }
    return null;
}

/**
 * At the start of a paragraph right after a source block (Backspace), or at the end of
 * one right before it (Delete): select the block, as `joinBackward`/`joinForward` would
 * delete it in one keystroke. An empty paragraph keeps the default: it goes, the block stays.
 */
function selectSourceBlockBeside(dir: -1 | 1): Command {
    return (state, dispatch) => {
        const sel = state.selection;
        if (!(sel instanceof TextSelection) || !sel.empty) {
            return false;
        }
        const $at = sel.$from;
        if (!$at.parent.isTextblock || $at.parent.content.size === 0 || $at.parentOffset !== (dir < 0 ? 0 : $at.parent.content.size)) {
            return false;
        }
        const $cut = cutBeside($at, dir);
        const node = $cut ? (dir < 0 ? $cut.nodeBefore : $cut.nodeAfter) : null;
        if (!$cut || !node || node.type !== editorSchema.nodes.raw_block || $cut.depth !== $at.depth - 1) {
            return false;
        }
        dispatch?.(state.tr.setSelection(NodeSelection.create(state.doc, dir < 0 ? $cut.pos - node.nodeSize : $cut.pos)).scrollIntoView());
        return true;
    };
}

/** Before `baseKeymap`: the keys that join backward or forward (macOS's Emacs-style ones too) select a source block beside the caret. */
export function sourceBlockKeymap(): Plugin {
    const back = selectSourceBlockBeside(-1);
    const forward = selectSourceBlockBeside(1);
    const keys: Record<string, Command> = { 'Backspace': back, 'Mod-Backspace': back, 'Shift-Backspace': back, 'Delete': forward, 'Mod-Delete': forward };
    if (macKeys()) {
        Object.assign(keys, { 'Ctrl-h': back, 'Alt-Backspace': back, 'Ctrl-d': forward, 'Alt-Delete': forward, 'Alt-d': forward, 'Ctrl-Alt-Backspace': forward });
    }
    return keymap(keys);
}
