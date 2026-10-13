import * as assert from 'assert';
import * as path from 'path';
import { Mark, Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EDITABLE_TOP_NODES, ParsedDocument, fidelityPlugin, groupSourceBlocks, parseDocument, serializeDocument, splitLines } from '../../../src/editor';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { editorSchema } from '../../../src/editor/schema';
import { literalLostReason, literalNotReadBack, unwritableInTable } from '../../../src/editor/serialize';
import {
    EditorObject, LiteralObject, changeLinkTransaction, changeInlineLiteralRefusal, changeInlineLiteralTransaction, editImageTransaction, literalObjectOf,
    literalRefusal, objectAtSelection,
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

/** Each mark or image carrying a literal, by its name and literal, in document order: one entry per text node or image. */
function literals(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants(node => {
        if (node.type.name === 'image' && typeof node.attrs.literal === 'string') {
            out.push(`image${node.attrs.literal as string}`);
        }
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
        state = state.apply(changeInlineLiteralTransaction(state, link, '{.source}') as never);
        assert.strictEqual(text(state), 'See [Quelle](https://a.example){.source} now.\n');
        link = objectAtSelection(state) as Extract<EditorObject, { kind: 'link' }>;
        assert.ok(changeInlineLiteralRefusal(state, link, '{title=x}') !== null);
        state = state.apply(changeInlineLiteralTransaction(state, link, '{}') as never);
        assert.strictEqual(text(state), 'See [Quelle](https://a.example) now.\n');

        let styled = select(stateOf('A _&#x2713;_{.colorize} b.\n'), '✓', 1);
        const object = objectAtSelection(styled) as Extract<EditorObject, { kind: 'styled' }>;
        assert.strictEqual(object.kind, 'styled');
        styled = styled.apply(changeInlineLiteralTransaction(styled, object, '{.colorize .big}') as never);
        assert.strictEqual(text(styled), 'A _✓_{.colorize .big} b.\n');
        const again = objectAtSelection(styled) as Extract<EditorObject, { kind: 'styled' }>;
        styled = styled.apply(changeInlineLiteralTransaction(styled, again, '') as never);
        assert.strictEqual(text(styled), 'A _✓_ b.\n');
        assert.strictEqual(objectAtSelection(styled), null, 'emphasis without a literal is formatting, not an object');
    });
});

/** The image node of `state` (the first), selected as a whole, as a click selects it. */
function selectImage(state: EditorState): EditorState {
    let at = -1;
    state.doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === 'image') {
            at = pos;
        }
        return at < 0;
    });
    assert.ok(at >= 0, 'no image in the document');
    return state.apply(state.tr.setSelection(NodeSelection.create(state.doc, at)));
}

