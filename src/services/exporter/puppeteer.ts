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

/**
 * Puppeteer-based exporter for PDF, PNG, and JPG formats.
 * Implements singleton pattern for consistent exporter access.
 */
class PuppeteerExporter implements MarkdownExporter {
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
        
        try {
            // Ensure browser is available using centralized BrowserManager
            const browserManager = BrowserManager.getInstance(ExtensionContext.current.vsContext);
            const executablePath = await browserManager.ensureBrowser(progress);
            
            progress.report({ message: "Initializing browser..." });
            const browser = await puppeteer.launch({
                executablePath: executablePath || undefined,
                headless: true, // Use headless mode
                args: ['--no-sandbox', '--disable-setuid-sandbox'] // For compatibility
            });
            const page = await browser.newPage();

            return items.reduce(
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
                            () => this.exportFile(c, page)
                        );
                },
                Promise.resolve(null)
            ).then(async () => await browser.close())
                .catch(async err => {
                    await browser.close();
                    return Promise.reject(err);
                });
        } catch (error) {
            return this.handleExportError(error, items);
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

    /**
     * Handle export errors with user-friendly messages
     */
    private async handleExportError(error: any, items: ExportItem[]): Promise<never> {
        const errorMessage = error?.message || String(error);
        let userMessage = 'Export failed: ';
        let showDetails = false;

        if (errorMessage.includes('Could not find') || errorMessage.includes('Browser') || errorMessage.includes('Chromium')) {
            userMessage += 'Browser not found. ';
            const action = await vscode.window.showErrorMessage(
                userMessage + 'Would you like to configure a custom browser path?',
                'Configure Browser',
                'View Details',
                'Retry'
            );

            if (action === 'Configure Browser') {
                await vscode.commands.executeCommand(
                    'workbench.action.openSettings',
                    'markdownExtended.puppeteerExecutable'
                );
            } else if (action === 'View Details') {
                showDetails = true;
            }
        } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
            userMessage += 'Operation timed out. The page may be taking too long to load.';
            await vscode.window.showErrorMessage(userMessage, 'View Details');
            showDetails = true;
        } else if (errorMessage.includes('EACCES') || errorMessage.includes('permission')) {
            userMessage += 'Permission denied. Check file permissions for the output directory.';
            await vscode.window.showErrorMessage(userMessage, 'View Details');
            showDetails = true;
        } else {
            userMessage += 'An unexpected error occurred.';
            await vscode.window.showErrorMessage(userMessage, 'View Details');
            showDetails = true;
        }

        if (showDetails) {
            const detailsMessage = [
                'Export Error Details:',
                `Files to export: ${items.map(i => path.basename(i.fileName)).join(', ')}`,
                `Error: ${errorMessage}`,
                error.stack ? `Stack: ${error.stack}` : ''
            ].filter(Boolean).join('\n');
            
            vscode.window.showErrorMessage('Check Output panel for error details.');
            const output = vscode.window.createOutputChannel('MDExtended Export Error');
            output.appendLine(detailsMessage);
            output.show();
        }

        return Promise.reject(error);
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