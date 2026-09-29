import * as vscode from 'vscode';
import { Command } from './command';
import { exportUri } from './exportUri';

export class CommandExportCurrent extends Command {
    async execute(resource?: unknown) {
        // A menu or another extension names the document: VS Code passes the resource uri
        // first from editor/title and explorer/context, and a caller may pass its own.
        if (resource instanceof vscode.Uri) {
            return exportUri(resource);
        }
        const uri = activeTabUri()
            ?? (vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0])?.document?.uri;
        if (!uri) {
            vscode.window.showInformationMessage("Open a Markdown file first, then run Export.");
            return;
        }
        return exportUri(uri);
    }
    constructor() {
        super("markdownExtended.export");
    }
}

/** The document of the active tab, for a text tab or a custom editor (the Visual Editor has no text editor). */
function activeTabUri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
        return input.uri;
    }
    return undefined;
}
