import * as vscode from 'vscode';
import { tablesOf } from "./documentTables";
import { editType, getTableEdit, targetType } from './editTable';
import { editTextDocument } from '../common/editTextDocument';


export function editTables(et: editType, tt: targetType, before: boolean) {
    const editor = vscode.window.activeTextEditor;
    const document = editor.document;
    const selection = editor.selection;

    const tables = tablesOf(document).filter(t => t.range.intersection(selection));
    if (!tables || !tables.length) {return;}

    editTextDocument(
        editor.document,
        tables.map(tb => getTableEdit(editor, tb, et, tt, before))
    );
}
