import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { groupSourceBlocks, parseDocument, splitLines } from '../../../src/editor';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { conformanceDocument, constructsFixture, hostEngine, readText, topChildren } from './helpers';

/** FR-CON's raw blocks: each one's first line and the reason `blocks.ts` gives. */
const FR_CON_RAW: [string, string][] = [
    ['<!-- include: legal-notice -->', 'html_block'],
    ['<!-- requirement-summary: FR-CON-001 -->', 'html_block'],
    ['<details>', 'html_block'],
    ['</details>', 'html_block'],
    ['An authored inline element: press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>V</kbd> to', 'inline html_inline'],
];

/**
 * Which top-level blocks of Req Explorer's conformance document the editor may
 * edit, and why the rest are raw. Every test names the reason in its title.
 */
suite('Editor block classification (FR-CON.md)', () => {
    const fixture = conformanceDocument('FR-CON.md');
    const why = fixture.present ? '' : ` — skipped: not found at ${fixture.file} (set REQ_EXPLORER_ROOT)`;
    let blocks: Node[] = [];

    suiteSetup(() => {
        if (fixture.present) {
            // A checkout may hold the file with CRLF; classification does not
            // depend on it (the round-trip suite covers both), the slices below do.
            const text = readText(fixture.file).replace(/\r\n/g, '\n');
            blocks = topChildren(parseDocument(hostEngine(), text).doc);
        }
    });

    /** The one top-level block whose source starts with `prefix`. */
    function block(prefix: string): Node {
        const found = blocks.filter(b => typeof b.attrs.src === 'string' && (b.attrs.src as string).startsWith(prefix));
        assert.strictEqual(found.length, 1, `exactly one block starting with ${JSON.stringify(prefix)}`);
        return found[0];
    }

    function check(title: string, body: () => void): void {
        test(title + why, function () {
            if (!fixture.present) {
                this.skip();
            }
            body();
        });
    }

    check('front matter is one front_matter node holding the whole YAML block, fences included', () => {
        const fm = blocks[0];
        assert.strictEqual(fm.type.name, 'front_matter');
        assert.ok((fm.attrs.src as string).startsWith('---\ndoc: FR-CON\n'));
        assert.ok((fm.attrs.src as string).endsWith('---\n'));
    });

    check('the anchored requirement heading is editable: markdown-it-attrs moved {#…} into attrs, kept verbatim as attrsSuffix', () => {
        const heading = block('## FR-CON-001: ');
        assert.strictEqual(heading.type.name, 'heading');
        assert.strictEqual(heading.attrs.level, 2);
        assert.strictEqual(heading.attrs.attrsSuffix, '{#fr-con-001--21b3cb02}');
        assert.strictEqual(heading.attrs.anchor, 'fr-con-001--21b3cb02');
        assert.ok(!heading.textContent.includes('{'), 'the suffix is not editable text');
    });

    check('hard-wrapped paragraphs are editable and remember their width', () => {
        const paragraph = block('Paragraphs in this corpus are hard-wrapped by hand');
        assert.strictEqual(paragraph.type.name, 'paragraph');
        assert.strictEqual(paragraph.attrs.wrapWidth, 88);
    });

    check('the paragraph with authored <kbd> is raw: authored html_inline is not injected content', () => {
        assert.strictEqual(block('An authored inline element: press <kbd>').type.name, 'raw_block');
    });

    check('the GFM tables are editable tables: a pipe table is native, only multimd\'s extensions stay raw', () => {
        assert.strictEqual(block('| Construct |').type.name, 'table');
        assert.strictEqual(block('| Field | Value |').type.name, 'table');
    });

    check('the include directive is a raw html_block when no injecting plugin expands it', () => {
        const include = block('<!-- include: legal-notice -->');
        assert.strictEqual(include.type.name, 'raw_block');
        assert.strictEqual(include.attrs.src, '<!-- include: legal-notice -->\n');
    });

    check('the requirement-summary marker is raw: html_block', () => {
        assert.strictEqual(block('<!-- requirement-summary: FR-CON-001 -->').type.name, 'raw_block');
    });

    check('the <details> block is raw: an html_block ends at the blank line, so its opening and closing tags are two raw blocks', () => {
        assert.strictEqual(block('<details>\n<summary>').type.name, 'raw_block');
        assert.strictEqual(block('</details>').type.name, 'raw_block');
        assert.strictEqual(block('Its body is ordinary Markdown').type.name, 'paragraph');
    });

    check('the sidenote, marginal-note and both sidebar paragraphs (SPEC §6.2) are editable: the note family is rich text', () => {
        const expected: Record<string, string> = {
            'Fidelity is ++a property': 'sidenote',
            'The serializer !!lives': 'marginal_note',
            '@ **STATUS**': 'right_sidebar',
            '$ **BETRIFFT**': 'left_sidebar',
        };
        for (const [prefix, note] of Object.entries(expected)) {
            const paragraph = block(prefix);
            assert.strictEqual(paragraph.type.name, 'paragraph', prefix);
            const kinds: string[] = [];
            paragraph.forEach(child => kinds.push(child.type.name));
            assert.ok(kinds.includes(note), `${prefix}: ${kinds.join(', ')}`);
        }
    });

    check('the marginal note that spans a line break keeps its paragraph\'s width', () => {
        const paragraph = block('The serializer !!lives');
        assert.ok((paragraph.attrs.src as string).includes('\n'), 'two source lines');
        assert.strictEqual(typeof paragraph.attrs.wrapWidth, 'number');
    });

    check('fences, the blockquote, both lists and the rule are editable, with their written form in attrs', () => {
        const gherkin = block('```gherkin');
        assert.strictEqual(gherkin.type.name, 'code_block');
        assert.strictEqual(gherkin.attrs.params, 'gherkin');
        assert.strictEqual(block('```\nA fence with no info string.').attrs.params, '');
        assert.strictEqual(block('> A blockquote of two paragraphs').type.name, 'blockquote');
        const bullets = block('- A bullet list item.');
        assert.strictEqual(bullets.type.name, 'bullet_list');
        assert.strictEqual(bullets.attrs.bullet, '-');
        assert.strictEqual(bullets.attrs.tight, true);
        const ordered = block('1. An ordered list item.');
        assert.strictEqual(ordered.type.name, 'ordered_list');
        assert.strictEqual(ordered.attrs.delimiter, '.');
        const rule = blocks.filter(b => b.attrs.src === '---\n');
        assert.deepStrictEqual(rule.map(b => b.type.name), ['horizontal_rule']);
    });

    check('every block that stays raw, and why: HTML and markup inside a paragraph — the stage-3 constructs are not in this corpus', () => {
        const text = readText(fixture.file).replace(/\r\n/g, '\n');
        const { blocks: grouped } = groupSourceBlocks(hostEngine().parse(text, {}), splitLines(text), definitionOf(hostEngine()));
        const raw = grouped.filter(b => b.kind === 'raw').map(b => [(b.src ?? '').split('\n')[0], b.reason]);
        assert.deepStrictEqual(raw, FR_CON_RAW);
    });

    check('a block\'s src stops before the blank line markdown-it counts into a list\'s map; that line is the next gap', () => {
        const bullets = block('- A bullet list item.');
        assert.ok((bullets.attrs.src as string).endsWith('outer level.\n'));
        const ordered = block('1. An ordered list item.');
        assert.strictEqual(ordered.attrs.gap, '\n');
    });
});

