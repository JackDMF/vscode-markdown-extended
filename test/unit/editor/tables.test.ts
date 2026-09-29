import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, TextSelection, Transaction } from 'prosemirror-state';
import { MarkdownIt, StateBase, Token } from '../../../src/@types/markdown-it';
import { EDITABLE_TOP_NODES, InjectionMark, ParsedDocument, blockLineRanges, editorSchema, groupSourceBlocks, parseDocument, serializeDocument, splitLines } from '../../../src/editor';
import { blockIndexForLine } from '../../../src/editor/host/lenses';
import { tableLines, unwritableInTable } from '../../../src/editor/serialize';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { addRowTransaction, deleteColumnRefusal, deleteRowRefusal, deleteRowTransaction, enterInCell, tableRefusal } from '../../../src/editor/webview/tables';
import { CellSelection } from 'prosemirror-tables';
import { hostEngine, toCrlf, topChildren, touched } from './helpers';

/** The position where `needle` starts in one of the document's text nodes. */
function cellTextPos(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        const at = found < 0 && node.isText ? (node.text ?? '').indexOf(needle) : -1;
        if (at >= 0) {
            found = pos + at;
        }
        return found < 0;
    });
    assert.ok(found >= 0, `the document holds ${needle}`);
    return found;
}

const OPTIONS = { defaultWrap: 90 };
const nodes = editorSchema.nodes;

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function allTouched(parsed: ParsedDocument): ParsedDocument {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return { ...parsed, doc: parsed.doc.type.create(null, children) };
}

/** The cells of a table node, row by row: each cell's type, text and alignment. */
function cellsOf(table: Node): { type: string; text: string; align: unknown }[][] {
    const rows: { type: string; text: string; align: unknown }[][] = [];
    table.forEach(row => {
        const cells: { type: string; text: string; align: unknown }[] = [];
        row.forEach(cell => cells.push({ type: cell.type.name, text: cell.textContent, align: cell.attrs.align }));
        rows.push(cells);
    });
    return rows;
}

/** Why each top-level block of `text` is what it is. */
function kinds(md: MarkdownIt, text: string): { kind: string; reason: string }[] {
    return groupSourceBlocks(md.parse(text, {}), splitLines(text)).blocks.map(b => ({ kind: b.kind, reason: b.reason }));
}

const TIDY = [
    '| Name  |  Kind  | Count |',
    '| :---- | :----: | ----: |',
    '| Alpha | first  |     1 |',
    '| Beta  | second |    22 |',
    '',
].join('\n');

