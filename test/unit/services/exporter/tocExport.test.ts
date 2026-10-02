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
import { headingIds, withVscodeHeadingRule } from '../../vscodeHeadings';

/**
 * The preview's engine as the export reaches it: the extension's plugins, and
 * the heading id rule VS Code's Markdown engine adds over any id already there.
 */
function vscodeEngine(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt({ html: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return withVscodeHeadingRule(md);
}

function tocHrefs(html: string): string[] {
    return [...html.matchAll(/<a href="#([^"]*)">/g)].map(([, href]) => href);
}

suite('Export: a table of contents links the exported headings', () => {
    const text = '[[TOC]]\n\n# Notes\n\n## Setup\n\ntext\n\n### Setup\n\n## Setup\n';

    suiteSetup(() => {
        ExtensionContext._reset();
        const ctx = {
            globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'mte-toc-export')),
            subscriptions: [] as { dispose(): unknown }[],
        } as unknown as vscode.ExtensionContext;
        ExtensionContext.initialize(ctx).setMarkdown(vscodeEngine());
    });

    suiteTeardown(() => {
        ExtensionContext._reset();
    });

    test('every TOC link names the id its heading has in the export', async () => {
        const document = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
        const html = renderHTML(new MarkdownDocument(document));
        const ids = headingIds(html);
        assert.deepStrictEqual(ids, ['notes', 'setup', 'setup-1', 'setup-2']);
        assert.deepStrictEqual(tocHrefs(html), ids);
    });
});
