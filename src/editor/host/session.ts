import * as vscode from 'vscode';
import { Environment, MarkdownIt } from '../../@types/markdown-it';
import { Config } from '../../services/common/config';
import { escapeHtml } from '../../services/exporter/shared';
import { blockLineRanges, parseDocument, parsedDocumentToJSON } from '../parse';
import { HostMessage, WebviewMessage } from '../protocol';
import { CodeActionController } from './codeActions';
import { message } from './errors';
import { IncludeController, IncludePicker, IncludeProvider, collectIncludeProviders } from './includes';
import { LensController, SessionPort } from './lenses';
import { FileLister } from './linkChoices';
import { LinksAndImages } from './linksImages';
import { fragmentLine, headingAnchors, resolveLinkTarget } from './links';
import { minimalReplacement } from './minimalEdit';
import { VISUAL_EDITOR_VIEW_TYPE } from './viewType';

/** What a session needs from the extension, injected so a test can drive one without a webview. */
export interface SessionHost {
    /** The engine shared by every open editor (`EditorEngineHost.get`). */
    engine(): Promise<MarkdownIt>;
    /** Fires when the engine was rebuilt and every document must be parsed again. */
    onDidChangeEngine: vscode.Event<void>;
    log(line: string): void;
    /**
     * The extensions that offer includes (`collectIncludeProviders`, the
     * default); a test passes its own, since no provider is installed in the
     * test host.
     */
    includeProviders?(): Promise<IncludeProvider[]>;
    /** VS Code's QuickPick and information message (the default); a test answers for the person. */
    includePicker?: IncludePicker;
    /** The files a link's field completes with (`workspaceFiles`, the default); a test lists its own. */
    linkFiles?: FileLister;
    /** VS Code's open dialog (the default) for **Insert → Image…**; a test answers for the person. */
    openDialog?(options: vscode.OpenDialogOptions): Thenable<vscode.Uri[] | undefined>;
}

/** The part of a `vscode.Webview` a session talks to. */
export interface SessionWebview {
    postMessage(message: HostMessage): Thenable<boolean>;
    onDidReceiveMessage: vscode.Event<WebviewMessage>;
    /** The address the page loads a local file from; without it, no image `src` is resolved. */
    asWebviewUri?(uri: vscode.Uri): vscode.Uri;
}

/** How long a burst of changes from another writer (typing in the text editor) is left to settle before re-parsing. */
const RESYNC_DELAY_MS = 100;

/** A fragment to bring into view in a page: see the `revealAnchor` message. */
export interface Reveal {
    anchor: string;
    line: number | null;
}

/** The open sessions by document uri, so a link followed from one page can land in another. */
const sessions = new Map<string, VisualEditorSession>();
/** A reveal for a document whose page is opening: taken by its session when it is made. */
const pendingReveals = new Map<string, Reveal>();

/**
 * Bring `reveal` into view in the Visual Editor over `uri`: now, if a session
 * is open for it, else as soon as one is (the page a `vscode.open` just
 * opened may not have made its session yet). The session posts it once its
 * page has the document.
 */
export function revealInVisualEditor(uri: vscode.Uri, reveal: Reveal): void {
    const session = sessions.get(uri.toString());
    if (session) {
        session.reveal(reveal);
    } else {
        pendingReveals.set(uri.toString(), reveal);
    }
}

/**
 * One rich editor over one `TextDocument`: the host half of the protocol in
 * `../protocol.ts`.
 *
 * The document is the only state that matters. The session remembers the text
 * it believes the webview holds (`webviewText`) — the text it last posted or
 * last applied for it — and uses it for two decisions: a change to the document
 * that leaves it equal to that text is the webview's own edit coming back and
 * is not posted again; and an edit from the webview is written only while the
 * document still equals it, because an edit computed against text the document
 * no longer holds would undo whatever changed it (Req Explorer's mutation
 * engine, the text editor beside). In that case the webview is re-synced and
 * the edit is dropped; merging is not attempted in stage 1.
 */
