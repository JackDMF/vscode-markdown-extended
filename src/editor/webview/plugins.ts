import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { Plugin, Transaction } from 'prosemirror-state';
import { PRESERVE_SOURCE_META, fidelityPlugin } from '../fidelity';
import { editorSchema } from '../schema';

const nodes = editorSchema.nodes;
const marks = editorSchema.marks;

/**
 * Markdown's own block syntax, typed at the start of a line, turns the line into
 * the block — the shortcut a Markdown author already knows.
 */
function markdownInputRules(): Plugin {
    return inputRules({
        rules: [
            textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, match => ({ level: match[1].length })),
            wrappingInputRule(/^\s*([-*])\s$/, nodes.bullet_list, match => ({ bullet: match[1] })),
            wrappingInputRule(
                /^(\d+)\.\s$/,
                nodes.ordered_list,
                match => ({ order: Number(match[1]) }),
                (match, node) => node.childCount + (node.attrs.order as number) === Number(match[1]),
            ),
            wrappingInputRule(/^\s*>\s$/, nodes.blockquote),
            textblockTypeInputRule(/^```$/, nodes.code_block, () => ({ params: '', markup: '```' })),
        ],
    });
}

function markdownKeymap(): Plugin {
    const item = nodes.list_item;
    return keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Mod-Shift-z': redo,
        // Backspace right after an input rule fired gives back what was typed.
        'Backspace': undoInputRule,
        'Mod-b': toggleMark(marks.strong),
        'Mod-i': toggleMark(marks.em),
        'Mod-`': toggleMark(marks.code),
        'Enter': splitListItem(item),
        'Tab': sinkListItem(item),
        'Shift-Tab': liftListItem(item),
    });
}

/**
 * A top-level block moved by a drop keeps its `src` — its text did not change,
 * and the fidelity plugin keeps it by node identity — but it also keeps its
 * `gap`, the text that separated it from the block it used to follow. At the
 * new place that separator is a guess about somebody else's neighbour, so it is
 * cleared, and the serializer writes the default blank line.
 *
 * Only nodes the drop inserted whole are touched: a block a drop inserted text
 * into did not move, and its gap is still its own. The transaction carries
 * `PRESERVE_SOURCE_META`, because resetting an attribute is not an edit of the
 * block and the fidelity plugin must not clear `src` for it. It must run after
 * the fidelity plugin, which then has already judged the drop itself.
 */
export function dropGapPlugin(): Plugin {
    return new Plugin({
        appendTransaction(transactions, _oldState, newState) {
            const index = transactions.findIndex(tr => tr.docChanged && tr.getMeta('uiEvent') === 'drop');
            if (index < 0) {
                return null;
            }
            const drop = transactions[index];
            const last = drop.mapping.maps[drop.mapping.maps.length - 1];
            let from = -1;
            let to = -1;
            last?.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                from = newStart;
                to = newEnd;
            });
            if (from < 0) {
                return null;
            }
            for (const later of transactions.slice(index + 1)) {
                from = later.mapping.map(from, 1);
                to = later.mapping.map(to, -1);
            }
            let tr: Transaction | null = null;
            newState.doc.forEach((child, offset) => {
                const inside = offset >= from && offset + child.nodeSize <= to;
                if (!inside || !('gap' in child.attrs) || child.attrs.gap === null) {
                    return;
                }
                tr = tr ?? newState.tr.setMeta(PRESERVE_SOURCE_META, true);
                tr.setNodeMarkup(offset, undefined, { ...child.attrs, gap: null });
            });
            return tr;
        },
    });
}

/** Every plugin the editor state is built with, in the order they must run. */
export function editorPlugins(): Plugin[] {
    return [
        markdownInputRules(),
        markdownKeymap(),
        keymap(baseKeymap),
        history(),
        dropCursor(),
        gapCursor(),
        fidelityPlugin(),
        dropGapPlugin(),
    ];
}
