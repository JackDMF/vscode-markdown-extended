import * as assert from 'assert';
import * as path from 'path';
import { Mark, Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EDITABLE_TOP_NODES, ParsedDocument, fidelityPlugin, groupSourceBlocks, parseDocument, serializeDocument, splitLines } from '../../../src/editor';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { editorSchema } from '../../../src/editor/schema';
import { literalNotReadBack } from '../../../src/editor/serialize';
import {
    EditorObject, changeLinkTransaction, changeMarkLiteralRefusal, changeMarkLiteralTransaction, literalRefusal, objectAtSelection,
} from '../../../src/editor/webview/objects';
import { toggleMarkup } from '../../../src/editor/webview/toolbar/commands';
import { hostEngine, readText, repoRoot, topChildren, touched } from './helpers';

const options = { defaultWrap: 90 };

/** The real-world shapes: a talk outline citing sources with `[…](…){.source}`, marking points with `_✓_{.colorize}`. */
const FIXTURE = path.join(repoRoot, 'test', 'fixtures', 'editor', 'markLiterals.md');

function write(parsed: ParsedDocument, doc = parsed.doc): string {
    return serializeDocument({ ...parsed, doc }, options);
}

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function byRule(parsed: ParsedDocument): string {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return write(parsed, parsed.doc.type.create(null, children));
}

/** Each mark carrying a literal, by its name and literal, in document order: one entry per text node. */
function literals(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants(node => {
        for (const mark of node.marks) {
            if (typeof mark.attrs.literal === 'string') {
                out.push(`${mark.type.name}${mark.attrs.literal as string}`);
            }
        }
    });
    return out;
}

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: [fidelityPlugin()] });
}

function text(state: EditorState): string {
    return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, options);
}

function posOf(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(needle)) {
            found = pos + (node.text ?? '').indexOf(needle);
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}" in the document`);
    return found;
}

function select(state: EditorState, needle: string, from = 0, to = from): EditorState {
    const at = posOf(state.doc, needle);
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at + from, at + to)));
}

/** The text node `needle` stands in, unmarked, inserted right after it: what typing beside a mark that does not extend over it gives. */
function insertAfter(state: EditorState, needle: string, inserted: string): EditorState {
    return state.apply(state.tr.insert(posOf(state.doc, needle) + needle.length, editorSchema.text(inserted)));
}

