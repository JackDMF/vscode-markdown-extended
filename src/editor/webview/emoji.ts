import { Plugin, PluginKey } from 'prosemirror-state';
import { PRESERVE_SOURCE_META, asRepair, fidelityPlan, isRepair } from '../fidelity';
import { unreadEmojiAsText } from '../serialize';

/**
 * An emoji the file holds is an atom (`emoji`), written back as it was
 * spelled. An edit can make that spelling stop reading as the emoji where it
 * stands — a letter typed right after `:)`, the text before `>:(` deleted at a
 * line start, which makes it a quote. Such an atom becomes its spelling as
 * plain text on the page at once, in a transaction appended to the edit, so
 * one undo takes both back; the file then holds that text, which reads as no
 * emoji. It is not spelled otherwise (`:smiley:`): what was written stays.
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
export const emojiPluginKey = new PluginKey<null>('mepEmoji');

/** The meta on the transaction that made atoms text: what each became, with the character after it, as the page then shows it. */
export const EMOJI_AS_TEXT_META = 'mepEmojiAsText';

/** prosemirror-history's meta key: an undo or redo puts back a state judged already. */
const HISTORY_META = 'history$';

export function emojiPlugin(): Plugin {
    return new Plugin({
        key: emojiPluginKey,
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
    });
}
