import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { history, undo } from 'prosemirror-history';
import { EditorState, TextSelection, Transaction } from 'prosemirror-state';
import { PRESERVE_SOURCE_META, editorSchema, fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { splitRequirementHeading } from '../../../src/editor/webview/plugins';
import { hostEngine, topChildren } from './helpers';

const SOURCE = [
    '---',
    'title: Fidelity',
    '---',
    '',
    'First paragraph.',
    '',
    'Second paragraph.',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    'Third paragraph.',
    '',
].join('\n');

/** The document position just inside top-level child `index`. */
function inside(doc: Node, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) {
        pos += doc.child(i).nodeSize;
    }
    return pos + 1;
}

function start(doc: Node, index: number): number {
    return inside(doc, index) - 1;
}

suite('Editor fidelity plugin', () => {
    const md = hostEngine();
    const parsed = parseDocument(md, SOURCE);
    const original = topChildren(parsed.doc).map(n => n.attrs.src as string | null);
    const names = topChildren(parsed.doc).map(n => n.type.name);
    const state = () => EditorState.create({ doc: parsed.doc, plugins: [fidelityPlugin()] });

    test('the fixture is front matter, three paragraphs and a raw table', () => {
        assert.deepStrictEqual(names, ['front_matter', 'paragraph', 'paragraph', 'raw_block', 'paragraph']);
    });

    test('typing into the second paragraph clears only its src', () => {
        const before = state();
        const after = before.apply(before.tr.insertText('Edited: ', inside(before.doc, 2)));
        const srcs = topChildren(after.doc).map(n => n.attrs.src as string | null);
        assert.deepStrictEqual(srcs, [original[0], original[1], null, original[3], original[4]]);
        const out = serializeDocument({ ...parsed, doc: after.doc }, { defaultWrap: 90 });
        assert.strictEqual(out, SOURCE.replace('Second paragraph.', 'Edited: Second paragraph.'));
    });

    test('deleting a node leaves every other node\'s src, and its gap goes with it', () => {
        const before = state();
        const from = start(before.doc, 1);
        const after = before.apply(before.tr.delete(from, from + before.doc.child(1).nodeSize));
        const srcs = topChildren(after.doc).map(n => n.attrs.src as string | null);
        assert.deepStrictEqual(srcs, [original[0], original[2], original[3], original[4]]);
        const out = serializeDocument({ ...parsed, doc: after.doc }, { defaultWrap: 90 });
        assert.strictEqual(out, SOURCE.replace('First paragraph.\n\n', ''));
    });

    test('front_matter and raw_block never lose src, even when replaced by a new node object', () => {
        const before = state();
        const fm = before.doc.child(0);
        const table = before.doc.child(3);
        let tr = before.tr.replaceWith(start(before.doc, 3), start(before.doc, 3) + table.nodeSize, table.type.create({ ...table.attrs }));
        tr = tr.replaceWith(0, fm.nodeSize, fm.type.create({ ...fm.attrs }));
        const after = before.apply(tr);
        assert.notStrictEqual(after.doc.child(0), fm, 'a new node object');
        assert.strictEqual(after.doc.child(0).attrs.src, original[0]);
        assert.strictEqual(after.doc.child(3).attrs.src, original[3]);
    });

    test('a moved node keeps its identity and therefore its slice', () => {
        const before = state();
        const third = before.doc.child(4);
        const tr = before.tr.delete(start(before.doc, 4), start(before.doc, 4) + third.nodeSize);
        tr.insert(start(before.doc, 1), third);
        const after = before.apply(tr);
        assert.strictEqual(after.doc.child(1).attrs.src, original[4]);
    });

    test('a transaction marked to preserve sources clears neither src nor gap', () => {
        const before = state();
        const second = before.doc.child(2);
        const tr = before.tr.insertText('x', inside(before.doc, 1));
        tr.delete(start(tr.doc, 2), start(tr.doc, 2) + second.nodeSize);
        tr.insert(tr.doc.content.size, second);
        const after = before.apply(tr.setMeta(PRESERVE_SOURCE_META, true));
        assert.strictEqual(after.doc.child(1).attrs.src, original[1]);
        assert.strictEqual(after.doc.child(after.doc.childCount - 1).attrs.gap, second.attrs.gap);
    });

    test('an undo restores src and gap with the content, and the file its exact bytes', () => {
        let s = EditorState.create({ doc: parsed.doc, plugins: [history(), fidelityPlugin()] });
        const apply = (tr: Transaction) => {
            s = s.apply(tr);
        };
        apply(s.tr.split(inside(s.doc, 2) + 'Second '.length));
        assert.strictEqual(s.doc.child(2).attrs.src, null);
        assert.strictEqual(s.doc.child(3).attrs.gap, null);
        assert.ok(undo(s, apply));
        assert.deepStrictEqual(topChildren(s.doc).map(n => n.attrs.src as string | null), original);
        assert.strictEqual(serializeDocument({ ...parsed, doc: s.doc }, { defaultWrap: 90 }), SOURCE);
    });
});

