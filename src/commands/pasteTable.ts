import { Command } from './command';
import * as vscode from 'vscode';
import { convertToMarkdownTable } from '../services/table/convertTable';
import { editTextDocument } from '../services/common/editTextDocument';
export class CommandPasteTable extends Command {
    execute() {
        //let text = clip.readSync().trim();
        vscode.env.clipboard.readText().then(text => {
            if (!text) {return;}
            const tableText = convertToMarkdownTable(text);
            if (!tableText) {return;}
            const editor = vscode.window.activeTextEditor;
            return editTextDocument(
                editor.document, [{
                    range: editor.selection,
                    replace: tableText
                }]
            );
        });
    }
    constructor() {
        super("markdownExtended.pasteAsTable");
    }
}