import * as assert from 'assert';
import { Fragment, Node } from 'prosemirror-model';
import { EditorState, Transaction } from 'prosemirror-state';
import { fidelityPlugin } from '../../../src/editor/fidelity';
import { parseDocument } from '../../../src/editor/parse';
import { createPositionMap } from '../../../src/editor/positions';
import { serializeDocument } from '../../../src/editor/serialize';
import { editorSchema } from '../../../src/editor/schema';
import { hostEngine, replaceChild, topChildren, touched } from './helpers';

/** `text` parsed by the host's engine. */
function parsed(text: string) {
    return parseDocument(hostEngine(), text);
}

function write(doc: { doc: Node; eol: '\n' | '\r\n'; tail: string }, root = doc.doc): string {
    return serializeDocument({ doc: root, eol: doc.eol, tail: doc.tail }, { defaultWrap: 90 });
}

/** The document written with every top-level block that holds a footnote reference forced through its writer (`src` cleared). */
function forced(text: string): string {
    const doc = parsed(text);
    let root = doc.doc;
    topChildren(root).forEach((block, i) => {
        if (references(block).length > 0) {
            root = replaceChild(root, i, touched(block));
        }
    });
    return write(doc, root);
}

/** `text` with every footnote reference taken out, the definitions left: what a forced write is compared without. */
function withoutReferences(text: string): string {
    return text.replace(/\[\^[^\]\s]+\](?!:)|\^\[[^\]]*\]/g, '');
}

/** Each footnote reference atom in `node`: its label, or `^[…]` for an inline footnote. */
function references(node: Node): string[] {
    const out: string[] = [];
    node.descendants(child => {
        if (child.type.name === 'footnote_ref') {
            out.push(child.attrs.label ?? `^[${child.attrs.source as string}]`);
        }
    });
    return out;
}

/** Each top-level block: its type, and a source block's words. */
function shapes(text: string): string[] {
    return topChildren(parsed(text).doc).map(n => (n.type.name === 'raw_block' ? `raw_block: ${n.attrs.construct as string}` : n.type.name));
}

/**
 * The archive's shapes (Theokratie-Archiv, wave 4 #5b, synthetic copies):
 * where a reference stands in Daniel's files, and how they are written.
 */
const ARCHIVE_SHAPES: [string, string][] = [
    ['in a !!! quote under a list item', '- Punkt\n\n    !!! quote\n        „Simon, liebst[^liebst] du mich?“ Meine Schäfchen[^Schäfchen]. Zum dritten[^drittes] Mal.\n\n[^Schäfchen]: *Schäfchen*: Kleine Schafe.\n[^liebst]: *liebst*: Agapáō.\n[^drittes]: *drittes*: Dreimal.\n'],
    ['in a quote four levels deep under lists', '- eins\n\n  - zwei\n\n    > ^20^Er antwortete: „Weil ihr zu wenig Glauben[^zu_wenig_Glauben] habt.“\n\n      > Denn ich versichere euch[^ich_versichere_euch]: Wenn euer Glaube …\n\n[^zu_wenig_Glauben]: *zu wenig Glauben*  \nDer Ausdruck.\n\n[^ich_versichere_euch]: *ich versichere euch*  \nWtl. „Amen“.\n'],
    ['inside _…_', 'Er sagte _so sehr geliebt[^geliebt]_ und mehr.\n\n[^geliebt]: *geliebt*  \n  Agapáō.\n'],
    ['in a heading', '## Die Welt[^Welt]\n\n[^Welt]: *Welt*  \n  Kósmos.\n'],
    // Padded as the writer pads a table: the reference counts as its spelling.
    ['in a table cell', '| Wort        | Sinn       |\n| ----------- | ---------- |\n| Welt[^Welt] | Menschheit |\n\n[^Welt]: *Welt*  \n  Kósmos.\n'],
    ['in a sidebar', 'Ein Satz @2 Min.[^Zeit]@ danach.\n\n[^Zeit]: *Zeit*  \nUngefähr.\n'],
    ['followed by a colon mid-line', 'Denn ich versichere euch[^ich_versichere_euch]: Wenn euer Glaube.\n\n[^ich_versichere_euch]: *ich versichere euch*  \nAmen.\n'],
    ['an inline footnote in a verse quote', '> ^6^ Ihr sollt mit geschickter Anleitung^[Oder „mit weiser Lenkung“.] Krieg führen.\n'],
    ['an inline footnote inside _…_', '> _Hört auf Anleitung^[Rbi8: „Lenkung“]_, dann wird er.\n'],
    ['a repeated reference', 'Gerechtigkeit[^Gerechtigkeit] und Gerechtigkeit[^Gerechtigkeit].\n\n[^Gerechtigkeit]: *Gerechtigkeit*  \nRecht.\n'],
    // Notes share the document's footnotes (plan step 1): CA-btk22's `++Helfer|… Joh 14:16.[^Joh14:16]++`.
    ['in a sidenote\'s text', 'Doch der ++Helfer|Oder „Tröster“. (Siehe Anm. zu Joh 14:16.[^Joh14:16])++, der heilige Geist.\n\n[^Joh14:16]: *Helfer*  \nParáklētos.\n'],
    ['an inline footnote in a marginal note\'s text', 'Ein Wort !!Wort|mit Anleitung^[Oder „Lenkung“]!! danach.\n'],
];

