import * as vscode from 'vscode';
import { MarkdownIt } from '../../@types/markdown-it';
import { engineEnvironment } from '../../editor/host/engineHost';
import { InlineSource, LineKind, SourceSpan, readInlineSource } from '../../editor/inlineSource';
import { INLINE_MARKERS, WORD_CHARACTER, opensInsideWords } from '../../syntax/markers';
import { editTextDocument } from '../common/editTextDocument';
import { inlineSourceOf } from './inlineSourceCache';

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
 * Toggles an inline marker on every selection, in one edit, reading the
 * document as the engine reads it (`inlineSource.ts`, through `md`).
 *
 * A selection lying within a formatted span loses that span's markers — the
 * innermost such span — and a selection over several lines does when each
 * line's part lies within a span. Any other selection is wrapped as selected,
 * the spans inside it kept, so `«make **this** bold»` gives
 * `**make **this** bold**`. What is wrapped is each line's text the selection
 * covers, without the whitespace at its ends: a line's prefix (a bullet and its
 * task box, a number, `#`, `>`, a footnote's label, an admonition's
 * indentation), code, inline HTML, a link's URL and a table cell's padding stay
 * outside, so a selection across a link's end takes only the link's text and
 * one over a table row formats each cell. A part may run across another span's
 * markers, a code span, an image, an emoji or a footnote reference, which the
 * markers then enclose. Over several lines a line that is not text — a fence
 * and its code, a thematic break, a setext underline, a table's delimiter row,
 * a container's fences, an HTML block — is left as it is, and so is a line
 * whose part is formatted already; on its own such a line is not toggled at
 * all. Underline's `_` cannot open or close next to a word character, so a
 * selection ending inside or next to a word takes in the rest of the word.
 *
 * A cursor in or next to a span removes the span, and a cursor between the
 * markers of an empty pair removes the pair; otherwise it wraps the word at the
 * cursor (VS Code's word, so punctuation stays outside), and with no word there
 * the marker pair is inserted with the cursor between — unless the line would
 * then be no longer text, as `~~~~` at a line's start opens a fence. Nothing is
 * written into code. A span whose markers the tokens do not place exactly is
 * never removed: the selection is wrapped instead.
 *
 * Selections whose texts overlap, and wrapped selections that touch, are
 * toggled as one selection from the first one's start to the last one's end,
 * whichever cursor is the primary one. Every selection is kept where its text
 * went.
 */
export function toggleInlineFormat(editor: vscode.TextEditor, marker: string, md: MarkdownIt): Thenable<unknown> {
    if (!editor || !editor.document) {return;}
    const document = editor.document;
    const toggler = new InlineToggler(document, marker, inlineSourceOf(document, md), md);
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

/** The smallest of the spans: the innermost, when they nest. */
function innermost(spans: SourceSpan[]): SourceSpan | undefined {
    return spans.reduce<SourceSpan | undefined>((best, s) => (best === undefined || s.end - s.start < best.end - best.start ? s : best), undefined);
}

/** What one marker does to one selection, read from the document as it was before the edit. */
class InlineToggler {
    private readonly text: string;

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly marker: string,
        private readonly source: InlineSource,
        private readonly md: MarkdownIt,
    ) {
        this.text = document.getText();
    }

    toggleOf(selection: vscode.Selection): Toggle {
        const at = this.document.offsetAt(selection.active);
        const selected = { start: this.document.offsetAt(selection.start), end: this.document.offsetAt(selection.end) };
        const none: Toggle = { ...selected, kind: 'none', changes: [] };
        const kind = this.source.kindOf(selection.start.line);
        if (selection.isSingleLine && kind !== 'text' && kind !== 'blank') {return none;}
        if (selection.isEmpty) {
            const line = selection.active.line;
            if (this.marker !== INLINE_MARKERS.codeInline && this.inCode(line, at)) {return none;}
            if (this.inEmptyPair(at)) {
                const start = at - this.marker.length, end = at + this.marker.length;
                return { start, end, kind: 'unwrap', changes: [{ start, end, text: '', kind: 'delete' }] };
            }
            const span = innermost(this.spansOn(line).filter(s => s.start <= at && at <= s.end));
            if (span) {return this.unwrap([span], span);}
            const word = this.document.getWordRangeAtPosition(selection.active);
            if (!word) {return this.pair(selection.active, at) ?? none;}
            const part = this.partsOn(line, this.document.offsetAt(word.start), this.document.offsetAt(word.end))
                .find(p => p.start <= at && at <= p.end);
            return part ? this.wrap([part], part) : none;
        }
        const parts = this.partsOf(selection);
        if (!parts.length) {
            // Code is no text a part takes: a selection over code spans and the spaces between them removes them.
            const codes: SourceSpan[] = [];
            for (let line = selection.start.line; this.marker === INLINE_MARKERS.codeInline && line <= selection.end.line; line++) {
                codes.push(...this.spansOn(line).filter(s => s.start < selected.end && selected.start < s.end));
            }
            return codes.length ? this.unwrap(codes, selected) : none;
        }
        const within = parts.map(part => innermost(this.spansAt(part).filter(s => s.start <= part.start && part.end <= s.end)));
        if (within.every(s => !!s)) {return this.unwrap(within, selected);}
        // a line whose part is formatted already is left as it is.
        return this.wrap(parts.filter((_, i) => !within[i]), selected);
    }

    /** Each line's parts a selection wraps (`partsOn`); a line that is not text has none. */
    private partsOf(selection: vscode.Selection): Stretch[] {
        const from = this.document.offsetAt(selection.start);
        const to = this.document.offsetAt(selection.end);
        const parts: Stretch[] = [];
        for (let line = selection.start.line; line <= selection.end.line; line++) {
            parts.push(...this.partsOn(line, from, to));
        }
        return parts;
    }

    /**
     * The parts of `from`..`to` on a line: its text stretches cut to the
     * range, one joined to the one before it where the stretch continues it
     * and the range takes in what stands between, without whitespace at
     * either end.
     */
    private partsOn(line: number, from: number, to: number): Stretch[] {
        const parts: Stretch[] = [];
        let last: Stretch | undefined;
        let reached = false;
        for (const stretch of this.source.textOn(line)) {
            const start = Math.max(from, stretch.start), end = Math.min(to, stretch.end);
            if (end <= start) {
                last = undefined;
                continue;
            }
            if (last && reached && stretch.continues && start === stretch.start) {
                last.end = end;
            } else {
                last = { start, end };
                parts.push(last);
            }
            reached = end === stretch.end;
        }
        const inside = this.allSpansOn(line).filter(s => from <= s.start && s.end <= to);
        for (const part of parts) {
            while (part.start < part.end && /\s/.test(this.text[part.start])) {part.start++;}
            while (part.end > part.start && /\s/.test(this.text[part.end - 1])) {part.end--;}
            // A span the range holds whole, markers and all, and the part runs
            // into is taken in whole: its markers stay inside the new ones.
            for (let grown = part.end > part.start; grown;) {
                grown = false;
                for (const s of inside) {
                    if (s.start < part.end && part.start < s.end && (s.start < part.start || s.end > part.end)) {
                        part.start = Math.min(part.start, s.start);
                        part.end = Math.max(part.end, s.end);
                        grown = true;
                    }
                }
            }
        }
        // Parts grown into one span are one part.
        const merged: Stretch[] = [];
        for (const part of parts.filter(p => p.end > p.start)) {
            const previous = merged[merged.length - 1];
            if (previous && part.start < previous.end) {
                previous.end = Math.max(previous.end, part.end);
            } else {
                merged.push(part);
            }
        }
        return merged;
    }

    /** The exact spans of every inline marker on a line. */
    private allSpansOn(line: number): SourceSpan[] {
        return Object.values(INLINE_MARKERS).flatMap(m => (m === INLINE_MARKERS.codeInline ? [] : this.source.spansOn(line, m).filter(s => s.exact)));
    }

    /** Wraps each part as selected, the spans inside it kept. `_` widens a part to the ends of the words its ends touch. */
    private wrap(parts: Stretch[], covered: Stretch): Toggle {
        const toggle: Toggle = { ...covered, kind: 'wrap', changes: [] };
        for (const original of parts) {
            const part = opensInsideWords(this.marker) ? original : this.widened(original);
            toggle.changes.push(
                { start: part.start, end: part.start, text: this.marker, kind: 'open' },
                { start: part.end, end: part.end, text: this.marker, kind: 'close' },
            );
            toggle.start = Math.min(toggle.start, part.start);
            toggle.end = Math.max(toggle.end, part.end);
        }
        return toggle;
    }

    /** Removes the spans' markers, each as long as it was written (a code span's backtick run). */
    private unwrap(spans: SourceSpan[], covered: Stretch): Toggle {
        const distinct = [...new Set(spans)].sort((a, b) => a.start - b.start);
        return {
            start: Math.min(covered.start, distinct[0].start),
            end: Math.max(covered.end, ...distinct.map(s => s.end)),
            kind: 'unwrap',
            changes: distinct.flatMap(span => [
                { start: span.start, end: span.start + span.markup.length, text: '', kind: 'delete' as const },
                { start: span.end - span.markup.length, end: span.end, text: '', kind: 'delete' as const },
            ]),
        };
    }

    /** The marker pair at a cursor with no word, if the line stays text with it written. */
    private pair(position: vscode.Position, at: number): Toggle | undefined {
        const pair = this.marker + this.marker;
        if (!this.staysText(position, pair)) {return undefined;}
        return { start: at, end: at, kind: 'pair', changes: [{ start: at, end: at, text: pair, kind: 'pair' }] };
    }

    /**
     * Whether a line is still text, or blank, with `inserted` written at
     * `position`: `~~~~` at a line's start opens a fence, `====` under a
     * paragraph makes it a heading. The block the line is in is read again with
     * the insertion; a block that read alone is not what it is in the document
     * (a footnote's continuation, which is indented code on its own) is read
     * with the whole document.
     */
    private staysText(position: vscode.Position, inserted: string): boolean {
        const { line, character } = position;
        const env = engineEnvironment(this.document.uri);
        const kindIn = (lines: string[], at: number): LineKind => readInlineSource(this.md, lines.join('\n'), env).kindOf(at);
        const textOf = (from: number, to: number) => Array.from({ length: to - from }, (_, n) => this.document.lineAt(from + n).text);
        const original = this.document.lineAt(line).text;
        const written = original.slice(0, character) + inserted + original.slice(character);
        // From the block before it on: a paragraph above takes in a line written under it (`====`).
        const own = this.source.blockOf(line);
        const block = { start: line > 0 ? Math.min(this.source.blockOf(line - 1).start, own.start) : own.start, end: own.end };
        const lines = textOf(block.start, Math.min(block.end, this.document.lineCount));
        let kind: LineKind;
        if (kindIn(lines, line - block.start) === this.source.kindOf(line)) {
            lines[line - block.start] = written;
            kind = kindIn(lines, line - block.start);
        } else {
            const all = textOf(0, this.document.lineCount);
            all[line] = written;
            kind = kindIn(all, line);
        }
        return kind === 'text' || kind === 'blank';
    }

    /** A part taken out to the ends of the words its ends touch, so no word character stands outside its markers. */
    private widened(part: Stretch): Stretch {
        const isWord = (at: number) => at >= 0 && at < this.text.length && WORD_CHARACTER.test(this.text[at]);
        let { start, end } = part;
        while (isWord(start - 1)) {start--;}
        while (isWord(end)) {end++;}
        return { start, end };
    }

    /** The exact spans of the marker on the line a stretch starts on. */
    private spansAt(stretch: Stretch): SourceSpan[] {
        return this.spansOn(this.document.positionAt(stretch.start).line);
    }

    /** The exact spans of the marker on a line: only these are ever removed. */
    private spansOn(line: number): SourceSpan[] {
        return this.source.spansOn(line, this.marker).filter(s => s.exact);
    }

    /** Whether an offset stands inside a code span, between its backtick runs. */
    private inCode(line: number, at: number): boolean {
        return this.source.spansOn(line, INLINE_MARKERS.codeInline).some(s => s.start < at && at < s.end);
    }

    /**
     * Whether the cursor stands between the markers of a pair with nothing in
     * it, as a toggle with no word inserts one: not inside a longer run of the
     * marker's character on both sides (`***‸***` holds no empty `*`), and no
     * word touching it from outside (VS Code's word, as when the pair was
     * inserted), so the inner markers of `**bold**` are not taken for a pair.
     */
    private inEmptyPair(at: number): boolean {
        const start = at - this.marker.length, end = at + this.marker.length;
        if (start < 0 || this.text.slice(start, at) !== this.marker || this.text.slice(at, end) !== this.marker) {return false;}
        const c = this.marker[0];
        if (this.text[start - 1] === c && this.text[end] === c) {return false;}
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
