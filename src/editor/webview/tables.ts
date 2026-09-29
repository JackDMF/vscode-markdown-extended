/**
 * Editing a pipe table in the page: the keys, the verbs of its object toolbar,
 * what the page refuses to make, and the invariants a pipe table has that
 * `prosemirror-tables`' model does not. ProseMirror only, no DOM, so every
 * verb is a transaction a test can check on an `EditorState`.
 *
 * **The keys** (`tableKeymap`), ahead of the Markdown keys: `Tab` moves to the
 * next cell, its text selected, and in the last cell adds a row and moves into
 * it; `Shift+Tab` moves back and stays in the first cell; `Enter` moves to the
 * cell below — a pipe table has one line per row, so it never breaks a line —
 * and in the last row adds a row, except that `Enter` in an empty last row
 * takes the row away again and leaves the table for a new paragraph after it,
 * as `Enter` in an empty last item leaves a list. `Shift+Enter` would be a hard
 * break, which a cell cannot hold: it is refused, with the reason beside the
 * caret. Arrow keys, a drag across cells (a `CellSelection`) and pasting cells
 * are `tableEditing`'s. Column resizing is not installed: a width is not
 * Markdown.
 *
 * **The invariants** (`normalizeTables`, run by every verb here and appended
 * to every other transaction): a pipe table has exactly one header row, its
 * first, so the first row's cells are `table_header` and every other row's
 * `table_cell` — a row added above the header becomes the header, a deleted
 * header row hands the role to the next; and a column has one alignment, its
 * header cell's, which every cell of it carries (it draws `text-align`). The
 * verbs that add a row copy the alignment of the row beside it, so a row added
 * above the header keeps the columns' alignment. There is no *Toggle header
 * row*: GFM has no table without one, and markdown-it-multimd-table's
 * headerless table is a source block here.
 *
 * **What is not made** (`tablesPlugin`'s filter): a transaction that would
 * leave in a table what the tidy form cannot write (`unwritableInTable`) is
 * refused with the reason, as the notes plugin refuses an unwritable note.
 */