suite('Editor fidelity plugin: gap', () => {
    const md = hostEngine();
    const SOURCE = '# H\nAlpha beta\n\n\n\nSecond, after three blank lines.\n\n\nThird, after two.\n';
    const parsed = parseDocument(md, SOURCE);
    const state = () => EditorState.create({ doc: parsed.doc, plugins: [fidelityPlugin()] });
    const gaps = (doc: Node) => topChildren(doc).map(n => n.attrs.gap as string | null);
    const write = (doc: Node) => serializeDocument({ ...parsed, doc }, { defaultWrap: 90 });

    test('the fixture\'s gaps are what the source holds', () => {
        assert.deepStrictEqual(gaps(parsed.doc), ['', '', '\n\n\n', '\n\n']);
    });

    test('a split paragraph: the first half keeps its gap, the second half and its follower lose theirs', () => {
        const before = state();
        const after = before.apply(before.tr.split(inside(before.doc, 1) + 'Alpha '.length));
        assert.deepStrictEqual(gaps(after.doc), ['', '', null, null, '\n\n']);
        assert.strictEqual(write(after.doc), '# H\nAlpha\n\nbeta\n\nSecond, after three blank lines.\n\n\nThird, after two.\n');
    });

    test('deleting a middle node clears its follower\'s gap and no other', () => {
        const before = state();
        const from = start(before.doc, 2);
        const after = before.apply(before.tr.delete(from, from + before.doc.child(2).nodeSize));
        assert.deepStrictEqual(gaps(after.doc), ['', '', null]);
    });

    test('a moved node and the node now after its old place lose their gaps, by a drop or otherwise', () => {
        for (const drop of [false, true]) {
            const before = state();
            const alpha = before.doc.child(1);
            const tr = before.tr.delete(start(before.doc, 1), start(before.doc, 1) + alpha.nodeSize);
            tr.insert(tr.doc.content.size, alpha);
            if (drop) {
                tr.setMeta('uiEvent', 'drop');
            }
            const after = before.apply(tr);
            const texts = topChildren(after.doc).map(n => n.textContent);
            assert.deepStrictEqual(texts, ['H', 'Second, after three blank lines.', 'Third, after two.', 'Alpha beta']);
            assert.deepStrictEqual(gaps(after.doc), ['', null, '\n\n', null], `drop: ${drop}`);
            assert.strictEqual(after.doc.child(3).attrs.src, alpha.attrs.src, 'the moved node is still written from its slice');
        }
    });

    test('typing in a node touches no gap', () => {
        const before = state();
        const after = before.apply(before.tr.insertText('Edited ', inside(before.doc, 2)));
        assert.deepStrictEqual(gaps(after.doc), gaps(parsed.doc));
        assert.strictEqual(after.doc.child(2).attrs.src, null);
    });
});

