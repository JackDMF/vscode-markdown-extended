import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../../src/plugin/plugins';
import { renderHTML } from '../../../../src/services/exporter/shared';
import { ExtensionContext } from '../../../../src/services/common/extensionContext';
import { MarkdownDocument } from '../../../../src/services/common/markdownDocument';
import { headingIds, secondAnchors, withVscodeHeadingRule } from '../../vscodeHeadings';

/**
 * The preview's engine as the export reaches it: the extension's plugins, and
 * the heading id rule VS Code's Markdown engine adds, which slugs by
 * `env.slugifier` when the render brings one and statelessly when not.
 */
function vscodeEngine(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt({ html: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return withVscodeHeadingRule(md);
}

suite('Export heading ids', () => {
    const text = '# Notes\n\n## Setup\n\ntext\n\n## Setup\n\ntext\n\n## Setup\n';

    suiteSetup(() => {
        ExtensionContext._reset();
        const ctx = {
            globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'mte-heading-ids')),
            subscriptions: [] as { dispose(): unknown }[],
        } as unknown as vscode.ExtensionContext;
        ExtensionContext.initialize(ctx).setMarkdown(vscodeEngine());
    });

    suiteTeardown(() => {
        ExtensionContext._reset();
    });

    async function exported(content: string): Promise<string> {
        const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
        return renderHTML(new MarkdownDocument(document));
    }

    test('a repeated heading gets -1, -2', async () => {
        assert.deepStrictEqual(headingIds(await exported(text)), ['notes', 'setup', 'setup-1', 'setup-2']);
    });

    test("the ids are the built-in preview's", async () => {
        const preview: string = await vscode.commands.executeCommand('markdown.api.render', text);
        assert.deepStrictEqual(headingIds(await exported(text)), headingIds(preview));
    });

    test('an explicit {#id} is the heading\'s id and its slug a second anchor, as in the preview', async () => {
        const explicit = '## FR-1: Name {#fr-1}\n\n## Setup\n\n## Setup {#intro}\n\n## Setup\n';
        const preview: string = await vscode.commands.executeCommand('markdown.api.render', explicit);
        const html = await exported(explicit);
        assert.deepStrictEqual(headingIds(html), ['fr-1', 'setup', 'intro', 'setup-2']);
        assert.deepStrictEqual(secondAnchors(html), ['fr-1-name', 'setup-1']);
        assert.deepStrictEqual([headingIds(html), secondAnchors(html)], [headingIds(preview), secondAnchors(preview)]);
    });

    test('each export starts counting again', async () => {
        await exported(text);
        assert.deepStrictEqual(headingIds(await exported('## Setup\n')), ['setup']);
    });
});
