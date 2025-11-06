import * as puppeteer from 'puppeteer-core';
import { install, Browser, BrowserPlatform, resolveBuildId, computeExecutablePath } from '@puppeteer/browsers';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MarkdownDocument } from '../common/markdownDocument';
import { mkdirsSync, mergeSettings } from '../common/tools';
import { renderPage } from './shared';
import { MarkdownExporter, exportFormat, Progress, ExportItem } from './interfaces';
import { config } from '../common/config';
import { context } from '../../extension';

class PuppeteerExporter implements MarkdownExporter {
    async Export(items: ExportItem[], progress: Progress) {
        let count = items.length;
        
        try {
            // Ensure browser is available
            const executablePath = await this.ensureBrowser(progress);
            
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
     * Ensure browser is available, downloading if necessary
     * @param progress Progress reporter
     * @returns Path to browser executable, or empty string to use bundled browser
     */
    private async ensureBrowser(progress: Progress): Promise<string> {
        // If user configured a custom executable, validate and use it
        const customExe = config.puppeteerExecutable;
        if (customExe) {
            if (fs.existsSync(customExe)) {
                return customExe;
            } else {
                vscode.window.showWarningMessage(
                    `Configured Puppeteer executable not found: ${customExe}. Will download Chromium instead.`
                );
            }
        }

        // Use extension's global storage for browser cache
        const cacheDir = path.join(context.globalStorageUri.fsPath, 'browsers');
        
        try {
            // Ensure cache directory exists
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }

            // Detect platform
            const platform = this.detectBrowserPlatform();
            
            // Get the latest stable Chrome build ID
            const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
            
            // Compute where the browser would be installed
            const executablePath = computeExecutablePath({
                browser: Browser.CHROME,
                buildId,
                cacheDir
            });

            // Check if browser is already installed
            if (fs.existsSync(executablePath)) {
                return executablePath;
            }

            // Browser not found, ask user to download
            const storageKey = 'puppeteer.chromiumDownloadConfirmed';
            const confirmed = context.globalState.get<boolean>(storageKey);
            
            if (!confirmed) {
                const result = await vscode.window.showInformationMessage(
                    "Chromium browser (~150MB) needs to be downloaded for PDF/PNG/JPG export. Download now?",
                    "Yes", "No"
                );

                if (result !== "Yes") {
                    throw new Error("Download cancelled. Configure 'markdownExtended.puppeteerExecutable' to use a custom browser.");
                }
                
                // Remember user's choice
                await context.globalState.update(storageKey, true);
            }

            // Download the browser
            progress.report({ message: "Downloading Chromium browser..." });
            
            await this.downloadBrowser(progress, cacheDir, buildId, platform);
            
            // Verify installation
            if (!fs.existsSync(executablePath)) {
                throw new Error(`Browser download completed but executable not found at: ${executablePath}`);
            }
            
            return executablePath;

        } catch (error) {
            throw new Error(`Failed to ensure browser: ${error.message}\nCache directory: ${cacheDir}`);
        }
    }

    /**
     * Download browser with progress reporting
     */
    private async downloadBrowser(progress: Progress, cacheDir: string, buildId: string, platform: BrowserPlatform): Promise<void> {
        progress.report({ message: "Downloading Chromium..." });
        
        let lastProgress = 0;
        
        try {
            await install({
                browser: Browser.CHROME,
                buildId,
                cacheDir,
                platform,
                downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
                    const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                    if (percent !== lastProgress && percent % 5 === 0) { // Update every 5%
                        progress.report({
                            message: `Downloading Chromium (${percent}%)`,
                            increment: percent - lastProgress
                        });
                        lastProgress = percent;
                    }
                }
            });
            
            progress.report({ message: "Download complete!" });
        } catch (error) {
            throw new Error(`Failed to download browser: ${error.message}`);
        }
    }

    /**
     * Detect the current browser platform
     */
    private detectBrowserPlatform(): BrowserPlatform {
        const platform = process.platform;
        const arch = process.arch;

        switch (platform) {
            case 'win32':
                return arch === 'x64' ? BrowserPlatform.WIN64 : BrowserPlatform.WIN32;
            case 'darwin':
                return arch === 'arm64' ? BrowserPlatform.MAC_ARM : BrowserPlatform.MAC;
            case 'linux':
                return BrowserPlatform.LINUX;
            default:
                throw new Error(`Unsupported platform: ${platform}`);
        }
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
export const puppeteerExporter = new PuppeteerExporter();

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