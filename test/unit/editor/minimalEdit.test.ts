import * as assert from 'assert';
import { MinimalReplacement, minimalReplacement } from '../../../src/editor/host/minimalEdit';

/** Apply a replacement to the text it was computed from. */
function apply(before: string, r: MinimalReplacement | null): string {
    return r === null ? before : before.slice(0, r.start) + r.text + before.slice(r.end);
}

suite('Editor host: minimal replacement', () => {
    test('identical texts need no edit', () => {
        assert.strictEqual(minimalReplacement('', ''), null);
        assert.strictEqual(minimalReplacement('# Title\n\nBody.\n', '# Title\n\nBody.\n'), null);
    });

    test('an insertion replaces nothing and inserts only what is new', () => {
        const before = 'First.\n\nThird.\n';
        const after = 'First.\n\nSecond.\n\nThird.\n';
        const r = minimalReplacement(before, after);
        assert.deepStrictEqual(r, { start: 8, end: 8, text: 'Second.\n\n' });
        assert.strictEqual(apply(before, r), after);
    });

    test('a deletion inserts nothing', () => {
        const before = 'Keep this. Drop this. Keep that.\n';
        const after = 'Keep this. Keep that.\n';
        const r = minimalReplacement(before, after);
        assert.ok(r);
        assert.strictEqual(r.text, '');
        assert.strictEqual(before.slice(r.start, r.end), 'Drop this. ');
        assert.strictEqual(apply(before, r), after);
    });

    test('a replacement in the middle leaves both ends alone', () => {
        const before = '---\ntitle: x\n---\n\nThe old word here.\n\n| a |\n| - |\n';
        const after = '---\ntitle: x\n---\n\nThe new word here.\n\n| a |\n| - |\n';
        const r = minimalReplacement(before, after);
        assert.deepStrictEqual(r, { start: before.indexOf('old'), end: before.indexOf('old') + 3, text: 'new' });
        assert.strictEqual(apply(before, r), after);
    });

    test('CRLF text: a boundary never splits a line ending', () => {
        // The common prefix would end on the `\r` of `\r\n`; the pair is kept whole.
        const before = 'One.\r\nTwo.\r\n';
        const after = 'One.\r\n\r\nInserted.\r\nTwo.\r\n';
        const r = minimalReplacement(before, after);
        assert.ok(r);
        assert.strictEqual(apply(before, r), after);
        const cut = (text: string, at: number) => text.charAt(at - 1) === '\r' && text.charAt(at) === '\n';
        assert.ok(!cut(before, r.start) && !cut(before, r.end), `boundary inside \\r\\n: ${JSON.stringify(r)}`);

        // A line ending changed between LF and CRLF: the whole terminator is
        // replaced, never the `\r` alone.
        const lf = 'a\nb\n';
        const crlf = 'a\r\nb\n';
        const r2 = minimalReplacement(lf, crlf);
        assert.deepStrictEqual(r2, { start: 1, end: 2, text: '\r\n' });
        assert.strictEqual(apply(lf, r2), crlf);
        const r3 = minimalReplacement(crlf, lf);
        assert.deepStrictEqual(r3, { start: 1, end: 3, text: '\n' });
        assert.strictEqual(apply(crlf, r3), lf);
    });

    test('a boundary never splits a surrogate pair', () => {
        const before = 'x\u{1F600}y';
        const after = 'x\u{1F601}y';
        const r = minimalReplacement(before, after);
        assert.deepStrictEqual(r, { start: 1, end: 3, text: '\u{1F601}' });
    });
});
