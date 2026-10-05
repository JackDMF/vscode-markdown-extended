import * as assert from 'assert';
import { DOMSerializer, Fragment, Mark, MarkType, Node, ResolvedPos, Slice } from 'prosemirror-model';
import { toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { EditorState, TextSelection, Transaction } from 'prosemirror-state';
import { EDITABLE_TOP_NODES, ParsedDocument, createEditorEngine, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { createPositionMap } from '../../../src/editor/positions';
import { unwritableEmbed, unwritableInNote, unwritableInTable } from '../../../src/editor/serialize';
import { headingAnchors } from '../../../src/editor/host/links';
import { notesFilterRefusal } from '../../../src/editor/webview/notes';
import { tableRefusal } from '../../../src/editor/webview/tables';
import { objectOfNode } from '../../../src/editor/webview/objects';
import { wikiEmbedVerbs } from '../../../src/editor/webview/objectToolbar';
import { OWN_COPY, embedAsTextTransaction, inlineForNote, isOwnCopyDom, textWithEmbeds, wikiEmbedInputRule, wikiEmbedPastePlugin } from '../../../src/editor/webview/wikiEmbeds';
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

    type RuleLike = { match: RegExp; handler: (s: EditorState, m: RegExpMatchArray, a: number, b: number) => Transaction | null };
    const embedRule = wikiEmbedInputRule(() => true) as unknown as RuleLike;
    /**
     * What the input rule makes of `typed` typed at `at` in `state`, as the rule
     * runs: its pattern over the text before the caret and the typed character,
     * then its handler over the part that is in the document. `null` for no match
     * or a refusal.
     */
    const typeInto = (state: EditorState, at: number, typed: string): Transaction | null => {
        const $at = state.doc.resolve(at);
        const before = $at.parent.textBetween(0, $at.parentOffset, undefined, '￼') + typed;
        const match = embedRule.match.exec(before);
        return match === null ? null : embedRule.handler(state, match, at - (match[0].length - typed.length), at);
    };
    const embedPositions = (doc: Node): number[] => {
        const found: number[] = [];
        doc.descendants((node, pos) => {
            if (node.type.name === 'wiki_embed') { found.push(pos); }
        });
        return found;
    };

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
        // Marks: not the code before the `!`, which is no part of the text the atom replaces.
        const code = schema.marks.code.create();
        const afterCode = type(paragraph(text('k', code), text('![[a]')), ']', []);
        assert.ok(afterCode, 'made');
        afterCode.doc.descendants(node => {
            if (node.type.name === 'wiki_embed') { assert.deepStrictEqual(node.marks, []); }
        });
        assert.strictEqual(type(paragraph(text('![[a]', code)), ']', [code]), null);
        // The atom takes the marks of the text it replaces — which keeps it in a link or an attribute span that
        // ends there — with those toggled on before the `]` (stored, the caret's not) added and those toggled
        // off (the caret's, not stored) taken away.
        const em = schema.marks.em.create();
        const link = schema.marks.link.create({ href: 'https://e.org' });
        const atomMarks = (tr: Transaction | null) => {
            assert.ok(tr, 'made');
            const found: string[][] = [];
            tr.doc.descendants(node => {
                if (node.type.name === 'wiki_embed') { found.push(node.marks.map(m => m.type.name)); }
            });
            return found;
        };
        assert.deepStrictEqual(atomMarks(type(paragraph(text('See ![[x]')), ']', [em])), [['em']], 'em toggled on: an em atom');
        assert.deepStrictEqual(atomMarks(type(paragraph(text('![[x]', em)), ']', [])), [[]], 'em toggled off: a plain atom');
        assert.deepStrictEqual(atomMarks(type(paragraph(text('![[x]', em)), ']')), [['em']], 'none stored: the replaced text\'s marks');
        assert.deepStrictEqual(atomMarks(type(paragraph(text('the ![[x]', link)), ']')), [['link']], 'none stored, at the end of a link: it stays in the link');
        assert.strictEqual(type(paragraph(text('See ![[x]')), ']', [schema.marks.sup.create()]), null, 'superscript toggled on: it stays text');
        const off = wikiEmbedInputRule(() => false) as unknown as typeof rule;
        assert.strictEqual(off.handler(EditorState.create({ doc: paragraph(text('![[x]')) }), ['![[x]]'] as unknown as RegExpMatchArray, 1, 6), null);
    });

    test('Edit as text: the atom becomes its plain text with its marks and the caret after it, is saved as the escaped literal, undone as one step, and made an embed again by retyping the last ]', () => {
        const em = schema.marks.em.create();
        const parsed = parseDocument(md, 'An ![[ab]] here and *![[c&#124;d]]* too.\n');
        const start = EditorState.create({ doc: parsed.doc, plugins: [history()] });
        const found: number[] = [];
        start.doc.descendants((node, pos) => {
            if (node.type.name === 'wiki_embed') { found.push(pos); }
        });
        assert.strictEqual(found.length, 2);

        const first = embedAsTextTransaction(start, found[0], found[0] + 1);
        assert.ok(first, 'the first embed becomes text');
        const state = start.apply(first);
        assert.deepStrictEqual(embedsOf(state.doc), ['![[c&#124;d]]'], 'only that embed went');
        const $caret = state.doc.resolve(state.selection.from);
        assert.ok(state.selection.empty && $caret.parent.textContent.startsWith('An ![[ab]]'), $caret.parent.textContent);
        assert.strictEqual($caret.parent.textBetween(0, $caret.parentOffset), 'An ![[ab]]', 'the caret is right after the closing ]]');
        assert.strictEqual(serialize(allTouched({ ...parsed, doc: state.doc })), 'An !\\[\\[ab\\]\\] here and *![[c|d]]* too.\n', 'saved as text, escaped; the other embed written plain where nothing needs encoding');

        // Marks go with it, and the encoded character is shown plain, as the atom was.
        let rest = -1;
        state.doc.descendants((node, pos) => {
            if (node.type.name === 'wiki_embed') { rest = pos; }
        });
        const second = embedAsTextTransaction(state, rest, rest + 1);
        assert.ok(second, 'the second embed becomes text');
        const marked = state.apply(second);
        let texts = '';
        marked.doc.descendants(node => {
            if (node.isText && node.marks.some(m => m.type === em.type)) { texts += node.text; }
        });
        assert.strictEqual(texts, '![[c|d]]');
        assert.strictEqual(embedAsTextTransaction(state, 1, 2), null, 'a text position is no embed');

        // One undo step puts the atom back, with its source.
        let undone: EditorState | undefined;
        undo(state, tr => { undone = state.apply(tr); });
        assert.deepStrictEqual(embedsOf((undone as EditorState).doc), ['![[ab]]', '![[c&#124;d]]']);

        // A redo puts the text back, as one step too, the other embed untouched.
        let redone: EditorState | undefined;
        redo(undone as EditorState, tr => { redone = (undone as EditorState).apply(tr); });
        assert.ok(redone, 'there is a step to redo');
        assert.deepStrictEqual(embedsOf(redone.doc), ['![[c&#124;d]]']);
        assert.ok(redone.doc.textContent.startsWith('An ![[ab]] here'), redone.doc.textContent);
        assert.strictEqual(serialize(allTouched({ ...parsed, doc: redone.doc })), 'An !\\[\\[ab\\]\\] here and *![[c|d]]* too.\n');

        // Retyping the last ] makes the atom again, and a third ] makes nothing.
        const before = state.selection.from;
        const cut = state.apply(state.tr.delete(before - 1, before));
        const again = typeInto(cut, cut.selection.from, ']');
        assert.ok(again, 'the rule fires');
        assert.deepStrictEqual(embedsOf(again.doc), ['![[ab]]', '![[c&#124;d]]']);
        assert.strictEqual(typeInto(state, state.selection.from, ']'), null, 'a third ] makes nothing');
    });

    /** `embedAsTextTransaction` on the first embed of `doc`, then the last ] deleted and typed again: the document the editor ends with. */
    function textAndBack(doc: Node): Node {
        const [at] = embedPositions(doc);
        const asText = embedAsTextTransaction(EditorState.create({ doc }), at, at + 1);
        assert.ok(asText, 'the embed becomes text');
        const state = EditorState.create({ doc }).apply(asText);
        const caret = state.selection.from;
        const cut = state.apply(state.tr.delete(caret - 1, caret));
        const made = typeInto(cut, cut.selection.from, ']');
        assert.ok(made, 'retyping the ] fires the rule');
        return made.doc;
    }

    test('Edit as text and a retyped ] keep the embed in the link, attribute span or marks it was in: at their end, start and middle', () => {
        // Through the document: the saved text is the source the embed was parsed from.
        for (const source of [
            'See [the ![[x]]](https://e.org) now.\n',
            'See [![[x]] the](https://e.org) now.\n',
            'See [the ![[x]] end](https://e.org) now.\n',
            'A [![[x]]]{.big} b.\n',
            'A [![[x]] the]{.big} b.\n',
            'A [the ![[x]] end]{.big} b.\n',
            'An *emphasised ![[x]]* word.\n',
            'An *emphasised ![[x]] word*.\n',
            'A plain ![[x]] one.\n',
        ]) {
            const parsed = parseDocument(md, source);
            assert.strictEqual(embedPositions(parsed.doc).length, 1, source);
            const back = textAndBack(parsed.doc);
            assert.strictEqual(serialize(allTouched({ ...parsed, doc: back })), source, source);
            assert.ok(Mark.sameSet(back.nodeAt(embedPositions(back)[0])?.marks ?? [], parsed.doc.nodeAt(embedPositions(parsed.doc)[0])?.marks ?? []), `the same marks: ${source}`);
        }

        // A req_ref decoration is not Markdown: built by hand, at the end of its run.
        const ref = schema.marks.req_ref.create();
        const decorated = paragraph(text('see '), embed('![[x]]', ref));
        const [pos] = embedPositions(decorated);
        assert.deepStrictEqual(textAndBack(decorated).nodeAt(pos)?.marks.map(m => m.type.name), ['req_ref']);
    });

    test('a ]] typed closes an embed that carries the marks of the text it replaces, changed by those stored — in a link, wherever the caret is in it — and not those of the caret', () => {
        const link = schema.marks.link.create({ href: 'https://e.org' });
        const span = schema.marks.attr_span.create({ literal: '{.big}' });
        const ref = schema.marks.req_ref.create();
        const code = schema.marks.code.create();
        const marksOfEmbeds = (tr: Transaction | null) => {
            assert.ok(tr, 'the rule fires');
            return embedPositions(tr.doc).map(p => tr.doc.nodeAt(p)?.marks.map(m => m.type.name));
        };
        for (const mark of [link, span, ref]) {
            const caretAtEnd = (...inline: Node[]) => {
                const doc = paragraph(...inline);
                return typeInto(EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) }), doc.content.size - 1, ']');
            };
            // At the end of the run (a typed character does not extend the mark, so the caret's marks have none of it).
            assert.deepStrictEqual(marksOfEmbeds(caretAtEnd(text('the ![[x]', mark))), [[mark.type.name]], `${mark.type.name} at its end`);
            // After other text of the run, and with text of another mark before it.
            assert.deepStrictEqual(marksOfEmbeds(caretAtEnd(text('a '), text('the ![[x]', mark))), [[mark.type.name]], `${mark.type.name} after plain text`);
        }
        // In the middle of a link: more of the link follows the caret.
        const middle = paragraph(text('the ![[x]rest', link));
        const typedInMiddle = typeInto(EditorState.create({ doc: middle }), 1 + 'the ![[x]'.length, ']');
        assert.deepStrictEqual(marksOfEmbeds(typedInMiddle), [['link']]);
        // Emphasis still carries over; marks stored before the `]` (Ctrl+I) decide, on or off, as for any typed character.
        const em = schema.marks.em.create();
        const emphasised = paragraph(text('![[x]', em));
        assert.deepStrictEqual(marksOfEmbeds(typeInto(EditorState.create({ doc: emphasised }), emphasised.content.size - 1, ']')), [['em']]);
        const stored = (doc: Node, marks: readonly Mark[]) => EditorState.create({ doc }).apply(EditorState.create({ doc }).tr.setStoredMarks(marks));
        const plain = paragraph(text('![[x]'));
        assert.deepStrictEqual(marksOfEmbeds(typeInto(stored(plain, [em]), plain.content.size - 1, ']')), [['em']]);
        assert.deepStrictEqual(marksOfEmbeds(typeInto(stored(emphasised, []), emphasised.content.size - 1, ']')), [[]]);
        // Under inline code the embed stays text.
        assert.strictEqual(typeInto(EditorState.create({ doc: paragraph(text('![[x]', code)) }), 6, ']'), null);
    });

    test('a mark toggled before the ]] is added to or taken from the replaced text\'s marks: at the end of a link, an attribute span or a note reference the atom stays in it; under superscript or with code toggled on it stays text', () => {
        const link = schema.marks.link.create({ href: 'https://e.org' });
        const span = schema.marks.attr_span.create({ literal: '{.big}' });
        const ref = schema.marks.req_ref.create();
        const em = schema.marks.em.create();
        /** `doc` with the caret at its end, `toggled` toggled there as Ctrl+I or Ctrl+B does, then `]` typed. */
        const toggleThenType = (doc: Node, toggled: MarkType): Transaction | null => {
            const end = doc.content.size - 1;
            let state = EditorState.create({ doc, selection: TextSelection.create(doc, end) });
            assert.ok(toggleMark(toggled)(state, tr => { state = state.apply(tr); }), `${toggled.name} toggles`);
            assert.ok(state.storedMarks !== null, 'the toggle is stored');
            return typeInto(state, end, ']');
        };
        const atomMarks = (tr: Transaction | null): readonly Mark[] => {
            assert.ok(tr, 'the rule fires');
            const found = embedPositions(tr.doc);
            assert.strictEqual(found.length, 1);
            return tr.doc.nodeAt(found[0])?.marks ?? [];
        };
        const names = (marks: readonly Mark[]) => marks.map(m => m.type.name);

        // On, at the end of a mark typing does not extend: the atom keeps that mark, with its attributes.
        const inLink = atomMarks(toggleThenType(paragraph(text('the ![[x]', link)), schema.marks.em));
        assert.deepStrictEqual(names(inLink).sort(), ['em', 'link']);
        assert.strictEqual(inLink.find(m => m.type === link.type)?.attrs.href, 'https://e.org', 'the href is kept');
        const inSpan = atomMarks(toggleThenType(paragraph(text('See '), text('![[x]', span)), schema.marks.strong));
        assert.deepStrictEqual(names(inSpan).sort(), ['attr_span', 'strong']);
        assert.strictEqual(inSpan.find(m => m.type === span.type)?.attrs.literal, '{.big}', 'the attributes are kept');
        assert.deepStrictEqual(names(atomMarks(toggleThenType(paragraph(text('See '), text('![[x]', ref)), schema.marks.em))).sort(), ['em', 'req_ref']);
        // On over plain text, off over emphasis, off with a link kept.
        assert.deepStrictEqual(names(atomMarks(toggleThenType(paragraph(text('a ![[x]')), schema.marks.em))), ['em']);
        assert.deepStrictEqual(names(atomMarks(toggleThenType(paragraph(text('![[x]', em)), schema.marks.em))), []);
        assert.deepStrictEqual(names(atomMarks(toggleThenType(paragraph(text('![[x]', link, em)), schema.marks.em))), ['link']);
        // Superscript toggled off over superscript text, or code toggled on: it stays text.
        assert.strictEqual(toggleThenType(paragraph(text('a'), text('![[x]', schema.marks.sup.create())), schema.marks.sup), null, 'sup text, sup off');
        assert.strictEqual(toggleThenType(paragraph(text('a'), text('![[x]', schema.marks.code.create())), schema.marks.code), null, 'code text, code off');
        assert.strictEqual(toggleThenType(paragraph(text('a ![[x]')), schema.marks.code), null, 'code on');
    });

    test('Edit as text is refused where the notes\' and the tables\' filters would refuse its text: an attribute span over the atom whose literal holds a note marker or a cell\'s pipe', () => {
        const spanned = (source: string, literal: string) => {
            const parsed = parseDocument(md, source);
            const [at] = embedPositions(parsed.doc);
            const start = EditorState.create({ doc: parsed.doc });
            return start.apply(start.tr.addMark(at, at + 1, schema.marks.attr_span.create({ literal })));
        };
        const asText = (state: EditorState) => {
            const [at] = embedPositions(state.doc);
            const tr = embedAsTextTransaction(state, at, at + 1);
            assert.ok(tr);
            return tr;
        };
        for (const [source, literal] of [['X $![[x]]$ y.\n', '{title="p$q"}'], ['X @![[x]]@ y.\n', '{title="p@q"}'], ['X ++ref|![[x]]++ y.\n', '{title="p|q"}']]) {
            const state = spanned(source, literal);
            assert.ok(notesFilterRefusal(asText(state))?.includes('attribute span'), source);
            const [at] = embedPositions(state.doc);
            assert.strictEqual(notesFilterRefusal(state.tr.delete(at, at + 1)), null, `the atom alone is removable: ${source}`);
        }
        const inCell = spanned('| a |\n| - |\n| ![[x]] |\n', '{title="p|q"}');
        assert.ok(tableRefusal(asText(inCell))?.includes('attribute span'));
        // No span, no refusal.
        for (const source of ['X $![[x]]$ y.\n', '| a |\n| - |\n| ![[x]] |\n', 'Plain ![[x]].\n']) {
            const state = EditorState.create({ doc: parseDocument(md, source).doc });
            const tr = asText(state);
            assert.strictEqual(notesFilterRefusal(tr) ?? tableRefusal(tr), null, source);
        }
    });

    test('the embed\'s bar disables Edit as text and Remove embed with the reason where the notes\' filter would refuse them — an attribute span with a note marker in its literal, inside a note — and offers both elsewhere', () => {
        const bar = (state: EditorState) => {
            const [at] = embedPositions(state.doc);
            const object = objectOfNode(state.doc.nodeAt(at) as Node, at);
            assert.ok(object && object.kind === 'wiki_embed', 'the embed is an object');
            return wikiEmbedVerbs(state, object, { asText: () => undefined, remove: () => undefined });
        };
        const spanned = (source: string, literal: string, from: (at: number) => number) => {
            const start = EditorState.create({ doc: parseDocument(md, source).doc });
            const [at] = embedPositions(start.doc);
            return start.apply(start.tr.addMark(from(at), from(at) + 1, schema.marks.attr_span.create({ literal })));
        };
        const marker = 'An attribute span in a note cannot hold {title="p$q"}';

        // The span over the atom itself: its text would be unwritable, the atom's removal leaves no span.
        const over = spanned('X $![[x]]$ y.\n', '{title="p$q"}', at => at);
        const [asText, remove] = bar(over);
        assert.deepStrictEqual([asText.id, remove.id], ['edit-wiki-embed-as-text', 'remove-wiki-embed']);
        assert.ok(asText.refusal?.startsWith(marker), `Edit as text: ${asText.refusal}`);
        const [at] = embedPositions(over.doc);
        assert.strictEqual(notesFilterRefusal(over.tr.delete(at, at + 1)), null, 'the filters let the atom go');
        assert.strictEqual(remove.refusal, null, 'Remove embed is offered');

        // The span over the text beside it, in a note the filters would refuse a change to: both verbs carry the reason.
        const beside = spanned('X $a![[x]]$ y.\n', '{title="p$q"}', at => at - 1);
        assert.deepStrictEqual(bar(beside).map(v => v.refusal?.startsWith(marker)), [true, true], 'both disabled with the reason');

        for (const source of ['X $![[x]]$ y.\n', 'Plain ![[x]].\n', '| a |\n| - |\n| ![[x]] |\n']) {
            assert.deepStrictEqual(bar(EditorState.create({ doc: parseDocument(md, source).doc })).map(v => v.refusal), [null, null], source);
        }
    });

    type PasteProps = {
        handleDOMEvents: { paste: () => boolean; copy: () => boolean; cut: () => boolean };
        clipboardParser: { parseSlice: (dom: unknown) => Slice };
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
    const copied = (p: PasteProps, slice: Slice) => p.clipboardSerializer.serializeFragment(slice.content, { document: fakeDocument as unknown as Document }) as unknown as FakeNode;
    const copiedHtml = (p: PasteProps, slice: Slice) => copied(p, slice).html();
    /** An element of pasted HTML as the browser parsed it, with the marker or not. */
    const el = (tag: string, marked: boolean, ...children: FakeNode[]) => {
        const e = new FakeNode(1, tag);
        if (marked) {
            e.setAttribute(OWN_COPY, '');
        }
        e.childNodes.push(...children);
        return e;
    };
    const txt = (s: string) => new FakeNode(3, '', s);
    const comment = (s: string) => new FakeNode(8, '', s);
    /**
     * A paste's HTML as ProseMirror hands it to its clipboard parser: the body
     * the browser parsed it into. ProseMirror walks `firstChild` and so reads
     * this stub as empty, the decision reads its `childNodes`; the slice it
     * stands for is given to `transformPasted` apart, as before.
     */
    const pastedDom = (...children: FakeNode[]) => Object.assign(el('body', false, ...children), { firstChild: null });
    /** ProseMirror's parsing, in `p`'s editor, of a paste whose HTML the browser parsed into `children`. */
    const parsePasted = (p: PasteProps, ...children: FakeNode[]) => p.clipboardParser.parseSlice(pastedDom(...children));
    /** The same, for HTML `q`'s editor copied of `slice`. */
    const parseCopy = (p: PasteProps, q: PasteProps, slice: Slice) => parsePasted(p, ...copied(q, slice).childNodes);

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
        parseCopy(own, own, carried);
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

    test('a copied embed carries the plain title "Wiki embed", not the editor\'s how-to tooltip', () => {
        const html = copiedHtml(plugin(), inline(text('see '), embed('![[x]]')));
        assert.ok(html.includes('title="Wiki embed"'), html);
        assert.ok(html.includes('data-mep-wiki-embed="![[x]]"'), html);
        assert.ok(!html.includes('Backspace') && !html.includes('Edit as text'), html);
        // In the editor itself the tooltip is the long one.
        const inEditor = (DOMSerializer.fromSchema(schema).serializeNode(embed('![[x]]'), { document: fakeDocument as unknown as Document }) as unknown as FakeNode).html();
        assert.ok(inEditor.includes('Edit as text'), inEditor);
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
        parseCopy(other, plugin(), literal);
        assert.strictEqual(other.transformPasted(literal, view, false), literal);
        // Another ProseMirror editor's copy has no marker, and the marker's name as text is no marker: converted.
        for (const foreign of [txt('Lit ![[x]] here'), txt(`Lit ![[x]] here ${OWN_COPY}=""`)]) {
            other.handleDOMEvents.paste();
            const p = el('p', false, foreign);
            p.setAttribute('data-pm-slice', '1 1 []');
            parsePasted(other, p);
            assert.deepStrictEqual(atoms(other.transformPasted(literal, view, false)), ['![[x]]'], foreign.text);
        }
        // The marker is read for a paste only, and only for the paste it came with.
        parseCopy(other, plugin(), literal);
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

    test('HTML is the editor\'s own when every top-level element the browser parsed of it carries the marker', () => {
        const own = () => el('p', true, txt('x'));
        const table = (...rows: FakeNode[]) => el('table', false, el('tbody', false, ...rows));
        // The browser has read the HTML: a comment, an attribute's value, raw text, a name's case are its business (the e2e suite pastes those).
        const cases: [string, FakeNode[], boolean][] = [
            ['one marked element', [own()], true],
            ['every element marked', [own(), el('blockquote', true, el('p', false, txt('q')))], true],
            ['Windows CF_HTML\'s fragment comments and line breaks around it', [txt('\r\n'), comment('StartFragment'), own(), comment('EndFragment'), txt('\r\n')], true],
            ['a stylesheet, a title, a meta or a script beside it: no part of the fragment', [el('style', false, txt('a{}')), el('title', false, txt('t')), el('meta', false), el('script', false, txt(`"<p ${OWN_COPY}>"`)), own()], true],
            ['ProseMirror\'s table around a copied cell', [table(el('tr', false, el('td', true, txt('x'))))], true],
            ['ProseMirror\'s table around copied rows', [table(el('tr', true, el('td', false, txt('a'))), el('tr', true, el('td', false, txt('b'))))], true],
            ['a copied table', [el('table', true, el('tbody', false, el('tr', false, el('td', false, txt('x')))))], true],
            ['the marker as text', [el('p', false, txt(`${OWN_COPY}=""`))], false],
            ['a script beside an unmarked element', [el('script', false, txt(`"<p ${OWN_COPY}>"`)), el('p', false, txt('x'))], false],
            ['the marker inside an unmarked element', [el('div', false, own())], false],
            ['a marked row beside an unmarked one', [table(el('tr', true, el('td', false, txt('a'))), el('tr', false, el('td', false, txt('b'))))], false],
            ['an unmarked table', [table(el('tr', false, el('td', false, txt('x'))))], false],
            ['marked and unmarked elements', [own(), el('p', false, txt('new ![[x]]'))], false],
            ['unmarked, then marked', [el('p', false, txt('new')), own()], false],
            ['text beside a marked element', [txt('new '), own()], false],
            ['nothing', [], false],
            ['a comment alone', [comment(OWN_COPY)], false],
            ['no element', [txt('x')], false],
        ];
        for (const [what, children, expected] of cases) {
            assert.strictEqual(isOwnCopyDom(pastedDom(...children)), expected, what);
        }
        // What the editor's serializer copies is its own, as it is parsed for the paste.
        assert.ok(isOwnCopyDom(pastedDom(...copied(plugin(), inline(text('Lit ![[x]]'))).childNodes)));
        // A fragment of marked and unmarked elements converts: what came from outside in it is not left as literal text.
        const mixed = inline(text('old'), text(' new ![[x]]'));
        for (const [second, converted] of [[false, true], [true, false]] as const) {
            const p = plugin();
            p.handleDOMEvents.paste();
            parsePasted(p, el('p', true, txt('old')), el('p', second, txt('new ![[x]]')));
            assert.deepStrictEqual(atoms(p.transformPasted(mixed, view, false)), converted ? ['![[x]]'] : [], `second marked: ${second}`);
        }
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
