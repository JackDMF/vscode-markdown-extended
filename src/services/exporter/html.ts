import * as vscode from 'vscode';
import * as fs from 'fs';
import { mkdirsSync } from '../common/tools';
import * as path from 'path';
import { renderPage } from './shared';
import { MarkdownExporter, exportFormat, Progress, ExportItem } from './interfaces';
import { setTimeout } from 'timers';
import { ErrorHandler, ErrorSeverity } from '../common/errorHandler';

/**
 * HTML exporter for markdown documents.
 * Implements singleton pattern for consistent exporter access.
 */
class HtmlExporter implements MarkdownExporter {
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

    async Export(items: ExportItem[], progress: Progress) {
        let count = items.length;
        return items.reduce((p, c, i) => {
            return p
                .then(
                    () => {
                        if (progress) progress.report({
                            message: `${path.basename(c.fileName)} (${i + 1}/${count})`,
                            increment: ~~(1 / count * 100)
                        });
                    }
                )
                .then(
                    () => this.exportFile(c)
                )
                .catch(async (error) => {
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
                });
        }, Promise.resolve(null));
    }
    private async exportFile(item: ExportItem) {

        let document = await vscode.workspace.openTextDocument(item.uri);
        let html = renderPage(document);
        mkdirsSync(path.dirname(item.fileName));
        return new Promise((resolve, reject) => {
            try {
                fs.writeFileSync(item.fileName, html, "utf-8");
                resolve("ok");
            } catch (error) {
                reject(error);
            }
        });
    }
    FormatAvailable(format: exportFormat) {
        return exportFormat.HTML == format;
    }
}

/**
 * Singleton instance of HtmlExporter for backward compatibility.
 * @deprecated Use HtmlExporter.instance instead
 */
export const htmlExporter = HtmlExporter.instance;