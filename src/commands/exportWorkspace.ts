import * as vscode from 'vscode';
import { Command } from './command';
import { exportUri } from "./exportUri";

export class CommandExportWorkSpace extends Command {
    async execute(uri: vscode.Uri) {
       return exportUri(uri);
    }
    constructor() {
        super("markdownExtended.exportWorkspace");
    }
}