export class VisualEditorSession implements vscode.Disposable {
    private webviewText: string | undefined;
    private postedVersion = -1;
    /** The document could not be parsed without loss; nothing is written until it can. */
    private broken = false;
    /** The snippet files the current document's expansions name; `openSnippet` opens only these. */
    private snippetPaths = new Set<string>();
    private queue: Promise<void> = Promise.resolve();
    /** The last save the page asked for; it runs after the queue, not in it. */
    private saving: Promise<void> = Promise.resolve();
    private resyncTimer: ReturnType<typeof setTimeout> | undefined;
    /** Other extensions' code lenses, asked of VS Code after every post and every applied edit. */
    private readonly lenses: LensController;
    /** Other extensions' code actions on a block, asked of VS Code when the page's object toolbar opens for it. */
    private readonly codeActions: CodeActionController;
    /** Include insertion: the choices other extensions offer, picked in VS Code's QuickPick. */
    private readonly includes: IncludeController;
    /** Links and images: completion, the open dialog, dropped and pasted files, where an image loads from. */
    private readonly linksAndImages: LinksAndImages;
    private readonly subscriptions: vscode.Disposable[];
    /** A fragment to bring into view once the page has the document (`reveal`). */
    private pendingReveal: Reveal | undefined;

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly webview: SessionWebview,
        private readonly host: SessionHost,
    ) {
        const port: SessionPort = {
            document,
            pageHolds: text => !this.broken && text === this.webviewText,
            lineRanges: async text => blockLineRanges(await this.host.engine(), text, this.env()),
            post: msg => this.webview.postMessage(msg),
            log: line => this.host.log(line),
        };
        this.lenses = new LensController(port);
        this.codeActions = new CodeActionController(port);
        const includeProviders = host.includeProviders?.bind(host) ?? (() => collectIncludeProviders(undefined, line => this.host.log(line)));
        this.includes = new IncludeController(port, includeProviders, host.includePicker);
        this.linksAndImages = new LinksAndImages({
            port,
            engine: () => this.host.engine(),
            enqueue: work => this.enqueue(work),
            asWebviewUri: webview.asWebviewUri?.bind(webview),
            linkFiles: host.linkFiles,
            openDialog: host.openDialog?.bind(host),
        });
        this.subscriptions = [
            this.lenses,
            this.codeActions,
            webview.onDidReceiveMessage(msg => this.receive(msg)),
            webview.onDidReceiveMessage(msg => this.linksAndImages.receive(msg)),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === this.document.uri.toString()) {
                    this.documentChanged();
                }
            }),
            // A save started elsewhere (the File menu, auto-save, Save All)
            // waits for the edits already received to be applied. It cannot
            // wait for one the page has not sent yet; Ctrl+S in the page does
            // not come through here at all but as an edit with `save`.
            vscode.workspace.onWillSaveTextDocument(e => {
                if (e.document.uri.toString() === this.document.uri.toString()) {
                    e.waitUntil(this.queue);
                }
            }),
            host.onDidChangeEngine(() => this.enqueue(() => this.post())),
        ];
        const key = document.uri.toString();
        sessions.set(key, this);
        this.pendingReveal = pendingReveals.get(key);
        pendingReveals.delete(key);
    }

    /**
     * Bring a link's fragment into view in this page: posted behind whatever
     * the queue holds, once the page has a document — at once when it has,
     * else right after the first document is posted (`post`).
     */
    reveal(reveal: Reveal): void {
        this.pendingReveal = reveal;
        this.enqueue(async () => {
            if (this.postedVersion >= 0 && !this.broken) {
                await this.postReveal();
            }
        });
    }

    private async postReveal(): Promise<void> {
        const reveal = this.pendingReveal;
        this.pendingReveal = undefined;
        if (reveal) {
            await this.webview.postMessage({ type: 'revealAnchor', anchor: reveal.anchor, line: reveal.line });
        }
    }

    /** Resolves when every message received so far has been handled. For tests. */
    settled(): Promise<void> {
        return Promise.all([this.queue, this.saving]).then(() => undefined);
    }

    dispose(): void {
        if (this.resyncTimer !== undefined) {
            clearTimeout(this.resyncTimer);
        }
        if (sessions.get(this.document.uri.toString()) === this) {
            sessions.delete(this.document.uri.toString());
        }
        this.subscriptions.forEach(d => d.dispose());
    }

    private enqueue(work: () => Promise<void>): void {
        this.queue = this.queue.then(work).catch(error => {
            this.host.log(`[ERROR] Visual Editor: ${message(error)}`);
        });
    }

    /**
     * The render environment. `currentDocument` is the file's uri, as VS Code
     * puts it in the preview's render env, so a plugin that asks which document
     * it renders — Req Explorer's, which treats only its own reading scheme as a
     * reading document — sees an ordinary file.
     */
    private env(): Environment {
        return { currentDocument: this.document.uri } as unknown as Environment;
    }

    private receive(msg: WebviewMessage): void {
        switch (msg.type) {
            case 'ready':
                this.enqueue(() => this.post());
                break;
            case 'edit':
                this.enqueue(() => this.applyEdit(msg.text, msg.baseVersion, msg.reparse === true));
                if (msg.save) {
                    // After the edit, but outside the queue: the save runs the
                    // will-save listener, which waits on the queue, and a save
                    // queued behind itself would wait for itself.
                    this.saving = this.queue.then(() => this.save()).catch(error => {
                        this.host.log(`[ERROR] Visual Editor: saving failed: ${message(error)}`);
                    });
                }
                break;
            case 'render':
                void this.render(msg.requestId, msg.src);
                break;
            case 'openSnippet':
                void this.openSnippet(msg.path);
                break;
            case 'openSource':
                void this.openSource(msg.line);
                break;
            case 'openLink':
                void this.openLink(msg.href);
                break;
            case 'refreshLenses':
                this.lenses.schedule();
                break;
            case 'runLens':
                // Behind the edit the page flushed before the click: a lens
                // whose command edits the file must not write over keystrokes
                // on their way. Started there, not waited for — a command
                // that saves would wait for the queue it is in.
                this.enqueue(async () => {
                    void this.lenses.run(msg.id);
                });
                break;
            case 'actionsFor':
                // In the queue, behind the edit the page sent before asking, so
                // the block is looked up in the text the page holds; the answer
                // itself is not waited for there, or a slow provider would hold
                // up the edits behind it.
                this.enqueue(async () => {
                    void this.codeActions.answer(msg.requestId, msg.blockIndex, msg.blocks);
                });
                break;
            case 'runAction':
                // In the queue, behind the edit the page flushed before the
                // click; `run` waits only for the action's own edit.
                this.enqueue(() => this.codeActions.run(msg.id));
                break;
            case 'pickInclude':
                // In the queue, behind the edit the page flushed before asking,
                // so a provider that reads the document reads the page's text;
                // the pick is not waited for there, or the person choosing
                // would hold up every edit behind it.
                this.enqueue(async () => {
                    void this.includes.answer(msg.requestId, msg.replace !== undefined);
                });
                break;
        }
    }

    /** A followed link: resolved against this document, opened by VS Code or the system. */
    private async openLink(href: string): Promise<void> {
        try {
            // Inside the try: a strict parse throws on an href such as
            // `http:////x`, which a raw HTML block can carry, and the call site
            // does not await this.
            const folder = vscode.workspace.getWorkspaceFolder(this.document.uri)?.uri;
            const target = resolveLinkTarget(href, this.document.uri, folder);
            if (target.kind === 'external') {
                await vscode.env.openExternal(target.uri);
            } else if (target.kind === 'open') {
                await this.openAt(target.uri);
            } else {
                this.host.log(`[WARN] Visual Editor: did not follow ${href}: ${target.reason}.`);
            }
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: opening ${href} failed: ${message(error)}`);
        }
    }

    /**
     * Open a file at the element its `#fragment` names, as the text editor's
     * own link handling lands on the heading. The fragment is resolved to a
     * line in the file's text (`fragmentLine`: a `{#id}`, a heading's slug, a
     * line fragment); the file opens with `vscode.open`, in whichever editor
     * VS Code chooses for it. In the text editor the line is revealed at the
     * top; in the Visual Editor its page is sent `revealAnchor`. A link to
     * this very document scrolls this page, and opens nothing. A fragment the
     * file does not have opens it at the top — not an error, the link may be
     * older than the heading it named.
     */
    private async openAt(uri: vscode.Uri): Promise<void> {
        const fragment = uri.fragment;
        const file = uri.with({ fragment: '' });
        if (fragment === '') {
            await vscode.commands.executeCommand('vscode.open', uri);
            return;
        }
        const self = file.toString() === this.document.uri.toString();
        let line: number | null = null;
        try {
            const document = self ? this.document : await vscode.workspace.openTextDocument(file);
            line = await this.lineOf(document, fragment);
        } catch {
            // Not a text file (an image, a folder): there is nothing to land on.
        }
        if (line === null) {
            this.host.log(`[INFO] Visual Editor: ${file.fsPath} has no #${fragment}; opened at the top.`);
        }
        if (self) {
            this.reveal({ anchor: fragment, line });
            return;
        }
        if (line === null) {
            await vscode.commands.executeCommand('vscode.open', file);
            return;
        }
        const at = new vscode.Range(line, 0, line, 0);
        await vscode.commands.executeCommand('vscode.open', file, { selection: at });
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (tab instanceof vscode.TabInputCustom && tab.viewType === VISUAL_EDITOR_VIEW_TYPE && tab.uri.toString() === file.toString()) {
            revealInVisualEditor(file, { anchor: fragment, line });
            return;
        }
        // The editor `vscode.open` showed; the active one may not be it yet when the call returns.
        const editor = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors]
            .find(e => e !== undefined && e.document.uri.toString() === file.toString());
        if (editor) {
            editor.selection = new vscode.Selection(at.start, at.start);
            editor.revealRange(at, vscode.TextEditorRevealType.AtTop);
        }
    }

    /** The line `fragment` names in `document`: headings only in Markdown, a line fragment in any text. */
    private async lineOf(document: vscode.TextDocument, fragment: string): Promise<number | null> {
        const anchors = document.languageId === 'markdown'
            ? headingAnchors(await this.host.engine(), document.getText(), { currentDocument: document.uri } as unknown as Environment)
            : [];
        const line = fragmentLine(anchors, fragment);
        return line === null ? null : Math.min(line, document.lineCount - 1);
    }

    /** Parse the document as it is now and hand it to the webview, or say why it cannot be shown. */
    private async post(): Promise<void> {
        let md: MarkdownIt;
        try {
            md = await this.host.engine();
        } catch (error) {
            this.fail(`The Markdown engine could not be built: ${message(error)}`);
            return;
        }
        // Before the text is read: nothing may be awaited between reading it and posting its parse.
        const includes = await this.includes.offered();
        // Read after the await, and parse synchronously, so the text posted is
        // the text of the version posted.
        const text = this.document.getText();
        const version = this.document.version;
        let json;
        try {
            const parsed = parseDocument(md, text, this.env());
            json = parsedDocumentToJSON(parsed);
            this.snippetPaths = collectSnippetPaths(json.doc);
        } catch (error) {
            this.fail(message(error));
            return;
        }
        this.broken = false;
        this.webviewText = text;
        this.postedVersion = version;
        await this.webview.postMessage({
            type: 'document',
            json,
            version,
            defaultWrap: Config.instance.editorWrapColumn(this.document.uri),
            includes,
        });
        // A link followed here before the page had the document lands now.
        await this.postReveal();
        this.lenses.schedule();
    }

    private fail(reason: string): void {
        this.broken = true;
        this.webviewText = undefined;
        this.host.log(`[WARN] Visual Editor: ${this.document.uri.toString()} stays in the text editor: ${reason}`);
        void this.webview.postMessage({ type: 'error', message: reason });
    }

    /**
     * Write an edit from the page. With `reparse` the page asked to see its own
     * text parsed again — it inserted a construct it can only show once the host
     * has classified and rendered it — so the document is posted after the edit
     * lands, although it equals what the page holds. A stale edit is dropped with
     * or without it: the document on its way is parsed afresh anyway.
     */
    private async applyEdit(text: string, baseVersion: number, reparse = false): Promise<void> {
        if (this.broken || baseVersion !== this.postedVersion) {
            // Broken: never write. Stale base: a newer document is on its way,
            // and the webview rebuilds from it.
            return;
        }
        const current = this.document.getText();
        if (current !== this.webviewText) {
            await this.post();
            return;
        }
        const replacement = minimalReplacement(current, text);
        if (replacement === null) {
            if (reparse) {
                await this.post();
            }
            return;
        }
        // Set before applying: the change event fires while the edit applies,
        // and must see its own text.
        this.webviewText = text;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            this.document.uri,
            new vscode.Range(this.document.positionAt(replacement.start), this.document.positionAt(replacement.end)),
            replacement.text,
        );
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied || this.document.getText() !== text || reparse) {
            // Refused, or VS Code normalized the inserted line endings: show the
            // person what the document now holds. Or the page asked to see it.
            await this.post();
            return;
        }
        // The lenses of the text the page now holds: a provider's lines moved with the edit.
        this.lenses.schedule();
        // And its code actions: those of a block the edit did not touch are
        // registered for the previous version, and may no longer be offered.
        this.codeActions.invalidate();
    }

    /**
     * The save the person asked for with Ctrl+S in the page, after the edit it
     * came with. A stale edit was dropped, and the document is saved as it
     * stands — which is what Ctrl+S in the text editor would have saved.
     */
    private async save(): Promise<void> {
        if (!this.document.isDirty) {
            return;
        }
        const saved = await this.document.save();
        if (!saved) {
            this.host.log(`[WARN] Visual Editor: saving ${this.document.uri.toString()} did not complete.`);
        }
    }

    private documentChanged(): void {
        if (this.document.getText() === this.webviewText) {
            return;
        }
        if (this.resyncTimer !== undefined) {
            clearTimeout(this.resyncTimer);
        }
        this.resyncTimer = setTimeout(() => {
            this.resyncTimer = undefined;
            this.enqueue(async () => {
                if (this.document.getText() !== this.webviewText) {
                    await this.post();
                }
            });
        }, RESYNC_DELAY_MS);
    }

    private async render(requestId: number, src: string): Promise<void> {
        let html: string;
        try {
            const md = await this.host.engine();
            html = md.render(src, this.env());
        } catch (error) {
            this.host.log(`[ERROR] Visual Editor: rendering a raw block failed: ${message(error)}`);
            html = `<pre>${escapeHtml(src)}</pre>`;
        }
        await this.webview.postMessage({ type: 'rendered', requestId, html });
    }

    private async openSnippet(path: string): Promise<void> {
        // The path comes back from the webview; open only one this document's
        // own expansions named, never an arbitrary file a page asked for.
        if (!this.snippetPaths.has(path)) {
            this.host.log(`[WARN] Visual Editor: refused to open ${path}, which no expansion in this document names.`);
            return;
        }
        await vscode.window.showTextDocument(vscode.Uri.file(path), { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }

    private async openSource(line: number): Promise<void> {
        const target = Math.max(0, Math.min(Math.floor(line), this.document.lineCount - 1));
        const position = new vscode.Position(target, 0);
        const editor = await vscode.window.showTextDocument(this.document, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: false,
            selection: new vscode.Range(position, position),
        });
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
}

/** The `path` of every resolved include expansion in a document's JSON. */
export function collectSnippetPaths(doc: Record<string, unknown>): Set<string> {
    const paths = new Set<string>();
    const content = (doc.content ?? []) as { type?: string; attrs?: { kind?: string; mark?: { path?: unknown } | null } }[];
    for (const node of content) {
        const path = node.attrs?.mark?.path;
        if (node.type === 'injected_block' && node.attrs?.kind === 'expansion' && typeof path === 'string') {
            paths.add(path);
        }
    }
    return paths;
}
