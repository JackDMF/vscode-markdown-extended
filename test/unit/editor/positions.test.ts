import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EDITABLE_TOP_NODES, ParsedDocument, fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { PositionMap, SourcePosition, caretOf, createPositionMap, holdsText } from '../../../src/editor/positions';
import { serializeLayout } from '../../../src/editor/serialize';
import { hostEngine, toCrlf, topChildren, touched } from './helpers';

const OPTIONS = { defaultWrap: 90 };

/** The page position where the `nth` occurrence of `needle` starts in one of the document's text nodes. */
function pageOf(doc: Node, needle: string, nth = 0): number {
    let found = -1;
    let seen = 0;
    doc.descendants((node, pos) => {
        if (found >= 0) {
            return false;
        }
        if (node.isText) {
            const text = node.text ?? '';
            for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
                if (seen++ === nth) {
                    found = pos + at;
                    return false;
                }
            }
        }
        return true;
    });
    assert.ok(found >= 0, `the page has the text ${JSON.stringify(needle)}`);
    return found;
}

/** The source position where the `nth` occurrence of `needle` starts in `text`. */
function sourceOf(text: string, needle: string, nth = 0): SourcePosition {
    let at = -1;
    for (let k = 0; k <= nth; k++) {
        at = text.indexOf(needle, at + 1);
    }
    assert.ok(at >= 0, `the text has ${JSON.stringify(needle)}`);
    const lines = text.slice(0, at).split(/\r\n|\r|\n/);
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

/** The offset of a source position in `text`, lines broken as VS Code breaks them. */
function offsetOf(text: string, position: SourcePosition): number {
    const re = /\r\n|\r|\n/g;
    let start = 0;
    for (let line = 0; line < position.line; line++) {
        const m = re.exec(text);
        assert.ok(m, `line ${position.line} exists`);
        start = m.index + m[0].length;
    }
    return start + position.character;
}

/** `pos` maps exactly to `expected`, and `expected` exactly back to `pos`. */
function assertBothWays(map: PositionMap, pos: number, expected: SourcePosition, what: string): void {
    assert.deepStrictEqual(map.sourcePositionOf(pos), { ...expected, approximate: false }, what);
    assert.deepStrictEqual(map.pagePositionOf(expected), { pos, approximate: false }, `${what}, back`);
}

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function allTouched(parsed: ParsedDocument): ParsedDocument {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return { ...parsed, doc: parsed.doc.type.create(null, children) };
}

/** `parsed` after `edit`, as the fidelity plugin leaves it: the edited blocks lose their `src`. */
function edited(parsed: ParsedDocument, edit: (state: EditorState) => ReturnType<EditorState['tr']['insertText']>): ParsedDocument {
    const state = EditorState.create({ doc: parsed.doc, plugins: [fidelityPlugin()] });
    return { ...parsed, doc: state.apply(edit(state)).doc };
}

/** A document of every editable construct the mapping has to see through. */
const PROPERTY_SOURCE = [
    '---',
    'title: Positions',
    '---',
    '',
    '# A heading with `code` {#anchor}',
    '',
    'Some *emphasis*, **strong**, ==mark==, a [link](https://example.com/x) and',
    'a second line with ~~strike~~ and [[Ctrl+S]].',
    '',
    '- one item',
    '- two items, the second',
    '  wrapped onto a continuation line',
    '  1. nested ordered',
    '',
    '> A quote with ++a reference|and its note++ inside.',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '1. first',
    '2. second',
    '',
    '::: note info',
    'Inside a container.',
    ':::',
    '',
    '!!! warning "Careful"',
    '    The body of an admonition.',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    'Last paragraph with $left sidebar$ text and !!margin|a marginal note!!.',
    '',
    // A multimd table (its `=` delimiter row) stays a source block: the raw atom the walk passes.
    '| c | d |',
    '| = | = |',
    '| 3 | 4 |',
    '',
].join('\n');

suite('Editor positions: page ↔ source', () => {
    const md = hostEngine();

    test('the layout puts every body where the text holds it', () => {
        const parsed = parseDocument(md, PROPERTY_SOURCE);
        for (const variant of [parsed, allTouched(parsed)]) {
            const layout = serializeLayout(variant, OPTIONS);
            assert.strictEqual(layout.text, serializeDocument(variant, OPTIONS));
            assert.strictEqual(layout.blocks.length, variant.doc.childCount);
            for (const block of layout.blocks) {
                assert.strictEqual(layout.text.slice(block.start, block.start + block.body.length), block.body);
            }
        }
    });

    test('the line a block starts on is read from the layout, a seam it widened included', () => {
        // `text` + an emptied first item: the layout puts a blank line between them, so the list starts on line 2, not 1.
        const parsed = parseDocument(md, 'text\n- a\n- b\n\nAfter.\n');
        const [paragraph, list, after] = topChildren(parsed.doc);
        const first = list.child(0);
        const emptied = first.type.create(first.attrs, first.content.replaceChild(0, first.child(0).type.create(first.child(0).attrs)));
        const doc = parsed.doc.type.create(null, [paragraph, touched(list, list.content.replaceChild(0, emptied)), after]);
        const map = createPositionMap({ ...parsed, doc }, OPTIONS);
        assert.strictEqual(map.text, 'text\n\n- \n- b\n\nAfter.\n');
        assert.deepStrictEqual([0, 1, 2].map(i => map.blockLine(i)), [0, 2, 5]);
        assert.strictEqual(map.blockLine(3), 6, 'past the last block: the line its body ends on');
    });

    test('an unedited block: the slice\'s offset plus the offset inside it, delimiters stepped over', () => {
        const source = 'First line.\n\nSome *emphasis* and `code` in [a link](https://x.org/y).\n';
        const parsed = parseDocument(md, source);
        const map = createPositionMap(parsed, OPTIONS);
        assert.strictEqual(map.text, source);
        assertBothWays(map, pageOf(parsed.doc, 'mphasis'), sourceOf(source, 'mphasis'), 'inside emphasis');
        assertBothWays(map, pageOf(parsed.doc, 'ode'), sourceOf(source, 'ode'), 'inside code');
        assertBothWays(map, pageOf(parsed.doc, 'ink'), sourceOf(source, 'ink'), 'inside the link text');
        // Between text and a delimiter the caret goes with the character before it.
        assertBothWays(map, pageOf(parsed.doc, 'emphasis'), sourceOf(source, '*emphasis'), 'before the opening *');
        assertBothWays(map, pageOf(parsed.doc, ' and'), sourceOf(source, '* and'), 'after the text, before the closing *');
        assertBothWays(map, pageOf(parsed.doc, 'a link') + 'a link'.length, sourceOf(source, '](https'), 'the end of the link text');
        assertBothWays(map, pageOf(parsed.doc, 'Some'), sourceOf(source, 'Some'), 'the start of a paragraph');
    });

    test('an edited paragraph maps against its fresh serialization, marks and wrapping included', () => {
        const parsed = parseDocument(md, 'Intro.\n\nSome *emphasis*, **strong**, ==mark== and a [link](https://example.com/x) here.\n');
        const changed = edited(parsed, state => state.tr.insertText('A much longer opening that will make the serializer wrap this paragraph now. ', pageOf(state.doc, 'Some')));
        const map = createPositionMap(changed, { defaultWrap: 40 });
        assert.strictEqual(map.text, serializeDocument(changed, { defaultWrap: 40 }));
        assert.ok(map.text.split('\n').length > 4, `wrapped: ${map.text}`);
        for (const needle of ['mphasis', 'trong', 'ark', 'ink', 'here', 'serializer', 'paragraph now']) {
            assertBothWays(map, pageOf(changed.doc, needle), sourceOf(map.text, needle), needle);
        }
    });

    test('an edited heading: its markers, its code span and its anchor are delimiters', () => {
        const parsed = parseDocument(md, '## A heading with `code` {#anchor}\n\nText.\n');
        const changed = edited(parsed, state => state.tr.insert(pageOf(state.doc, 'code') + 'code'.length, state.schema.text(' more')));
        const map = createPositionMap(changed, OPTIONS);
        assert.strictEqual(map.text.split('\n')[0], '## A heading with `code` more {#anchor}');
        assertBothWays(map, pageOf(changed.doc, 'A heading'), { line: 0, character: 3 }, 'the start of the text, after the markers');
        assertBothWays(map, pageOf(changed.doc, 'ode'), sourceOf(map.text, 'ode'), 'inside the code span');
        assertBothWays(map, pageOf(changed.doc, 'more') + 4, sourceOf(map.text, ' {#anchor}'), 'the end of the text, before the anchor');
    });

    test('list items: bullets, numbers and a wrapped item\'s indentation are delimiters', () => {
        const source = '- one item\n- two items, the second\n  wrapped onto a continuation line\n\n1. 1st of the numbered\n2. 2nd\n';
        const parsed = parseDocument(md, source);
        for (const variant of [parsed, allTouched(parsed)]) {
            const map = createPositionMap(variant, OPTIONS);
            const text = map.text;
            assertBothWays(map, pageOf(variant.doc, 'one'), sourceOf(text, 'one'), 'the first item');
            assertBothWays(map, pageOf(variant.doc, 'two'), sourceOf(text, 'two'), 'the second item');
            assertBothWays(map, pageOf(variant.doc, 'wrapped'), sourceOf(text, 'wrapped'), 'a continuation line, after its indentation');
            assertBothWays(map, pageOf(variant.doc, '1st'), sourceOf(text, '1st'), 'a numbered item whose text starts with a digit');
            assertBothWays(map, pageOf(variant.doc, '2nd'), sourceOf(text, '2nd'), 'the next numbered item');
        }
    });

    test('a source position inside a line\'s prefix is approximate, even where the soft break matched one of its spaces', () => {
        const parsed = parseDocument(md, '- two items, the second\n  wrapped onto a line\n\n> A quote that\n> wraps.\n');
        for (const variant of [parsed, allTouched(parsed)]) {
            const map = createPositionMap(variant, OPTIONS);
            const item = sourceOf(map.text, 'wrapped');
            assert.strictEqual(map.pagePositionOf({ line: item.line, character: 1 })?.approximate, true, 'between the two indentation spaces');
            assert.strictEqual(map.pagePositionOf({ line: item.line, character: 0 })?.approximate, true, 'before the indentation');
            assertBothWays(map, pageOf(variant.doc, 'wrapped'), item, 'after the indentation, the text');
            const quote = sourceOf(map.text, 'wraps');
            assert.strictEqual(map.pagePositionOf({ line: quote.line, character: 1 })?.approximate, true, 'between > and its space');
            assertBothWays(map, pageOf(variant.doc, 'wraps'), quote, 'after the quote\'s prefix, the text');
        }
    });

    test('after a character is after its whole spelling, an escape\'s and an entity\'s alike', () => {
        const source = 'A \\* star and &amp; amp.\n';
        const parsed = parseDocument(md, source);
        assert.strictEqual(parsed.doc.textContent, 'A * star and & amp.');
        const map = createPositionMap(parsed, OPTIONS);
        assertBothWays(map, pageOf(parsed.doc, '* star') + 1, sourceOf(source, ' star'), 'after an escaped *');
        assertBothWays(map, pageOf(parsed.doc, '& amp') + 1, sourceOf(source, ' amp.'), 'after &amp;');
        assertBothWays(map, pageOf(parsed.doc, '& amp'), sourceOf(source, '&amp;'), 'before &amp;');
        const inside = sourceOf(source, 'amp;');
        assert.strictEqual(map.pagePositionOf({ line: 0, character: inside.character + 1 })?.approximate, true, 'inside the entity');
    });

    test('an inline note: the reference and the body find their columns, a character reference included', () => {
        const source = 'Text ++a ref|the body text++ after, and ++x&#124;y|z++ too.\n';
        const parsed = parseDocument(md, source);
        for (const variant of [parsed, allTouched(parsed)]) {
            const map = createPositionMap(variant, OPTIONS);
            const text = map.text;
            assertBothWays(map, pageOf(variant.doc, 'a ref'), sourceOf(text, 'a ref'), 'the start of the reference');
            assertBothWays(map, pageOf(variant.doc, 'the body'), sourceOf(text, 'the body'), 'the start of the body');
            assertBothWays(map, pageOf(variant.doc, 'ody text'), sourceOf(text, 'ody text'), 'inside the body');
            assertBothWays(map, pageOf(variant.doc, ' after'), sourceOf(text, ' after'), 'after the note');
            assertBothWays(map, pageOf(variant.doc, 'x|y') + 2, sourceOf(text, 'y|z'), 'after a reference\'s | written as &#124;');
            assertBothWays(map, pageOf(variant.doc, 'z'), sourceOf(text, 'z++'), 'the body after it');
        }
    });

    test('a table: each cell is its text between pipes, the padding and the delimiter row delimiters, unedited and edited', () => {
        const source = 'Intro.\n\n|Name|Value|\n|:--|--:|\n| Alpha \\| x | 1 |\n|Beta|22|\n\nAfter.\n';
        const parsed = parseDocument(md, source);
        assert.strictEqual(parsed.doc.child(1).type.name, 'table');
        const typed = edited(parsed, state => state.tr.insertText('max', pageOf(state.doc, 'Beta') + 'Beta'.length));
        for (const [variant, name] of [[parsed, 'unedited'], [typed, 'edited']] as const) {
            const map = createPositionMap(variant, OPTIONS);
            const text = map.text;
            if (variant === typed) {
                assert.ok(text.includes('| Betamax    |    22 |'), `written tidy: ${text}`);
            }
            for (const needle of ['Name', 'alue', 'Alpha', ' x', '1', 'eta', '22', 'After']) {
                assertBothWays(map, pageOf(variant.doc, needle), sourceOf(text, needle), `${name}: ${needle}`);
            }
            const beta = variant === typed ? 'Betamax' : 'Beta';
            const end = pageOf(variant.doc, beta) + beta.length;
            const after = sourceOf(text, beta);
            assertBothWays(map, end, { line: after.line, character: after.character + beta.length }, `${name}: the end of a cell's text, before its padding`);
            const caret = caretOf(TextSelection.create(variant.doc, end), map);
            assert.deepStrictEqual(caret, { line: after.line, character: after.character + beta.length }, `${name}: a caret in a cell is reported`);
        }
    });

    test('a header-only table: its delimiter row is anchored after the header all the same, unedited and edited', () => {
        const source = 'Intro.\n\n|Name|Kind|\n|:--|---|\n\nAfter.\n';
        const parsed = parseDocument(md, source);
        assert.strictEqual(parsed.doc.child(1).type.name, 'table');
        assert.strictEqual(parsed.doc.child(1).childCount, 1);
        const typed = edited(parsed, state => state.tr.insertText('s', pageOf(state.doc, 'Kind') + 'Kind'.length));
        for (const [variant, name] of [[parsed, 'unedited'], [typed, 'edited']] as const) {
            const map = createPositionMap(variant, OPTIONS);
            const text = map.text;
            if (variant === typed) {
                assert.ok(text.includes('| Name | Kinds |\n| :--- | ----- |\n'), `written tidy: ${text}`);
            }
            for (const needle of ['Name', 'ame', 'Kind', 'ind', 'After']) {
                assertBothWays(map, pageOf(variant.doc, needle), sourceOf(text, needle), `${name}: ${needle}`);
            }
        }
    });

    test('a raw atom maps to its whole slice: its start before it, its end after it', () => {
        const source = 'Before.\n\n| a | b |\n| = | = |\n| 1 | 2 |\n\nAfter.\n';
        const parsed = parseDocument(md, source);
        assert.deepStrictEqual(topChildren(parsed.doc).map(n => n.type.name), ['paragraph', 'raw_block', 'paragraph']);
        const map = createPositionMap(parsed, OPTIONS);
        const before = parsed.doc.child(0).nodeSize;
        const after = before + parsed.doc.child(1).nodeSize;
        assertBothWays(map, before, { line: 2, character: 0 }, 'the position before the table');
        assertBothWays(map, after, { line: 4, character: 9 }, 'the position after it');
        assert.deepStrictEqual(map.pagePositionOf({ line: 3, character: 4 }), { pos: before, approximate: true }, 'inside the table');
    });

    test('a position in an atom or on a selected node is no caret', () => {
        const parsed = parseDocument(md, 'Before.\n\n| a | b |\n| = | = |\n\nAn ![image](x.png) here.\n');
        const map = createPositionMap(parsed, OPTIONS);
        const state = EditorState.create({ doc: parsed.doc });
        const raw = parsed.doc.child(0).nodeSize;
        assert.strictEqual(caretOf(NodeSelection.create(state.doc, raw), map), null, 'a selected source block');
        const image = pageOf(parsed.doc, ' here') - 1;
        assert.strictEqual(caretOf(NodeSelection.create(state.doc, image), map), null, 'a selected image');
        assert.deepStrictEqual(caretOf(TextSelection.create(state.doc, pageOf(parsed.doc, 'ore')), map), { line: 0, character: 3 });
        // Beside the image the caret is exact: the image is a gap between its neighbours.
        assertBothWays(map, image, sourceOf(map.text, '![image]'), 'before the image');
        assertBothWays(map, image + 1, sourceOf(map.text, ' here'), 'after the image');
    });

    test('a CRLF source maps to the same lines and characters as its LF twin', () => {
        const lf = parseDocument(md, PROPERTY_SOURCE);
        const crlf = parseDocument(md, toCrlf(PROPERTY_SOURCE));
        for (const [a, b] of [[lf, crlf], [allTouched(lf), allTouched(crlf)]]) {
            const mapA = createPositionMap(a, OPTIONS);
            const mapB = createPositionMap(b, OPTIONS);
            assert.ok(mapB.text.includes('\r\n') && !mapB.text.replace(/\r\n/g, '').includes('\n'), 'every line break is CRLF');
            for (let pos = 0; pos <= a.doc.content.size; pos++) {
                assert.deepStrictEqual(mapB.sourcePositionOf(pos), mapA.sourcePositionOf(pos), `pos ${pos}`);
            }
            const lines = mapA.text.split('\n');
            lines.forEach((line, l) => {
                for (let c = 0; c <= line.length; c++) {
                    assert.deepStrictEqual(mapB.pagePositionOf({ line: l, character: c }), mapA.pagePositionOf({ line: l, character: c }), `${l}:${c}`);
                }
            });
        }
    });

    test('past the end, or no position at all: clamped and approximate, or null — never a throw', () => {
        const source = 'Before.\n\nAfter.\n';
        const parsed = parseDocument(md, source);
        const map = createPositionMap(parsed, OPTIONS);
        const size = parsed.doc.content.size;
        const endOfAfter = pageOf(parsed.doc, 'After.') + 'After.'.length;
        assert.deepStrictEqual(map.pagePositionOf({ line: 99, character: 0 }), { pos: endOfAfter, approximate: true }, 'past the last line');
        assert.deepStrictEqual(map.pagePositionOf({ line: 0, character: 99 }), { pos: pageOf(parsed.doc, 'Before.') + 7, approximate: true }, 'past a line\'s end');
        assert.deepStrictEqual(map.pagePositionOf({ line: 1, character: 0 }).approximate, true, 'the blank line between blocks');
        assert.deepStrictEqual(map.sourcePositionOf(size), { line: 2, character: 6, approximate: true }, 'the end of the document');
        assert.strictEqual(map.sourcePositionOf(size + 1), null);
        assert.strictEqual(map.sourcePositionOf(-1), null);
        assert.strictEqual(map.sourcePositionOf(1.5), null);
        assert.strictEqual(map.pagePositionOf({ line: Number.NaN, character: 0 }), null);
        assert.strictEqual(map.pagePositionOf(undefined as unknown as SourcePosition), null);
        assert.strictEqual(map.pageRangeOf({ start: { line: 0, character: 0 }, end: { line: 0.5, character: 0 } }), null);
        assert.deepStrictEqual(
            map.pageRangeOf({ start: { line: 2, character: 3 }, end: { line: 0, character: 2 } }),
            { from: pageOf(parsed.doc, 'fore'), to: pageOf(parsed.doc, 'er.'), approximate: false },
            'a range is in document order',
        );
    });

    test('an empty paragraph has no text of its own: the nearest place, approximately', () => {
        const parsed = parseDocument(md, 'Before.\n\nAfter.\n');
        const withEmpty = edited(parsed, state => state.tr.insert(parsed.doc.child(0).nodeSize, state.schema.nodes.paragraph.create()));
        const map = createPositionMap(withEmpty, OPTIONS);
        const inside = withEmpty.doc.child(0).nodeSize + 1;
        assert.strictEqual(map.sourcePositionOf(inside)?.approximate, true);
        assert.strictEqual(caretOf(TextSelection.create(withEmpty.doc, inside), map), null, 'an approximate caret is not reported');
    });

    test('a block too large for the alignment\'s budget is aligned greedily, every answer approximate', () => {
        const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
        const source = `${words} [link](https://example.com/${'a'.repeat(6000)}) end.\n`;
        const parsed = parseDocument(md, source);
        const map = createPositionMap(parsed, OPTIONS);
        const mapped = map.sourcePositionOf(pageOf(parsed.doc, 'w150'));
        assert.strictEqual(mapped?.approximate, true);
        assert.strictEqual(mapped?.line, 0);
        assert.strictEqual(map.pagePositionOf(sourceOf(source, 'w150'))?.approximate, true);
    });

    for (const [name, lineEnding] of [['LF', (s: string) => s], ['CRLF', toCrlf]] as const) {
        for (const touch of [false, true]) {
            test(`every text position maps exactly and back to itself (${name}, ${touch ? 'every block edited' : 'unedited'})`, () => {
                const parsed = parseDocument(md, lineEnding(PROPERTY_SOURCE));
                const variant = touch ? allTouched(parsed) : parsed;
                const map = createPositionMap(variant, OPTIONS);
                const doc = variant.doc;
                const kinds = new Set<string>();
                doc.descendants(node => {
                    kinds.add(node.type.name);
                });
                for (const kind of ['front_matter', 'heading', 'bullet_list', 'ordered_list', 'blockquote', 'sidenote', 'marginal_note',
                    'left_sidebar', 'raw_block', 'container', 'admonition', 'code_block']) {
                    assert.ok(kinds.has(kind), `the document holds a ${kind}`);
                }
                let checked = 0;
                for (let pos = 0; pos <= doc.content.size; pos++) {
                    const $pos = doc.resolve(pos);
                    if (!holdsText($pos.parent)) {
                        continue;
                    }
                    const source = map.sourcePositionOf(pos);
                    assert.ok(source !== null && !source.approximate, `pos ${pos} maps exactly: ${JSON.stringify(source)}`);
                    const back = map.pagePositionOf(source);
                    assert.deepStrictEqual(back, { pos, approximate: false }, `pos ${pos} → ${source.line}:${source.character} → back`);
                    // After a character of text the source position is after that same character.
                    const before = $pos.nodeBefore;
                    if (before?.isText) {
                        const ch = (before.text ?? '').slice(-1);
                        if (ch !== ' ') {
                            const offset = offsetOf(map.text, source);
                            assert.strictEqual(map.text.charAt(offset - 1), ch, `pos ${pos}: after ${JSON.stringify(ch)}`);
                        }
                    }
                    checked++;
                }
                assert.ok(checked > 300, `${checked} text positions checked`);
            });
        }
    }
});
