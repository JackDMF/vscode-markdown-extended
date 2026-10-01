import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { renderHTML } from '../../../../src/services/exporter/shared';
import { ExtensionContext } from '../../../../src/services/common/extensionContext';
import { MarkdownDocument } from '../../../../src/services/common/markdownDocument';
import { Config } from '../../../../src/services/common/config';
import { MarkdownItEnv } from '../../../../src/services/common/interfaces';

suite('Export reads markdownExtended.export.embedFiles per document', () => {
    let seen: MarkdownItEnv['htmlExporter'][];
    let sandbox: sinon.SinonSandbox;

    suiteSetup(() => {
        ExtensionContext._reset();
        const ctx = {
            globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'mte-embed-files')),
            subscriptions: [] as { dispose(): unknown }[],
        } as unknown as vscode.ExtensionContext;
        const md = new MarkdownIt();
        md.core.ruler.push('seen', state => { seen.push((state.env as MarkdownItEnv).htmlExporter); });
        ExtensionContext.initialize(ctx).setMarkdown(md);
    });

    suiteTeardown(() => {
        ExtensionContext._reset();
    });

    setup(() => {
        seen = [];
        // Materialize the singleton before stubbing, as Config.scoped's tests do.
        void Config.instance;
        sandbox = sinon.createSandbox();
    });

    teardown(() => sandbox.restore());

    test('the render carries the value read for the document being exported', async () => {
        const a = await vscode.workspace.openTextDocument({ content: '# A', language: 'markdown' });
        const b = await vscode.workspace.openTextDocument({ content: '# B', language: 'markdown' });
        const scoped = Config.instance.scoped.bind(Config.instance);
        sandbox.stub(Config.instance, 'scoped').callsFake((uri?: vscode.Uri) => ({
            ...scoped(uri),
            exportEmbedFiles: uri?.toString() === a.uri.toString() ? 'machine' : 'none',
        }));
        renderHTML(new MarkdownDocument(a));
        renderHTML(new MarkdownDocument(b));
        assert.deepStrictEqual(seen.map(e => e?.embedFiles), ['machine', 'none']);
        assert.deepStrictEqual(seen.map(e => e?.uri.toString()), [a.uri.toString(), b.uri.toString()]);
    });
});
