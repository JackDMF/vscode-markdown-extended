import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { EditorEngineHost, buildEditorEngine } from '../../../src/editor/host/engineHost';
import { editorPage, localResourceRoots } from '../../../src/editor/host/html';
import { CodeActionController } from '../../../src/editor/host/codeActions';
import {
    IncludeController, IncludePickItem, IncludePicker, IncludeProvider, NO_INCLUDES_MESSAGE, collectIncludeProviders,
} from '../../../src/editor/host/includes';
import { blockIndexForLine, lensHintOf, lensRows } from '../../../src/editor/host/lenses';
import { VISUAL_EDITOR_VIEW_TYPE } from '../../../src/editor/host/provider';
import { SessionHost, SessionWebview, VisualEditorSession, revealInVisualEditor } from '../../../src/editor/host/session';
import { fillDestination } from '../../../src/editor/host/images';
import { fragmentLine, githubSlug, headingAnchors } from '../../../src/editor/host/links';
import { GITHUB_SLUG_REPLACE } from '../../../src/editor/host/githubSlugRegex';
import { blockLineRanges } from '../../../src/editor/parse';
import { HostMessage, WebviewMessage } from '../../../src/editor/protocol';
import { ActiveVisualEditor, ActiveVisualEditorTracker, TrackedEditor, TrackedPanel, VisualEditorApi } from '../../../src/editor/host/activeEditor';

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

    test('an image keeps its alt text, and a media link or image still embeds', async () => {
        // markdown-it-html5-embed 0.3.3 rendered every image by the link rule's
        // default when both of its syntaxes were on in one registration.
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        assert.ok(md.render('![A diagram](a.png)', {}).includes('alt="A diagram"'), md.render('![A diagram](a.png)', {}));
        assert.ok(md.render('![clip](v.mp4)', {}).includes('<video'));
        assert.ok(md.render('[talk](t.mp3)', {}).includes('<audio'));
    });
});

