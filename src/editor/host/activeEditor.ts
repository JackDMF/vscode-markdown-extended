import * as vscode from 'vscode';

/**
 * Which Visual Editor has the focus, and where its caret is — what `activate`
 * hands other extensions as `visualEditor` (ARCHITECTURE.md, "The active
 * editor and its caret").
 *
 * Req Explorer is the first reader: a command it runs from the palette without
 * arguments takes the active document, and the requirement at the caret, from
 * `vscode.window.activeTextEditor` — which a custom editor is not. VS Code has
 * no API that says a custom editor is active and where its caret is, so the
 * extension that owns the editor says it: the panel's own `active` flag, and
 * the caret the page reports (`webview/caret.ts`), mapped to the document's
 * text by `positions.ts`.
 *
 * API 2 (4.12.0) adds what the Studienhilfe needs to write where a person
 * works in the Visual Editor: the selection, and `insertBlock`, which has the
 * page insert Markdown blocks as its own Insert menu would — undoable there,
 * with no keystroke lost — instead of another writer's `WorkspaceEdit`, which
 * the page's undo cannot take back (ARCHITECTURE.md, "Inserting blocks for
 * another extension"). Readers test for the member they need: API 1 has
 * neither, and no `version`.
 */

/** The level of the API `activate` exports: absent in 4.0–4.11 (level 1), 2 from 4.12.0. */
export const VISUAL_EDITOR_API_VERSION = 2;

/** The Visual Editor that has the focus: its document, and the caret's position in its text. */
export interface ActiveVisualEditor {
    uri: vscode.Uri;
    /**
     * 0-based line and UTF-16 character, as every `vscode.Position`;
     * `undefined` when the selection is in an atom (a source block, an
     * injected block, the front matter, a badge), is no caret (Ctrl+A, a gap
     * cursor), or maps only approximately, and while a change the page has
     * not seen is on its way to it.
     */
    caret: vscode.Position | undefined;
    /**
     * Since API 2 (4.12.0). The selection in the document's text when it is a
     * non-empty text selection whose both ends map exactly; `undefined` for an
     * empty selection (then `caret` says where it is) and wherever `caret` is
     * `undefined`. `selection.active` equals `caret`.
     */
    selection?: vscode.Selection;
}

/**
 * How `insertBlock` went. `inserted: true`: the document holds the blocks.
 * `inserted: false` means *not confirmed*: with every reason but
 * `unconfirmed` the blocks were not written (with `not-separate`, typing on
 * its way was); with `unconfirmed` nobody can say.
 */
export type InsertBlockResult =
    | { inserted: true }
    | { inserted: false; reason: InsertBlockRefusal };

/**
 * Why `insertBlock` reports no insertion. The blocks were not written for: no Visual
 * Editor open over the uri (`no-editor`, and always in the web build); it
 * shows the error state, no document yet, or would not take the block
 * (`error-state`); Markdown of whitespace only (`empty`); its page did not
 * answer within 2 s, so the request was withdrawn and the page confirmed it
 * wrote nothing (`timeout`); its panel closed before the page answered
 * (`closed`); the file changed elsewhere as the page's edit arrived, which was
 * dropped for it (`changed`); a source box (**Edit source**) holds text typed
 * and not yet applied, which is left as it is — the person applies or
 * cancels it, and the caller may ask again (`source-open`); the blocks would
 * not stand on their own in the file — a construct left open before their
 * place (a code fence, an HTML comment) would take them in, or one they leave
 * open would take in what follows — so the host wrote the edit without them,
 * typing that went with them kept (`not-separate`). Both were added after
 * 4.13.0.
 *
 * `unconfirmed` is the exception: the page gave no word at all within 30 s
 * (it is hung), and the blocks **may be in the document or not**. A caller
 * must not take it as "not inserted" — not insert the blocks a second time
 * elsewhere, but say that it is unknown and let the person look.
 *
 * Reasons may be added within API 2, as these two were: a caller takes one
 * it does not know as every reason but `unconfirmed` — the blocks were not
 * written.
 */
export type InsertBlockRefusal = 'no-editor' | 'error-state' | 'empty' | 'timeout' | 'closed' | 'changed' | 'source-open' | 'not-separate' | 'unconfirmed';

export interface InsertBlockOptions {
    /** Bring the Visual Editor to the front, the keyboard in its page. */
    focus?: boolean;
}

