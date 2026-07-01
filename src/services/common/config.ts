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
     * Read a setting that was renamed in v3.0, preferring the new (grouped) key
     * but falling back to the deprecated flat key when only the old one is set.
     * This keeps existing user settings working across the rename.
     *
     * @param newKey grouped key, e.g. `pdf.format`
     * @param oldKey legacy flat key, e.g. `pdfFormat`
     * @param uri optional resource scope
     */
    private migrated<T>(newKey: string, oldKey: string, uri?: vscode.Uri): T {
        const conf = uri
            ? vscode.workspace.getConfiguration('markdownExtended', uri)
            : vscode.workspace.getConfiguration('markdownExtended');
        const explicit = (info?: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }): T | undefined =>
            info ? (info.workspaceFolderValue ?? info.workspaceValue ?? info.globalValue) : undefined;
        const newInfo = conf.inspect<T>(newKey);
        const newVal = explicit(newInfo);
        if (newVal !== undefined) { return newVal; }
        const oldVal = explicit(conf.inspect<T>(oldKey));
        if (oldVal !== undefined) { return oldVal; }
        return (newInfo && newInfo.defaultValue !== undefined)
            ? newInfo.defaultValue as T
            : conf.get<T>(newKey);
    }

    /**
     * Get list of disabled markdown-it plugins.
     * Plugin names should be provided without the 'markdown-it-' prefix.
     * 
     * @returns Array of disabled plugin names (e.g., ['toc', 'container'])
     */
    get disabledPlugins(): string[] {
        const conf = (this.migrated<string>('plugins.disabled', 'disabledPlugins') || '').trim();
        if (!conf) {return [];}
        return conf.toLowerCase().split(',').map(p => p.trim());
    }
    
    /**
     * Get heading levels to include in table of contents.
     * 
     * @returns Array of heading levels (1-6), defaults to [1, 2, 3]
     */
    get tocLevels(): number[] {
        let conf = this.migrated<number[]>('toc.levels', 'tocLevels');
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
        return this.migrated<string>('export.outDirName', 'exportOutDirName');
    }

    /**
     * Whether to apply the built-in accessible base stylesheet to exports.
     * Layered beneath the user's own `markdown.styles`, so user CSS wins.
     *
     * @returns true unless explicitly disabled
     */
    get exportDefaultStyles(): boolean {
        const conf = vscode.workspace.getConfiguration('markdownExtended');
        return conf.get<boolean>('export.defaultStyles') !== false;
    }

    /**
     * Get the color theme to apply to exported HTML/PDF/PNG output.
     *
     * Drives the preview body class (`vscode-light` / `vscode-dark`) so that
     * theme-aware stylesheets render in the chosen mode. `auto` (the default)
     * follows the active VS Code color theme at export time.
     *
     * @returns `'light'` or `'dark'` (the resolved value, never `'auto'`)
     */
    get exportTheme(): 'light' | 'dark' {
        const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
        const isDark = kind === vscode.ColorThemeKind.Dark
            || kind === vscode.ColorThemeKind.HighContrast;
        return resolveExportTheme(this.migrated<string>('export.theme', 'exportTheme'), isDark);
    }
    
    /**
     * Get path to custom Puppeteer/Chrome executable.
     * Validates that the path exists before returning.
     *
     * @returns Path to executable, or empty string if not configured or doesn't exist
     */
    get puppeteerExecutable(): string {
        const exe = this.migrated<string>('export.puppeteerExecutable', 'puppeteerExecutable');
        return exe && fs.existsSync(exe) ? exe : "";
    }
    
    /**
     * Get PDF page format (e.g., 'A4', 'Letter').
     * @returns PDF format string
     */
    get pdfFormat(): string {
        return this.migrated<string>('pdf.format', 'pdfFormat');
    }
    
    /**
     * Get custom PDF page width (with units, e.g., '210mm').
     * Only used when pdfFormat is not set.
     * @returns PDF width string
     */
    get pdfWidth(): string {
        return this.migrated<string>('pdf.width', 'pdfWidth');
    }
    
    /**
     * Get custom PDF page height (with units, e.g., '297mm').
     * Only used when pdfFormat is not set.
     * @returns PDF height string
     */
    get pdfHeight(): string {
        return this.migrated<string>('pdf.height', 'pdfHeight');
    }
    
    /**
     * Get PDF landscape orientation setting.
     * @returns true for landscape, false for portrait
     */
    get pdfLandscape(): boolean {
        return this.migrated<boolean>('pdf.landscape', 'pdfLandscape');
    }
    get pdfMarginTop(): string {
        return this.migrated<string>('pdf.margin.top', 'pdfMarginTop');
    }
    get pdfMarginRight(): string {
        return this.migrated<string>('pdf.margin.right', 'pdfMarginRight');
    }
    get pdfMarginBottom(): string {
        return this.migrated<string>('pdf.margin.bottom', 'pdfMarginBottom');
    }
    get pdfMarginLeft(): string {
        return this.migrated<string>('pdf.margin.left', 'pdfMarginLeft');
    }
    get pdfDisplayHeaderFooter(): boolean {
        return this.migrated<boolean>('pdf.displayHeaderFooter', 'pdfDisplayHeaderFooter');
    }
    get pdfPageRanges(): string {
        return this.migrated<string>('pdf.pageRanges', 'pdfPageRanges');
    }
    get pdfHeaderTemplate(): string {
        return this.migrated<string>('pdf.headerTemplate', 'pdfHeaderTemplate');
    }
    get pdfFooterTemplate(): string {
        return this.migrated<string>('pdf.footerTemplate', 'pdfFooterTemplate');
    }
    get imageQuality(): number {
        return this.migrated<number>('image.quality', 'imageQuality') || 100;
    }
    get imageOmitBackground(): boolean {
        return this.migrated<boolean>('image.omitBackground', 'imageOmitBackground');
    }

    get puppeteerDefaultSetting(): any {
        return {
            pdf: {
                printBackground: true,
                preferCSSPageSize: true,
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
 * Resolve the configured export theme to a concrete `'light'` or `'dark'` value.
 *
 * @param value Raw `markdownExtended.exportTheme` setting (`light` | `dark` | `auto`).
 * @param isDark Whether the active VS Code color theme is dark (used for `auto`).
 * @returns `'dark'` for `dark`, the active theme for `auto`, otherwise `'light'`.
 */
export function resolveExportTheme(value: string | undefined, isDark: boolean): 'light' | 'dark' {
    switch ((value || 'light').toLowerCase()) {
        case 'dark':
            return 'dark';
        case 'auto':
            return isDark ? 'dark' : 'light';
        default:
            return 'light';
    }
}

/**
 * Singleton instance of Config for backward compatibility.
 * @deprecated Use Config.instance instead
 */
export const config = Config.instance;