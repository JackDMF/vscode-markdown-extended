import * as vscode from 'vscode';
import { ExtensionContext } from './extensionContext';

/**
 * Error severity levels for categorizing errors
 */
export enum ErrorSeverity {
    /** Critical error - extension cannot continue */
    Critical = 'critical',
    /** Error - feature broken but extension functional */
    Error = 'error',
    /** Warning - non-critical issue */
    Warning = 'warning',
    /** Info - informational message */
    Info = 'info'
}

/**
 * Context information for error handling
 */
export interface ErrorContext {
    /** Operation being performed when error occurred */
    operation: string;
    /** File path related to the error (if applicable) */
    filePath?: string;
    /** Additional details about the error context */
    details?: Record<string, any>;
    /** Recovery options to present to user */
    recoveryOptions?: ErrorRecoveryOption[];
}

/**
 * Recovery option for error handling
 */
export interface ErrorRecoveryOption {
    /** Label shown to user */
    label: string;
    /** Action to perform when selected */
    action: () => Promise<void> | void;
    /** Whether this is the default action */
    isDefault?: boolean;
}

/**
 * Centralized error handling service.
 * Provides consistent error reporting, logging, and recovery options.
 * 
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   await ErrorHandler.handle(error, {
 *     operation: 'Export PDF',
 *     filePath: document.uri.fsPath,
 *     recoveryOptions: [{
 *       label: 'Retry',
 *       action: () => riskyOperation()
 *     }]
 *   }, ErrorSeverity.Error);
 * }
 * ```
 */
export class ErrorHandler {
    /**
     * Handle an error with appropriate user feedback and logging
     * 
     * @param error The error to handle
     * @param context Context information about the error
     * @param severity Severity level of the error
     */
    static async handle(
        error: any,
        context: ErrorContext,
        severity: ErrorSeverity = ErrorSeverity.Error
    ): Promise<void> {
        const message = this.formatErrorMessage(error, context);
        const fullDetails = this.formatFullDetails(error, context);
        
        // Log to output panel
        this.logToOutput(fullDetails, severity);
        
        // Show appropriate UI message based on severity
        switch (severity) {
            case ErrorSeverity.Critical:
                await this.handleCriticalError(message, error, context);
                break;
            case ErrorSeverity.Error:
                await this.handleError(message, error, context);
                break;
            case ErrorSeverity.Warning:
                await this.handleWarning(message, context);
                break;
            case ErrorSeverity.Info:
                this.handleInfo(message);
                break;
        }
    }
    
    /**
     * Handle a critical error with detailed options
     */
    private static async handleCriticalError(
        message: string,
        error: any,
        context: ErrorContext
    ): Promise<void> {
        const actions = ['View Details', 'Report Issue'];
        
        // Add recovery options if provided
        if (context.recoveryOptions && context.recoveryOptions.length > 0) {
            for (const option of context.recoveryOptions) {
                actions.unshift(option.label);
            }
        }
        
        const action = await vscode.window.showErrorMessage(
            `❌ Critical: ${message}`,
            ...actions
        );
        
        if (action === 'View Details') {
            this.showDetailsPanel(error, context);
        } else if (action === 'Report Issue') {
            this.openIssueReporter(error, context);
        } else if (action && context.recoveryOptions) {
            // Execute recovery action
            const option = context.recoveryOptions.find(o => o.label === action);
            if (option) {
                try {
                    await option.action();
                } catch (recoveryError) {
                    // If recovery fails, show a simpler error
                    vscode.window.showErrorMessage(
                        `Recovery failed: ${this.extractErrorMessage(recoveryError)}`
                    );
                }
            }
        }
    }
    
    /**
     * Handle a standard error
     */
    private static async handleError(
        message: string,
        error: any,
        context: ErrorContext
    ): Promise<void> {
        const actions: string[] = ['View Details'];
        
        // Add recovery options if provided
        if (context.recoveryOptions && context.recoveryOptions.length > 0) {
            for (const option of context.recoveryOptions) {
                actions.unshift(option.label);
            }
        }
        
        const action = await vscode.window.showErrorMessage(
            message,
            ...actions
        );
        
        if (action === 'View Details') {
            this.showDetailsPanel(error, context);
        } else if (action && context.recoveryOptions) {
            // Execute recovery action
            const option = context.recoveryOptions.find(o => o.label === action);
            if (option) {
                try {
                    await option.action();
                } catch (recoveryError) {
                    vscode.window.showErrorMessage(
                        `Recovery failed: ${this.extractErrorMessage(recoveryError)}`
                    );
                }
            }
        }
    }
    
    /**
     * Handle a warning
     */
    private static async handleWarning(
        message: string,
        context: ErrorContext
    ): Promise<void> {
        const actions: string[] = [];
        
        if (context.recoveryOptions && context.recoveryOptions.length > 0) {
            for (const option of context.recoveryOptions) {
                actions.push(option.label);
            }
        }
        
        if (actions.length === 0) {
            vscode.window.showWarningMessage(message);
            return;
        }
        
        const action = await vscode.window.showWarningMessage(message, ...actions);
        
        if (action && context.recoveryOptions) {
            const option = context.recoveryOptions.find(o => o.label === action);
            if (option) {
                await option.action();
            }
        }
    }
    
