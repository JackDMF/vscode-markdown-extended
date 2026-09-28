import * as vscode from 'vscode';
import { Command } from '../../commands/command';
import { EditorEngineHost } from './engineHost';
import { editorPage, localResourceRoots } from './html';
import { collectIncludeProviders } from './includes';
import { VisualEditorSession } from './session';

import { VISUAL_EDITOR_VIEW_TYPE } from './viewType';

export { VISUAL_EDITOR_VIEW_TYPE };

/**
 * The rich editor as a `CustomTextEditorProvider` over the file's own
 * `TextDocument`.
 *
 * Not a `CustomEditorProvider` with a document model of its own, because Req
 * Explorer's commands (and the text editor, and every other extension) write to
 * the `TextDocument` through `WorkspaceEdit`s; a private model would have to be
 * told about each of them, and the first one it was not told about would be
 * saved over. Over the shared document, VS Code keeps dirty state, save and the
 * document's undo stack, and the editor is one more view of the file.
 */
export class VisualEditorProvider implements vscode.CustomTextEditorProvider {
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly engines: EditorEngineHost,
        private readonly log: (line: string) => void,
        private readonly selfId?: string,
    ) { }

    resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
        const webview = panel.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: localResourceRoots(this.extensionUri),
        };
        webview.html = editorPage(webview, this.extensionUri, document.uri);
        const session = new VisualEditorSession(document, webview, {
            engine: () => this.engines.get(),
            onDidChangeEngine: this.engines.onDidChange,
            log: this.log,
            includeProviders: () => collectIncludeProviders(this.selfId, this.log),
        });
        panel.onDidDispose(() => session.dispose());
    }
}

/**
 * `markdownExtended.openVisualEditor`: open a Markdown file in the rich editor —
 * the file the explorer or editor context menu passed, else the active one.
 */
export class CommandOpenVisualEditor extends Command {
    constructor() {
        super('markdownExtended.openVisualEditor');
    }

    async execute(target?: unknown): Promise<void> {
        const uri = target instanceof vscode.Uri
            ? target
            : vscode.window.activeTextEditor?.document.languageId === 'markdown'
                ? vscode.window.activeTextEditor.document.uri
                : undefined;
        if (uri === undefined) {
            vscode.window.showInformationMessage('Open a Markdown file first, then run "Open in Visual Editor".');
            return;
        }
        await vscode.commands.executeCommand('vscode.openWith', uri, VISUAL_EDITOR_VIEW_TYPE);
    }
}

/**
 * Register the rich editor and its command.
 *
 * `retainContextWhenHidden` keeps the webview alive in a background tab: the
 * ProseMirror state holds the undo history and an edit still inside its
 * debounce, and both would be lost if VS Code tore the page down on every tab
 * switch.
 */
export function registerVisualEditor(context: vscode.ExtensionContext, log: (line: string) => void): vscode.Disposable {
    const engines = new EditorEngineHost(context.extension.id, log);
    const provider = new VisualEditorProvider(context.extensionUri, engines, log, context.extension.id);
    return vscode.Disposable.from(
        engines,
        vscode.window.registerCustomEditorProvider(VISUAL_EDITOR_VIEW_TYPE, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        new CommandOpenVisualEditor(),
    );
}