suite('Editor fidelity plugin: requirement ids', () => {
    const md = hostEngine();
    const SOURCE = '## FRS-TST-001: Title here {#frs-tst-001-abc}\n\nText.\n';
    const parsed = parseDocument(md, SOURCE);

    /** The document as the parser leaves it when Req Explorer's badge names the id (it is not in the test host). */
    function requirementDoc(extraHeading = false): Node {
        const [heading, ...rest] = topChildren(parsed.doc);
        const lifted = heading.type.create(
            { ...heading.attrs, reqPrefix: 'FRS-TST-001: ' },
            editorSchema.text('Title here'),
        );
        const copy = lifted.type.create(lifted.attrs, lifted.content);
        return parsed.doc.type.create(null, extraHeading ? [lifted, ...rest, copy] : [lifted, ...rest]);
    }
    const ids = (n: Node) => [n.attrs.reqPrefix, n.attrs.anchor, n.attrs.attrsSuffix] as unknown[];

    test('the fixture heading carries an anchor and its suffix', () => {
        const heading = requirementDoc().child(0);
        assert.deepStrictEqual(ids(heading), ['FRS-TST-001: ', 'frs-tst-001-abc', '{#frs-tst-001-abc}']);
    });

    test('the second half of a heading split by any transaction does not carry the id again', () => {
        const before = EditorState.create({ doc: requirementDoc(), plugins: [fidelityPlugin()] });
        const after = before.apply(before.tr.split(1 + 'Title '.length));
        const [first, second] = topChildren(after.doc);
        assert.strictEqual(second.type.name, 'heading');
        assert.deepStrictEqual(ids(first), ids(before.doc.child(0)));
        assert.deepStrictEqual(ids(second), [null, null, null]);
        assert.strictEqual(second.attrs.src, null);
    });

    test('a pasted copy of the heading loses the id; the original keeps it', () => {
        const before = EditorState.create({ doc: requirementDoc(), plugins: [fidelityPlugin()] });
        const heading = before.doc.child(0);
        const after = before.apply(before.tr.insert(before.doc.content.size, heading.type.create(heading.attrs, heading.content)));
        const children = topChildren(after.doc);
        assert.deepStrictEqual(ids(children[0]), ids(heading));
        assert.deepStrictEqual(ids(children[children.length - 1]), [null, null, null]);
    });

    test('typing in one of two headings the file already duplicates changes neither', () => {
        const before = EditorState.create({ doc: requirementDoc(true), plugins: [fidelityPlugin()] });
        const lastStart = before.doc.content.size - before.doc.child(before.doc.childCount - 1).nodeSize;
        const after = before.apply(before.tr.insertText('New ', lastStart + 1));
        const children = topChildren(after.doc);
        assert.deepStrictEqual(ids(children[children.length - 1]), ids(before.doc.child(0)));
        assert.deepStrictEqual(ids(children[0]), ids(before.doc.child(0)));
    });
});

suite('Editor webview: Enter in a requirement heading', () => {
    const md = hostEngine();
    const parsed = parseDocument(md, '## FRS-TST-001: Title here {#frs-tst-001-abc}\n\nText.\n');
    const heading = parsed.doc.child(0);
    const doc = parsed.doc.type.create(null, [
        heading.type.create({ ...heading.attrs, reqPrefix: 'FRS-TST-001: ' }, editorSchema.text('Title here')),
        ...topChildren(parsed.doc).slice(1),
    ]);

    function enterAt(offset: number): Node {
        let s = EditorState.create({ doc, plugins: [fidelityPlugin()] });
        s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1 + offset)));
        assert.ok(splitRequirementHeading(s, tr => {
            s = s.apply(tr);
        }));
        return s.doc;
    }

    test('in the middle of the title, the text after the caret becomes a paragraph', () => {
        const after = enterAt('Title '.length);
        assert.deepStrictEqual(topChildren(after).map(n => `${n.type.name}:${n.textContent}`), ['heading:Title ', 'paragraph:here', 'paragraph:Text.']);
        assert.strictEqual(after.child(0).attrs.anchor, 'frs-tst-001-abc');
        assert.strictEqual(after.child(0).attrs.reqPrefix, 'FRS-TST-001: ');
    });

    test('at the start of the title the command leaves the default split alone', () => {
        let s = EditorState.create({ doc, plugins: [fidelityPlugin()] });
        s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1)));
        assert.strictEqual(splitRequirementHeading(s, undefined), false);
    });

    test('a heading with no id or suffix is split by the default command', () => {
        const plain = EditorState.create({ doc: parseDocument(md, '## Plain title\n').doc, plugins: [fidelityPlugin()] });
        const s = plain.apply(plain.tr.setSelection(TextSelection.create(plain.doc, 1 + 'Plain '.length)));
        assert.strictEqual(splitRequirementHeading(s, undefined), false);
    });
});
