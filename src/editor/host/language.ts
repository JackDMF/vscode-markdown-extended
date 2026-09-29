import * as vscode from 'vscode';
import type { HostMessage, WebviewMessage } from '../protocol';
import { CompletionController } from './completion';
import { DiagnosticsController } from './diagnostics';
import { message } from './errors';
import { HoverController } from './hover';
import type { SessionPort } from './lenses';

/** What completion, diagnostics and hover need from the session around them. */
export interface LanguageHost {
    port: SessionPort;
    /** The version of the document the session last posted to the page: a request's `baseVersion` must be it. */
    postedVersion(): number;
    /** Run `work` in the session's queue, behind the edits the page sent before. */
    enqueue(work: () => Promise<void>): void;
    /** Post the document to the page now, from inside the queue (after a completion's edit). */
    repost(): Promise<void>;
    /** `vscode.commands.executeCommand`, unless a test answers for VS Code. */
    execute<T>(command: string, ...args: unknown[]): Thenable<T>;
    /** `vscode.languages.getDiagnostics`, unless a test answers. */
    diagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[];
    onDidChangeDiagnostics: vscode.Event<vscode.DiagnosticChangeEvent>;
    /** Post, never throwing: the page may be gone by the time an answer is ready. */
    send(msg: HostMessage): Promise<void>;
}

/**
 * The host's half of completion, diagnostics and hover in the page
 * (ARCHITECTURE.md, *Completion, diagnostics and hover*). As with lenses and
 * code actions, no API between the extensions: VS Code is asked, and runs the
 * providers every extension registered for the document. Every request comes
 * with the version of the document the page shows and is answered from the
 * session's queue, behind the edit the page sent before asking, so a position
 * is read in the text the host holds; an answer computed while the document
 * changed is empty. A listener on the page's messages beside the session's
 * own, as links and images are.
 */
export class LanguageFeatures implements vscode.Disposable {
    private readonly completion: CompletionController;
    private readonly hover: HoverController;
    private readonly diagnostics: DiagnosticsController;

    constructor(private readonly host: LanguageHost) {
        this.completion = new CompletionController(host);
        this.hover = new HoverController(host);
        this.diagnostics = new DiagnosticsController(host);
    }

    dispose(): void {
        this.diagnostics.dispose();
    }

    /** The session posted a document: the page's diagnostics are drawn afresh on it. */
    documentPosted(): void {
        this.diagnostics.schedule();
    }

    receive(msg: WebviewMessage): void {
        switch (msg.type) {
            case 'complete':
                // In the queue, behind the edit the page flushed before asking;
                // the providers are not waited for there.
                this.host.enqueue(async () => {
                    void this.completion.answer(msg.requestId, msg.baseVersion, msg.position, msg.triggerCharacter);
                });
                break;
            case 'applyCompletion':
                // In the queue and waited for: the edit goes before any the page sends after it.
                this.host.enqueue(() => this.completion.apply(msg.requestId, msg.index, msg.baseVersion, msg.position));
                break;
            case 'hover':
                this.host.enqueue(async () => {
                    void this.hover.answer(msg.requestId, msg.baseVersion, msg.position);
                });
                break;
            case 'runHoverCommand':
                // Behind the edits the page sent before the click, as a lens's command runs.
                this.host.enqueue(async () => this.hover.run(msg.id));
                break;
            case 'showHoverInEditor':
                void this.hover.showInEditor(msg.requestId);
                break;
            case 'showProblems':
                void Promise.resolve(this.host.execute('workbench.actions.view.problems')).catch(error => {
                    this.host.port.log(`[WARN] Visual Editor: the Problems view could not be shown: ${message(error)}`);
                });
                break;
        }
    }
}
