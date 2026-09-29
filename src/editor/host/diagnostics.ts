import * as vscode from 'vscode';
import type { DiagnosticEntry, DiagnosticSeverityName } from '../protocol';
import { message } from './errors';
import type { LanguageHost } from './language';

/** How long a burst of diagnostic changes is left to settle before the page is sent them. */
export const DIAGNOSTICS_DELAY_MS = 150;

const SEVERITIES: readonly DiagnosticSeverityName[] = ['error', 'warning', 'info', 'hint'];

function codeOf(code: vscode.Diagnostic['code']): string | undefined {
    if (code === undefined || code === null) {
        return undefined;
    }
    const value = typeof code === 'object' ? code.value : code;
    return String(value);
}

/** The diagnostics as the page draws them, in the order of their ranges. */
export function diagnosticEntries(diagnostics: readonly vscode.Diagnostic[]): DiagnosticEntry[] {
    return [...diagnostics]
        .sort((a, b) => a.range.start.compareTo(b.range.start) || a.range.end.compareTo(b.range.end))
        .map(d => {
            const entry: DiagnosticEntry = {
                range: {
                    start: { line: d.range.start.line, character: d.range.start.character },
                    end: { line: d.range.end.line, character: d.range.end.character },
                },
                severity: SEVERITIES[d.severity] ?? 'error',
                message: d.message,
            };
            const code = codeOf(d.code);
            if (code !== undefined && code !== '') {
                entry.code = code;
            }
            if (d.source) {
                entry.source = d.source;
            }
            return entry;
        });
}

/**
 * The document's diagnostics for the page to draw (ARCHITECTURE.md,
 * *Completion, diagnostics and hover*): read from where they are true —
 * `languages.getDiagnostics(uri)`, what the text editor and the Problems view
 * show — when they change (debounced), after every document the session
 * posts and after every edit of the page's it applies. Sent only while the
 * page holds the document's text: a change on its way to the page is followed
 * by a document, which schedules a send of its own.
 */
export class DiagnosticsController implements vscode.Disposable {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    private readonly subscription: vscode.Disposable;

    constructor(private readonly host: LanguageHost) {
        this.subscription = host.onDidChangeDiagnostics(e => {
            const uri = this.host.port.document.uri.toString();
            if (e.uris.some(u => u.toString() === uri)) {
                this.schedule();
            }
        });
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.subscription.dispose();
    }

    schedule(): void {
        if (this.disposed) {
            return;
        }
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.host.enqueue(() => this.send());
        }, DIAGNOSTICS_DELAY_MS);
    }

    /** In the session's queue, behind the edits the page sent before. */
    private async send(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const document = this.host.port.document;
        if (!this.host.port.pageHolds(document.getText())) {
            return;
        }
        let items: DiagnosticEntry[];
        try {
            items = diagnosticEntries(this.host.diagnostics(document.uri));
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the diagnostics could not be read: ${message(error)}`);
            return;
        }
        await this.host.send({ type: 'diagnostics', version: this.host.postedVersion(), items });
    }
}
