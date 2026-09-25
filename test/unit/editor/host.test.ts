import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { EditorEngineHost, buildEditorEngine } from '../../../src/editor/host/engineHost';
import { blockIndexForLine } from '../../../src/editor/host/lenses';
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

/** The text the lens suite opens: front matter, a heading, a blank line, a paragraph. */
const LENS_SOURCE = [
    '---',            // 0
    'id: LENS-001',   // 1
    '---',            // 2
    '',               // 3
    '# Heading',      // 4
    '',               // 5
    'A paragraph.',   // 6
    '',
].join('\n');

const LENS_COMMAND = 'markdownExtended.test.lensCommand';

type LensesMessage = Extract<HostMessage, { type: 'lenses' }>;

suite('Editor host: code lenses', () => {
    let uri: vscode.Uri;
    let document: vscode.TextDocument;
    let webview: FakeWebview;
    let session: VisualEditorSession;
    const engineChanged = new vscode.EventEmitter<void>();
    const subscriptions: vscode.Disposable[] = [];
    const ran: unknown[][] = [];
    /** An argument no `postMessage` could carry: it must reach the command as this very object. */
    const handle = { kind: 'handle', call: () => 'called' };
    let resolved = 0;

    const lensMessages = () => webview.posted.filter((m): m is LensesMessage => m.type === 'lenses');
    /** The next `lenses` message after the `count`th. */
    const nextLenses = (count: number) => until(() => lensMessages()[count], 5000);
    const titlesOf = (msg: LensesMessage) => msg.rows.map(r => ({ blockIndex: r.blockIndex, titles: r.items.map(i => i.title) }));

    suiteSetup(async function () {
        this.timeout(20000);
        uri = tempMarkdown(LENS_SOURCE);
        const lens = (line: number, title: string, command: string, args: unknown[] = []) => ({
            lens: new vscode.CodeLens(new vscode.Range(line, 0, line, 1)),
            command: { title, command, arguments: args, tooltip: `${title} tooltip` },
        });
        const lenses = [
            lens(1, 'Front lens', LENS_COMMAND, ['front']),
            lens(4, 'Heading lens', LENS_COMMAND, [uri, handle]),
            lens(4, 'Second on heading', LENS_COMMAND, ['second']),
            lens(5, 'Blank-line lens', LENS_COMMAND, ['blank']),
            lens(6, 'Text only', ''),
        ];
        subscriptions.push(
            vscode.commands.registerCommand(LENS_COMMAND, (...args: unknown[]) => {
                ran.push(args);
            }),
            vscode.languages.registerCodeLensProvider({ language: 'markdown' }, {
                // Unresolved: the command comes from resolveCodeLens, as Req Explorer's does.
                provideCodeLenses: d => (d.uri.toString() === uri.toString() ? lenses.map(l => l.lens) : []),
                resolveCodeLens: codeLens => {
                    resolved++;
                    const found = lenses.find(l => l.lens === codeLens);
                    if (found) {
                        codeLens.command = found.command;
                    }
                    return codeLens;
                },
            }),
        );
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
        subscriptions.forEach(d => d.dispose());
        await vscode.workspace.getConfiguration('markdownExtended').update('editor.codeLenses', undefined, vscode.ConfigurationTarget.Global);
        fs.rmSync(uri.fsPath, { force: true });
    });

    test('after the document, each lens is posted resolved, in a row for the block its line is in', async function () {
        this.timeout(10000);
        webview.send({ type: 'ready' });
        const msg = await nextLenses(0);
        assert.ok(msg, `expected lenses, got ${JSON.stringify(webview.posted.map(m => m.type))}`);
        assert.ok(resolved >= 5, 'VS Code resolved the lenses before handing them over');
        assert.strictEqual(msg.version, document.version);
        assert.strictEqual(msg.blocks, 3, 'front matter, heading, paragraph');
        assert.deepStrictEqual(titlesOf(msg), [
            // A front-matter line is the front matter's.
            { blockIndex: 0, titles: ['Front lens'] },
            // A heading line is the heading's, every lens on it in one row.
            { blockIndex: 1, titles: ['Heading lens', 'Second on heading'] },
            // A blank line belongs to the block after it.
            { blockIndex: 2, titles: ['Blank-line lens', 'Text only'] },
        ]);
        const heading = msg.rows[1].items[0];
        assert.strictEqual(heading.tooltip, 'Heading lens tooltip');
        assert.ok(heading.id, 'a lens with a command is clickable');
        assert.strictEqual(msg.rows[2].items[1].id, undefined, 'a lens whose command has no id is text only');
        // What crosses is titles and ids; the arguments stay in the host.
        assert.ok(!JSON.stringify(msg).includes('handle'));
    });

    test('runLens runs the lens\'s command with its own arguments, objects included', async function () {
        this.timeout(10000);
        const msg = lensMessages()[lensMessages().length - 1];
        webview.send({ type: 'runLens', id: msg.rows[1].items[0].id as string });
        const args = await until(() => ran[0], 5000);
        assert.ok(args, 'the command ran');
        assert.strictEqual((args[0] as vscode.Uri).toString(), uri.toString());
        assert.strictEqual(args[1], handle, 'the very object the provider gave');

        ran.length = 0;
        webview.send({ type: 'runLens', id: 'no-such-lens' });
        await delay(200);
        assert.deepStrictEqual(ran, [], 'an id of no current lens runs nothing');
    });

    test('an applied edit is followed by lenses for the text the page now holds', async function () {
        this.timeout(10000);
        const [doc] = webview.documents();
        const before = lensMessages().length;
        webview.send({ type: 'edit', text: LENS_SOURCE.replace('A paragraph.', 'A changed paragraph.'), baseVersion: doc.version });
        const msg = await nextLenses(before);
        assert.ok(msg, 'lenses after the edit');
        assert.strictEqual(msg.version, document.version);
        assert.strictEqual(webview.documents().length, 1, 'the edit itself is not echoed');
    });

    test('with markdownExtended.editor.codeLenses off, the rows are cleared and none are sent', async function () {
        this.timeout(15000);
        const before = lensMessages().length;
        await vscode.workspace.getConfiguration('markdownExtended').update('editor.codeLenses', false, vscode.ConfigurationTarget.Global);
        const cleared = await nextLenses(before);
        assert.ok(cleared, 'the page is told');
        assert.deepStrictEqual(cleared.rows, []);

        webview.send({ type: 'refreshLenses' });
        await delay(800);
        assert.strictEqual(lensMessages().length, before + 1, 'nothing more while off');

        await vscode.workspace.getConfiguration('markdownExtended').update('editor.codeLenses', undefined, vscode.ConfigurationTarget.Global);
        const back = await nextLenses(before + 1);
        assert.ok(back);
        assert.strictEqual(back.rows.length, 3, 'the rows come back when it is on again');
    });
});

