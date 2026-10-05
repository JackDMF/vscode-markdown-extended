import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import markdownItAttrs from 'markdown-it-attrs';
import { Token } from '../../../src/@types/markdown-it';
import { MarkdownItAttrs, attrsCutsIn, textBeforeAttrs } from '../../../src/plugin/markdownItAttrs';
import { plugins } from '../../../src/plugin/plugins';

// The preview's own registry, in its order: the bug lives between two plugins.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

function rows(html: string): string[][] {
    return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
        [...row.matchAll(/<t[hd][^>]*>([^<]*)<\/t[hd]>/g)].map(([, text]) => text));
}

suite('MarkdownItAttrs with multimd tables', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('two columns spanning five rows keep every row (jackdmf/vscode-markdown-extended#3)', () => {
        const html = md.render([
            '| Column 1 | Column 2 | Column 3 |',
            '| -------- | -------- | -------- |',
            '| Row 1    | Row 1-5  | Row 1-5  |',
            '| Row 2    | ^^       | ^^       |',
            '| Row 3    | ^^       | ^^       |',
            '| Row 4    | ^^       | ^^       |',
            '| Row 5    | ^^       | ^^       |',
            '',
        ].join('\n'));
        assert.deepStrictEqual(rows(html), [
            ['Column 1', 'Column 2', 'Column 3'],
            ['Row 1', 'Row 1-5', 'Row 1-5'],
            ['Row 2'], ['Row 3'], ['Row 4'], ['Row 5'],
        ]);
        assert.strictEqual((html.match(/rowspan="5"/g) ?? []).length, 2);
    });

    test('a multimd colspan beside a rowspan keeps the cells after it', () => {
        const html = md.render([
            '| a | b | c | d |',
            '| - | - | - | - |',
            '| 1 | 2 || 3 |',
            '| ^^ | 4 | 5 | 6 |',
            '| ^^ | 7 | 8 | 9 |',
            '',
        ].join('\n'));
        assert.deepStrictEqual(rows(html).slice(1), [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']]);
        assert.ok(html.includes('colspan="2"'));
        assert.ok(html.includes('rowspan="3"'));
    });

    test('attrs still lays out a span written as {rowspan=…}', () => {
        const html = md.render([
            '| A | B |',
            '| - | - |',
            '| 1 {rowspan=2} | 11 |',
            '| 2 | 22 |',
            '',
        ].join('\n'));
        assert.ok(html.includes('rowspan="2"'));
        // attrs' own layout: the row under the span loses its last cell.
        assert.deepStrictEqual(rows(html).slice(1), [['1', '11'], ['2']]);
    });

    test('a class on a table still lands on the table', () => {
        const html = md.render('| A | B |\n| - | - |\n| 1 | 2 |\n\n{.wide}\n');
        assert.ok(html.includes('<table class="wide">'));
    });
});

suite('MarkdownItAttrs records what the plugin cut, without changing what it renders', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    /** The first inline token of `source`, as the registry parses it. */
    function inline(source: string): Token {
        const token = (md.parse(source, {}) as unknown as Token[]).find(t => t.type === 'inline');
        assert.ok(token, source);
        return token;
    }

    /** Each cut as `[the text token before it was cut, the {…}, end?]`. */
    function cuts(source: string): [string, string, boolean][] {
        return attrsCutsIn(inline(source)).map(cut => [cut.text, cut.text.slice(cut.from, cut.to), cut.end]);
    }

    test('a span\'s literal emptying the text after it is a cut off its start, and the block\'s is the one before it', () => {
        // `a {x}[t]{.s}`: "end of block" takes `{x}` off `a {x}`; `{.s}` is the span's, cut off the start of the text after `]`.
        assert.deepStrictEqual(cuts('a {x}[t]{.s}\n'), [['a {x}', '{x}', true], ['{.s}', '{.s}', false]]);
        assert.strictEqual(textBeforeAttrs(inline('a {x}[t]{.s}\n')), 'a {x}');
        assert.strictEqual(textBeforeAttrs(inline('a [t]{.s}\n')), null, 'nothing was cut off an end');
        const span = attrsCutsIn(inline('a [t]{.s}{.c}\n'));
        assert.deepStrictEqual(span.map(cut => [cut.text.slice(cut.from, cut.to), cut.after, cut.first]), [['{.s}', 'span_close', true], ['{.c}', 'span_close', false]]);
    });

    test('every place the plugin takes a {…} is recorded, an escape after it joined or not', () => {
        assert.deepStrictEqual(cuts('see *a*{.c} more \\{y\\}\n'), [['{.c} more ', '{.c}', false]]);
        assert.deepStrictEqual(cuts('see `a`{.c}\n'), [['{.c}', '{.c}', false]], 'taken out whole after inline code');
        assert.deepStrictEqual(cuts('text\n{.c}\n'), [['{.c}', '{.c}', false]], 'a {…} line after a soft break');
        assert.deepStrictEqual(cuts('- a {x} {y}\n'), [['a {x} {y}', '{y}', true], ['a {x} {y}', '{x}', true]], 'the item\'s, then the paragraph\'s');
        assert.strictEqual(textBeforeAttrs(inline('- a {x} {y}\n')), 'a {x} {y}');
        assert.deepStrictEqual(cuts('a \\{x\\} b\n'), [], 'an escaped {…} is not cut');
    });

    test('the preview renders exactly what markdown-it-attrs alone renders', () => {
        const plain = new MarkdownIt();
        plain.use(markdownItAttrs);
        const wrapped = new MarkdownIt();
        wrapped.use(MarkdownItAttrs as never);
        for (const source of ['a {x}[t]{.s}\n', 'see *a*{.c} more \\{y\\}\n', '- a {x} {y}\n', '# T {#t}\n', 'text\n{.c}\n', '`a`{.c} and ![i](u){.d}\n', '| A |\n| - |\n| 1 {.x} |\n\n{.wide}\n']) {
            assert.strictEqual(wrapped.render(source), plain.render(source), source);
        }
    });
});
