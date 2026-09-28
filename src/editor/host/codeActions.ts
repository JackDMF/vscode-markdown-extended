import * as vscode from 'vscode';
import type { CodeActionItem, HostMessage } from '../protocol';
import { message } from './errors';
import { LineRange, SessionPort } from './lenses';

/** How many code actions VS Code resolves (their lazily computed edits) before handing them over. */
export const ACTION_RESOLVE_COUNT = 50;

/** How long a burst of reasons to invalidate the page's answers is left to settle. */
const INVALIDATE_DELAY_MS = 100;

type AnyAction = vscode.CodeAction | vscode.Command;

function isCommand(action: AnyAction): action is vscode.Command {
    return typeof (action as vscode.Command).command === 'string';
}

/** VS Code's "Surround With" snippets: offered for any text selection, from every extension's snippet files. */
const SURROUND = vscode.CodeActionKind.Refactor.append('surround');

/** Commands that act on the active text editor, of which the Visual Editor is none: "More…" of Surround With, inline chat. */
const TEXT_EDITOR_COMMAND = /^(editor\.action\.|inlineChat\.)/;

/**
 * Whether an action belongs on a block's bar. Not a source action
 * (`source.organizeImports`, `source.fixAll`): those act on the whole file, and
 * the text editor keeps them out of the light bulb too, in the Source Action
 * menu. Not VS Code's snippet surround actions: they wrap a text selection, and
 * in the Visual Editor a block is wrapped from its own toolbar — asked for a
 * block's whole range, VS Code offers every snippet of every extension that
 * takes the selected text, on every block. And not an action whose command
 * works on the active text editor, since there is none while this one has the
 * focus: it would run against nothing, or against whatever text editor last had it.
 */
export function belongsOnBlock(action: AnyAction): boolean {
    const kind = isCommand(action) ? undefined : action.kind;
    if (kind !== undefined && (vscode.CodeActionKind.Source.contains(kind) || SURROUND.contains(kind))) {
        return false;
    }
    const command = isCommand(action) ? action.command : action.command?.command;
    return command === undefined || !TEXT_EDITOR_COMMAND.test(command);
}

/** The range of the file a block's lines `[start, end)` cover: from its first line's start to its last line's end. */
export function rangeOfLines(document: vscode.TextDocument, range: readonly [number, number]): vscode.Range {
    const last = Math.max(range[0], Math.min(range[1], document.lineCount) - 1);
    return new vscode.Range(range[0], 0, last, document.lineAt(last).text.length);
}

/**
 * The code actions other extensions offer for a top-level block, for the
 * object toolbar to draw as verbs after the block's own.
 *
 * As with the lenses, no new API between the extensions: VS Code is asked
 * (`vscode.executeCodeActionProvider`) for the actions on the block's lines —
 * the quick fixes for the diagnostics there and the refactorings, what the
 * light bulb would offer with those lines selected. The actions stay here, in
 * a registry of the document version they were asked for; the page gets titles,
 * kinds and ids. Running one applies its `WorkspaceEdit` through
 * `vscode.workspace.applyEdit`, which reaches the page as any other writer's
 * change does, and then runs its command.
 *
 * The block is named by its index in the page's document, which the host maps
 * to lines through its own parse of the same text (`blockLineRanges`). The
 * page sends its pending edit before asking, and the request is answered from
 * the session's queue after that edit, so the parse is of the page's text; when
 * it is not — another writer's change is on its way — the answer is empty.
 */
export class CodeActionController implements vscode.Disposable {
    private readonly actions = new Map<string, { version: number; action: AnyAction }>();
    private invalidateTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;
    private readonly subscriptions: vscode.Disposable[];

    constructor(private readonly host: SessionPort) {
        this.subscriptions = [
            // A quick fix is offered for a diagnostic: when the diagnostics
            // change, so may the actions — also of a block nobody edited.
            vscode.languages.onDidChangeDiagnostics(e => {
                const uri = this.host.document.uri.toString();
                if (e.uris.some(u => u.toString() === uri)) {
                    this.invalidate();
                }
            }),
        ];
    }

    dispose(): void {
        this.disposed = true;
        if (this.invalidateTimer !== undefined) {
            clearTimeout(this.invalidateTimer);
        }
        this.actions.clear();
        this.subscriptions.forEach(d => d.dispose());
    }

    /**
     * Tell the page that every answer it holds may be out of date, once a burst
     * of reasons has settled: after an applied edit, a change of the document's
     * diagnostics, an answer computed against a text that changed meanwhile.
     */
    invalidate(): void {
        if (this.disposed) {
            return;
        }
        if (this.invalidateTimer !== undefined) {
            clearTimeout(this.invalidateTimer);
        }
        this.invalidateTimer = setTimeout(() => {
            this.invalidateTimer = undefined;
            this.send({ type: 'invalidateActions' });
        }, INVALIDATE_DELAY_MS);
    }

