/**
 * The pieces a refusal is made of that are not words of its own: how long it
 * stays (`refusalMs`), when a repeat of it is not said again
 * (`REANNOUNCE_GAP_MS`), and the names it gives what it is about — a note
 * (`noteNoun`), the part of a block it points at (`partLabel`), a mark
 * (`markNoun`). One source per name, so a refusal and the bar it points to
 * call a thing the same.
 *
 * No DOM here; ProseMirror's model only to read nodes.
 */
import { Mark, Node } from 'prosemirror-model';
import { holderOfCarrier, namesOf } from './inlineLiterals';

/** The time a hint stays at least, and at most: a reason is read, and a long one is given longer. */
const REFUSAL_MIN_MS = 3_500;
const REFUSAL_MAX_MS = 10_000;

/** How long a refusal of `text` stays when nothing ends it first: 2 s plus 50 ms a character, between 3.5 and 10 s (Daniel, 2026-10-22). */
export function refusalMs(text: string): number {
    return Math.min(REFUSAL_MAX_MS, Math.max(REFUSAL_MIN_MS, 2_000 + 50 * text.length));
}

/** A refusal said again at the same place within this time (a held key) restarts its time but is not announced again. */
export const REANNOUNCE_GAP_MS = 1_000;

/** What each note is called — on its bar, in the Annotation menu, and (lowercase) in a refusal. */
export const NOTE_LABELS = {
    sidenote: 'Sidenote',
    marginal_note: 'Marginal note',
    left_sidebar: 'Left sidebar',
    right_sidebar: 'Right sidebar',
} as const;

/** A note's name mid-sentence (`sidenote`, `left sidebar`); `note` for anything else. */
export function noteNoun(node: Node | string): string {
    const name = typeof node === 'string' ? node : node.type.name;
    const label = (NOTE_LABELS as Readonly<Record<string, string>>)[name];
    return label === undefined ? 'note' : label.toLowerCase();
}

/** A mark's name mid-sentence, as the row's buttons name it (`italic text` for `*`, `emphasis` for `_`, `inline code`); `formatting` for one without a name. */
export function markNoun(mark: Mark): string {
    const holder = holderOfCarrier(mark.type.name);
    return holder === undefined ? 'formatting' : namesOf(holder, mark.attrs.markup).noun;
}

/** Whether `node` is `target` or holds it: by identity, O(node). */
function holds(node: Node, target: Node): boolean {
    if (node === target) {
        return true;
    }
    let found = false;
    node.descendants(child => {
        if (found) {
            return false;
        }
        if (child === target) {
            found = true;
        }
        return !found;
    });
    return found;
}

/**
 * The part of `block` that `textblock` is, as a refusal names it to someone
 * who must find it: `the header row`, `row 3` (body rows counted from 1),
 * `item 2`, `the heading`, `paragraph 2` (counted among the block's
 * textblocks of that kind). Found by identity, O(block); built only when a
 * refusal is made, never per key.
 */
export function partLabel(block: Node, textblock: Node): string {
    const name = block.type.name;
    if (name === 'table') {
        let body = 0;
        let label: string | null = null;
        block.forEach(row => {
            if (label !== null) {
                return;
            }
            const header = row.firstChild?.type.name === 'table_header';
            if (!header) {
                body++;
            }
            if (holds(row, textblock)) {
                label = header ? 'the header row' : `row ${body}`;
            }
        });
        return label ?? 'a row';
    }
    if (name === 'bullet_list' || name === 'ordered_list') {
        let index = 0;
        let label: string | null = null;
        block.forEach(item => {
            index++;
            if (label === null && holds(item, textblock)) {
                label = `item ${index}`;
            }
        });
        return label ?? 'an item';
    }
    const kind = textblock.type.name;
    if (kind === 'heading') {
        return 'the heading';
    }
    let index = 0;
    let label: string | null = null;
    block.descendants(child => {
        if (label !== null) {
            return false;
        }
        if (child.type.name === kind) {
            index++;
            if (child === textblock) {
                label = `${kind === 'paragraph' ? 'paragraph' : 'line'} ${index}`;
            }
        }
        return true;
    });
    return label ?? 'a line';
}
