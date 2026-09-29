import * as vscode from 'vscode';
import type { SourcePosition, SourceRange } from '../positions';
import type { CompletionEntry } from '../protocol';
import { message } from './errors';
import type { LanguageHost } from './language';
import { minimalReplacement } from './minimalEdit';

/** How many completions the page is sent: the list shows eight rows and filters as the person types. */
export const COMPLETION_CAP = 100;

/** How many items VS Code resolves (their lazily computed detail) before handing them over. */
export const COMPLETION_RESOLVE_COUNT = 20;

/** Commands that act on the active text editor (re-trigger suggest, parameter hints), of which the Visual Editor is none. */
const TEXT_EDITOR_COMMAND = /^(editor\.action\.|editor\.|inlineChat\.)/;

/**
 * A snippet (`SnippetString.value`, TextMate syntax) as the text it inserts
 * with nothing typed into its placeholders: a tab stop is nothing, a
 * placeholder its default, a choice its first option, a variable its default
 * or nothing, `\$`, `\}` and `\\` the character. `cursor` is where the final
 * tab stop (`$0`) stands in the text, the end when it has none — where VS
 * Code's own editor leaves the caret once the snippet's stops are passed.
 */
export function snippetText(snippet: string): { text: string; cursor: number } {
    let i = 0;
    let cursor = -1;
    let out = '';

    const digits = (): string => {
        const start = i;
        while (i < snippet.length && snippet[i] >= '0' && snippet[i] <= '9') {
            i++;
        }
        return snippet.slice(start, i);
    };
    const name = (): string => {
        const m = /^[_a-zA-Z][_a-zA-Z0-9]*/.exec(snippet.slice(i));
        if (!m) {
            return '';
        }
        i += m[0].length;
        return m[0];
    };
    /** Text up to an unescaped `until` (not consumed), placeholders inside expanded. */
    const body = (until: string | null): string => {
        let text = '';
        while (i < snippet.length) {
            const c = snippet[i];
            if (until !== null && c === until) {
                return text;
            }
            if (c === '\\' && i + 1 < snippet.length && '$}\\,|'.includes(snippet[i + 1])) {
                text += snippet[i + 1];
                i += 2;
                continue;
            }
            if (c === '$') {
                text += dollar(text);
                continue;
            }
            text += c;
            i++;
        }
        return text;
    };
    /** A `$…` construct at `i`; `before` is the text of the enclosing body so far, for where `$0` stands. */
    const dollar = (before: string): string => {
        const start = i;
        i++;
        const stop = digits();
        if (stop !== '') {
            if (stop === '0' && cursor < 0) {
                cursor = out.length + before.length;
            }
            return '';
        }
        const variable = name();
        if (variable !== '') {
            return '';
        }
        if (snippet[i] !== '{') {
            return '$';
        }
        i++;
        const id = digits() || name();
        if (id === '') {
            i = start + 1;
            return '$';
        }
        const isStop = /^\d+$/.test(id);
        if (snippet[i] === '}') {
            i++;
            if (id === '0' && cursor < 0) {
                cursor = out.length + before.length;
            }
            return '';
        }
        if (snippet[i] === ':') {
            i++;
            if (isStop && id === '0' && cursor < 0) {
                cursor = out.length + before.length;
            }
            const text = body('}');
            i++;
            return text;
        }
        if (snippet[i] === '|' && isStop) {
            i++;
            const end = snippet.indexOf('|}', i);
            const choices = end < 0 ? '' : snippet.slice(i, end);
            i = end < 0 ? snippet.length : end + 2;
            const first = /^(?:\\.|[^,\\])*/.exec(choices)?.[0] ?? '';
            return first.replace(/\\(.)/g, '$1');
        }
        // A variable's transform (`${TM_FILENAME/(.*)/$1/}`) or anything else: nothing.
        let depth = 1;
        while (i < snippet.length && depth > 0) {
            if (snippet[i] === '\\') {
                i += 2;
                continue;
            }
            if (snippet[i] === '{') {
                depth++;
            } else if (snippet[i] === '}') {
                depth--;
            }
            i++;
        }
        return '';
    };

    while (i < snippet.length) {
        out += body(null);
    }
    return { text: out, cursor: cursor < 0 ? out.length : cursor };
}

/** The offset of a position in `text`, lines broken as VS Code breaks them; a character past a line's end is its end. */
export function offsetIn(text: string, position: SourcePosition): number {
    const re = /\r\n|\r|\n/g;
    let start = 0;
    for (let line = 0; line < position.line; line++) {
        const m = re.exec(text);
        if (!m) {
            return text.length;
        }
        start = m.index + m[0].length;
    }
    re.lastIndex = start;
    const next = re.exec(text);
    const end = next ? next.index : text.length;
    return Math.min(start + Math.max(0, position.character), end);
}

