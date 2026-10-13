import * as assert from 'assert';
import * as vscode from 'vscode';
import * as exportUriModule from '../../../src/commands/exportUri';
import { CommandExportCurrent } from '../../../src/commands/exportCurrent';
import * as exportersModule from '../../../src/services/exporter/exporters';
import { ExportFormat } from '../../../src/services/exporter/interfaces';
import * as sharedModule from '../../../src/services/exporter/shared';

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

/**
 * `exportUri` with a format already chosen — the Visual Editor's Export menu —
 * asks for no format; without one it asks, as the command always did. Which
 * exporter is asked either way (`pickExporter`, which asks only when two fit).
 * Both pickers answer here and the export stops at the exporter's question.
 */
suite('Export a uri: a preset format', () => {
    const pickers = exportersModule as { pickFormat: () => Promise<ExportFormat | undefined>; pickExporter: (format: ExportFormat) => Promise<unknown> };
    const shared = sharedModule as { ensureMarkdownEngine: () => Promise<void> };
    const originals = { pickFormat: pickers.pickFormat, pickExporter: pickers.pickExporter, ensure: shared.ensureMarkdownEngine };
    let asked: string[];

    setup(() => {
        asked = [];
        pickers.pickFormat = async () => {
            asked.push('format');
            return ExportFormat.HTML;
        };
        pickers.pickExporter = async (format: ExportFormat) => {
            asked.push(`exporter:${format}`);
            return undefined;
        };
        shared.ensureMarkdownEngine = async () => undefined;
    });
    teardown(() => {
        pickers.pickFormat = originals.pickFormat;
        pickers.pickExporter = originals.pickExporter;
        shared.ensureMarkdownEngine = originals.ensure;
    });

    test('a preset format is exported without asking for one', async () => {
        await exportUriModule.exportUri(vscode.Uri.file('/somewhere/doc.md'), ExportFormat.PDF);
        assert.deepStrictEqual(asked, ['exporter:pdf']);
    });

    test('without one, the format is asked first, as the command asks it', async () => {
        await exportUriModule.exportUri(vscode.Uri.file('/somewhere/doc.md'));
        assert.deepStrictEqual(asked, ['format', 'exporter:html']);
    });
});
