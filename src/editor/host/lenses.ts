import * as vscode from 'vscode';
import { Config } from '../../services/common/config';
import type { HostMessage, LensHint, LensItem, LensRow, LensSurface } from '../protocol';
import { message } from './errors';

/** How long a burst of edits is left to settle before VS Code is asked for the lenses again. */
export const LENS_REFRESH_DELAY_MS = 300;

/**
 * How many lenses VS Code resolves before handing them over. The text editor
 * resolves the ones in view as they scroll in; the page has no viewport VS Code
 * knows of, so it asks for every lens resolved — enough for the largest
 * requirement document, where Req Explorer puts up to eight on a heading.
 */
export const LENS_RESOLVE_COUNT = 500;

/** A top-level block's source lines `[start, end)`, `null` for one that stands for none. */
export type LineRange = readonly [number, number] | null;

/**
 * The top-level block a lens on `line` belongs to: the block whose lines cover
 * it — a front-matter line is the front matter's — else, for a line no block
 * covers (a blank line between blocks, one before the first), the next block;
 * after the last block (the blank lines of the tail), the last block that has
 * lines. `null` only for a document without one. Blocks that stand for no
 * lines (generated content) are never chosen.
 */
export function blockIndexForLine(ranges: readonly LineRange[], line: number): number | null {
    let last: number | null = null;
    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        if (range === null) {
            continue;
        }
        if (line < range[1]) {
            // The first block ending after the line: it covers the line, or is the next one.
            return i;
        }
        last = i;
    }
    return last;
}

const SURFACES: ReadonlySet<string> = new Set<LensSurface>(['status', 'priority', 'links', 'action']);

/**
 * The surface a lens names for itself: the last of its command's arguments,
 * when that is an object of the `LensHint` shape — a known surface and an
 * artifact id; `relation` only when it is a string. Anything else, and a lens
 * with no arguments, names none: it is a foreign lens, drawn as the text
 * editor draws it. The shape is checked, not assumed — the argument is the
 * provider's own and may be anything.
 */
export function lensHintOf(command: vscode.Command): LensHint['reqExplorer'] | undefined {
    const args = command.arguments;
    const last: unknown = args && args.length > 0 ? args[args.length - 1] : undefined;
    if (typeof last !== 'object' || last === null) {
        return undefined;
    }
    const hint = (last as { reqExplorer?: unknown }).reqExplorer;
    if (typeof hint !== 'object' || hint === null) {
        return undefined;
    }
    const { surface, artifact, relation } = hint as { surface?: unknown; artifact?: unknown; relation?: unknown };
    if (typeof surface !== 'string' || !SURFACES.has(surface) || typeof artifact !== 'string' || artifact === '') {
        return undefined;
    }
    return {
        surface: surface as LensSurface,
        artifact,
        ...(typeof relation === 'string' && relation !== '' ? { relation } : {}),
    };
}

/**
 * The rows the page draws, and the commands their ids stand for. Lenses are
 * ordered by where they stand (line, then column; a provider's own order among
 * equals) and grouped by block. A lens VS Code could not resolve has no
 * command and nothing to show, as in the text editor; one whose command has no
 * command id is a title only, drawn as text. A lens naming its surface
 * (`lensHintOf`) carries it to the page, which places it there; its command is
 * kept whole, the hint among its arguments.
 */
export function lensRows(lenses: readonly vscode.CodeLens[], ranges: readonly LineRange[], idPrefix: string): { rows: LensRow[]; commands: Map<string, vscode.Command> } {
    const commands = new Map<string, vscode.Command>();
    const byBlock = new Map<number, LensItem[]>();
    const ordered = lenses
        .map((lens, k) => ({ lens, k }))
        .filter(({ lens }) => lens.command !== undefined && lens.command.title !== '')
        .sort((a, b) => a.lens.range.start.line - b.lens.range.start.line
            || a.lens.range.start.character - b.lens.range.start.character
            || a.k - b.k);
    for (const { lens } of ordered) {
        const command = lens.command as vscode.Command;
        const blockIndex = blockIndexForLine(ranges, lens.range.start.line);
        if (blockIndex === null) {
            continue;
        }
        const item: LensItem = { title: command.title };
        if (command.tooltip) {
            item.tooltip = command.tooltip;
        }
        const hint = lensHintOf(command);
        if (hint) {
            item.surface = hint.surface;
            item.artifact = hint.artifact;
            if (hint.relation !== undefined) {
                item.relation = hint.relation;
            }
        }
        if (command.command) {
            item.id = `${idPrefix}.${commands.size}`;
            commands.set(item.id, command);
        }
        const items = byBlock.get(blockIndex) ?? [];
        items.push(item);
        byBlock.set(blockIndex, items);
    }
    const rows = [...byBlock.entries()].sort(([a], [b]) => a - b).map(([blockIndex, items]) => ({ blockIndex, items }));
    return { rows, commands };
}

