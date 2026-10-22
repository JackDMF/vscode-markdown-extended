import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { editorSchema, parseDocument } from '../../../src/editor';
import { REANNOUNCE_GAP_MS, markNoun, noteNoun, partLabel, refusalMs } from '../../../src/editor/refusal';
import { hostEngine, topChildren } from './helpers';

/** The first top-level block named `name` in `md` parsed, and its textblocks in document order. */
function blockOf(md: string, name: string): { block: Node; textblocks: Node[] } {
    const doc = parseDocument(hostEngine(), md).doc;
    const block = topChildren(doc).find(n => n.type.name === name);
    assert.ok(block, `no ${name} in ${JSON.stringify(md)}`);
    const textblocks: Node[] = [];
    block.descendants(n => {
        if (n.isTextblock) {
            textblocks.push(n);
        }
        return true;
    });
    return { block, textblocks };
}

/** The pieces of a refusal that are not its words (#10): its time, its repeat gap, the names it gives. */
suite('Editor refusals: time and names', () => {
    test('a refusal stays 2 s plus 50 ms a character, between 3.5 and 10 s', () => {
        const of = (n: number) => refusalMs('x'.repeat(n));
        assert.deepStrictEqual([0, 30, 70, 160, 500].map(of), [3500, 3500, 5500, 10000, 10000]);
        assert.strictEqual(REANNOUNCE_GAP_MS, 1000);
    });

    test('partLabel names the part someone must find: header row, body row n, item n, the heading, paragraph n', () => {
        const table = blockOf('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n', 'table');
        // Cells: header a, b; then rows 1…3.
        assert.strictEqual(partLabel(table.block, table.textblocks[1]), 'the header row');
        assert.strictEqual(partLabel(table.block, table.textblocks[2]), 'row 1');
        assert.strictEqual(partLabel(table.block, table.textblocks[6]), 'row 3');
        const list = blockOf('- one\n- two\n- three\n', 'bullet_list');
        assert.strictEqual(partLabel(list.block, list.textblocks[1]), 'item 2');
        const item = list.block.child(1);
        assert.strictEqual(partLabel(list.block, item), 'item 2');
        const quote = blockOf('> # Title\n>\n> first\n>\n> second\n', 'blockquote');
        assert.strictEqual(partLabel(quote.block, quote.textblocks[0]), 'the heading');
        assert.strictEqual(partLabel(quote.block, quote.textblocks[2]), 'paragraph 2');
    });

    test('noteNoun: the note bars\' names, lowercase mid-sentence', () => {
        assert.deepStrictEqual(['sidenote', 'marginal_note', 'left_sidebar', 'right_sidebar', 'paragraph'].map(n => noteNoun(n)), ['sidenote', 'marginal note', 'left sidebar', 'right sidebar', 'note']);
    });

    test('markNoun: the row\'s four names by delimiter, and code, superscript, subscript', () => {
        const m = editorSchema.marks;
        assert.deepStrictEqual(
            [m.em.create({ markup: '*' }), m.em.create({ markup: '_' }), m.strong.create({ markup: '**' }), m.strong.create({ markup: '__' }), m.code.create(), m.sup.create(), m.sub.create()].map(markNoun),
            ['italic text', 'emphasis', 'bold text', 'strong emphasis', 'inline code', 'superscript', 'subscript'],
        );
    });
});
