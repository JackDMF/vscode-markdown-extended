import type { SourcePosition } from '../positions';
import type { WebviewMessage } from '../protocol';

/** How long the selection is left to settle before its caret is reported. */
export const CARET_DELAY_MS = 100;

/** What the reporter needs from the page, injected so a test can drive it without one. */
export interface CaretPort {
    /** The version of the document the page shows, `undefined` without one (the error state). */
    version(): number | undefined;
    /** Whether an edit is waiting in the delay, or a save is committing its source boxes. */
    editPending(): boolean;
    /** The text the host holds for the page: the one it sent, or the last one sent to it. */
    hostText(): string | undefined;
    /** The page's text now and the caret in it (`caretOf`), or `undefined` without a document. */
    measure(): { text: string; caret: SourcePosition | null } | undefined;
    post(message: Extract<WebviewMessage, { type: 'caret' }>): void;
}

/**
 * The caret's source position, reported to the host as the selection moves.
 *
 * A caret is a position in a text, and it is only worth anything in the text
 * the host holds: the host reads it against the document, and another
 * extension against `vscode.TextDocument` positions. So a report waits, as the
 * code-action question does, while the page holds a text the host has not
 * got — an edit in the delay, a save committing — and goes right after the
 * edit that carries it (`editSent`); the host drops one whose `baseVersion` is
 * not the document it last posted or that arrives while the document holds
 * another text, so a stale caret is never taken. Reports are debounced
 * (`CARET_DELAY_MS`) and sent only when the answer changed; a new document
 * from the host makes the last one stale, and it is reported again.
 */
export class CaretReporter {
    private timer: ReturnType<typeof setTimeout> | undefined;
    /** A report held back for the pending edit. */
    private waiting = false;
    /** What was last reported, as `version:line:character` (or `version:none`). */
    private last: string | undefined;

    constructor(private readonly port: CaretPort, private readonly delayMs = CARET_DELAY_MS) { }

    /** The selection or the document changed: report the caret once it settles. */
    selectionMoved(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.report();
        }, this.delayMs);
    }

    /** The page's pending edit was sent (or found unchanged): a report held back for it goes now. */
    editSent(): void {
        if (this.waiting) {
            this.waiting = false;
            this.report();
        }
    }

    /** A document from the host: what was reported is stale, and the caret is reported afresh. */
    documentShown(): void {
        this.last = undefined;
        this.waiting = false;
        this.selectionMoved();
    }

    dispose(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.waiting = false;
    }

    private report(): void {
        const version = this.port.version();
        if (version === undefined) {
            return;
        }
        if (this.port.editPending()) {
            this.waiting = true;
            return;
        }
        const measured = this.port.measure();
        if (measured === undefined) {
            return;
        }
        if (measured.text !== this.port.hostText()) {
            // A change this very transaction made, not yet scheduled as an edit.
            this.waiting = true;
            return;
        }
        const { caret } = measured;
        const key = caret === null ? `${version}:none` : `${version}:${caret.line}:${caret.character}`;
        if (key === this.last) {
            return;
        }
        this.last = key;
        this.port.post({ type: 'caret', baseVersion: version, position: caret });
    }
}
