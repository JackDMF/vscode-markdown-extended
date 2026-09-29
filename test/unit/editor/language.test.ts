import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { parseDocument } from '../../../src/editor/parse';
import { PositionMap, SourceRange, createPositionMap } from '../../../src/editor/positions';
import type { CompletionEntry, DiagnosticEntry } from '../../../src/editor/protocol';
import { filterCompletions, isWordCharacter, listKeyAction } from '../../../src/editor/webview/completion';
import { DiagnosticMark, diagnosticCounts, diagnosticMarks, worse } from '../../../src/editor/webview/diagnostics';
import { hostEngine } from './helpers';

const SOURCE = [
    'Intro paragraph with a word.',
    '',
    'Second *paragraph* here.',
    '',
    '<div class="box">',
    '  <b>raw</b> html',
    '</div>',
    '',
    '- item one',
    '- item two',
    '',
].join('\n');

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number): SourceRange {
    return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function warning(r: SourceRange, message = 'look here'): DiagnosticEntry {
    return { range: r, severity: 'warning', message };
}

/**
 * The mapping of diagnostics onto the page (`diagnosticMarks`): an exact
 * range is a squiggle over its text, an approximate one its whole block, a
 * range across blocks one piece per block, an atom inside it whole.
 */
suite('Editor diagnostics: from source ranges to page marks', () => {
    let doc: Node;
    let map: PositionMap;

    suiteSetup(() => {
        const parsed = parseDocument(hostEngine(), SOURCE, {});
        doc = parsed.doc;
        map = createPositionMap(parsed, { defaultWrap: 90 });
    });

    const text = (mark: DiagnosticMark) => doc.textBetween(mark.from, mark.to, '|', '￼');

    test('an exact range is a squiggle over exactly its text, in its block', () => {
        // `Second *paragraph* here.`: the word inside the emphasis, delimiters not in the page.
        const marks = diagnosticMarks(doc, map, [warning(range(2, 8, 2, 17))]);
        assert.strictEqual(marks.length, 1);
        assert.deepStrictEqual([marks[0].whole, marks[0].block, marks[0].index, marks[0].severity], [false, 1, 0, 'warning']);
        assert.strictEqual(text(marks[0]), 'paragraph');
    });

    test('an approximate range marks its whole top-level block: a range inside a source block (raw HTML) is the block', () => {
        const marks = diagnosticMarks(doc, map, [{ range: range(5, 2, 5, 3), severity: 'error', message: 'in the raw HTML' }]);
        assert.strictEqual(marks.length, 1);
        const [mark] = marks;
        assert.strictEqual(mark.whole, true);
        assert.strictEqual(doc.nodeAt(mark.from)?.type.name, 'raw_block');
        assert.strictEqual(mark.to, mark.from + (doc.nodeAt(mark.from)?.nodeSize ?? 0));
    });

    test('a range on the blank line between blocks is approximate, and marks a block rather than nothing', () => {
        const marks = diagnosticMarks(doc, map, [warning(range(1, 0, 1, 0))]);
        assert.strictEqual(marks.length, 1);
        assert.strictEqual(marks[0].whole, true);
    });

    test('a range across blocks is one piece per block, split at them', () => {
        const marks = diagnosticMarks(doc, map, [warning(range(0, 6, 2, 6))]);
        assert.deepStrictEqual(marks.map(m => [m.block, m.whole]), [[0, false], [1, false]]);
        assert.deepStrictEqual(marks.map(text), ['paragraph with a word.', 'Second']);
    });

    test('an atom inside a range across blocks is marked whole, the text around it squiggled', () => {
        const marks = diagnosticMarks(doc, map, [warning(range(2, 7, 9, 4))]);
        assert.deepStrictEqual(marks.map(m => [m.block, m.whole]), [[1, false], [2, true], [3, false]]);
        assert.strictEqual(text(marks[0]), 'paragraph here.');
        assert.ok(text(marks[2]).startsWith('item one') && text(marks[2]).endsWith('it'), text(marks[2]));
    });

    test('an empty range is widened to the character after it, as the text editor draws it', () => {
        const [after] = diagnosticMarks(doc, map, [warning(range(0, 6, 0, 6))]);
        assert.strictEqual(text(after), 'p');
        const [atEnd] = diagnosticMarks(doc, map, [warning(range(0, 28, 0, 28))]);
        assert.strictEqual(text(atEnd), '.', 'at the end of the text, the character before');
    });

    test('a range that is no place in the text is not drawn, and the others keep their index', () => {
        const marks = diagnosticMarks(doc, map, [warning(range(0.5, 0, 0.5, 2)), warning(range(0, 0, 0, 5), 'second')]);
        assert.deepStrictEqual(marks.map(m => [m.index, text(m)]), [[1, 'Intro']]);
    });

    test('the counts leave hints out, and the worse of two severities is the error', () => {
        const items: DiagnosticEntry[] = [
            { range: range(0, 0, 0, 1), severity: 'error', message: 'e' },
            { range: range(0, 0, 0, 1), severity: 'warning', message: 'w' },
            { range: range(0, 0, 0, 1), severity: 'warning', message: 'w2' },
            { range: range(0, 0, 0, 1), severity: 'hint', message: 'h' },
        ];
        assert.deepStrictEqual(diagnosticCounts(items), { error: 1, warning: 2, info: 0 });
        assert.strictEqual(worse('warning', 'error'), 'error');
        assert.strictEqual(worse('info', 'hint'), 'info');
    });
});

const ITEMS: CompletionEntry[] = [
    { label: 'FRS-RXE-057', detail: 'Generated requirement summary', insertText: 'FRS-RXE-057' },
    { label: 'FRS-RXE-058', detail: 'Composed deliverable', insertText: 'FRS-RXE-058' },
    { label: 'Snippet index', filterText: 'frs-rxe-059', insertText: 'FRS-RXE-059' },
    { label: 'NFR-RXE-001', insertText: 'NFR-RXE-001' },
];

/** The caret list's filtering and keys, without a page. */
suite('Editor completion: filtering and keys', () => {
    test('nothing typed lists everything, in the host\'s order', () => {
        assert.deepStrictEqual(filterCompletions(ITEMS, '').map(i => i.index), [0, 1, 2, 3]);
    });

    test('the typed text filters by prefix of filterText, else the label, ignoring case; the index stays the host\'s', () => {
        assert.deepStrictEqual(filterCompletions(ITEMS, 'frs-rxe-05').map(i => i.index), [0, 1, 2]);
        assert.deepStrictEqual(filterCompletions(ITEMS, 'FRS-RXE-059').map(i => i.entry.label), ['Snippet index'], 'by its filterText, not its label');
        assert.deepStrictEqual(filterCompletions(ITEMS, 'Snippet').map(i => i.index), [], 'a filterText replaces the label for filtering');
        assert.deepStrictEqual(filterCompletions(ITEMS, 'n').map(i => i.index), [3]);
        assert.deepStrictEqual(filterCompletions(ITEMS, 'RXE'), [], 'a prefix, not a substring');
    });

    test('the arrows move and wrap, Tab and Enter accept the chosen row, Esc closes', () => {
        assert.deepStrictEqual(listKeyAction('ArrowDown', 3, 0), { kind: 'move', chosen: 1 });
        assert.deepStrictEqual(listKeyAction('ArrowDown', 3, 2), { kind: 'move', chosen: 0 });
        assert.deepStrictEqual(listKeyAction('ArrowUp', 3, 0), { kind: 'move', chosen: 2 });
        assert.deepStrictEqual(listKeyAction('Tab', 3, 1), { kind: 'accept', chosen: 1 });
        assert.deepStrictEqual(listKeyAction('Enter', 3, -1), { kind: 'accept', chosen: 0 }, 'nothing chosen: the first row');
        assert.deepStrictEqual(listKeyAction('Escape', 3, 1), { kind: 'close' });
    });

    test('any other key, and a key with a modifier, is the text\'s', () => {
        assert.strictEqual(listKeyAction('a', 3, 0), null);
        assert.strictEqual(listKeyAction('Tab', 3, 0, { shift: true }), null, 'Shift+Tab');
        assert.strictEqual(listKeyAction('Enter', 3, 0, { ctrl: true }), null);
        assert.strictEqual(listKeyAction('ArrowDown', 0, -1), null, 'an empty list has no keys');
    });

    test('a word character filters; anything else asks the providers', () => {
        for (const ch of ['a', 'Z', '7', '_', 'ä', 'ß']) {
            assert.strictEqual(isWordCharacter(ch), true, ch);
        }
        for (const ch of [' ', '-', ':', '[', '(', '#', '/', '.', '@']) {
            assert.strictEqual(isWordCharacter(ch), false, ch);
        }
    });
});
