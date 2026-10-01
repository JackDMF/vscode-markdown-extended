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

/**
 * The preview's engine as the export reaches it: the extension's plugins, and
 * the heading id rule VS Code's Markdown engine adds (`_addNamedHeaders`, as
 * its bundle has it): `env.slugifier ? env.slugifier.add(title) :
 * this.slugifier.fromHeading(title)`. The fallback here is the stateless one.
 */
function vscodeEngine(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt({ html: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    const original = md.renderer.rules.heading_open;
    md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
        const title = tokens[idx + 1].children.map(t => t.content).join('');
        const fallback = title.trim().toLowerCase().replace(/\s/g, '-');
        const slugifier = (env as { slugifier?: { add(heading: string): { value: string } } }).slugifier;
        const slug = slugifier ? slugifier.add(title) : { value: fallback };
        tokens[idx].attrSet('id', slug.value);
        return original ? original(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };
    return md;
}

function headingIds(html: string): string[] {
    return [...html.matchAll(/<h\d[^>]*\bid="([^"]*)"/g)].map(([, id]) => id);
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

    test('an explicit {#id} is the heading\'s id, and the repeats around it are the preview\'s', async () => {
        const explicit = '## FR-1: Name {#fr-1}\n\n## Setup\n\n## Setup {#intro}\n\n## Setup\n';
        const preview: string = await vscode.commands.executeCommand('markdown.api.render', explicit);
        assert.deepStrictEqual(headingIds(await exported(explicit)), ['fr-1', 'setup', 'intro', 'setup-2']);
        assert.deepStrictEqual(headingIds(await exported(explicit)), headingIds(preview));
    });

    test('each export starts counting again', async () => {
        await exported(text);
        assert.deepStrictEqual(headingIds(await exported('## Setup\n')), ['setup']);
    });
});
