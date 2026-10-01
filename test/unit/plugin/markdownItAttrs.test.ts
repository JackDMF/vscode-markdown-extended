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

suite('MarkdownItAttrs leaves a brace that is the text\'s own', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('a PowerShell hashtable in a table cell is shown whole (qjebbs/vscode-markdown-extended#146)', () => {
        const html = md.render([
            '| Name  | Properties     |',
            '| ----- | -------------- |',
            '| karin | @{height = 65} |',
            '',
        ].join('\n'));
        assert.deepStrictEqual(rows(html)[1], ['karin', '@{height = 65}']);
        assert.ok(!html.includes('height=""'), html);
    });

    for (const [source, text] of [
        ['Set it to @{height = 65}', 'Set it to @{height = 65}'],
        ['Spaced {height = 65}', 'Spaced {height = 65}'],
        ['Spaced {a= b}', 'Spaced {a= b}'],
        ['Spaced {a =b}', 'Spaced {a =b}'],
        ['*em*{a = b} after', '<i>em</i>{a = b} after'],
        // What the Visual Editor writes for a changed paragraph: `@` and `$` escaped, an entity kept.
        ['Set it to \\@{height = 65}', 'Set it to @{height = 65}'],
        ['An env var \\${VAR = 1}', 'An env var ${VAR = 1}'],
        ['An entity &amp;{x = 1}', 'An entity &amp;{x = 1}'],
        ['A private-use  character, then @{height = 65}', 'A private-use  character, then @{height = 65}'],
        ['Two {a = 1} and {b = 2}', 'Two {a = 1} and {b = 2}'],
    ]) {
        test(`${source} keeps its braces as text`, () => {
            assert.strictEqual(md.render(source), `<p>${text}</p>\n`);
        });
    }

    test('a list item\'s literal after a hashtable goes to the item, the hashtable stays text', () => {
        assert.strictEqual(md.render('- karin @{height = 65} {.row}\n'), '<ul>\n<li class="row">karin @{height = 65}</li>\n</ul>\n');
    });

    test('a paragraph of a hashtable after a table stays a paragraph, and gives the table nothing', () => {
        const html = md.render('| A |\n| - |\n| 1 |\n\n{height = 65}\n');
        assert.ok(html.includes('<table>'), html);
        assert.ok(html.includes('<p>{height = 65}</p>'), html);
    });

    test('a rule followed by a hashtable stays the paragraph it is', () => {
        assert.strictEqual(md.render('--- {.a}@{b = 1}\n'), '<p>--- {.a}@{b = 1}</p>\n');
    });

    test('a fence\'s info ending in a hashtable keeps its language and gets no attribute', () => {
        assert.ok(md.render('```ps1 @{a = 1}\nx\n```\n').startsWith('<pre><code class="language-ps1">'));
    });

    for (const [source, html] of [
        ['text {.a}', '<p class="a">text</p>\n'],
        ['text {#b}', '<p id="b">text</p>\n'],
        ['text {key=value}', '<p key="value">text</p>\n'],
        ['text {key="v w"}', '<p key="v w">text</p>\n'],
        ['text {title="a = b"}', '<p title="a = b">text</p>\n'],
        ['text {.a #b c=d}', '<p class="a" id="b" c="d">text</p>\n'],
        ['*em*{.a} after', '<p><i class="a">em</i> after</p>\n'],
        ['`code`{.a}', '<p><code class="a">code</code></p>\n'],
        ['[link](u){.a}', '<p><a href="u" class="a">link</a></p>\n'],
        ['==mark=={.a}', '<p><mark class="a">mark</mark></p>\n'],
        ['text\n{.a}', '<p class="a">text</p>\n'],
        // A brace glued to the text before it is read as on master.
        ['text{.lead}', '<p class="lead">text</p>\n'],
        ['Set it to @{height=65}', '<p height="65">Set it to @</p>\n'],
        ['*em*{.a}{.b}', '<p><i class="a b">em</i></p>\n'],
        ['---{.a}', '<hr class="a">\n'],
    ]) {
        test(`${source.replace('\n', '⏎')} is still read as attributes`, () => {
            assert.strictEqual(md.render(source), html);
        });
    }

    test('a glued heading anchor, a CJK one too, is the heading\'s id, as Req Explorer reads it', () => {
        assert.ok(md.render('## FR-1: Name{#fr-1}\n').includes('id="fr-1"'), md.render('## FR-1: Name{#fr-1}\n'));
        assert.ok(md.render('# 标题{#id}\n').includes('id="id"'), md.render('# 标题{#id}\n'));
    });

    test('a fence\'s glued literal leaves its language as on master', () => {
        assert.ok(md.render('```js{4}\nx\n```\n').includes('class="language-js"'), md.render('```js{4}\nx\n```\n'));
        const numbered = md.render('```js{.numberLines}\nx\n```\n');
        assert.ok(numbered.includes('language-js') && numbered.includes('numberLines') && !numbered.includes('language-js{'), numbered);
    });

    test('a span\'s chained literals both reach it', () => {
        const html = md.render('[span]{.a}{#b}');
        assert.ok(html.includes('class="a"') && html.includes('id="b"'), html);
    });

    test('the text reads the same on a second render', () => {
        const tokens = md.parse('Set it to @{height = 65}', {});
        assert.strictEqual(md.renderer.render(tokens, {}, {}), '<p>Set it to @{height = 65}</p>\n');
        assert.strictEqual(md.renderer.render(tokens, {}, {}), '<p>Set it to @{height = 65}</p>\n');
    });
});

