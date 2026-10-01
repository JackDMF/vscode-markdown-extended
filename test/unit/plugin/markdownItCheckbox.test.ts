import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';

// The preview's own registry, in its order.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

function cells(html: string): string[] {
    return [...html.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell);
}

suite('MarkdownItCheckbox', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('a task list keeps its boxes and labels', () => {
        assert.strictEqual(md.render('- [ ] open\n- [x] done\n'), [
            '<ul>',
            '<li><input type="checkbox" id="checkbox0"><label for="checkbox0">open</label></li>',
            '<li><input type="checkbox" id="checkbox1" checked="true"><label for="checkbox1">done</label></li>',
            '</ul>',
            '',
        ].join('\n'));
    });

    test('the text before a box is kept', () => {
        assert.strictEqual(md.render('para [ ] mid\n'),
            '<p>para <input type="checkbox" id="checkbox0"><label for="checkbox0">mid</label></p>\n');
    });

    test('the text before a box in a table cell is kept', () => {
        const html = md.render('| a |\n| - |\n| text [x] mid |\n');
        assert.deepStrictEqual(cells(html),
            ['text <input type="checkbox" id="checkbox0" checked="true"><label for="checkbox0">mid</label>']);
    });

    test('a bare box is a box (qjebbs/vscode-markdown-extended#158)', () => {
        const html = md.render('| a | b |\n| - | - |\n| [ ] | [x] |\n| [ ] todo | text [ ] |\n');
        assert.deepStrictEqual(cells(html), [
            '<input type="checkbox" id="checkbox0"><label for="checkbox0"></label>',
            '<input type="checkbox" id="checkbox1" checked="true"><label for="checkbox1"></label>',
            '<input type="checkbox" id="checkbox2"><label for="checkbox2">todo</label>',
            'text <input type="checkbox" id="checkbox3"><label for="checkbox3"></label>',
        ]);
        assert.strictEqual(md.render('[x]\n'),
            '<p><input type="checkbox" id="checkbox4" checked="true"><label for="checkbox4"></label></p>\n');
    });

    test('brackets that are no box stay text', () => {
        assert.strictEqual(md.render('[ab] and a[i] and [ ]**bold**\n'),
            '<p>[ab] and a[i] and [ ]<b>bold</b></p>\n');
    });

    test('an escaped box stays text, and the box after it is one', () => {
        assert.strictEqual(md.render('\\[x\\]\n\n\\[ \\] a\n\na \\[x\\] b [ ] c\n'), [
            '<p>[x]</p>',
            '<p>[ ] a</p>',
            '<p>a [x] b <input type="checkbox" id="checkbox0"><label for="checkbox0">c</label></p>',
            '',
        ].join('\n'));
    });
});
