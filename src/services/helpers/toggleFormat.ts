import * as vscode from 'vscode';
import { MarkdownIt } from '../../@types/markdown-it';
import { BlockToken, InlineSource, SourceSpan } from '../../editor/inlineSource';
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

/** Where a span's marker stands once the changes are made: at a marker a change inserts, or at an offset of the text as it was. */
type Anchor = { change: MarkerChange } | { offset: number };

/** A span a toggle means to write, from its opening marker's start to its closing marker's end. */
interface Written {
    open: Anchor;
    close: Anchor;
    markup: string;
}

/**
 * What one selection toggles: the text it covers, markers included, how, the
 * changes, and what they mean — the spans written and removed, which reading
 * the text again must confirm. `alternatives` are tried, in order, when it
 * does not.
 */
interface Toggle extends Stretch {
    kind: 'wrap' | 'unwrap' | 'pair' | 'none';
    changes: MarkerChange[];
    writes: Written[];
    removes: SourceSpan[];
    alternatives: Toggle[];
}

const KIND_ORDER = { close: 0, pair: 1, open: 2, delete: 3 };

/**
 * Whether a span of the marker a selection touches becomes part of the new
 * one: `**foo**«bar»` gives `**foobar**`, `` `foo`«bar» `` gives
 * `` `foobar` `` (where the code would not read as one span, nothing is
 * made). Not yet settled with the owner; `false` wraps the selection beside
 * the span as selected.
 */
const JOINS_TOUCHING_SPANS = true;

/** A line's start of nothing but containers' markers: a quote's `>`, a bullet, a number, a task's box, a definition's `:` or `~`, a footnote's label. */
const CONTAINER_MARKERS = /^(?:[ \t]*(?:>|[-+*]|\d{1,9}[.)]|[:~]|\[[ xX]\]|\[\^[^\]\s]+\]:))*[ \t]*$/;

/** The marker's name in a hint. */
const MARKER_NAMES: Readonly<Record<string, string>> = {
    '**': 'Bold', '*': 'Italics', '_': 'Underline', '==': 'Mark', '^': 'Superscript', '~': 'Subscript', '~~': 'Strikethrough', '`': 'Code',
};

/**
 * Toggles an inline marker on every selection, in one edit, reading the
 * document as the engine reads it (`inlineSource.ts`, through `md`).
 *
 * A selection lying within a formatted span loses that span's markers — the
 * innermost such span — and a selection over several lines does when each
 * line's part lies within a span. Any other selection is wrapped as selected,
 * the spans inside it kept, so `«make **this** bold»` gives
 * `**make **this** bold**`. A span of the same marker the selection touches
 * becomes part of it (`**foo**«bar»` gives `**foobar**`), and Code takes the
 * backticks out of the code spans inside it, since code does not nest. What
 * is wrapped is each line's text the selection covers, without the whitespace
 * at its ends: a line's prefix (a bullet and its task box, a number, `#`, `>`,
 * a footnote's label, an admonition's indentation), code, inline HTML, a
 * link's URL and a table cell's padding stay outside, so a selection across a
 * link's end takes only the link's text and one over a table row formats each
 * cell. A part may run across another span's markers, a code span, an image,
 * an emoji or a footnote reference, which the markers then enclose. Over
 * several lines a line that is not text is left as it is, and so is a line
 * whose part is formatted already. Underline's `_` cannot open or close next
 * to a letter or digit, so a selection ending inside or next to a word takes
 * in the rest of the word, up to another span's marker.
 *
 * A cursor in or next to a span removes the span, and a cursor between the
 * markers of an empty pair removes the pair; otherwise it wraps the word at the
 * cursor (VS Code's word, so punctuation stays outside), and with no word there
 * the marker pair is inserted with the cursor between. Nothing is written into
 * code, a line's prefix or the inside of another span's markers.
 *
 * Every toggle is checked by reading the text again (`Verifier`): its block
 * must keep its structure, every span it writes must read as that span, every
 * empty pair it writes must be one the next press takes out, every span it
 * removes must be gone and no other span may change. One that does not pass
 * tries its alternatives (the lines of a span it holds written as one, a span
 * it crosses taken in whole), else is left out, and the status bar says so.
 * A blank line may become a thematic break (`****`) or a paragraph of the
 * pair; nothing else may change a block. Taking out an empty pair is read
 * again like every other toggle: where that would change what the text reads
 * as (`*‸**bold***`, `Title\n==‸==`), the cursor toggles as if the pair were
 * text.
 *
 * Selections whose texts overlap, and wrapped selections that touch, are
 * toggled as one selection from the first one's start to the last one's end,
 * whichever cursor is the primary one. Every selection is kept where its text
 * went.
 */
