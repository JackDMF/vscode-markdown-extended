import { MDTable, TableAlign } from "./mdTable";
export function stringifyMDTable(table: MDTable, compact?: boolean, padding?: number): string {
    padding = padding || 1;
    const rows = table.data.map((row, i) => table.indentation + stringifyRow(table, row, table.rowMergeFlags[i], compact, padding));
    const sep = table.indentation + stringifyHeaderSeperator(table, compact, padding);
    rows.splice(table.headerRowCount, 0, sep);
    return rows.join('\n');
}

function stringifyHeaderSeperator(table: MDTable, compact: boolean, padding: number): string {
    const colCount = table.data[0].length;
    return [...Array(colCount).keys()].reduce(
        (p, i) => p + formatHeaderCell(table.aligns[i], table.columnWidths[i], compact, padding) + "|"
        , "|"
    );
}
function stringifyRow(table: MDTable, row: string[], merged: boolean, compact: boolean, padding: number): string {
    const columnWidths = table.columnWidths;
    return row.reduce((p, c, i) => {
        const splittor = (i === row.length - 1 && merged) ? '\\' : '|';
        if (c === null) {return p + splittor;}
        // current col width
        let width = columnWidths[i];
        let idx = i + 1;
        // try to add merged cells' width
        while (row[idx] === null) {
            width += columnWidths[idx] + padding * 2;
            idx++;
        }
        return p + (compact ? c : formatCell(c, table.cellWidth(c), width, table.aligns[i], padding)) + splittor;
    }, "|");
}
function formatHeaderCell(align: TableAlign, columnWidth: number, compact: boolean, padding: number) {
    switch (align) {
        case TableAlign.Center:
            if (compact) {return ":-:";}
            return addPadding(":" + "-".repeat(columnWidth - 2) + ":", padding, padding);
        case TableAlign.Left:
            if (compact) {return ":-";}
            return addPadding(":" + "-".repeat(columnWidth - 1), padding, padding);
        case TableAlign.Right:
            if (compact) {return "-:";}
            return addPadding("-".repeat(columnWidth - 1) + ":", padding, padding);
        case TableAlign.Auto:
        default:
            if (compact) {return "-";}
            return addPadding("-".repeat(columnWidth), padding, padding);
    }
}
function formatCell(cell: string, cellWidth: number, width: number, align: TableAlign, padding: number): string {
    let leftPadding = padding;
    let rightPadding = padding;
    const room = width - cellWidth;
    switch (align) {
        case TableAlign.Center:
            leftPadding += ~~(room / 2);
            rightPadding += ~~(room / 2);
            if (leftPadding + rightPadding !== room + padding * 2) {rightPadding += 1;}
            break;
        case TableAlign.Left:
            rightPadding += room;
            break;
        case TableAlign.Right:
            leftPadding += room;
            break;
        case TableAlign.Auto:
        default:
            rightPadding += room;
            break;
    }
    return addPadding(cell.trim(), leftPadding, rightPadding);
}

function addPadding(cell: string, left: number, right: number): string {
    const SPACE = " ";
    return SPACE.repeat(left) + cell.trim() + SPACE.repeat(right);
}