suite('Editor inline literals: inline code, an image, superscript, subscript and a key keep their {…}', () => {
    const md = hostEngine();
    const first = (source: string) => topChildren(parseDocument(md, source).doc)[0];
    const reasons = (source: string) => groupSourceBlocks(md.parse(source, {}), splitLines(source), definitionOf(md)).blocks.map(b => b.reason);

    for (const [source, expected] of [
        ['A `x`{.c} b.\n', ['code{.c}']],
        ['A ``x`y``{.c} b.\n', ['code{.c}']],
        ['A `x`{title=t} b.\n', ['code{title=t}']],
        ['Run `--flag`{.k} now.\n', ['code{.k}']],
        ['A ![a](s.png){.c} b.\n', ['image{.c}']],
        ['![a](s.png){.c}\n', ['image{.c}']],
        ['A ![a](s.png "t"){.c} b.\n', ['image{.c}']],
        ['![Screenshot](img.png){width=400}\n', ['image{width=400}']],
        ['A ![a](v.mp4){.c} b.\n', ['image{.c}']],
        ['x^2^{.c} b.\n', ['sup{.c}']],
        ['H~2~{.f}O b.\n', ['sub{.f}']],
        ['Press [[Ctrl]]{.key} now.\n', ['kbd{.key}']],
        ['![a](s.png){.c} {.d}\n', ['image{.c}']],
        ['- ![a](s.png){.c} {.unused}\n', ['image{.c}']],
        ['A *`x`{.c}*{.d} b.\n', ['em{.d}', 'code{.c}']],
        ['A ^a^{.c}^b^{.d} c.\n', ['sup{.c}', 'sup{.d}']],
        ['A ~x~{.c}~~y~~{.d} b.\n', ['sub{.c}', 'strike{.d}']],
        ['A [[a]]{.c}[[b]] b.\n', ['kbd{.c}']],
        ['A [[a *b*]]{.c} b.\n', ['kbd{.c}']],
        ['A [[[a]]{.c}](u) b.\n', ['kbd{.c}']],
        ['A `x`{.c}`y`{.d} b.\n', ['code{.c}', 'code{.d}']],
        // The first `{.c}` follows a backtick but is the code's text; recovery goes on past the one it took.
        ['A `{.c}`{.c} and `y`{.d} b.\n', ['code{.c}', 'code{.d}']],
        ['[![a](s.png){.c}](u){.d}\n', ['image{.c}', 'link{.d}']],
        ['Text ++ref|a `x`{.c} body++ end.\n', ['code{.c}']],
        ['| a | b |\n| - | - |\n| `x`{.c} | ![a](s.png){.d} |\n', ['code{.c}', 'image{.d}']],
    ] as const) {
        test(`${source.trim()}: the literal is the element's, verbatim; untouched and written by rule as it was`, () => {
            const parsed = parseDocument(md, source);
            const node = topChildren(parsed.doc)[0];
            assert.notStrictEqual(node.type.name, 'raw_block', reasons(source).join());
            assert.deepStrictEqual([...new Set(literals(node))], expected);
            assert.strictEqual(write(parsed), source);
            // A table written by rule is tidied: its literals stand where they stood, read back the same.
            const once = byRule(parsed);
            if (node.type.name !== 'table') {
                assert.strictEqual(once, source);
            }
            assert.deepStrictEqual(literals(first(once)), literals(node), once);
            assert.strictEqual(literalNotReadBack(touched(node)), null);
        });
    }

    test('a line holding a long image with a literal is no evidence of the paragraph\'s width: the literal is held with it', () => {
        const source = 'Some words here that wrap at forty\n![a long alt text](images/a-long-path.png){.hero width=300}\nand more words after the image here,\nand a last line of words to close it.\n';
        assert.strictEqual(byRule(parseDocument(md, source)), source);
    });

    test('a second literal the plugin merged in, and a reference image, are written in the forms that read the same', () => {
        assert.strictEqual(byRule(parseDocument(md, 'A `x`{.c}{.d} b.\n')), 'A `x`{.c .d} b.\n');
        assert.strictEqual(byRule(parseDocument(md, '![a][r]{.c} b.\n\n[r]: s.png\n')), '![a](s.png){.c} b.\n\n[r]: s.png\n');
    });

    test('an image\'s src, alt and title are its own: a {…} setting them is no literal, as a link\'s href', () => {
        assert.strictEqual(byRule(parseDocument(md, 'A ![a](s.png){alt=b} b.\n')), 'A ![a](s.png) b.\n', 'the preview takes the alt from the text');
        assert.strictEqual(byRule(parseDocument(md, 'A ![a](s.png){title=t} b.\n')), 'A ![a](s.png "t") b.\n');
        for (const literal of ['{src=x.png}', '{alt=x}', '{title=x}', '{.c title=x}']) {
            assert.ok(literalRefusal(literal, 'image')?.includes('src, alt or title'), literal);
        }
        assert.strictEqual(literalRefusal('{.hero width=300}', 'image'), null);
    });

    test('what stays a source block: a quoted } in each one\'s literal, a note marker in a note; a wiki embed\'s {…} is text', () => {
        assert.deepStrictEqual(reasons('A `x`{title="a}b"} c.\n'), ['inline code whose literal holds a quoted }']);
        assert.deepStrictEqual(reasons('A ![a](s.png){.c data-x="a}b"} c.\n'), ['image whose literal holds a quoted }']);
        assert.deepStrictEqual(reasons('A ^x^{title="a}b"} c.\n'), ['superscript whose literal holds a quoted }']);
        assert.deepStrictEqual(reasons('A ~x~{title="a}b"} c.\n'), ['subscript whose literal holds a quoted }']);
        assert.deepStrictEqual(reasons('A [[x]]{title="a}b"} c.\n'), ['key whose literal holds a quoted }']);
        assert.deepStrictEqual(reasons('Text ++ref|a `x`{title="x|y"} body++ end.\n'), ['inline code in a note whose literal holds a note marker']);
        const embed = first('A ![[e.png]]{.c} b.\n');
        assert.strictEqual(embed.type.name, 'paragraph');
        assert.ok(embed.textContent.includes('{.c} b.'));
        assert.strictEqual(byRule(parseDocument(md, 'A ![[e.png]]{.c} b.\n')), 'A ![[e.png]]{.c} b.\n');
    });

    test('an emoji right after a literal is placed and kept', () => {
        for (const source of ['A `x`{.c}:smile: b.\n', 'A ![a](s.png){.c} :) b.\n']) {
            const p = first(source);
            assert.strictEqual(p.type.name, 'paragraph', reasons(source).join());
            let emoji = 0;
            p.descendants(n => {
                emoji += n.type.name === 'emoji' ? 1 : 0;
            });
            assert.strictEqual(emoji, 1, source);
            assert.strictEqual(byRule(parseDocument(md, source)), source);
        }
    });

    test('the elements carry the attributes the engine renders: code.c, sup, sub, kbd, img with a width', () => {
        for (const [source, tag] of [['`x`{.c #i}', 'code'], ['^x^{.c}', 'sup'], ['~x~{.c}', 'sub'], ['[[x]]{.c data-k=1}', 'kbd']] as const) {
            const html = md.renderInline(source);
            const mark = (first(`${source}\n`).firstChild as Node).marks[0];
            const spec = mark.type.spec.toDOM?.(mark, true) as unknown as [string, Record<string, string>];
            assert.strictEqual(spec[0], tag, source);
            assert.deepStrictEqual(Object.entries(spec[1]).filter(([n]) => !n.startsWith('data-mep-')), attrsOfFirst(html, tag), source);
        }
        const source = '![pic](p.png){.hero width=300}';
        const image = first(`${source}\n`).firstChild as Node;
        const spec = image.type.spec.toDOM?.(image) as unknown as [string, Record<string, string | null>];
        const drawn = Object.entries(spec[1]).filter(([n, v]) => !n.startsWith('data-mep-') && v !== null);
        assert.deepStrictEqual(drawn, attrsOfFirst(md.renderInline(source), 'img'));
    });
});