suite('MarkdownItAttrs and a text brace: the review\'s second round', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('an = inside a value is the value\'s: base64 padding, an integrity hash', () => {
        const image = md.render('![i](p.png){data-h=YQ== .wide}');
        assert.ok(image.includes('data-h="YQ=="') && image.includes('class="wide"'), image);
        assert.strictEqual(md.render('text {integrity=sha256-abc= crossorigin=anonymous}'), '<p integrity="sha256-abc=" crossorigin="anonymous">text</p>\n');
    });

    test('a text brace anywhere in a paragraph attrs reads whole keeps all of it', () => {
        const table = md.render('| A |\n| - |\n| 1 |\n\n{.x} {a = b}\n');
        assert.ok(table.includes('<table>') && table.includes('<p>{.x} {a = b}</p>'), table);
        const list = md.render('- a\n\n{.x} {a = b}\n');
        assert.ok(list.includes('<ul>') && list.includes('<p>{.x} {a = b}</p>'), list);
        assert.strictEqual(md.render('para\n{.x} {a = b}\n'), '<p>para\n{.x} {a = b}</p>\n');
        assert.ok(md.render('--- {a = b} {.x}\n').includes('--- {a = b}'), md.render('--- {a = b} {.x}\n'));
    });

    test('a brace runs from its { to the first }, a { inside it included', () => {
        assert.strictEqual(md.render('*em*{a = {b} x'), '<p><i>em</i>{a = {b} x</p>\n');
    });

    test('the typographer sees the brace whole, as it would without attrs', () => {
        const typographic = new MarkdownIt({ typographer: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plugins.forEach(p => typographic.use(p.plugin as any, ...p.args));
        assert.strictEqual(typographic.render('x {a = --}'), '<p>x {a = --}</p>\n');
    });

    test('a fence\'s info that is only a text brace names no language, and one glued to a language that language', () => {
        assert.strictEqual(md.render('```{a = b}\nx\n```\n'), '<pre><code>x\n</code></pre>\n');
        assert.ok(md.render('```js{a = b}\nx\n```\n').startsWith('<pre><code class="language-js">'), md.render('```js{a = b}\nx\n```\n'));
    });

    test('a bracketed span whose literal is text is text, brackets and all', () => {
        assert.strictEqual(md.render('[x]{a = b}'), '<p>[x]{a = b}</p>\n');
        assert.strictEqual(md.render('A [*x*]{a = b} y'), '<p>A [<i>x</i>]{a = b} y</p>\n');
        assert.ok(md.render('[x]{.a}').includes('<span class="a">x</span>'));
    });

    test('an admonition\'s classes leave out a text brace', () => {
        const html = md.render('!!! note x {a = b} "Title"\n    Body.\n');
        assert.ok(html.includes('class="admonition note x"'), html);
    });
});