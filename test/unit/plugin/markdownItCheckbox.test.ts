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

// The ids count on across renders of one engine, so a test compares the
// markup with each box's id as `N`, and their order apart.
function render(md: MarkdownIt.MarkdownIt, src: string): string {
    return md.render(src).replace(/"checkbox\d+"/g, '"checkboxN"');
}

function box(label: string, checked = false): string {
    return `<input type="checkbox" id="checkboxN"${checked ? ' checked="true"' : ''}><label for="checkboxN">${label}</label>`;
}

suite('MarkdownItCheckbox', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('a task list renders as markdown-it-checkbox rendered it', () => {
        assert.strictEqual(md.render('- [ ] open\n- [x] done\n'), [
            '<ul>',
            '<li><input type="checkbox" id="checkbox0"><label for="checkbox0">open</label></li>',
            '<li><input type="checkbox" id="checkbox1" checked="true"><label for="checkbox1">done</label></li>',
            '</ul>',
            '',
        ].join('\n'));
        assert.strictEqual(render(md, '- [X] up\n- [_] u\n- [-] d\n'),
            `<ul>\n<li>${box('up', true)}</li>\n<li>${box('u')}</li>\n<li>${box('d')}</li>\n</ul>\n`);
    });

    test('the text before a box is kept', () => {
        assert.strictEqual(render(md, 'para [ ] mid\n'), `<p>para ${box('mid')}</p>\n`);
        assert.ok(render(md, '| a |\n| - |\n| text [x] mid |\n').includes(`<td>text ${box('mid', true)}</td>`));
    });

    test('an escaped bracket after a box stays in its label', () => {
        assert.strictEqual(render(md, '- [ ] see \\[1\\] here\n'), `<ul>\n<li>${box('see [1] here')}</li>\n</ul>\n`);
        assert.strictEqual(render(md, 'a [x] b \\[c\\]\n'), `<p>a ${box('b [c]', true)}</p>\n`);
    });

    test('an escape changes no box: the label runs to the end of the text, as before', () => {
        const label = box('b [c] d [ ] e', true);
        assert.strictEqual(render(md, 'a [x] b \\[c\\] d [ ] e\n'), `<p>a ${label}</p>\n`);
        assert.strictEqual(render(md, 'a [x] b [c] d [ ] e\n'), `<p>a ${label}</p>\n`);
    });

    test('an escaped box stays text', () => {
        assert.strictEqual(render(md, '\\[x\\] a\n'), '<p>[x] a</p>\n');
        assert.strictEqual(render(md, '\\[ \\] a\n'), '<p>[ ] a</p>\n');
    });

    test('a box needs the start of the text or whitespace before it', () => {
        assert.strictEqual(render(md, 'ends foo[x]\n'), '<p>ends foo[x]</p>\n');
        assert.strictEqual(render(md, 'a[i] x[x] y\n'), '<p>a[i] x[x] y</p>\n');
        assert.ok(render(md, '| a |\n| - |\n| arr[_] |\n').includes('<td>arr[_]</td>'));
    });

    test('a box with nothing after it stays text', () => {
        assert.ok(render(md, '# Heading [x]\n').includes('>Heading [x]</h1>'));
        assert.strictEqual(render(md, '- [ ]\n  wrapped\n'), '<ul>\n<li>[ ]\nwrapped</li>\n</ul>\n');
        assert.ok(render(md, '| a |\n| - |\n| [ ] |\n').includes('<td>[ ]</td>'));
    });

    test('only text becomes a box, never a code span', () => {
        assert.strictEqual(render(md, '`a [x] b` and [x] c\n'), `<p><code>a [x] b</code> and ${box('c', true)}</p>\n`);
    });

    test('boxes are numbered in the order they are written', () => {
        const ids = [...md.render('[ ] a\n[x] b\n\n- [ ] c\n').matchAll(/<input type="checkbox" id="checkbox(\d+)"/g)].map(([, n]) => Number(n));
        assert.strictEqual(ids.length, 3);
        assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b));
    });

    test('a text without a box keeps its tokens as they are', () => {
        const [inline] = md.parseInline('plain \\[x\\] text', {});
        assert.deepStrictEqual(inline.children.map(t => [t.type, t.content, t.meta]), [['text', 'plain [x] text', null]]);
    });
});
