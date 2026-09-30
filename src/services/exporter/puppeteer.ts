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
 * differ per platform. An invalid or unknown tag falls back to the runtime default and is
 * reported through `warn`.
 */
export function formatPrintDate(locale: string | undefined, now: Date, warn?: (message: string) => void): string {
    const format = (l: string | undefined) => new Intl.DateTimeFormat(l, { dateStyle: 'short', timeStyle: 'short' }).format(now);
    try {
        if (locale !== undefined && Intl.DateTimeFormat.supportedLocalesOf(locale).length === 0) {
            throw new RangeError(`unknown locale ${locale}`); // well-formed but not a language Intl knows
        }
        return format(locale);
    } catch (error) {
        if (!(error instanceof RangeError)) {
            throw error;
        }
        warn?.(`[WARNING] markdownExtended.pdf.locale "${locale}" is not a known BCP 47 language tag; the print date uses the default locale.`);
        return format(undefined);
    }
}

/** One attribute of a start tag, with the source range of its value's text. */
interface TagAttribute {
    name: string;
    value: string;
    /** Range of the whole attribute in the tag's source. */
    start: number;
    end: number;
    /** Range of the value's text (inside the quotes, if any); equal bounds when there is none. */
    valueStart: number;
    valueEnd: number;
    quoted: boolean;
}

interface StartTag {
    name: string;
    attributes: TagAttribute[];
    /** Index after the closing `>`. */
    end: number;
    /** Index of the `/` of `/>`, or of the `>`; the source before it is the tag as written. */
    closer: number;
    selfClosing: boolean;
}

/**
 * Reads the start tag at `at` (which holds `<` and a letter), or undefined when the source
 * ends before its `>`. Tolerant: a `>` inside a quoted attribute value does not end the tag.
 */
function readStartTag(src: string, at: number): StartTag | undefined {
    const nameMatch = /^<([A-Za-z][^\s/>]*)/.exec(src.slice(at, at + 64));
    if (!nameMatch) {
        return undefined;
    }
    let i = at + nameMatch[0].length;
    const attributes: TagAttribute[] = [];
    for (;;) {
        while (i < src.length && /\s/.test(src[i])) {
            i++;
        }
        if (i >= src.length) {
            return undefined;
        }
        if (src[i] === '>' || (src[i] === '/' && src[i + 1] === '>')) {
            const selfClosing = src[i] === '/';
            return { name: nameMatch[1], attributes, end: selfClosing ? i + 2 : i + 1, closer: i, selfClosing };
        }
        if (src[i] === '/') {
            i++;
            continue;
        }
        const start = i;
        while (i < src.length && !/[\s=/>]/.test(src[i])) {
            i++;
        }
        const name = src.slice(start, i);
        if (name === '') {
            i++; // a stray '=' — skip it rather than loop
            continue;
        }
        let j = i;
        while (j < src.length && /\s/.test(src[j])) {
            j++;
        }
        let attribute: TagAttribute = { name, value: '', start, end: i, valueStart: i, valueEnd: i, quoted: false };
        if (src[j] === '=') {
            j++;
            while (j < src.length && /\s/.test(src[j])) {
                j++;
            }
            const quote = src[j] === '"' || src[j] === "'" ? src[j] : '';
            if (quote) {
                const close = src.indexOf(quote, j + 1);
                if (close < 0) {
                    return undefined;
                }
                attribute = { name, value: src.slice(j + 1, close), start, end: close + 1, valueStart: j + 1, valueEnd: close, quoted: true };
                i = close + 1;
            } else {
                let k = j;
                while (k < src.length && !/[\s>]/.test(src[k])) {
                    k++;
                }
                attribute = { name, value: src.slice(j, k), start, end: k, valueStart: j, valueEnd: k, quoted: false };
                i = k;
            }
        }
        attributes.push(attribute);
    }
}

/** The tag's class attribute, as its list of class names. */
function classList(tag: StartTag): { attribute?: TagAttribute; classes: string[] } {
    const attribute = tag.attributes.find(a => a.name.toLowerCase() === 'class');
    return { attribute, classes: attribute ? attribute.value.split(/\s+/).filter(c => c !== '') : [] };
}

/**
 * The start tag of a `date` element, opened again for the printed time: class `date` becomes
 * `print-date` (Chrome replaces the text of any element that carries `date`, which would throw
 * our text away), every other class and attribute stays, and a `/>` becomes `>`.
 */