/**
 * A footnote reference is an inline atom (wave 4 #5b, plan step 3): the block
 * holding it is rich text, written back byte for byte untouched and through
 * its writer, the reference spelled as the file had it.
 */
suite('Editor footnote references', () => {
    for (const [what, text] of ARCHIVE_SHAPES) {
        test(`${what}: an atom in rich text; untouched it writes the file's bytes, forced it differs only as it does without the reference`, () => {
            const doc = parsed(text);
            const holders = topChildren(doc.doc).filter(b => references(b).length > 0);
            assert.ok(holders.length > 0, `a block holds the reference: ${shapes(text).join(' | ')}`);
            assert.ok(holders.every(b => b.type.name !== 'raw_block'), shapes(text).join(' | '));
            assert.strictEqual(write(doc), text, 'untouched');
            const out = forced(text);
            // A list's or a table's own rewrite (indentation, padding) is the writer's, not the reference's.
            if (out !== text) {
                const bare = parsed(withoutReferences(text));
                let root = bare.doc;
                topChildren(root).forEach((block, i) => {
                    if (references(topChildren(doc.doc)[i]).length > 0) {
                        root = replaceChild(root, i, touched(block));
                    }
                });
                assert.strictEqual(withoutReferences(out), write(bare, root), 'forced');
            }
            assert.deepStrictEqual(topChildren(parsed(out).doc).map(references), topChildren(doc.doc).map(references), 'the references read back');
        });
    }

    test('a reference reads as its label, an inline footnote as its text; neither is drawn as its number yet', () => {
        const [p] = topChildren(parsed('Welt[^Welt] und Anleitung^[Oder *Lenkung*].\n\n[^Welt]: W\n').doc);
        const atoms: Node[] = [];
        p.descendants(n => {
            if (n.type.name === 'footnote_ref') {
                atoms.push(n);
            }
        });
        assert.deepStrictEqual(atoms.map(a => ({ ...a.attrs })), [{ label: 'Welt', source: null }, { label: null, source: 'Oder *Lenkung*' }]);
        assert.deepStrictEqual(atoms.map(a => a.textContent), ['[^Welt]', '^[Oder *Lenkung*]']);
    });

    test('a `(` right after a reference is escaped, so the two are no link; it reads back as the reference', () => {
        const ref = editorSchema.nodes.footnote_ref.create({ label: 'x' });
        const doc = parsed('Seed.\n\n[^x]: X\n');
        const para = editorSchema.nodes.paragraph.create(null, [editorSchema.text('a'), ref, editorSchema.text('(u) b')]);
        const out = write(doc, replaceChild(doc.doc, 0, para));
        assert.strictEqual(out, 'a[^x]\\(u) b\n\n[^x]: X\n');
        assert.deepStrictEqual(references(topChildren(parsed(out).doc)[0]), ['x']);
    });

    test('a reference followed by a colon never begins a wrapped line, and one that must (after a line break) has its colon escaped', () => {
        const doc = parsed('Seed.\n\n[^x]: X\n');
        const ref = () => editorSchema.nodes.footnote_ref.create({ label: 'x' });
        const long = `${'word '.repeat(17)}y`;
        const wrapped = editorSchema.nodes.paragraph.create(null, [editorSchema.text(`${long} `), ref(), editorSchema.text(': after it')]);
        const broken = editorSchema.nodes.paragraph.create(null, [editorSchema.text('before'), editorSchema.nodes.hard_break.create(), ref(), editorSchema.text(': after')]);
        for (const para of [wrapped, broken]) {
            const out = write(doc, replaceChild(doc.doc, 0, para));
            assert.ok(!/^\[\^x\]:/m.test(out.split('\n\n[^x]:')[0]), `no definition made: ${JSON.stringify(out)}`);
            const [back, ...rest] = topChildren(parsed(out).doc);
            assert.deepStrictEqual([back.type.name, references(back), rest.length], ['paragraph', ['x'], 1], JSON.stringify(out));
        }
    });

    test('a source block records the footnotes it holds and defines, for the numbers', () => {
        const blocks = topChildren(parsed('!!! note "T[^n]"\n    x^[i] and [^n]\n\n> [^q]: quoted[^n]\n\n[^n]: N\n').doc);
        assert.deepStrictEqual(blocks.map(b => b.attrs.footnotes ?? null), [
            { refs: ['n', null, 'n'], defines: [] },
            { refs: ['n'], defines: ['q'] },
            // An entry: its own node, no source block.
            null,
        ]);
    });
});

