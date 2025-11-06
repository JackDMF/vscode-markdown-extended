import { Command } from './command';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { install, Browser, BrowserPlatform, resolveBuildId, computeExecutablePath } from '@puppeteer/browsers';
import { context } from '../extension';

export class CommandInstallBrowser extends Command {
    async execute() {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Installing Chromium Browser',
                cancellable: false
            },
            async (progress) => {
                try {
                    progress.report({ message: 'Preparing...' });

                    const cacheDir = path.join(context.globalStorageUri.fsPath, 'browsers');
                    
                    // Ensure cache directory exists
                    if (!fs.existsSync(cacheDir)) {
                        fs.mkdirSync(cacheDir, { recursive: true });
                    }

                    // Detect platform
                    const platform = this.detectBrowserPlatform();
                    
                    // Get the latest stable Chrome build ID
                    progress.report({ message: 'Resolving latest Chrome version...' });
                    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');
                    
                    // Compute where the browser will be installed
                    const executablePath = computeExecutablePath({
                        browser: Browser.CHROME,
                        buildId,
                        cacheDir
                    });

                    // Check if already installed
                    if (fs.existsSync(executablePath)) {
                        const reinstall = await vscode.window.showInformationMessage(
                            'Chromium is already installed. Reinstall?',
                            'Yes', 'No'
                        );
                        if (reinstall !== 'Yes') {
                            vscode.window.showInformationMessage('Installation cancelled.');
                            return;
                        }
                    }

                    // Download browser
                    progress.report({ message: 'Downloading Chromium (~150MB)...' });
                    
                    let lastProgress = 0;
                    await install({
                        browser: Browser.CHROME,
                        buildId,
                        cacheDir,
                        platform,
                        downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
                            const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                            if (percent !== lastProgress && percent % 5 === 0) {
                                progress.report({
                                    message: `Downloading Chromium (${percent}%)`,
                                    increment: percent - lastProgress
                                });
                                lastProgress = percent;
                            }
                        }
                    });

                    progress.report({ message: 'Installation complete!' });
                    
                    vscode.window.showInformationMessage(
                        `Chromium successfully installed to: ${cacheDir}`,
                        'OK'
                    );

                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to install Chromium: ${error.message}`
                    );
                    throw error;
                }
            }
        );
    }

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

    constructor() {
        super('markdownExtended.installBrowser');
    }
}
