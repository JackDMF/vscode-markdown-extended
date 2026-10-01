import * as assert from 'assert';
import { parseDocument } from '../../../../src/editor';
import { tableLines } from '../../../../src/editor/serialize';
import { MDTable } from '../../../../src/services/table/mdTable';
import { convertToMarkdownTable } from '../../../../src/services/table/convertTable';
import { MonoSpaceLength, clustersWidth } from '../../../../src/services/table/monospace';
import { hostEngine } from '../../editor/helpers';

const ZWJ = '\u200D';
const VS15 = '\uFE0E';
const VS16 = '\uFE0F';
const KEYCAP = '\u20E3';
const ACUTE = '\u0301';

/**
 * A column is padded by the monospace columns its cells take, counted by
 * grapheme cluster (qjebbs/vscode-markdown-extended#149: an emoji measured 0,
 * so its column was written two spaces too wide).
 */
const WIDTHS: readonly [string, string, number][] = [
    ['ASCII', 'abc', 3],
    ['an emoji', '🍉', 2],
    ['an emoji between text', 'a🍉b', 4],
    ['an emoji with VS15, still emoji-default', `🍉${VS15}`, 2],
    ['a ZWJ family', `👨${ZWJ}👩${ZWJ}👧${ZWJ}👦`, 2],
    ['a flag', '🇩🇪', 2],
    ['a skin tone modifier', '👍🏽', 2],
    ['a text-default emoji with a skin tone', '☝🏽', 2],
    ['a letter with a skin tone', 'a🏽', 2],
    ['a keycap', `1${VS16}${KEYCAP}`, 2],
    ['a text-default emoji with VS16', `❤${VS16}`, 2],
    ['a text-default emoji alone', '❤', 1],
    ['a text-default emoji with VS15', `❤${VS15}`, 1],
    ['CJK', '中文', 4],
    ['Hiragana and Hangul', 'かな한글', 8],
    ['CJK punctuation', '「」。', 6],
    ['enclosed and compatibility CJK', '㈱㎡', 4],
    ['Bopomofo', 'ㄅㄆ', 4],
    ['fullwidth', 'ＡＢ１', 6],
    ['halfwidth katakana', 'ｶﾅ', 2],
    ['a combining accent', `e${ACUTE}`, 1],
    ['a combining mark alone', ACUTE, 0],
    ['a zero-width space', 'a\u200Bb', 2],
    ['Thai with a tone mark and a spacing vowel', 'น้ำ', 2],
    ['an arrow, a box drawing and a circle (ambiguous)', '→─○', 3],
];

suite('Table monospace width', () => {
    for (const [name, text, width] of WIDTHS) {
        test(`${name} takes ${width}`, () => {
            assert.strictEqual(MonoSpaceLength(text), width, JSON.stringify(text));
        });
    }

    test('plain text, Latin with umlauts and dashes, is its length, as the full rule measures it', () => {
        for (const text of ['Größe', 'Übermaß – ‚so‘ …', 'Ærøskøbing', 'ǅ ȷ ɏ']) {
            assert.strictEqual(MonoSpaceLength(text), text.length, text);
            assert.strictEqual(clustersWidth(text), text.length, text);
        }
    });

    test('without Intl.Segmenter each code point is measured by the same rules', () => {
        const single = ['abc', '🍉', '中文', 'ＡＢ１', 'ｶﾅ', `e${ACUTE}`, ACUTE, 'น้ำ', '→─○', '🇩🇪'];
        for (const text of single) {
            assert.strictEqual(clustersWidth(text, null), MonoSpaceLength(text), JSON.stringify(text));
        }
        assert.strictEqual(clustersWidth(`👨${ZWJ}👩${ZWJ}👧`, null), 6, 'an emoji sequence is the sum of its parts');
        assert.strictEqual(clustersWidth(`1${VS16}${KEYCAP}`, null), 1);
    });

    test('Paste as Table lines up CSV cells padded with spaces', () => {
        assert.deepStrictEqual(convertToMarkdownTable(' Name , Wert \n Größe ,  1 \n 中文,22').split('\n'), [
            '| Name  | Wert |',
            '| ----- | ---- |',
            '| Größe | 1    |',
            '| 中文  | 22   |',
        ]);
    });

    const SOURCE = [
        '| Cell | Kind |',
        '| --- | :-: |',
        '| 🍉 | emoji |',
        `| 👨${ZWJ}👩${ZWJ}👧 | family |`,
        '| 🇩🇪 | flag |',
        '| 👍🏽 | skin tone |',
        `| 1${VS16}${KEYCAP} | keycap |`,
        '| 中文 | CJK |',
        '| ＡＢＣ | fullwidth |',
        `| e${ACUTE} | accent |`,
    ].join('\n');

    const TIDY = [
        '| Cell   |   Kind    |',
        '| ------ | :-------: |',
        '| 🍉     |   emoji   |',
        `| 👨${ZWJ}👩${ZWJ}👧     |  family   |`,
        '| 🇩🇪     |   flag    |',
        '| 👍🏽     | skin tone |',
        `| 1${VS16}${KEYCAP}     |  keycap   |`,
        '| 中文   |    CJK    |',
        '| ＡＢＣ | fullwidth |',
        `| e${ACUTE}      |  accent   |`,
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
