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

/** A stretch of the document, as offsets. */
interface Stretch {
    start: number;
    end: number;
}

/** A formatted span, markers included, and the length of one marker. */
interface Span extends Stretch {
    marker: number;
}

/** What one selection toggles: the text it covers, markers included, and the changes. */
interface Toggle extends Stretch {
    changes: MarkerChange[];
}

const KIND_ORDER = { close: 0, pair: 1, open: 2, delete: 3 };

/** What a line starts with that is not its text: indentation, a quote's `>`, a bullet, a number, a heading's `#`s. */
const BLOCK_PREFIX = /^[^\S\n]*(?:(?:>|[-*+](?=\s)|\d+[.)](?=\s)|#{1,6}(?=\s))[^\S\n]*)*/;

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Toggles an inline marker on every selection, in one edit.
 *
 * A selection lying within a formatted span loses that span's markers; a
 * selection over several lines does when each line's part lies within a span.
 * Any other selection is wrapped, spans inside it kept as they are: each
 * line's part of it, without the whitespace at its ends and without the line's
 * block prefix, so a list item keeps its bullet and no marker stands next to a
 * space; a line whose part is formatted already is left alone, and a part is
 * cut short of a span it only partly covers. A cursor in or next
 * to a span removes the span, a cursor between the markers of an empty pair
 * removes the pair; otherwise it wraps the word at the cursor (VS Code's word,
 * so punctuation stays outside), and with no word there the marker pair is
 * inserted with the cursor between.
 *
 * Selections whose texts overlap are toggled as one selection, from the first
 * one's start to the last one's end, whichever cursor is the primary one.
 * Every selection is kept where its text went.
 */
function toggleInline(editor: vscode.TextEditor, detect: RegExp, onReplace: string): Thenable<unknown> {
    const document = editor.document;
    const [prefix, suffix] = onReplace.split('$1');
    const text = document.getText();
    const toggleOver = (selection: vscode.Selection) => toggleOf(document, text, selection, detect, prefix, suffix);
    const toggles = editor.selections.map(toggleOver);
    const order = toggles.map((_, i) => i)
        .sort((a, b) => toggles[a].start - toggles[b].start || toggles[b].end - toggles[a].end);
    // in document order, each toggle merged with the ones before it that it overlaps.
    const merged: { toggle: Toggle, members: number[] }[] = [];
    for (const i of order) {
        let current = { toggle: toggles[i], members: [i] };
        while (merged.length && overlaps(merged[merged.length - 1].toggle, current.toggle)) {
            const top = merged.pop();
            const members = top.members.concat(current.members);
            const same = top.toggle.start === current.toggle.start && top.toggle.end === current.toggle.end;
            const start = Math.min(top.toggle.start, current.toggle.start);
            const end = Math.max(top.toggle.end, current.toggle.end);
            current = {
                toggle: same ? top.toggle : toggleOver(new vscode.Selection(document.positionAt(start), document.positionAt(end))),
                members,
            };
        }
        merged.push(current);
    }
    const owners: Toggle[] = [];
    for (const { toggle, members } of merged) {
        for (const i of members) {owners[i] = toggle;}
    }
    const changes = merged
        .flatMap(m => m.toggle.changes)
        .sort((a, b) => a.start - b.start || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
    if (!changes.length) {return Promise.resolve();}
    const selections = editor.selections.map((selection, i) => [
        mapOffset(document.offsetAt(selection.anchor), owners[i], changes, prefix.length),
        mapOffset(document.offsetAt(selection.active), owners[i], changes, prefix.length),
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
    text: string,
    selection: vscode.Selection,
    detect: RegExp,
    prefix: string, suffix: string
): Toggle {
    if (selection.isEmpty) {
        const at = document.offsetAt(selection.active);
        if (inEmptyPair(text, at, prefix, suffix)) {
            const start = at - prefix.length, end = at + suffix.length;
            return { start, end, changes: [{ start, end, text: '', kind: 'delete' }] };
        }
        const span = spansOn(document, selection.active.line, detect).find(s => s.start <= at && at <= s.end);
        if (span) {return unwrap([span], span);}
        const word = document.getWordRangeAtPosition(selection.active);
        if (!word) {
            return { start: at, end: at, changes: [{ start: at, end: at, text: prefix + suffix, kind: 'pair' }] };
        }
        const part = { start: document.offsetAt(word.start), end: document.offsetAt(word.end) };
        return wrap([part], part, prefix, suffix);
    }
    const selected = { start: document.offsetAt(selection.start), end: document.offsetAt(selection.end) };
    const parts = partsOf(document, selection);
    if (!parts.length) {return { ...selected, changes: [] };}
    const spans = parts.map(part =>
        spansOn(document, document.positionAt(part.start).line, detect)
            .find(s => s.start <= part.start && part.end <= s.end)
    );
    if (spans.every(s => !!s)) {return unwrap(spans, selected);}
    // a line whose part is formatted already is left as it is.
    const clipped = parts
        .filter((_, i) => !spans[i])
        .map(part => clip(part, spansOn(document, document.positionAt(part.start).line, detect), text))
        .filter(part => part.start < part.end);
    return wrap(clipped, selected, prefix, suffix);
}

/**
 * A part cut short of a span it only partly covers, so the toggle never writes
 * a marker into another's: `«a **b»c**` wraps `a`, not `a **b`.
 */
function clip(part: Stretch, spans: Span[], text: string): Stretch {
    let { start, end } = part;
    for (const span of spans) {
        if (span.start < start && start < span.end && span.end < end) {start = span.end;}
        if (start < span.start && span.start < end && end < span.end) {end = span.start;}
    }
    while (start < end && /\s/.test(text[start])) {start++;}
    while (end > start && /\s/.test(text[end - 1])) {end--;}
    return { start, end };
}

function overlaps(a: Stretch, b: Stretch): boolean {
    if (a.start === b.start && a.end === b.end) {return true;}
    return a.start < b.end && b.start < a.end;
}

function wrap(parts: Stretch[], covered: Stretch, prefix: string, suffix: string): Toggle {
    return {
        start: covered.start, end: covered.end,
        changes: parts.flatMap(part => [
            { start: part.start, end: part.start, text: prefix, kind: 'open' as const },
            { start: part.end, end: part.end, text: suffix, kind: 'close' as const },
        ]),
    };
}

function unwrap(spans: Span[], covered: Stretch): Toggle {
    return {
        start: Math.min(covered.start, spans[0].start),
        end: Math.max(covered.end, spans[spans.length - 1].end),
        changes: spans.flatMap(span => [
            { start: span.start, end: span.start + span.marker, text: '', kind: 'delete' as const },
            { start: span.end - span.marker, end: span.end, text: '', kind: 'delete' as const },
        ]),
    };
}

/** The formatted spans on a line. */
function spansOn(document: vscode.TextDocument, line: number, detect: RegExp): Span[] {
    const text = document.lineAt(line).text;
    const base = document.offsetAt(new vscode.Position(line, 0));
    const spans: Span[] = [];
    detect.lastIndex = 0;
    let match: RegExpExecArray;
    while (match = detect.exec(text)) {
        // the markers are the same either side of the text the expression captures.
        const marker = (match[0].length - match[1].length) / 2;
        spans.push({ start: base + match.index, end: base + match.index + match[0].length, marker });
    }
    return spans;
}

/**
 * The part of each line a selection wraps: the line's text after its block
 * prefix, without whitespace at either end. A line with nothing left has no
 * part.
 */
function partsOf(document: vscode.TextDocument, selection: vscode.Selection): Stretch[] {
    const parts: Stretch[] = [];
    for (let line = selection.start.line; line <= selection.end.line; line++) {
        const text = document.lineAt(line).text;
        let from = Math.max(line === selection.start.line ? selection.start.character : 0, BLOCK_PREFIX.exec(text)[0].length);
        let to = line === selection.end.line ? selection.end.character : text.length;
        while (from < to && /\s/.test(text[from])) {from++;}
        while (to > from && /\s/.test(text[to - 1])) {to--;}
        if (to <= from) {continue;}
        const base = document.offsetAt(new vscode.Position(line, 0));
        parts.push({ start: base + from, end: base + to });
    }
    return parts;
}

/**
 * Whether the cursor stands between the markers of a pair with nothing in it,
 * as a toggle with no word inserts one: no word or marker character touching
 * it from outside, so the inner markers of `**bold**` are not taken for a pair.
 */
function inEmptyPair(text: string, at: number, prefix: string, suffix: string): boolean {
    const start = at - prefix.length, end = at + suffix.length;
    if (start < 0 || text.slice(start, at) !== prefix || text.slice(at, end) !== suffix) {return false;}
    const outside = (c: string) => !!c && (WORD_CHARACTER.test(c) || prefix.includes(c) || suffix.includes(c));
    return !outside(text[start - 1]) && !outside(text[end]);
}

/**
 * Where an offset is after the changes. An insertion at the offset itself moves
 * it as far as the offset's place in its own toggle says: the start of a
 * wrapped part goes after the opening marker, its end stays before the closing
 * one, and a cursor in an inserted pair goes between the two markers.
 */
function mapOffset(offset: number, own: Toggle, changes: MarkerChange[], prefixLength: number): number {
    const kinds = own.changes.filter(c => c.start === offset).map(c => c.kind);
    const place = kinds.includes('open') ? 'start'
        : kinds.includes('close') ? 'end'
            : kinds.includes('pair') ? 'pair' : 'inside';
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
    const newLinePos: number[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text.substr(i, 1) === '\n') {newLinePos.push(i);}
    }
    rule.lastIndex = 0;
    let matches: RegExpMatchArray;
    while (matches = rule.exec(text)) {
        const start = convertPosition(
            new vscode.Position(selection.start.line, matches.index),
            newLinePos,
        );
        const end = convertPosition(
            new vscode.Position(selection.start.line, matches.index + matches[0].length),
            newLinePos,
        );
        const rng = new vscode.Selection(start, end);
        if (rng.intersection(selection)) {return rng;}
    }
    return undefined;
}

function convertPosition(pos: vscode.Position, newLinePos: number[]): vscode.Position {
    let line = 0;
    let linePos = 0;
    newLinePos.map((p, i) => {
        if (pos.character > p) {
            line = i + 1;
            linePos = p;
        }
    });
    return new vscode.Position(line + pos.line, pos.character - linePos);
}

function getLines(document: vscode.TextDocument, selection: vscode.Selection): vscode.Selection {
    const lines = document.lineAt(selection.start).range.union(
        document.lineAt(selection.end).range
    );
    return new vscode.Selection(lines.start, lines.end);
}
