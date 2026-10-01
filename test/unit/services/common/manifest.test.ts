import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../../../..');

/**
 * The settings a cloned repository's `.vscode/settings.json` must not set
 * for a workspace its owner has not trusted: which files an export copies in,
 * and which program it runs.
 */
const RESTRICTED = [
    'markdownExtended.export.embedFiles',
    'markdownExtended.export.puppeteerExecutable',
    'markdownExtended.puppeteerExecutable',
];

suite('Manifest: settings a workspace must not set untrusted', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const properties = manifest.contributes.configuration.properties;

    test('each is declared restricted', () => {
        for (const key of RESTRICTED) {
            assert.ok(properties[key], `${key} is declared`);
            assert.strictEqual(properties[key].restricted, true, `${key} is restricted`);
        }
    });

    test('an extension that runs untrusted lists each in restrictedConfigurations', () => {
        // Today the extension declares no untrustedWorkspaces capability, so
        // VS Code does not run it in Restricted Mode at all. The day it does,
        // VS Code reads `restricted` from restrictedConfigurations for every
        // setting that does not declare it: keep both, so neither can lapse.
        const untrusted = manifest.capabilities?.untrustedWorkspaces;
        if (untrusted?.supported === true || untrusted?.supported === 'limited') {
            const listed: string[] = untrusted.restrictedConfigurations ?? [];
            for (const key of RESTRICTED) {
                assert.ok(listed.includes(key), `${key} is in restrictedConfigurations`);
            }
        }
    });
});