suite('Editor host: lens placement', () => {
    const ranges: ([number, number] | null)[] = [[0, 3], [4, 5], null, [6, 9], [11, 12]];

    test('a line maps to the block covering it, a gap line to the next block, the tail to the last', () => {
        assert.strictEqual(blockIndexForLine(ranges, 0), 0);
        assert.strictEqual(blockIndexForLine(ranges, 2), 0);
        assert.strictEqual(blockIndexForLine(ranges, 3), 1, 'a blank line before a block');
        assert.strictEqual(blockIndexForLine(ranges, 4), 1);
        assert.strictEqual(blockIndexForLine(ranges, 5), 3, 'past a block that stands for no lines');
        assert.strictEqual(blockIndexForLine(ranges, 10), 4);
        assert.strictEqual(blockIndexForLine(ranges, 12), 4, 'after the last block');
        assert.strictEqual(blockIndexForLine([], 0), null);
        assert.strictEqual(blockIndexForLine([null], 0), null);
    });
});

const ACTION_SOURCE = [
    '# Heading',        // 0
    '',                 // 1
    'A paragraph',      // 2
    'over two lines.',  // 3
    '',
].join('\n');

const ACTION_COMMAND = 'markdownExtended.test.actionCommand';

type ActionsMessage = Extract<HostMessage, { type: 'actions' }>;

