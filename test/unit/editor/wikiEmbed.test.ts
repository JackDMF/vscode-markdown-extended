import * as assert from 'assert';
import { Fragment, Node, Slice } from 'prosemirror-model';
import { EDITABLE_TOP_NODES, ParsedDocument, createEditorEngine, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { createPositionMap } from '../../../src/editor/positions';
import { unwritableEmbed, unwritableInNote, unwritableInTable } from '../../../src/editor/serialize';
import { headingAnchors } from '../../../src/editor/host/links';
import { textWithEmbeds, wikiEmbedPastePlugin } from '../../../src/editor/webview/wikiEmbeds';
import { tokenText } from '../../../src/syntax/tokenText';
import { plugins } from '../../../src/plugin/plugins';
import { hostEngine, topChildren, touched } from './helpers';
import markdownIt from 'markdown-it';
import { MarkdownIt } from '../../../src/@types/markdown-it';

const schema = editorSchema;
const text = (s: string, ...marks: Array<ReturnType<typeof schema.mark>>) => schema.text(s, marks);
const paragraph = (...inline: Node[]) => schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, inline)]);
const embed = (source: string, ...marks: Array<ReturnType<typeof schema.mark>>) => schema.nodes.wiki_embed.create({ source }, null, marks);

/** The preview's composition: the registry on a plain markdown-it, embeds joined as text. */
function previewEngine(): MarkdownIt {
    const md = markdownIt() as unknown as MarkdownIt;
    plugins.forEach(p => md.use(p.plugin as never, ...p.args));
    return md;
}

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

    test('an embed is written so its table row and its note read it back: a |, a backtick, a note\'s terminator and marker are encoded', () => {
        const n = schema.nodes;
        const table = (source: string) => schema.topNodeType.create(null, [n.table.create(null, [
            n.table_row.create(null, [n.table_header.create(null, [text('a')])]),
            n.table_row.create(null, [n.table_cell.create(null, [embed(source)])]),
        ])]);
        const sidenote = (ref: Node, body: Node) => paragraph(n.sidenote.create(null, [n.note_ref.create(null, [ref]), n.sidenote_body.create(null, [body])]));
        const preview = previewEngine();
        for (const [doc, written, name] of [
            // The table plugin reads any backslash before `|` as its escape.
            [table('![[a\\\\|b]]'), '![[a\\\\|b]]', null],
            [table('![[a\\|b]]'), '![[a\\|b]]', 'a|b'],
            [table('![[a|b]]'), '![[a\\|b]]', 'a|b'],
            [table('![[a`b]]'), '![[a&#96;b]]', 'a`b'],
            [sidenote(embed('![[a|b]]'), text('note')), '![[a&#124;b]]', 'a|b'],
            [sidenote(text('ref'), embed('![[C++ x]]')), '![[C&#43;&#43; x]]', 'C++ x'],
        ] as const) {
            assert.strictEqual(unwritableInTable(doc), null);
            assert.strictEqual(unwritableInNote(doc), null);
            const out = serialize({ doc, eol: '\n', tail: '' });
            assert.ok(out.includes(written), out);
            assert.deepStrictEqual(embedsOf(parseDocument(md, out).doc), [written], out);
            if (name !== null) {
                // The preview, and Foam reading its text, see the same name.
                assert.ok(preview.render(out).includes(`![[${md.utils.escapeHtml(name)}]]`), preview.render(out));
            }
        }
        // Read from the file, an embed is written byte for byte.
        assertVerbatim('| a |\n| - |\n| ![[a\\\\|b]] |\n'.replace('| a |\n| - |', '| a          |\n| ---------- |'), 'table');
    });

    test('a wiki embed under inline code, superscript or subscript is refused, not written', () => {
        for (const mark of [schema.marks.code, schema.marks.sup, schema.marks.sub]) {
            assert.match(unwritableEmbed(paragraph(embed('![[x]]', mark.create()))) ?? '', /wiki embed/);
        }
        assert.strictEqual(unwritableEmbed(paragraph(embed('![[x]]', schema.marks.em.create()))), null);
    });

    test('a {…} after an embed under a mark is a literal to attrs, so it is escaped; after a bare embed it is text', () => {
        const em = schema.marks.em.create();
        const link = schema.marks.link.create({ href: 'u', title: null });
        const preview = previewEngine();
        for (const [blocks, written] of [
            [[schema.nodes.paragraph.create(null, [text('A '), embed('![[x]]', em), text('{.a}')])], 'A *![[x]]*\\{.a\\}\n'],
            [[schema.nodes.paragraph.create(null, [text('A '), embed('![[x]]', link), text('{.a}')])], 'A [![[x]]](u)\\{.a\\}\n'],
            [[schema.nodes.heading.create({ level: 2 }, [text('A '), embed('![[x]]', em), text('{#id}')])], '## A *![[x]]*\\{#id\\}\n'],
            [[schema.nodes.paragraph.create(null, [text('A '), embed('![[x]]'), text('{.a}')])], 'A ![[x]]{.a}\n'],
        ] as const) {
            const out = serialize({ doc: schema.topNodeType.create(null, [...blocks]), eol: '\n', tail: '' });
            assert.strictEqual(out, written);
            assert.ok(preview.render(out).includes('{'), preview.render(out));
        }
    });

    test('an image whose alt text holds an embed or an escape keeps that text, in the editor and in a block it renders as source', () => {
        const parsed = parseDocument(md, '![alt ![[y]] a\\*b](z.png)\n');
        let alt: string | null = null;
        parsed.doc.descendants(n => {
            if (n.type.name === 'image') { alt = n.attrs.alt as string; }
        });
        assert.strictEqual(alt, 'alt ![[y]] a*b');
        const first = serialize(allTouched(parsed));
        assert.strictEqual(serialize(allTouched(parseDocument(md, first))), first);
        const raw = parseDocument(md, '![alt ![[y]]](z.png) <span>x</span>\n');
        const html = topChildren(raw.doc).map(b => b.attrs.html as string).join('');
        assert.ok(html.includes('alt="alt ![[y]]"'), html);
    });

    test('one reader of a heading\'s text: its slug, its table-of-contents entry and the preview\'s agree with an embed in it', () => {
        assert.deepStrictEqual(headingAnchors(md, '# Head ![[x]]\n', {}).map(a => a.slug), ['head-x']);
        assert.deepStrictEqual(headingAnchors(previewEngine(), '# Head ![[x]]\n', {}).map(a => a.slug), ['head-x']);
        const toc = '[[TOC]]\n\n# Head ![[x]]\n';
        assert.strictEqual(md.render(toc), previewEngine().render(toc));
        assert.strictEqual(tokenText(md.parseInline('a ![[b\\_c]] `d`', {})[0].children), 'a ![[b_c]] d');
    });

    test('positions: the position before an embed is its source\'s start, the one after it its end, at a block\'s start too', () => {
        for (const [source, expected] of [
            ['ab ![[x/y.png]] cd\n', [[3, 15]]],
            ['![[x]] b\n', [[0, 6]]],
            ['# ![[x]] t\n', [[2, 8]]],
            ['- ![[aa]]![[bb]]\n', [[2, 9], [9, 16]]],
            ['A ++ref|![[x]] b++ c\n', [[8, 14]]],
        ] as const) {
            const parsed = parseDocument(md, source);
            const map = createPositionMap(parsed, { defaultWrap: 90 });
            const found: [number, number][] = [];
            parsed.doc.descendants((n, p) => {
                if (n.type.name === 'wiki_embed') {
                    const before = map.sourcePositionOf(p);
                    const after = map.sourcePositionOf(p + 1);
                    assert.ok(before && after && !before.approximate && !after.approximate, source);
                    found.push([before.character, after.character]);
                    assert.strictEqual(map.pagePositionOf({ line: 0, character: after.character })?.pos, p + 1, source);
                }
            });
            assert.deepStrictEqual(found, expected, source);
        }
    });

    test('text typed or pasted as ![[name]] becomes an atom, except under a raw mark', () => {
        const nodes = textWithEmbeds('see ![[x]] and ![[a b.png]] end', []);
        assert.deepStrictEqual(nodes?.map(n => n.type.name === 'wiki_embed' ? `atom ${n.attrs.source as string}` : n.text), ['see ', 'atom ![[x]]', ' and ', 'atom ![[a b.png]]', ' end']);
        assert.strictEqual(textWithEmbeds('no embed ![[a [[b]] c]]', []), null);
        assert.strictEqual(textWithEmbeds('![[x]]', [schema.marks.code.create()]), null);
        const pasted = new Slice(Fragment.from(schema.nodes.paragraph.create(null, [text('a ![[x]] b')])), 1, 1);
        const plugin = wikiEmbedPastePlugin(() => true);
        const transform = plugin.props.transformPasted as unknown as (slice: Slice) => Slice;
        assert.deepStrictEqual(embedsOf(schema.topNodeType.create(null, transform(pasted).content)), ['![[x]]']);
        const off = wikiEmbedPastePlugin(() => false).props.transformPasted as unknown as (slice: Slice) => Slice;
        assert.deepStrictEqual(embedsOf(schema.topNodeType.create(null, off(pasted).content)), []);
    });
});
