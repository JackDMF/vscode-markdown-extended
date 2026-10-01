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
import { wikiEmbedInputRule, wikiEmbedPastePlugin } from './wikiEmbeds';
import { admonitionTitlesPlugin, wrapperKeymap } from './wrappers';

const nodes = editorSchema.nodes;
const marks = editorSchema.marks;

/**
 * Markdown's own block syntax, typed at the start of a line, turns the line into
 * the block — the shortcut a Markdown author already knows.
 */
function markdownInputRules(wikiEmbeds: () => boolean): Plugin {
    return inputRules({
        rules: [
            // `![[name]]` typed: an embed atom, where the engine reads embeds (`wikiEmbeds.ts`).
            wikiEmbedInputRule(wikiEmbeds),
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

/**
 * A key acts where the caret is shown, not where ProseMirror last read it.
 *
 * A click moves the DOM caret at once, but ProseMirror takes the new position
 * into its state only when the browser's `selectionchange` event reaches it —
 * a task of its own, which Chromium may run after input it already has queued.
 * On a busy page a key pressed right after the click is then handled against
 * the selection from before it: Enter split the block the caret had left, and
 * the text typed after it went there (the lens suite's "Inserted.Intro.", and
 * text typed into a heading the caret had been in). ProseMirror's `keydown`
 * flushes pending DOM mutations, not a selection change it has not heard of.
 *
 * So before any key handler — `handleDOMEvents` run ahead of every plugin's
 * `handleKeyDown`, the completion list's included — the page tells ProseMirror
 * the selection changed, and ProseMirror reads it by its own rules (a widget's
 * or a node view's selection it ignores stays ignored; an unchanged one is a
 * no-op). Only for a key on the editable text itself, and not while an IME
 * composes: a field inside a node view keeps its own selection.
 */
export function domSelectionFirst(): Plugin {
    return new Plugin({
        props: {
            handleDOMEvents: {
                keydown(view, event) {
                    if (event.target === view.dom && !event.isComposing && event.keyCode !== 229 && view.hasFocus()) {
                        view.dom.ownerDocument.dispatchEvent(new Event('selectionchange'));
                    }
                    return false;
                },
            },
        },
    });
}

/**
 * Every plugin the editor state is built with, in the order they must run.
 * `wikiEmbeds` says whether the host's engine reads wiki embeds (`readsWikiEmbeds`).
 */
export function editorPlugins(wikiEmbeds: () => boolean = () => true): Plugin[] {
    return [
        // First: every key below reads the selection the DOM shows.
        domSelectionFirst(),
        markdownInputRules(wikiEmbeds),
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
        notesPlugin(wikiEmbeds),
        wikiEmbedPastePlugin(wikiEmbeds),
        admonitionTitlesPlugin(),
        ...tablesPlugins(),
        fidelityPlugin(),
    ];
}