function labelOf(item: vscode.CompletionItem): string {
    return typeof item.label === 'string' ? item.label : item.label.label;
}

/**
 * The range an item replaces: its own (the `inserting` one of an insert and
 * a replace range — VS Code's default insert mode), else the word before the
 * position, as VS Code's editor takes it for an item without a range.
 */
export function rangeOf(item: vscode.CompletionItem, document: vscode.TextDocument, position: vscode.Position): vscode.Range {
    const range = item.range;
    if (range instanceof vscode.Range) {
        return range;
    }
    if (range && 'inserting' in range) {
        return range.inserting;
    }
    const word = document.getWordRangeAtPosition(position);
    return new vscode.Range(word && word.start.isBefore(position) ? word.start : position, position);
}

/** What an item inserts, and where the caret goes in it. */
export function insertionOf(item: vscode.CompletionItem): { text: string; cursor: number } {
    const insert = item.insertText;
    if (insert instanceof vscode.SnippetString) {
        return snippetText(insert.value);
    }
    const text = typeof insert === 'string' ? insert : labelOf(item);
    return { text, cursor: text.length };
}

/** The items as the page lists them: VS Code's order for an empty word — `sortText`, else the label — capped. */
export function orderedItems(items: readonly vscode.CompletionItem[]): vscode.CompletionItem[] {
    return items
        .map((item, k) => ({ item, k, key: item.sortText ?? labelOf(item) }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.k - b.k))
        .slice(0, COMPLETION_CAP)
        .map(({ item }) => item);
}

function sourceRange(range: vscode.Range): SourceRange {
    return { start: { line: range.start.line, character: range.start.character }, end: { line: range.end.line, character: range.end.character } };
}

/** One item as the page lists it (`CompletionEntry`). */
export function completionEntry(item: vscode.CompletionItem, document: vscode.TextDocument, position: vscode.Position): CompletionEntry {
    const entry: CompletionEntry = { label: labelOf(item), insertText: insertionOf(item).text, range: sourceRange(rangeOf(item, document, position)) };
    const detail = item.detail ?? (typeof item.label === 'string' ? undefined : item.label.description ?? item.label.detail);
    if (detail) {
        entry.detail = detail;
    }
    if (item.kind !== undefined && vscode.CompletionItemKind[item.kind] !== undefined) {
        entry.kind = vscode.CompletionItemKind[item.kind].toLowerCase();
    }
    if (item.sortText !== undefined) {
        entry.sortText = item.sortText;
    }
    if (item.filterText !== undefined) {
        entry.filterText = item.filterText;
    }
    return entry;
}

/** The items of one `completions` answer, kept to apply the chosen one to the text it was offered for. */
interface Offered {
    requestId: number;
    version: number;
    text: string;
    position: vscode.Position;
    items: vscode.CompletionItem[];
}

/**
 * Completion at the page's caret (ARCHITECTURE.md, *Completion, diagnostics
 * and hover*): VS Code runs every completion provider registered for the
 * document (`vscode.executeCompletionItemProvider`) at the caret's source
 * position, and the items stay here — an item's edit is applied to the source
 * by the host, never guessed at by the page. The latest answer is kept, with
 * the document text it was computed on; an item is applied only to that text,
 * or to one that differs from it only inside the item's range (what the page
 * typed while the list filtered), its range then extended over the typing.
 */
export class CompletionController {
    private offered: Offered | undefined;

    constructor(private readonly host: LanguageHost) { }

    /** Whether the page of `baseVersion` holds the document's text now. */
    private current(baseVersion: number): boolean {
        return baseVersion === this.host.postedVersion() && this.host.port.pageHolds(this.host.port.document.getText());
    }

