'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CommandExportCurrent } from './commands/exportCurrent';
import { CommandInstallBrowser } from './commands/installBrowser';
import * as markdowIt from './@types/markdown-it';
import { plugins } from './plugin/plugins';
import { CommandCopy, CommandCopyWithStyles } from './commands/copy';
import { config } from './services/common/config';
import { mdConfig } from './services/contributes/mdConfig';
import { CommandPasteTable } from './commands/pasteTable';
import { CommandFormateTable } from './commands/formateTable';
import { commandToggles } from './commands/toggleFormats';
import { commandTableEdits } from './commands/tableEdits';
import { CommandExportWorkSpace } from './commands/exportWorkspace';

export var markdown: markdowIt.MarkdownIt;
export var context: vscode.ExtensionContext;
export var outputPanel = vscode.window.createOutputChannel("MDExtended");
// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(ctx: vscode.ExtensionContext) {
    context = ctx;
    const subscriptions = [
        outputPanel,
        config,
        mdConfig,
        commandToggles,
        commandTableEdits,
        new CommandExportCurrent(),
        new CommandExportWorkSpace(),
        new CommandCopy(),
        new CommandCopyWithStyles(),
        new CommandPasteTable(),
        new CommandFormateTable(),
        new CommandInstallBrowser(),
    ].filter(Boolean);
    
    ctx.subscriptions.push(...subscriptions);
    return {
        extendMarkdownIt(md: markdowIt.MarkdownIt) {
            // Filter out null/undefined plugins and add error handling
            plugins
                .filter(p => p && typeof p.plugin === 'function')
                .forEach(({plugin, args}) => {
                    try {
                        md.use(plugin, ...args);
                    } catch (error) {
                        console.error('Failed to load markdown plugin:', error);
                        vscode.window.showWarningMessage(
                            `Markdown plugin failed to load: ${error.message}`
                        );
                    }
                });
            markdown = md;
            return md;
        }
    };
}

// this method is called when your extension is deactivated
export function deactivate() {
}