/** What stays a source block around footnotes (plan section 4c), each with its words. */
suite('Editor footnote references: what stays source', () => {
    const rows: [string, string, string][] = [
        ['a definition inside a quote', '> [^q]: Quoted.\n', 'has footnote text'],
        ['a definition inside a list item', '- item\n\n  [^l]: In a list.\n', 'has footnote text'],
        ['an inline footnote holding a reference (the engine numbers both alike)', 'a^[see[^x]] b\n\n[^x]: X\n', 'has a footnote in a footnote'],
        ['an inline footnote over two lines', 'a^[one\ntwo] b\n', 'has a footnote over two lines'],
        ['a reference in an admonition title', '!!! note "T[^n]"\n    body\n\n[^n]: N\n', 'has a footnote'],
    ];
    for (const [what, text, words] of rows) {
        test(`${what}: "${words}"`, () => {
            assert.strictEqual(shapes(text)[0], `raw_block: ${words}`);
            assert.strictEqual(write(parsed(text)), text);
        });
    }

    test('an inline footnote holding a | in a table cell keeps the table a source block', () => {
        assert.deepStrictEqual(shapes('| a | b |\n| - | - |\n| x^[p\\|q] | y |\n'), ['raw_block: table']);
    });

    test('a reference between superscript\'s carets is its text, as the preview reads it: no atom', () => {
        const [p] = topChildren(parsed('x ^a[^n]^ y\n\n[^n]: N\n').doc);
        assert.deepStrictEqual([p.type.name, references(p)], ['paragraph', []]);
    });
});

/** The document after `edit` on a state of `doc`, the edited blocks losing their `src` as the fidelity plugin has them lose it. */
function editedDoc(doc: { doc: Node; eol: '\n' | '\r\n'; tail: string }, edit: (state: EditorState) => Transaction): { doc: Node; eol: '\n' | '\r\n'; tail: string } {
    const state = EditorState.create({ doc: doc.doc, plugins: [fidelityPlugin()] });
    return { ...doc, doc: state.apply(edit(state)).doc };
}

/** The position right after the first `needle` in a text node of `doc`. */
function after(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        const at = found < 0 && node.isText ? (node.text ?? '').indexOf(needle) : -1;
        if (at >= 0) {
            found = pos + at + needle.length;
        }
        return found < 0;
    });
    assert.ok(found >= 0, needle);
    return found;
}

/** The archive's two continuation styles (CA-btk22): after a `␣␣` hard break, a 2-space line or a lazy (unindented) one. */
const ENTRY_STYLES = [
    'Die Welt[^Welt] und der Sklave[^Sklave].',
    '',
    '[^Welt]: *Welt*  ',
    '  Das Wort kósmos wird in der Bibel eng mit der Menschheit in Verbindung gebracht.',
    '',
    '[^Sklave]: *Sklave*  ',
    'Oder „Diener“. Die Tatsache, dass „Sklave“ hier im Singular steht, bedeutet nicht unbedingt eine Einzelperson.',
    '',
].join('\n');

/**
 * A footnote's definition is an entry where the file writes it (plan step 4):
 * untouched it is its source; changed, it keeps the way the file wrote it —
 * the space after `]:`, the continuation's prefix, the hard break's spelling.
 */
