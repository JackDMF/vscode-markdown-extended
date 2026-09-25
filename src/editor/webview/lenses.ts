/**
 * Other extensions' code lenses, drawn as rows above the blocks they belong to,
 * the way the text editor draws them above lines: small, dimmed, `a | b | c`,
 * each title a command. The host asks VS Code for the lenses and says which
 * top-level block each row is for (`host/lenses.ts`); the page only draws them
 * and posts `runLens` with the id of the one clicked.
 *
 * **A row follows its block, not its index.** The rows arrive for the host's
 * parse of a text the page held; from then on the page may split, join and
 * move blocks before the next refresh arrives. On arrival each row is put on
 * the top-level node at its index, and from then on it follows that node
 * through every transaction the way `fidelityPlugin` follows a node for its
 * `src` and `gap` (`descent`: the same object, else the node the mapping takes
 * its start to). A node that disappears takes its row with it; a node that
 * descends from none (the second half of a split) has none until the refresh.
 *
 * The rows are widgets at the start of their block: not content, never
 * serialized, not selectable, and every event inside them is theirs.
 */
import { Node } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { descent, topLevelChildren } from '../fidelity';
import type { LensItem, LensRow } from '../protocol';

/** One row as the page holds it: `key` is fresh per `lenses` message, so a widget is redrawn only when its row was replaced. */
interface HeldRow {
    key: string;
    items: readonly LensItem[];
}

interface LensState {
    /** Parallel to the document's top-level children: the row above child `i`, or `null`. */
    rows: readonly (HeldRow | null)[];
    decorations: DecorationSet;
}

export const lensPluginKey = new PluginKey<LensState>('mepLenses');

let received = 0;

/**
 * Glyphs for the product icons lens titles use (`$(name)`, VS Code's codicon
 * syntax). The page has no access to the workbench's icon font, so the common
 * ones are drawn as characters and any other is left out, its text kept.
 */
const ICONS: Readonly<Record<string, string>> = {
    'add': '+',
    'beaker': '⚗',
    'check': '✓',
    'check-all': '✓',
    'circle-filled': '●',
    'circle-outline': '○',
    'close': '✕',
    'error': '✕',
    'file': '□',
    'file-code': '‹›',
    'info': 'ℹ',
    'link': '→',
    'pass': '✓',
    'play': '▶',
    'references': '→',
    'run': '▶',
    'symbol-event': '⚡',
    'warning': '⚠',
};

/** A lens title with its `$(icon)` references drawn as characters, or left out where there is none. */
export function lensLabel(title: string): string {
    return title
        .replace(/\$\(([a-z0-9-]+)(?:~[a-z]+)?\)/gi, (_whole, name: string) => ICONS[name.toLowerCase()] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

function rowDOM(row: HeldRow, run: (id: string) => void): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mep-lens-row';
    el.contentEditable = 'false';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Code lenses');
    // The pointer is the row's: no caret placed, no focus taken from the text.
    el.addEventListener('mousedown', e => e.preventDefault());
    row.items.forEach((item, k) => {
        if (k > 0) {
            const sep = document.createElement('span');
            sep.className = 'mep-lens-separator';
            sep.setAttribute('aria-hidden', 'true');
            sep.textContent = ' | ';
            el.append(sep);
        }
        const label = lensLabel(item.title);
        const id = item.id;
        if (id === undefined) {
            const text = document.createElement('span');
            text.className = 'mep-lens-text';
            text.textContent = label;
            if (item.tooltip) {
                text.title = item.tooltip;
            }
            el.append(text);
            return;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mep-lens';
        button.dataset.lens = id;
        button.textContent = label;
        button.title = item.tooltip ?? item.title;
        button.addEventListener('click', e => {
            e.preventDefault();
            run(id);
        });
        el.append(button);
    });
    return el;
}

function decorate(doc: Node, rows: readonly (HeldRow | null)[], run: (id: string) => void): DecorationSet {
    const widgets: Decoration[] = [];
    doc.forEach((_child, offset, index) => {
        const row = rows[index];
        if (row) {
            widgets.push(Decoration.widget(offset, () => rowDOM(row, run), {
                side: -1,
                key: row.key,
                ignoreSelection: true,
                stopEvent: () => true,
            }));
        }
    });
    return DecorationSet.create(doc, widgets);
}

function noRows(doc: Node): (HeldRow | null)[] {
    return Array.from({ length: doc.childCount }, () => null);
}

/** Put `rows` — from a `lenses` message, indexed by the host's parse — on the top-level nodes at those indices, replacing every row before. */
export function setLensesTransaction(state: EditorState, rows: readonly LensRow[]): Transaction {
    return state.tr.setMeta(lensPluginKey, rows).setMeta('addToHistory', false);
}

/** The rows the state holds, as block index and titles: for tests. */
export function lensRowsOf(state: EditorState): { blockIndex: number; titles: string[] }[] {
    const held = lensPluginKey.getState(state)?.rows ?? [];
    return held.flatMap((row, blockIndex) => (row ? [{ blockIndex, titles: row.items.map(i => i.title) }] : []));
}

/** The lens rows; `run` is called with a lens's id when it is clicked or chosen with the keyboard. */
export function lensPlugin(run: (id: string) => void): Plugin<LensState> {
    return new Plugin<LensState>({
        key: lensPluginKey,
        state: {
            init: (_config, state) => ({ rows: noRows(state.doc), decorations: DecorationSet.empty }),
            apply(tr, value, oldState, newState): LensState {
                const incoming = tr.getMeta(lensPluginKey) as readonly LensRow[] | undefined;
                if (incoming !== undefined) {
                    const tag = `mep-lens-${++received}`;
                    const rows = noRows(newState.doc);
                    for (const row of incoming) {
                        if (row.blockIndex >= 0 && row.blockIndex < rows.length && row.items.length > 0) {
                            rows[row.blockIndex] = { key: `${tag}-${row.blockIndex}`, items: row.items };
                        }
                    }
                    return { rows, decorations: decorate(newState.doc, rows, run) };
                }
                if (!tr.docChanged) {
                    return value;
                }
                const from = descent([tr], topLevelChildren(oldState.doc), topLevelChildren(newState.doc));
                const rows = from.map(i => (i < 0 ? null : value.rows[i] ?? null));
                return { rows, decorations: decorate(newState.doc, rows, run) };
            },
        },
        props: {
            decorations: state => lensPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
    });
}
