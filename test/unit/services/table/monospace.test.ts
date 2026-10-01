import * as assert from 'assert';
import { parseDocument } from '../../../../src/editor';
import { tableLines } from '../../../../src/editor/serialize';
import { MDTable } from '../../../../src/services/table/mdTable';
import { MonoSpaceLength, graphemeClusters } from '../../../../src/services/table/monospace';
import { hostEngine } from '../../editor/helpers';

/**
 * A column is padded by the monospace columns its cells take, counted by
 * grapheme cluster (qjebbs/vscode-markdown-extended#149: an emoji measured 0,
 * so its column was written two spaces too wide).
 */
const WIDTHS: readonly [string, string, number][] = [
    ['ASCII', 'abc', 3],
    ['an emoji', '🍉', 2],
    ['an emoji between text', 'a🍉b', 4],
    ['a ZWJ family', '👨‍👩‍👧‍👦', 2],
    ['a flag', '🇩🇪', 2],
    ['a skin tone modifier', '👍🏽', 2],
    ['a text-default emoji with a skin tone', '☝🏽', 2],
    ['a keycap', '1️⃣', 2],
    ['a text-default emoji with VS16', '❤️', 2],
    ['a text-default emoji without VS16', '❤', 1],
    ['an emoji with VS15', '⌚︎', 1],
    ['CJK', '中文', 4],
    ['Hiragana and Hangul', 'かな한글', 8],
    ['CJK punctuation', '「」。', 6],
    ['fullwidth', 'ＡＢ１', 6],
    ['halfwidth katakana', 'ｶﾅ', 2],
    ['a combining accent', 'é', 1],
    ['a combining mark alone', '́', 0],
    ['an arrow and a box drawing, as before', '→─', 4],
];

suite('Table monospace width', () => {
    for (const [name, text, width] of WIDTHS) {
        test(`${name} takes ${width}`, () => {
            assert.strictEqual(MonoSpaceLength(text), width, JSON.stringify(text));
        });
    }

    test('without Intl.Segmenter the clusters are split by rule, as the segmenter splits them', () => {
        for (const [, text] of WIDTHS) {
            assert.deepStrictEqual(graphemeClusters(text, null), graphemeClusters(text), JSON.stringify(text));
        }
    });

    const SOURCE = [
        '| Cell | Kind |',
        '| --- | :-: |',
        '| 🍉 | emoji |',
        '| 👨‍👩‍👧 | family |',
        '| 🇩🇪 | flag |',
        '| 👍🏽 | skin tone |',
        '| 1️⃣ | keycap |',
        '| 中文 | CJK |',
        '| ＡＢＣ | fullwidth |',
        '| é | accent |',
    ].join('\n');

    const TIDY = [
        '| Cell   |   Kind    |',
        '| ------ | :-------: |',
        '| 🍉     |   emoji   |',
        '| 👨‍👩‍👧     |  family   |',
        '| 🇩🇪     |   flag    |',
        '| 👍🏽     | skin tone |',
        '| 1️⃣     |  keycap   |',
        '| 中文   |    CJK    |',
        '| ＡＢＣ | fullwidth |',
        '| é      |  accent   |',
    ];

    test('Format Table pads a column of emoji, CJK, fullwidth and accents by their width', () => {
        assert.deepStrictEqual(MDTable.parse(SOURCE).stringify().split('\n'), TIDY);
    });

    test('the Visual Editor writes the same table as Format Table does', () => {
        const table = parseDocument(hostEngine(), `${SOURCE}\n`).doc.child(0);
        assert.strictEqual(table.type.name, 'table');
        assert.deepStrictEqual(tableLines(table), MDTable.parse(SOURCE).stringify().split('\n'));
        assert.deepStrictEqual(tableLines(table), TIDY);
    });
});
