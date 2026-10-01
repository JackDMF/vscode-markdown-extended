import * as vscode from 'vscode';
import { WORD_CHARACTER, opensInsideWords } from '../../syntax/markers';
import { editTextDocument } from '../common/editTextDocument';
import { LineStart, findSpans, lineStarts } from './inlineSpans';

/** Toggles a block construct (quote, list, code block) on the primary selection's lines. */
export function toggleFormat(
    editor: vscode.TextEditor,
    detect: RegExp,
    on: RegExp, onReplace: string,
    off: RegExp, offReplace: string,
): Thenable<unknown> {
    if (!editor || !editor.document) {return;}
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

/** What one selection toggles: the text it covers, markers included, how, and the changes. */
interface Toggle extends Stretch {
    kind: 'wrap' | 'unwrap' | 'pair' | 'none';
    changes: MarkerChange[];
}

const KIND_ORDER = { close: 0, pair: 1, open: 2, delete: 3 };

/**
 * Toggles an inline marker on every selection, in one edit.
 *
 * A selection lying within a formatted span loses that span's markers; a
 * selection over several lines does when each line's part lies within a span.
 * Any other selection is wrapped, and written as one span: spans of the same
 * marker inside it lose their markers, and one it touches or overlaps becomes
 * part of it, so `«make **this** bold»` and `**make**« this bold»` both give
 * `**make this bold**`. What is wrapped is each line's part of the selection,
 * without the whitespace at its ends and after the line's block prefix (a
 * bullet and its task box, a number, `#`, `>`), so no marker stands next to a
 * space; over several lines a line that is not text a marker can go into — a
 * fence and its code, a table row, a thematic break, an HTML block, and the
 * like (`lineStarts`) — is left as it is, and so is a line whose part is
 * formatted already. Underline's `_` cannot open or close next to a word
 * character, so a selection ending inside or next to a word takes in the rest
 * of the word.
 *
 * A cursor in or next to a span removes the span, and a cursor between the
 * markers of an empty pair removes the pair; otherwise it wraps the word at the
 * cursor (VS Code's word, so punctuation stays outside), and with no word there
 * the marker pair is inserted with the cursor between. Nothing is written into
 * code, math or an HTML block.
 *
 * Selections whose texts overlap, and wrapped selections that touch, are
 * toggled as one selection from the first one's start to the last one's end,
 * whichever cursor is the primary one. Every selection is kept where its text
 * went.
 */
export function toggleInlineFormat(editor: vscode.TextEditor, marker: string): Thenable<unknown> {
    if (!editor || !editor.document) {return;}
    const document = editor.document;
    const last = Math.max(...editor.selections.map(s => s.end.line));
    const lines = Array.from({ length: last + 1 }, (_, n) => document.lineAt(n).text);
    const toggler = new InlineToggler(document, marker, lineStarts(lines));
    const toggles = editor.selections.map(selection => toggler.toggleOf(selection));
    const order = toggles.map((_, i) => i)
        .sort((a, b) => toggles[a].start - toggles[b].start || toggles[b].end - toggles[a].end);
    // in document order, each toggle merged with the ones before it that it joins.
    const merged: { toggle: Toggle, members: number[] }[] = [];
    for (const i of order) {
        let current = { toggle: toggles[i], members: [i] };
        while (merged.length && joins(merged[merged.length - 1].toggle, current.toggle)) {
            const top = merged.pop();
            const same = top.toggle.start === current.toggle.start && top.toggle.end === current.toggle.end;
            const start = Math.min(top.toggle.start, current.toggle.start);
            const end = Math.max(top.toggle.end, current.toggle.end);
            current = {
                toggle: same ? top.toggle : toggler.toggleOf(new vscode.Selection(document.positionAt(start), document.positionAt(end))),
                members: top.members.concat(current.members),
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
        mapOffset(document.offsetAt(selection.anchor), owners[i], changes, marker.length),
        mapOffset(document.offsetAt(selection.active), owners[i], changes, marker.length),
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

/** Whether two toggles are one: their texts overlap, or two wrapped texts touch. */
function joins(a: Toggle, b: Toggle): boolean {
    if (a.start === b.start && a.end === b.end) {return true;}
    if (a.kind === 'wrap' && b.kind === 'wrap' && (a.end === b.start || b.end === a.start)) {return true;}
    return a.start < b.end && b.start < a.end;
}

/** What one marker does to one selection, read from the document as it was before the edit. */
class InlineToggler {
    private readonly text: string;
    private readonly spans = new Map<number, Stretch[]>();

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly marker: string,
        private readonly starts: LineStart[],
    ) {
        this.text = document.getText();
    }

    toggleOf(selection: vscode.Selection): Toggle {
        const at = this.document.offsetAt(selection.active);
        const selected = { start: this.document.offsetAt(selection.start), end: this.document.offsetAt(selection.end) };
        if (selection.isSingleLine && this.starts[selection.start.line].kind === 'literal') {
            return { ...selected, kind: 'none', changes: [] };
        }
        if (selection.isEmpty) {
            if (this.inEmptyPair(at)) {
                const start = at - this.marker.length, end = at + this.marker.length;
                return { start, end, kind: 'unwrap', changes: [{ start, end, text: '', kind: 'delete' }] };
            }
            const span = this.spansOn(selection.active.line).find(s => s.start <= at && at <= s.end);
            if (span) {return this.unwrap([span], span);}
            const word = this.document.getWordRangeAtPosition(selection.active);
            if (!word) {
                const pair = this.marker + this.marker;
                // `~~~~` at a line's start would open a fence.
                const line = this.document.lineAt(selection.active.line).text;
                const written = line.slice(0, selection.active.character) + pair + line.slice(selection.active.character);
                if (lineStarts([written])[0].kind === 'literal') {return { ...selected, kind: 'none', changes: [] };}
                return { start: at, end: at, kind: 'pair', changes: [{ start: at, end: at, text: pair, kind: 'pair' }] };
            }
            const part = { start: this.document.offsetAt(word.start), end: this.document.offsetAt(word.end) };
            return this.wrap([part], part);
        }
        const parts = this.partsOf(selection);
        if (!parts.length) {return { ...selected, kind: 'none', changes: [] };}
        const within = parts.map(part => this.spansAt(part).find(s => s.start <= part.start && part.end <= s.end));
        if (within.every(s => !!s)) {return this.unwrap(within, selected);}
        // a line whose part is formatted already is left as it is.
        return this.wrap(parts.filter((_, i) => !within[i]), selected);
    }

    /**
     * Each line's part a selection wraps: after the line's block prefix,
     * without whitespace at either end. Over several lines, a line no marker
     * can go into has no part.
     */
    private partsOf(selection: vscode.Selection): Stretch[] {
        const parts: Stretch[] = [];
        for (let line = selection.start.line; line <= selection.end.line; line++) {
            const start = this.starts[line];
            if (start.kind === 'literal' || (start.kind === 'structure' && !selection.isSingleLine)) {continue;}
            const text = this.document.lineAt(line).text;
            let from = Math.max(line === selection.start.line ? selection.start.character : 0, start.prefix);
            let to = line === selection.end.line ? selection.end.character : text.length;
            while (from < to && /\s/.test(text[from])) {from++;}
            while (to > from && /\s/.test(text[to - 1])) {to--;}
            if (to <= from) {continue;}
            const base = this.document.offsetAt(new vscode.Position(line, 0));
            parts.push({ start: base + from, end: base + to });
        }
        return parts;
    }

    /**
     * Wraps the parts as one span each. A span of the marker inside a part
     * loses its markers; one a part touches or overlaps at an end lends it its
     * marker there, so the two are one span. `_` widens a part to the ends of
     * the words its ends touch.
     */
    private wrap(parts: Stretch[], covered: Stretch): Toggle {
        const length = this.marker.length;
        const toggle: Toggle = { ...covered, kind: 'wrap', changes: [] };
        for (const original of parts) {
            const part = opensInsideWords(this.marker) ? original : this.widened(original);
            const spans = this.spansAt(part).filter(s => s.end >= part.start && s.start <= part.end);
            if (spans.some(s => s.start <= part.start && part.end <= s.end)) {continue;}
            const left = spans.find(s => s.start <= part.start);
            const right = spans.find(s => s.end >= part.end);
            for (const span of spans) {
                if (span !== left) {toggle.changes.push({ start: span.start, end: span.start + length, text: '', kind: 'delete' });}
                if (span !== right) {toggle.changes.push({ start: span.end - length, end: span.end, text: '', kind: 'delete' });}
            }
            if (!left) {toggle.changes.push({ start: part.start, end: part.start, text: this.marker, kind: 'open' });}
            if (!right) {toggle.changes.push({ start: part.end, end: part.end, text: this.marker, kind: 'close' });}
            toggle.start = Math.min(toggle.start, left ? left.start : part.start);
            toggle.end = Math.max(toggle.end, right ? right.end : part.end);
        }
        return toggle;
    }

    private unwrap(spans: Stretch[], covered: Stretch): Toggle {
        const length = this.marker.length;
        return {
            start: Math.min(covered.start, spans[0].start),
            end: Math.max(covered.end, spans[spans.length - 1].end),
            kind: 'unwrap',
            changes: spans.flatMap(span => [
                { start: span.start, end: span.start + length, text: '', kind: 'delete' as const },
                { start: span.end - length, end: span.end, text: '', kind: 'delete' as const },
            ]),
        };
    }

    /** A part taken out to the ends of the words its ends touch, so no word character stands outside its markers. */
    private widened(part: Stretch): Stretch {
        const isWord = (at: number) => at >= 0 && at < this.text.length && WORD_CHARACTER.test(this.text[at]);
        let { start, end } = part;
        while (isWord(start - 1)) {start--;}
        while (isWord(end)) {end++;}
        return { start, end };
    }

    /** The spans of the marker on the line a stretch starts on. */
    private spansAt(stretch: Stretch): Stretch[] {
        return this.spansOn(this.document.positionAt(stretch.start).line);
    }

    /** The spans of the marker on a line, as document offsets. */
    private spansOn(line: number): Stretch[] {
        let spans = this.spans.get(line);
        if (!spans) {
            const base = this.document.offsetAt(new vscode.Position(line, 0));
            spans = findSpans(this.document.lineAt(line).text, this.marker)
                .map(s => ({ start: base + s.start, end: base + s.end }));
            this.spans.set(line, spans);
        }
        return spans;
    }

    /**
     * Whether the cursor stands between the markers of a pair with nothing in
     * it, as a toggle with no word inserts one: no word touching it from
     * outside (VS Code's word, as when the pair was inserted), so the inner
     * markers of `**bold**` are not taken for a pair.
     */
    private inEmptyPair(at: number): boolean {
        const start = at - this.marker.length, end = at + this.marker.length;
        if (start < 0 || this.text.slice(start, at) !== this.marker || this.text.slice(at, end) !== this.marker) {return false;}
        const wordAt = (offset: number) => !!this.document.getWordRangeAtPosition(this.document.positionAt(offset));
        return !wordAt(start) && !wordAt(end);
    }
}

/**
 * Where an offset is after the changes. An insertion at the offset itself moves
 * it as far as the offset's place in its own toggle says: the start of a
 * wrapped part goes after the opening marker, its end stays before the closing
 * one, and a cursor in an inserted pair goes between the two markers.
 */
function mapOffset(offset: number, own: Toggle, changes: MarkerChange[], markerLength: number): number {
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
        if (change.kind === 'pair') {delta += place === 'start' ? change.text.length : place === 'pair' ? markerLength : 0;}
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