    /** Post, never throwing: the page may be gone (the webview disposed) by the time an answer is ready. */
    private async send(msg: HostMessage): Promise<void> {
        try {
            await this.host.post(msg);
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the code actions could not be sent to the page: ${message(error)}`);
        }
    }

    /** Answer `actionsFor`: never throws, and always answers, if only with nothing. */
    async answer(requestId: number, blockIndex: number, blocks: number): Promise<void> {
        let items: CodeActionItem[] = [];
        let stale = false;
        try {
            const result = await this.actionsFor(requestId, blockIndex, blocks);
            items = result.items;
            stale = result.stale;
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the code actions could not be read: ${message(error)}`);
        }
        await this.send({ type: 'actions', requestId, blockIndex, items });
        if (stale) {
            // Asked about a text that changed while VS Code computed: the page asks again.
            this.invalidate();
        }
    }

    /** Whether the page holds the document as it is now, so an action registered for `version` edits the text it was computed on. */
    private current(version: number): boolean {
        const document = this.host.document;
        return document.version === version && this.host.pageHolds(document.getText());
    }

    private async actionsFor(requestId: number, blockIndex: number, blocks: number): Promise<{ items: CodeActionItem[]; stale: boolean }> {
        const document = this.host.document;
        const version = document.version;
        const text = document.getText();
        if (!this.host.pageHolds(text)) {
            return { items: [], stale: false };
        }
        const ranges: LineRange[] = await this.host.lineRanges(text);
        const lines = ranges.length === blocks ? ranges[blockIndex] ?? null : null;
        if (lines === null) {
            return { items: [], stale: false };
        }
        if (!this.current(version)) {
            return { items: [], stale: true };
        }
        const found = await vscode.commands.executeCommand<AnyAction[]>(
            'vscode.executeCodeActionProvider', document.uri, rangeOfLines(document, lines), undefined, ACTION_RESOLVE_COUNT,
        ) ?? [];
        // Checked after the await, not before: an edit that landed while the
        // providers computed has moved the text their edits' offsets point into.
        if (!this.current(version)) {
            return { items: [], stale: true };
        }
        // Actions of an older version edit text that is no longer there.
        for (const [id, entry] of this.actions) {
            if (entry.version !== version) {
                this.actions.delete(id);
            }
        }
        const items: CodeActionItem[] = [];
        found.filter(belongsOnBlock).forEach((action, k) => {
            const id = `${requestId}.${k}`;
            this.actions.set(id, { version, action });
            const item: CodeActionItem = { id, title: action.title, kind: isCommand(action) ? '' : action.kind?.value ?? '' };
            if (!isCommand(action) && action.disabled) {
                item.refusal = action.disabled.reason;
            }
            items.push(item);
        });
        return { items, stale: false };
    }

    /**
     * Apply a code action: its edit, then its command — the order VS Code
     * applies them in. The session runs this in its queue, behind every edit
     * the page sent before the click, so it never writes over keystrokes on
     * their way.
     *
     * An action is applied only to the text it was computed on: its edit holds
     * offsets into that text, and a `Command` in its place may hold ranges.
     * When the document moved on since — the page's own edit ahead of the click
     * is the usual case — nothing is applied, and the page is told to ask again
     * and say why. The action's command is started, not waited for: a command
     * that saves the document would wait for the session's queue, which would
     * be waiting for the command.
     */
    async run(id: string): Promise<void> {
        const entry = this.actions.get(id);
        if (entry === undefined) {
            this.host.log(`[WARN] Visual Editor: the code action ${id} is no longer current; nothing was applied.`);
            return;
        }
        const action = entry.action;
        if (!this.current(entry.version)) {
            this.actions.delete(id);
            this.host.log(`[WARN] Visual Editor: "${action.title}" was offered for version ${entry.version}, the document is at ${this.host.document.version}; nothing was applied.`);
            await this.send({ type: 'invalidateActions', refused: action.title });
            return;
        }
        const start = (command: string, args: readonly unknown[] | undefined) => {
            void Promise.resolve(vscode.commands.executeCommand(command, ...(args ?? []))).catch(error => {
                this.host.log(`[WARN] Visual Editor: the code action "${action.title}" failed: ${message(error)}`);
            });
        };
        try {
            if (isCommand(action)) {
                start(action.command, action.arguments);
                return;
            }
            if (action.disabled) {
                return;
            }
            if (action.edit && !(await vscode.workspace.applyEdit(action.edit))) {
                this.host.log(`[WARN] Visual Editor: the edit of "${action.title}" was not applied.`);
                return;
            }
            if (action.command) {
                start(action.command.command, action.command.arguments);
            }
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the code action "${action.title}" failed: ${message(error)}`);
        }
    }
}
