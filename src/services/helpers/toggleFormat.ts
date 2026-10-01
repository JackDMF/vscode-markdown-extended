import * as vscode from 'vscode';
import { editTextDocument } from '../common/editTextDocument';

export function toggleFormat(
    editor: vscode.TextEditor,
    detect: RegExp,
    on: RegExp, onReplace: string,
    off: RegExp, offReplace: string,
    multiLine: boolean
): Thenable<unknown> {
    if (!editor || !editor.document) {return;}
    if (!multiLine) {return toggleInline(editor, detect, onReplace);}
    let isOn = false;
    const document = editor.document;
    const selection = editor.selection;
    let target = matchedInCursor(document, selection, detect);
    let newText = "";
    if (target)
        {isOn = true;}
    else
        {target = getLines(document, selection);}
    // select target for better user experience.
    editor.selections = [target];
    if (isOn)
        {newText = document.getText(target).replace(off, offReplace);}
    else
        {newText = document.getText(target).replace(on, onReplace);}
    // console.log(document.getText(target));
    return editTextDocument(document, [{
        range: target,
        replace: newText
    }]);
}

/**
 * One insertion or deletion of a marker, as offsets in the document before the
 * edit. `close`, `pair` and `open` are insertions, written at one offset in
 * that order; `delete` removes `start`..`end`.
 */
interface MarkerChange {
    start: number;
    end: number;
    text: string;
    kind: 'close' | 'pair' | 'open' | 'delete';
}

/** What one selection toggles: the text it covers, markers included, and the changes. */
interface Toggle {
    start: number;
    end: number;
    changes: MarkerChange[];
}

const KIND_ORDER = { close: 0, pair: 1, open: 2, delete: 3 };

/**
 * Toggles an inline marker on every selection, in one edit. A selection inside
 * (or a cursor touching) a formatted span removes its markers; otherwise a
 * selection is wrapped exactly as selected, an empty one wraps the word at the
 * cursor (VS Code's word, as a double-click selects it), and with no word there
 * the marker pair is inserted with the cursor between. The selections are kept
 * where their text went.
 */