/**
 * The same over this repository's fixture, which holds every construct the
 * extension renders: which blocks are rich text since stage 3 (attributes,
 * spans, containers, admonitions), and why each of the others is a source block.
 */
suite('Editor block classification (constructs.md)', () => {
    const text = readText(constructsFixture).replace(/\r\n/g, '\n');
    const grouped = groupSourceBlocks(hostEngine().parse(text, {}), splitLines(text), definitionOf(hostEngine())).blocks;
    const blocks = topChildren(parseDocument(hostEngine(), text).doc);

    /** The one top-level block whose source starts with `prefix`, and its classification. */
    function block(prefix: string): { node: Node; reason: string } {
        const at = grouped.map((b, i) => ((b.src ?? '').startsWith(prefix) ? i : -1)).filter(i => i >= 0);
        assert.strictEqual(at.length, 1, `exactly one block starting with ${JSON.stringify(prefix)}`);
        return { node: blocks[at[0]], reason: grouped[at[0]].reason };
    }

    test('admonitions, with a title and without, and containers, nested one level, are nodes holding their blocks', () => {
        const titled = block('!!! note "A titled note"').node;
        assert.deepStrictEqual([titled.type.name, titled.attrs.type, titled.attrs.title], ['admonition', 'note', 'A titled note']);
        const untitled = block('!!! tip').node;
        assert.deepStrictEqual([untitled.type.name, untitled.attrs.title, untitled.child(1).type.name], ['admonition', '', 'bullet_list']);
        const warning = block('::: warning').node;
        assert.deepStrictEqual([warning.type.name, warning.attrs.name], ['container', 'warning']);
        const outer = block(':::: note-box wide').node;
        assert.deepStrictEqual([outer.type.name, outer.attrs.name, outer.attrs.info, outer.attrs.markup], ['container', 'note-box', ' wide', '::::']);
        const kinds: string[] = [];
        outer.forEach(child => kinds.push(child.type.name));
        assert.deepStrictEqual(kinds, ['paragraph', 'bullet_list', 'container']);
    });

    test('block attributes are kept where they were written: end of line, own line under a paragraph or a list, a fence\'s line', () => {
        const suffix = (prefix: string) => [block(prefix).node.type.name, block(prefix).node.attrs.attrsSuffix, block(prefix).node.attrs.attrsPlacement];
        assert.deepStrictEqual(suffix('A paragraph with a class.'), ['paragraph', '{.lead}', 'end']);
        assert.deepStrictEqual(suffix('A class on its own line'), ['paragraph', '{.aside}', 'line']);
        assert.deepStrictEqual(suffix('- A list\n- with a class'), ['bullet_list', '{.checklist}', 'line']);
        assert.deepStrictEqual(suffix('```js {.numbered}'), ['code_block', '{.numbered}', 'end']);
        assert.deepStrictEqual(suffix('> A quote with a class'), ['blockquote', '{.pull}', 'line']);
        assert.deepStrictEqual(suffix('> A quote whose class stands lazily'), ['blockquote', '{.pull-lazy}', 'line']);
        assert.deepStrictEqual(suffix('| Table | with a class right under it'), ['table', '{.line-table}', 'line']);
        assert.deepStrictEqual(suffix('| Table | with a class after a blank line'), ['table', '{.blank-table}', 'blank']);
        const list = block('+ A list item with a class').node;
        assert.deepStrictEqual([list.type.name, list.child(0).attrs.literal, list.child(1).attrs.literal], ['bullet_list', '{.done}', null]);
    });

    test('attribute spans are rich text, each literal as written', () => {
        const p = block('A [styled span]').node;
        const literals: string[] = [];
        p.forEach(child => {
            const span = child.marks.find(m => m.type.name === 'attr_span');
            if (span && !literals.includes(span.attrs.literal as string)) {
                literals.push(span.attrs.literal as string);
            }
        });
        assert.deepStrictEqual([p.type.name, literals], ['paragraph', ['{#s1 .accent style="color: red"}', '{class="a b"}']]);
    });

    test('the pipe table is a table node, each column aligned as its delimiter cell says', () => {
        const table = block('| Left | Centre | Right |').node;
        assert.strictEqual(table.type.name, 'table');
        const aligns: unknown[] = [];
        table.child(0).forEach(cell => aligns.push(cell.attrs.align));
        assert.deepStrictEqual(aligns, ['left', 'center', 'right']);
    });

    test('what stays raw, and why: the TOC, a setext heading, footnotes, definition lists, task lists, inline HTML, abbreviations, reference definitions', () => {
        const raw = grouped.filter(b => b.kind === 'raw').map(b => [(b.src ?? '').split('\n')[0], b.reason]);
        assert.deepStrictEqual(raw, CONSTRUCTS_RAW);
    });
});

