import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { commandLinkAllowed, hoverParts, parseCommandLink, renderHoverParts } from '../../../src/editor/host/hover';
import { offsetIn, snippetText } from '../../../src/editor/host/completion';
import { SessionWebview, VisualEditorSession } from '../../../src/editor/host/session';
import { HostMessage, WebviewMessage } from '../../../src/editor/protocol';

const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

const SOURCE = [
    '# Title',
    '',
    'See FRS- for the rule.',
    '',
    'A second paragraph.',
    '',
].join('\n');

function tempMarkdown(text: string): vscode.Uri {
    const file = path.join(os.tmpdir(), `mep-language-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
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
        await delay(25);
    }
}

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

    last<T extends HostMessage['type']>(type: T, where: (m: Extract<HostMessage, { type: T }>) => boolean = () => true): Extract<HostMessage, { type: T }> | undefined {
        return this.posted.filter((m): m is Extract<HostMessage, { type: T }> => m.type === type).filter(where).pop();
    }
}

/** The pure halves: a snippet's text, a hover's trust, a command link. */
suite('Editor language features: snippets and trusted command links', () => {
    test('a snippet inserts its defaults, the caret at $0 or its end', () => {
        assert.deepStrictEqual(snippetText('plain'), { text: 'plain', cursor: 5 });
        assert.deepStrictEqual(snippetText('[${1:text}](${2:url})$0'), { text: '[text](url)', cursor: 11 });
        assert.deepStrictEqual(snippetText('a$0b'), { text: 'ab', cursor: 1 });
        assert.deepStrictEqual(snippetText('${1|one,two|} ${TM_FILENAME} \\$5 \\}'), { text: 'one  $5 }', cursor: 9 });
        assert.deepStrictEqual(snippetText('${1:outer ${2:inner}}!'), { text: 'outer inner!', cursor: 12 });
        assert.deepStrictEqual(snippetText('cost: $'), { text: 'cost: $', cursor: 7 });
    });

    test('an offset is read as VS Code breaks lines; a character past a line\'s end is its end', () => {
        assert.strictEqual(offsetIn('ab\r\ncd\nef', { line: 1, character: 1 }), 5);
        assert.strictEqual(offsetIn('ab\r\ncd\nef', { line: 1, character: 9 }), 6);
        assert.strictEqual(offsetIn('ab', { line: 5, character: 0 }), 2);
    });

    test('a command link runs only what the part is trusted for', () => {
        assert.strictEqual(commandLinkAllowed(true, 'any.command'), true);
        assert.strictEqual(commandLinkAllowed({ enabledCommands: ['a.allowed'] }, 'a.allowed'), true);
        assert.strictEqual(commandLinkAllowed({ enabledCommands: ['a.allowed'] }, 'b.denied'), false);
        assert.strictEqual(commandLinkAllowed(false, 'a.allowed'), false);
        assert.strictEqual(commandLinkAllowed(undefined, 'a.allowed'), false);
    });

    test('a command link\'s arguments are read as VS Code reads them', () => {
        assert.deepStrictEqual(parseCommandLink(`command:a.run?${encodeURIComponent(JSON.stringify(['x', 2]))}`), { command: 'a.run', args: ['x', 2] });
        assert.deepStrictEqual(parseCommandLink('command:a.run?{"k":1}'), { command: 'a.run', args: [{ k: 1 }] }, 'not an array: the one argument');
        assert.deepStrictEqual(parseCommandLink('command:a.run'), { command: 'a.run', args: [] });
        assert.strictEqual(parseCommandLink('https://example.com'), null);
    });

    test('rendering keeps a trusted command link as a registered id, strips any other to its text, and keeps ordinary links', () => {
        const trusted = new vscode.MarkdownString('[Run](command:a.allowed?%5B%22x%22%5D) [Deny](command:b.denied) [Web](https://example.com)');
        trusted.isTrusted = { enabledCommands: ['a.allowed'] };
        const untrusted = new vscode.MarkdownString('[Also](command:a.allowed)');
        const registered: [string, unknown[]][] = [];
        const html = renderHoverParts(hoverParts([new vscode.Hover([trusted, untrusted])]), (command, args) => {
            registered.push([command, args]);
            return `id${registered.length}`;
        });
        assert.deepStrictEqual(registered, [['a.allowed', ['x']]], 'only the trusted part\'s enabled command');
        assert.ok(html.includes('data-mep-command="id1"'), html);
        assert.ok(!/command:/.test(html), `no command: target survives: ${html}`);
        assert.ok(html.includes('>Deny<') || html.includes(' Deny '), 'the denied link is its text');
        assert.ok(html.includes('href="https://example.com"'));
        assert.strictEqual((html.match(/mep-hover-part/g) ?? []).length, 2, 'one part each');
    });

    test('raw HTML is text unless the part allows it, and never keeps a command: target', () => {
        const plain = new vscode.MarkdownString('<b>bold</b>');
        assert.ok(renderHoverParts(hoverParts([new vscode.Hover([plain])]), () => 'x').includes('&lt;b&gt;'));
        const html = new vscode.MarkdownString('<a href="command:evil">x</a> <b>bold</b>');
        html.supportHtml = true;
        html.isTrusted = true;
        const out = renderHoverParts(hoverParts([new vscode.Hover([html])]), () => 'x');
        assert.ok(out.includes('<b>bold</b>'), out);
        assert.ok(!out.includes('command:'), out);
    });
});

type Execute = (args: unknown[]) => unknown;

/**
 * The host's answers to `complete`, `applyCompletion`, `hover`,
 * `quickFixesFor` and its `diagnostics`, with VS Code's side played by fake
 * `executeCommand` answers: versions checked, stale answers dropped, the
 * trusted commands kept to what a hover names.
 */
suite('Editor host: completion, diagnostics and hover', () => {
    let uri: vscode.Uri;
    let document: vscode.TextDocument;
    let webview: FakeWebview;
    let session: VisualEditorSession;
    const engineChanged = new vscode.EventEmitter<void>();
    const diagnosticsChanged = new vscode.EventEmitter<vscode.DiagnosticChangeEvent>();
    let diagnostics: vscode.Diagnostic[] = [];
    const calls: { command: string; args: unknown[] }[] = [];
    const answers = new Map<string, Execute>();

    const version = () => {
        const last = webview.last('document');
        assert.ok(last, 'a document was posted');
        return last.version;
    };
    const called = (command: string) => calls.filter(c => c.command === command);
    const reset = async () => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), SOURCE);
        await vscode.workspace.applyEdit(edit);
        await until(() => (webview.last('document')?.json && document.getText() === SOURCE ? true : undefined), 3000);
        await delay(200);
        await session.settled();
    };

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
            executeCommand: <T>(command: string, ...args: unknown[]) => {
                calls.push({ command, args });
                const answer = answers.get(command);
                return Promise.resolve(answer ? answer(args) : undefined) as Thenable<T>;
            },
            diagnostics: () => diagnostics,
            onDidChangeDiagnostics: diagnosticsChanged.event,
        });
        webview.send({ type: 'ready' });
        await session.settled();
    });

    suiteTeardown(async () => {
        session.dispose();
        engineChanged.dispose();
        diagnosticsChanged.dispose();
        fs.rmSync(uri.fsPath, { force: true });
    });

    setup(() => {
        calls.length = 0;
        answers.clear();
    });

    const idItems = () => {
        const a = new vscode.CompletionItem('FRS-RXE-057', vscode.CompletionItemKind.Reference);
        a.detail = 'Generated requirement summary';
        a.range = new vscode.Range(2, 4, 2, 8);
        a.sortText = 'b';
        const b = new vscode.CompletionItem({ label: 'FRS-RXE-058', description: 'Composed deliverable' }, vscode.CompletionItemKind.Reference);
        b.range = { inserting: new vscode.Range(2, 4, 2, 8), replacing: new vscode.Range(2, 4, 2, 9) };
        b.insertText = new vscode.SnippetString('FRS-RXE-058${0}');
        b.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(4, 0), 'Also: ')];
        b.sortText = 'a';
        return new vscode.CompletionList([a, b], true);
    };

    test('complete asks VS Code at the position with the trigger, and answers the items as the page lists them, VS Code\'s order', async function () {
        this.timeout(10000);
        answers.set('vscode.executeCompletionItemProvider', () => idItems());
        webview.send({ type: 'complete', requestId: 1, baseVersion: version(), position: { line: 2, character: 8 }, triggerCharacter: '-' });
        const answer = await until(() => webview.last('completions', m => m.requestId === 1), 3000);
        assert.ok(answer);
        const [call] = called('vscode.executeCompletionItemProvider');
        assert.strictEqual((call.args[0] as vscode.Uri).toString(), uri.toString());
        assert.deepStrictEqual([(call.args[1] as vscode.Position).line, (call.args[1] as vscode.Position).character, call.args[2]], [2, 8, '-']);
        assert.strictEqual(answer.version, version());
        assert.strictEqual(answer.incomplete, true);
        assert.deepStrictEqual(answer.items, [
            {
                label: 'FRS-RXE-058', detail: 'Composed deliverable', kind: 'reference', insertText: 'FRS-RXE-058',
                range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, sortText: 'a',
            },
            {
                label: 'FRS-RXE-057', detail: 'Generated requirement summary', kind: 'reference', insertText: 'FRS-RXE-057',
                range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, sortText: 'b',
            },
        ], 'by sortText; the inserting range; a snippet as the text it inserts');
    });

    test('a question from a page on another version is answered with nothing, and VS Code is not asked', async function () {
        this.timeout(10000);
        answers.set('vscode.executeCompletionItemProvider', () => idItems());
        webview.send({ type: 'complete', requestId: 2, baseVersion: version() - 1, position: { line: 2, character: 8 } });
        const answer = await until(() => webview.last('completions', m => m.requestId === 2), 3000);
        assert.deepStrictEqual(answer?.items, []);
        assert.strictEqual(called('vscode.executeCompletionItemProvider').length, 0);
    });

    test('an answer computed while the document changed is dropped: the page gets nothing', async function () {
        this.timeout(10000);
        answers.set('vscode.executeCompletionItemProvider', async () => {
            const edit = new vscode.WorkspaceEdit();
            edit.insert(uri, new vscode.Position(0, 0), 'x');
            await vscode.workspace.applyEdit(edit);
            return idItems();
        });
        webview.send({ type: 'complete', requestId: 3, baseVersion: version(), position: { line: 2, character: 8 } });
        const answer = await until(() => webview.last('completions', m => m.requestId === 3), 3000);
        assert.deepStrictEqual(answer?.items, []);
        await reset();
    });

    test('applyCompletion applies the item to the source — its range, its additional edit — posts the document, then the caret', async function () {
        this.timeout(10000);
        answers.set('vscode.executeCompletionItemProvider', () => idItems());
        webview.send({ type: 'complete', requestId: 4, baseVersion: version(), position: { line: 2, character: 8 } });
        assert.ok(await until(() => webview.last('completions', m => m.requestId === 4), 3000));
        const before = webview.posted.length;
        webview.send({ type: 'applyCompletion', requestId: 4, index: 0, baseVersion: version(), position: { line: 2, character: 8 } });
        const applied = await until(() => webview.last('completionApplied', m => m.requestId === 4), 3000);
        assert.ok(applied);
        assert.strictEqual(document.getText(), SOURCE.replace('See FRS- for', 'See FRS-RXE-058 for').replace('A second', 'Also: A second'));
        const types = webview.posted.slice(before).map(m => m.type);
        assert.ok(types.indexOf('document') >= 0 && types.indexOf('document') < types.indexOf('completionApplied'), `the document first: ${JSON.stringify(types)}`);
        assert.strictEqual(applied.version, version(), 'the caret is in the document just posted');
        assert.deepStrictEqual(applied.caret, { line: 2, character: 'See FRS-RXE-058'.length }, 'at the snippet\'s $0');
        await reset();
    });

    test('what the page typed inside the item\'s range since the answer is covered by it; a change outside the range refuses the item', async function () {
        this.timeout(10000);
        answers.set('vscode.executeCompletionItemProvider', () => idItems());
        webview.send({ type: 'complete', requestId: 5, baseVersion: version(), position: { line: 2, character: 8 } });
        assert.ok(await until(() => webview.last('completions', m => m.requestId === 5), 3000));
        // The page typed `RX` while the list filtered.
        const typed = SOURCE.replace('See FRS- for', 'See FRS-RX for');
        webview.send({ type: 'edit', text: typed, baseVersion: version() });
        webview.send({ type: 'applyCompletion', requestId: 5, index: 1, baseVersion: version(), position: { line: 2, character: 10 } });
        const applied = await until(() => webview.last('completionApplied', m => m.requestId === 5), 3000);
        assert.deepStrictEqual(applied?.caret, { line: 2, character: 'See FRS-RXE-057'.length });
        assert.strictEqual(document.getText(), SOURCE.replace('See FRS- for', 'See FRS-RXE-057 for'), 'the typed RX replaced, not kept beside');
        await reset();

        webview.send({ type: 'complete', requestId: 6, baseVersion: version(), position: { line: 2, character: 8 } });
        assert.ok(await until(() => webview.last('completions', m => m.requestId === 6), 3000));
        webview.send({ type: 'edit', text: SOURCE.replace('Title', 'Title!'), baseVersion: version() });
        webview.send({ type: 'applyCompletion', requestId: 6, index: 0, baseVersion: version(), position: { line: 2, character: 8 } });
        const refused = await until(() => webview.last('completionApplied', m => m.requestId === 6), 3000);
        assert.strictEqual(refused?.caret, null);
        assert.strictEqual(document.getText(), SOURCE.replace('Title', 'Title!'), 'nothing applied');
        await reset();
    });

    test('an item of an older answer is not applied', async function () {
        this.timeout(10000);
        webview.send({ type: 'applyCompletion', requestId: 4, index: 0, baseVersion: version(), position: { line: 2, character: 8 } });
        const refused = await until(() => webview.last('completionApplied', m => m.requestId === 4 && m.caret === null), 3000);
        assert.ok(refused);
        assert.strictEqual(document.getText(), SOURCE);
    });

    test('hover renders the providers\' Markdown; only the commands the hover names run, with their arguments', async function () {
        this.timeout(10000);
        const trusted = new vscode.MarkdownString(`**FRS-RXE-057** [Read](command:req.read?${encodeURIComponent(JSON.stringify([{ id: 'FRS-RXE-057' }]))}) [Graph](command:req.graph) [Other](command:other.run)`);
        trusted.isTrusted = { enabledCommands: ['req.read', 'req.graph'] };
        answers.set('vscode.executeHoverProvider', () => [new vscode.Hover([trusted], new vscode.Range(2, 4, 2, 8))]);
        webview.send({ type: 'hover', requestId: 7, baseVersion: version(), position: { line: 2, character: 5 } });
        const answer = await until(() => webview.last('hoverResult', m => m.requestId === 7), 3000);
        assert.ok(answer);
        assert.deepStrictEqual(answer.range, { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } });
        const ids = [...answer.html.matchAll(/data-mep-command="([^"]+)"/g)].map(m => m[1]);
        assert.strictEqual(ids.length, 2, answer.html);
        assert.ok(!answer.html.includes('other.run'), 'a command the hover does not name is stripped');
        webview.send({ type: 'runHoverCommand', id: ids[0] });
        webview.send({ type: 'runHoverCommand', id: 'not-registered' });
        await until(() => (called('req.read').length > 0 ? true : undefined), 3000);
        await session.settled();
        assert.deepStrictEqual(called('req.read').map(c => c.args), [[{ id: 'FRS-RXE-057' }]]);
        assert.strictEqual(calls.filter(c => c.command === 'not-registered' || c.command === 'other.run').length, 0);
    });

    test('a hover for another version is not asked, and a later answer replaces the commands of the one before', async function () {
        this.timeout(10000);
        const md = new vscode.MarkdownString('[Run](command:req.read)');
        md.isTrusted = true;
        answers.set('vscode.executeHoverProvider', () => [new vscode.Hover([md])]);
        webview.send({ type: 'hover', requestId: 8, baseVersion: version() - 1, position: { line: 2, character: 5 } });
        const stale = await until(() => webview.last('hoverResult', m => m.requestId === 8), 3000);
        assert.strictEqual(stale?.html, '');
        assert.strictEqual(called('vscode.executeHoverProvider').length, 0);
        webview.send({ type: 'hover', requestId: 9, baseVersion: version(), position: { line: 2, character: 5 } });
        const first = await until(() => webview.last('hoverResult', m => m.requestId === 9), 3000);
        webview.send({ type: 'hover', requestId: 10, baseVersion: version(), position: { line: 2, character: 5 } });
        await until(() => webview.last('hoverResult', m => m.requestId === 10), 3000);
        const oldId = /data-mep-command="([^"]+)"/.exec(first?.html ?? '')?.[1];
        assert.ok(oldId);
        webview.send({ type: 'runHoverCommand', id: oldId });
        await delay(100);
        await session.settled();
        assert.strictEqual(called('req.read').length, 0, 'an id of an earlier answer runs nothing');
    });

    test('diagnostics are sent when they change, as the page draws them, for the version the page shows', async function () {
        this.timeout(10000);
        const d = new vscode.Diagnostic(new vscode.Range(2, 4, 2, 8), 'Edge target FRS-RXE-999 does not exist.', vscode.DiagnosticSeverity.Error);
        d.code = { value: 'RX021', target: vscode.Uri.parse('https://example.com/rx021') };
        d.source = 'Req Explorer';
        const w = new vscode.Diagnostic(new vscode.Range(0, 2, 0, 7), 'Heading', vscode.DiagnosticSeverity.Warning);
        diagnostics = [d, w];
        const before = webview.posted.length;
        diagnosticsChanged.fire({ uris: [uri] });
        const sent = await until(() => webview.posted.slice(before).find((m): m is Extract<HostMessage, { type: 'diagnostics' }> => m.type === 'diagnostics'), 3000);
        assert.ok(sent);
        assert.strictEqual(sent.version, version());
        assert.deepStrictEqual(sent.items, [
            { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } }, severity: 'warning', message: 'Heading' },
            { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, severity: 'error', message: 'Edge target FRS-RXE-999 does not exist.', code: 'RX021', source: 'Req Explorer' },
        ], 'in range order; the code\'s value');
        const other = webview.posted.length;
        diagnosticsChanged.fire({ uris: [vscode.Uri.file(path.join(os.tmpdir(), 'another.md'))] });
        await delay(300);
        assert.ok(!webview.posted.slice(other).some(m => m.type === 'diagnostics'), 'another document\'s change sends nothing');
    });

    test('quickFixesFor asks for the quick fixes on the range and answers them alone; runAction applies one', async function () {
        this.timeout(10000);
        answers.set('vscode.executeCodeActionProvider', args => {
            const fix = new vscode.CodeAction('Pick the target…', vscode.CodeActionKind.QuickFix);
            fix.edit = new vscode.WorkspaceEdit();
            fix.edit.replace(uri, args[1] as vscode.Range, 'FRS-RXE-001');
            const refactor = new vscode.CodeAction('Rewrite', vscode.CodeActionKind.RefactorRewrite);
            return [fix, refactor];
        });
        webview.send({ type: 'quickFixesFor', requestId: 11, baseVersion: version(), range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } } });
        const answer = await until(() => webview.last('quickFixes', m => m.requestId === 11), 3000);
        assert.ok(answer);
        const [call] = called('vscode.executeCodeActionProvider');
        assert.strictEqual(call.args[2], 'quickfix');
        assert.deepStrictEqual(answer.items.map(i => [i.title, i.kind]), [['Pick the target…', 'quickfix']]);
        webview.send({ type: 'runAction', id: answer.items[0].id });
        await until(() => (document.getText().includes('See FRS-RXE-001 for') ? true : undefined), 3000);
        assert.strictEqual(document.getText(), SOURCE.replace('See FRS- for', 'See FRS-RXE-001 for'));
        await reset();

        webview.send({ type: 'quickFixesFor', requestId: 12, baseVersion: version() - 1, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } } });
        const stale = await until(() => webview.last('quickFixes', m => m.requestId === 12), 3000);
        assert.deepStrictEqual(stale?.items, []);
    });

    test('the count\'s click shows the Problems view', async function () {
        this.timeout(10000);
        webview.send({ type: 'showProblems' });
        await until(() => (called('workbench.actions.view.problems').length > 0 ? true : undefined), 3000);
        assert.strictEqual(called('workbench.actions.view.problems').length, 1);
    });
});
