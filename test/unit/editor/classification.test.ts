import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { parseDocument } from '../../../src/editor';
import { conformanceDocument, hostEngine, readText, topChildren } from './helpers';

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

    check('the GFM table is raw: tables are not in the stage-1 editable core', () => {
        assert.strictEqual(block('| Construct |').type.name, 'raw_block');
        assert.strictEqual(block('| Field | Value |').type.name, 'raw_block');
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

    check('a block\'s src stops before the blank line markdown-it counts into a list\'s map; that line is the next gap', () => {
        const bullets = block('- A bullet list item.');
        assert.ok((bullets.attrs.src as string).endsWith('outer level.\n'));
        const ordered = block('1. An ordered list item.');
        assert.strictEqual(ordered.attrs.gap, '\n');
    });
});
