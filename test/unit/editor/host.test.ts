import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { EditorEngineHost, buildEditorEngine } from '../../../src/editor/host/engineHost';
import { VISUAL_EDITOR_VIEW_TYPE } from '../../../src/editor/host/provider';
import { SessionWebview, VisualEditorSession } from '../../../src/editor/host/session';
import { HostMessage, WebviewMessage } from '../../../src/editor/protocol';

const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

/** What a requirement file looks like: front matter, an anchored id heading, prose, a table. */
const SOURCE = [
    '---',
    'id: FRS-TST-001',
    'title: Smoke',
    '---',
    '',
    '## FRS-TST-001: Smoke {#frs-tst-001-1a2b3c4d}',
    '',
    'A paragraph that stays',
    'wrapped as it was written.',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
].join('\n');

function tempMarkdown(text: string): vscode.Uri {
    const file = path.join(os.tmpdir(), `mep-visual-editor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(file, text, 'utf8');
    return vscode.Uri.file(file);
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function until<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value !== undefined || Date.now() > end) {
            return value;
        }
        await delay(50);
    }
}

function customTab(uri: vscode.Uri): vscode.Tab | undefined {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputCustom && input.viewType === VISUAL_EDITOR_VIEW_TYPE
                && input.uri.toString() === uri.toString()) {
                return tab;
            }
        }
    }
    return undefined;
}

suite('Editor host: engine', () => {
    test('the host engine reads front matter as one token followed by the body', async () => {
        const logged: string[] = [];
        const md = await buildEditorEngine(EXTENSION_ID, line => logged.push(line));
        const tokens = md.parse('---\ntitle: x\n---\n\n# Body\n\nText.\n', {});
        assert.strictEqual(tokens[0].type, 'front_matter');
        assert.deepStrictEqual(tokens.slice(1).map(t => t.type).slice(0, 3), ['heading_open', 'inline', 'heading_close']);
        assert.deepStrictEqual(logged, []);
    });

    test('a bare domain is not a link, as in the preview', async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        assert.ok(!md.render('see example.com', {}).includes('<a '));
        assert.ok(md.render('see https://example.com', {}).includes('<a '));
    });
});

suite('Editor host: engine cache', () => {
    test('a failed build forgets itself, never a newer build that replaced it', async () => {
        const builds: { reject(error: Error): void }[] = [];
        const host = new EditorEngineHost(EXTENSION_ID, () => undefined, () => new Promise<MarkdownIt>((_resolve, reject) => {
            builds.push({ reject });
        }));
        try {
            const first = host.get();
            host.invalidate();
            const second = host.get();
            assert.notStrictEqual(second, first);

            builds[0].reject(new Error('the superseded build failed'));
            // The host's own handler was attached first, so it has run once this has.
            await first.catch(() => undefined);
            assert.strictEqual(host.get(), second, 'the newer build is still the one handed out');
            assert.strictEqual(builds.length, 2);

            builds[1].reject(new Error('the current build failed'));
            await second.catch(() => undefined);
            void host.get().catch(() => undefined);
            assert.strictEqual(builds.length, 3, 'a failed current build is not cached');
        } finally {
            host.dispose();
        }
    });
});

/** A webview stand-in: records what the host posts and lets the test speak for the page. */
class FakeWebview implements SessionWebview {
    readonly posted: HostMessage[] = [];
    private readonly emitter = new vscode.EventEmitter<WebviewMessage>();
    readonly onDidReceiveMessage = this.emitter.event;

    postMessage(message: HostMessage): Thenable<boolean> {
        this.posted.push(message);
        return Promise.resolve(true);
    }

    send(message: WebviewMessage): void {
        this.emitter.fire(message);
    }

    documents(): Extract<HostMessage, { type: 'document' }>[] {
        return this.posted.filter((m): m is Extract<HostMessage, { type: 'document' }> => m.type === 'document');
    }
}

suite('Editor host: session protocol', () => {
    let uri: vscode.Uri;
    let document: vscode.TextDocument;
    let webview: FakeWebview;
    let session: VisualEditorSession;
    const engineChanged = new vscode.EventEmitter<void>();

    suiteSetup(async function () {
        this.timeout(20000);
        uri = tempMarkdown(SOURCE);
        document = await vscode.workspace.openTextDocument(uri);
        const engine = buildEditorEngine(EXTENSION_ID, () => undefined);
        webview = new FakeWebview();
        session = new VisualEditorSession(document, webview, {
            engine: () => engine,
            onDidChangeEngine: engineChanged.event,
            log: () => undefined,
        });
    });

    suiteTeardown(async () => {
        session.dispose();
        engineChanged.dispose();
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), SOURCE);
        await vscode.workspace.applyEdit(edit);
        await document.save();
        fs.rmSync(uri.fsPath, { force: true });
    });

    test('ready is answered with the parsed document of the current version', async function () {
        this.timeout(10000);
        webview.send({ type: 'ready' });
        await session.settled();
        const [first] = webview.documents();
        assert.ok(first, `expected a document, got ${JSON.stringify(webview.posted.map(m => m.type))}`);
        assert.strictEqual(first.version, document.version);
        assert.strictEqual(first.defaultWrap, 90);
        const types = (first.json.doc.content as { type: string }[]).map(n => n.type);
        assert.deepStrictEqual(types, ['front_matter', 'heading', 'paragraph', 'raw_block']);
    });

    test('an edit is written as one minimal replacement and not echoed back', async function () {
        this.timeout(10000);
        const [first] = webview.documents();
        const changed = SOURCE.replace('stays', 'was changed');
        const changes: vscode.TextDocumentContentChangeEvent[] = [];
        const listener = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === document) {
                changes.push(...e.contentChanges);
            }
        });
        try {
            webview.send({ type: 'edit', text: changed, baseVersion: first.version });
            await session.settled();
            await delay(300);
            await session.settled();
        } finally {
            listener.dispose();
        }
        assert.strictEqual(document.getText(), changed);
        assert.strictEqual(changes.length, 1);
        assert.strictEqual(changes[0].rangeLength, 'stays'.length);
        assert.strictEqual(changes[0].text, 'was changed');
        assert.strictEqual(webview.documents().length, 1, 'the webview\'s own edit came back as a document');
    });

    test('a change from another writer is posted as a new document', async function () {
        this.timeout(10000);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, document.positionAt(document.getText().length), '\nAppended by another writer.\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await delay(300);
        await session.settled();
        const docs = webview.documents();
        assert.strictEqual(docs.length, 2);
        assert.strictEqual(docs[1].version, document.version);
    });

    test('an edit against a superseded version is not written', async function () {
        this.timeout(10000);
        const before = document.getText();
        const [stale] = webview.documents();
        webview.send({ type: 'edit', text: 'Stale text that must not land.\n', baseVersion: stale.version });
        await session.settled();
        assert.strictEqual(document.getText(), before);
    });

    test('a render request is answered with the host engine\'s HTML', async function () {
        this.timeout(10000);
        webview.send({ type: 'render', requestId: 7, src: '| x |\n| - |\n| 1 |\n' });
        const rendered = await until(
            () => webview.posted.find((m): m is Extract<HostMessage, { type: 'rendered' }> => m.type === 'rendered'),
            5000,
        );
        assert.ok(rendered);
        assert.strictEqual(rendered.requestId, 7);
        assert.ok(rendered.html.includes('<table'), rendered.html);
    });

    test('an edit asking to save is applied, then saved', async function () {
        this.timeout(10000);
        const last = webview.documents().pop();
        assert.ok(last);
        assert.ok(document.isDirty, 'the earlier edits left the document dirty');
        const changed = document.getText().replace('wrapped as it was written.', 'wrapped, then saved.');
        webview.send({ type: 'edit', text: changed, baseVersion: last.version, save: true });
        await session.settled();
        assert.strictEqual(document.getText(), changed);
        assert.strictEqual(document.isDirty, false, 'the save ran after the edit, not before it');
        assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), changed);
    });

    test('a save with nothing left to send still saves what an earlier edit wrote', async function () {
        this.timeout(10000);
        const last = webview.documents().pop();
        assert.ok(last);
        const changed = document.getText().replace('wrapped, then saved.', 'wrapped, edited, saved later.');
        webview.send({ type: 'edit', text: changed, baseVersion: last.version });
        await session.settled();
        assert.ok(document.isDirty);
        webview.send({ type: 'edit', text: changed, baseVersion: last.version, save: true });
        await session.settled();
        assert.strictEqual(document.isDirty, false);
        assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), changed);
    });

    test('an edit asking to reparse is applied, then posted back parsed afresh, once', async function () {
        this.timeout(10000);
        const last = webview.documents().pop();
        assert.ok(last);
        const before = webview.documents().length;
        // What a raw block's source commit sends: syntax outside the editable
        // core (authored inline HTML), written as source into the paragraph.
        const changed = document.getText().replace('wrapped, edited, saved later.', 'wrapped, <kbd>marked</kbd> later.');
        webview.send({ type: 'edit', text: changed, baseVersion: last.version, reparse: true });
        await session.settled();
        await delay(300);
        await session.settled();
        assert.strictEqual(document.getText(), changed);
        const docs = webview.documents();
        assert.strictEqual(docs.length, before + 1, 'the page\'s own edit is posted back once, and only because it asked');
        const posted = docs[docs.length - 1];
        assert.strictEqual(posted.version, document.version);
        const marked = (posted.json.doc.content as { type: string; attrs?: { src?: string; html?: string } }[])
            .find(n => n.attrs?.src?.includes('<kbd>marked</kbd>'));
        assert.strictEqual(marked?.type, 'raw_block', 'the paragraph comes back as a source block');
        assert.ok(marked?.attrs?.html?.includes('<kbd>marked</kbd>'), marked?.attrs?.html);

        // Without `reparse`, the same kind of edit is not echoed.
        const plain = changed.replace('<kbd>marked</kbd>', '<kbd>marked twice</kbd>');
        webview.send({ type: 'edit', text: plain, baseVersion: posted.version });
        await session.settled();
        assert.strictEqual(document.getText(), plain);
        assert.strictEqual(webview.documents().length, before + 1);
    });
});

suite('Editor host: provider smoke test', () => {
    test('opening a file in the Visual Editor shows it in a custom tab and writes nothing', async function () {
        this.timeout(30000);
        const uri = tempMarkdown(SOURCE);
        try {
            await vscode.commands.executeCommand('vscode.openWith', uri, VISUAL_EDITOR_VIEW_TYPE);
            const tab = await until(() => customTab(uri), 10000);
            assert.ok(tab, 'no tab with the Visual Editor\'s view type');

            // Give the page time to load, say ready and receive the document —
            // the moment a careless host would write something back.
            await delay(2000);
            const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            assert.ok(document, 'the custom editor holds no TextDocument for the file');
            assert.strictEqual(document.getText(), SOURCE);
            assert.strictEqual(document.isDirty, false);

            await vscode.window.tabGroups.close(tab);
        } finally {
            fs.rmSync(uri.fsPath, { force: true });
        }
    });
});
