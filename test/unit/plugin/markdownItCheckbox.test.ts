import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';

// The preview's own registry, in its order.
function preview(options: MarkdownIt.Options = {}): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt(options);
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

    test('a box right after an escape or an entity is text, and a later box in the same text still is one', () => {
        assert.strictEqual(render(md, '&amp;[ ] a [x] b\n'), `<p>&amp;[ ] a ${box('b', true)}</p>\n`);
        assert.strictEqual(render(md, 'x \\*[x] a [ ] b\n'), `<p>x *[x] a ${box('b')}</p>\n`);
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

    test('the label takes the task\'s whole text, formatting included', () => {
        assert.strictEqual(render(md, '- [ ] task **one**\n'), `<ul>\n<li>${box('task <b>one</b>')}</li>\n</ul>\n`);
        assert.strictEqual(render(md, '- [ ] **task one**\n'), `<ul>\n<li>${box('<b>task one</b>')}</li>\n</ul>\n`);
        assert.strictEqual(render(md, '- [x] see [doc](u) and `x`\n'), `<ul>\n<li>${box('see <a href="u">doc</a> and <code>x</code>', true)}</li>\n</ul>\n`);
        assert.strictEqual(render(md, '- [ ] task\n  more\n'), `<ul>\n<li>${box('task\nmore')}</li>\n</ul>\n`);
    });

    test('a label ends with the element its box stands in, or before the next box beside it', () => {
        assert.strictEqual(render(md, '**[ ] a** b\n'), `<p><b>${box('a')}</b> b</p>\n`);
        assert.strictEqual(render(md, '[ ] a\n[x] b\n'), `<p>${box('a')}\n${box('b', true)}</p>\n`);
        assert.strictEqual(render(md, 'a [x] b **c** [ ] d\n'), `<p>a ${box('b <b>c</b> ', true)}${box('d')}</p>\n`);
        assert.strictEqual(render(md, '[ ] a\nb **c** [x] d\n'), `<p>${box('a\nb <b>c</b> ')}${box('d', true)}</p>\n`);
        // No label holds another: a box inside an element the label takes in is text.
        assert.strictEqual(render(md, '[ ] a **b [x] c**\n'), `<p>${box('a <b>b [x] c</b>')}</p>\n`);
        // Starting a line of its own, as decided.
        assert.strictEqual(render(md, '- [ ] a *b\n  [x] c*\n'), `<ul>\n<li>${box('a <i>b\n[x] c</i>')}</li>\n</ul>\n`);
    });

    test('a label nests with inline HTML: it ends before the close of an element opened before it, and takes in one it opens whole', () => {
        const html = preview({ html: true });
        assert.strictEqual(render(html, '<span>[ ] a</span> b\n'), `<p><span>${box('a')}</span> b</p>\n`);
        assert.strictEqual(render(html, '- [ ] a </span> b\n'), `<ul>\n<li>${box('a ')}</span> b</li>\n</ul>\n`);
        // A box inside an element the label opens is text, as in emphasis.
        assert.strictEqual(render(html, '[ ] a <i>b\n[x] c</i>\n'), `<p>${box('a <i>b\n[x] c</i>')}</p>\n`);
        assert.strictEqual(render(html, '[ ] a <i>b</i> [x] c\n'), `<p>${box('a <i>b</i> ')}${box('c', true)}</p>\n`);
        // A void tag opens nothing, written with a slash or without.
        assert.strictEqual(render(html, '[ ] a <br> b [x] c\n'), `<p>${box('a <br> b ')}${box('c', true)}</p>\n`);
        assert.strictEqual(render(html, '[ ] a <br/> b [x] c\n'), `<p>${box('a <br/> b ')}${box('c', true)}</p>\n`);
    });

    test('an element opened and not closed inside a label keeps the later boxes text, its slash ignored', () => {
        const html = preview({ html: true });
        // As the owner decided: no label holds another, and the span is still open at the next box.
        assert.strictEqual(render(html, '[ ] a <span>b [x] c\n'), `<p>${box('a <span>b [x] c')}</p>\n`);
        // In HTML the slash of a non-void tag is ignored: `<span/>` opens a span, as `<span>` does.
        assert.strictEqual(render(html, '[ ] a <span/> b [x] c\n'), `<p>${box('a <span/> b [x] c')}</p>\n`);
        assert.strictEqual(render(html, '[ ] a <x/> b [x] c\n'), `<p>${box('a <x/> b [x] c')}</p>\n`);
        // Closed again, the element is whole and the next box is a box.
        assert.strictEqual(render(html, '[ ] a <span/> b </span> [x] c\n'), `<p>${box('a <span/> b </span> ')}${box('c', true)}</p>\n`);
    });

    test('an svg or math tag with a slash closes itself, so later boxes stay boxes; without the slash it opens, and any other element keeps its slash ignored', () => {
        const html = preview({ html: true });
        // Foreign content self-closes in HTML, unlike an HTML element.
        assert.strictEqual(render(html, '- [ ] a <svg/> b [ ] c\n'), `<ul>\n<li>${box('a <svg/> b ')}${box('c')}</li>\n</ul>\n`);
        assert.strictEqual(render(html, '[ ] a <math/> b [x] c\n'), `<p>${box('a <math/> b ')}${box('c', true)}</p>\n`);
        // Without the slash they open, and the later box stays text.
        assert.strictEqual(render(html, '[ ] a <svg> b [x] c\n'), `<p>${box('a <svg> b [x] c')}</p>\n`);
        assert.strictEqual(render(html, '[ ] a <math> b [x] c\n'), `<p>${box('a <math> b [x] c')}</p>\n`);
        // Any other element keeps the HTML rule: the slash is ignored and the element stays open.
        assert.strictEqual(render(html, '[ ] a <a id="x"/> b [x] c\n'), `<p>${box('a <a id="x"/> b [x] c')}</p>\n`);
    });

    test('a formatted label is still the label of its box', () => {
        const html = md.render('- [ ] task **one**\n');
        const [, id] = /<input type="checkbox" id="(checkbox\d+)">/.exec(html) ?? [];
        assert.ok(id);
        assert.ok(html.includes(`<label for="${id}">task <b>one</b></label>`), html);
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
