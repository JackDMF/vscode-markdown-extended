import * as vscode from 'vscode';
import * as markdownIt from '../../@types/markdown-it';

/**
 * Centralized extension context and state management.
 * Replaces global mutable state with a thread-safe singleton pattern.
 * 
 * @example
 * ```typescript
 * // Initialize on activation
 * ExtensionContext.initialize(ctx);
 * 
 * // Access anywhere in the codebase
 * const markdown = ExtensionContext.current.markdown;
 * const outputPanel = ExtensionContext.current.outputPanel;
 * ```
 */
export class ExtensionContext {
    private static _instance?: ExtensionContext;
    private _markdown?: markdownIt.MarkdownIt;
    private _vsContext?: vscode.ExtensionContext;
    private _outputPanel: vscode.OutputChannel;

    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor(ctx: vscode.ExtensionContext) {
        this._vsContext = ctx;
        this._outputPanel = vscode.window.createOutputChannel("MDExtended");
    }

    /**
     * Initialize the extension context singleton.
     * Should be called once during extension activation.
     * 
     * @param ctx VS Code extension context
     * @returns The initialized extension context instance
     * @throws Error if already initialized
     */
    static initialize(ctx: vscode.ExtensionContext): ExtensionContext {
        if (ExtensionContext._instance) {
            throw new Error('ExtensionContext already initialized');
        }
        ExtensionContext._instance = new ExtensionContext(ctx);
        return ExtensionContext._instance;
    }

    /**
     * Get the current extension context instance.
     * 
     * @returns The extension context instance
     * @throws Error if not initialized
     */
    static get current(): ExtensionContext {
        if (!ExtensionContext._instance) {
            throw new Error('ExtensionContext not initialized. Call initialize() first.');
        }
        return ExtensionContext._instance;
    }

    /**
     * Check if the extension context is initialized
     */
    static get isInitialized(): boolean {
        return !!ExtensionContext._instance;
    }

    /**
     * Get the markdown-it instance.
     * 
     * @returns The markdown-it instance
     * @throws Error if markdown engine not initialized
     */
    get markdown(): markdownIt.MarkdownIt {
        if (!this._markdown) {
            throw new Error('Markdown engine not initialized. Call setMarkdown() first.');
        }
        return this._markdown;
    }

    /**
     * Check if markdown engine is initialized
     */
    get isMarkdownInitialized(): boolean {
        return !!this._markdown;
    }

    /**
     * Set the markdown-it instance.
     * Called by VS Code when the markdown engine is ready.
     * 
     * @param md The markdown-it instance
     */
    setMarkdown(md: markdownIt.MarkdownIt): void {
        if (this._markdown) {
            this._outputPanel.appendLine('[WARNING] Markdown engine already initialized, replacing...');
        }
        this._markdown = md;
    }

    /**
     * Get the VS Code extension context
     */
    get vsContext(): vscode.ExtensionContext {
        if (!this._vsContext) {
            throw new Error('VS Code extension context not available');
        }
        return this._vsContext;
    }

    /**
     * Get the output panel for extension messages
     */
    get outputPanel(): vscode.OutputChannel {
        return this._outputPanel;
    }

    /**
     * Get the global storage path for the extension.
     * Useful for storing browser binaries, cache, etc.
     */
    get globalStoragePath(): string {
        return this.vsContext.globalStorageUri.fsPath;
    }

    /**
     * Get the workspace storage path for the extension.
     * Useful for workspace-specific data.
     */
    get workspaceStoragePath(): string | undefined {
        return this.vsContext.storageUri?.fsPath;
    }

    /**
     * Dispose of extension resources.
     * Should be called during extension deactivation.
     */
    dispose(): void {
        this._outputPanel.dispose();
    }

    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        if (ExtensionContext._instance) {
            ExtensionContext._instance.dispose();
            ExtensionContext._instance = undefined;
        }
    }
}
