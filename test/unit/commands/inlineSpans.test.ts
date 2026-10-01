import * as assert from 'assert';
import { findSpans, lineStarts } from '../../../src/services/helpers/inlineSpans';
import { INLINE_MARKERS, isHalfMarker } from '../../../src/syntax/markers';

/** The spans as the text they cover, to read a case at a glance. */
function spans(text: string, marker: string): string[] {
    return findSpans(text, marker).map(s => text.slice(s.start, s.end));
}

suite('Inline toggles: the spans a marker formats', () => {
    test('which markers are half of another is read from the marker table', () => {
        const halves = Object.values(INLINE_MARKERS).filter(isHalfMarker);
        assert.deepStrictEqual(halves.sort(), ['*', '_', '~'].sort());
    });

    test('a span of one character, the shortest first', () => {
        assert.deepStrictEqual(spans('x **a** and **bc** y', '**'), ['**a**', '**bc**']);
        assert.deepStrictEqual(spans('==a== ==b==', '=='), ['==a==', '==b==']);
    });

    test('markers side by side are one span, as Markdown reads them', () => {
        assert.deepStrictEqual(spans('**a****b**', '**'), ['**a****b**']);
    });

    test('a run of the marker\'s own character is no span', () => {
        assert.deepStrictEqual(spans('*****', '**'), []);
        assert.deepStrictEqual(spans('****', '**'), []);
        assert.deepStrictEqual(spans('```js', '`'), []);
        assert.deepStrictEqual(spans('a ``b`` c', '`'), []);
    });

    test('italics: a run of one or three, so bold\'s markers are not its own', () => {
        assert.deepStrictEqual(spans('**bold**', '*'), []);
        assert.deepStrictEqual(spans('***bold***', '*'), ['***bold***']);
        assert.deepStrictEqual(spans('*see **this***', '*'), ['*see **this***']);
        assert.deepStrictEqual(spans('***bold***', '**'), ['***bold***']);
    });

    test('subscript: strikethrough\'s markers are not its own', () => {
        assert.deepStrictEqual(spans('~~strike~~ H~2~O', '~'), ['~2~']);
    });

    test('underline does not open or close inside a word', () => {
        assert.deepStrictEqual(spans('_snake_case_', '_'), ['_snake_case_']);
        assert.deepStrictEqual(spans('x_a_y Grö_ße_n', '_'), []);
        assert.deepStrictEqual(spans('(_a_)', '_'), ['_a_']);
    });

    test('superscript leaves footnote references alone', () => {
        assert.deepStrictEqual(spans('see[^1] and[^2]', '^'), []);
        assert.deepStrictEqual(spans('E=mc^2^ [^1]', '^'), ['^2^']);
    });

    test('no space inside a marker', () => {
        assert.deepStrictEqual(spans('a ** b ** c', '**'), []);
    });
});

suite('Inline toggles: which lines take a marker', () => {
    function kinds(text: string): string[] {
        return lineStarts(text.split('\n')).map(s => s.kind === 'text' ? `text+${s.prefix}` : s.kind);
    }

    test('block prefixes, task boxes and definitions are left before the text', () => {
        assert.deepStrictEqual(kinds('- item\n- [ ] task\n1. one\n# Title\n> quote\nTerm\n: definition'),
            ['text+2', 'text+6', 'text+3', 'text+2', 'text+2', 'text+0', 'text+2']);
    });

    test('fences, the code they hold, indented code, HTML and math are literal', () => {
        assert.deepStrictEqual(kinds('```js\nlet a;\n```\n\n    code\n\n<div>\nhtml\n\n$$\nx^2\n$$'),
            ['literal', 'literal', 'literal', 'text+0', 'literal', 'text+0', 'literal', 'literal', 'text+0', 'literal', 'literal', 'literal']);
    });

    test('table rows, breaks, setext underlines, containers and definitions are structure', () => {
        assert.deepStrictEqual(kinds('a | b\n--|--\n1 | 2\n\nTitle\n===\n\n---\n!!! note\n::: box\n[^1]: note'),
            ['structure', 'structure', 'structure', 'text+0', 'text+0', 'structure', 'text+0', 'structure', 'structure', 'structure', 'structure']);
    });

    test('an indented line in a list is no code', () => {
        assert.deepStrictEqual(kinds('- item\n\n    more'), ['text+2', 'text+0', 'text+4']);
    });
});
