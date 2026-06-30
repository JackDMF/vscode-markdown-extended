import * as vscode from 'vscode';
import { promises as fsPromises } from 'fs';
import { mkdirsAsync } from '../common/tools';
import * as path from 'path';
import { renderPage } from './shared';
import { MermaidRenderer } from './mermaidRenderer';
import { MarkdownExporter, ExportFormat, Progress, ExportItem } from './interfaces';
import { ErrorHandler, ErrorSeverity } from '../common/errorHandler';

/**
 * HTML exporter for markdown documents.
 * Implements singleton pattern for consistent exporter access.
 */
export class HtmlExporter implements MarkdownExporter {
    private static _instance?: HtmlExporter;
    
    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {}
    
    /**
     * Get the HtmlExporter singleton instance
     */
    static get instance(): HtmlExporter {
        if (!HtmlExporter._instance) {
            HtmlExporter._instance = new HtmlExporter();
        }
        return HtmlExporter._instance;
    }
    
    /**
     * Set a custom instance (for testing purposes only)
     * @internal
     */
    static _setInstance(instance: HtmlExporter): void {
        HtmlExporter._instance = instance;
    }
    
    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        HtmlExporter._instance = undefined;
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    async Export(items: ExportItem[], progress: Progress) {
        const count = items.length;
        for (let i = 0; i < items.length; i++) {
            const c = items[i];
            try {
                if (progress) {
                    progress.report({
                        message: `${path.basename(c.fileName)} (${i + 1}/${count})`,
                        increment: ~~(1 / count * 100)
                    });
                }
                await this.exportFile(c);
            } catch (error) {
                // Use centralized error handler
                await ErrorHandler.handle(error, {
                    operation: 'Export to HTML',
                    filePath: c.uri.fsPath,
                    details: {
                        outputPath: c.fileName,
                        currentItem: i + 1,
                        totalItems: count
                    },
                    recoveryOptions: [
                        ErrorHandler.retryOption(async () => {
                            await this.exportFile(c);
                        }),
                        ErrorHandler.openFileOption(c.uri.fsPath)
                    ]
                }, ErrorSeverity.Error);
                throw error;
            }
        }
        return null;
    }
    private async exportFile(item: ExportItem) {
        const document = await vscode.workspace.openTextDocument(item.uri);
        // Render mermaid diagrams (if any) to inline SVG before writing the file.
        const html = await MermaidRenderer.instance.process(renderPage(document));
        
        // Use async directory creation
        await mkdirsAsync(path.dirname(item.fileName));
        
        // Use async file write
        await fsPromises.writeFile(item.fileName, html, "utf-8");
    }
    // eslint-disable-next-line @typescript-eslint/naming-convention
    FormatAvailable(format: ExportFormat) {
        return ExportFormat.HTML === format;
    }
}

/**
 * Singleton instance of HtmlExporter for backward compatibility.
 * @deprecated Use HtmlExporter.instance instead
 */
export const htmlExporter = HtmlExporter.instance;
