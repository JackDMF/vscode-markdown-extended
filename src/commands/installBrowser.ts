import { Command } from './command';
import * as vscode from 'vscode';
import { BrowserManager } from '../services/browser/browserManager';
import { ExtensionContext } from '../services/common/extensionContext';

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

                    const browserManager = BrowserManager.getInstance(ExtensionContext.current.vsContext);
                    
                    // Check if already installed
                    if (browserManager.isBrowserInstalled()) {
                        const reinstall = await vscode.window.showInformationMessage(
                            'Chromium is already installed. Reinstall?',
                            'Yes', 'No'
                        );
                        if (reinstall !== 'Yes') {
                            vscode.window.showInformationMessage('Installation cancelled.');
                            return;
                        }
                    }

                    // Download browser (force reinstall if requested)
                    await browserManager.ensureBrowser(progress, { force: true });

                    progress.report({ message: 'Installation complete!' });
                    
                    vscode.window.showInformationMessage(
                        `Chromium successfully installed!`,
                        'OK'
                    );

                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(
                        `Failed to install Chromium: ${errorMessage}`
                    );
                    throw error;
                }
            }
        );
    }

    constructor() {
        super('markdownExtended.installBrowser');
    }
}