function reopenAsPrintDate(src: string, at: number, tag: StartTag, attribute: TagAttribute, classes: string[]): string {
    const source = src.slice(at, tag.closer) + '>';
    const renamed: string[] = [];
    for (const c of classes) {
        const name = c === 'date' ? 'print-date' : c;
        if (!renamed.includes(name)) {
            renamed.push(name);
        }
    }
    const list = renamed.join(' ');
    const a = attribute.start - at;
    const b = attribute.end - at;
    const inQuotes = attribute.quoted ? source.slice(a, attribute.valueStart - at) + list + source.slice(attribute.valueEnd - at, b) : `class="${list}"`;
    return source.slice(0, a) + inQuotes + source.slice(b);
}

/** Index after the end tag matching the start tag just read, counting same-named tags nested in it. */
function findElementEnd(src: string, tag: StartTag): { innerEnd: number; end: number } | undefined {
    const name = tag.name.toLowerCase();
    let depth = 1;
    let i = tag.end;
    while (i < src.length) {
        const lt = src.indexOf('<', i);
        if (lt < 0) {
            return undefined;
        }
        const close = /^<\/([A-Za-z][^\s/>]*)\s*>/.exec(src.slice(lt, lt + 80));
        if (close) {
            if (close[1].toLowerCase() === name && --depth === 0) {
                return { innerEnd: lt, end: lt + close[0].length };
            }
            i = lt + close[0].length;
            continue;
        }
        const open = /[A-Za-z]/.test(src[lt + 1] ?? '') ? readStartTag(src, lt) : undefined;
        if (open) {
            if (open.name.toLowerCase() === name && !open.selfClosing) {
                depth++;
            }
            i = open.end;
        } else {
            i = lt + 1;
        }
    }
    return undefined;
}

/**
 * Fills the `date` elements of a header or footer template with the preformatted print time.
 *
 * Any element whose class list contains `date` counts, whatever its name; its whole content
 * (nested tags included, up to its own end tag) is replaced, and `<x class="date"/>` is an empty
 * element. The filled element carries `print-date` instead of `date`, since Chrome overwrites
 * the text of any element with class `date` when it prints; the template's own `<style>` blocks
 * get `.date` rewritten to `.print-date` to follow it. An outer element never swallows a date
 * element inside it, and a `>` inside a quoted attribute does not end a tag.
 */
export function fillPrintDate(template: string, formatted: string): string {
    const text = formatted.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let out = '';
    let i = 0;
    while (i < template.length) {
        const lt = template.indexOf('<', i);
        if (lt < 0) {
            break;
        }
        out += template.slice(i, lt);
        i = lt;
        if (template.startsWith('<!--', lt)) {
            const close = template.indexOf('-->', lt + 4);
            const end = close < 0 ? template.length : close + 3;
            out += template.slice(lt, end);
            i = end;
            continue;
        }
        const tag = /[A-Za-z]/.test(template[lt + 1] ?? '') ? readStartTag(template, lt) : undefined;
        if (!tag) {
            out += '<';
            i = lt + 1;
            continue;
        }
        const lower = tag.name.toLowerCase();
        if ((lower === 'style' || lower === 'script') && !tag.selfClosing) {
            const close = template.toLowerCase().indexOf(`</${lower}`, tag.end);
            const innerEnd = close < 0 ? template.length : close;
            const inner = template.slice(tag.end, innerEnd);
            out += template.slice(lt, tag.end) + (lower === 'style' ? inner.replace(/\.date(?![\w-])/g, '.print-date') : inner);
            i = innerEnd;
            continue;
        }
        const { attribute, classes } = classList(tag);
        if (attribute && classes.includes('date')) {
            out += reopenAsPrintDate(template, lt, tag, attribute, classes);
            const element = tag.selfClosing ? undefined : findElementEnd(template, tag);
            out += text + `</${tag.name}>`;
            i = element ? element.end : tag.end;
            continue;
        }
        out += template.slice(lt, tag.end);
        i = tag.end;
    }
    return out + template.slice(i);
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
        // One warning per export, not per file: a bad locale setting is the same for every item.
        const warned = new Set<string>();
        const warnOnce = (message: string) => {
            if (!warned.has(message)) {
                warned.add(message);
                ExtensionContext.current.outputPanel.appendLine(message);
            }
        };
        
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
                await this.exportFile(c, page, warnOnce);
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
    private async exportFile(item: ExportItem, page: puppeteer.Page, warn: (message: string) => void) {
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
                    warn
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
