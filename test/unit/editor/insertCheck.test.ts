import * as assert from 'assert';
import { insertionStandsAlone, judgeInsertion } from '../../../src/editor/host/insertCheck';
import { parseDocument } from '../../../src/editor/parse';
import type { InsertedBlocks } from '../../../src/editor/protocol';
import { hostEngine } from './helpers';
import { insertAsThePage } from './insertAsPage';

const QUOTE = '> ## Römer 12:2 {.nwtsty}\n> Text';

/**
 * The host's check of blocks another extension inserted (`host/insertCheck.ts`):
 * the page's half played as `insertBlock` plays it — the file parsed, the
 * block inserted after top-level block `after` (`insertBlockTransaction`), the
 * edit's text, where the source block stands and what the text is without it —
 * and the host's word on it.
 */
suite('Editor host: inserted blocks stand alone in the host\'s parse, or are not written', () => {
    const md = hostEngine();

    const inserted = (file: string, markdown: string, after: number) => insertAsThePage(md, file, markdown, after);
    /** The host's word without the parse it hands on (`parsed`, the edit's text's: checked once, below). */
    const judged = (text: string, insert: InsertedBlocks) => {
        const { parsed, ...verdict } = judgeInsertion(md, text, insert);
        assert.strictEqual(parsed !== undefined, verdict.text === text, 'the parse is handed on with the edit\'s text only');
        return verdict;
    };

    test('a quote after a paragraph stands alone: the edit\'s text is written', () => {
        const file = 'Intro paragraph.\n\nSecond paragraph.\n\nLast paragraph.\n';
        const { text, insert } = inserted(file, QUOTE, 1);
        assert.strictEqual(text, 'Intro paragraph.\n\nSecond paragraph.\n\n> ## Römer 12:2 {.nwtsty}\n> Text\n\nLast paragraph.\n');
        assert.deepStrictEqual(judged(text, insert), { text });
    });

    test('after a code fence left open at the file\'s end, the quote would be code: not-separate, the text without it', () => {
        const file = 'Intro paragraph.\n\n```js\nlet a = 1;\n';
        const { text, insert } = inserted(file, QUOTE, 1);
        assert.ok(text.endsWith(`let a = 1;\n\n${QUOTE}\n`), text);
        assert.deepStrictEqual(judged(text, insert), { text: file, refused: 'not-separate' });
    });

    test('after an HTML comment left open, the quote would be in the comment: not-separate', () => {
        const file = 'Intro paragraph.\n\n<!-- a note\n';
        const { text, insert } = inserted(file, QUOTE, 1);
        assert.deepStrictEqual(judged(text, insert), { text: file, refused: 'not-separate' });
    });

    test('Markdown that leaves a fence open itself would take the blocks after it in: not-separate, they stay as they are', () => {
        const file = 'Intro paragraph.\n\nSecond paragraph.\n\nLast paragraph.\n';
        const { text, insert } = inserted(file, '```\nnot closed', 0);
        assert.deepStrictEqual(judged(text, insert), { text: file, refused: 'not-separate' });
    });

    test('a block the parse reads as a source block again — raw HTML — stands alone, kept in place', () => {
        const file = 'Intro paragraph.\n\nLast paragraph.\n';
        const { text, insert, page } = inserted(file, '<div class="x">raw</div>', 0);
        assert.deepStrictEqual(judged(text, insert), { text });
        assert.strictEqual(insertionStandsAlone(page, insert.index, parseDocument(md, text, {}).doc), true);
    });

    test('typing elsewhere in the same edit is kept when the blocks are refused', () => {
        const file = 'Intro paragraph.\n\n```js\nlet a = 1;\n';
        const typed = file.replace('Intro', 'ABIntro');
        const { text, insert } = inserted(typed, QUOTE, 1);
        assert.deepStrictEqual(judged(text, insert), { text: typed, refused: 'not-separate' });
    });

    test('what cannot be told is not written: a `without` that changes nothing, a page document that is none; an index out of range never stands alone', () => {
        const file = 'Intro paragraph.\n\nLast paragraph.\n';
        const { text, insert, page } = inserted(file, QUOTE, 0);
        assert.deepStrictEqual(judged(text, { ...insert, without: { start: 0, end: 0, text: '' } }), { text: undefined, refused: 'error-state' });
        assert.deepStrictEqual(judged(text, { ...insert, without: { start: 5, end: 2, text: '' } }), { text: undefined, refused: 'error-state' });
        assert.deepStrictEqual(judged(text, { ...insert, page: { type: 'nonsense' } }), { text: file, refused: 'error-state' });
        const parsed = parseDocument(md, text, {}).doc;
        assert.strictEqual(insertionStandsAlone(page, -1, parsed), false);
        assert.strictEqual(insertionStandsAlone(page, page.childCount, parsed), false);
        assert.strictEqual(insertionStandsAlone(page, 0, parsed), false, 'the run replaced is the quote\'s, not the first block\'s');
    });

    test('typing in an admonition or a list item before the insertion: the quote elsewhere still stands alone (H1)', () => {
        for (const [file, word] of [
            ['Intro.\n\n!!! note "Title"\n    body text here\n\nLast.\n', 'body'],
            ['Intro.\n\n- item one\n- item two\n\nLast.\n', 'two'],
        ] as const) {
            const { text, insert } = insertAsThePage(md, file, QUOTE, 1, 1, state => {
                let at = -1;
                state.doc.descendants((n, p) => {
                    if (at < 0 && n.isText && n.text?.includes(word)) {
                        at = p + (n.text ?? '').indexOf(word);
                    }
                });
                return state.apply(state.tr.insertText('XY', at));
            });
            assert.deepStrictEqual(judged(text, insert), { text }, file);
        }
    });

    test('inserted text that closes a comment left open before it is not taken as standing alone: its source block and the comment\'s are not the parse\'s (L1)', () => {
        const file = 'Intro.\n\n<!-- a\n';
        const { text, insert } = inserted(file, 'x -->\n\n<div>y</div>', 1);
        assert.deepStrictEqual(judged(text, insert), { text: file, refused: 'not-separate' });
    });
});
