import * as vscode from 'vscode';
import { DocumentTable } from "./documentTables";
import { splitColumns } from './mdTableParse';
import { Edit, editTextDocument } from '../common/editTextDocument';

export enum EditType {
    Add,
    Delete,
    Move,
}

export enum TargetType {
    Row,
    Column,
}

interface SelectedRange {
    range: vscode.Range, // effective rang extracted from selection
    start: number, // start of table column/row
    count: number, // count of table column/row
}

export function editTable(editor: vscode.TextEditor, table: DocumentTable, et: EditType, tt: TargetType, before: boolean) {
    editTextDocument(
        editor.document,
        [getTableEdit(editor, table, et, tt, before)]
    );
}

export function getTableEdit(editor: vscode.TextEditor, table: DocumentTable, et: EditType, tt: TargetType, before: boolean): Edit {
    const document = editor.document;
    const selection = editor.selection;
    let offsetLine = 0;
    let offsetCharachter = 0;

    let rng: SelectedRange = undefined;
    if (tt === TargetType.Row) {
        rng = getSelectedRow(table, selection, et === EditType.Add ? before : true);
        switch (et) {
            case EditType.Add:
                offsetLine = before ? rng.count : 0;
                offsetCharachter = 0;
                table.table.addRow(rng.start, rng.count);
                break;
            case EditType.Delete:
                offsetLine = 0;
                offsetCharachter = 0;
                table.table.deleteRow(rng.start, rng.count);
                break;
            case EditType.Move:
                offsetLine = before ? -rng.count : rng.count;
                offsetCharachter = 0;
                table.table.moveRow(rng.start, rng.count, before ? -1 : 1);
                break;
            default:
                break;
        }
    }
    else {
        rng = getSelectedColumn(table, selection, et === EditType.Add ? before : true, document);
        switch (et) {
            case EditType.Add:
                offsetLine = 0;
                offsetCharachter = before ? 4 * rng.count : 0;
                table.table.addColumn(rng.start, rng.count);
                break;
            case EditType.Delete:
                offsetLine = 0;
                offsetCharachter = 0;
                table.table.deleteColumn(rng.start, rng.count);
                break;
            case EditType.Move:
                offsetLine = 0;
                offsetCharachter = 0;
                const offsetCol = table.table.columnWidths[rng.start + (before ? -1 : rng.count)];
                if (offsetCol) {
                    offsetCharachter = before ? -table.table.columnWidths[rng.start - 1] - 3 : table.table.columnWidths[rng.start + rng.count] + 3;
                    table.table.moveColumn(rng.start, rng.count, before ? -1 : 1);
                }
                break;
            default:
                break;
        }
    }
    return <Edit>{
        range: table.range,
        replace: table.table.stringify(),
        selectionOffset: {
            orignal: rng.range,
            offset: {
                line: offsetLine,
                charachter: offsetCharachter,
            }
        }
    }
}

// if not insert, insertBefore should be always true
function getSelectedRow(table: DocumentTable, selection: vscode.Selection, insertBefore: boolean): SelectedRange {
    let rowStart = 0;
    let rowCount = 0;
    const tableBodyRange = new vscode.Range(
        new vscode.Position(table.range.start.line + 2, 0),
        table.range.end
    );
    const intersection = tableBodyRange.intersection(selection);
    if (intersection) {
        rowStart = intersection.start.line - tableBodyRange.start.line;
        rowCount = intersection.end.line - intersection.start.line + 1;
    } else {
        rowStart = 0;
        rowCount = 1;
    }
    if (!insertBefore) {rowStart += rowCount;}
    return {
        range: intersection,
        start: rowStart,
        count: rowCount,
    }
}

// if not insert, insertBefore should be always true
function getSelectedColumn(table: DocumentTable, selection: vscode.Selection, insertBefore: boolean, document: vscode.TextDocument): SelectedRange {
    const intersectSelection = selection.intersection(table.range);
    const selectionStartLine = document.lineAt(intersectSelection.start.line).range;
    const effectiveRange = intersectSelection.intersection(selectionStartLine);
    let colStart = -1;
    let colCount = 0;
    const startLineCells = getRowCells(document, selectionStartLine);

    startLineCells.map((c, i) => {
        if (c.intersection(selection)) {
            if (colStart < 0) {colStart = i;}
            colCount++;
        }
    });

    // let colEnd = -1;
    // for (let i = 0; i < startLineCells.length; i++) {
    //     if (startLineCells[i].intersection(selectionStartPoint)) {
    //         colStart = i;
    //         break;
    //     }
    // }
    // for (let i = 0; i < endLineCells.length; i++) {
    //     if (endLineCells[i].intersection(selectionEndPoint)) {
    //         if (i > colStart) {
    //             colEnd = i;
    //         } else {
    //             colEnd = colStart;
    //             colStart = i;
    //         }
    //         break;
    //     }
    // }
    // colCount = colEnd - colStart + 1;

    if (!insertBefore) {colStart += colCount;}
    return {
        range: effectiveRange,
        start: colStart,
        count: colCount,
    }
}

function getRowCells(document: vscode.TextDocument, line: vscode.Range): vscode.Range[] {
    let pos = 0;
    return splitColumns(document.getText(line)).map((c, i, ar) => {
        const start = new vscode.Position(line.start.line, pos);
        const end = new vscode.Position(line.start.line, pos + c.length);
        pos += c.length + 1; //cell.length + '|'.length
        if ((i === 0 || i === ar.length - 1) && !c.trim()) {return undefined;}
        return new vscode.Range(start, end);
    }).filter(r => r !== undefined);
}
