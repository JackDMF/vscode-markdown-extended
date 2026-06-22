'use strict';
import * as vscode from 'vscode';
import * as markdownIt from './@types/markdown-it';
import { plugins } from './plugin/plugins';
import { Config } from './services/common/config';
import { mdConfig } from './services/contributes/mdConfig';
import { CommandCopy, CommandCopyWithStyles } from './commands/copy';
import { CommandPasteTable } from './commands/pasteTable';
import { CommandFormateTable } from './commands/formateTable';
import { commandToggles } from './commands/toggleFormats';
import { commandTableEdits } from './commands/tableEdits';
import { ExtensionContext } from './services/common/extensionContext';

// Deprecated: Use ExtensionContext.current.markdown instead
// @deprecated
export let markdown: markdownIt.MarkdownIt;
// Deprecated: Use ExtensionContext.current.vsContext instead
// @deprecated
export let context: vscode.ExtensionContext;
// Deprecated: Use ExtensionContext.current.outputPanel instead
// @deprecated
export let outputPanel: vscode.OutputChannel;

export function activate(ctx: vscode.ExtensionContext) {
    const extensionContext = ExtensionContext.initialize(ctx);
    context = ctx;
    outputPanel = extensionContext.outputPanel;

    const webUnavailable = (label: string) =>
        vscode.commands.registerCommand(label, () => {
            vscode.window.showWarningMessage(
                `This export feature is not available in the VS Code web editor.`
            );
        });

    const subscriptions = [
        extensionContext.outputPanel,
        Config.instance,
        mdConfig,
        commandToggles,
        commandTableEdits,
        new CommandCopy(),
        new CommandCopyWithStyles(),
        new CommandPasteTable(),
        new CommandFormateTable(),
        webUnavailable('markdownExtended.export'),
        webUnavailable('markdownExtended.exportWorkspace'),
        webUnavailable('markdownExtended.installBrowser'),
    ].filter(Boolean);

    ctx.subscriptions.push(...subscriptions);

    return {
        extendMarkdownIt(md: markdownIt.MarkdownIt) {
            plugins
                .filter(p => p && typeof p.plugin === 'function')
                .forEach(({ plugin, args }) => {
                    try {
                        md.use(plugin, ...args);
                    } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        extensionContext.outputPanel.appendLine(
                            `[ERROR] Failed to load markdown plugin: ${msg}`
                        );
                    }
                });

            extensionContext.setMarkdown(md);
            markdown = md;
            return md;
        }
    };
}

export function deactivate() {
    ExtensionContext._reset();
}