suite('Editor footnote entries', () => {
    test('both continuation styles are entries; untouched and forced they write the file\'s bytes', () => {
        const doc = parsed(ENTRY_STYLES);
        const entries = topChildren(doc.doc).filter(b => b.type.name === 'footnote_entry');
        assert.deepStrictEqual(entries.map(e => [e.attrs.label, e.attrs.space, e.attrs.continuation, e.attrs.breakStyle]), [['Welt', ' ', '  ', '  '], ['Sklave', ' ', '', '  ']]);
        assert.strictEqual(write(doc), ENTRY_STYLES);
        let root = doc.doc;
        topChildren(root).forEach((block, i) => {
            root = replaceChild(root, i, touched(block));
        });
        assert.strictEqual(write(doc, root), ENTRY_STYLES);
    });

    test('a word typed on the second line keeps the `␣␣` break and each entry\'s continuation (AC11)', () => {
        const doc = parsed(ENTRY_STYLES);
        // A word for a longer one: the line stays within the width the entry was written at (a longer one wraps, as any paragraph).
        const word = (state: EditorState, old: string, now: string) => state.tr.insertText(now, after(state.doc, old) - old.length, after(state.doc, old));
        const out = write(editedDoc(doc, state => word(state, 'unbedingt', 'immer')));
        assert.strictEqual(out, ENTRY_STYLES.replace('unbedingt', 'immer'));
        const welt = write(editedDoc(doc, state => word(state, 'Menschheit', 'Welt')));
        assert.strictEqual(welt, ENTRY_STYLES.replace('Menschheit', 'Welt'));
    });

    test('a line break added in an entry is written as its others are, the next line as its continuation (Shift+Enter)', () => {
        const doc = parsed(ENTRY_STYLES);
        const out = write(editedDoc(doc, state => state.tr.replaceWith(after(state.doc, 'Oder „Diener“.'), after(state.doc, 'Oder „Diener“.') + 1, editorSchema.nodes.hard_break.create())));
        assert.ok(out.includes('[^Sklave]: *Sklave*  \nOder „Diener“.  \nDie Tatsache'), JSON.stringify(out));
        const plain = parsed('A[^p]\n\n[^p]: One line.\n');
        const broken = write(editedDoc(plain, state => state.tr.replaceWith(after(state.doc, 'One'), after(state.doc, 'One') + 1, editorSchema.nodes.hard_break.create())));
        // An entry that read no break and no continuation writes them as Daniel's files do: two spaces, then a lazy line.
        assert.strictEqual(broken, 'A[^p]\n\n[^p]: One  \nline.\n');
        assert.deepStrictEqual(topChildren(parsed(broken).doc).map(n => n.type.name), ['paragraph', 'footnote_entry']);
    });

    test('an entry of several blocks: the first on the definition\'s line, the others indented by four', () => {
        const text = 'A[^m]\n\n[^m]: one\n\n    two\n\n    - list\n    - more\n';
        const doc = parsed(text);
        const [, entry] = topChildren(doc.doc);
        assert.deepStrictEqual([entry.type.name, entry.childCount], ['footnote_entry', 3]);
        assert.strictEqual(write(doc, replaceChild(doc.doc, 1, touched(entry))), text);
        const out = write(editedDoc(doc, state => state.tr.insertText('!', after(state.doc, 'two'))));
        assert.strictEqual(out, text.replace('two', 'two!'));
    });

    test('L-d (review 2): a touched entry wraps its lines at the text\'s width, a long label not counted (plan §3a)', () => {
        const words = `${'Wort '.repeat(14)}Ende`;
        for (const label of ['a', 'abcdefghij']) {
            const source = `x[^${label}]\n\n[^${label}]: ${words}\n  ${words}\n`;
            const doc = parsed(source);
            const blocks = topChildren(doc.doc);
            const entry = blocks[1];
            const first = entry.child(0);
            const grown = first.type.create(first.attrs, first.content.addToStart(editorSchema.text('Q ')), first.marks);
            const out = write(doc, replaceChild(doc.doc, 1, touched(entry, Fragment.from(grown))));
            const lines = out.split('\n').slice(2).filter(l => l !== '');
            // The source's lines hold 74 characters of text each, its continuation two spaces in: so do the written ones.
            assert.ok(lines.slice(1).every(l => l.length <= 76), `${label}: ${JSON.stringify(lines.map(l => l.length))}`);
            assert.ok(lines[0].length - `[^${label}]: `.length <= 74, `${label}: ${JSON.stringify(lines.map(l => l.length))}`);
        }
    });

    test('an empty definition is an entry of one empty paragraph, written `[^e]:` with no space after it', () => {
        const text = 'A[^e]\n\n[^e]:\n\nNext.\n';
        const doc = parsed(text);
        const [, entry] = topChildren(doc.doc);
        assert.deepStrictEqual([entry.type.name, entry.childCount, entry.child(0).type.name, entry.child(0).content.size], ['footnote_entry', 1, 'paragraph', 0]);
        assert.strictEqual(write(doc, replaceChild(doc.doc, 1, touched(entry))), text);
    });

    test('a new entry after one written lazily: `[^n]: text` after a blank line', () => {
        const doc = parsed(ENTRY_STYLES);
        const entry = editorSchema.nodes.footnote_entry.create({ label: 'neu' }, editorSchema.nodes.paragraph.create(null, editorSchema.text('Neuer Text.')));
        const out = write(doc, doc.doc.copy(doc.doc.content.append(Fragment.from(entry))));
        assert.strictEqual(out, `${ENTRY_STYLES}\n[^neu]: Neuer Text.\n`);
        assert.deepStrictEqual(topChildren(parsed(out).doc).map(n => n.type.name), ['paragraph', 'footnote_entry', 'footnote_entry', 'footnote_entry']);
    });

    test('two definitions with one label are two entries', () => {
        const doc = parsed('x[^a]\n\n[^a]: A one\n\n[^a]: A two\n');
        assert.deepStrictEqual(topChildren(doc.doc).map(n => [n.type.name, n.attrs.label ?? null]), [['paragraph', null], ['footnote_entry', 'a'], ['footnote_entry', 'a']]);
    });

    test('seams: a paragraph and an entry after an entry are their own blocks; an indented code block right after one is swallowed (R3, written as it is)', () => {
        const doc = parsed('x[^a]\n\n[^a]: A\n');
        const para = editorSchema.nodes.paragraph.create(null, editorSchema.text('After.'));
        const entry = editorSchema.nodes.footnote_entry.create({ label: 'b' }, editorSchema.nodes.paragraph.create(null, editorSchema.text('B')));
        const code = editorSchema.nodes.code_block.create({ markup: '' }, editorSchema.text('code'));
        const shape = (extra: Node) => {
            const out = write(doc, doc.doc.copy(doc.doc.content.append(Fragment.from(extra))));
            return { out, read: topChildren(parsed(out).doc).map(n => n.type.name) };
        };
        assert.deepStrictEqual(shape(para), { out: 'x[^a]\n\n[^a]: A\n\nAfter.\n', read: ['paragraph', 'footnote_entry', 'paragraph'] });
        assert.deepStrictEqual(shape(entry), { out: 'x[^a]\n\n[^a]: A\n\n[^b]: B\n', read: ['paragraph', 'footnote_entry', 'footnote_entry'] });
        // The known hole: four spaces after an entry continue it. The seam ladder cannot mend that; it writes it anyway.
        assert.deepStrictEqual(shape(code).read, ['paragraph', 'footnote_entry']);
    });

    test('the caret maps between an entry\'s text and its source line, past `[^label]: `', () => {
        const doc = parsed(ENTRY_STYLES);
        for (const variant of [doc, { ...doc, doc: doc.doc.type.create(null, topChildren(doc.doc).map(n => touched(n))) }]) {
            const map = createPositionMap(variant, { defaultWrap: 90 });
            // The entry's first text: its paragraph's first position.
            let at = -1;
            variant.doc.forEach((node, offset) => {
                at = node.type.name === 'footnote_entry' && node.attrs.label === 'Sklave' ? offset + 2 : at;
            });
            const lines = map.text.split('\n');
            const line = lines.findIndex(l => l.startsWith('[^Sklave]:'));
            assert.deepStrictEqual(map.sourcePositionOf(at), { line, character: '[^Sklave]: *'.length, approximate: false });
        }
    });
});

