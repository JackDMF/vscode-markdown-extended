import * as puppeteer from 'puppeteer-core';
import * as vscode from 'vscode';
import * as path from 'path';
import { MarkdownDocument } from '../common/markdownDocument';
import { mkdirsAsync, mergeSettings } from '../common/tools';
import { renderPage } from './shared';
import { MermaidRenderer } from './mermaidRenderer';
import { MarkdownExporter, ExportFormat, Progress, ExportItem } from './interfaces';
import { Config } from '../common/config';
import { BrowserManager } from '../browser/browserManager';
import { ExtensionContext } from '../common/extensionContext';
import { ErrorHandler, ErrorSeverity } from '../common/errorHandler';

/**
 * The locale the print date is formatted in. The `markdownExtended.pdf.locale` setting wins; else
 * VS Code's display language. Empty and the pseudo-locale `qps-ploc` (VS Code's localisation test
 * language) name no real language and give `undefined`, for which `Intl` uses the runtime's default.
 */
export function exportLocale(setting: string | undefined, envLanguage: string | undefined): string | undefined {
    const pick = (v: string | undefined) => (v ?? '').trim();
    const locale = pick(setting) || pick(envLanguage);
    return locale === '' || locale.toLowerCase() === 'qps-ploc' ? undefined : locale;
}

/**
 * The print time as Chrome itself writes the `date` class (`30.09.26, 13:20`, `9/30/26, 1:20 PM`),
 * but in a locale we choose: Chrome takes its own from the OS and the launch environment, which
 * differ per platform. An invalid tag (a `RangeError`) falls back to the runtime default and is
 * reported through `warn`.
 */
export function formatPrintDate(locale: string | undefined, now: Date, warn?: (message: string) => void): string {
    const format = (l: string | undefined) => new Intl.DateTimeFormat(l, { dateStyle: 'short', timeStyle: 'short' }).format(now);
    try {
        return format(locale);
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
        warn?.(`[WARNING] markdownExtended.pdf.locale "${locale}" is not a valid BCP 47 language tag; the print date uses the default locale.`);
        return format(undefined);
    }
}

/**
 * Replaces the content of every `<span class="date">` (any quoting, any attributes, `date` among
 * other classes) in a header or footer template with the preformatted print time. The span and its
 * attributes stay, so a user's CSS still finds it.
 */
export function fillPrintDate(template: string, formatted: string): string {
    const text = formatted.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return template.replace(/<span\b([^>]*)>[\s\S]*?<\/span>/gi, (whole, attrs: string) => {
        const m = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
        const classes = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').split(/\s+/);
        return classes.includes('date') ? `<span${attrs}>${text}</span>` : whole;
    });
}