suite('Editor inline literals: edits keep the literal of code, an image, superscript, subscript and a key', () => {
    test('typing inside keeps the literal', () => {
        for (const [source, needle, written] of [
            ['A `ab`{.c} z.\n', 'ab', 'A `axb`{.c} z.\n'],
            ['A ^ab^{.c} z.\n', 'ab', 'A ^axb^{.c} z.\n'],
            ['A ~ab~{.c} z.\n', 'ab', 'A ~axb~{.c} z.\n'],
            ['A [[ab]]{.c} z.\n', 'ab', 'A [[axb]]{.c} z.\n'],
        ] as const) {
            let state = select(stateOf(source), needle, 1);
            state = state.apply(state.tr.insertText('x'));
            assert.strictEqual(text(state), written, source);
        }
    });

    test('a text {…} typed right after one, with a literal or without, is escaped and reads back as shown', () => {
        const cases: [string, string, string][] = [
            ['x `a` z\n', 'a', '{.y}'],
            ['x `a`{.c} z\n', 'a', '{.y}'],
            ['x ^a^ z\n', 'a', '{.y}'],
            ['x ^a^{.c} z\n', 'a', '{.y}'],
            ['x ~a~{.c} z\n', 'a', '{.y}'],
            ['x [[a]] z\n', 'a', '{.y}'],
            ['x [[a]]{.c} z\n', 'a', '{.y}'],
        ];
        for (const [source, needle, inserted] of cases) {
            const state = insertAfter(stateOf(source), needle, inserted);
            const written = text(state);
            assert.ok(written.includes('\\{.y\\}'), `${source} -> ${written}`);
            assert.strictEqual(literalNotReadBack(state.doc.child(0)), null, source);
            const back = parseDocument(hostEngine(), written, {}).doc;
            assert.strictEqual(back.textContent, state.doc.textContent, `${written} reads back as shown`);
            assert.deepStrictEqual(literals(back), literals(state.doc), written);
        }
        for (const source of ['x ![a](s.png) z\n', 'x ![a](s.png){.c} z\n']) {
            let state = stateOf(source);
            let after = -1;
            state.doc.descendants((n, pos) => {
                if (after < 0 && n.type.name === 'image') {
                    after = pos + n.nodeSize;
                }
                return after < 0;
            });
            state = state.apply(state.tr.insert(after, editorSchema.text('{.y}')));
            const written = text(state);
            assert.ok(written.includes('\\{.y\\}'), `${source} -> ${written}`);
            assert.strictEqual(literalNotReadBack(state.doc.child(0)), null, source);
            assert.deepStrictEqual(literals(parseDocument(hostEngine(), written, {}).doc), literals(state.doc), written);
        }
    });

    test('code, superscript or a key extended over more text keeps the literal; removed from part, the rest keeps it', () => {
        for (const [mark, source, extended, removed] of [
            [editorSchema.marks.code, 'A `word`{.c} more b.\n', 'A `word more`{.c} b.\n', 'A `wo`{.c}rd more b.\n'],
            [editorSchema.marks.sup, 'A ^word^{.c} more b.\n', 'A ^word more^{.c} b.\n', 'A ^wo^{.c}rd more b.\n'],
            [editorSchema.marks.kbd, 'A [[word]]{.c} more b.\n', 'A [[word more]]{.c} b.\n', 'A [[wo]]{.c}rd more b.\n'],
        ] as const) {
            let more = select(stateOf(source), 'word', 0, 9);
            toggleMarkup(mark, null)(more, tr => {
                more = more.apply(tr);
            });
            assert.strictEqual(text(more), extended, source);
            let part = select(stateOf(source), 'word', 2, 4);
            toggleMarkup(mark, null)(part, tr => {
                part = part.apply(tr);
            });
            assert.strictEqual(text(part), removed, source);
        }
    });

    test('Edit image… keeps the literal', () => {
        let state = selectImage(stateOf('A ![a](s.png){.hero} b.\n'));
        state = state.apply(editImageTransaction(state, state.selection.from, 'b', 't.png') as never);
        assert.strictEqual(text(state), 'A ![b](t.png){.hero} b.\n');
    });

    test('Attributes… on an image: set, change, remove; its src, alt and title refused', () => {
        let state = selectImage(stateOf('An ![pic](p.png) here.\n'));
        let image = literalObjectOf(objectAtSelection(state)) as LiteralObject;
        assert.strictEqual(image.kind, 'image');
        for (const literal of ['{src=x}', '{alt=x}', '{title=x}']) {
            assert.ok(changeInlineLiteralRefusal(state, image, literal) !== null, literal);
            assert.strictEqual(changeInlineLiteralTransaction(state, image, literal), null, literal);
        }
        state = state.apply(changeInlineLiteralTransaction(state, image, '{.hero width=300}') as never);
        assert.strictEqual(text(state), 'An ![pic](p.png){.hero width=300} here.\n');
        assert.ok(state.selection instanceof NodeSelection, 'the image stays selected');
        image = literalObjectOf(objectAtSelection(state)) as LiteralObject;
        state = state.apply(changeInlineLiteralTransaction(state, image, '{.hero}') as never);
        assert.strictEqual(text(state), 'An ![pic](p.png){.hero} here.\n');
        image = literalObjectOf(objectAtSelection(state)) as LiteralObject;
        state = state.apply(changeInlineLiteralTransaction(state, image, '{}') as never);
        assert.strictEqual(text(state), 'An ![pic](p.png) here.\n');
    });

    test('a run of code, superscript, subscript or a key carrying a literal is a styled object; without one it is formatting', () => {
        for (const [source, needle] of [['A `ab`{.c} z.\n', 'ab'], ['A ^ab^{.c} z.\n', 'ab'], ['A ~ab~{.c} z.\n', 'ab'], ['A [[ab]]{.c} z.\n', 'ab']] as const) {
            const state = select(stateOf(source), needle, 1);
            const object = objectAtSelection(state) as Extract<EditorObject, { kind: 'styled' }>;
            assert.strictEqual(object?.kind, 'styled', source);
            const set = state.apply(changeInlineLiteralTransaction(state, object, '{.d}') as never);
            assert.strictEqual(text(set), source.replace('{.c}', '{.d}'));
            assert.strictEqual(objectAtSelection(select(stateOf(source.replace('{.c}', '')), needle, 1)), null, source);
        }
    });

    test('a literal a cell or a note cannot hold is refused: a | in a cell, a note marker in a note', () => {
        const cell = select(stateOf('| a | b |\n| - | - |\n| `x`{.c} | ![i](s.png) |\n'), 'x', 1);
        const code = objectAtSelection(cell) as Extract<EditorObject, { kind: 'styled' }>;
        assert.strictEqual(code.kind, 'styled');
        assert.strictEqual(changeInlineLiteralTransaction(cell, code, '{data-x="a|b"}'), null);
        // The table's own filter names the element, whatever made it.
        const piped = cell.tr.addMark(code.from, code.to, editorSchema.marks.code.create({ literal: '{data-x="a|b"}' }));
        assert.ok(unwritableInTable(piped.doc)?.startsWith('Inline code in a table cell cannot hold {data-x="a|b"}'), unwritableInTable(piped.doc) ?? 'none');
        const image = literalObjectOf(objectAtSelection(selectImage(cell))) as LiteralObject;
        const pipedImage = cell.tr.setNodeMarkup(image.from, undefined, { ...(image as { node: Node }).node.attrs, literal: '{data-x="a|b"}' });
        assert.ok(unwritableInTable(pipedImage.doc)?.startsWith('An image in a table cell cannot hold'), unwritableInTable(pipedImage.doc) ?? 'none');

        const note = select(stateOf('Text ++ref|a `q`{.c} body++ end.\n'), 'q', 1);
        const inNote = objectAtSelection(note) as Extract<EditorObject, { kind: 'styled' }>;
        assert.strictEqual(inNote.kind, 'styled');
        assert.ok(changeInlineLiteralRefusal(note, inNote, '{data-x="a|b"}')?.startsWith('Inline code in a note cannot hold'), changeInlineLiteralRefusal(note, inNote, '{data-x="a|b"}') ?? 'none');
    });
});

