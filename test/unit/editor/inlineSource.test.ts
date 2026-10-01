import * as assert from 'assert';
import { readInlineSource } from '../../../src/editor/inlineSource';
import { hostEngine, toCrlf } from './helpers';

/**
 * What the inline toggles read of a document: its lines' kinds, each text
 * line's stretches and the spans a marker formats, from the engine's tokens.
 */
suite('Inline source: the document as the engine reads it', () => {
    const md = hostEngine();

    function kinds(text: string): string[] {
        const source = readInlineSource(md, text);
        return text.split(/\r\n|\r|\n/).map((_, line) => source.kindOf(line));
    }

    /** Each line's stretches as the text they cover, `+` before one that continues the one before it. */
    function stretches(text: string): string[][] {
        const source = readInlineSource(md, text);
        return text.split(/\r\n|\r|\n/).map((_, line) => source.textOn(line).map(s => (s.continues ? '+' : '') + text.slice(s.start, s.end)));
    }

    function spans(text: string, marker: string, line = 0): string[] {
        return readInlineSource(md, text).spansOn(line, marker).map(s => text.slice(s.start, s.end) + (s.exact ? '' : '?'));
    }

    test('a fence, indented code and an HTML block are literal, in a list and a quote too', () => {
        assert.deepStrictEqual(kinds('Intro\n\n```js\nlet a = 1;\n```\n\nOutro'), ['text', 'blank', 'literal', 'literal', 'literal', 'blank', 'text']);
        assert.deepStrictEqual(kinds('- item\n\n    ```\n    code\n    ```'), ['text', 'blank', 'literal', 'literal', 'literal']);
        assert.deepStrictEqual(kinds('1. item\n\n   ```\n   code\n   ```'), ['text', 'blank', 'literal', 'literal', 'literal']);
        assert.deepStrictEqual(kinds('> ```\n> code\n> ```'), ['literal', 'literal', 'literal']);
        assert.deepStrictEqual(kinds('<div>\nhtml\n</div>'), ['literal', 'literal', 'literal']);
        assert.deepStrictEqual(kinds('one\n\n<details>\n<summary>S</summary>\n\ninside\n\n</details>'),
            ['text', 'blank', 'literal', 'literal', 'blank', 'text', 'blank', 'literal']);
        assert.deepStrictEqual(kinds('para\n\n    indented code'), ['text', 'blank', 'literal']);
    });

    test('a paragraph starting with inline HTML or an autolink is text', () => {
        assert.deepStrictEqual(kinds('<kbd>Ctrl</kbd> saves'), ['text']);
        assert.deepStrictEqual(kinds('<https://example.com> is the site'), ['text']);
        assert.deepStrictEqual(kinds('line one\n<b>x</b> more\nline three'), ['text', 'text', 'text']);
    });

    test('an admonition\'s and a footnote\'s body after a blank line is text, not indented code', () => {
        assert.deepStrictEqual(kinds('!!! note Title\n    para one\n\n    para two'), ['text', 'text', 'blank', 'text']);
        assert.deepStrictEqual(kinds('!!! note Title\n    ```\n    code\n    ```'), ['text', 'literal', 'literal', 'literal']);
        assert.deepStrictEqual(kinds('x[^1]\n\n[^1]: note\n\n    more note'), ['text', 'blank', 'text', 'blank', 'text']);
    });

    test('a block\'s own syntax is structure', () => {
        assert.deepStrictEqual(kinds('| a | b |\n|---|---|\n| 1 | 2 |'), ['text', 'structure', 'text']);
        assert.deepStrictEqual(kinds('Title\n=====\n\ntext'), ['text', 'structure', 'blank', 'text']);
        assert.deepStrictEqual(kinds('one\n\n---\n\ntwo'), ['text', 'blank', 'structure', 'blank', 'text']);
        assert.deepStrictEqual(kinds('::: warning\ntext\n:::'), ['structure', 'text', 'structure']);
        assert.deepStrictEqual(kinds('[a]: http://x\n\ntext'), ['structure', 'blank', 'text']);
        assert.deepStrictEqual(kinds('Term\n: definition'), ['text', 'text']);
    });

    test('a code span holds no span of another marker, and its own is found whole', () => {
        const text = 'Use `**/*.ts` or `**/*.js` here';
        assert.deepStrictEqual(spans(text, '**'), []);
        assert.deepStrictEqual(spans(text, '*'), []);
        assert.deepStrictEqual(spans(text, '`'), ['`**/*.ts`', '`**/*.js`']);
        assert.deepStrictEqual(stretches(text), [['Use ', '+ or ', '+ here']]);
        assert.deepStrictEqual(spans('`` `a` `` x', '`'), ['`` `a` ``']);
        assert.deepStrictEqual(spans('y ` a ` x', '`'), ['` a `']);
        assert.deepStrictEqual(stretches('y ` a ` x'), [['y ', '+ x']]);
    });

    test('code offsets: a code span starts and ends at its backtick runs', () => {
        const source = readInlineSource(md, 'a ``b`` c');
        assert.deepStrictEqual(source.spansOn(0, '`').map(s => [s.start, s.end, s.markup, s.exact]), [[2, 7, '``', true]]);
    });

    test('an escaped marker is text, no span', () => {
        assert.deepStrictEqual(spans('\\*\\*not\\*\\*', '**'), []);
        assert.deepStrictEqual(spans('\\*\\*not\\*\\*', '*'), []);
        assert.deepStrictEqual(stretches('\\*\\*not\\*\\*'), [['\\*\\*not\\*\\*']]);
    });

    test('text beside a marker of its own character leaves the marker its characters', () => {
        assert.deepStrictEqual(spans('x ~~~strike~~~ y', '~~'), ['~~strike~~']);
        assert.deepStrictEqual(stretches('x ~~~strike~~~ y'), [['x ~', '+strike', '+~ y']]);
        assert.deepStrictEqual(spans('**a***', '**'), ['**a**']);
        assert.deepStrictEqual(spans('not \\**emph*\\* here', '*'), ['*emph*']);
        assert.deepStrictEqual(spans('lit \\*\\***not**\\*\\* bold', '**'), ['**not**']);
    });

    test('a `_` inside a word opens no span', () => {
        assert.deepStrictEqual(spans('the _cache field and the _lock_', '_'), ['_lock_']);
    });

    test('***x*** is one italic and one bold span, with markers of their own', () => {
        const source = readInlineSource(md, '***x***');
        const em = source.spansOn(0, '*').map(s => [s.start, s.end]);
        const strong = source.spansOn(0, '**').map(s => [s.start, s.end]);
        assert.deepStrictEqual(em, [[0, 7]]);
        assert.deepStrictEqual(strong, [[1, 6]]);
        assert.deepStrictEqual(spans('**bold**', '*'), []);
        assert.deepStrictEqual(spans('* *a* b', '*'), ['*a*']);
    });

    test('offsets are the document\'s, CRLF included', () => {
        const text = toCrlf('a\n**b**\n`c`');
        const source = readInlineSource(md, text);
        assert.deepStrictEqual(source.spansOn(1, '**').map(s => [s.start, s.end]), [[3, 8]]);
        assert.deepStrictEqual(source.textOn(1).map(s => [s.start, s.end]), [[5, 6]]);
        assert.deepStrictEqual(source.spansOn(2, '`').map(s => [s.start, s.end]), [[10, 13]]);
    });

    test('a link\'s text is a stretch of its own, its URL none', () => {
        assert.deepStrictEqual(stretches('[l **b**](u) after'), [['l ', '+b', ' after']]);
        assert.deepStrictEqual(spans('[l **b**](u) after', '**'), ['**b**']);
        assert.deepStrictEqual(stretches('<https://x.org> and <kbd>k</kbd>'), [[' and ', 'k']]);
    });

    test('a line\'s prefix is outside its stretch', () => {
        assert.deepStrictEqual(stretches('- [ ] task\n1. item\n# Title #\n> q'), [['task'], ['item'], ['Title'], ['q']]);
        assert.deepStrictEqual(stretches('x[^1]\n\n[^1]: note'), [['x'], [], ['note']]);
        assert.deepStrictEqual(stretches('!!! note Title\n    para one\n\n    para two'), [['Title'], ['para one'], [], ['para two']]);
        assert.deepStrictEqual(stretches('<kbd>Ctrl</kbd> saves'), [['Ctrl', ' saves']]);
        assert.deepStrictEqual(stretches('| a | **b** |\n|---|---|\n| 1 | 2 |'), [['a', 'b'], [], ['1', '2']]);
    });

    test('a selection may run across another span\'s markers, an inline note and an entity', () => {
        assert.deepStrictEqual(stretches('make **this** bold'), [['make ', '+this', '+ bold']]);
        assert.deepStrictEqual(stretches('text^[an inline note] and'), [['text', '+ and']]);
        assert.deepStrictEqual(stretches('a &amp; b'), [['a &amp; b']]);
    });

    test('the block a line is in', () => {
        const source = readInlineSource(md, 'a\nb\n\n- x\n\n  y\n\nz');
        assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 7].map(l => source.blockOf(l)),
            // A list's map takes in the blank line after it.
            [{ start: 0, end: 2 }, { start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 7 }, { start: 3, end: 7 }, { start: 3, end: 7 }, { start: 7, end: 8 }]);
    });
});
