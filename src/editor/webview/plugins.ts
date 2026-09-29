import { baseKeymap, chainCommands, splitBlockAs, toggleMark } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { Command, Plugin } from 'prosemirror-state';
import { fidelityPlugin } from '../fidelity';
import { editorSchema } from '../schema';
import { hintPlugin } from './hint';
import { noteKeymap, notesPlugin } from './notes';
import { tableKeymap, tablesPlugins } from './tables';
import { toggleMarkType } from './toolbar/commands';
import { admonitionTitlesPlugin, wrapperKeymap } from './wrappers';

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

/**
 * Enter inside a heading that carries a requirement id or an attribute suffix
 * (`## ID: Title {#anchor}`): the text after the caret becomes a paragraph, not
 * a second heading. The default split copies every attribute to the new half,
 * which would write the id and the anchor twice — the duplicate Req Explorer's
 * checks refuse. At the end of the heading the default already starts a
 * paragraph, and at its start it leaves the heading (with its id) under a new
 * empty paragraph, so only a caret strictly inside the text is taken here.
 * `fidelityPlugin` holds the same line for transactions that do not come from
 * this key.
 */
export const splitRequirementHeading: Command = (state, dispatch) => {
    const { $from } = state.selection;
    const heading = $from.parent;
    if (heading.type !== nodes.heading || (heading.attrs.reqPrefix === null && heading.attrs.attrsSuffix === null)) {
        return false;
    }
    if ($from.parentOffset === 0) {
        return false;
    }
    return splitBlockAs(() => ({ type: nodes.paragraph }))(state, dispatch);
};

function markdownKeymap(): Plugin {
    const item = nodes.list_item;
    return keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Mod-Shift-z': redo,
        // Backspace right after an input rule fired gives back what was typed.
        'Backspace': undoInputRule,
        // By mark type, written with the CommonMark delimiters when added; the
        // toolbar's buttons toggle one delimiter each (toolbar/commands.ts).
        'Mod-b': toggleMarkType(marks.strong, '**'),
        'Mod-i': toggleMarkType(marks.em, '*'),
        'Mod-`': toggleMark(marks.code),
        'Enter': chainCommands(splitListItem(item), splitRequirementHeading),
        'Tab': sinkListItem(item),
        'Shift-Tab': liftListItem(item),
    });
}

/** Every plugin the editor state is built with, in the order they must run. */
export function editorPlugins(): Plugin[] {
    return [
        markdownInputRules(),
        // Ahead of the Markdown keys: Tab, Enter and Backspace mean something else inside a note,
        // Enter and Backspace in an empty paragraph of a container or an admonition,
        // and Tab, Enter and Shift+Enter in a table cell (a sidebar in a cell keeps its own keys).
        noteKeymap(),
        wrapperKeymap(),
        tableKeymap(),
        markdownKeymap(),
        keymap(baseKeymap),
        history(),
        dropCursor(),
        gapCursor(),
        hintPlugin(),
        notesPlugin(),
        admonitionTitlesPlugin(),
        ...tablesPlugins(),
        fidelityPlugin(),
    ];
}
