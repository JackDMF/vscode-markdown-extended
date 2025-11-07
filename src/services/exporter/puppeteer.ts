import * as puppeteer from 'puppeteer-core';
import * as vscode from 'vscode';
import * as path from 'path';
import { MarkdownDocument } from '../common/markdownDocument';
import { mkdirsSync, mergeSettings } from '../common/tools';
import { renderPage } from './shared';
import { MarkdownExporter, exportFormat, Progress, ExportItem } from './interfaces';
import { config } from '../common/config';
import { BrowserManager } from '../browser/browserManager';
import { ExtensionContext } from '../common/extensionContext';
import { ErrorHandler, ErrorSeverity } from '../common/errorHandler';

/**
 * Puppeteer-based exporter for PDF, PNG, and JPG formats.
 * Implements singleton pattern for consistent exporter access.
 */
export class PuppeteerExporter implements MarkdownExporter {
    private static _instance?: PuppeteerExporter;
    
    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {}
    
    /**
     * Get the PuppeteerExporter singleton instance
     */
    static get instance(): PuppeteerExporter {
        if (!PuppeteerExporter._instance) {
            PuppeteerExporter._instance = new PuppeteerExporter();
        }
        return PuppeteerExporter._instance;
    }
    
    /**
     * Set a custom instance (for testing purposes only)
     * @internal
     */
    static _setInstance(instance: PuppeteerExporter): void {
        PuppeteerExporter._instance = instance;
    }
    
    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        PuppeteerExporter._instance = undefined;
    }

    async Export(items: ExportItem[], progress: Progress) {
        let count = items.length;
        let browser: puppeteer.Browser | undefined;
        let page: puppeteer.Page | undefined;
        
        try {
            // Ensure browser is available using centralized BrowserManager
            const browserManager = BrowserManager.getInstance(ExtensionContext.current.vsContext);
            const executablePath = await browserManager.ensureBrowser(progress);
            
            progress.report({ message: "Initializing browser..." });
            browser = await puppeteer.launch({
                executablePath: executablePath || undefined,
                headless: true, // Use headless mode
                args: ['--no-sandbox', '--disable-setuid-sandbox'] // For compatibility
            });
            page = await browser.newPage();

            // Process all export items sequentially
            await items.reduce(
                (p, c, i) => {
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
                            () => this.exportFile(c, page!)
                        );
                },
                Promise.resolve(null)
            );
        } catch (error) {
            // Use centralized error handler with recovery options
            await ErrorHandler.handle(error, {
                operation: 'Export to ' + items[0]?.format || 'file',
                filePath: items[0]?.uri.fsPath,
                details: {
                    formatType: items[0]?.format,
                    itemCount: items.length,
                    outputPath: items[0]?.fileName
                },
                recoveryOptions: [
                    ErrorHandler.retryOption(async () => {
                        await this.Export(items, progress);
                    }),
                    ErrorHandler.openSettingsOption('markdownExtended.puppeteerExecutable'),
                    {
                        label: 'Install Browser',
                        action: async () => {
                            await vscode.commands.executeCommand('markdownExtended.installBrowser');
                        }
                    }
                ]
            }, ErrorSeverity.Error);
            
            throw error;
        } finally {
            // Critical: Always clean up resources in reverse order of creation
            // Close page first, then browser
            try {
                if (page) {
                    await page.close();
                }
            } catch (closeError) {
                // Log but don't throw - we still want to close the browser
                console.error('Error closing page:', closeError);
            }
            
            try {
                if (browser) {
                    await browser.close();
                }
            } catch (closeError) {
                // Log but don't throw - cleanup errors shouldn't mask original error
                console.error('Error closing browser:', closeError);
            }
        }
    }
    private async exportFile(item: ExportItem, page: puppeteer.Page) {
        let document = new MarkdownDocument(await vscode.workspace.openTextDocument(item.uri));
        let inject = getInjectStyle(item.format);
        let html = renderPage(document, inject);
        let ptConf: any = {};
        mkdirsSync(path.dirname(item.fileName));

        await page.setContent(html, { waitUntil: 'networkidle0' });
        switch (item.format) {
            case exportFormat.PDF:
                ptConf = mergeSettings(
                    config.puppeteerDefaultSetting.pdf,
                    config.puppeteerUserSetting.pdf,
                    document.meta.puppeteerPDF
                );
                ptConf = Object.assign(ptConf, { path: item.fileName });
                await page.pdf(ptConf);
                break;
            case exportFormat.JPG:
            case exportFormat.PNG:
                ptConf = mergeSettings(
                    config.puppeteerDefaultSetting.image,
                    config.puppeteerUserSetting.image,
                    document.meta.puppeteerImage
                );
                ptConf = Object.assign(ptConf, { path: item.fileName, type: item.format == exportFormat.JPG ? "jpeg" : "png" });
                if (item.format == exportFormat.PNG) ptConf.quality = undefined;
                await page.screenshot(ptConf);
                break;
            default:
                return Promise.reject("PuppeteerExporter does not support HTML export.");
        }
    }
    FormatAvailable(format: exportFormat) {
        return [
            exportFormat.PDF,
            exportFormat.JPG,
            exportFormat.PNG
        ].indexOf(format) > -1;
    }
}

/**
 * Singleton instance of PuppeteerExporter for backward compatibility.
 * @deprecated Use PuppeteerExporter.instance instead
 */
export const puppeteerExporter = PuppeteerExporter.instance;

function getInjectStyle(formate: exportFormat): string {
    switch (formate) {
        case exportFormat.PDF:
            return `body, .vscode-body {
                max-width: 100% !important;
                width: 1000px !important;
                margin: 0!important;
                padding: 0!important;
            }`;
        case exportFormat.JPG:
        case exportFormat.PNG:
            return `body, .vscode-body {
                width: 1000px !important;
            }`
        default:
            return "";
    }
}