/** A `[^x]` written as text (wave 4 #5b, Q2 = yes): kept as written when nothing defines `x`. */
suite('Editor footnote literals', () => {
    test('a changed paragraph keeps `[^fehlt]` as written, not `\\[\\^fehlt\\]`; it reads back as the same text', () => {
        const doc = parsed('Siehe[^fehlt] und mehr.\n');
        const [p] = topChildren(doc.doc);
        assert.deepStrictEqual(references(p), [], 'text, as the preview reads it');
        const touchedDoc = replaceChild(doc.doc, 0, touched(p, p.content.append(Fragment.from(editorSchema.text(' Neu.')))));
        const out = write(doc, touchedDoc);
        assert.strictEqual(out, 'Siehe[^fehlt] und mehr. Neu.\n');
        assert.strictEqual(topChildren(parsed(out).doc)[0].textContent, 'Siehe[^fehlt] und mehr. Neu.');
    });

    test('one whose label the document defines is escaped: unescaped it would become the reference', () => {
        const doc = parsed('Erst[^a].\n\n[^a]: A.\n');
        const para = editorSchema.nodes.paragraph.create(null, editorSchema.text('Text [^a] als Text.'));
        const out = write(doc, replaceChild(doc.doc, 0, para));
        assert.ok(out.startsWith('Text \\[\\^a\\] als Text.\n'), JSON.stringify(out));
    });

    test('one that would start a line followed by a colon is escaped there: no definition is made', () => {
        const doc = parsed('Seed.\n');
        const para = editorSchema.nodes.paragraph.create(null, editorSchema.text('[^neu]: kein Eintrag'));
        const out = write(doc, replaceChild(doc.doc, 0, para));
        const [back, ...rest] = topChildren(parsed(out).doc);
        assert.deepStrictEqual([back.type.name, back.textContent, rest.length], ['paragraph', '[^neu]: kein Eintrag', 0], JSON.stringify(out));
    });

    test('M1 (review 1): right before `(`, `{` or a reference link\'s `[` it stays escaped, so it is no link and no attributes, and reads back as text', () => {
        for (const [line, tail] of [['Text with [^nope](see) here.', ''], ['See [^nope]{.cls} attr.', ''], ['Text with [^nope][ref] here.', '\n[ref]: http://example.com\n']] as const) {
            const doc = parsed(`Seed.\n${tail}`);
            const para = editorSchema.nodes.paragraph.create(null, editorSchema.text(line));
            const out = write(doc, replaceChild(doc.doc, 0, para));
            assert.ok(!out.includes('[^nope]'), JSON.stringify(out));
            assert.strictEqual(topChildren(parsed(out).doc)[0].textContent, line, JSON.stringify(out));
        }
    });

    test('M1 (review 2): one glued to bold text, more of the line after it, stays escaped; at the line\'s end it is written as typed', () => {
        const doc = parsed('Seed.\n');
        const glued = editorSchema.nodes.paragraph.create(null, [editorSchema.text('Siehe [^nope]'), editorSchema.text('fett', [editorSchema.marks.strong.create({ markup: '**' })]), editorSchema.text(' hier.')]);
        const out = write(doc, replaceChild(doc.doc, 0, glued));
        assert.ok(out.startsWith('Siehe \\[\\^nope\\]**fett** hier.\n'), JSON.stringify(out));
        assert.strictEqual(topChildren(parsed(out).doc)[0].textContent, 'Siehe [^nope]fett hier.');
        const last = editorSchema.nodes.paragraph.create(null, editorSchema.text('Am Ende [^nope]'));
        assert.strictEqual(write(doc, replaceChild(doc.doc, 0, last)), 'Am Ende [^nope]\n');
    });

    test('L2 (review 2): one paragraph written under more label sets than the writer keeps, in turn: each time as a fresh write would', () => {
        const para = editorSchema.nodes.paragraph.create(null, editorSchema.text('Siehe [^a] hier.'));
        const entry = (label: string) => editorSchema.nodes.footnote_entry.create({ label }, editorSchema.nodes.paragraph.create(null, editorSchema.text('T.')));
        const sets = [[], ['a'], [], ['b'], ['a', 'b'], ['c'], ['d'], ['e'], ['a'], [], ['a', 'c'], ['a']];
        for (const labels of sets) {
            const doc = editorSchema.topNodeType.create(null, [para, ...labels.map(entry)]);
            const out = serializeDocument({ doc, eol: '\n', tail: '' }, { defaultWrap: 90 }).split('\n')[0];
            assert.strictEqual(out, labels.includes('a') ? 'Siehe \\[\\^a\\] hier.' : 'Siehe [^a] hier.', JSON.stringify(labels));
        }
    });

    test('two of them in one paragraph are escaped as before: unescaped, their carets would pair as a superscript', () => {
        const doc = parsed('Seed.\n');
        const para = editorSchema.nodes.paragraph.create(null, editorSchema.text('[^a] und [^b]'));
        assert.ok(write(doc, replaceChild(doc.doc, 0, para)).startsWith('\\[\\^a\\] und \\[\\^b\\]\n'));
    });
});