/** Whether lenses are drawn for this document: this extension's setting and VS Code's own `editor.codeLens`. */
export function lensesEnabled(uri: vscode.Uri): boolean {
    const editor = vscode.workspace.getConfiguration('editor', { uri, languageId: 'markdown' }).get<boolean>('codeLens', true);
    return editor !== false && Config.instance.editorCodeLenses(uri);
}

/** What the lens rows and the code actions (`codeActions.ts`) need from the session. */
export interface SessionPort {
    readonly document: vscode.TextDocument;
    /** Whether the page holds `text`: the text the session last posted to it or applied for it, and not the error state. */
    pageHolds(text: string): boolean;
    /** The source lines of each top-level block of `text`, as the session's engine groups them (`blockLineRanges`). */
    lineRanges(text: string): Promise<LineRange[]>;
    post(message: HostMessage): Thenable<boolean>;
    log(line: string): void;
}

/**
 * Every other extension's code lenses, for the page to draw above the blocks
 * they belong to.
 *
 * No new API between the extensions: VS Code is asked for the lenses of the
 * document (`vscode.executeCodeLensProvider`), which runs every registered
 * provider and resolves them — the same lenses the text editor shows. Their
 * commands stay here, in a registry that is replaced on each refresh: an
 * argument may be a `Uri` or any object the provider made, and what crosses to
 * the page is a title, an id and — for a lens that names one — its surface. A
 * `runLens` naming an id of an earlier refresh
 * is refused and logged; the row it came from is on its way out.
 *
 * Rows are posted only for a text the page holds, and dropped when the document
 * changed while VS Code was computing them or a newer refresh started: the
 * change that intervened schedules its own.
 */
export class LensController implements vscode.Disposable {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private generation = 0;
    private commands = new Map<string, vscode.Command>();
    /** Whether the page was last sent rows, so turning the setting off clears them once. */
    private shown = false;
    private disposed = false;
    private readonly subscriptions: vscode.Disposable[];

    constructor(private readonly host: SessionPort) {
        this.subscriptions = [
            vscode.workspace.onDidChangeConfiguration(e => {
                const uri = this.host.document.uri;
                if (e.affectsConfiguration('markdownExtended.editor.codeLenses', uri) || e.affectsConfiguration('editor.codeLens', uri)) {
                    this.schedule();
                }
            }),
        ];
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.commands.clear();
        this.subscriptions.forEach(d => d.dispose());
    }

    /** Refresh once a burst of calls has settled. */
    schedule(): void {
        if (this.disposed) {
            return;
        }
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh().catch(error => this.host.log(`[WARN] Visual Editor: the code lenses could not be read: ${message(error)}`));
        }, LENS_REFRESH_DELAY_MS);
    }

    /** Run a lens's command with its own arguments, as a click on it in the text editor does. */
    async run(id: string): Promise<void> {
        const command = this.commands.get(id);
        if (command === undefined) {
            this.host.log(`[WARN] Visual Editor: the code lens ${id} is no longer current; nothing was run.`);
            return;
        }
        try {
            await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
        } catch (error) {
            this.host.log(`[WARN] Visual Editor: the code lens "${command.title}" (${command.command}) failed: ${message(error)}`);
        }
    }

    private async refresh(): Promise<void> {
        const seq = ++this.generation;
        const document = this.host.document;
        const version = document.version;
        const text = document.getText();
        const current = () => !this.disposed && seq === this.generation && document.version === version && this.host.pageHolds(text);
        if (!this.host.pageHolds(text)) {
            // The page is about to receive another text; that post schedules the next refresh.
            return;
        }
        if (!lensesEnabled(document.uri)) {
            this.commands.clear();
            if (this.shown) {
                this.shown = false;
                await this.host.post({ type: 'lenses', version, blocks: 0, rows: [] });
            }
            return;
        }
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
            'vscode.executeCodeLensProvider', document.uri, LENS_RESOLVE_COUNT,
        ) ?? [];
        if (!current()) {
            return;
        }
        const ranges = await this.host.lineRanges(text);
        if (!current()) {
            return;
        }
        const { rows, commands } = lensRows(lenses, ranges, String(seq));
        this.commands = commands;
        this.shown = rows.length > 0;
        await this.host.post({ type: 'lenses', version, blocks: ranges.length, rows });
    }
}
