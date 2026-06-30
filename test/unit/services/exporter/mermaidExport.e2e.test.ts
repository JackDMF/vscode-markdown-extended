import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { MermaidRenderer } from '../../../../src/services/exporter/mermaidRenderer';
import { BrowserManager } from '../../../../src/services/browser/browserManager';
import { ExtensionContext } from '../../../../src/services/common/extensionContext';
import { Config } from '../../../../src/services/common/config';

const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

/**
 * End-to-end test for the mermaid export pipeline.
 *
 * Unlike the unit tests in `mermaidRenderer.test.ts` (which inject a fake page
 * renderer), this test exercises the REAL `MermaidRenderer.process` path: it
 * launches headless Chromium, evaluates the bundled `dist/mermaid-browser.js`
 * harness and renders the diagram to an inline `<svg>`.
 *
 * It is CI-safe: the test skips unless a browser is available. A browser is
 * considered available when either
 *   - Chromium is already installed in the resolved global storage, or
 *   - the `MTE_E2E_CHROME` env var points at an existing Chrome executable
 *     (e.g. the one your normal VS Code profile already downloaded).
 * The test never triggers a Chromium download.
 */
suite('Mermaid Export (e2e)', () => {
    let sandbox: sinon.SinonSandbox;
    let extensionPath: string | undefined;

    suiteSetup(() => {
        extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;

        // Establish a clean, known singleton state with the REAL extension path
        // so the bundled `dist/mermaid-browser.js` harness resolves. Other test
        // suites may have left these singletons in a mock/reset state.
        ExtensionContext._reset();
        BrowserManager._reset();

        const ctx = {
            extensionPath,
            globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'mte-e2e-global')),
            subscriptions: [] as { dispose(): unknown }[],
        } as unknown as vscode.ExtensionContext;

        ExtensionContext.initialize(ctx);
        BrowserManager.initialize(ctx);
    });

    suiteTeardown(() => {
        ExtensionContext._reset();
        BrowserManager._reset();
    });

    setup(() => {
        sandbox = sinon.createSandbox();
    });

    teardown(() => {
        sandbox.restore();
    });

    test('renders a mermaid diagram to inline SVG without leaking the library', async function () {
        this.timeout(180000);

        const harness = extensionPath && path.join(extensionPath, 'dist', 'mermaid-browser.js');
        if (!harness || !fs.existsSync(harness)) {
            // Extension not built (no bundled harness) — nothing to exercise.
            this.skip();
        }

        const envChrome = process.env.MTE_E2E_CHROME;
        if (envChrome && fs.existsSync(envChrome)) {
            // Route the bundled browser launch at the provided executable so the
            // real pipeline runs without downloading anything.
            sandbox.stub(Config.instance, 'puppeteerExecutable').get(() => envChrome);
        } else if (!BrowserManager.instance.isBrowserInstalled()) {
            this.skip();
        }

        const html = [
            '<!DOCTYPE html>',
            '<html><head><meta charset="utf-8"></head><body>',
            '<pre class="mermaid">graph TD;A--&gt;B;B--&gt;C;</pre>',
            '</body></html>',
        ].join('\n');

        const result = await MermaidRenderer.instance.process(html);

        assert.ok(/<svg[\s>]/i.test(result), 'output should contain an inline <svg> element');
        assert.ok(
            !/<pre[^>]*\bclass\s*=\s*"[^"]*\bmermaid\b/i.test(result),
            'the mermaid <pre> placeholder should have been replaced',
        );
        assert.ok(
            !result.includes('__mteMermaid'),
            'the mermaid library harness must not be serialized into the exported HTML',
        );
    });
});