function toggleInline(editor: vscode.TextEditor, detect: RegExp, onReplace: string): Thenable<unknown> {
    const document = editor.document;
    const [prefix, suffix] = onReplace.split('$1');
    const toggles = editor.selections.map(selection => toggleOf(document, selection, detect, prefix, suffix));
    // two cursors in one word toggle it once; a selection overlapping another's text is left out.
    const accepted: Toggle[] = [];
    for (const toggle of toggles) {
        if (accepted.some(a => overlaps(a, toggle))) {continue;}
        accepted.push(toggle);
    }
    const changes = accepted
        .reduce((all, t) => all.concat(t.changes), [] as MarkerChange[])
        .sort((a, b) => a.start - b.start || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    if (!changes.length) {return Promise.resolve();}
    const selections = editor.selections.map((selection, i) => [
        mapOffset(document.offsetAt(selection.anchor), toggles[i], changes, prefix.length),
        mapOffset(document.offsetAt(selection.active), toggles[i], changes, prefix.length),
    ]);
    return editor.edit(builder => {
        for (const edit of mergeChanges(document, changes)) {
            builder.replace(edit.range, edit.text);
        }
    }).then(applied => {
        if (!applied) {return;}
        editor.selections = selections.map(([anchor, active]) => new vscode.Selection(
            editor.document.positionAt(anchor), editor.document.positionAt(active)
        ));
    });
}

function toggleOf(
    document: vscode.TextDocument,
    selection: vscode.Selection,
    detect: RegExp,
    prefix: string, suffix: string
): Toggle {
    const matched = matchedInCursor(document, selection, detect);
    if (matched) {
        const start = document.offsetAt(matched.start);
        const end = document.offsetAt(matched.end);
        // the markers are the same either side of the text the expression captures.
        const text = document.getText(matched);
        detect.lastIndex = 0;
        const inner = detect.exec(text)[1];
        const marker = (text.length - inner.length) / 2;
        return {
            start, end, changes: [
                { start, end: start + marker, text: '', kind: 'delete' },
                { start: end - marker, end, text: '', kind: 'delete' },
            ]
        };
    }
    let target: vscode.Range = selection;
    if (selection.isEmpty) {
        target = document.getWordRangeAtPosition(selection.active);
        if (!target) {
            const at = document.offsetAt(selection.active);
            return { start: at, end: at, changes: [{ start: at, end: at, text: prefix + suffix, kind: 'pair' }] };
        }
    }
    const toggle: Toggle = { start: document.offsetAt(target.start), end: document.offsetAt(target.end), changes: [] };
    // a selection over several lines wraps each line's part of it.
    for (let line = target.start.line; line <= target.end.line; line++) {
        const from = line === target.start.line ? target.start.character : 0;
        const to = line === target.end.line ? target.end.character : document.lineAt(line).text.length;
        if (to <= from) {continue;}
        const start = document.offsetAt(new vscode.Position(line, from));
        const end = document.offsetAt(new vscode.Position(line, to));
        toggle.changes.push(
            { start, end: start, text: prefix, kind: 'open' },
            { start: end, end, text: suffix, kind: 'close' },
        );
    }
    return toggle;
}

function overlaps(a: Toggle, b: Toggle): boolean {
    if (a.start === b.start && a.end === b.end) {return true;}
    return a.start < b.end && b.start < a.end;
}

/**
 * Where an offset is after the changes. An insertion at the offset itself moves
 * it as far as the offset's place in its own toggle says: the start of a
 * wrapped text goes after the opening marker, its end stays before the closing
 * one, and a cursor in an inserted pair goes between the two markers.
 */
function mapOffset(offset: number, toggle: Toggle, changes: MarkerChange[], prefixLength: number): number {
    const place = toggle.start === toggle.end ? 'pair'
        : offset === toggle.start ? 'start'
            : offset === toggle.end ? 'end' : 'inside';
    let delta = 0;
    for (const change of changes) {
        if (change.kind === 'delete') {
            if (change.end <= offset) {delta -= change.end - change.start;}
            else if (change.start < offset) {delta -= offset - change.start;}
            continue;
        }
        if (change.start < offset) {delta += change.text.length; continue;}
        if (change.start > offset) {continue;}
        if (change.kind === 'close' && place !== 'end') {delta += change.text.length;}
        if (change.kind === 'pair') {delta += place === 'start' ? change.text.length : place === 'pair' ? prefixLength : 0;}
        if (change.kind === 'open' && place === 'start') {delta += change.text.length;}
    }
    return offset + delta;
}

/** The changes as replacements, those at one offset or touching merged, so no two ranges meet. */
function mergeChanges(document: vscode.TextDocument, changes: MarkerChange[]): { range: vscode.Range, text: string }[] {
    const edits: { start: number, end: number, text: string }[] = [];
    for (const change of changes) {
        const last = edits[edits.length - 1];
        if (last && change.start <= last.end) {
            last.text += change.text;
            last.end = Math.max(last.end, change.end);
            continue;
        }
        edits.push({ start: change.start, end: change.end, text: change.text });
    }
    return edits.map(e => ({
        range: new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
        text: e.text,
    }));
}

function matchedInCursor(
    document: vscode.TextDocument,
    selection: vscode.Selection,
    rule: RegExp
): vscode.Selection {
    const lines = getLines(document, selection);
    const text = document.getText(lines);
    const base = document.offsetAt(lines.start);
    rule.lastIndex = 0;
    let matches: RegExpMatchArray;
    while (matches = rule.exec(text)) {
        const start = document.positionAt(base + matches.index);
        const end = document.positionAt(base + matches.index + matches[0].length);
        const rng = new vscode.Selection(start, end);
        const common = rng.intersection(selection);
        // a cursor touching the markers is in the span; a selection must share text with it.
        if (common && (selection.isEmpty || !common.isEmpty)) {return rng;}
    }
    return undefined;
}

function getLines(document: vscode.TextDocument, selection: vscode.Selection): vscode.Selection {
    const lines = document.lineAt(selection.start).range.union(
        document.lineAt(selection.end).range
    );
    return new vscode.Selection(lines.start, lines.end);
}
