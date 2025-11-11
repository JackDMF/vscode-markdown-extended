import { ConfigReader } from "./configReader";
import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Configuration reader for markdown-extended settings.
 * Implements singleton pattern for consistent configuration access.
 */
export class Config extends ConfigReader {
    private static _instance?: Config;
    
    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {
        super('markdownExtended');
    }
    
    /**
     * Get the Config singleton instance
     */
    static get instance(): Config {
        if (!Config._instance) {
            Config._instance = new Config();
        }
        return Config._instance;
    }
    
    /**
     * Set a custom instance (for testing purposes only)
     * @internal
     */
    static _setInstance(instance: Config): void {
        Config._instance = instance;
    }
    
    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        if (Config._instance) {
            Config._instance.dispose();
            Config._instance = undefined;
        }
    }

    onChange(_e?: vscode.ConfigurationChangeEvent): void {
        // Configuration change handling can be added here if needed
    }
    
    /**
     * Get list of disabled markdown-it plugins.
     * Plugin names should be provided without the 'markdown-it-' prefix.
     * 
     * @returns Array of disabled plugin names (e.g., ['toc', 'container'])
     * @example
     * ```typescript
     * // In settings.json: "markdownExtended.disabledPlugins": "toc, container"
     * const disabled = config.disabledPlugins; // ['toc', 'container']
     * ```
     */
    get disabledPlugins(): string[] {
        const conf = this.read<string>('disabledPlugins').trim();
        if (!conf) {return [];}
        return conf.toLowerCase().split(',').map(p => p.trim());
    }
    
    /**
     * Get heading levels to include in table of contents.
     * 
     * @returns Array of heading levels (1-6), defaults to [1, 2, 3]
     * @example
     * ```typescript
     * // In settings.json: "markdownExtended.tocLevels": [1, 2, 3, 4]
     * const levels = config.tocLevels; // [1, 2, 3, 4]
     * ```
     */
    get tocLevels(): number[] {
        let conf = this.read<number[]>('tocLevels');
        if (!(conf instanceof Array)) {conf = [];}
        if (conf.length) {conf = conf.filter(c => typeof c === "number");}
        if (!conf.length) {return [1, 2, 3];}
        return conf;
    }
    
    /**
     * Get output directory name for exports.
     * 
     * @returns Directory name relative to workspace root
     */
    get exportOutDirName(): string {
        return this.read<string>('exportOutDirName');
    }
    
    /**
     * Get path to custom Puppeteer/Chrome executable.
     * Validates that the path exists before returning.
     * 
     * @returns Path to executable, or empty string if not configured or doesn't exist
     * @example
     * ```typescript
     * // In settings.json: "markdownExtended.puppeteerExecutable": "/path/to/chrome"
     * const exe = config.puppeteerExecutable; // "/path/to/chrome" or ""
     * ```
     */
    get puppeteerExecutable(): string {
        const exe = this.read<string>('puppeteerExecutable');
        return fs.existsSync(exe) ? exe : "";
    }
    
    /**
     * Get PDF page format (e.g., 'A4', 'Letter').
     * @returns PDF format string
     */
    get pdfFormat(): string {
        return this.read<string>('pdfFormat');
    }
    
    /**
     * Get custom PDF page width (with units, e.g., '210mm').
     * Only used when pdfFormat is not set.
     * @returns PDF width string
     */
    get pdfWidth(): string {
        return this.read<string>('pdfWidth');
    }
    
    /**
     * Get custom PDF page height (with units, e.g., '297mm').
     * Only used when pdfFormat is not set.
     * @returns PDF height string
     */
    get pdfHeight(): string {
        return this.read<string>('pdfHeight');
    }
    
    /**
     * Get PDF landscape orientation setting.
     * @returns true for landscape, false for portrait
     */
    get pdfLandscape(): boolean {
        return this.read<boolean>('pdfLandscape');
    }
    get pdfMarginTop(): string {
        return this.read<string>('pdfMarginTop');
    }
    get pdfMarginRight(): string {
        return this.read<string>('pdfMarginRight');
    }
    get pdfMarginBottom(): string {
        return this.read<string>('pdfMarginBottom');
    }
    get pdfMarginLeft(): string {
        return this.read<string>('pdfMarginLeft');
    }
    get pdfDisplayHeaderFooter(): boolean {
        return this.read<boolean>('pdfDisplayHeaderFooter');
    }
    get pdfPageRanges(): string {
        return this.read<string>('pdfPageRanges');
    }
    get pdfHeaderTemplate(): string {
        return this.read<string>('pdfHeaderTemplate');
    }
    get pdfFooterTemplate(): string {
        return this.read<string>('pdfFooterTemplate');
    }
    get imageQuality(): number {
        return this.read<number>('imageQuality') || 100;
    }
    get imageOmitBackground(): boolean {
        return this.read<boolean>('imageOmitBackground');
    }

    get puppeteerDefaultSetting(): any {
        return {
            pdf: {
                printBackground: true,
            },
            image: {
                quality: 100,
                fullPage: true,
                omitBackground: false,
            }
        }
    }
    get puppeteerUserSetting(): any {
        return {
            pdf: {
                format: this.pdfFormat,
                width: this.pdfWidth,
                height: this.pdfHeight,
                landscape: this.pdfLandscape,
                margin: {
                    top: this.pdfMarginTop,
                    right: this.pdfMarginRight,
                    bottom: this.pdfMarginBottom,
                    left: this.pdfMarginLeft,
                },
                displayHeaderFooter: this.pdfDisplayHeaderFooter,
                pageRanges: this.pdfPageRanges,
                headerTemplate: this.pdfHeaderTemplate,
                footerTemplate: this.pdfFooterTemplate,
            },
            image: {
                quality: this.imageQuality,
                omitBackground: this.imageOmitBackground,
            }
        }
    }
}

/**
 * Singleton instance of Config for backward compatibility.
 * @deprecated Use Config.instance instead
 */
export const config = Config.instance;