/**
 * A container written with a `{…}` on its `:::` line: the preview draws the
 * literal on the container's `div` (qjebbs/vscode-markdown-extended#126), the
 * container node has no slot for it, so the block is a source block saying so.
 */
suite('Editor block classification: a container with attributes', () => {
    const reason = 'container attributes on its ::: line, which the container node does not keep';

    for (const [where, text] of [
        ['at top level', '::: note {#id .c}\nInside.\n:::\n'],
        ['alone on the line', '::: { .admonition .note }\nInside.\n:::\n'],
        ['nested in a container', ':::: outer\n::: inner {.c}\nInside.\n:::\n::::\n'],
    ]) {
        test(`${where} is a source block: ${reason}`, () => {
            const grouped = groupSourceBlocks(hostEngine().parse(text, {}), splitLines(text), definitionOf(hostEngine())).blocks;
            assert.deepStrictEqual(grouped.map(b => [b.kind, b.reason]), [['raw', reason]]);
        });
    }

    test('one without stays a container node', () => {
        const text = '::: note c\nInside.\n:::\n';
        assert.strictEqual(topChildren(parseDocument(hostEngine(), text).doc)[0].type.name, 'container');
    });
});

/**
 * An emoji the host reads in a paragraph makes it a source block (no editable
 * node holds one). The save escapes every shortcut of the plugin's table where
 * the host would read it, so what the page wrote opens editable again.
 */
