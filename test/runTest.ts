import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
    try {
        // VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE=1. Inherited by
        // the downloaded Code.exe it runs as plain Node, which rejects every launch
        // flag ("bad option: --disable-extensions") and the suite dies with code 9.
        delete process.env.ELECTRON_RUN_AS_NODE;

        // The folder containing the Extension Manifest package.json
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');

        // The path to the extension test runner script
        const extensionTestsPath = path.resolve(__dirname, './unit/index');

        // Download VS Code, unzip it and run the integration test
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: ['--disable-extensions'] // Disable other extensions during test
        });
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