/** The API, exported by `activate` as `visualEditor`. */
export interface VisualEditorApi {
    /** API level: absent = 1 (4.0–4.11), 2 from 4.12.0. Readers test for the member they need. */
    readonly version?: number;
    /** The Visual Editor that has focus, if one does: its document uri, the caret's source position and, since API 2, the selection. */
    active(): ActiveVisualEditor | undefined;
    /** Fires when another Visual Editor (or none) takes the focus, and when the active one's caret or selection changes. */
    onDidChangeActive: vscode.Event<ActiveVisualEditor | undefined>;
    /**
     * Since API 2. Insert Markdown blocks into the Visual Editor over `uri`,
     * where its own Insert menu would put a block: after the top-level block the
     * page's selection ends in, never before the first block. The text is
     * written as given — line endings turned into the document's, line breaks
     * at its end dropped — a blank line before it, as one step of the page's
     * history (Ctrl+Z removes it), in the same edit as any typing still in the
     * page's delay, and parsed by the host with every markdown-it plugin —
     * written only where that parse reads them as blocks of their own, so
     * Ctrl+Z reaches them (else `not-separate`). Afterwards the caret is right after the inserted blocks and they are
     * scrolled into view. With `focus`, the panel is revealed and the page
     * takes the keyboard. Works on a Visual Editor in a background tab too.
     * Requests to one editor are taken one after the other. Resolves once the
     * document holds the blocks, or with the reason it does not — or, with
     * `unconfirmed`, that it cannot say.
     */
    insertBlock(uri: vscode.Uri, markdown: string, options?: InsertBlockOptions): Promise<InsertBlockResult>;
}

/** Who inserts for `insertBlock`: the open sessions (`session.ts`, `insertBlockIn`); without them — the web build — none is open. */
export type BlockInserter = (uri: vscode.Uri, markdown: string, options?: InsertBlockOptions) => Promise<InsertBlockResult>;

const NO_EDITOR: BlockInserter = () => Promise.resolve({ inserted: false, reason: 'no-editor' });

/** The part of a `vscode.WebviewPanel` the tracker reads. */
export interface TrackedPanel {
    readonly active: boolean;
    readonly onDidChangeViewState: vscode.Event<unknown>;
}

/** The part of a `VisualEditorSession` the tracker reads. */
export interface TrackedEditor {
    readonly uri: vscode.Uri;
    readonly caret: vscode.Position | undefined;
    /** The non-empty selection, when the page reported one that maps exactly. */
    readonly selection?: vscode.Selection;
    readonly onDidChangeCaret: vscode.Event<unknown>;
}

/**
 * Follows every open Visual Editor's panel: the one whose panel is `active` is
 * the active editor, until its panel stops being active or is closed.
 */
export class ActiveVisualEditorTracker implements vscode.Disposable {
    private current: { panel: TrackedPanel; editor: TrackedEditor } | undefined;
    private readonly changed = new vscode.EventEmitter<ActiveVisualEditor | undefined>();
    readonly onDidChangeActive = this.changed.event;
    /** What other extensions get: the API's members, and nothing of the tracker. */
    readonly api: VisualEditorApi;

    /** `inserter` writes for `insertBlock`: the sessions' `insertBlockIn` on the desktop; the web build, with no editor, leaves it out. */
    constructor(inserter: BlockInserter = NO_EDITOR) {
        this.api = {
            version: VISUAL_EDITOR_API_VERSION,
            active: () => this.active(),
            onDidChangeActive: this.onDidChangeActive,
            // A caller's mistake (no uri) is answered as no editor over it, never thrown.
            insertBlock: (uri, markdown, options) => (uri === undefined || uri === null
                ? Promise.resolve({ inserted: false, reason: 'no-editor' })
                : inserter(uri, markdown, options)),
        };
    }

    active(): ActiveVisualEditor | undefined {
        if (this.current === undefined) {
            return undefined;
        }
        const { uri, caret, selection } = this.current.editor;
        return selection === undefined ? { uri, caret } : { uri, caret, selection };
    }

    /** Follow one editor's panel; dispose the result when the panel is closed. */
    track(panel: TrackedPanel, editor: TrackedEditor): vscode.Disposable {
        const listeners = [
            panel.onDidChangeViewState(() => this.viewStateChanged(panel, editor)),
            editor.onDidChangeCaret(() => {
                if (this.current?.editor === editor) {
                    this.fire();
                }
            }),
        ];
        this.viewStateChanged(panel, editor);
        return {
            dispose: () => {
                listeners.forEach(l => l.dispose());
                if (this.current?.panel === panel) {
                    this.current = undefined;
                    this.fire();
                }
            },
        };
    }

    dispose(): void {
        this.current = undefined;
        this.changed.dispose();
    }

    private viewStateChanged(panel: TrackedPanel, editor: TrackedEditor): void {
        if (panel.active) {
            if (this.current?.panel !== panel) {
                this.current = { panel, editor };
                this.fire();
            }
        } else if (this.current?.panel === panel) {
            this.current = undefined;
            this.fire();
        }
    }

    private fire(): void {
        this.changed.fire(this.active());
    }
}
