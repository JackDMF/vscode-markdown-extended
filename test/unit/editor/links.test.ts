import * as assert from 'assert';
import * as vscode from 'vscode';
import { resolveLinkTarget } from '../../../src/editor/host/links';

/** Where a Ctrl/Cmd+clicked link goes: resolved against the document, as the preview resolves it. */
suite('Editor links: resolving a followed href', () => {
    const doc = vscode.Uri.file('/corpus/requirements/functional/FR-CON.md');
    const folder = vscode.Uri.file('/corpus');

    const opened = (href: string, ws?: vscode.Uri) => {
        const target = resolveLinkTarget(href, doc, ws);
        assert.strictEqual(target.kind, 'open', `${href}: ${JSON.stringify(target)}`);
        return (target as { uri: vscode.Uri }).uri;
    };

    test('a relative path is the document\'s folder\'s, its fragment kept', () => {
        const uri = opened('FR-OTHER.md#fr-other-001');
        assert.strictEqual(uri.path, '/corpus/requirements/functional/FR-OTHER.md');
        assert.strictEqual(uri.fragment, 'fr-other-001');
        assert.strictEqual(uri.scheme, 'file');
    });

    test('.. climbs out of the folder, and a query is dropped', () => {
        assert.strictEqual(opened('../../workshops/2026-09-21.md?x=1').path, '/corpus/workshops/2026-09-21.md');
    });

    test('a leading / is the workspace folder\'s, or the root\'s outside one', () => {
        assert.strictEqual(opened('/README.md', folder).path, '/corpus/README.md');
        assert.strictEqual(opened('/README.md').path, '/README.md');
    });

    test('percent escapes markdown-it added are decoded to the file\'s own name', () => {
        assert.strictEqual(opened('%C3%9Cbersicht.md#teil').path, '/corpus/requirements/functional/Übersicht.md');
    });

    test('a fragment alone is the document itself', () => {
        const uri = opened('#fr-con-001--21b3cb02');
        assert.strictEqual(uri.path, doc.path);
        assert.strictEqual(uri.fragment, 'fr-con-001--21b3cb02');
    });

    test('file: uris and drive paths are opened', () => {
        assert.strictEqual(opened('file:///c%3A/notes/a.md').scheme, 'file');
        assert.strictEqual(opened('C:/notes/a.md').fsPath.toLowerCase().replace(/\\/g, '/'), 'c:/notes/a.md');
    });

    test('web and mail addresses go to the system', () => {
        for (const href of ['https://example.com/a?b=1#c', 'http://example.com', 'mailto:someone@example.com']) {
            const target = resolveLinkTarget(href, doc);
            assert.strictEqual(target.kind, 'external', href);
            assert.strictEqual((target as { uri: vscode.Uri }).uri.toString(true), vscode.Uri.parse(href, true).toString(true));
        }
    });

    test('an href the strict uri parse rejects throws here, which is why the session resolves inside its try', () => {
        assert.throws(() => resolveLinkTarget('http:////x', doc));
    });

    test('a scheme that runs something is refused, and so is an empty href', () => {
        for (const href of ['command:workbench.action.quit', 'vscode:extension/x.y', 'javascript:alert(1)', '  ']) {
            assert.strictEqual(resolveLinkTarget(href, doc).kind, 'refused', href);
        }
    });
});
