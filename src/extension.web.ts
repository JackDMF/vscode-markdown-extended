'use strict';
import * as vscode from 'vscode';
import * as markdownIt from './@types/markdown-it';
import { plugins } from './plugin/plugins';
import { Config } from './services/common/config';
import { mdConfig } from './services/contributes/mdConfig';
import { CommandCopy, CommandCopyWithStyles } from './commands/copy';
import { CommandPasteTable } from './commands/pasteTable';
import { CommandFormateTable } from './commands/formateTable';
import { createToggleCommands } from './commands/toggleFormats';
import { commandTableEdits } from './commands/tableEdits';
import { ExtensionContext } from './services/common/extensionContext';
import { ActiveVisualEditorTracker } from './editor/host/activeEditor';
import { EditorEngineHost } from './editor/host/engineHost';

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

    // The engine the inline toggles read documents with, as the desktop
    // build's Visual Editor parses them.
    const engines = new EditorEngineHost(ctx.extension.id, line => {
        try {
            extensionContext.outputPanel.appendLine(line);
        } catch {
            // Nothing left to report to.
        }
    });

    const subscriptions = [
        extensionContext.outputPanel,
        Config.instance,
        mdConfig,
        engines,
        createToggleCommands(engines),
        commandTableEdits,
        new CommandCopy(),
        new CommandCopyWithStyles(),
        new CommandPasteTable(),
        new CommandFormateTable(),
        webUnavailable('markdownExtended.export'),
        webUnavailable('markdownExtended.exportWorkspace'),
        webUnavailable('markdownExtended.installBrowser'),
    ].filter(Boolean);

    // The Visual Editor is desktop-only (extension.ts), so no editor is ever
    // active here; the export has the same shape on both builds.
    const visualEditors = new ActiveVisualEditorTracker();
    subscriptions.push(visualEditors);

    ctx.subscriptions.push(...subscriptions);

    return {
        visualEditor: visualEditors.api,
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
