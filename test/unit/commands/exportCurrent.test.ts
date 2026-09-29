import * as assert from 'assert';
import * as vscode from 'vscode';
import * as exportUriModule from '../../../src/commands/exportUri';
import { CommandExportCurrent } from '../../../src/commands/exportCurrent';

/**
 * `markdownExtended.export` takes the document from its argument, then from the active tab
 * (a custom editor has no text editor), then from the editors. The command is not
 * constructed: that would register the id a second time.
 */
suite('Export current: which document', () => {
    const module = exportUriModule as { exportUri: (uri: vscode.Uri) => Promise<void> };
    const original = module.exportUri;
    let exported: vscode.Uri[];
    let command: CommandExportCurrent;

    setup(() => {
        exported = [];
        module.exportUri = async (uri: vscode.Uri) => { exported.push(uri); };
        command = Object.create(CommandExportCurrent.prototype);
    });
    teardown(async () => {
        module.exportUri = original;
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('a uri argument is exported without consulting the editors', async () => {
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# open' });
        await vscode.window.showTextDocument(doc);
        const named = vscode.Uri.file('/somewhere/else.md');
        await command.execute(named);
        assert.deepStrictEqual(exported.map(u => u.toString()), [named.toString()]);
    });

    test('with no argument the active tab is exported', async () => {
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# tab' });
        await vscode.window.showTextDocument(doc);
        await command.execute();
        assert.deepStrictEqual(exported.map(u => u.toString()), [doc.uri.toString()]);
    });

    test('a custom editor tab is read as a document', async () => {
        const uri = vscode.Uri.file('/custom/doc.md');
        const tab = { input: new vscode.TabInputCustom(uri, 'markdownExtended.visualEditor') };
        const groups = { activeTabGroup: { activeTab: tab } };
        const descriptor = Object.getOwnPropertyDescriptor(vscode.window, 'tabGroups');
        Object.defineProperty(vscode.window, 'tabGroups', { value: groups, configurable: true });
        try {
            await command.execute();
        } finally {
            if (descriptor) { Object.defineProperty(vscode.window, 'tabGroups', descriptor); }
            else { delete (vscode.window as any).tabGroups; }
        }
        assert.deepStrictEqual(exported.map(u => u.toString()), [uri.toString()]);
    });
});
