import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EDITABLE_TOP_NODES, ParsedDocument, createEditorEngine, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { createPositionMap } from '../../../src/editor/positions';
import { unwritableInNote, unwritableInTable } from '../../../src/editor/serialize';
import { plugins } from '../../../src/plugin/plugins';
import { hostEngine, topChildren, touched } from './helpers';

const schema = editorSchema;
const text = (s: string, ...marks: Array<ReturnType<typeof schema.mark>>) => schema.text(s, marks);
const paragraph = (...inline: Node[]) => schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, inline)]);
const embed = (source: string) => schema.nodes.wiki_embed.create({ source });

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function allTouched(parsed: ParsedDocument): ParsedDocument {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return { ...parsed, doc: parsed.doc.type.create(null, children) };
}

function embedsOf(doc: Node): string[] {
    const found: string[] = [];
    doc.descendants(n => {
        if (n.type.name === 'wiki_embed') { found.push(n.attrs.source as string); }
    });
    return found;
}

function keysOf(doc: Node): string[] {
    const found: string[] = [];
    doc.descendants(n => {
        if (n.isText && n.marks.some(m => m.type.name === 'kbd')) { found.push(n.text ?? ''); }
    });
    return found;
}

suite('Editor: a wiki embed is an atom carrying its source (qjebbs/vscode-markdown-extended#168)', () => {
    const md = hostEngine();
    const serialize = (parsed: ParsedDocument, wikiEmbeds?: boolean) => serializeDocument(parsed, { defaultWrap: 90, wikiEmbeds });

    /** Parse, rewrite every editable block, parse and rewrite again: both writes are the source. */
    function assertVerbatim(source: string, editable: string): void {
        const parsed = parseDocument(md, source);
        assert.deepStrictEqual(topChildren(parsed.doc).map(n => n.type.name), [editable], source);
        assert.strictEqual(serialize(parsed), source, 'untouched');
        const first = serialize(allTouched(parsed));
        assert.strictEqual(first, source, 'rewritten');
        assert.strictEqual(serialize(allTouched(parseDocument(md, first))), source, 'rewritten twice');
    }

    test('in a paragraph: an atom per embed, the block editable, the source written back as it was, nothing in it escaped', () => {
        const source = 'See ![[assets/_img.png]], ![[note#^block-id]], ![[C++ notes]], ![[a@b $x$]] and [[Ctrl+S]].\n';
        const parsed = parseDocument(md, source);
        assert.deepStrictEqual(embedsOf(parsed.doc), ['![[assets/_img.png]]', '![[note#^block-id]]', '![[C++ notes]]', '![[a@b $x$]]']);
        assert.deepStrictEqual(keysOf(parsed.doc), ['Ctrl+S']);
        assertVerbatim(source, 'paragraph');
    });

    test('lists, quotes, headings, tables and admonitions holding an embed stay editable and are written back as they were', () => {
        assertVerbatim('- one ![[a.png]]\n- two\n', 'bullet_list');
        assertVerbatim('> quote ![[a.png]]\n', 'blockquote');
        assertVerbatim('# Title ![[img.png]]\n', 'heading');
        assertVerbatim('!!! note "T"\n    body ![[a.png]]\n', 'admonition');
        // A table cell keeps the embed's escaped `\|`, which the row needs.
        const table = '| a                 | b |\n| ----------------- | - |\n| ![[img.png\\|300]] | x |\n';
        assertVerbatim(table, 'table');
        assert.deepStrictEqual(embedsOf(parseDocument(md, table).doc), ['![[img.png\\|300]]']);
    });

    test('an embed in a sidenote or a marginal note is an atom in the note and is written back as it was', () => {
        for (const source of ['A ++ref|![[x]]++ b\n', 'A !!ref|![[x]]!! b\n', 'A ++![[x]]|note++ b\n']) {
            assert.deepStrictEqual(embedsOf(parseDocument(md, source).doc), ['![[x]]'], source);
            assertVerbatim(source, 'paragraph');
        }
    });

    test('![[x]](y), ![[x]]{.cls} and an embed under a mark or in a key are written back as they were', () => {
        assertVerbatim('![[x]](y) here\n', 'paragraph');
        assertVerbatim('![[x]]{.cls}\n', 'paragraph');
        assertVerbatim('a ![[x]]{.cls} b\n', 'paragraph');
        assertVerbatim('**![[x]]** and [[a ![[b]] c]]\n', 'paragraph');
    });

    test('an embed the author escaped, !\\[\\[note\\]\\], is text and stays escaped after an edit', () => {
        const source = 'Plain !\\[\\[note\\]\\] here.\n';
        assert.deepStrictEqual(embedsOf(parseDocument(md, source).doc), []);
        assertVerbatim(source, 'paragraph');
    });

    test('a key right after a marginal note stays a key after a save', () => {
        const source = 'A !!ref|note!![[Ctrl]] b.\n';
        assertVerbatim(source, 'paragraph');
        assert.deepStrictEqual(keysOf(parseDocument(md, source).doc), ['Ctrl']);
    });

    test('a key right after a ! has its ! escaped where the engine reads embeds, and only there', () => {
        const kbd = schema.marks.kbd.create();
        for (const [before, written] of [['Wow!', 'Wow\\!'], ['x\\!', 'x\\\\\\!']]) {
            const doc = paragraph(text(before), text('Ctrl', kbd));
            const first = serialize({ doc, eol: '\n', tail: '' });
            assert.strictEqual(first, `${written}[[Ctrl]]\n`);
            const reparsed = parseDocument(md, first);
            assert.strictEqual(topChildren(reparsed.doc)[0].textContent, `${before}Ctrl`);
            assert.deepStrictEqual(keysOf(reparsed.doc), ['Ctrl'], first);
        }
        // With wiki-embed disabled the engine says so, and `Wow![[Ctrl]]` is a `!` and a key as written.
        const doc = paragraph(text('Wow!'), text('Ctrl', kbd));
        assert.strictEqual(serialize({ doc, eol: '\n', tail: '' }, false), 'Wow![[Ctrl]]\n');
        const noEmbeds = createEditorEngine({ linkify: true, typographer: false, plugins: plugins.filter(p => p.plugin.name !== 'MarkdownItWikiEmbed') });
        const parsed = parseDocument(noEmbeds, 'Wow![[Ctrl]]\n');
        assert.strictEqual(parsed.wikiEmbeds, false);
        assert.strictEqual(parseDocument(md, 'x\n').wikiEmbeds, true);
        assert.strictEqual(serialize(allTouched(parsed)), 'Wow![[Ctrl]]\n');
    });

    test('a link or an attribute span right after x\\! gets its ! escaped: an escaped backslash leaves the ! bare', () => {
        const link = schema.marks.link.create({ href: 'u', title: null });
        const span = schema.marks.attr_span.create({ literal: '{.c}' });
        for (const [mark, written, name] of [[link, 'x\\\\\\![a](u)\n', 'link'], [span, 'x\\\\\\![a]{.c}\n', 'attr_span']] as const) {
            const first = serialize({ doc: paragraph(text('x\\!'), text('a', mark)), eol: '\n', tail: '' });
            assert.strictEqual(first, written);
            const p = topChildren(parseDocument(md, first).doc)[0];
            assert.strictEqual(p.textContent, 'x\\!a');
            assert.ok(p.lastChild?.marks.some(m => m.type.name === name), first);
        }
    });

    test('an atom after a ! is written with that ! escaped, so the two do not pair', () => {
        const first = serialize({ doc: paragraph(text('a!'), embed('![[x]]')), eol: '\n', tail: '' });
        assert.strictEqual(first, 'a\\!![[x]]\n');
        assert.deepStrictEqual(embedsOf(parseDocument(md, first).doc), ['![[x]]']);
    });

    test('an embed that would break its table row or note is refused, not written', () => {
        const n = schema.nodes;
        const table = (source: string) => schema.topNodeType.create(null, [n.table.create(null, [
            n.table_row.create(null, [n.table_header.create(null, [text('a')])]),
            n.table_row.create(null, [n.table_cell.create(null, [embed(source)])]),
        ])]);
        assert.match(unwritableInTable(table('![[a|b]]')) ?? '', /wiki embed/);
        assert.strictEqual(unwritableInTable(table('![[a\\|b]]')), null);
        const sidenote = (ref: Node, body: Node) => paragraph(n.sidenote.create(null, [n.note_ref.create(null, [ref]), n.sidenote_body.create(null, [body])]));
        assert.match(unwritableInNote(sidenote(embed('![[a|b]]'), text('note'))) ?? '', /wiki embed/);
        assert.match(unwritableInNote(sidenote(text('ref'), embed('![[C++ x]]'))) ?? '', /wiki embed/);
        assert.strictEqual(unwritableInNote(sidenote(text('ref'), embed('![[a|b]]'))), null);
    });

    test('an image whose alt text holds an embed or an escape keeps that text', () => {
        const parsed = parseDocument(md, '![alt ![[y]] a\\*b](z.png)\n');
        let alt: string | null = null;
        parsed.doc.descendants(n => {
            if (n.type.name === 'image') { alt = n.attrs.alt as string; }
        });
        assert.strictEqual(alt, 'alt ![[y]] a*b');
        const first = serialize(allTouched(parsed));
        assert.strictEqual(serialize(allTouched(parseDocument(md, first))), first);
    });

    test('positions: the atom stands at its source\'s first character, the text after it after its source', () => {
        const source = 'ab ![[x/y.png]] cd\n';
        const parsed = parseDocument(md, source);
        const map = createPositionMap(parsed, { defaultWrap: 90 });
        let atomPos = -1;
        parsed.doc.descendants((n, p) => {
            if (n.type.name === 'wiki_embed') { atomPos = p; }
        });
        assert.deepStrictEqual(map.sourcePositionOf(atomPos), { line: 0, character: 3, approximate: false });
        assert.deepStrictEqual(map.sourcePositionOf(atomPos + 1), { line: 0, character: 15, approximate: false });
        assert.strictEqual(map.pagePositionOf({ line: 0, character: 16 })?.pos, atomPos + 2);
    });
});
