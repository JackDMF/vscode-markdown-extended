import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Profiles a killed run left behind (its `finally` never ran). Best effort: only those older than a day, so a
 * parallel run's profile is never touched; anything that cannot be removed stays for the next run.
 */
function removeStaleProfiles(): void {
    try {
        const tmp = os.tmpdir();
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const name of fs.readdirSync(tmp)) {
            if (!name.startsWith('mep-test-')) {
                continue;
            }
            try {
                const dir = path.join(tmp, name);
                if (fs.statSync(dir).mtimeMs < cutoff) {
                    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
                }
            } catch {
                // in use or already gone: leave it
            }
        }
    } catch {
        // an unreadable temp folder is no reason to fail a run
    }
}

async function main() {
    removeStaleProfiles();
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
            // Never fails a run: on Windows the Code.exe helpers can still hold files (EBUSY/EPERM) a moment after exit.
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            } catch (e) {
                console.warn(`Could not remove the test profile ${userDataDir}:`, e);
            }
        }
    } catch (err) {
        console.error('Failed to run tests:', err);
        process.exit(1);
    }
}

main();