import { keymap } from 'prosemirror-keymap';
import { Node } from 'prosemirror-model';
import { Command, EditorState, NodeSelection, Plugin, TextSelection, Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { CellSelection, TableMap, TableRect, addColumn, addRow, deleteColumn, deleteRow, goToNextCell, isInTable, selectedRect, tableEditing } from 'prosemirror-tables';
import { PRESERVE_SOURCE_META } from '../fidelity';
import { TableAlign, editorSchema } from '../schema';
import { serializeNode, unwritableInTable } from '../serialize';
import { showHint } from './hint';
import { refusableRange } from './notes';
import { insertionPoint } from './toolbar/commands';
import type { SourceContext } from './toolbar/commands';

const nodes = editorSchema.nodes;

/** What `Shift+Enter` says in a cell. */
export const CELL_BREAK_REFUSAL = 'A table cell holds one line: a pipe table has no line break inside a cell.';

/** The top-level table the selection is in, both its ends, with its position; `null` outside one. */
export function tableAt(state: EditorState): { pos: number; node: Node } | null {
    const sel = state.selection;
    if (sel instanceof NodeSelection && sel.node.type === nodes.table) {
        return { pos: sel.from, node: sel.node };
    }
    const { $from, $to } = sel;
    if ($from.depth < 1 || $to.depth < 1 || $from.node(1) !== $to.node(1) || $from.node(1).type !== nodes.table) {
        return null;
    }
    return { pos: $from.before(1), node: $from.node(1) };
}

/** The selection's cells as a rectangle of the table, or `null` when the selection is in no cell. */
function rectOf(state: EditorState): TableRect | null {
    return isInTable(state) || state.selection instanceof CellSelection ? selectedRect(state) : null;
}

/** The position before the cell at `row`, `col` of the table starting (content) at `tableStart` in `doc`. */
function cellPos(doc: Node, tableStart: number, row: number, col: number): number | null {
    const table = doc.nodeAt(tableStart - 1);
    if (!table || table.type !== nodes.table) {
        return null;
    }
    const map = TableMap.get(table);
    if (row < 0 || row >= map.height || col < 0 || col >= map.width) {
        return null;
    }
    return tableStart + map.map[row * map.width + col];
}

/** The caret at the end of the cell before `pos`, or the cell's text selected. */
function intoCell(tr: Transaction, pos: number, how: 'end' | 'all'): Transaction {
    const cell = tr.doc.nodeAt(pos);
    const end = pos + 1 + (cell?.content.size ?? 0);
    return tr.setSelection(TextSelection.create(tr.doc, how === 'all' ? pos + 1 : end, end));
}

/** One cell a pipe table's invariants change: its type, its alignment. */
interface CellFix {
    pos: number;
    type: typeof nodes.table_cell;
    attrs: Record<string, unknown>;
}

/** What `normalizeTables` changes in `doc`: nothing, for a document whose tables are pipe tables. */
function tableFixes(doc: Node): CellFix[] {
    const fixes: CellFix[] = [];
    doc.forEach((table, offset) => {
        if (table.type !== nodes.table) {
            return;
        }
        const map = TableMap.get(table);
        const start = offset + 1;
        const aligns: TableAlign[] = [];
        table.firstChild?.forEach(cell => {
            aligns.push((cell.attrs.align as TableAlign) ?? null);
        });
        for (let row = 0; row < map.height; row++) {
            for (let col = 0; col < map.width; col++) {
                const at = map.map[row * map.width + col];
                const cell = table.nodeAt(at);
                if (!cell) {
                    continue;
                }
                const type = row === 0 ? nodes.table_header : nodes.table_cell;
                const align = aligns[col] ?? null;
                if (cell.type !== type || cell.attrs.align !== align) {
                    fixes.push({ pos: start + at, type, attrs: { ...cell.attrs, align } });
                }
            }
        }
    });
    return fixes;
}

/**
 * Every top-level table of `tr.doc` made a pipe table again, in `tr`: the
 * first row's cells headers and the others body cells, each cell aligned as
 * its column's header cell. Sizes do not change, so positions hold.
 */
export function normalizeTables(tr: Transaction): Transaction {
    for (const fix of tableFixes(tr.doc)) {
        tr.setNodeMarkup(fix.pos, fix.type, fix.attrs);
    }
    return tr;
}

/** The alignment of the cells of row `ref` copied onto the cells of row `row` (a new one). */
function copyRowAligns(tr: Transaction, tableStart: number, row: number, ref: number): void {
    const table = tr.doc.nodeAt(tableStart - 1);
    if (!table) {
        return;
    }
    const map = TableMap.get(table);
    for (let col = 0; col < map.width; col++) {
        const at = cellPos(tr.doc, tableStart, row, col);
        const from = cellPos(tr.doc, tableStart, ref, col);
        const cell = at === null ? null : tr.doc.nodeAt(at);
        const source = from === null ? null : tr.doc.nodeAt(from);
        if (at !== null && cell && source && cell.attrs.align !== source.attrs.align) {
            tr.setNodeMarkup(at, undefined, { ...cell.attrs, align: source.attrs.align });
        }
    }
}

/**
 * A row added above or below the selection's rows, its cells aligned as the
 * row beside it, the caret in its cell under the selection's first column.
 * Above the header row, the new row is the header (`normalizeTables`).
 */
export function addRowTransaction(state: EditorState, side: 'above' | 'below'): Transaction | null {
    const rect = rectOf(state);
    if (rect === null) {
        return null;
    }
    const row = side === 'above' ? rect.top : rect.bottom;
    const tr = state.tr;
    addRow(tr, rect, row);
    copyRowAligns(tr, rect.tableStart, row, side === 'above' ? row + 1 : row - 1);
    normalizeTables(tr);
    const pos = cellPos(tr.doc, rect.tableStart, row, rect.left);
    return (pos === null ? tr : intoCell(tr, pos, 'end')).scrollIntoView();
}

/** A column added left or right of the selection's columns, unaligned, the caret in its cell on the selection's first row. */
export function addColumnTransaction(state: EditorState, side: 'left' | 'right'): Transaction | null {
    const rect = rectOf(state);
    if (rect === null) {
        return null;
    }
    const col = side === 'left' ? rect.left : rect.right;
    const tr = state.tr;
    addColumn(tr, rect, col);
    normalizeTables(tr);
    const pos = cellPos(tr.doc, rect.tableStart, rect.top, col);
    return (pos === null ? tr : intoCell(tr, pos, 'end')).scrollIntoView();
}

/** Why the selection's rows cannot be deleted, or `null`: a pipe table keeps at least its header row. */
export function deleteRowRefusal(state: EditorState): string | null {
    const rect = rectOf(state);
    if (rect === null) {
        return 'Put the caret in a row of the table.';
    }
    return rect.top === 0 && rect.bottom === rect.map.height
        ? 'These are all the table\'s rows: Delete table removes it.'
        : null;
}

/** Why the selection's columns cannot be deleted, or `null`: a table keeps at least one. */
export function deleteColumnRefusal(state: EditorState): string | null {
    const rect = rectOf(state);
    if (rect === null) {
        return 'Put the caret in a column of the table.';
    }
    return rect.left === 0 && rect.right === rect.map.width
        ? 'These are all the table\'s columns: Delete table removes it.'
        : null;
}

/** A command's transaction, captured rather than dispatched. */
function captured(command: Command, state: EditorState): Transaction | null {
    let out: Transaction | null = null;
    command(state, tr => {
        out = tr;
    });
    return out;
}

/** The selection's rows deleted; a deleted header row hands the role to the next row. `null` where refused. */
export function deleteRowTransaction(state: EditorState): Transaction | null {
    if (deleteRowRefusal(state) !== null) {
        return null;
    }
    const tr = captured(deleteRow, state);
    return tr === null ? null : normalizeTables(tr).scrollIntoView();
}

/** The selection's columns deleted. `null` where refused. */
export function deleteColumnTransaction(state: EditorState): Transaction | null {
    if (deleteColumnRefusal(state) !== null) {
        return null;
    }
    const tr = captured(deleteColumn, state);
    return tr === null ? null : normalizeTables(tr).scrollIntoView();
}

/** The alignment of the selection's first column — its header cell's — or `null`. */
export function columnAlign(state: EditorState): TableAlign {
    const rect = rectOf(state);
    if (rect === null) {
        return null;
    }
    const pos = cellPos(state.doc, rect.tableStart, 0, rect.left);
    return pos === null ? null : ((state.doc.nodeAt(pos)?.attrs.align as TableAlign) ?? null);
}

/** Every cell of the selection's columns aligned `align` (`null`: the delimiter's `---`). `null` when nothing changes. */
export function alignColumnTransaction(state: EditorState, align: TableAlign): Transaction | null {
    const rect = rectOf(state);
    if (rect === null) {
        return null;
    }
    const tr = state.tr;
    for (let col = rect.left; col < rect.right; col++) {
        for (let row = 0; row < rect.map.height; row++) {
            const pos = cellPos(tr.doc, rect.tableStart, row, col);
            const cell = pos === null ? null : tr.doc.nodeAt(pos);
            if (pos !== null && cell && cell.attrs.align !== align) {
                tr.setNodeMarkup(pos, undefined, { ...cell.attrs, align });
            }
        }
    }
    return tr.docChanged ? tr.scrollIntoView() : null;
}

/**
 * The table at `pos` made a source block holding its text — its slice while
 * untouched, else the tidy form — for **Edit source**: the page opens the
 * block's source box and asks the host to render it; the source's commit is
 * parsed by the host again, a table once more if it still is one. It keeps the
 * table's `gap` and carries `PRESERVE_SOURCE_META`, as `wrap-source` does; one
 * history event, so one undo returns the table.
 */
export function tableSourceTransaction(state: EditorState, pos: number, context: SourceContext): { tr: Transaction; src: string } | null {
    const node = state.doc.nodeAt(pos);
    if (!node || node.type !== nodes.table) {
        return null;
    }
    const own = node.attrs.src as string | null;
    const src = own ?? `${serializeNode(node, { defaultWrap: context.defaultWrap }).replace(/\n/g, context.eol)}${context.eol}`;
    const tr = state.tr.replaceWith(pos, pos + node.nodeSize, nodes.raw_block.create({ src, gap: node.attrs.gap ?? null, html: '' }));
    tr.setSelection(NodeSelection.create(tr.doc, pos));
    return { tr: tr.setMeta(PRESERVE_SOURCE_META, true).scrollIntoView(), src };
}

/** A new table: a header row of `columns` cells named `Column 1` …, and `rows` empty body rows. */
export function newTable(columns: number, rows: number): Node {
    const header = nodes.table_row.create(null, Array.from({ length: columns }, (_, c) => nodes.table_header.create(null, editorSchema.text(`Column ${c + 1}`))));
    const body = Array.from({ length: rows }, () => nodes.table_row.create(null, Array.from({ length: columns }, () => nodes.table_cell.create())));
    return nodes.table.create(null, [header, ...body]);
}

/** **Insert → Table**: a new table after the current block (`insertionPoint`), the first header cell's text selected, so typing names the column. */
export function insertTableTransaction(state: EditorState, columns: number, rows: number): Transaction {
    const pos = insertionPoint(state);
    const tr = state.tr.insert(pos, newTable(columns, rows));
    // Into the table, its first row, its first cell.
    return intoCell(tr, pos + 2, 'all').scrollIntoView();
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** `Tab`: the next cell, its text selected; in the last cell, a new row's first cell. `Shift+Tab`: the previous, staying in the first. */
export function moveCell(direction: 1 | -1): Command {
    return (state, dispatch) => {
        if (!isInTable(state)) {
            return false;
        }
        if (goToNextCell(direction)(state, dispatch)) {
            return true;
        }
        if (direction === -1) {
            // In the first cell: the key stays in the table rather than leaving the editor.
            return true;
        }
        const rect = selectedRect(state);
        const tr = addRowTransaction(state, 'below');
        const pos = tr === null ? null : cellPos(tr.doc, rect.tableStart, rect.bottom, 0);
        if (tr !== null && pos !== null) {
            dispatch?.(intoCell(tr, pos, 'all').scrollIntoView());
        }
        return true;
    };
}

/** Whether every cell of the table's row `row` is empty: an empty cell is two positions, its open and its close. */
function rowIsEmpty(table: Node, row: number): boolean {
    return table.child(row).content.size === table.child(row).childCount * 2;
}

/**
 * `Enter`: the cell below, the caret at its end; in the last row a new row,
 * unless that row is empty — then it goes, and the caret leaves the table for
 * a new paragraph after it (a header row alone is never taken away).
 */
export const enterInCell: Command = (state, dispatch) => {
    if (!isInTable(state)) {
        return false;
    }
    const rect = selectedRect(state);
    const below = cellPos(state.doc, rect.tableStart, rect.bottom, rect.left);
    if (below !== null) {
        dispatch?.(intoCell(state.tr, below, 'end').scrollIntoView());
        return true;
    }
    const last = rect.map.height - 1;
    if (last > 0 && rect.bottom === rect.map.height && rowIsEmpty(rect.table, last)) {
        if (dispatch) {
            const tablePos = rect.tableStart - 1;
            const tr = state.tr;
            let rowPos = rect.tableStart;
            for (let r = 0; r < last; r++) {
                rowPos += rect.table.child(r).nodeSize;
            }
            tr.delete(rowPos, rowPos + rect.table.child(last).nodeSize);
            const after = tablePos + (tr.doc.nodeAt(tablePos)?.nodeSize ?? 0);
            tr.insert(after, nodes.paragraph.create());
            dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
        }
        return true;
    }
    const tr = addRowTransaction(state, 'below');
    if (tr !== null) {
        dispatch?.(tr);
    }
    return true;
};

/** `Shift+Enter` in a cell: refused, with the reason beside the caret. */
export const refuseBreakInCell: Command = (state, _dispatch, view) => {
    if (!isInTable(state)) {
        return false;
    }
    if (view) {
        showHint(view, CELL_BREAK_REFUSAL, 'refusal');
    }
    return true;
};

/** The keys of a table, ahead of the Markdown keys (see the module comment). */
export function tableKeymap(): Plugin {
    return keymap({
        'Tab': moveCell(1),
        'Shift-Tab': moveCell(-1),
        'Enter': enterInCell,
        'Shift-Enter': refuseBreakInCell,
    });
}

// ---------------------------------------------------------------------------
// The plugins
// ---------------------------------------------------------------------------

/** Why the transaction must not be applied: it leaves in a table what the tidy form cannot write (`unwritableInTable`). */
export function tableRefusal(tr: Transaction): string | null {
    const range = refusableRange(tr);
    return range === null ? null : unwritableInTable(tr.doc, range.from, range.to);
}

/**
 * `prosemirror-tables`' editing (cell selections, arrows, pasting cells, fixing
 * a table with holes), then this module's refusal and invariants.
 */
export function tablesPlugins(): Plugin[] {
    let editorView: EditorView | null = null;
    return [
        tableEditing(),
        new Plugin({
            filterTransaction(tr) {
                const reason = tableRefusal(tr);
                if (reason !== null) {
                    if (editorView) {
                        showHint(editorView, reason, 'refusal');
                    }
                    return false;
                }
                return true;
            },
            view(view) {
                editorView = view;
                return {
                    destroy() {
                        editorView = null;
                    },
                };
            },
            appendTransaction(transactions, _oldState, newState) {
                if (!transactions.some(tr => tr.docChanged) || tableFixes(newState.doc).length === 0) {
                    return null;
                }
                const tr = normalizeTables(newState.tr);
                // A re-sync is the host's document, which a table always is; the fix-up is not a step anybody took.
                return transactions.some(t => t.getMeta(PRESERVE_SOURCE_META) === true) ? tr.setMeta('addToHistory', false) : tr;
            },
        }),
    ];
}
