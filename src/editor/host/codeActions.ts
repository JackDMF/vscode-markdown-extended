import * as vscode from 'vscode';
import type { CodeActionItem } from '../protocol';
import { message } from './errors';
import { LineRange, SessionPort } from './lenses';

/** How many code actions VS Code resolves (their lazily computed edits) before handing them over. */
export const ACTION_RESOLVE_COUNT = 50;

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

    constructor(private readonly host: SessionPort) { }

    dispose(): void {
        this.actions.clear();
    }

    /** Answer `actionsFor`: never throws, and always answers, if only with nothing. */
    async answer(requestId: number, blockIndex: number, blocks: number): Promise<void> {
        let items: CodeActionItem[] = [];
        try {
            items = await this.actionsFor(requestId, blockIndex, blocks);
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the code actions could not be read: ${message(error)}`);
        }
        await this.host.post({ type: 'actions', requestId, blockIndex, items });
    }

    private async actionsFor(requestId: number, blockIndex: number, blocks: number): Promise<CodeActionItem[]> {
        const document = this.host.document;
        const version = document.version;
        const text = document.getText();
        if (!this.host.pageHolds(text)) {
            return [];
        }
        const ranges: LineRange[] = await this.host.lineRanges(text);
        const lines = ranges.length === blocks ? ranges[blockIndex] ?? null : null;
        if (lines === null || document.version !== version) {
            return [];
        }
        const found = await vscode.commands.executeCommand<AnyAction[]>(
            'vscode.executeCodeActionProvider', document.uri, rangeOfLines(document, lines), undefined, ACTION_RESOLVE_COUNT,
        ) ?? [];
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
        return items;
    }

    /** Apply a code action: its edit, then its command — the order VS Code applies them in. */
    async run(id: string): Promise<void> {
        const entry = this.actions.get(id);
        if (entry === undefined) {
            this.host.log(`[WARN] Visual Editor: the code action ${id} is no longer current; nothing was applied.`);
            return;
        }
        const action = entry.action;
        try {
            if (isCommand(action)) {
                await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
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
                await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
            }
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the code action "${action.title}" failed: ${message(error)}`);
        }
    }
}