    /**
     * Handle an info message
     */
    private static handleInfo(message: string): void {
        vscode.window.showInformationMessage(message);
    }
    
    /**
     * Format error message for user display
     */
    private static formatErrorMessage(error: any, context: ErrorContext): string {
        const errorMsg = this.extractErrorMessage(error);
        
        if (context.filePath) {
            return `${context.operation} failed for "${context.filePath}": ${errorMsg}`;
        }
        
        return `${context.operation} failed: ${errorMsg}`;
    }
    
    /**
     * Format full error details for logging
     */
    private static formatFullDetails(error: any, context: ErrorContext): string {
        const lines: string[] = [];
        
        lines.push(`=== Error Report ===`);
        lines.push(`Timestamp: ${new Date().toISOString()}`);
        lines.push(`Operation: ${context.operation}`);
        
        if (context.filePath) {
            lines.push(`File: ${context.filePath}`);
        }
        
        if (context.details) {
            lines.push(`\nContext Details:`);
            for (const [key, value] of Object.entries(context.details)) {
                lines.push(`  ${key}: ${JSON.stringify(value)}`);
            }
        }
        
        lines.push(`\nError Message:`);
        lines.push(this.extractErrorMessage(error));
        
        if (error instanceof Error && error.stack) {
            lines.push(`\nStack Trace:`);
            lines.push(error.stack);
        }
        
        lines.push(`\n=== End Report ===\n`);
        
        return lines.join('\n');
    }
    
    /**
     * Extract readable error message from various error types
     */
    private static extractErrorMessage(error: any): string {
        if (typeof error === 'string') {
            return error;
        }
        
        if (error instanceof Error) {
            return error.message;
        }
        
        if (error && typeof error === 'object') {
            if (error.message) {
                return String(error.message);
            }
            if (error.toString && error.toString() !== '[object Object]') {
                return error.toString();
            }
            try {
                return JSON.stringify(error);
            } catch {
                return 'Unknown error (could not serialize)';
            }
        }
        
        return String(error);
    }
    
    /**
     * Log error to output panel
     */
    private static logToOutput(message: string, severity: ErrorSeverity): void {
        if (!ExtensionContext.isInitialized) {
            console.error('ExtensionContext not initialized, logging to console:', message);
            return;
        }
        
        const outputPanel = ExtensionContext.current.outputPanel;
        
        const prefix = severity === ErrorSeverity.Critical ? '🔴 CRITICAL' :
                      severity === ErrorSeverity.Error ? '❌ ERROR' :
                      severity === ErrorSeverity.Warning ? '⚠️  WARNING' :
                      'ℹ️  INFO';
        
        outputPanel.appendLine(`${prefix}: ${new Date().toLocaleTimeString()}`);
        outputPanel.appendLine(message);
    }
    
    /**
     * Show detailed error information in output panel
     */
    private static showDetailsPanel(error: any, context: ErrorContext): void {
        if (!ExtensionContext.isInitialized) {
            return;
        }
        
        const outputPanel = ExtensionContext.current.outputPanel;
        const details = this.formatFullDetails(error, context);
        
        outputPanel.clear();
        outputPanel.appendLine(details);
        outputPanel.show();
    }
    
    /**
     * Open GitHub issue reporter with error details
     */
    private static openIssueReporter(error: any, context: ErrorContext): void {
        const errorMsg = this.extractErrorMessage(error);
        const title = encodeURIComponent(`Error: ${context.operation}`);
        const body = encodeURIComponent(
            `**Operation:** ${context.operation}\n\n` +
            `**Error Message:**\n${errorMsg}\n\n` +
            `**Context:**\n${JSON.stringify(context.details || {}, null, 2)}\n\n` +
            `**Environment:**\n` +
            `- VS Code Version: ${vscode.version}\n` +
            `- OS: ${process.platform} ${process.arch}\n\n` +
            `**Steps to Reproduce:**\n1. \n\n` +
            `**Additional Information:**\n`
        );
        
        const url = `https://github.com/JackDMF/vscode-markdown-extended/issues/new?title=${title}&body=${body}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
    }
    
    /**
     * Create a recovery option for retrying an operation
     */
    static retryOption(operation: () => Promise<void> | void): ErrorRecoveryOption {
        return {
            label: 'Retry',
            action: operation,
            isDefault: true
        };
    }
    
    /**
     * Create a recovery option for opening settings
     */
    static openSettingsOption(settingId?: string): ErrorRecoveryOption {
        return {
            label: 'Open Settings',
            action: () => {
                if (settingId) {
                    vscode.commands.executeCommand('workbench.action.openSettings', settingId);
                } else {
                    vscode.commands.executeCommand('workbench.action.openSettings', 'markdownExtended');
                }
            }
        };
    }
    
    /**
     * Create a recovery option for opening a file
     */
    static openFileOption(filePath: string): ErrorRecoveryOption {
        return {
            label: 'Open File',
            action: async () => {
                const uri = vscode.Uri.file(filePath);
                const document = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(document);
            }
        };
    }
}
