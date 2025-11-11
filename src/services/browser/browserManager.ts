import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { install, Browser, BrowserPlatform, computeExecutablePath } from '@puppeteer/browsers';
import { Config } from '../common/config';

/**
 * Progress reporter interface for browser download operations
 */
export interface Progress {
    report(value: { message?: string; increment?: number }): void;
}

/**
 * Browser installation options
 */
export interface BrowserInstallOptions {
    /** Force reinstall even if browser exists */
    force?: boolean;
    /** Custom browser build ID (defaults to 133.0.6943.141) */
    buildId?: string;
}

/**
 * Centralized browser management service.
 * Handles browser installation, platform detection, and lifecycle management.
 * 
 * This service eliminates code duplication between PuppeteerExporter and CommandInstallBrowser,
 * and provides a clean abstraction for browser management.
 * 
 * @example
 * ```typescript
 * const browserManager = BrowserManager.getInstance(context);
 * const executablePath = await browserManager.ensureBrowser(progress);
 * ```
 */
export class BrowserManager {
    private static _instance?: BrowserManager;
    private readonly BROWSER_BUILD_ID = '133.0.6943.141';
    private _browserPath?: string;
    
    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor(private context: vscode.ExtensionContext) {}
    
    /**
     * Get the BrowserManager singleton instance
     * 
     * @param context VS Code extension context (required on first call)
     * @returns The BrowserManager instance
     */
    static getInstance(context?: vscode.ExtensionContext): BrowserManager {
        if (!BrowserManager._instance) {
            if (!context) {
                throw new Error('BrowserManager requires extension context on first initialization');
            }
            BrowserManager._instance = new BrowserManager(context);
        }
        return BrowserManager._instance;
    }
    
    /**
     * Ensure browser is available, downloading if necessary.
     * 
     * @param progress Optional progress reporter for download operations
     * @param options Installation options
     * @returns Path to browser executable, or empty string to use bundled browser
     */
    async ensureBrowser(progress?: Progress, options?: BrowserInstallOptions): Promise<string> {
        // Check for custom Puppeteer executable path in settings
        const customExecutable = Config.instance.puppeteerExecutable;
        if (customExecutable && fs.existsSync(customExecutable)) {
            return customExecutable;
        }
        
        // Check if browser is already installed (using cached path)
        if (this._browserPath && !options?.force && fs.existsSync(this._browserPath)) {
            return this._browserPath;
        }
        
        try {
            const cacheDir = this.getBrowserCacheDir();
            const buildId = options?.buildId || this.BROWSER_BUILD_ID;
            const platform = this.detectPlatform();
            
            // Ensure cache directory exists
            if (!fs.existsSync(cacheDir)) {
                await fs.promises.mkdir(cacheDir, { recursive: true });
            }
            
            // Use @puppeteer/browsers' computeExecutablePath to get the correct path
            const expectedPath = computeExecutablePath({
                cacheDir,
                browser: Browser.CHROME,
                buildId,
                platform
            });
            
            // Check if browser exists at expected path
            if (!options?.force && fs.existsSync(expectedPath)) {
                this._browserPath = expectedPath;
                return expectedPath;
            }
            
            // Download browser
            if (progress) {
                progress.report({ message: 'Downloading Chromium browser...' });
            }
            
            await this.downloadBrowser(progress, cacheDir, buildId, platform);
            
            this._browserPath = expectedPath;
            return expectedPath;
            
        } catch (error) {
            console.error('Browser installation failed:', error);
            
            // User-friendly error message with recovery options
            const action = await vscode.window.showErrorMessage(
                'Failed to download Chromium browser for export. Would you like to try again or use a custom browser?',
                'Try Again',
                'Custom Browser',
                'Cancel'
            );
            
            if (action === 'Try Again') {
                return this.ensureBrowser(progress, { ...options, force: true });
            } else if (action === 'Custom Browser') {
                const selected = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: { 'Executables': process.platform === 'win32' ? ['exe'] : ['*'] },
                    title: 'Select Chromium/Chrome executable'
                });
                
                if (selected && selected.length > 0) {
                    const customPath = selected[0].fsPath;
                    // Save to settings for future use
                    const configuration = vscode.workspace.getConfiguration('markdownExtended');
                    await configuration.update('puppeteerExecutable', customPath, vscode.ConfigurationTarget.Global);
                    return customPath;
                }
            }
            
            throw error;
        }
    }
    
    /**
     * Download browser with progress reporting
     * 
     * @param progress Progress reporter
     * @param cacheDir Cache directory path
     * @param buildId Browser build ID
     * @param platform Target platform
     */
    private async downloadBrowser(
        progress: Progress | undefined,
        cacheDir: string,
        buildId: string,
        platform: BrowserPlatform
    ): Promise<void> {
        await install({
            browser: Browser.CHROME,
            buildId: buildId,
            cacheDir: cacheDir,
            platform: platform,
            downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
                if (progress && totalBytes > 0) {
                    const percent = Math.round((downloadedBytes / totalBytes) * 100);
                    progress.report({
                        message: `Downloading Chromium: ${percent}%`,
                        increment: 0
                    });
                }
            }
        });
        
        if (progress) {
            progress.report({ message: 'Browser installation complete' });
        }
    }
    
    /**
     * Detect the current browser platform based on OS and architecture
     * 
     * @returns Browser platform identifier
     * @throws Error if platform is unsupported
     */
    detectPlatform(): BrowserPlatform {
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
     * Get the browser cache directory path.
     * Uses extension's global storage to ensure browser persists across updates.
     * 
     * @returns Absolute path to browser cache directory
     */
    getBrowserCacheDir(): string {
        return path.join(this.context.globalStorageUri.fsPath, '.chromium');
    }
    
    /**
     * Get the currently installed browser path (if any)
     * 
     * @returns Browser executable path or undefined if not installed
     */
    getBrowserPath(): string | undefined {
        const customExecutable = Config.instance.puppeteerExecutable;
        if (customExecutable && fs.existsSync(customExecutable)) {
            return customExecutable;
        }
        
        if (this._browserPath && fs.existsSync(this._browserPath)) {
            return this._browserPath;
        }
        
        // Try to compute path from cache
        try {
            const cacheDir = this.getBrowserCacheDir();
            const platform = this.detectPlatform();
            const executablePath = computeExecutablePath({
                cacheDir,
                browser: Browser.CHROME,
                buildId: this.BROWSER_BUILD_ID,
                platform
            });
            
            if (fs.existsSync(executablePath)) {
                this._browserPath = executablePath;
                return executablePath;
            }
        } catch (error) {
            // Ignore errors, just return undefined
        }
        
        return undefined;
    }
    
    /**
     * Check if browser is installed
     * 
     * @returns True if browser is available
     */
    isBrowserInstalled(): boolean {
        return !!this.getBrowserPath();
    }
    
    /**
     * Remove installed browser
     * 
     * @returns True if successfully removed
     */
    async removeBrowser(): Promise<boolean> {
        try {
            const cacheDir = this.getBrowserCacheDir();
            if (fs.existsSync(cacheDir)) {
                await fs.promises.rm(cacheDir, { recursive: true, force: true });
                this._browserPath = undefined;
                return true;
            }
            return false;
        } catch (error) {
            console.error('Failed to remove browser:', error);
            return false;
        }
    }
    
    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        BrowserManager._instance = undefined;
    }
}