/** Each mark that carries a literal, its delimiters, the markup its toggle writes, and the element the engine renders it as. */
const ADJACENT: readonly [string, string, string, string | null, string][] = [
    ['code', '`', '`', null, 'code'], ['strong', '**', '**', '**', 'b'], ['em', '*', '*', '*', 'i'], ['sup', '^', '^', null, 'sup'],
    ['sub', '~', '~', null, 'sub'], ['kbd', '[[', ']]', null, 'kbd'], ['mark', '==', '==', null, 'mark'], ['strike', '~~', '~~', null, 's'],
];

suite('Editor inline literals: two runs of one mark side by side', () => {
    const md = hostEngine();

    for (const [name, open, close, markup, tag] of ADJACENT) {
        test(`${name}: a run without a literal right before one with: refused exactly where the engine reads the two as one`, () => {
            let state = stateOf(`A foo${open}abc${close}{.x} y.\n`);
            const from = posOf(state.doc, 'foo');
            const type = editorSchema.marks[name];
            state = state.apply(state.tr.addMark(from, from + 3, type.create(markup === null ? {} : { markup })));
            const p = touched(state.doc.child(0));
            const written = serializeDocument({ doc: state.doc.type.create(null, [p]), eol: '\n', tail: '' }, options).trim();
            const elements = (md.renderInline(written).match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
            const lost = literalNotReadBack(p);
            assert.strictEqual(lost?.merged !== undefined, elements < 2, `${written}: ${elements} element(s), verdict ${JSON.stringify(lost)}`);
        });

        test(`${name}: the toggle applied right before a run with a literal joins that run, which keeps its literal`, () => {
            let state = select(stateOf(`A foo${open}abc${close}{.x} y.\n`), 'foo', 0, 3);
            toggleMarkup(editorSchema.marks[name], markup)(state, tr => {
                state = state.apply(tr);
            });
            assert.strictEqual(text(state), `A ${open}fooabc${close}{.x} y.\n`);
            assert.strictEqual(literalNotReadBack(state.doc.child(0)), null);
        });
    }

    test('the refusal says what would happen', () => {
        let state = stateOf('A foo`abc`{.x} y.\n');
        const from = posOf(state.doc, 'foo');
        state = state.apply(state.tr.addMark(from, from + 3, editorSchema.marks.code.create()));
        const lost = literalNotReadBack(touched(state.doc.child(0)));
        assert.ok(lost !== null && literalLostReason(lost).startsWith('After this edit two pieces of inline code would stand side by side'), JSON.stringify(lost));
    });
});