/** Fills the `date` spans of the header and footer templates in PDF options, in place. */
export function applyPrintDate(pdfOptions: { headerTemplate?: unknown; footerTemplate?: unknown }, locale: string | undefined, now: Date, warn?: (message: string) => void): void {
    const formatted = formatPrintDate(locale, now, warn);
    for (const key of ['headerTemplate', 'footerTemplate'] as const) {
        const template = pdfOptions[key];
        if (typeof template === 'string') {
            pdfOptions[key] = fillPrintDate(template, formatted);
        }
    }
}

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

    // eslint-disable-next-line @typescript-eslint/naming-convention
    async Export(items: ExportItem[], progress: Progress) {
        const count = items.length;
        let browser: puppeteer.Browser | undefined;
        let page: puppeteer.Page | undefined;
        
        try {
            // Ensure browser is available using centralized BrowserManager.
            // First-time PDF/PNG/JPG export needs a one-time Chromium download, so
            // ask for consent instead of silently pulling ~170 MB.
            const browserManager = BrowserManager.instance;
            if (!browserManager.isBrowserInstalled()) {
                const choice = await vscode.window.showInformationMessage(
                    'Exporting to PDF, PNG, or JPG needs a one-time Chromium download (~170 MB) to render the document. ' +
                    'It is stored with the extension and reused for future exports.',
                    { modal: true },
                    'Download'
                );
                if (choice !== 'Download') {
                    throw new vscode.CancellationError();
                }
            }
            const executablePath = await browserManager.ensureBrowser(progress);
            
            progress.report({ message: "Initializing browser..." });
            browser = await puppeteer.launch({
                executablePath: executablePath || undefined,
                headless: true, // Use headless mode
                args: ['--no-sandbox', '--disable-setuid-sandbox'] // For compatibility
            });
            page = await browser.newPage();

            // Process all export items sequentially
            for (let i = 0; i < items.length; i++) {
                const c = items[i];
                if (progress) {
                    progress.report({
                        message: `${path.basename(c.fileName)} (${i + 1}/${count})`,
                        increment: ~~(1 / count * 100)
                    });
                }
                if (!page) {
                    throw new Error('Browser page is not initialized');
                }
                await this.exportFile(c, page);
            }
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
                const output = ExtensionContext.current.outputPanel;
                output.appendLine(`[WARNING] Error closing page: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
            }
            
            try {
                if (browser) {
                    await browser.close();
                }
            } catch (closeError) {
                // Log but don't throw - cleanup errors shouldn't mask original error
                const output = ExtensionContext.current.outputPanel;
                output.appendLine(`[WARNING] Error closing browser: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
            }
        }
    }
    private async exportFile(item: ExportItem, page: puppeteer.Page) {
        const document = new MarkdownDocument(await vscode.workspace.openTextDocument(item.uri));
        const inject = getInjectStyle(item.format);
        // Render mermaid diagrams (if any) to inline SVG before capture.
        const html = await MermaidRenderer.instance.process(renderPage(document, inject));
        let ptConf: any = {};
        // Folder-level settings only arrive when the read names the document
        const scoped = Config.instance.scoped(item.uri);
        await mkdirsAsync(path.dirname(item.fileName));

        // `setContent` no longer accepts the network-idle lifecycle events. `load`
        // already covers images and stylesheets, and the page arrives with mermaid
        // pre-rendered and images embedded, so there is normally no traffic left.
        // Give third-party preview scripts a brief, bounded window anyway.
        await page.setContent(html, { waitUntil: 'load' });
        await page.waitForNetworkIdle({ idleTime: 100, timeout: 5000 }).catch(() => {
            // Best effort: a slow remote resource must not fail the export.
        });
        switch (item.format) {
            case ExportFormat.PDF:
                ptConf = mergeSettings(
                    Config.instance.puppeteerDefaultSetting.pdf,
                    scoped.puppeteerUserSetting.pdf,
                    document.meta.puppeteerPDF
                );
                if (typeof ptConf.preferCSSPageSize === 'undefined') {
                    ptConf.preferCSSPageSize = true;
                }
                applyPrintDate(
                    ptConf,
                    exportLocale(scoped.pdfLocale, vscode.env.language),
                    new Date(),
                    message => ExtensionContext.current.outputPanel.appendLine(message)
                );
                ptConf = Object.assign(ptConf, { path: item.fileName });
                await page.pdf(ptConf);
                break;
            case ExportFormat.JPG:
            case ExportFormat.PNG:
                ptConf = mergeSettings(
                    Config.instance.puppeteerDefaultSetting.image,
                    scoped.puppeteerUserSetting.image,
                    document.meta.puppeteerImage
                );
                ptConf = Object.assign(ptConf, { path: item.fileName, type: item.format === ExportFormat.JPG ? "jpeg" : "png" });
                if (item.format === ExportFormat.PNG) {ptConf.quality = undefined;}
                await page.screenshot(ptConf);
                break;
            default:
                return Promise.reject("PuppeteerExporter does not support HTML export.");
        }
    }
    // eslint-disable-next-line @typescript-eslint/naming-convention
    FormatAvailable(format: ExportFormat) {
        return [
            ExportFormat.PDF,
            ExportFormat.JPG,
            ExportFormat.PNG
        ].indexOf(format) > -1;
    }
}

function getInjectStyle(formate: ExportFormat): string {
    switch (formate) {
        case ExportFormat.JPG:
        case ExportFormat.PNG:
            return `body, .vscode-body {
                width: 1000px !important;
            }`
        default:
            return "";
    }
}