/** The attributes of the first `<tag …>` in `html`, in order. */
function attrsOfFirst(html: string, tag: string): [string, string][] {
    const m = new RegExp(`<${tag}((?:\\s+[^\\s=>]+(?:="[^"]*")?)*)\\s*>`).exec(html);
    assert.ok(m, `no <${tag}> in ${html}`);
    return Array.from(m[1].matchAll(/([^\s=]+)(?:="([^"]*)")?/g), a => [a[1], (a[2] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&')] as [string, string]);
}

suite('Editor mark literals: emphasis and links with {…} after them are rich text', () => {
    const md = hostEngine();
    const first = (source: string) => topChildren(parseDocument(md, source).doc)[0];
    const reasons = (source: string) => groupSourceBlocks(md.parse(source, {}), splitLines(source), definitionOf(md)).blocks.map(b => b.reason);

    for (const [source, expected] of [
        ['A *word*{.a} here.\n', ['em{.a}']],
        ['A _word_{.colorize} here.\n', ['em{.colorize}']],
        ['A **word**{#w .a} here.\n', ['strong{#w .a}']],
        ['A __word__{data-n="3"} here.\n', ['strong{data-n="3"}']],
        ['A ~~word~~{.gone} here.\n', ['strike{.gone}']],
        ['A ==word=={ .hi  #h } here.\n', ['mark{ .hi  #h }']],
        ['See [the source](https://example.org/a){.source} here.\n', ['link{.source}']],
        ['See [w02 1. 11. 12-13](){.source} here.\n', ['link{.source}']],
        ['See <https://example.org>{.source} here.\n', ['link{.source}']],
        ['See [the source](https://example.org "Title"){.source} here.\n', ['link{.source}']],
    ] as const) {
        test(`${source.trim()}: the literal is the mark's, verbatim; untouched and written by rule as it was`, () => {
            const parsed = parseDocument(md, source);
            const p = topChildren(parsed.doc)[0];
            assert.strictEqual(p.type.name, 'paragraph', reasons(source).join());
            assert.deepStrictEqual([...new Set(literals(p))], expected);
            assert.strictEqual(write(parsed), source);
            assert.strictEqual(byRule(parsed), source);
            assert.strictEqual(literalNotReadBack(touched(p)), null);
        });
    }

    test('nested marks each keep their own literal, matched in the order the source closes them', () => {
        const source = 'A [_one_{.x} two](u){.y} and _three_{.z}.\n';
        const p = first(source);
        assert.deepStrictEqual([...new Set(literals(p))], ['em{.x}', 'link{.y}', 'em{.z}']);
        assert.strictEqual(byRule(parseDocument(md, source)), source);
    });

    test('a literal right before a list item\'s {…} stays the mark\'s, the item\'s stays the item\'s', () => {
        const source = '- Zitat [w02 1. 11. 12-13](){.source} {.unused}\n- _&#x2713;_{.colorize} Punkt\n';
        const list = first(source);
        assert.strictEqual(list.type.name, 'bullet_list');
        assert.strictEqual(list.child(0).attrs.literal, '{.unused}');
        assert.deepStrictEqual([...new Set(literals(list))], ['link{.source}', 'em{.colorize}']);
        // Written by rule, the entity becomes its character, as anywhere in a changed block; the literals stand where they stood.
        assert.strictEqual(byRule(parseDocument(md, source)), '- Zitat [w02 1. 11. 12-13](){.source} {.unused}\n- _✓_{.colorize} Punkt\n');
    });

    test('a second literal the plugin merged in, and a bare address, are written in the normalized form', () => {
        assert.strictEqual(byRule(parseDocument(md, 'A _b_{.x}{.y} c.\n')), 'A _b_{.x .y} c.\n');
        // A bare address has no closing character for the literal to follow: it is written as a link.
        assert.strictEqual(byRule(parseDocument(md, 'See https://example.org{.a} now.\n')), 'See [https://example.org](https://example.org){.a} now.\n');
    });

    test('a literal the editor cannot keep leaves the block a source block, with its reason', () => {
        assert.deepStrictEqual(reasons('A `code`{.c} b.\n'), ['attributes on code_inline']);
        assert.deepStrictEqual(reasons('A ![i](x.png){.c} b.\n'), ['attributes on image']);
        assert.deepStrictEqual(reasons('A _b_{title="a}b"} c.\n'), ['emphasis whose literal holds a quoted }']);
        assert.deepStrictEqual(reasons('Text ++ref|a _b_{title="x|y"} body++ end.\n'), ['emphasis in a note whose literal holds a note marker']);
    });

    test('in a note and in a table cell the literal is kept too', () => {
        for (const source of ['Text ++ref|a _b_{.c} body++ end.\n', '| a | b |\n| - | - |\n| _x_{.c} | [y](u){.d} |\n']) {
            const node = first(source);
            assert.notStrictEqual(node.type.name, 'raw_block', source);
            assert.ok(literals(node).length > 0, source);
            const once = byRule(parseDocument(md, source));
            assert.deepStrictEqual(literals(first(once)), literals(node), once);
        }
    });

    test('the elements carry the attributes the engine renders: em.colorize, a.source', () => {
        for (const [source, tag] of [
            ['_&#x2713;_{.colorize #c1}', 'em'],
            ['*x*{.a}', 'i'],
            ['**x**{.a}', 'b'],
            ['~~x~~{.a}', 's'],
            ['==x=={.a style="color: red"}', 'mark'],
        ] as const) {
            const html = md.renderInline(source);
            const mark = topChildren(parseDocument(md, `${source}\n`).doc)[0].firstChild?.marks[0] as Mark;
            const spec = mark.type.spec.toDOM?.(mark, true) as unknown as [string, Record<string, string>];
            assert.strictEqual(spec[0], tag, source);
            assert.deepStrictEqual(Object.entries(spec[1]).filter(([n]) => !n.startsWith('data-mep-')), attrsOfFirst(html, tag), source);
        }
        const link = topChildren(parseDocument(md, '[Quelle](https://example.org){.source #q}\n').doc)[0].firstChild?.marks[0] as Mark;
        const drawn = (link.type.spec.toDOM?.(link, true) as unknown as [string, Record<string, string>])[1];
        assert.strictEqual(drawn.class, 'source');
        assert.strictEqual(drawn.id, 'q');
        assert.strictEqual(drawn.href, 'https://example.org');
    });

    test('a link\'s literal that sets its href or title is no literal of the mark', () => {
        assert.strictEqual(byRule(parseDocument(md, '[a](u){title=t}\n')), '[a](u "t")\n', 'the title is the link\'s');
        assert.ok(literalRefusal('{title=t}', 'link') !== null);
        assert.ok(literalRefusal('{href=x .a}', 'link') !== null);
        assert.strictEqual(literalRefusal('{.source}', 'link'), null);
        assert.ok(literalRefusal('{title="a}b"}', 'em') !== null, 'after a closing delimiter the plugin cuts at the first }');
    });

    test('the real-world shapes: no source block for a link\'s or emphasis\' attributes, and every literal reads back', () => {
        const source = readText(FIXTURE);
        const blocks = groupSourceBlocks(md.parse(source, {}), splitLines(source), definitionOf(md)).blocks;
        assert.deepStrictEqual(blocks.filter(b => b.kind === 'raw').map(b => b.reason), []);
        const parsed = parseDocument(md, source);
        assert.strictEqual(write(parsed), source, 'untouched, byte for byte');
        assert.strictEqual(literals(parsed.doc).filter(l => l.startsWith('link{.source}')).length >= 8, true);
        for (const node of topChildren(parsed.doc)) {
            if (EDITABLE_TOP_NODES.has(node.type.name)) {
                assert.strictEqual(literalNotReadBack(touched(node)), null, node.textContent.slice(0, 60));
            }
        }
        const once = byRule(parsed);
        assert.deepStrictEqual(literals(parseDocument(md, once).doc), literals(parsed.doc));
    });
});

suite('Editor mark literals: edits keep the literal with its mark', () => {
    test('typing inside the mark keeps its literal; the block is written with it where it stood', () => {
        let state = stateOf('- Gesetze: _&check;_{.colorize} &ndash; aber *durchsetzen*.\n');
        state = select(state, '✓', 1);
        state = state.apply(state.tr.insertText('✓'));
        assert.strictEqual(text(state), '- Gesetze: _✓✓_{.colorize} – aber *durchsetzen*.\n');
        let link = stateOf('See [Quelle](https://example.org){.source} {.unused}\n');
        link = select(link, 'Quelle', 3);
        link = link.apply(link.tr.insertText('l'));
        assert.strictEqual(text(link), 'See [Quellle](https://example.org){.source} {.unused}\n');
    });

    test('a text {…} typed right after a mark is escaped, never read as attributes nor taking the literal\'s place', () => {
        const cases: [string, string, string, string][] = [
            ['x [a](u){.x} z\n', 'a', '{b}', 'x [a](u){.x}\\{b\\} z\n'],
            ['x _a_ z\n', 'a', '{.y}', 'x _a_\\{.y\\} z\n'],
            ['x _a_{.y} z\n', 'a', '{.y}', 'x _a_{.y}\\{.y\\} z\n'],
            // The same text after an earlier emphasis: that one is escaped, the literal of the later stays.
            ['x _a_ y _b_{.y} z\n', 'a', '{.y}', 'x _a_\\{.y\\} y _b_{.y} z\n'],
            ['- x [a](u){.y}\n', 'a', ' {.unused}', '- x [a](u){.y} \\{.unused\\}\n'],
        ];
        for (const [source, needle, inserted, written] of cases) {
            const state = insertAfter(stateOf(source), needle, inserted);
            assert.strictEqual(text(state), written, source);
            assert.strictEqual(literalNotReadBack(state.doc.child(0)), null, source);
            const back = parseDocument(hostEngine(), written, {}).doc;
            assert.strictEqual(back.textContent, state.doc.textContent, `${written} reads back as shown`);
            assert.deepStrictEqual(literals(back), literals(state.doc), written);
        }
    });

    test('a letter right after emphasis with a literal keeps its _ delimiter: the literal stands between', () => {
        const state = insertAfter(stateOf('x _a_{.c} z\n'), 'a', 'b');
        assert.strictEqual(text(state), 'x _a_{.c}b z\n');
    });

    test('the link\'s new address keeps its literal', () => {
        let state = select(stateOf('See [Quelle](https://a.example){.source}.\n'), 'Quelle', 2);
        const link = objectAtSelection(state) as Extract<EditorObject, { kind: 'link' }>;
        state = state.apply(changeLinkTransaction(state, link, 'https://b.example') as never);
        assert.strictEqual(text(state), 'See [Quelle](https://b.example){.source}.\n');
    });

    test('the other delimiter, or emphasis extended over more text, keeps the literal; removed from part, the rest keeps it', () => {
        let swapped = select(stateOf('A *word*{.c} b.\n'), 'word', 0, 4);
        toggleMarkup(editorSchema.marks.em, '_')(swapped, tr => {
            swapped = swapped.apply(tr);
        });
        assert.strictEqual(text(swapped), 'A _word_{.c} b.\n');

        let extended = select(stateOf('A _word_{.c} more b.\n'), 'word', 0, 9);
        toggleMarkup(editorSchema.marks.em, '_')(extended, tr => {
            extended = extended.apply(tr);
        });
        assert.strictEqual(text(extended), 'A _word more_{.c} b.\n');

        let removed = select(stateOf('A _word_{.c} b.\n'), 'word', 2, 4);
        toggleMarkup(editorSchema.marks.em, '_')(removed, tr => {
            removed = removed.apply(tr);
        });
        assert.strictEqual(text(removed), 'A _wo_{.c}rd b.\n');
    });

    test('Attributes… on a link and on a styled run: set, change and remove the literal, refused where it would not read back', () => {
        let state = select(stateOf('See [Quelle](https://a.example) now.\n'), 'Quelle', 2);
        let link = objectAtSelection(state) as Extract<EditorObject, { kind: 'link' }>;
        state = state.apply(changeMarkLiteralTransaction(state, link, '{.source}') as never);
        assert.strictEqual(text(state), 'See [Quelle](https://a.example){.source} now.\n');
        link = objectAtSelection(state) as Extract<EditorObject, { kind: 'link' }>;
        assert.ok(changeMarkLiteralRefusal(state, link, '{title=x}') !== null);
        state = state.apply(changeMarkLiteralTransaction(state, link, '{}') as never);
        assert.strictEqual(text(state), 'See [Quelle](https://a.example) now.\n');

        let styled = select(stateOf('A _&#x2713;_{.colorize} b.\n'), '✓', 1);
        const object = objectAtSelection(styled) as Extract<EditorObject, { kind: 'styled' }>;
        assert.strictEqual(object.kind, 'styled');
        styled = styled.apply(changeMarkLiteralTransaction(styled, object, '{.colorize .big}') as never);
        assert.strictEqual(text(styled), 'A _✓_{.colorize .big} b.\n');
        const again = objectAtSelection(styled) as Extract<EditorObject, { kind: 'styled' }>;
        styled = styled.apply(changeMarkLiteralTransaction(styled, again, '') as never);
        assert.strictEqual(text(styled), 'A _✓_ b.\n');
        assert.strictEqual(objectAtSelection(styled), null, 'emphasis without a literal is formatting, not an object');
    });
});