suite('Editor host: page', () => {
    test('the page links the codicon font\'s stylesheet before the editor\'s, from dist/codicons, which the webview may read', () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, 'the extension is installed in the test host');
        const asWebviewUri = (uri: vscode.Uri) => vscode.Uri.parse(`https://webview.test${uri.path}`);
        const webview = { cspSource: 'https://webview.test', asWebviewUri } as unknown as vscode.Webview;
        const html = editorPage(webview, extension.extensionUri, vscode.Uri.file('/doc.md'));
        const hrefs = Array.from(html.matchAll(/<link rel="stylesheet" type="text\/css" href="([^"]+)"/g), m => m[1]);
        const codicons = hrefs.findIndex(h => h.endsWith('/dist/codicons/codicon.css'));
        assert.ok(codicons >= 0, `codicon.css is linked: ${hrefs.join(', ')}`);
        assert.ok(codicons < hrefs.findIndex(h => h.endsWith('/styles/editor.css')), 'before the editor\'s own styles');
        assert.ok(/font-src https:\/\/webview\.test /.test(html), 'font-src admits the webview\'s own origin');
        const font = vscode.Uri.joinPath(extension.extensionUri, 'dist', 'codicons', 'codicon.css').path;
        assert.ok(localResourceRoots(extension.extensionUri).some(r => font.startsWith(r.path.endsWith('/') ? r.path : `${r.path}/`)),
            'some root the webview may read is an ancestor of the font');
        for (const file of ['codicon.css', 'codicon.ttf']) {
            assert.ok(fs.existsSync(path.join(extension.extensionUri.fsPath, 'dist', 'codicons', file)), `${file} is built into dist/codicons`);
        }
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
        assert.deepStrictEqual(types, ['front_matter', 'heading', 'paragraph', 'table']);
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
    /** The document's text when each lens command ran. */
    const textsAtRun: string[] = [];
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
                textsAtRun.push(document.getText());
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

    test('a runLens sent right after an edit runs once the edit has landed', async function () {
        this.timeout(10000);
        await session.settled();
        const msg = lensMessages()[lensMessages().length - 1];
        const [doc] = webview.documents();
        textsAtRun.length = 0;
        const typed = document.getText().replace('A paragraph.', 'A paragraph, typed just before the click.');
        webview.send({ type: 'edit', text: typed, baseVersion: doc.version });
        webview.send({ type: 'runLens', id: msg.rows[1].items[0].id as string });
        const text = await until(() => textsAtRun[0], 5000);
        assert.strictEqual(text, typed, 'the command saw the typed text: it ran behind the edit, and did not race it');
        await session.settled();
        assert.strictEqual(document.getText(), typed);
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

    test('a lens naming its surface carries it to the page; a lens without, or with a malformed hint, carries none; the command keeps the hint', () => {
        const lens = (line: number, title: string, args: unknown[]) => new vscode.CodeLens(
            new vscode.Range(line, 0, line, 1), { title, command: 'test.lens', arguments: args },
        );
        const status = { reqExplorer: { surface: 'status', artifact: 'FRS-TST-001' } };
        const links = { reqExplorer: { surface: 'links', artifact: 'FRS-TST-001', relation: 'verified-by' } };
        const { rows, commands } = lensRows([
            lens(4, 'Set status', ['a', status]),
            lens(4, '3 tests', [links]),
            lens(4, 'Foreign', ['plain']),
            // The hint is the last argument, or none.
            lens(4, 'Hint not last', [status, 'after']),
            lens(4, 'Unknown surface', [{ reqExplorer: { surface: 'elsewhere', artifact: 'FRS-TST-001' } }]),
            lens(4, 'No artifact', [{ reqExplorer: { surface: 'status' } }]),
            lens(4, 'Null argument', [null]),
        ], ranges, '1');
        assert.deepStrictEqual(rows[0].items.map(({ title, surface, artifact, relation }) => ({ title, surface, artifact, relation })), [
            { title: 'Set status', surface: 'status', artifact: 'FRS-TST-001', relation: undefined },
            { title: '3 tests', surface: 'links', artifact: 'FRS-TST-001', relation: 'verified-by' },
            { title: 'Foreign', surface: undefined, artifact: undefined, relation: undefined },
            { title: 'Hint not last', surface: undefined, artifact: undefined, relation: undefined },
            { title: 'Unknown surface', surface: undefined, artifact: undefined, relation: undefined },
            { title: 'No artifact', surface: undefined, artifact: undefined, relation: undefined },
            { title: 'Null argument', surface: undefined, artifact: undefined, relation: undefined },
        ]);
        assert.ok(!('surface' in rows[0].items[2]), 'a foreign lens has no hint fields at all');
        assert.deepStrictEqual(commands.get(rows[0].items[0].id as string)?.arguments, ['a', status], 'the command runs with the hint in place');
        assert.deepStrictEqual(lensHintOf({ title: 'x', command: 'c', arguments: [links] }), links.reqExplorer);
        assert.strictEqual(lensHintOf({ title: 'x', command: 'c' }), undefined);

        // A symmetric relation's side: `out` or `in`, and nothing else.
        const side = (direction: unknown) => lensHintOf({
            title: 'x', command: 'c',
            arguments: [{ reqExplorer: { surface: 'links', artifact: 'FRS-TST-001', relation: 'conflicts-with', direction } }],
        });
        assert.strictEqual(side('in')?.direction, 'in');
        assert.strictEqual(side('out')?.direction, 'out');
        assert.ok(side('sideways') && !('direction' in (side('sideways') as object)), 'an unknown side is left out; the lens keeps its relation');
        const withSide = lensRows([lens(4, 'Conflicted by', [{ reqExplorer: { surface: 'links', artifact: 'FRS-TST-001', relation: 'conflicts-with', direction: 'in' } }])], ranges, '2');
        assert.strictEqual(withSide.rows[0].items[0].direction, 'in', 'the side crosses to the page');
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
    const logged: string[] = [];
    const handle = { kind: 'handle', call: () => 'called' };
    /** How long the provider takes; above 0, an edit can land while VS Code computes. */
    let providerDelayMs = 0;
    /** Called as the provider is asked, before it answers. */
    let onProvide: (() => void) | undefined;

    const answer = (requestId: number) => until(
        () => webview.posted.find((m): m is ActionsMessage => m.type === 'actions' && m.requestId === requestId), 5000,
    );
    type InvalidateMessage = Extract<HostMessage, { type: 'invalidateActions' }>;
    const invalidations = () => webview.posted.filter((m): m is InvalidateMessage => m.type === 'invalidateActions');
    /** The version of the last document posted, which the page's edits are based on (its own edits are not posted back). */
    const pageVersion = () => {
        const last = webview.documents().pop();
        assert.ok(last);
        return last.version;
    };

    suiteSetup(async function () {
        this.timeout(20000);
        uri = tempMarkdown(ACTION_SOURCE);
        subscriptions.push(
            vscode.commands.registerCommand(ACTION_COMMAND, (...args: unknown[]) => {
                ran.push(args);
            }),
            vscode.languages.registerCodeActionsProvider({ language: 'markdown' }, {
                provideCodeActions: async (d, range) => {
                    if (d.uri.toString() !== uri.toString()) {
                        return [];
                    }
                    asked.push(range);
                    onProvide?.();
                    if (providerDelayMs > 0) {
                        await delay(providerDelayMs);
                    }
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
            log: line => logged.push(line),
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
        await session.settled();
    });

    test('actions computed while the page\'s text moved on are not offered: the answer is empty and the page is told to ask again', async function () {
        this.timeout(10000);
        // A controller of its own, whose page stops holding the text while the
        // provider computes — what an edit landing in that moment does. (VS Code
        // itself may drop the actions of a model that changed meanwhile, so a
        // real edit does not show whether the controller checks after the await.)
        let holds = true;
        const posts: HostMessage[] = [];
        const controller = new CodeActionController({
            document,
            pageHolds: () => holds,
            lineRanges: async text => blockLineRanges(await buildEditorEngine(EXTENSION_ID, () => undefined), text),
            post: m => {
                posts.push(m);
                return Promise.resolve(true);
            },
            log: () => undefined,
        });
        onProvide = () => {
            holds = false;
        };
        providerDelayMs = 200;
        try {
            await controller.answer(40, 1, 2);
            const msg = posts.find((m): m is ActionsMessage => m.type === 'actions');
            assert.ok(msg);
            assert.deepStrictEqual(msg.items, [], 'no action of the text that was replaced');
            assert.ok(await until(() => (posts.some(m => m.type === 'invalidateActions') ? true : undefined), 2000), 'the page is told to ask again');
        } finally {
            onProvide = undefined;
            providerDelayMs = 0;
            controller.dispose();
        }
    });

    test('an action offered before the page\'s edit is refused, not applied over it; the page is told why, and the typed text stays', async function () {
        this.timeout(10000);
        webview.send({ type: 'actionsFor', requestId: 21, blockIndex: 1, blocks: 2 });
        const msg = await answer(21);
        assert.ok(msg);
        const insert = msg.items.find(i => i.title === 'Insert marker');
        assert.ok(insert);
        const typed = document.getText().replace('A paragraph', 'A typed paragraph');
        // The page flushed its pending edit before the click: both arrive back to back.
        webview.send({ type: 'edit', text: typed, baseVersion: pageVersion() });
        webview.send({ type: 'runAction', id: insert.id });
        const refused = await until(() => invalidations().find(m => m.refused === 'Insert marker'), 3000);
        await session.settled();
        assert.ok(refused, 'the page is told the action was refused');
        assert.strictEqual(document.getText(), typed, 'the typed text landed, and the stale edit was not written after it');
        assert.ok(logged.some(l => l.startsWith('[WARN]') && l.includes('Insert marker')), JSON.stringify(logged));
    });

    test('a change of the document\'s diagnostics invalidates the page\'s answers, without any lens', async function () {
        this.timeout(10000);
        const before = invalidations().length;
        const diagnostics = vscode.languages.createDiagnosticCollection('mep-test');
        try {
            diagnostics.set(uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'A test finding')]);
            assert.ok(await until(() => (invalidations().length > before ? true : undefined), 3000), 'invalidateActions posted');
        } finally {
            diagnostics.dispose();
        }
    });

    test('an answer the page can no longer receive is a logged warning, not an unhandled rejection', async function () {
        this.timeout(10000);
        const warnings: string[] = [];
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        const controller = new CodeActionController({
            document,
            pageHolds: () => true,
            lineRanges: async () => [[0, 1], [2, 4]],
            post: () => Promise.reject(new Error('Webview is disposed')),
            log: line => warnings.push(line),
        });
        try {
            await controller.answer(30, 1, 2);
            await delay(200);
        } finally {
            process.off('unhandledRejection', onRejection);
            controller.dispose();
        }
        assert.deepStrictEqual(rejections, []);
        assert.ok(warnings.some(l => l.startsWith('[WARN]') && l.includes('Webview is disposed')), JSON.stringify(warnings));
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

/** A document whose headings a fragment can name: 0-based lines in the comments. */
const FRAGMENT_TARGET = [
    '# Title',                                          // 0
    '',
    '## FRS-TST-001: Smoke {#frs-tst-001-1a2b3c4d}',    // 2
    '',
    '## Second Heading, with `code` & punctuation!',    // 4
    '',
    '## Second Heading, with `code` & punctuation!',    // 6
    '',
    '## Other {#title}',                                // 8
    '',
    'Text.',
    '',
    // Enough below for any heading to be scrolled to the top of the window.
    ...Array.from({ length: 80 }, (_, k) => `Filler ${k}.\n`),
].join('\n');

suite('Editor host: a link lands on the element its fragment names', () => {
    test('the slug rule is the one the built-in Markdown language server of this VS Code uses', function () {
        const bundle = path.join(vscode.env.appRoot, 'extensions', 'markdown-language-features', 'dist', 'serverWorkerMain.js');
        if (!fs.existsSync(bundle)) {
            this.skip();
        }
        const src = fs.readFileSync(bundle, 'utf8');
        const key = 'githubSlugReplaceRegex = /';
        const start = src.indexOf(key);
        assert.ok(start >= 0, 'the built-in names its slug regex githubSlugReplaceRegex');
        const shipped = src.slice(start + key.length, src.indexOf('/g;', start));
        assert.strictEqual(GITHUB_SLUG_REPLACE.source, shipped, 'regenerate src/editor/host/githubSlugRegex.ts from this VS Code');
        assert.strictEqual(githubSlug('  Second Heading, with `code` & punctuation!  '), 'second-heading-with-code--punctuation');
    });

    test('a {#id} heading, a slugged heading, a repeated slug, a line fragment; an id wins over a slug; a missing one is none', async () => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const anchors = headingAnchors(md, FRAGMENT_TARGET, {});
        const line = (fragment: string) => fragmentLine(anchors, fragment);
        assert.strictEqual(line('frs-tst-001-1a2b3c4d'), 2, 'the explicit id');
        assert.strictEqual(line('frs-tst-001-smoke'), 2, 'its slug too: the id is not in the slugged text');
        assert.strictEqual(line('second-heading-with-code--punctuation'), 4);
        assert.strictEqual(line('Second-Heading-With-Code--Punctuation'), 4, 'compared without case');
        assert.strictEqual(line('second-heading-with-code--punctuation-1'), 6, 'the second of a repeated slug');
        assert.strictEqual(line('title'), 8, 'an id wins over the slug of "# Title"');
        assert.strictEqual(line('L11'), 10);
        assert.strictEqual(line('no-such-heading'), null);
        assert.strictEqual(line(''), null);
    });

    test('a link to another file opens it at the heading; a fragment it lacks opens it at the top, logged as info at most', async function () {
        this.timeout(20000);
        const source = tempMarkdown('Source.\n');
        const dir = path.dirname(source.fsPath);
        const target = vscode.Uri.file(path.join(dir, `mep-fragment-target-${process.pid}-${Date.now()}.md`));
        const other = vscode.Uri.file(path.join(dir, `mep-fragment-other-${process.pid}-${Date.now()}.md`));
        fs.writeFileSync(target.fsPath, FRAGMENT_TARGET, 'utf8');
        fs.writeFileSync(other.fsPath, FRAGMENT_TARGET, 'utf8');
        const logged: string[] = [];
        const engineChanged = new vscode.EventEmitter<void>();
        const webview = new FakeWebview();
        const session = new VisualEditorSession(await vscode.workspace.openTextDocument(source), webview, {
            engine: () => buildEditorEngine(EXTENSION_ID, () => undefined),
            onDidChangeEngine: engineChanged.event,
            log: line => logged.push(line),
        });
        const editorOn = (uri: vscode.Uri) => until(() => {
            const editor = vscode.window.activeTextEditor;
            return editor && editor.document.uri.toString() === uri.toString() ? editor : undefined;
        }, 5000);
        try {
            webview.send({ type: 'openLink', href: `${path.basename(target.fsPath)}#frs-tst-001-1a2b3c4d` });
            const editor = await editorOn(target);
            assert.ok(editor, 'the target opened in the text editor');
            await until(() => (editor.selection.active.line === 2 ? true : undefined), 3000);
            assert.strictEqual(editor.selection.active.line, 2, 'the caret on the heading');
            // In view. That it stands at the top is not checked here: the test
            // host's window does not render, and scrolls nothing — revealRange
            // and revealLine alike leave its visible range at line 0.
            assert.ok(editor.visibleRanges.some(r => r.contains(new vscode.Position(2, 0))), 'the heading in view');

            webview.send({ type: 'openLink', href: `${path.basename(other.fsPath)}#no-such-heading` });
            const opened = await editorOn(other);
            assert.ok(opened, 'the file opens all the same');
            await delay(200);
            assert.strictEqual(opened.selection.active.line, 0, 'at the top');
            assert.deepStrictEqual(logged.filter(l => !l.startsWith('[INFO]')), [], 'nothing louder than info');
            assert.ok(logged.some(l => l.startsWith('[INFO]') && l.includes('#no-such-heading')), JSON.stringify(logged));
        } finally {
            session.dispose();
            engineChanged.dispose();
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            for (const uri of [source, target, other]) {
                fs.rmSync(uri.fsPath, { force: true });
            }
        }
    });

    test('a link to this very document is revealed in its own page; a reveal for another page reaches that page\'s session', async function () {
        this.timeout(10000);
        const uri = tempMarkdown(FRAGMENT_TARGET);
        const second = tempMarkdown(FRAGMENT_TARGET);
        const engineChanged = new vscode.EventEmitter<void>();
        const host = { engine: () => buildEditorEngine(EXTENSION_ID, () => undefined), onDidChangeEngine: engineChanged.event, log: () => undefined };
        const webview = new FakeWebview();
        const otherWebview = new FakeWebview();
        const session = new VisualEditorSession(await vscode.workspace.openTextDocument(uri), webview, host);
        const otherSession = new VisualEditorSession(await vscode.workspace.openTextDocument(second), otherWebview, host);
        const reveals = (w: FakeWebview) => w.posted.filter(m => m.type === 'revealAnchor');
        try {
            webview.send({ type: 'ready' });
            await until(() => webview.documents()[0], 5000);
            webview.send({ type: 'openLink', href: `${path.basename(uri.fsPath)}#second-heading-with-code--punctuation-1` });
            await until(() => reveals(webview)[0], 5000);
            assert.deepStrictEqual(reveals(webview), [{ type: 'revealAnchor', anchor: 'second-heading-with-code--punctuation-1', line: 6 }]);

            // Before the other page has its document the reveal waits, then follows the document.
            revealInVisualEditor(second, { anchor: 'frs-tst-001-1a2b3c4d', line: 2 });
            await delay(100);
            assert.deepStrictEqual(reveals(otherWebview), []);
            otherWebview.send({ type: 'ready' });
            await until(() => reveals(otherWebview)[0], 5000);
            assert.deepStrictEqual(otherWebview.posted.map(m => m.type).slice(0, 2), ['document', 'revealAnchor']);
        } finally {
            session.dispose();
            otherSession.dispose();
            engineChanged.dispose();
            fs.rmSync(uri.fsPath, { force: true });
            fs.rmSync(second.fsPath, { force: true });
        }
    });
});

type IncludeChosenMessage = Extract<HostMessage, { type: 'includeChosen' }>;

/** A picker that answers for the person: records what it was shown, and picks what `choose` says. */
class FakePicker implements IncludePicker {
    readonly shown: { items: IncludePickItem[]; options: vscode.QuickPickOptions }[] = [];
    readonly informed: string[] = [];
    choose: (items: IncludePickItem[]) => IncludePickItem | undefined = () => undefined;

    pick(items: IncludePickItem[], options: vscode.QuickPickOptions): Thenable<IncludePickItem | undefined> {
        this.shown.push({ items, options });
        return Promise.resolve(this.choose(items));
    }

    inform(text: string): void {
        this.informed.push(text);
    }
}

function provider(id: string, displayName: string, list: (uri: vscode.Uri) => unknown): IncludeProvider {
    return { id, displayName, listIncludeChoices: list };
}

/**
 * Include insertion. No extension offering includes is installed in the test
 * host (`--disable-extensions`), so the providers are injected — the session
 * and the controller take a `providers()` function, the real collection by
 * default — and the QuickPick is answered by a fake picker.
 */
suite('Editor host: includes', () => {
    const logged: string[] = [];
    let document: vscode.TextDocument;
    let uri: vscode.Uri;

    suiteSetup(async () => {
        uri = tempMarkdown(SOURCE);
        document = await vscode.workspace.openTextDocument(uri);
    });

    suiteTeardown(() => {
        fs.rmSync(uri.fsPath, { force: true });
    });

    /** A controller over the test document, posting into `posts`. */
    const controller = (providers: IncludeProvider[], picker: FakePicker, posts: HostMessage[]) => new IncludeController({
        document,
        pageHolds: () => true,
        lineRanges: async () => [],
        post: m => {
            posts.push(m);
            return Promise.resolve(true);
        },
        log: line => logged.push(line),
    }, async () => providers, picker);

    test('the real collection skips every extension that exports no listIncludeChoices', async () => {
        // This extension and VS Code's built-in math extension both contribute
        // markdown-it plugins, and neither offers includes.
        assert.deepStrictEqual(await collectIncludeProviders(undefined, line => logged.push(line)), []);
        assert.deepStrictEqual(await collectIncludeProviders(EXTENSION_ID, line => logged.push(line)), []);
    });

    test('choices are collected from every provider, each under a separator with its display name; the chosen line is the answer', async () => {
        const asked: string[] = [];
        const picker = new FakePicker();
        picker.choose = items => items.find(i => i.label === 'legal-notice');
        const posts: HostMessage[] = [];
        await controller([
            provider('corpus.req-explorer', 'Req Explorer', u => {
                asked.push(u.toString());
                return Promise.resolve([
                    { label: 'legal-notice', description: 'Legal notice', detail: 'snippets/legal-notice.md', insert: '<!-- include: legal-notice -->' },
                    { label: 'glossary', insert: 'INCLUDE glossary\n' },
                ]);
            }),
            provider('other.snippets', 'Other Snippets', () => [{ label: 'intro', description: '', insert: '@include intro' }]),
        ], picker, posts).answer(7, false);

        assert.deepStrictEqual(asked, [uri.toString()], 'asked for this document');
        assert.strictEqual(picker.shown.length, 1);
        const { items, options } = picker.shown[0];
        assert.deepStrictEqual(items.map(i => [i.kind === vscode.QuickPickItemKind.Separator ? 'separator' : 'choice', i.label]), [
            ['separator', 'Req Explorer'], ['choice', 'legal-notice'], ['choice', 'glossary'],
            ['separator', 'Other Snippets'], ['choice', 'intro'],
        ]);
        assert.deepStrictEqual([items[1].description, items[1].detail], ['Legal notice', 'snippets/legal-notice.md']);
        assert.strictEqual(items[2].insert, 'INCLUDE glossary', 'a terminator at the end is the page\'s to write');
        assert.strictEqual(items[4].description, undefined, 'an empty description is none');
        assert.deepStrictEqual(options, { placeHolder: 'Include…', matchOnDescription: true, matchOnDetail: true });
        assert.deepStrictEqual(posts, [{ type: 'includeChosen', requestId: 7, insert: '<!-- include: legal-notice -->' }]);
    });

    test('a provider that throws, rejects or answers no list is logged and skipped; so is a choice without a label or a one-line insert', async () => {
        const picker = new FakePicker();
        picker.choose = items => items.find(i => i.insert !== undefined);
        const posts: HostMessage[] = [];
        logged.length = 0;
        await controller([
            provider('broken.throws', 'Throws', () => {
                throw new Error('provider exploded');
            }),
            provider('broken.rejects', 'Rejects', () => Promise.reject(new Error('provider rejected'))),
            provider('broken.object', 'Not a list', () => ({ label: 'x', insert: 'x' })),
            provider('mixed.choices', 'Mixed', () => [
                null, { label: '', insert: 'x' }, { label: 'two lines', insert: 'a\nb' }, { label: 'blank', insert: '  ' }, { insert: 'unlabelled' },
                { label: 'good', insert: 'GOOD' },
            ]),
        ], picker, posts).answer(8, true);

        const { items, options } = picker.shown[0];
        assert.deepStrictEqual(items.map(i => i.label), ['Mixed', 'good'], 'only the provider with a valid choice, and only that choice');
        assert.strictEqual(options.placeHolder, 'Change snippet…', 'a replacement says so');
        assert.deepStrictEqual(posts, [{ type: 'includeChosen', requestId: 8, insert: 'GOOD' }]);
        for (const id of ['broken.throws', 'broken.rejects', 'broken.object', 'mixed.choices']) {
            assert.ok(logged.some(l => l.startsWith('[WARN]') && l.includes(id)), `${id} logged: ${JSON.stringify(logged)}`);
        }
    });

    test('nothing to offer shows the information message and answers without a line; a dismissed pick answers without one too', async () => {
        const picker = new FakePicker();
        const posts: HostMessage[] = [];
        await controller([provider('empty.one', 'Empty', () => [])], picker, posts).answer(9, false);
        await controller([], picker, posts).answer(10, false);
        assert.deepStrictEqual(picker.informed, [NO_INCLUDES_MESSAGE, NO_INCLUDES_MESSAGE]);
        assert.strictEqual(NO_INCLUDES_MESSAGE, 'No extension offers includes for this document');
        assert.strictEqual(picker.shown.length, 0, 'no empty QuickPick');

        await controller([provider('one', 'One', () => [{ label: 'a', insert: 'A' }])], picker, posts).answer(11, false);
        assert.strictEqual(picker.shown.length, 1);
        assert.deepStrictEqual(posts, [
            { type: 'includeChosen', requestId: 9 },
            { type: 'includeChosen', requestId: 10 },
            { type: 'includeChosen', requestId: 11 },
        ]);
    });

    test('the document says whether any extension offers includes', async function () {
        this.timeout(10000);
        const engine = buildEditorEngine(EXTENSION_ID, () => undefined);
        const engineChanged = new vscode.EventEmitter<void>();
        const flags: boolean[] = [];
        for (const providers of [[], [provider('one', 'One', () => [])]]) {
            const webview = new FakeWebview();
            const session = new VisualEditorSession(document, webview, {
                engine: () => engine,
                onDidChangeEngine: engineChanged.event,
                log: () => undefined,
                includeProviders: async () => providers,
            });
            try {
                webview.send({ type: 'ready' });
                await session.settled();
                const [posted] = webview.documents();
                assert.ok(posted);
                flags.push(posted.includes);
            } finally {
                session.dispose();
            }
        }
        engineChanged.dispose();
        assert.deepStrictEqual(flags, [false, true]);
    });

    test('pickInclude is answered behind the edit the page sent before it: the provider reads the typed text', async function () {
        this.timeout(10000);
        const source = tempMarkdown(SOURCE);
        const doc = await vscode.workspace.openTextDocument(source);
        const engineChanged = new vscode.EventEmitter<void>();
        const webview = new FakeWebview();
        const picker = new FakePicker();
        picker.choose = items => items.find(i => i.insert !== undefined);
        const seen: string[] = [];
        const session = new VisualEditorSession(doc, webview, {
            engine: () => buildEditorEngine(EXTENSION_ID, () => undefined),
            onDidChangeEngine: engineChanged.event,
            log: () => undefined,
            includeProviders: async () => [provider('reads.document', 'Reads', () => {
                seen.push(doc.getText());
                return [{ label: 'x', insert: 'X' }];
            })],
            includePicker: picker,
        });
        try {
            webview.send({ type: 'ready' });
            await session.settled();
            const [first] = webview.documents();
            assert.ok(first);
            const typed = SOURCE.replace('stays', 'was typed');
            // The page flushed its pending edit before asking: both arrive back to back.
            webview.send({ type: 'edit', text: typed, baseVersion: first.version });
            webview.send({ type: 'pickInclude', requestId: 3 });
            const answer = await until(() => webview.posted.find((m): m is IncludeChosenMessage => m.type === 'includeChosen'), 5000);
            assert.deepStrictEqual(answer, { type: 'includeChosen', requestId: 3, insert: 'X' });
            assert.deepStrictEqual(seen, [typed], 'the provider was asked after the edit landed');
        } finally {
            session.dispose();
            engineChanged.dispose();
            // Not saved first: a save's local-history copy races the removal.
            fs.rmSync(source.fsPath, { force: true });
        }
    });
});

type MapMessage = Extract<HostMessage, { type: 'map' }>;

/** How long the suite's session waits for a `mapped` answer. */
const MAP_TIMEOUT = 300;

suite('Editor host: the caret and source positions', () => {
    let uri: vscode.Uri;
    let document: vscode.TextDocument;
    let webview: FakeWebview;
    let session: VisualEditorSession;
    const engineChanged = new vscode.EventEmitter<void>();
    const carets: (vscode.Position | undefined)[] = [];

    const lastDocument = () => {
        const docs = webview.documents();
        return docs[docs.length - 1];
    };
    const caretNow = () => (session.caret === undefined ? undefined : [session.caret.line, session.caret.character]);

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
            mapTimeoutMs: MAP_TIMEOUT,
        });
        session.onDidChangeCaret(caret => carets.push(caret));
        webview.send({ type: 'ready' });
        await session.settled();
    });

    suiteTeardown(() => {
        session.dispose();
        engineChanged.dispose();
        // Not saved first: a save's local-history copy races the removal.
        fs.rmSync(uri.fsPath, { force: true });
    });

    test('toSource and toPage ask the page, and take its answer only for the document it holds', async function () {
        this.timeout(10000);
        const posted = lastDocument();
        const requests = () => webview.posted.filter((m): m is MapMessage => m.type === 'map');
        const before = requests().length;

        const source = session.toSource(12);
        const asked = await until(() => requests()[before], 2000);
        assert.ok(asked);
        assert.deepStrictEqual(asked.toSource, [12]);
        webview.send({ type: 'mapped', id: asked.id, baseVersion: posted.version, toSource: [{ line: 7, character: 2, approximate: false }], toPage: [] });
        assert.deepStrictEqual(await source, { position: new vscode.Position(7, 2), approximate: false });

        const page = session.toPage(new vscode.Position(7, 2));
        const askedPage = await until(() => requests()[before + 1], 2000);
        assert.ok(askedPage);
        assert.deepStrictEqual(askedPage.toPage, [{ line: 7, character: 2 }]);
        webview.send({ type: 'mapped', id: askedPage.id, baseVersion: posted.version, toSource: [], toPage: [{ pos: 30, approximate: true }] });
        assert.deepStrictEqual(await page, { pos: 30, approximate: true });

        const stale = session.toSource(12);
        const askedStale = await until(() => requests()[before + 2], 2000);
        assert.ok(askedStale);
        webview.send({ type: 'mapped', id: askedStale.id, baseVersion: posted.version - 1, toSource: [{ line: 7, character: 2, approximate: false }], toPage: [] });
        assert.strictEqual(await stale, undefined, 'an answer for an older document is dropped');

        const none = session.toSource(1);
        const askedNone = await until(() => requests()[before + 3], 2000);
        assert.ok(askedNone);
        webview.send({ type: 'mapped', id: askedNone.id, baseVersion: posted.version, toSource: [null], toPage: [] });
        assert.strictEqual(await none, undefined, 'a position that is none');

        const started = Date.now();
        assert.strictEqual(await session.toSource(5), undefined, 'no answer: undefined once the wait is over');
        assert.ok(Date.now() - started >= MAP_TIMEOUT - 50);
    });

    test('a caret for the document the host posted is taken; one for a superseded version is dropped', async function () {
        this.timeout(10000);
        const posted = lastDocument();
        webview.send({ type: 'caret', baseVersion: posted.version - 1, position: { line: 7, character: 2 } });
        await session.settled();
        assert.strictEqual(session.caret, undefined, 'a stale caret is dropped');
        webview.send({ type: 'caret', baseVersion: posted.version, position: { line: 7, character: 2 } });
        await session.settled();
        assert.deepStrictEqual(caretNow(), [7, 2]);
        webview.send({ type: 'caret', baseVersion: posted.version, position: { line: 7, character: 2 } });
        await session.settled();
        assert.strictEqual(carets.length, 1, 'the same caret again is no change');
        webview.send({ type: 'caret', baseVersion: posted.version, position: null });
        await session.settled();
        assert.strictEqual(session.caret, undefined, 'no caret: a selected atom, an approximate mapping');
        webview.send({ type: 'caret', baseVersion: posted.version, position: { line: -1, character: 0 } });
        await session.settled();
        assert.strictEqual(session.caret, undefined, 'a malformed position is none');
    });

    test('a caret behind the page\'s edit is in the edited text; another writer\'s change makes it unknown', async function () {
        this.timeout(10000);
        const posted = lastDocument();
        webview.send({ type: 'caret', baseVersion: posted.version, position: { line: 7, character: 2 } });
        await session.settled();
        assert.deepStrictEqual(caretNow(), [7, 2]);
        const typed = document.getText().replace('stays', 'stays, typed');
        const seenWhileApplying: (vscode.Position | undefined)[] = [];
        const listener = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document === document) {
                seenWhileApplying.push(session.caret);
            }
        });
        try {
            // The page sends its caret right after the edit that carries it.
            webview.send({ type: 'edit', text: typed, baseVersion: posted.version });
            webview.send({ type: 'caret', baseVersion: posted.version, position: { line: 7, character: 29 } });
            await session.settled();
        } finally {
            listener.dispose();
        }
        assert.strictEqual(document.getText(), typed);
        assert.ok(seenWhileApplying.length > 0 && seenWhileApplying.every(c => c === undefined), 'a listener to the edit is not handed the caret of the text before it');
        assert.deepStrictEqual(caretNow(), [7, 29]);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, document.positionAt(document.getText().length), '\nAppended by another writer.\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.strictEqual(session.caret, undefined, 'the caret was a position in the text before the change');
        assert.strictEqual(await session.toSource(1), undefined, 'nor is any position mapped while the page holds the old text');
        webview.send({ type: 'caret', baseVersion: posted.version, position: { line: 7, character: 29 } });
        await delay(300);
        await session.settled();
        assert.strictEqual(session.caret, undefined, 'a caret for the text before is dropped');
        const next = lastDocument();
        assert.ok(next.version > posted.version, 'the change was posted');
        webview.send({ type: 'caret', baseVersion: next.version, position: { line: 7, character: 3 } });
        await session.settled();
        assert.deepStrictEqual(caretNow(), [7, 3]);
    });
});

suite('Editor host: a change that comes and goes', () => {
    test('another writer\'s change undone before the re-sync posts no document and asks the page for its caret', async function () {
        this.timeout(20000);
        const uri = tempMarkdown(SOURCE);
        const document = await vscode.workspace.openTextDocument(uri);
        const engineChanged = new vscode.EventEmitter<void>();
        const webview = new FakeWebview();
        const session = new VisualEditorSession(document, webview, {
            engine: () => buildEditorEngine(EXTENSION_ID, () => undefined),
            onDidChangeEngine: engineChanged.event,
            log: () => undefined,
        });
        try {
            webview.send({ type: 'ready' });
            await session.settled();
            const [posted] = webview.documents();
            webview.send({ type: 'caret', baseVersion: posted.version, position: { line: 7, character: 2 } });
            await session.settled();
            assert.ok(session.caret);

            const insert = new vscode.WorkspaceEdit();
            insert.insert(uri, new vscode.Position(7, 0), 'x');
            assert.ok(await vscode.workspace.applyEdit(insert));
            assert.strictEqual(session.caret, undefined);
            const remove = new vscode.WorkspaceEdit();
            remove.delete(uri, new vscode.Range(7, 0, 7, 1));
            assert.ok(await vscode.workspace.applyEdit(remove));
            assert.strictEqual(document.getText(), SOURCE);
            await delay(300);
            await session.settled();
            assert.strictEqual(webview.documents().length, 1, 'the text is the page\'s again: nothing to post');
            assert.ok(webview.posted.some(m => m.type === 'reportCaret'), 'the page is asked to report its caret again');
            webview.send({ type: 'caret', baseVersion: posted.version, position: { line: 7, character: 2 } });
            await session.settled();
            assert.deepStrictEqual([session.caret?.line, session.caret?.character], [7, 2]);
        } finally {
            session.dispose();
            engineChanged.dispose();
            fs.rmSync(uri.fsPath, { force: true });
        }
    });
});

/** A panel stand-in for the tracker: `active` as the test sets it, and the event VS Code would fire. */
class FakePanel implements TrackedPanel {
    active = false;
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeViewState = this.emitter.event;

    set(active: boolean): void {
        this.active = active;
        this.emitter.fire();
    }
}

/** A session stand-in for the tracker: its uri, and a caret the test moves. */
class FakeEditor implements TrackedEditor {
    caret: vscode.Position | undefined;
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCaret = this.emitter.event;

    constructor(readonly uri: vscode.Uri) { }

    move(caret: vscode.Position | undefined): void {
        this.caret = caret;
        this.emitter.fire();
    }
}

suite('Editor host: the active Visual Editor', () => {
    const describe = (active: ActiveVisualEditor | undefined) =>
        active === undefined ? 'none' : `${active.uri.path}${active.caret ? `@${active.caret.line}:${active.caret.character}` : ''}`;

    test('the editor whose panel is active, and its caret, until another takes the focus or it closes', () => {
        const tracker = new ActiveVisualEditorTracker();
        const events: string[] = [];
        tracker.api.onDidChangeActive(active => events.push(describe(active)));
        try {
            const a = new FakeEditor(vscode.Uri.file('/a.md'));
            const b = new FakeEditor(vscode.Uri.file('/b.md'));
            const panelA = new FakePanel();
            const panelB = new FakePanel();
            panelA.active = true;
            tracker.track(panelA, a);
            const trackingB = tracker.track(panelB, b);
            assert.strictEqual(describe(tracker.api.active()), '/a.md');

            a.move(new vscode.Position(3, 4));
            b.move(new vscode.Position(9, 9));
            assert.strictEqual(describe(tracker.api.active()), '/a.md@3:4', 'only the active editor\'s caret is news');

            panelA.set(false);
            panelB.set(true);
            assert.strictEqual(describe(tracker.api.active()), '/b.md@9:9');
            trackingB.dispose();
            assert.strictEqual(tracker.api.active(), undefined, 'a closed editor is not active');
            assert.deepStrictEqual(events, ['/a.md', '/a.md@3:4', 'none', '/b.md@9:9', 'none']);
            assert.deepStrictEqual(Object.keys(tracker.api).sort(), ['active', 'onDidChangeActive'], 'nothing of the tracker leaks');
        } finally {
            tracker.dispose();
        }
    });

    test('activate exports it, and a Visual Editor opened is the active one until its tab closes', async function () {
        this.timeout(30000);
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension);
        const api = (await extension.activate() as { visualEditor: VisualEditorApi }).visualEditor;
        assert.strictEqual(typeof api.active, 'function');
        assert.strictEqual(typeof api.onDidChangeActive, 'function');
        const uri = tempMarkdown(SOURCE);
        try {
            await vscode.commands.executeCommand('vscode.openWith', uri, VISUAL_EDITOR_VIEW_TYPE);
            const active = await until(() => (api.active()?.uri.toString() === uri.toString() ? api.active() : undefined), 10000);
            assert.ok(active, 'the opened Visual Editor is the active one');
            const tab = await until(() => customTab(uri), 10000);
            assert.ok(tab);
            await vscode.window.tabGroups.close(tab);
            const gone = await until(() => (api.active()?.uri.toString() === uri.toString() ? undefined : true), 10000);
            assert.ok(gone, 'a closed Visual Editor is not active');
        } finally {
            fs.rmSync(uri.fsPath, { force: true });
        }
    });
});

/** A webview that says where it loads a file from, as VS Code's `asWebviewUri` does. */
class ResolvingWebview extends FakeWebview {
    asWebviewUri(uri: vscode.Uri): vscode.Uri {
        return vscode.Uri.parse(`https://webview.test${uri.path}`);
    }

    answer<T extends HostMessage['type']>(type: T): Promise<Extract<HostMessage, { type: T }> | undefined> {
        return until(() => this.posted.find((m): m is Extract<HostMessage, { type: T }> => m.type === type), 5000);
    }
}

/**
 * Links and images on the host: completion for a link's field, the paths an
 * inserted image or a dropped file is written with, a pasted bitmap written
 * beside the document, and where the page loads an image from. A folder of
 * its own holds the document and the files it links to; the file list is the
 * test's (the test host opens no workspace folder).
 */
suite('Editor host: links and images', () => {
    let dir: string;
    let docUri: vscode.Uri;
    let document: vscode.TextDocument;
    const engineChanged = new vscode.EventEmitter<void>();
    const TEXT = '# Intro\n\nText.\n\n## Scope {#scope-id}\n\nMore.\n';

    suiteSetup(async function () {
        this.timeout(20000);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mep-links-'));
        fs.mkdirSync(path.join(dir, 'docs'));
        fs.mkdirSync(path.join(dir, 'pictures'));
        fs.writeFileSync(path.join(dir, 'doc.md'), TEXT, 'utf8');
        fs.writeFileSync(path.join(dir, 'docs', 'other file.md'), '# Other Heading\n\nText.\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'pictures', 'my pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        fs.writeFileSync(path.join(dir, 'z.txt'), 'z', 'utf8');
        docUri = vscode.Uri.file(path.join(dir, 'doc.md'));
        document = await vscode.workspace.openTextDocument(docUri);
    });

    suiteTeardown(() => {
        engineChanged.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const files = () => [
        vscode.Uri.file(path.join(dir, 'z.txt')),
        vscode.Uri.file(path.join(dir, 'pictures', 'my pic.png')),
        docUri,
        vscode.Uri.file(path.join(dir, 'docs', 'other file.md')),
    ];

    const open = (extra: Partial<SessionHost> = {}) => {
        const webview = new ResolvingWebview();
        const session = new VisualEditorSession(document, webview, {
            engine: () => buildEditorEngine(EXTENSION_ID, () => undefined),
            onDidChangeEngine: engineChanged.event,
            log: () => undefined,
            linkFiles: async () => files(),
            ...extra,
        });
        return { webview, session };
    };

    const choices = async (query: string, images = false) => {
        const { webview, session } = open();
        try {
            webview.send({ type: 'linkChoices', requestId: 5, query, ...(images ? { images: true as const } : {}) });
            const answer = await webview.answer('linkChoicesResult');
            assert.ok(answer, `an answer to ${query}`);
            assert.strictEqual(answer.requestId, 5);
            return answer.items;
        } finally {
            session.dispose();
        }
    };

    test('a link\'s field completes with the files relative to the document, Markdown first, encoded as a destination; the document itself is not offered', async function () {
        this.timeout(10000);
        assert.deepStrictEqual((await choices('')).map(c => [c.value, c.label, c.kind]), [
            ['docs/other%20file.md', 'docs/other file.md', 'file'],
            ['z.txt', 'z.txt', 'file'],
            ['pictures/my%20pic.png', 'pictures/my pic.png', 'file'],
        ]);
        assert.deepStrictEqual((await choices('my%20p')).map(c => c.value), ['pictures/my%20pic.png'], 'a typed escape matches the name');
        assert.deepStrictEqual((await choices('', true)).map(c => c.value), ['pictures/my%20pic.png'], 'an image\'s path: images only');
        assert.deepStrictEqual(await choices('https://exa'), [], 'a web address completes to nothing');
    });

    test('#… completes with this document\'s headings — an explicit {#id} as written, else the slug — and path#… with that file\'s', async function () {
        this.timeout(10000);
        assert.deepStrictEqual((await choices('#')).map(c => [c.value, c.detail, c.kind]), [
            ['#intro', 'Intro', 'heading'],
            ['#scope-id', 'Scope', 'heading'],
        ]);
        assert.deepStrictEqual((await choices('#sco')).map(c => c.value), ['#scope-id'], 'filtered by anchor or text');
        assert.deepStrictEqual((await choices('docs/other%20file.md#')).map(c => [c.value, c.label]), [['docs/other%20file.md#other-heading', '#other-heading']],
            'the path is fixed once # is typed: the list shows the anchor, the value is the whole destination');
        assert.deepStrictEqual(await choices('z.txt#'), [], 'a file that is not Markdown has no headings to offer');
    });

    test('Insert → Image… asks VS Code\'s open dialog in the document\'s folder for an image, and answers its path relative to the document, POSIX, spaces encoded, its stem the alt text', async function () {
        this.timeout(10000);
        const asked: vscode.OpenDialogOptions[] = [];
        const { webview, session } = open({
            openDialog: options => {
                asked.push(options);
                return Promise.resolve([vscode.Uri.file(path.join(dir, 'pictures', 'my pic.png'))]);
            },
        });
        try {
            webview.send({ type: 'pickImage', requestId: 9 });
            const answer = await webview.answer('filesChosen');
            assert.deepStrictEqual(answer, { type: 'filesChosen', requestId: 9, files: [{ src: 'pictures/my%20pic.png', alt: 'my pic', image: true }] });
            assert.strictEqual(asked.length, 1);
            assert.strictEqual(asked[0].defaultUri?.toString(), vscode.Uri.file(dir).toString());
            assert.strictEqual(asked[0].canSelectMany, false);
            assert.ok(asked[0].filters?.Images.includes('png'));
        } finally {
            session.dispose();
        }
    });

    test('a dismissed dialog answers with no file', async function () {
        this.timeout(10000);
        const { webview, session } = open({ openDialog: () => Promise.resolve(undefined) });
        try {
            webview.send({ type: 'pickImage', requestId: 10 });
            assert.deepStrictEqual(await webview.answer('filesChosen'), { type: 'filesChosen', requestId: 10, files: [] });
        } finally {
            session.dispose();
        }
    });

    test('dropped files are answered relative to the document: an image as an image, another file as a link named by its name; a uri or a path', async function () {
        this.timeout(10000);
        const { webview, session } = open();
        try {
            const outside = path.join(path.dirname(dir), 'spec sheet.pdf');
            webview.send({ type: 'insertFiles', requestId: 11, uris: [vscode.Uri.file(path.join(dir, 'pictures', 'my pic.png')).toString(), outside] });
            assert.deepStrictEqual(await webview.answer('filesChosen'), {
                type: 'filesChosen', requestId: 11, files: [
                    { src: 'pictures/my%20pic.png', alt: 'my pic', image: true },
                    { src: '../spec%20sheet.pdf', alt: 'spec sheet.pdf', image: false },
                ],
            });
        } finally {
            session.dispose();
        }
    });

    test('a pasted screenshot is written to images/<document>-<yyyymmdd-hhmmss>.png beside the document, and answered as the image the page inserts', async function () {
        this.timeout(10000);
        const { webview, session } = open();
        try {
            const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
            webview.send({ type: 'saveImage', requestId: 12, bytes: bytes.toString('base64'), suggestedName: 'image.png' });
            const answer = await webview.answer('filesChosen');
            assert.ok(answer, 'answered');
            assert.strictEqual(answer.requestId, 12);
            assert.strictEqual(answer.files.length, 1, JSON.stringify(answer));
            const [file] = answer.files;
            assert.match(file.src, /^images\/doc-\d{8}-\d{6}\.png$/);
            assert.strictEqual(file.alt, file.src.slice('images/'.length, -'.png'.length), 'its file\'s stem, from the host');
            assert.strictEqual(file.image, true);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, ...file.src.split('/'))), bytes, 'the bytes the page sent');
        } finally {
            session.dispose();
        }
    });

    test('images dropped from the system keep their name, and two saves at once of one name write two files, one after the other', async function () {
        this.timeout(10000);
        const { webview, session } = open();
        try {
            const first = Buffer.from([1, 2, 3]);
            const second = Buffer.from([4, 5, 6]);
            webview.send({ type: 'saveImage', requestId: 21, bytes: first.toString('base64'), suggestedName: 'my diagram.png' });
            webview.send({ type: 'saveImage', requestId: 22, bytes: second.toString('base64'), suggestedName: 'my diagram.png' });
            await until(() => webview.posted.filter(m => m.type === 'filesChosen' && (m.requestId === 21 || m.requestId === 22)).length === 2 ? true : undefined, 5000);
            const answers = webview.posted.filter((m): m is Extract<HostMessage, { type: 'filesChosen' }> => m.type === 'filesChosen' && (m.requestId === 21 || m.requestId === 22));
            assert.deepStrictEqual(answers.map(a => [a.requestId, a.files.map(f => [f.src, f.alt])]), [
                [21, [['images/my%20diagram.png', 'my diagram']]],
                [22, [['images/my%20diagram-1.png', 'my diagram-1']]],
            ]);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'images', 'my diagram.png')), first);
            assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'images', 'my diagram-1.png')), second, 'not written over the first');
        } finally {
            session.dispose();
        }
    });

    test('markdown.copyFiles.destination\'s variables are filled in as the built-in fills them', () => {
        const ctx = { documentUri: vscode.Uri.file('/ws/docs/guide.md'), workspaceFolder: vscode.Uri.file('/ws'), fileName: 'image.png', now: new Date(0) };
        assert.strictEqual(fillDestination('assets/${documentBaseName}/', ctx), 'assets/guide/image.png', 'a trailing / takes the file name');
        assert.strictEqual(fillDestination('/media/${fileName}', ctx), `${vscode.Uri.file('/ws').path}/media/image.png`, 'a leading / is the workspace folder');
        assert.strictEqual(fillDestination('${documentRelativeDirName}/${fileExtName}-\\$x', ctx), 'docs/png-$x');
        assert.strictEqual(fillDestination('${fileName/(.*)\\.png/$1.jpg/}', ctx), 'image.jpg', 'a ${name/regex/replacement/} transform');
        assert.strictEqual(fillDestination('', ctx), 'image.png');
    });

    test('an image\'s src is resolved against the document to the address the webview loads it from; a web address and a data: image are shown as written', async function () {
        this.timeout(10000);
        const { webview, session } = open();
        try {
            const srcs = ['pictures/my%20pic.png', 'https://example.com/a.png', 'http://example.com/b.png', 'data:image/png;base64,AAAA'];
            webview.send({ type: 'resolveImages', requestId: 13, srcs });
            const answer = await webview.answer('imagesResolved');
            assert.ok(answer);
            const file = vscode.Uri.file(path.join(dir, 'pictures', 'my pic.png'));
            assert.deepStrictEqual(Object.keys(answer.sources), ['pictures/my%20pic.png']);
            assert.strictEqual(answer.sources['pictures/my%20pic.png'], vscode.Uri.parse(`https://webview.test${file.path}`).toString());
        } finally {
            session.dispose();
        }
    });

    test('the webview may load from the document\'s folder', () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension);
        const roots = localResourceRoots(extension.extensionUri, docUri).map(r => r.toString());
        assert.ok(roots.includes(vscode.Uri.file(dir).toString()), roots.join(', '));
        assert.ok(!localResourceRoots(extension.extensionUri).map(r => r.toString()).includes(vscode.Uri.file(dir).toString()), 'only for its document');
    });
});