suite('Editor pipe tables', () => {
    const md = hostEngine();

    test('a plain pipe table is one editable table node: a header row, body rows, each cell aligned as its column', () => {
        const parsed = parseDocument(md, TIDY);
        assert.strictEqual(parsed.doc.childCount, 1);
        const table = parsed.doc.child(0);
        assert.strictEqual(table.type, nodes.table);
        assert.strictEqual(table.attrs.src, TIDY);
        assert.deepStrictEqual(cellsOf(table), [
            [{ type: 'table_header', text: 'Name', align: 'left' }, { type: 'table_header', text: 'Kind', align: 'center' }, { type: 'table_header', text: 'Count', align: 'right' }],
            [{ type: 'table_cell', text: 'Alpha', align: 'left' }, { type: 'table_cell', text: 'first', align: 'center' }, { type: 'table_cell', text: '1', align: 'right' }],
            [{ type: 'table_cell', text: 'Beta', align: 'left' }, { type: 'table_cell', text: 'second', align: 'center' }, { type: 'table_cell', text: '22', align: 'right' }],
        ]);
    });

    test('the tidy form is a fixed point: untouched it is its slice, changed it is written back byte for byte', () => {
        const parsed = parseDocument(md, TIDY);
        assert.strictEqual(serializeDocument(parsed, OPTIONS), TIDY);
        assert.strictEqual(serializeDocument(allTouched(parsed), OPTIONS), TIDY);
        const crlf = toCrlf(`Intro.\n\n${TIDY}\nAfter.\n`);
        const again = parseDocument(md, crlf);
        assert.strictEqual(serializeDocument(again, OPTIONS), crlf, 'CRLF, untouched');
        assert.strictEqual(serializeDocument(allTouched(again), OPTIONS), crlf, 'CRLF, changed');
    });

    test('an untidy table nobody edited is its slice; changed, it is written tidy, and that is stable', () => {
        const untidy = 'Text.\n\nName|Value\n-|:-:\nAlpha | 1\n  Beta|22  \n\nAfter.\n';
        const parsed = parseDocument(md, untidy);
        assert.strictEqual(parsed.doc.child(1).type, nodes.table, 'outer pipes are optional, a one-dash delimiter reads');
        assert.strictEqual(serializeDocument(parsed, OPTIONS), untidy);
        const once = serializeDocument(allTouched(parsed), OPTIONS);
        assert.strictEqual(once, [
            'Text.',
            '',
            '| Name  | Value |',
            '| ----- | :---: |',
            '| Alpha |   1   |',
            '| Beta  |  22   |',
            '',
            'After.',
            '',
        ].join('\n'));
        assert.strictEqual(serializeDocument(allTouched(parseDocument(md, once)), OPTIONS), once, 'stable');
    });

    test('every alignment round-trips through the delimiter row: ---, :--, :-:, --:', () => {
        const source = '| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | 2 | 3 | 4 |\n';
        const table = parseDocument(md, source).doc.child(0);
        assert.deepStrictEqual(cellsOf(table)[1].map(c => c.align), [null, 'left', 'center', 'right']);
        assert.deepStrictEqual(tableLines(table), [
            '| a | b  |  c  |  d |',
            '| - | :- | :-: | -: |',
            '| 1 | 2  |  3  |  4 |',
        ], 'each column as narrow as its delimiter allows');
    });

    test('an escaped | is a | in the cell\'s text and \\| again in the file; a backslash stays a backslash', () => {
        const source = '| a \\| b | c\\\\ |\n| --- | --- |\n| x\\|y | \\\\\\| |\n';
        const parsed = parseDocument(md, source);
        assert.deepStrictEqual(cellsOf(parsed.doc.child(0)).map(r => r.map(c => c.text)), [['a | b', 'c\\'], ['x|y', '\\|']]);
        const once = serializeDocument(allTouched(parsed), OPTIONS);
        assert.strictEqual(once, '| a \\| b | c\\\\  |\n| ------ | ---- |\n| x\\|y   | \\\\\\| |\n');
        assert.deepStrictEqual(cellsOf(parseDocument(md, once).doc.child(0)).map(r => r.map(c => c.text)), [['a | b', 'c\\'], ['x|y', '\\|']], 'reads back');
    });

    test('empty cells stay cells: padded to the column, never written as ||, which is a colspan', () => {
        const source = '| a | b |\n| --- | --- |\n|  | x |\n| y |   |\n';
        const parsed = parseDocument(md, source);
        assert.deepStrictEqual(cellsOf(parsed.doc.child(0)).map(r => r.map(c => c.text)), [['a', 'b'], ['', 'x'], ['y', '']]);
        const once = serializeDocument(allTouched(parsed), OPTIONS);
        assert.strictEqual(once, '| a | b |\n| - | - |\n|   | x |\n| y |   |\n');
        assert.strictEqual(kinds(md, once)[0].kind, 'editable');
        const header = parseDocument(md, '|   |   |\n| --- | --- |\n| a | b |\n');
        assert.strictEqual(header.doc.child(0).type, nodes.table, 'an empty header row is a header row');
    });

    test('inline marks, a link with a title, an image, code, a span and a sidebar in a cell round-trip', () => {
        const source = [
            '| Mark          | More                                      |',
            '| ------------- | ----------------------------------------- |',
            '| *i* **b** `c` | [link](https://example.com/a "The title") |',
            '| ==m== ~~s~~   | ![alt](img.png) [[Ctrl]] ^up^ ~down~      |',
            '| [s]{.c}       | $a left sidebar$                          |',
            '',
        ].join('\n');
        const parsed = parseDocument(md, source);
        const table = parsed.doc.child(0);
        assert.strictEqual(table.type, nodes.table, kinds(md, source)[0].reason);
        const marksIn = new Set<string>();
        table.descendants(n => {
            n.marks.forEach(m => marksIn.add(m.type.name));
            if (!n.isText && n.isInline) {
                marksIn.add(n.type.name);
            }
        });
        for (const name of ['em', 'strong', 'code', 'link', 'mark', 'strike', 'image', 'kbd', 'sup', 'sub', 'attr_span', 'left_sidebar']) {
            assert.ok(marksIn.has(name), `${name} in a cell`);
        }
        assert.strictEqual(serializeDocument(allTouched(parsed), OPTIONS), source);
    });

    test('a cell that would read as table syntax is escaped: a delimiter cell, ^^, a backslash before code', () => {
        const table = nodes.table.create(null, [
            nodes.table_row.create(null, [nodes.table_header.create(null, editorSchema.text('h')), nodes.table_header.create(null, editorSchema.text('i'))]),
            nodes.table_row.create(null, [nodes.table_cell.create(null, editorSchema.text('---')), nodes.table_cell.create(null, editorSchema.text(':-:'))]),
            nodes.table_row.create(null, [
                nodes.table_cell.create(null, editorSchema.text('^^')),
                nodes.table_cell.create(null, [editorSchema.text('a\\'), editorSchema.text('b', [editorSchema.marks.code.create()])]),
            ]),
        ]);
        const text = `${tableLines(table).join('\n')}\n`;
        assert.strictEqual(text, '| h    | i         |\n| ---- | --------- |\n| \\--- | \\:-:      |\n| \\^\\^ | a&#92;`b` |\n');
        const read = parseDocument(md, text);
        assert.strictEqual(read.doc.childCount, 1, kinds(md, text).map(k => k.reason).join());
        assert.deepStrictEqual(cellsOf(read.doc.child(0)).map(r => r.map(c => c.text)), [['h', 'i'], ['---', ':-:'], ['^^', 'a\\b']]);
    });

    test('in a cell, a link\'s | and backtick are percent-encoded and a bare link holding one is written inline', () => {
        const link = (href: string, markup: string | null) => editorSchema.marks.link.create({ href, title: null, markup });
        const table = nodes.table.create(null, [
            nodes.table_row.create(null, [nodes.table_header.create(null, editorSchema.text('Links'))]),
            nodes.table_row.create(null, [nodes.table_cell.create(null, editorSchema.text('here', [link('https://x.org/a|b`c', null)]))]),
            nodes.table_row.create(null, [nodes.table_cell.create(null, editorSchema.text('https://x.org/p|q', [link('https://x.org/p|q', 'linkify')]))]),
        ]);
        const text = `${tableLines(table).join('\n')}\n`;
        assert.ok(text.includes('[here](https://x.org/a%7Cb%60c)'), text);
        assert.ok(text.includes('[https://x.org/p\\|q](https://x.org/p%7Cq)'), text);
        const read = parseDocument(md, text).doc.child(0);
        assert.strictEqual(read.type, nodes.table);
        assert.strictEqual(cellsOf(read).length, 3, 'one row each');
    });

    const MULTIMD: readonly [string, string, string][] = [
        ['a colspan (||)', '| a | b |\n| --- | --- |\n| wide ||\n', 'colspan'],
        ['a rowspan (^^)', '| a | b |\n| --- | --- |\n| x | y |\n| ^^ | z |\n', 'rowspan'],
        ['a multi-line row (\\ continuation)', '| a | b |\n| --- | --- |\n| x \\\n| more |\n| y | z |\n', 'table'],
        ['a caption above', '[The caption]\n| a | b |\n| --- | --- |\n| x | y |\n', 'caption'],
        ['a caption below', '| a | b |\n| --- | --- |\n| x | y |\n[The caption]\n', 'caption'],
        ['a headerless table', '| --- | --- |\n| x | y |\n', 'headerless'],
        ['two header rows', '| a | b |\n| c | d |\n| --- | --- |\n| x | y |\n', 'header row'],
        ['a second body after a blank line', '| a | b |\n| --- | --- |\n| x | y |\n\n| z | w |\n', 'second body'],
        ['= in the delimiter row', '| a | b |\n| === | --- |\n| x | y |\n', 'delimiter row'],
        ['+ in the delimiter row (a wrapped column)', '| a | b |\n| --- | ---+ |\n| x | y |\n', 'class'],
        ['a row of fewer cells than the header', '| a | b |\n| --- | --- |\n| x |\n', 'cells under a header'],
        ['a row of more cells than the header', '| a | b |\n| --- | --- |\n| x | y | z |\n', 'cells under a header'],
        ['attributes on the table', '| a | b |\n| --- | --- |\n| x | y |\n{.wide}\n', 'attributes'],
        ['a sidenote in a cell', '| a | b |\n| --- | --- |\n| ++ref\\|note++ | y |\n', 'sidenote_open'],
        ['code holding | in a cell', '| a | b |\n| --- | --- |\n| `x|y` | y |\n', 'code holding |'],
        ['inline HTML in a cell', '| a | b |\n| --- | --- |\n| x<br>y | y |\n', 'html_inline'],
        // markdown-it-attrs does not read the literal at all here; `classify` refuses one that holds `|` or a backtick besides.
        ['an attribute span whose literal would hold | in a cell', '| a | b |\n| --- | --- |\n| [s]{title="p\\|q"} | y |\n', 'span'],
    ];

    for (const [name, source, why] of MULTIMD) {
        test(`${name} stays a source block, written back as it was`, () => {
            const found = kinds(md, source);
            assert.strictEqual(found[0].kind, 'raw', JSON.stringify(found));
            assert.ok(found[0].reason.includes(why), `the reason names it: ${found[0].reason}`);
            const parsed = parseDocument(md, source);
            assert.strictEqual(parsed.doc.child(0).type, nodes.raw_block);
            assert.strictEqual(serializeDocument(allTouched(parsed), OPTIONS), source);
        });
    }

    test('a table inside a container, a quote or a list leaves that block a source block, as before', () => {
        for (const source of [
            '::: note\n| a | b |\n| --- | --- |\n| x | y |\n:::\n',
            '> | a | b |\n> | --- | --- |\n> | x | y |\n',
            '- item\n\n  | a | b |\n  | --- | --- |\n  | x | y |\n',
        ]) {
            const found = kinds(md, source);
            assert.strictEqual(found[0].kind, 'raw', `${JSON.stringify(source)}: ${JSON.stringify(found)}`);
            assert.strictEqual(serializeDocument(parseDocument(md, source), OPTIONS), source);
        }
    });

    test('Req Explorer\'s summary table is injected content, never a table node, even made of table tokens', () => {
        const injectSummary = (engine: MarkdownIt): MarkdownIt => {
            engine.core.ruler.push('req-status-badges', (state: StateBase) => {
                const tokens = state.tokens;
                const at = tokens.findIndex(t => t.type === 'heading_close');
                if (at < 0) {
                    return;
                }
                const summary: Token[] = [];
                engine.block.parse('| Status | implemented |\n| --- | --- |\n| Priority | high |\n', engine, state.env, summary);
                const mark: InjectionMark = { rule: 'req-status-badges', kind: 'atom', artifact: 'FR-X-001' };
                for (const t of summary) {
                    t.map = null;
                    t.meta = { reqExplorer: mark };
                    for (const child of t.children ?? []) {
                        child.children = child.children ?? [];
                    }
                }
                tokens.splice(at + 1, 0, ...summary);
            });
            return engine;
        };
        const engine = hostEngine([injectSummary]);
        const source = '## FR-X-001: A requirement {#fr-x-001}\n\nBody.\n';
        const parsed = parseDocument(engine, source);
        const children = topChildren(parsed.doc).map(n => n.type.name);
        assert.deepStrictEqual(children, ['heading', 'injected_block', 'paragraph']);
        assert.strictEqual(parsed.doc.child(1).attrs.kind, 'atom');
        assert.ok(String(parsed.doc.child(1).attrs.html).includes('<table'), 'drawn as the preview draws it');
        assert.strictEqual(parsed.doc.child(0).attrs.reqPrefix, 'FR-X-001: ', 'and it still names its heading');
        assert.strictEqual(serializeDocument(allTouched(parsed), OPTIONS), source, 'it writes nothing');
    });

    test('what the tidy form has no spelling for is named: a hard break in a cell, code or a literal holding |', () => {
        const table = (cell: Node) => editorSchema.topNodeType.create(null, [nodes.table.create(null, [
            nodes.table_row.create(null, [nodes.table_header.create(null, editorSchema.text('h'))]),
            nodes.table_row.create(null, [cell]),
        ])]);
        const sidebar = nodes.left_sidebar.create(null, [editorSchema.text('a'), nodes.hard_break.create(), editorSchema.text('b')]);
        assert.ok(unwritableInTable(table(nodes.table_cell.create(null, sidebar)))?.includes('one line'));
        assert.ok(unwritableInTable(table(nodes.table_cell.create(null, editorSchema.text('a|b', [editorSchema.marks.code.create()]))))?.includes('"|"'));
        const span = editorSchema.marks.attr_span.create({ literal: '{title="a|b"}' });
        assert.ok(unwritableInTable(table(nodes.table_cell.create(null, editorSchema.text('s', [span]))))?.includes('{title="a|b"}'));
        assert.strictEqual(unwritableInTable(table(nodes.table_cell.create(null, editorSchema.text('a|b')))), null, 'text holding | is written \\|');
        assert.throws(() => nodes.table_cell.create(null, nodes.hard_break.create()).check(), 'a cell holds no hard break of its own');
    });

    test('the page\'s verbs keep a pipe table: a row above the header is the header, aligned as the columns were', () => {
        let state = EditorState.create({ doc: parseDocument(md, TIDY).doc, plugins: editorPlugins() });
        const inName = cellTextPos(state.doc, 'Name');
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, inName)));
        const tr = addRowTransaction(state, 'above');
        assert.ok(tr);
        state = state.apply(tr);
        const rows = cellsOf(state.doc.child(0));
        assert.deepStrictEqual(rows[0], [{ type: 'table_header', text: '', align: 'left' }, { type: 'table_header', text: '', align: 'center' }, { type: 'table_header', text: '', align: 'right' }]);
        assert.deepStrictEqual(rows[1].map(c => c.type), ['table_cell', 'table_cell', 'table_cell'], 'the old header is a body row now');
        assert.strictEqual(serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, OPTIONS).split('\n')[1], '| :---- | :----: | ----: |');

        const deleting = EditorState.create({ doc: parseDocument(md, TIDY).doc, plugins: editorPlugins() });
        const header = deleting.apply(deleting.tr.setSelection(TextSelection.create(deleting.doc, cellTextPos(deleting.doc, 'Kind'))));
        const gone = header.apply(deleteRowTransaction(header) as Transaction);
        assert.deepStrictEqual(cellsOf(gone.doc.child(0))[0].map(c => `${c.type}:${c.text}`), ['table_header:Alpha', 'table_header:first', 'table_header:1'], 'the next row is the header');
        const single = EditorState.create({ doc: parseDocument(md, '| only |\n| ---- |\n').doc, plugins: editorPlugins() });
        const inOnly = single.apply(single.tr.setSelection(TextSelection.create(single.doc, cellTextPos(single.doc, 'only'))));
        assert.ok(deleteRowRefusal(inOnly)?.includes('Delete table'), 'a header row alone is the table');
        assert.ok(deleteColumnRefusal(inOnly)?.includes('Delete table'));
    });

    test('the page refuses what the tidy form cannot write: typing | into code in a cell', () => {
        const source = '| a |\n| - |\n| `code` |\n';
        let state = EditorState.create({ doc: parseDocument(md, source).doc, plugins: editorPlugins() });
        const at = cellTextPos(state.doc, 'code') + 2;
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
        const typed = state.tr.insertText('|');
        assert.ok(tableRefusal(typed)?.includes('"|"'), String(tableRefusal(typed)));
        assert.strictEqual(state.apply(typed).doc.eq(state.doc), true, 'the filter drops it');
        const plain = EditorState.create({ doc: parseDocument(md, '| a |\n| - |\n| text |\n').doc, plugins: editorPlugins() });
        const inText = plain.apply(plain.tr.setSelection(TextSelection.create(plain.doc, cellTextPos(plain.doc, 'text') + 2)));
        const written = inText.apply(inText.tr.insertText('|'));
        assert.ok(serializeDocument({ doc: written.doc, eol: '\n', tail: '' }, OPTIONS).includes('| te\\|xt |'), 'a | in text is written \\|');
    });

    test('a | is escaped where the text is, once: in text, alt text and a title; a text backslash before it stays one backslash', () => {
        const link = editorSchema.marks.link.create({ href: 'x.md', title: 'a|b', markup: null });
        const table = nodes.table.create(null, [
            nodes.table_row.create(null, [nodes.table_header.create(null, editorSchema.text('h'))]),
            nodes.table_row.create(null, [nodes.table_cell.create(null, [
                editorSchema.text('a\\|b '),
                editorSchema.text('l', [link]),
                editorSchema.text(' '),
                nodes.image.create({ src: 'i.png', alt: 'p|q', title: null }),
            ])]),
        ]);
        const text = `${tableLines(table).join('\n')}\n`;
        assert.ok(text.includes('a\\\\\\|b [l](x.md "a\\|b") ![p\\|q](i.png)'), text);
        const cell = cellsOf(parseDocument(md, text).doc.child(0))[1][0];
        assert.strictEqual(cell.text, 'a\\|b l ', 'reads back as it was');
    });

    test('Enter leaves the table only from a caret in an empty last row, not from cells selected down into it', () => {
        const source = '| a |\n| - |\n| x |\n|   |\n';
        const base = EditorState.create({ doc: parseDocument(md, source).doc, plugins: editorPlugins() });
        const table = base.doc.child(0);
        const cellStart = (row: number) => {
            let pos = 1;
            for (let r = 0; r < row; r++) {
                pos += table.child(r).nodeSize;
            }
            return pos + 1;
        };
        assert.strictEqual(table.childCount, 3, 'the header, a row, an empty last row');
        const across = base.apply(base.tr.setSelection(CellSelection.create(base.doc, cellStart(1), cellStart(2))));
        let result: EditorState | null = null;
        enterInCell(across, tr => {
            result = across.apply(tr);
        });
        assert.ok(result);
        assert.strictEqual((result as EditorState).doc.child(0).childCount, 4, 'a selection across rows keeps the empty row, and adds one as Enter in the last row does');
        const caret = base.apply(base.tr.setSelection(TextSelection.create(base.doc, cellStart(2) + 1)));
        enterInCell(caret, tr => {
            result = caret.apply(tr);
        });
        assert.strictEqual((result as EditorState).doc.child(0).childCount, 2, 'a caret there takes the row away');
        assert.strictEqual((result as EditorState).doc.child(1).type, nodes.paragraph, 'and leaves for a paragraph');
    });

    test('a lens on any line of a table goes on the table block, as on any block', () => {
        const source = `# Title\n\n${TIDY}\nAfter.\n`;
        const ranges = blockLineRanges(md, source);
        const table = topChildren(parseDocument(md, source).doc).findIndex(n => n.type === nodes.table);
        assert.strictEqual(table, 1);
        for (let line = 2; line <= 5; line++) {
            assert.strictEqual(blockIndexForLine(ranges, line), table, `line ${line}`);
        }
        assert.strictEqual(blockIndexForLine(ranges, 7), 2, 'the paragraph after it');
    });
});
