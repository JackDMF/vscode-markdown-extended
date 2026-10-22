import { baseKeymap, chainCommands, splitBlockAs, toggleMark } from 'prosemirror-commands';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { history, redo, undo } from 'prosemirror-history';
import { inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import type { Node } from 'prosemirror-model';
import { Command, Plugin, Transaction } from 'prosemirror-state';
import { AttrStep, Mapping } from 'prosemirror-transform';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { DEFAULT_FENCE, languageOf } from '../fences';
import { fidelityPlugin } from '../fidelity';
import { REDO_BINDINGS, UNDO_BINDING } from '../keys';
import { emojiKeymap, emojiPlugin } from './emoji';
import { currentReadsWikiEmbeds } from '../inlineEngine';
import { editorSchema } from '../schema';
import { hintPlugin } from './hint';
import { noteKeymap, notesPlugin } from './notes';
import { tableKeymap, tablesPlugins } from './tables';
import { TOOLBAR_ACTIONS } from './toolbar/actions';
import { toggleMarkType } from './toolbar/commands';
import { wikiEmbedInputRules, wikiEmbedPastePlugin } from './wikiEmbeds';
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
            textblockTypeInputRule(/^```$/, nodes.code_block, () => ({ params: '', markup: DEFAULT_FENCE })),
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

/** The row marks' keys (`ToolbarAction.key`), each toggling its mark by type. */
function markBindings(): Record<string, Command> {
    const bindings: Record<string, Command> = {};
    for (const action of TOOLBAR_ACTIONS) {
        if (action.key !== undefined && action.apply.kind === 'mark') {
            const type = marks[action.apply.mark];
            bindings[action.key] = action.apply.markup === null ? toggleMark(type) : toggleMarkType(type, action.apply.markup);
        }
    }
    return bindings;
}

function markdownKeymap(): Plugin {
    const item = nodes.list_item;
    return keymap({
        // The binding the undo hints name (`keys.ts`): the key a hint offers is this one.
        [UNDO_BINDING]: undo,
        ...Object.fromEntries(REDO_BINDINGS.map(binding => [binding, redo])),
        // Backspace right after an input rule fired gives back what was typed.
        'Backspace': undoInputRule,
        // By mark type, written with the delimiter of the row's mark that names
        // the key when added (`Mod-b` Bold `**`, `Mod-i` Italic `*`, Mod-backtick
        // Code); the toolbar's buttons toggle one delimiter each
        // (toolbar/commands.ts). The binding is the action's `key`, the one
        // its tooltip and `aria-keyshortcuts` name (`actions.ts`).
        ...markBindings(),
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
 * A node decoration per fenced code block that names a language and stands in `from`…`to`:
 * its `data-lang`, the corner tag's text (`editor.css`). A block counts when it touches the
 * range, its ends included — the same overlap `DecorationSet.find` answers by.
 */
function languageDecorationsBetween(doc: Node, from: number, to: number): Decoration[] {
    const decorations: Decoration[] = [];
    // One more on each side: `nodesBetween` leaves out a node that only ends where the range starts.
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
        if (node.type === editorSchema.nodes.code_block && pos <= to && pos + node.nodeSize >= from) {
            const language = languageOf(String(node.attrs.params ?? ''));
            if (language !== '') {
                decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-lang': language }));
            }
        }
        // Blocks stand in blocks; nothing inside a textblock is one.
        return !node.isTextblock;
    });
    return decorations;
}

function languageDecorations(doc: Node): DecorationSet {
    const decorations = languageDecorationsBetween(doc, 0, doc.content.size);
    return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decorations);
}

/**
 * The set after `tr`: mapped through it, and drawn again only where it changed the document.
 * A key in a paragraph of a long document with a thousand fences used to rebuild every
 * decoration (7.7 ms a key at 81 KB, 57 ms at 250 KB, nearly all of it `DecorationSet.create`);
 * now it maps them and looks at the few blocks the edit touched.
 */
function updatedLanguageDecorations(set: DecorationSet, tr: Transaction): DecorationSet {
    let from = Infinity;
    let to = -Infinity;
    const touch = (start: number, end: number, after: Mapping) => {
        from = Math.min(from, after.map(start, -1));
        to = Math.max(to, after.map(end, 1));
    };
    tr.steps.forEach((step, index) => {
        const after = tr.mapping.slice(index + 1);
        if (step instanceof AttrStep) {
            // An attribute set changes no position, so its step map is empty: the node's own start is the range.
            touch(step.pos, step.pos + 1, after);
            return;
        }
        tr.mapping.maps[index].forEach((_oldStart, _oldEnd, newStart, newEnd) => touch(newStart, newEnd, after));
    });
    const mapped = set.map(tr.mapping, tr.doc);
    if (from > to) {
        return mapped;
    }
    // Everything that touches the changed range goes and is read again from the new document.
    const stale = mapped.find(from, to);
    const kept = stale.length === 0 ? mapped : mapped.remove(stale);
    const added = languageDecorationsBetween(tr.doc, from, to);
    return added.length === 0 ? kept : kept.add(tr.doc, added);
}

/**
 * The fence's language at its block's corner: editor chrome, drawn from a
 * decoration on the node — not part of what the node renders, so a copy, a
 * drag and the schema's `toDOM` never carry it. Kept with the document, as
 * the admonitions' title bars are.
 */
export function codeLanguagesPlugin(): Plugin<DecorationSet> {
    return new Plugin<DecorationSet>({
        state: {
            init: (_config, state) => languageDecorations(state.doc),
            apply: (tr, set) => (tr.docChanged ? updatedLanguageDecorations(set, tr) : set),
        },
        props: {
            decorations(state) {
                return this.getState(state);
            },
        },
    });
}

/**
 * Every plugin the editor state is built with, in the order they must run.
 * `wikiEmbeds` says whether the host's engine reads wiki embeds: the page's
 * definition of it (`currentReadsWikiEmbeds`), unless a test says otherwise.
 */
export function editorPlugins(wikiEmbeds: () => boolean = currentReadsWikiEmbeds): Plugin[] {
    const embedInput = wikiEmbedInputRules(wikiEmbeds);
    return [
        // First: every key below reads the selection the DOM shows.
        domSelectionFirst(),
        markdownInputRules(),
        // `![[name]]` typed: an embed atom, where the engine reads embeds; a plugin of its own,
        // which a note's own text insertion runs and no other rule (`wikiEmbeds.ts`).
        embedInput,
        // Ahead of the Markdown keys: Tab, Enter and Backspace mean something else inside a note,
        // Enter and Backspace in an empty paragraph of a container or an admonition,
        // and Tab, Enter and Shift+Enter in a table cell (a sidebar in a cell keeps its own keys).
        // Before the note's keys: an arrow beside an emoji steps over it, wherever it stands.
        emojiKeymap(),
        noteKeymap(),
        wrapperKeymap(),
        tableKeymap(),
        markdownKeymap(),
        keymap(baseKeymap),
        history(),
        dropCursor(),
        gapCursor(),
        hintPlugin(),
        notesPlugin(embedInput),
        wikiEmbedPastePlugin(wikiEmbeds),
        admonitionTitlesPlugin(),
        codeLanguagesPlugin(),
        ...tablesPlugins(),
        // Before the fidelity plugin, which then clears `src` for the whole edit, this plugin's included.
        emojiPlugin(),
        fidelityPlugin(),
    ];
}
