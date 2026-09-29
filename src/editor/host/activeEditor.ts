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
 */

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
}

/** The API, exported by `activate` as `visualEditor`. */
export interface VisualEditorApi {
    /** The Visual Editor that has focus, if one does: its document uri and the caret's source position. */
    active(): ActiveVisualEditor | undefined;
    /** Fires when another Visual Editor (or none) takes the focus, and when the active one's caret changes. */
    onDidChangeActive: vscode.Event<ActiveVisualEditor | undefined>;
}

/** The part of a `vscode.WebviewPanel` the tracker reads. */
export interface TrackedPanel {
    readonly active: boolean;
    readonly onDidChangeViewState: vscode.Event<unknown>;
}

/** The part of a `VisualEditorSession` the tracker reads. */
export interface TrackedEditor {
    readonly uri: vscode.Uri;
    readonly caret: vscode.Position | undefined;
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
    /** What other extensions get: the two members, and nothing of the tracker. */
    readonly api: VisualEditorApi = {
        active: () => this.active(),
        onDidChangeActive: this.onDidChangeActive,
    };

    active(): ActiveVisualEditor | undefined {
        return this.current === undefined ? undefined : { uri: this.current.editor.uri, caret: this.current.editor.caret };
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
