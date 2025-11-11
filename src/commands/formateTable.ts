import { Command } from './command';
import * as vscode from 'vscode';
import { editTextDocument, Edit } from '../services/common/editTextDocument';
import { tablesOf } from '../services/table/documentTables';
export class CommandFormateTable extends Command {
    execute() {
        const editor = vscode.window.activeTextEditor;
        const selection = editor.selection;
        const tables = tablesOf(editor.document);
        const edits: Edit[] = [];
        tables.map(t => {
            if (t.range.intersection(selection))
                {edits.push({ range: t.range, replace: t.table.stringify() });}
        });
        return editTextDocument(
            editor.document,
            edits
        );
    }
    constructor() {
        super("markdownExtended.formateTable");
    }
}