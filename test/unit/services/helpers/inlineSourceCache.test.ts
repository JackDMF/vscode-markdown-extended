import * as assert from 'assert';
import * as vscode from 'vscode';
import { inlineSourceOf } from '../../../../src/services/helpers/inlineSourceCache';
import { hostEngine } from '../../editor/helpers';

suite('Inline source cache: read once per version and engine', () => {
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    test('a document is read again when it changes or the engine does, not otherwise', async () => {
        const md = hostEngine();
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: '**a** b' });
        const first = inlineSourceOf(document, md);
        assert.strictEqual(inlineSourceOf(document, md), first);
        assert.deepStrictEqual(first.spansOn(0, '**').map(s => [s.start, s.end]), [[0, 5]]);

        const other = hostEngine();
        const rebuilt = inlineSourceOf(document, other);
        assert.notStrictEqual(rebuilt, first);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), 'x ');
        assert.ok(await vscode.workspace.applyEdit(edit));
        const changed = inlineSourceOf(document, other);
        assert.notStrictEqual(changed, rebuilt);
        assert.deepStrictEqual(changed.spansOn(0, '**').map(s => [s.start, s.end]), [[2, 7]]);
    });
});
