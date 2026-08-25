import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { calculateExportPath } from '../../../../src/services/common/tools';
import { Config } from '../../../../src/services/common/config';

/**
 * calculateExportPath keeps the document's position inside the workspace and
 * mirrors it under the export directory. The directory may be a plain name
 * ("out") or an absolute path — the latter is how one exports into a synced
 * folder while the workspace stays in a repository.
 */
suite('calculateExportPath', () => {
    let sandbox: sinon.SinonSandbox;
    const wkdir = path.join(path.sep, 'repo', 'archive');
    const datei = vscode.Uri.file(path.join(wkdir, 'Aufgaben', '2026', 'Vorsitz.md'));

    setup(() => {
        sandbox = sinon.createSandbox();
        sandbox.stub(vscode.workspace, 'getWorkspaceFolder').returns({
            uri: vscode.Uri.file(wkdir), name: 'archive', index: 0
        } as vscode.WorkspaceFolder);
    });

    teardown(() => sandbox.restore());

    /** Stub both accessors; `exportOutDirNameFor` must be the one consulted. */
    function withOutDir(wert: string) {
        sandbox.stub(Config, 'instance').value({
            exportOutDirName: 'WRONG-workspace-level',
            exportOutDirNameFor: (_uri: vscode.Uri) => wert,
        });
    }

    test('a plain name lands under the workspace root', () => {
        withOutDir('out');
        assert.strictEqual(
            calculateExportPath(datei, 'pdf'),
            path.join(wkdir, 'out', 'Aufgaben', '2026', 'Vorsitz.pdf'));
    });

    test('an absolute path wins over the workspace root', () => {
        const ziel = path.join(path.sep, 'Users', 'x', 'iCloud', 'Output');
        withOutDir(ziel);
        assert.strictEqual(
            calculateExportPath(datei, 'pdf'),
            path.join(ziel, 'Aufgaben', '2026', 'Vorsitz.pdf'));
    });

    test('a document outside the workspace exports beside itself', () => {
        withOutDir('out');
        (vscode.workspace.getWorkspaceFolder as sinon.SinonStub).returns(undefined);
        const fremd = vscode.Uri.file(path.join(path.sep, 'tmp', 'notiz.md'));
        assert.strictEqual(
            calculateExportPath(fremd, 'html'),
            path.join(path.sep, 'tmp', 'notiz.html'));
    });
});
