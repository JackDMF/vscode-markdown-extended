import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
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