suite('Editor host: code actions', () => {
    let uri: vscode.Uri;
    let document: vscode.TextDocument;
    let webview: FakeWebview;
    let session: VisualEditorSession;
    const engineChanged = new vscode.EventEmitter<void>();
    const subscriptions: vscode.Disposable[] = [];
    const ran: unknown[][] = [];
    const asked: vscode.Range[] = [];
    const handle = { kind: 'handle', call: () => 'called' };

    const answer = (requestId: number) => until(
        () => webview.posted.find((m): m is ActionsMessage => m.type === 'actions' && m.requestId === requestId), 5000,
    );

    suiteSetup(async function () {
        this.timeout(20000);
        uri = tempMarkdown(ACTION_SOURCE);
        subscriptions.push(
            vscode.commands.registerCommand(ACTION_COMMAND, (...args: unknown[]) => {
                ran.push(args);
            }),
            vscode.languages.registerCodeActionsProvider({ language: 'markdown' }, {
                provideCodeActions: (d, range) => {
                    if (d.uri.toString() !== uri.toString()) {
                        return [];
                    }
                    asked.push(range);
                    const insert = new vscode.CodeAction('Insert marker', vscode.CodeActionKind.QuickFix);
                    insert.edit = new vscode.WorkspaceEdit();
                    insert.edit.insert(d.uri, new vscode.Position(range.start.line, 0), 'X');
                    const withCommand = new vscode.CodeAction('With command', vscode.CodeActionKind.RefactorRewrite);
                    withCommand.command = { title: 'With command', command: ACTION_COMMAND, arguments: [handle] };
                    const organize = new vscode.CodeAction('Organize', vscode.CodeActionKind.SourceOrganizeImports);
                    organize.command = { title: 'Organize', command: ACTION_COMMAND, arguments: ['organize'] };
                    return [insert, withCommand, { title: 'Plain command', command: ACTION_COMMAND, arguments: ['plain'] }, organize];
                },
            }),
        );
        document = await vscode.workspace.openTextDocument(uri);
        const engine = buildEditorEngine(EXTENSION_ID, () => undefined);
        webview = new FakeWebview();
        session = new VisualEditorSession(document, webview, {
            engine: () => engine,
            onDidChangeEngine: engineChanged.event,
            log: () => undefined,
        });
        webview.send({ type: 'ready' });
        await session.settled();
    });

    suiteTeardown(async () => {
        session.dispose();
        engineChanged.dispose();
        subscriptions.forEach(d => d.dispose());
        fs.rmSync(uri.fsPath, { force: true });
    });

    test('actionsFor asks VS Code for the actions on the block\'s lines, and answers with titles and kinds, none acting on the file or on a text editor', async function () {
        this.timeout(10000);
        webview.send({ type: 'actionsFor', requestId: 1, blockIndex: 1, blocks: 2 });
        const msg = await answer(1);
        assert.ok(msg, `expected actions, got ${JSON.stringify(webview.posted.map(m => m.type))}`);
        assert.strictEqual(msg.blockIndex, 1);
        const range = asked[asked.length - 1];
        assert.deepStrictEqual([range.start.line, range.start.character, range.end.line, range.end.character], [2, 0, 3, 'over two lines.'.length],
            'the paragraph\'s two lines, whole');
        assert.deepStrictEqual(msg.items.map(i => [i.title, i.kind]), [
            ['Insert marker', 'quickfix'],
            ['With command', 'refactor.rewrite'],
            ['Plain command', ''],
        ], 'no source action (the file\'s), no Surround With snippet, no inline chat (a text editor\'s selection): VS Code core offers those for any range');
        assert.ok(msg.items.every(i => i.id.length > 0));
        assert.ok(!JSON.stringify(msg).includes('handle'), 'the actions stay in the host');
    });

    test('a block count the page no longer shares is answered with nothing', async function () {
        this.timeout(10000);
        webview.send({ type: 'actionsFor', requestId: 2, blockIndex: 1, blocks: 3 });
        const msg = await answer(2);
        assert.ok(msg);
        assert.deepStrictEqual(msg.items, []);
    });

    test('runAction runs a command action with its own arguments, and a plain command', async function () {
        this.timeout(10000);
        const msg = await answer(1);
        assert.ok(msg);
        webview.send({ type: 'runAction', id: msg.items[1].id });
        webview.send({ type: 'runAction', id: msg.items[2].id });
        const done = await until(() => (ran.length >= 2 ? ran : undefined), 5000);
        assert.ok(done, 'both ran');
        assert.strictEqual(ran[0][0], handle, 'the very object the provider gave');
        assert.deepStrictEqual(ran[1], ['plain']);
    });

    test('runAction applies an action\'s edit to the document, which reaches the page as a new document', async function () {
        this.timeout(10000);
        const msg = await answer(1);
        assert.ok(msg);
        const before = webview.documents().length;
        webview.send({ type: 'runAction', id: msg.items[0].id });
        const posted = await until(() => webview.documents()[before], 5000);
        assert.strictEqual(document.getText(), ACTION_SOURCE.replace('A paragraph', 'XA paragraph'));
        assert.ok(posted, 'the change is posted like any other writer\'s');
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

suite('Editor host: following a link', () => {
    test('an href a strict parse refuses (http:////x) is logged as a warning, not thrown past the session', async function () {
        this.timeout(10000);
        const uri = tempMarkdown(SOURCE);
        const document = await vscode.workspace.openTextDocument(uri);
        const logged: string[] = [];
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        const engineChanged = new vscode.EventEmitter<void>();
        const webview = new FakeWebview();
        const session = new VisualEditorSession(document, webview, {
            engine: () => buildEditorEngine(EXTENSION_ID, () => undefined),
            onDidChangeEngine: engineChanged.event,
            log: line => logged.push(line),
        });
        try {
            webview.send({ type: 'openLink', href: 'http:////x' });
            await delay(300);
            assert.deepStrictEqual(rejections, [], 'no unhandled rejection');
            assert.ok(logged.some(l => l.startsWith('[WARN]') && l.includes('http:////x')), JSON.stringify(logged));
        } finally {
            process.off('unhandledRejection', onRejection);
            session.dispose();
            engineChanged.dispose();
            fs.rmSync(uri.fsPath, { force: true });
        }
    });
});
