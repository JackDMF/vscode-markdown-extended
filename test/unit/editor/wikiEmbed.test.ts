import * as assert from 'assert';
import { DOMSerializer, Fragment, Mark, Node, ResolvedPos, Slice } from 'prosemirror-model';
import { EditorState, TextSelection, Transaction } from 'prosemirror-state';
import { EDITABLE_TOP_NODES, ParsedDocument, createEditorEngine, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { createPositionMap } from '../../../src/editor/positions';
import { unwritableEmbed, unwritableInNote, unwritableInTable } from '../../../src/editor/serialize';
import { headingAnchors } from '../../../src/editor/host/links';
import { OWN_COPY, inlineForNote, textWithEmbeds, wikiEmbedInputRule, wikiEmbedPastePlugin } from '../../../src/editor/webview/wikiEmbeds';
import { tokenText } from '../../../src/syntax/tokenText';
import { plugins } from '../../../src/plugin/plugins';
import { hostEngine, topChildren, touched } from './helpers';
import { FakeNode, fakeDocument } from './fakeDom';
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
            // An escaped backtick is the table plugin's escape already: as written.
            [table('![[a\\`b]]'), '![[a\\`b]]', 'a`b'],
            [sidenote(embed('![[a|b]]'), text('note')), '![[a&#124;b]]', 'a|b'],
            // Escaped, the terminator still ends the reference to the notes plugin: a reference, not `\&#124;`.
            [sidenote(embed('![[img.png\\|300]]'), text('note')), '![[img.png&#124;300]]', 'img.png|300'],
            [sidenote(text('ref'), embed('![[C++ x]]')), '![[C&#43;&#43; x]]', 'C++ x'],
            // Where nothing needs encoding, the plain form (`plainWikiEmbed`).
            [paragraph(text('A '), embed('![[a&#124;b]]')), '![[a|b]]', 'a|b'],
            [paragraph(text('A '), embed('![[a\\|b]]')), '![[a|b]]', 'a|b'],
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
        // Read from the file, an embed in a cell or a note is written byte for byte.
        assertVerbatim('| a          |\n| ---------- |\n| ![[a\\\\|b]] |\n', 'table');
        assertVerbatim('| a         |\n| --------- |\n| ![[a\\`b]] |\n', 'table');
        assertVerbatim('A ++![[img.png&#124;300]]|n++ b\n', 'paragraph');
        // The atom shows the plain name.
        assert.strictEqual(embed('![[a&#124;b]]').textContent, '![[a|b]]');
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

    test('positions: the position before an embed is its source\'s start, the one after it its end, at a block\'s start and end too', () => {
        for (const [source, expected] of [
            ['ab ![[x/y.png]] cd\n', [[3, 15]]],
            ['![[x]] b\n', [[0, 6]]],
            ['# ![[x]] t\n', [[2, 8]]],
            ['- ![[aa]]![[bb]]\n', [[2, 9], [9, 16]]],
            ['A ++ref|![[x]] b++ c\n', [[8, 14]]],
            // Ending its block: the source's end maps exactly after the atom.
            ['ab ![[x]]\n', [[3, 9]]],
            // Spelled longer than its plain name where it stands.
            ['A ++![[img.png&#124;300]]|n++ b\n', [[4, 25]]],
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
                    const back = map.pagePositionOf({ line: 0, character: after.character });
                    assert.deepStrictEqual(back, { pos: p + 1, approximate: false }, source);
                }
            });
            assert.deepStrictEqual(found, expected, source);
        }
        // A changed cell writes `\|`: positions follow the written spelling.
        const n = schema.nodes;
        const doc = schema.topNodeType.create(null, [n.table.create(null, [
            n.table_row.create(null, [n.table_header.create(null, [text('a')])]),
            n.table_row.create(null, [n.table_cell.create(null, [embed('![[a|b]]'), text(' x')])]),
        ])]);
        const map = createPositionMap({ doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
        let at = -1;
        doc.descendants((node, p) => {
            if (node.type.name === 'wiki_embed') { at = p; }
        });
        assert.deepStrictEqual(map.sourcePositionOf(at + 1), { line: 2, character: 11, approximate: false });
        // A changed note reference writes `&#124;`: the anchors are that spelling, the text after it exact.
        const note = paragraph(text('A '), n.sidenote.create(null, [n.note_ref.create(null, [embed('![[a|b]]')]), n.sidenote_body.create(null, [text('n')])]), text(' b'));
        const noteMap = createPositionMap({ doc: note, eol: '\n', tail: '' }, { defaultWrap: 90 });
        assert.strictEqual(noteMap.text, 'A ++![[a&#124;b]]|n++ b\n');
        let inRef = -1;
        note.descendants((node, p) => {
            if (node.type.name === 'wiki_embed') { inRef = p; }
        });
        assert.deepStrictEqual([noteMap.sourcePositionOf(inRef), noteMap.sourcePositionOf(inRef + 1)],
            [{ line: 0, character: 4, approximate: false }, { line: 0, character: 17, approximate: false }]);
        assert.deepStrictEqual(noteMap.pagePositionOf({ line: 0, character: 19 }), { pos: inRef + 4, approximate: false });
    });

    test('a block the host renders from the editor\'s engine shows an embed in an image\'s alt, as the preview does', () => {
        assert.strictEqual(md.render('![alt ![[y]]](z.png)\n'), previewEngine().render('![alt ![[y]]](z.png)\n'));
    });

    test('text before the caret is made an embed only when its ]] was just typed, in one run of plain text', () => {
        const n = schema.nodes;
        const rule = wikiEmbedInputRule(() => true) as unknown as { match: RegExp; handler: (s: EditorState, m: RegExpMatchArray, a: number, b: number) => Transaction | null };
        /** What the input rule makes of typing `typed` at the end of `doc`'s first textblock (`typed` '' is a composition's end). */
        const type = (doc: Node, typed: string, stored?: readonly Mark[]): Transaction | null => {
            const end = doc.content.size - 1;
            let state = EditorState.create({ doc, selection: TextSelection.create(doc, end) });
            if (stored) { state = state.apply(state.tr.setStoredMarks(stored)); }
            const $end = state.doc.resolve(end);
            const before = $end.parent.textBetween(0, $end.parentOffset, null, '￼') + typed;
            const match = rule.match.exec(before);
            return match === null ? null : rule.handler(state, match, end - (match[0].length - typed.length), end);
        };
        const made = type(paragraph(text('See ![[x]')), ']');
        assert.deepStrictEqual(made && embedsOf(made.doc), ['![[x]]']);
        // The end of a composition over literal text already there makes nothing.
        assert.strictEqual(type(paragraph(text('Lit ![[x]]')), ''), null);
        // Across a sidenote: the text before the caret spans the note's parts.
        const crossing = paragraph(text('See ![['), n.sidenote.create(null, [n.note_ref.create(null, [text('r')]), n.sidenote_body.create(null, [text('body]')])]));
        assert.strictEqual(type(crossing, ']'), null);
        // Marks: the stored marks typed text takes, not the code before the `!`.
        const code = schema.marks.code.create();
        const afterCode = type(paragraph(text('k', code), text('![[a]')), ']', []);
        assert.ok(afterCode, 'made');
        afterCode.doc.descendants(node => {
            if (node.type.name === 'wiki_embed') { assert.deepStrictEqual(node.marks, []); }
        });
        assert.strictEqual(type(paragraph(text('![[a]', code)), ']', [code]), null);
        const off = wikiEmbedInputRule(() => false) as unknown as typeof rule;
        assert.strictEqual(off.handler(EditorState.create({ doc: paragraph(text('![[x]')) }), ['![[x]]'] as unknown as RegExpMatchArray, 1, 6), null);
    });

    type PasteProps = {
        handleDOMEvents: { paste: () => boolean; copy: () => boolean; cut: () => boolean };
        transformPastedHTML: (html: string, view: unknown) => string;
        transformPasted: (slice: Slice, view: unknown, asText: boolean) => Slice;
        clipboardTextSerializer: (slice: Slice) => string;
        clipboardSerializer: DOMSerializer;
    };
    const inline = (...content: Node[]) => new Slice(Fragment.from(schema.nodes.paragraph.create(null, content)), 1, 1);
    const view = { state: EditorState.create({ doc: paragraph(text('ab')) }) };
    const atoms = (slice: Slice) => embedsOf(schema.topNodeType.create(null, slice.content));
    /** A paste plugin as one webview's editor has it: a new one is another webview, or the same after a restart. */
    const plugin = (enabled = true) => wikiEmbedPastePlugin(() => enabled).props as unknown as PasteProps;
    /** A copy made in `p`'s editor: the copy event, then ProseMirror's serializing of it. */
    const copyOf = (p: PasteProps, slice: Slice) => {
        p.handleDOMEvents.copy();
        p.clipboardTextSerializer(slice);
    };
    /** The HTML `p`'s editor puts on the clipboard for `slice`. */
    const copiedHtml = (p: PasteProps, slice: Slice) => (p.clipboardSerializer.serializeFragment(slice.content, { document: fakeDocument as unknown as Document }) as unknown as FakeNode).html();

    test('a paste from outside this editor has its embeds made atoms; its own copy keeps what it carried; a drop and a code block do not', () => {
        const nodes = textWithEmbeds('see ![[x]] and ![[a b.png]] end', []);
        assert.deepStrictEqual(nodes?.map(n => n.type.name === 'wiki_embed' ? `atom ${n.attrs.source as string}` : n.text), ['see ', 'atom ![[x]]', ' and ', 'atom ![[a b.png]]', ' end']);
        assert.strictEqual(textWithEmbeds('no embed ![[a [[b]] c]]', []), null);
        assert.strictEqual(textWithEmbeds('![[x]]', [schema.marks.code.create()]), null);
        const em = schema.marks.em.create();
        const outside = () => inline(text('see ![[x]] '), text('![[y]]', em));
        // From outside, as text or as HTML: atoms, each with its text's marks.
        for (const asText of [true, false]) {
            const p = plugin();
            p.handleDOMEvents.paste();
            const pasted = p.transformPasted(outside(), view, asText);
            assert.deepStrictEqual(atoms(pasted), ['![[x]]', '![[y]]']);
            pasted.content.descendants(n => {
                if (n.type.name === 'wiki_embed' && n.attrs.source === '![[y]]') { assert.ok(em.isInSet(n.marks)); }
            });
        }
        // This editor's own copy: literal text stays literal, an atom stays an atom — as text (Ctrl+Shift+V) too.
        const own = plugin();
        const carried = inline(text('Lit ![[x]] and '), embed('![[a&#124;b]]'), text(' here.'));
        copyOf(own, carried);
        own.handleDOMEvents.paste();
        assert.deepStrictEqual(atoms(own.transformPasted(inline(text('Lit ![[x]] and ![[a|b]] here.')), view, true)), ['![[a&#124;b]]']);
        own.handleDOMEvents.paste();
        own.transformPastedHTML(copiedHtml(own, carried), view);
        assert.strictEqual(own.transformPasted(carried, view, false), carried);
        // Other text after the same copy is outside text.
        own.handleDOMEvents.paste();
        assert.deepStrictEqual(atoms(own.transformPasted(inline(text('other ![[z]]')), view, true)), ['![[z]]']);
        // No paste event (a drop): as it was.
        assert.deepStrictEqual(atoms(plugin().transformPasted(outside(), view, true)), []);
        // A paste the plugin never saw parse (an image, a paste left to the browser) leaves nothing for the next drop.
        return (async () => {
            const leak = plugin();
            leak.handleDOMEvents.paste();
            await Promise.resolve();
            assert.deepStrictEqual(atoms(leak.transformPasted(outside(), view, true)), []);
            // Into a code block, or with the engine not reading embeds: as it was, after a real paste event.
            const fence = schema.topNodeType.create(null, [schema.nodes.code_block.create(null, [text('ab')])]);
            const inFence = { state: EditorState.create({ doc: fence, selection: TextSelection.create(fence, 2) }) };
            const p = plugin();
            p.handleDOMEvents.paste();
            assert.deepStrictEqual(atoms(p.transformPasted(outside(), inFence, true)), []);
            const off = plugin(false);
            off.handleDOMEvents.paste();
            assert.deepStrictEqual(atoms(off.transformPasted(outside(), view, true)), []);
        })();
    });

    test('the editor\'s own HTML copy is known by its marker in any Visual Editor; its plain text by the last copy made here, which a drag does not replace', async () => {
        const literal = inline(text('Lit ![[x]] here'));
        // The copied HTML: each top-level element carries the marker, nothing inside it does.
        const quoted = new Slice(Fragment.from([
            schema.nodes.paragraph.create(null, [text('Lit ![[x]]')]),
            schema.nodes.blockquote.create(null, [schema.nodes.paragraph.create(null, [text('q')])]),
        ]), 0, 0);
        const html = copiedHtml(plugin(), quoted);
        assert.strictEqual(html, `<p ${OWN_COPY}="">Lit ![[x]]</p><blockquote ${OWN_COPY}=""><p>q</p></blockquote>`);
        // Pasted as HTML into another webview's editor, or after a restart, with no copy made there: as it was.
        const other = plugin();
        other.handleDOMEvents.paste();
        assert.strictEqual(other.transformPastedHTML(copiedHtml(plugin(), literal), view), copiedHtml(plugin(), literal));
        assert.strictEqual(other.transformPasted(literal, view, false), literal);
        // Another ProseMirror editor's copy has no marker, and the marker's name as text is no marker: converted.
        for (const foreign of ['<p data-pm-slice="1 1 []">Lit ![[x]] here</p>', `<p data-pm-slice="1 1 []">Lit ![[x]] here ${OWN_COPY}=""</p>`]) {
            other.handleDOMEvents.paste();
            other.transformPastedHTML(foreign, view);
            assert.deepStrictEqual(atoms(other.transformPasted(literal, view, false)), ['![[x]]'], foreign);
        }
        // The marker is read for a paste only, and only for the paste it came with.
        other.transformPastedHTML(copiedHtml(plugin(), literal), view);
        other.handleDOMEvents.paste();
        assert.deepStrictEqual(atoms(other.transformPasted(literal, view, false)), ['![[x]]']);
        // As plain text, a copy made in another webview is outside text (the README's first limit).
        other.handleDOMEvents.paste();
        assert.deepStrictEqual(atoms(other.transformPasted(literal, view, true)), ['![[x]]']);
        // A drag serializes its slice like a copy, but it is no copy: the last copy stays the literal.
        const here = plugin();
        copyOf(here, literal);
        here.clipboardTextSerializer(inline(text('dragged ![[y]]')));
        // A copy event with nothing serialized (an empty selection) leaves nothing for the next drag either.
        here.handleDOMEvents.copy();
        await Promise.resolve();
        here.clipboardTextSerializer(inline(text('dragged ![[z]]')));
        here.handleDOMEvents.paste();
        assert.deepStrictEqual(atoms(here.transformPasted(literal, view, true)), []);
        // A cut is a copy.
        here.handleDOMEvents.cut();
        here.clipboardTextSerializer(inline(text('cut ![[y]]')));
        here.handleDOMEvents.paste();
        assert.deepStrictEqual(atoms(here.transformPasted(inline(text('cut ![[y]]')), view, true)), []);
        here.handleDOMEvents.paste();
        assert.deepStrictEqual(atoms(here.transformPasted(literal, view, true)), ['![[x]]']);
    });

    test('a paste into a note keeps an atom an atom and literal text literal, with the marks typed text takes', () => {
        const em = schema.marks.em.create();
        const literal = new Slice(Fragment.from(schema.nodes.paragraph.create(null, [text('Lit ![[x]]')])), 1, 1);
        assert.deepStrictEqual(inlineForNote(literal, []).map(n => n.type.name), ['text']);
        const atom = new Slice(Fragment.from(schema.nodes.paragraph.create(null, [text('see '), embed('![[x]]'), text(' end')])), 1, 1);
        const inline = inlineForNote(atom, [em]);
        assert.deepStrictEqual(inline.map(n => n.type.name), ['text', 'wiki_embed', 'text']);
        assert.ok(inline.every(n => em.isInSet(n.marks)));
        // Under code an atom is its text.
        assert.deepStrictEqual(inlineForNote(atom, [schema.marks.code.create()]).map(n => n.text), ['see ', '![[x]]', ' end']);
    });
});
