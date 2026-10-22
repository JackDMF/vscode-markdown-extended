import * as fs from 'fs';
import * as os from 'os';
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

        // A profile of its own per run: worktrees share `.vscode-test` (and with it the default
        // `user-data`), and a second run on the same profile dies with "only supported if no
        // other instance of Code is running".
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-test-'));
        try {
            // Download VS Code, unzip it and run the integration test
            await runTests({
                extensionDevelopmentPath,
                extensionTestsPath,
                launchArgs: [
                    '--disable-extensions', // Disable other extensions during test
                    `--user-data-dir=${userDataDir}`
                ]
            });
        } finally {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