    /** Answer `complete`: never throws, always answers, if only with nothing. */
    async answer(requestId: number, baseVersion: number, position: SourcePosition, triggerCharacter: string | undefined): Promise<void> {
        let items: CompletionEntry[] = [];
        let incomplete = false;
        try {
            const result = await this.complete(requestId, baseVersion, position, triggerCharacter);
            items = result.items;
            incomplete = result.incomplete;
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the completions could not be read: ${message(error)}`);
        }
        await this.host.send({ type: 'completions', requestId, version: baseVersion, items, incomplete });
    }

    private async complete(requestId: number, baseVersion: number, position: SourcePosition, triggerCharacter: string | undefined): Promise<{ items: CompletionEntry[]; incomplete: boolean }> {
        const none = { items: [], incomplete: false };
        if (!this.current(baseVersion)) {
            return none;
        }
        const document = this.host.port.document;
        const version = document.version;
        const text = document.getText();
        const at = document.validatePosition(new vscode.Position(position.line, position.character));
        const trigger = typeof triggerCharacter === 'string' && triggerCharacter.length > 0 ? triggerCharacter : undefined;
        const list = await this.host.execute<vscode.CompletionList | undefined>(
            'vscode.executeCompletionItemProvider', document.uri, at, trigger, COMPLETION_RESOLVE_COUNT,
        );
        // Checked after the await: an edit that landed meanwhile moved the text the ranges point into.
        if (document.version !== version || !this.host.port.pageHolds(text)) {
            return none;
        }
        const items = orderedItems(list?.items ?? []);
        this.offered = { requestId, version, text, position: at, items };
        return { items: items.map(item => completionEntry(item, document, at)), incomplete: list?.isIncomplete === true };
    }

    /**
     * Apply item `index` of the answer `requestId` to the source: its range
     * replaced by what it inserts, its additional edits with it, in one
     * `WorkspaceEdit`; then the document is posted, and the caret's place in it
     * — the end of the insertion, a snippet's `$0` — follows. The item's
     * command is started, not awaited, unless it works on a text editor.
     */
    async apply(requestId: number, index: number, baseVersion: number): Promise<void> {
        let caret: SourcePosition | null = null;
        try {
            caret = await this.applyItem(requestId, index, baseVersion);
        } catch (error) {
            this.host.port.log(`[WARN] Visual Editor: the completion could not be applied: ${message(error)}`);
        }
        await this.host.send({ type: 'completionApplied', requestId, version: this.host.postedVersion(), caret });
    }

    private async applyItem(requestId: number, index: number, baseVersion: number): Promise<SourcePosition | null> {
        const offered = this.offered;
        const item = offered && offered.requestId === requestId && Number.isInteger(index) ? offered.items[index] : undefined;
        if (!offered || !item) {
            this.host.port.log(`[WARN] Visual Editor: the completion ${requestId}.${index} is no longer current; nothing was applied.`);
            return null;
        }
        if (!this.current(baseVersion)) {
            return null;
        }
        const document = this.host.port.document;
        const text = document.getText();
        const range = rangeOf(item, document, offered.position);
        const start = offsetIn(offered.text, range.start);
        const end = offsetIn(offered.text, range.end);
        // What the page typed while the list filtered: allowed only inside the item's range, which grows over it.
        let delta = 0;
        if (text !== offered.text) {
            const change = minimalReplacement(offered.text, text);
            if (change === null || change.start < start || change.end > end) {
                this.host.port.log(`[WARN] Visual Editor: "${labelOf(item)}" was offered for a text that changed outside its range; nothing was applied.`);
                return null;
            }
            delta = change.text.length - (change.end - change.start);
        }
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const normalize = (value: string) => value.replace(/\r\n|\r|\n/g, eol);
        const insertion = insertionOf(item);
        const inserted = normalize(insertion.text);
        const cursor = normalize(insertion.text.slice(0, insertion.cursor)).length;
        const edits: { start: number; end: number; text: string }[] = [{ start, end: end + delta, text: inserted }];
        let before = 0;
        for (const extra of item.additionalTextEdits ?? []) {
            const s = offsetIn(offered.text, extra.range.start);
            const e = offsetIn(offered.text, extra.range.end);
            const value = normalize(extra.newText);
            if (e <= start) {
                edits.push({ start: s, end: e, text: value });
                before += value.length - (e - s);
            } else if (s >= end) {
                edits.push({ start: s + delta, end: e + delta, text: value });
            } else {
                this.host.port.log(`[WARN] Visual Editor: "${labelOf(item)}" has an additional edit overlapping its own; nothing was applied.`);
                return null;
            }
        }
        const edit = new vscode.WorkspaceEdit();
        for (const e of edits) {
            edit.replace(document.uri, new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
            this.host.port.log(`[WARN] Visual Editor: the edit of "${labelOf(item)}" was not applied.`);
            return null;
        }
        this.offered = undefined;
        // The page takes the source as it now is, as it takes any writer's change.
        await this.host.repost();
        const command = item.command;
        if (command && command.command && !TEXT_EDITOR_COMMAND.test(command.command)) {
            void Promise.resolve(this.host.execute(command.command, ...(command.arguments ?? []))).catch(error => {
                this.host.port.log(`[WARN] Visual Editor: the command of "${labelOf(item)}" failed: ${message(error)}`);
            });
        }
        const at = document.positionAt(start + before + cursor);
        return { line: at.line, character: at.character };
    }
}
