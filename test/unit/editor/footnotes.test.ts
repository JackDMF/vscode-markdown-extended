import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { parseDocument } from '../../../src/editor/parse';
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
            { refs: [], defines: ['n'] },
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
        ['an inline footnote in a sidenote', 'x ++a|b^[n]++ y\n', 'has a footnote in a note'],
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