suite('Editor block classification: an emoji shortcut', () => {
    test('a paragraph saved as 5\\$\\:) opens as a paragraph holding 5$:)', () => {
        const [paragraph, ...rest] = topChildren(parseDocument(hostEngine(), '5\\$\\:)\n').doc);
        assert.deepStrictEqual([paragraph.type.name, rest.length], ['paragraph', 0]);
        assert.strictEqual(paragraph.textContent, '5$:)');
    });

    test('as 5\\$:), what the save wrote before the shortcut was escaped, it is a source block: inline emoji', () => {
        const text = '5\\$:)\n';
        const grouped = groupSourceBlocks(hostEngine().parse(text, {}), splitLines(text), definitionOf(hostEngine())).blocks;
        assert.deepStrictEqual(grouped.map(b => [b.kind, b.reason]), [['raw', 'inline emoji']]);
    });
});

/** constructs.md's raw blocks: each one's first line and the reason `blocks.ts` gives. */
const CONSTRUCTS_RAW: [string, string][] = [
    ['[[toc]]', 'toc_open'],
    ['Setext heading', 'setext heading: its underline has no place in the heading node'],
    ['A sentence with a footnote.[^first]', 'inline footnote_ref'],
    ['[^first]: The footnote body.', 'source lines no token accounts for'],
    ['Term', 'dl_open'],
    ['- [ ] An open task', 'inline checkbox_input'],
    ['Press <kbd>Ctrl</kbd> or [[Ctrl+S]], ==mark== this, H~2~O and x^2^, :smile:, ~~gone~~.', 'inline html_inline'],
    ['*[HTML]: HyperText Markup Language', 'source lines no token accounts for'],
    ['An abbreviation: HTML.', 'inline abbr_open'],
    ['[ref]: https://example.net/ref', 'source lines no token accounts for'],
];
