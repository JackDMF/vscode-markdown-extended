import { EditorState, Plugin, PluginKey, TextSelection, Transaction } from 'prosemirror-state';
import { HISTORY_META, PRESERVE_SOURCE_META, asRepair, fidelityPlan, isRepair } from '../fidelity';
import { editorSchema } from '../schema';
import { emojiBeyondAtoms, unreadEmojiAsText } from '../serialize';
import { showChangeHint, undoKey } from './hint';

/**
 * An emoji the file holds is an atom (`emoji`), written back as it was
 * spelled. An edit can make that spelling stop reading as the emoji where it
 * stands — a letter typed right after `:)`, the text before `>:(` deleted at a
 * line start, which makes it a quote. Such an atom becomes its spelling as
 * plain text on the page at once, in a transaction appended to the edit, so
 * one undo takes both back; the file then holds that text, which reads as no
 * emoji. It is not spelled otherwise (`:smiley:`): what was written stays.
 * The caret hint says so, once, naming the text as it now stands
 * (`:)Z is no longer an emoji — Ctrl+Z`).
 *
 * Decided here, on the page, right after the edit, by the parser: each
 * top-level block the save writes by rule after the edit (`fidelityPlan`) is
 * read back as the save will write it, with the page's engine
 * (`unreadEmojiAsText`, `unreadEmoji`). The check of the edit reads the
 * document this conversion makes (`writtenEdit`), and the save converts the
 * same way what reaches it (`withReadEmoji` in `serialize.ts`), so the page
 * and the file agree at once, not after a reload.
 *
 * Once text, it is text: the escape of typed shortcuts applies to it
 * (`emojiShortcuts.ts`), and typing it again never makes an atom.
 */

/** What the last transaction made text, as the hint names it; `null` after one that made none. */
interface EmojiNotice {
    text: string;
}

export const emojiPluginKey = new PluginKey<EmojiNotice | null>('mepEmoji');

/** The meta on the transaction that made atoms text: what each became, with the character after it, as the page then shows it. */
export const EMOJI_AS_TEXT_META = 'mepEmojiAsText';

/** The hint for what an edit made text: each as the text now stands around it, and the undo that gives the emoji back. */
function noticeOf(shown: readonly string[]): string {
    return `${shown.length === 1 ? `${shown[0]} is no longer an emoji` : `${shown.join(', ')} are no longer emoji`} — ${undoKey()}`;
}

/** The hint the transaction that led to `state` gives, or `null`: only the one that made atoms text. */
export function emojiAsTextNotice(state: EditorState): string | null {
    return emojiPluginKey.getState(state)?.text ?? null;
}

export function emojiPlugin(): Plugin<EmojiNotice | null> {
    return new Plugin<EmojiNotice | null>({
        key: emojiPluginKey,
        state: {
            init: () => null,
            apply(tr, notice) {
                const shown = tr.getMeta(EMOJI_AS_TEXT_META) as string[] | undefined;
                if (shown !== undefined && shown.length > 0) {
                    return { text: noticeOf(shown) };
                }
                // A repair appended after it (the fidelity plugin's) belongs to the same edit.
                return isRepair(tr) ? notice : null;
            },
        },
        appendTransaction(transactions, oldState, newState) {
            if (!transactions.some(tr => tr.docChanged && !isRepair(tr))
                || transactions.some(tr => tr.getMeta(PRESERVE_SOURCE_META) === true || tr.getMeta(HISTORY_META) !== undefined)) {
                return null;
            }
            const plan = fidelityPlan(transactions, oldState.doc, newState.doc);
            const tr = newState.tr;
            const made = unreadEmojiAsText(tr, plan.rewritten.map(block => block.offset));
            return tr.docChanged ? asRepair(tr).setMeta(EMOJI_AS_TEXT_META, made.map(m => m.shown)) : null;
        },
        view: () => ({
            update(view, prevState) {
                const notice = emojiPluginKey.getState(view.state);
                if (notice != null && notice !== emojiPluginKey.getState(prevState)) {
                    showChangeHint(view, notice.text);
                }
            },
        }),
    });
}

/** Why Edit as text is refused where the characters would still read as an emoji (`emojiTextStillRead`). */
export const EMOJI_TEXT_STILL_READ = 'Here its characters would still be read as an emoji, so it cannot be made text.';

/**
 * Why `tr`, an atom made text (`emojiAsTextTransaction`), is refused: the
 * block holding it, as the save writes it, would read more emoji beyond its
 * atoms than before (`emojiBeyondAtoms`) — the characters would still be an
 * emoji to the preview, as in a sidenote, whose plugin reads one even
 * escaped. Asked of the parser, not of where the atom stands.
 */
export function emojiTextStillRead(state: EditorState, tr: Transaction): string | null {
    const from = tr.mapping.invert().map(tr.selection.from);
    const $before = state.doc.resolve(Math.min(from, state.doc.content.size));
    const $after = tr.doc.resolve(Math.min(tr.selection.from, tr.doc.content.size));
    if ($before.depth === 0 || $after.depth === 0) {
        return null;
    }
    return emojiBeyondAtoms($after.node(1)) > emojiBeyondAtoms($before.node(1)) ? EMOJI_TEXT_STILL_READ : null;
}

/**
 * The emoji atom at `[from, to)` as its spelling in text, with the atom's
 * marks and the caret after it — Edit as text, the object bar's verb. It is
 * text, and stays text: the save escapes it as typed text (`emojiShortcuts.ts`).
 * `null` when `[from, to)` is not one emoji.
 */
export function emojiAsTextTransaction(state: EditorState, from: number, to: number): Transaction | null {
    const atom = state.doc.nodeAt(from);
    if (atom === null || atom.type !== editorSchema.nodes.emoji || from + atom.nodeSize !== to) {
        return null;
    }
    const source = atom.attrs.source as string;
    const tr = state.tr.replaceWith(from, to, editorSchema.text(source, atom.marks));
    return tr.setSelection(TextSelection.create(tr.doc, from + source.length)).scrollIntoView();
}