export function toggleInlineFormat(editor: vscode.TextEditor, marker: string, md: MarkdownIt): Thenable<unknown> {
    if (!editor || !editor.document) {return;}
    const document = editor.document;
    const source = inlineSourceOf(document, md);
    const toggler = new InlineToggler(document, marker, source);
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
    const chosen = new Verifier(document, source).choose(merged.map(m => m.toggle));
    const owners: Toggle[] = [];
    merged.forEach(({ members }, k) => {
        for (const i of members) {owners[i] = chosen[k];}
    });
    if (chosen.some((toggle, k) => toggle.kind === 'none' && merged[k].toggle.kind !== 'none')) {
        hint(`${MARKER_NAMES[marker] ?? marker}: left as it is where the result would not read as written.`);
    }
    const changes = chosen
        .flatMap(toggle => toggle.changes)
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

/** A short message in the status bar, where the host has one. */
function hint(text: string): void {
    if (typeof vscode.window.setStatusBarMessage === 'function') {
        vscode.window.setStatusBarMessage(text, 4000);
    }
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

function none(covered: Stretch): Toggle {
    return { ...covered, kind: 'none', changes: [], writes: [], removes: [], alternatives: [] };
}

/** What one marker does to one selection, read from the document as it was before the edit. */
class InlineToggler {
    private readonly text: string;

    constructor(
        private readonly document: vscode.TextDocument,
        private readonly marker: string,
        private readonly source: InlineSource,
    ) {
        this.text = document.getText();
    }

    toggleOf(selection: vscode.Selection): Toggle {
        const at = this.document.offsetAt(selection.active);
        const selected = { start: this.document.offsetAt(selection.start), end: this.document.offsetAt(selection.end) };
        if (selection.isEmpty && this.marker !== INLINE_MARKERS.codeInline && this.inCode(selection.active.line, at)) {return none(selected);}
        const otherwise = this.toggleAt(selection, at, selected);
        // An empty pair is taken out again before anything else is asked; where
        // reading the text again refuses that, the cursor toggles as it would
        // without the pair there (a span it stands in, the word, a pair).
        const pair = selection.isEmpty ? this.emptyPairAt(at) : undefined;
        if (pair) {
            const alternatives = otherwise.kind === 'none' ? [] : [otherwise, ...otherwise.alternatives];
            return { ...pair, kind: 'unwrap', changes: [{ ...pair, text: '', kind: 'delete' }], writes: [], removes: [], alternatives };
        }
        return otherwise;
    }

    /** What a selection toggles but for an empty pair at a cursor. */
    private toggleAt(selection: vscode.Selection, at: number, selected: Stretch): Toggle {
        const literal = this.source.kindOf(selection.start.line) === 'literal';
        if (selection.isSingleLine && literal) {return none(selected);}
        if (selection.isEmpty) {
            const line = selection.active.line;
            const span = innermost(this.spansOn(line).filter(s => s.start <= at && at <= s.end));
            if (span) {return this.unwrap([span], span);}
            const word = this.document.getWordRangeAtPosition(selection.active);
            if (!word) {return this.pair(line, at) ?? none(selected);}
            const part = this.partsOn(line, this.document.offsetAt(word.start), this.document.offsetAt(word.end))
                .find(p => p.start <= at && at <= p.end);
            return part ? this.wrap([part], part) : none(selected);
        }
        const parts = this.partsOf(selection);
        if (!parts.length) {
            // Code is no text a part takes: a selection over code spans and the spaces between them removes them.
            const codes: SourceSpan[] = [];
            for (let line = selection.start.line; this.marker === INLINE_MARKERS.codeInline && line <= selection.end.line; line++) {
                codes.push(...this.spansOn(line).filter(s => s.start < selected.end && selected.start < s.end));
            }
            return codes.length ? this.unwrap(codes, selected) : none(selected);
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
     * either end, and grown over a span of the line the range holds whole.
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
        const lineStart = this.document.offsetAt(new vscode.Position(line, 0));
        const lineEnd = lineStart + this.document.lineAt(line).text.length;
        const inside = this.allSpansOn(line).filter(s => Math.max(from, lineStart) <= s.start && s.end <= Math.min(to, lineEnd));
        for (const part of parts) {
            while (part.start < part.end && /\s/.test(this.text[part.start])) {part.start++;}
            while (part.end > part.start && /\s/.test(this.text[part.end - 1])) {part.end--;}
            // A span the range holds whole, markers and all, and the part runs
            // into is taken in whole: its markers stay inside the new ones.
            this.grow(part, inside);
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

    /** A part grown until no span of `spans` it runs into stands partly outside it. */
    private grow(part: Stretch, spans: SourceSpan[]): void {
        for (let grown = part.end > part.start; grown;) {
            grown = false;
            for (const s of spans) {
                if (s.start < part.end && part.start < s.end && (s.start < part.start || s.end > part.end)) {
                    part.start = Math.min(part.start, s.start);
                    part.end = Math.max(part.end, s.end);
                    grown = true;
                }
            }
        }
    }

    /** The exact spans of every inline marker on a line, code spans included. */
    private allSpansOn(line: number): SourceSpan[] {
        return this.source.spansOn(line).filter(s => s.exact);
    }

    /**
     * Wraps each part. A span of the marker a part touches is joined to it,
     * its marker there taken out; Code takes the backticks out of the code
     * spans a part runs into. The alternatives: the parts of lines a span the
     * selection holds runs across written as one, from the first line's part
     * to the last's (`*x **a\nb** y*`); then every span a part crosses — one
     * it holds an end of — on the part's line taken in whole.
     */
    private wrap(parts: Stretch[], covered: Stretch): Toggle {
        const primary = this.wrapped(parts, covered, false);
        const joined: Stretch[] = [];
        for (const part of parts) {
            const previous = joined[joined.length - 1];
            const line = previous === undefined ? -1 : this.document.positionAt(previous.end).line;
            if (previous && this.allSpansOn(line).some(s => previous.start <= s.start && s.start < previous.end && part.start < s.end && s.end <= part.end)) {
                previous.end = part.end;
            } else {
                joined.push({ ...part });
            }
        }
        if (joined.length < parts.length) {
            primary.alternatives.push(this.wrapped(joined, covered, false));
        }
        const crossing = parts.map(part => ({ ...part }));
        let crosses = false;
        for (const part of crossing) {
            const line = this.document.positionAt(part.start).line;
            const before = { ...part };
            this.grow(part, this.allSpansOn(line).filter(s => s.start < part.end && part.start < s.end));
            crosses = crosses || before.start !== part.start || before.end !== part.end;
        }
        if (crosses) {
            primary.alternatives.push(this.wrapped(crossing, covered, true));
        }
        return primary;
    }

    private wrapped(parts: Stretch[], covered: Stretch, whole: boolean): Toggle {
        const length = this.marker.length;
        const toggle: Toggle = { ...covered, kind: 'wrap', changes: [], writes: [], removes: [], alternatives: [] };
        const code = this.marker === INLINE_MARKERS.codeInline;
        for (const original of parts) {
            let part = opensInsideWords(this.marker) ? { ...original } : this.widened(original);
            const line = this.document.positionAt(part.start).line;
            let open: Anchor | undefined;
            let close: Anchor | undefined;
            if (code) {
                // Code does not nest: the code spans the part runs into lose their backticks, and so do those it touches.
                const codes = this.spansOn(line).filter(s => (s.start < part.end && part.start < s.end)
                    || (JOINS_TOUCHING_SPANS && (s.end === part.start || s.start === part.end)));
                for (const s of codes) {
                    part = { start: Math.min(part.start, s.start), end: Math.max(part.end, s.end) };
                    toggle.changes.push(
                        { start: s.start, end: s.start + s.markup.length, text: '', kind: 'delete' },
                        { start: s.end - s.markup.length, end: s.end, text: '', kind: 'delete' },
                    );
                    toggle.removes.push(s);
                }
            } else if (!whole && JOINS_TOUCHING_SPANS) {
                // A span of the marker the part touches becomes part of the new one.
                const left = this.spansOn(line).find(s => s.end === part.start);
                const right = this.spansOn(this.document.positionAt(part.end).line).find(s => s.start === part.end);
                if (left) {
                    toggle.changes.push({ start: left.end - length, end: left.end, text: '', kind: 'delete' });
                    toggle.removes.push(left);
                    open = { offset: left.start };
                    part = { start: left.start, end: part.end };
                }
                if (right) {
                    toggle.changes.push({ start: right.start, end: right.start + length, text: '', kind: 'delete' });
                    toggle.removes.push(right);
                    close = { offset: right.end };
                    part = { start: part.start, end: right.end };
                }
            }
            if (open === undefined) {
                const change: MarkerChange = { start: part.start, end: part.start, text: this.marker, kind: 'open' };
                toggle.changes.push(change);
                open = { change };
            }
            if (close === undefined) {
                const change: MarkerChange = { start: part.end, end: part.end, text: this.marker, kind: 'close' };
                toggle.changes.push(change);
                close = { change };
            }
            toggle.writes.push({ open, close, markup: this.marker });
            toggle.start = Math.min(toggle.start, part.start);
            toggle.end = Math.max(toggle.end, part.end);
        }
        return toggle;
    }

    /** Removes the spans' markers, each as long as it was written (a code span's backtick run). */
    private unwrap(spans: SourceSpan[], covered: Stretch): Toggle {
        // One span over several lines is found on each of them.
        const distinct = [...new Map(spans.map(s => [`${s.start}:${s.end}`, s])).values()].sort((a, b) => a.start - b.start);
        return {
            start: Math.min(covered.start, distinct[0].start),
            end: Math.max(covered.end, ...distinct.map(s => s.end)),
            kind: 'unwrap',
            changes: distinct.flatMap(span => [
                { start: span.start, end: span.start + span.markup.length, text: '', kind: 'delete' as const },
                { start: span.end - span.markup.length, end: span.end, text: '', kind: 'delete' as const },
            ]),
            writes: [],
            removes: distinct,
            alternatives: [],
        };
    }

    /**
     * The marker pair at a cursor with no word: in the line's text, or on a
     * line with none — not in a line's prefix before its text, and not inside
     * a run of another span's marker. A line of a block's syntax with no text
     * gets it only at its end, after nothing but a container's marker: an
     * empty list item, quote or definition (`- `, `> `, `: `); a reference's
     * or an abbreviation's definition is no place for one.
     */
    private pair(line: number, at: number): Toggle | undefined {
        const stretches = this.source.textOn(line);
        if (stretches.length > 0 && !stretches.some(s => s.start <= at && at <= s.end)) {
            if (at < stretches[0].start) {return undefined;}
            const before = this.text[at - 1];
            if (before !== undefined && before === this.text[at] && /[*_~^=`]/.test(before)) {return undefined;}
        }
        if (stretches.length === 0 && this.source.kindOf(line) === 'structure') {
            const text = this.document.lineAt(line).text;
            const column = at - this.document.offsetAt(new vscode.Position(line, 0));
            if (!/^\s*$/.test(text.slice(column)) || !CONTAINER_MARKERS.test(text.slice(0, column))) {return undefined;}
        }
        const pair = this.marker + this.marker;
        return { start: at, end: at, kind: 'pair', changes: [{ start: at, end: at, text: pair, kind: 'pair' }], writes: [], removes: [], alternatives: [] };
    }

    /** A part taken out to the ends of the words its ends touch, in the line's text, so no word character stands outside its markers. */
    private widened(part: Stretch): Stretch {
        const stretches = this.source.textOn(this.document.positionAt(part.start).line);
        const isText = (at: number) => stretches.some(s => s.start <= at && at < s.end);
        const isWord = (at: number) => at >= 0 && at < this.text.length && WORD_CHARACTER.test(this.text[at]) && isText(at);
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
     * The empty pair the cursor stands in, as a toggle with no word inserts
     * one: the marker on both sides, no word touching it from outside (VS
     * Code's word, as when the pair was inserted), so the inner markers of
     * `**bold**` are not taken for a pair, and the marker's runs around it as
     * `isEmptyPair` allows.
     */
    private emptyPairAt(at: number): Stretch | undefined {
        const length = this.marker.length;
        const start = at - length, end = at + length;
        if (!isEmptyPair(this.text, at, this.marker)) {return undefined;}
        const wordAt = (offset: number) => !!this.document.getWordRangeAtPosition(this.document.positionAt(offset));
        if (wordAt(start) || wordAt(end)) {return undefined;}
        return { start, end };
    }
}

/**
 * Whether `at` in `text` stands between the two markers of an empty pair.
 * Where the marker's character runs on further on both sides, the runs must
 * be equal and the rest of them another marker of that character, so
 * `***‸***` is Italics in an empty Bold (or the other way round); with one
 * side exactly the marker, the run on the other is a span's beside it
 * (`**b***‸*`).
 */
function isEmptyPair(text: string, at: number, marker: string): boolean {
    const length = marker.length;
    if (at < length || text.slice(at - length, at) !== marker || text.slice(at, at + length) !== marker) {return false;}
    const c = marker[0];
    let left = 0;
    while (text[at - 1 - left] === c) {left++;}
    let right = 0;
    while (text[at + right] === c) {right++;}
    const nested = left === right && Object.values(INLINE_MARKERS).some(m => m[0] === c && m !== marker && m.length === left - length && /^(.)\1*$/.test(m));
    return left === length || right === length || nested;
}

/** Some lines of the document a toggle is read again with: `[start, end)`, from offset `base`, their text and its reading. */
interface Part {
    start: number;
    end: number;
    base: number;
    text: string;
    before: InlineSource;
}

/**
 * What reading toggles again found: the toggles that went wrong (none when all
 * is well), and of those the ones blamed beside another toggle, for what went
 * wrong in an inline token both write in; or `'all'` where what went wrong is
 * no one toggle's — a block's structure, a line's kind, a definition.
 */
type Verdict = { failed: Set<Toggle>; shared: Set<Toggle> } | 'all';

/**
 * Whether toggles do what they mean, by reading the text again: the blocks
 * they touch are written over and parsed once, as the document parses them
 * (`InlineSource.readPart`), and compared with the same lines as they read
 * (`check` states what is compared).
 */
class Verifier {
    private readonly text: string;
    private readonly lines: number;
    private readonly parts = new Map<string, Part>();

    constructor(private readonly document: vscode.TextDocument, private readonly source: InlineSource) {
        this.text = document.getText();
        this.lines = document.lineCount;
    }

    /**
     * Each toggle, or one of its alternatives, that passes; a `none` toggle for
     * one that does not. The toggles whose lines meet are read again together
     * (`together`); where what goes wrong is no one toggle's, the toggles
     * that go wrong on their own lines alone are found first (`isolated`).
     */
    choose(toggles: Toggle[]): Toggle[] {
        const chosen = toggles.map(t => (t.kind === 'none' ? t : none(t)));
        for (const unit of this.units(toggles)) {
            const members = unit.members.filter(i => toggles[i].kind !== 'none');
            if (!members.length) {continue;}
            const own = members.map(i => toggles[i]);
            const part = this.part(unit.start, unit.end);
            const picked = this.together(part, own) ?? this.isolated(part, own);
            members.forEach((i, k) => {
                chosen[i] = picked[k];
            });
        }
        return chosen;
    }

    /**
     * Toggles a reading together found what is no one toggle's in — a
     * block's structure, a line's kind, a definition: each is read again with
     * its own lines alone (`rangeOf`), once, as it means to be made. Those
     * that go wrong there are tried one after another (`oneByOne`), with
     * their alternatives, after the rest are read together again; where no
     * toggle goes wrong alone, it is what some make together, and all are
     * tried one after another.
     */
    private isolated(part: Part, toggles: Toggle[]): Toggle[] {
        const wrong = toggles.map(t => {
            const range = this.rangeOf(t);
            return this.check(this.part(range.start, range.end), [t]) === 'all';
        });
        if (!wrong.includes(true)) {return this.oneByOne(toggles);}
        const rest = toggles.filter((_, k) => !wrong[k]);
        const restPicked = rest.length ? this.together(part, rest) ?? this.oneByOne(rest) : [];
        const taken = restPicked.flatMap((option, k) => (option.kind === 'none' ? [] : [{ toggle: option, ...this.rangeOf(rest[k]) }]));
        const culprits = this.oneByOne(toggles.filter((_, k) => wrong[k]), taken);
        let r = 0, c = 0;
        return toggles.map((_, k) => (wrong[k] ? culprits[c++] : restPicked[r++]));
    }

    /**
     * The toggles read again together, each as its first option; each one a
     * reading blames on its own goes on to its next option, or is left out
     * after its last, until a reading finds nothing wrong — a few parses of
     * the lines however many toggles there are. Toggles blamed beside each
     * other, for what went wrong where both write, are set aside and tried
     * after that in document order, each with the ones taken before it, by
     * halves that pass together. `undefined` where a reading finds what is no
     * one toggle's.
     */
    private together(part: Part, toggles: Toggle[]): Toggle[] | undefined {
        const options = toggles.map(t => [t, ...t.alternatives]);
        const at = toggles.map(() => 0);
        const aside = new Set<number>();
        for (;;) {
            const live = toggles.map((_, k) => k).filter(k => at[k] < options[k].length && !aside.has(k));
            const verdict = this.check(part, live.map(k => options[k][at[k]]));
            if (verdict === 'all') {return undefined;}
            if (verdict.failed.size === 0) {break;}
            for (const k of live) {
                const option = options[k][at[k]];
                if (verdict.shared.has(option)) {
                    aside.add(k);
                } else if (verdict.failed.has(option)) {
                    at[k]++;
                }
            }
        }
        const picked = toggles.map((_, k) => (at[k] < options[k].length && !aside.has(k) ? options[k][at[k]] : undefined));
        // By halves, the earlier first, each with the ones taken before it: a
        // half that passes together is taken whole, so of many toggles in one
        // inline token, one going wrong costs a few readings, not one each.
        const settle = (ks: number[]) => {
            const taken = picked.filter((p): p is Toggle => p !== undefined);
            if (ks.length > 1) {
                if (passed(this.check(part, [...taken, ...ks.map(k => options[k][at[k]])]))) {
                    for (const k of ks) {picked[k] = options[k][at[k]];}
                    return;
                }
                const half = ks.length >> 1;
                settle(ks.slice(0, half));
                settle(ks.slice(half));
                return;
            }
            const k = ks[0];
            picked[k] = options[k].slice(at[k]).find(option => passed(this.check(part, [...taken, option])));
        };
        if (aside.size > 0) {settle([...aside].sort((x, y) => x - y));}
        return picked.map((p, k) => p ?? none(toggles[k]));
    }

    /**
     * Each toggle, one after another, with the ones taken before it (`taken`
     * to start with): read with its own lines (`rangeOf`) and the lines of
     * each toggle taken whose own lines meet them — those alone, so the lines
     * read stay a toggle's neighbourhood however many toggles there are.
     */
    private oneByOne(toggles: Toggle[], taken: { toggle: Toggle; start: number; end: number }[] = []): Toggle[] {
        return toggles.map(toggle => {
            const own = this.rangeOf(toggle);
            const near = taken.filter(t => t.start < own.end && own.start < t.end);
            const start = Math.min(own.start, ...near.map(t => t.start));
            const end = Math.max(own.end, ...near.map(t => t.end));
            const part = this.part(start, end);
            const option = [toggle, ...toggle.alternatives].find(o => passed(this.check(part, [...near.map(t => t.toggle), o])));
            if (option === undefined) {return none(toggle);}
            taken.push({ toggle: option, ...own });
            return option;
        });
    }

    /** Lines `[start, end)` of the document and their reading, read once per verification. */
    private part(start: number, end: number): Part {
        const key = `${start}:${end}`;
        let part = this.parts.get(key);
        if (part === undefined) {
            const base = this.offsetOfLine(start);
            const text = this.text.slice(base, this.offsetOfLine(end));
            part = { start, end, base, text, before: this.source.readPart(text) };
            this.parts.set(key, part);
        }
        return part;
    }

    private offsetOfLine(line: number): number {
        return line >= this.lines ? this.text.length : this.document.offsetAt(new vscode.Position(line, 0));
    }

    /**
     * The lines a toggle is read again with: the top-level blocks it or one of
     * its alternatives touches, the block before them, across blank lines (a
     * paragraph takes in a line written under it, a list's item goes on after
     * one), and the block after them, across blank lines (a line written
     * above it may join it: a setext underline, indented code, a table); the
     * whole document for a footnote's definition.
     */
    private rangeOf(toggle: Toggle): { start: number; end: number } {
        const options = [toggle, ...toggle.alternatives];
        const first = this.document.positionAt(Math.min(...options.map(o => o.start))).line;
        const last = this.document.positionAt(Math.max(...options.map(o => o.end))).line;
        const a = this.source.blockOf(first);
        const b = this.source.blockOf(last);
        if (a.whole || b.whole) {return { start: 0, end: this.lines };}
        let start = Math.min(a.start, b.start);
        let end = Math.max(a.end, b.end);
        let previous = start - 1;
        while (previous >= 0 && this.source.kindOf(previous) === 'blank') {previous--;}
        if (previous >= 0) {
            const block = this.source.blockOf(previous);
            start = block.whole ? 0 : Math.min(start, block.start);
        }
        let next = end;
        while (next < this.lines && this.source.kindOf(next) === 'blank') {next++;}
        if (next < this.lines) {
            const block = this.source.blockOf(next);
            end = block.whole ? this.lines : Math.max(end, block.end);
        }
        return { start, end };
    }

    /** Each toggle's lines (`rangeOf`); units that overlap are one. */
    private units(toggles: Toggle[]): { start: number; end: number; members: number[] }[] {
        const ranges = toggles.map((toggle, i) => ({ ...this.rangeOf(toggle), members: [i] }))
            .sort((x, y) => x.start - y.start);
        const units: { start: number; end: number; members: number[] }[] = [];
        for (const range of ranges) {
            const last = units[units.length - 1];
            if (last && range.start < last.end) {
                last.end = Math.max(last.end, range.end);
                last.members.push(...range.members);
            } else {
                units.push(range);
            }
        }
        return units;
    }

    /**
     * The toggles, made together in a part, read again. What is compared, the
     * part as it is (`before`) and as written over (`after`), is all here:
     *
     * - nothing is written into a literal line (code, HTML, front matter);
     * - an empty pair written is one the next press finds, to take it out
     *   again: not a run of its character (`****‸****`);
     * - every element keeps its attributes (markdown-it-attrs' `{…}`): a block
     *   token's are compared with the block, another inline token's with the
     *   token, a span's with the span, and a span the toggles write or remove
     *   holds none, so no attribute goes from one element to another;
     * - the part has as many lines, each of the same kind and the same block
     *   tokens, except a line blank before or after, or with no text but the
     *   markers either time, which may become a paragraph of pairs or a
     *   thematic break and back, and a bare `: ` line, in a quote too, a pair
     *   is written on or taken from, which it makes a definition: the
     *   definition's own tokens, starting on its line or its term's, may
     *   come or go, the blocks around it may not;
     * - the part defines the same references (destinations and titles),
     *   footnotes and abbreviations (`InlineSource.defines`);
     * - every inline token holds the same tokens besides text and spans'
     *   markers — links' and images' destinations, inline HTML, math, emoji,
     *   footnote references and their notes, line breaks, and code spans
     *   unless the toggles write or remove one (`InlineSource.inlines`);
     * - every span written reads as that span, every span removed is gone,
     *   every other span reads as before, moved, with its attributes, and
     *   every inline token holds as many spans of each marker and attributes,
     *   those not placed exactly included;
     * - every character read as text is text after, where it moved to, and
     *   none comes in but the markers written, whitespace aside.
     *
     * A failure in an inline token blames the toggles that change its lines.
     */
    private check(part: Part, toggles: Toggle[]): Verdict {
        const { base, text, before } = part;
        const owner = new Map<MarkerChange, Toggle>();
        for (const t of toggles) {
            for (const change of t.changes) {owner.set(change, t);}
        }
        const failed = new Set<Toggle>();
        const shared = new Set<Toggle>();
        const changes = toggles.flatMap(t => t.changes)
            .map(change => ({ change, start: change.start - base, end: change.end - base, line: this.document.positionAt(change.start).line - part.start }))
            .sort((a, b) => a.start - b.start || KIND_ORDER[a.change.kind] - KIND_ORDER[b.change.kind]);
        // What went wrong on some lines blames the toggles that change them, beside each other when more than one does.
        const onLine = new Map<number, typeof changes>();
        for (const c of changes) {
            const here = onLine.get(c.line);
            if (here === undefined) {
                onLine.set(c.line, [c]);
            } else {
                here.push(c);
            }
        }
        let unplaced = false;
        const blame = (first: number, end: number) => {
            const blamed = new Set<Toggle>();
            for (let line = first; line < end; line++) {
                for (const c of onLine.get(line) ?? []) {blamed.add(owner.get(c.change));}
            }
            for (const t of blamed) {
                failed.add(t);
                if (blamed.size > 1) {shared.add(t);}
            }
            unplaced = unplaced || blamed.size === 0;
        };
        for (const c of changes) {
            if (this.source.kindOf(c.line + part.start) === 'literal') {failed.add(owner.get(c.change));}
        }
        // The text written over, and where each change's text and each old offset land in it.
        const placed = new Map<MarkerChange, number>();
        let out = '';
        let read = 0;
        for (const c of changes) {
            if (c.start < read) {return 'all';}
            out += text.slice(read, c.start);
            placed.set(c.change, out.length);
            out += c.change.text;
            read = c.end;
        }
        out += text.slice(read);
        for (const c of changes) {
            if (c.change.kind === 'pair') {
                const marker = c.change.text.slice(0, c.change.text.length / 2);
                if (!isEmptyPair(out, (placed.get(c.change) ?? 0) + marker.length, marker)) {blame(c.line, c.line + 1);}
            }
        }
        if (failed.size > 0) {return { failed, shared };}
        /** Where offset `o` of the old text lands: before (`left`) or after (`right`) what is inserted there. */
        const mapped = (o: number, side: 'left' | 'right'): number => {
            let shift = 0;
            for (const c of changes) {
                if (c.start > o || (c.start === o && (side === 'left' || c.end > c.start))) {break;}
                if (c.end <= o) {
                    shift += c.change.text.length - (c.end - c.start);
                } else {
                    return -1;
                }
            }
            return o + shift;
        };
        const after = this.source.readPart(out);
        const count = before.lineCount;
        if (after.lineCount !== count) {return 'all';}
        // A definition's `:` alone is text until something follows it: written
        // there, the pair makes it the definition it was meant to be. Its
        // line and its term's may change their blocks; no other line may. So
        // may it when the pair is taken out again.
        const defining = toggles.filter(t => t.writes.length === 0 && t.removes.length === 0 && t.changes.length === 1)
            .filter(t => {
                const line = this.document.lineAt(this.document.positionAt(t.start).line);
                const from = this.document.offsetAt(line.range.start);
                const c = t.changes[0];
                // The line without the pair.
                const bare = line.text.slice(0, c.start - from) + line.text.slice(c.end - from);
                return BARE_DEFINITION.test(bare);
            })
            .map(t => this.document.positionAt(t.start).line - part.start);
        // The structure. A free line is blank before or after, or holds no text
        // but the markers taken out or written either time: a blank line that
        // becomes the pair's paragraph or a thematic break, an empty item that
        // gets the pair, and the way back; and a definition's `:` line.
        const markers = (stretches: { start: number; end: number }[], ranges: number[][]) =>
            stretches.every(s => ranges.some(([from, to]) => from <= s.start && s.end <= to));
        const takenOf = (cs: typeof changes) => cs.filter(c => c.end > c.start).map(c => [c.start, c.end]);
        const writtenOf = (cs: typeof changes) => cs.filter(c => c.change.text !== '').map(c => [placed.get(c.change), placed.get(c.change) + c.change.text.length]);
        const written = writtenOf(changes);
        const free = new Set<number>();
        for (let line = 0; line < count; line++) {
            const kinds = [before.kindOf(line), after.kindOf(line)];
            const here = onLine.get(line) ?? [];
            const empty = markers(before.textOn(line), takenOf(here)) && markers(after.textOn(line), writtenOf(here));
            if (empty || kinds.includes('blank') || defining.includes(line)) {
                free.add(line);
            }
            if (kinds[0] !== kinds[1] && (kinds.includes('literal') || !free.has(line))) {return 'all';}
        }
        const kept = (structure: readonly BlockToken[]) => structure.filter(({ type, first, end }) => {
            // The definition's own tokens start on its term's line or its `:` line; the blocks around it are compared.
            if (DEFINITION_TOKENS.has(type) && defining.some(line => first === line || first === line - 1)) {return false;}
            // A paragraph of pairs alone, over one line or more, may come or go.
            if (!FREE_TOKENS.has(type)) {return true;}
            for (let line = first; line < Math.max(end, first + 1); line++) {
                if (!free.has(line)) {return true;}
            }
            return false;
        });
        // A block keeps its attributes; it may end later or sooner by lines with no text (an item taking in its thematic break).
        const same = (x: BlockToken, y: BlockToken) => {
            if (x.type !== y.type || x.nesting !== y.nesting || x.first !== y.first || x.attrs !== y.attrs) {return false;}
            if (x.end !== y.end && !CONTAINERS.test(x.type)) {return false;}
            const low = Math.min(x.end, y.end), high = Math.max(x.end, y.end);
            for (let line = low; line < high; line++) {
                if (!free.has(line)) {return false;}
            }
            return true;
        };
        const a = kept(before.structure), b = kept(after.structure);
        if (a.length !== b.length || a.some((entry, k) => !same(entry, b[k]))) {return 'all';}
        // The definitions.
        if (before.defines !== after.defines) {return 'all';}
        /** Per line, the first inline token that maps it, or -1. */
        const inlineIndex = (source: InlineSource) => {
            const at = new Int32Array(count).fill(-1);
            source.inlines.forEach((inline, k) => {
                for (let line = inline.first; line < Math.min(inline.end, count); line++) {
                    if (at[line] < 0) {at[line] = k;}
                }
            });
            return at;
        };
        const beforeIndex = inlineIndex(before), afterIndex = inlineIndex(after);
        const blameAt = (source: InlineSource, offset: number) => {
            const line = source.lineOf(offset);
            const inline = source.inlines[(source === before ? beforeIndex : afterIndex)[line]];
            blame(inline?.first ?? line, inline?.end ?? line + 1);
        };
        // Each inline token by its lines, as the same in both readings: a cell by
        // its place in its row; a definition's term and its `:`, one paragraph
        // before and two blocks after, as one.
        const keysOf = (source: InlineSource) => {
            const onLine = new Map<number, number>();
            return source.inlines.map(inline => {
                const term = defining.find(line => inline.first <= line && inline.end > line - 1);
                if (term !== undefined) {return { key: `:${term}`, first: term - 1, end: term + 1 };}
                const k = onLine.get(inline.first) ?? 0;
                onLine.set(inline.first, k + 1);
                return { key: `${inline.first}#${k}`, first: inline.first, end: inline.end };
            });
        };
        const beforeKeys = keysOf(before), afterKeys = keysOf(after);
        /** The inline token an offset stands in. */
        const inlineAt = (source: InlineSource, keys: { key: string; first: number; end: number }[], offset: number) => {
            const line = source.lineOf(offset);
            const k = (source === before ? beforeIndex : afterIndex)[line];
            return k < 0 ? { key: `${line}`, first: line, end: line + 1 } : keys[k];
        };
        // The inline tokens' other tokens.
        const code = toggles.some(t => t.writes.some(w => w.markup.startsWith('`')) || t.removes.some(s => s.markup.startsWith('`')));
        const contents = (source: InlineSource, keys: { key: string; first: number; end: number }[]) => {
            const byKey = new Map<string, { first: number; end: number; tokens: string[] }>();
            source.inlines.forEach((inline, k) => {
                const { key, first, end } = keys[k];
                const entry = byKey.get(key) ?? { first, end, tokens: [] };
                const tokens = code ? inline.tokens.filter(t => !t.startsWith('["code_inline"')) : inline.tokens;
                entry.tokens.push(...(key.startsWith(':') ? tokens.filter(t => !t.startsWith('["softbreak"')) : tokens));
                byKey.set(key, entry);
            });
            return byKey;
        };
        const was = contents(before, beforeKeys), now = contents(after, afterKeys);
        for (const key of new Set([...was.keys(), ...now.keys()])) {
            const x = was.get(key), y = now.get(key);
            const inline = x ?? y;
            // A paragraph of pairs alone, which may come or go, holds at most their line breaks.
            let alone = x === undefined || y === undefined;
            for (let line = inline.first; alone && line < inline.end; line++) {alone = free.has(line);}
            if (!alone && JSON.stringify(x?.tokens ?? []) !== JSON.stringify(y?.tokens ?? [])) {
                blame(inline.first, inline.end);
            }
        }
        // The spans: the old ones, moved, without the removed ones, and the written ones.
        const removed = new Set(toggles.flatMap(t => t.removes).map(s => `${s.markup}@${s.start - base}:${s.end - base}`));
        const spansOf = (source: InlineSource) => {
            const all = new Map<string, SourceSpan>();
            for (let line = 0; line < count; line++) {
                for (const s of source.spansOn(line)) {all.set(`${s.markup}@${s.start}:${s.end}`, s);}
            }
            return all;
        };
        const old = spansOf(before), spans = spansOf(after);
        const found = new Map([...spans].filter(([, s]) => s.exact));
        // Every span counted by inline token and marker, one placed exactly or not:
        // a span the alignment cannot place may not go or come either.
        // Counted with its attributes, which no span gains or loses either.
        const tally = new Map<string, { first: number; end: number; count: number }>();
        const count1 = (at: { key: string; first: number; end: number }, markup: string, attrs: string, by: number) => {
            const entry = tally.get(`${at.key} ${markup} ${attrs}`) ?? { first: at.first, end: at.end, count: 0 };
            entry.count += by;
            tally.set(`${at.key} ${markup} ${attrs}`, entry);
        };
        for (const [key, s] of old) {
            if (!removed.has(key)) {
                count1(inlineAt(before, beforeKeys, s.start), s.markup, s.attrs, 1);
            } else if (s.attrs !== '') {
                // Its attributes would go to the element around it.
                blameAt(before, s.start);
            }
        }
        for (const s of spans.values()) {
            count1(inlineAt(after, afterKeys, s.start), s.markup, s.attrs, -1);
        }
        const expected = new Set<string>();
        const writtenSpans: number[][] = [];
        for (const t of toggles) {
            for (const w of t.writes) {
                const position = (anchor: Anchor, edge: 'open' | 'close') => {
                    if ('change' in anchor) {
                        const at = placed.get(anchor.change);
                        return edge === 'open' ? at : at + anchor.change.text.length;
                    }
                    return mapped(anchor.offset - base, 'left');
                };
                const start = position(w.open, 'open');
                const end = position(w.close, 'close');
                const key = `${w.markup}@${start}:${end}`;
                // A span written takes no attributes from the element around it.
                if (found.get(key)?.attrs === '') {
                    expected.add(key);
                    writtenSpans.push([start, end]);
                    count1(inlineAt(after, afterKeys, start), w.markup, '', 1);
                } else {
                    // Its inline token's other toggles may be why: they are blamed beside it.
                    const at = inlineAt(after, afterKeys, Math.max(0, Math.min(start, out.length)));
                    blame(at.first, at.end);
                }
            }
        }
        for (const entry of tally.values()) {
            if (entry.count !== 0) {blame(entry.first, entry.end);}
        }
        for (const [key, s] of old) {
            if (removed.has(key)) {continue;}
            const starts = [mapped(s.start, 'left'), mapped(s.start, 'right')];
            const ends = [mapped(s.end, 'left'), mapped(s.end, 'right')];
            const moved = starts.flatMap(x => ends.map(y => `${s.markup}@${x}:${y}`)).find(k => found.get(k)?.attrs === s.attrs);
            if (moved) {
                expected.add(moved);
            } else if (s.exact) {
                blameAt(before, s.start);
            }
        }
        for (const [key, s] of found) {
            if (!expected.has(key)) {blameAt(after, s.start);}
        }
        // The text: every character read as text before is text after, where
        // it moved to, and none comes in but the markers written — save what a
        // code span written or taken out turns from text into code or back,
        // and a definition's `:`, which the pair makes its marker. Whitespace
        // is left out: a line's last space is text only once something
        // follows it.
        const textOf = (source: InlineSource, of: string) => {
            const at = new Uint8Array(of.length + 1);
            for (let line = 0; line < count; line++) {
                if (defining.includes(line)) {continue;}
                for (const s of source.textOn(line)) {
                    for (let o = s.start; o < s.end; o++) {
                        if (!/\s/.test(of[o])) {at[o] = 1;}
                    }
                }
            }
            return at;
        };
        const flags = (length: number, ranges: number[][]) => {
            const at = new Uint8Array(length + 1);
            for (const [from, to] of ranges) {
                for (let o = Math.max(0, from); o < Math.min(to, length); o++) {at[o] = 1;}
            }
            return at;
        };
        const coded = flags(out.length, code ? writtenSpans : []);
        const incoming = flags(out.length, [...written, ...(code ? toggles.flatMap(t => t.removes).map(s => [mapped(s.start - base, 'left'), mapped(s.end - base, 'right')]) : [])]);
        const textBefore = textOf(before, text), textAfter = textOf(after, out);
        // Each old character where it went, in one pass over the changes (`mapped`, `right`).
        let next = 0;
        let shift = 0;
        for (let o = 0; o < text.length; o++) {
            while (next < changes.length) {
                const c = changes[next];
                if (c.start > o || (c.start === o && c.end > c.start) || c.end > o) {break;}
                shift += c.change.text.length - (c.end - c.start);
                next++;
            }
            const deleted = next < changes.length && changes[next].start <= o && o < changes[next].end;
            if (textBefore[o] === 0 || deleted) {continue;}
            const to = o + shift;
            if (textAfter[to] === 1 && out[to] === text[o]) {
                textAfter[to] = 2;
            } else if (coded[to] === 0) {
                blameAt(before, o);
            }
        }
        for (let o = 0; o < out.length; o++) {
            if (textAfter[o] === 1 && incoming[o] === 0) {blameAt(after, o);}
        }
        return unplaced ? 'all' : { failed, shared };
    }
}

/** Whether a check found nothing wrong. */
function passed(verdict: Verdict): boolean {
    return verdict !== 'all' && verdict.failed.size === 0;
}

/** A definition's `:` (or `~`) line with nothing after it, inside a quote's `>`s too: a pair written at its end makes it a definition. */
const BARE_DEFINITION = /^(?:[ \t]*>)*[ \t]*[:~][ \t]+$/;

/** The block tokens of one definition, which a pair written on its `:` line makes, or takes back out: the list, the term, the definition, a paragraph. */
const DEFINITION_TOKENS: ReadonlySet<string> = new Set(['dl_open', 'dt_open', 'dd_open', 'paragraph_open']);

/** Block tokens that hold blocks, which may take in or give up a line with no text at their end. */
const CONTAINERS = /(?:list|item|blockquote|dl|dd|admonition|container)_open$/;

/** The block tokens a line with no text may gain or lose: a paragraph of the pair alone, a thematic break. */
const FREE_TOKENS: ReadonlySet<string> = new Set(['paragraph_open', 'paragraph_close', 'inline', 'hr']);

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
