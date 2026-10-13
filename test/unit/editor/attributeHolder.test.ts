import * as assert from 'assert';
import * as path from 'path';
import { Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import {
    CONTAINER_ATTRS_REFUSAL, EditorObject, attributeHolderAt, holderInside, isMarkObject, objectAtSelection, sameObject,
} from '../../../src/editor/webview/objects';
import { INLINE_ATTRS_LOCK, TOOLBAR_ACTIONS } from '../../../src/editor/webview/toolbar/actions';
import { evaluate } from '../../../src/editor/webview/toolbar/toolbar';
import { hostEngine, readText, repoRoot } from './helpers';

function stateOf(text: string): EditorState {
    return EditorState.create({ doc: parseDocument(hostEngine(), text, {}).doc });
}

/** The position of character `index` of the first text `needle` stands in. */
function posOf(doc: Node, needle: string, index = 0): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(needle)) {
            found = pos + (node.text ?? '').indexOf(needle) + index;
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}" in the document`);
    return found;
}

/** `state` with a caret at character `index` of `needle`, or a selection of `length` from there. */
function at(state: EditorState, needle: string, index = 0, length = 0): EditorState {
    const from = posOf(state.doc, needle, index);
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + length)));
}

/** The label the inline holder at the selection has, or `null`. */
const named = (state: EditorState) => attributeHolderAt(state).inline?.holder.label ?? null;

suite('Editor attribute holder: one rule for what at the selection carries a {…}', () => {
    test('wherever the bars show a mark\'s object or an image, the holder is that same object', () => {
        const docs = [
            readText(path.join(repoRoot, 'test', 'fixtures', 'editor', 'markLiterals.md')),
            '| a | b |\n| - | - |\n| **bold** | `c`{.k} |\n',
            'See [the `x` here](u){.l} and [plain *em* link](v) now.\n',
            'A *`x`* b, **_x_{.a}**{.b} c, `y`{.c}*z*{.d} e.\n',
            'A ![a](s.png){.c} and ![b](t.png) here, [![i](s.png){.e}](u){.f}.\n',
        ];
        let checked = 0;
        for (const text of docs) {
            const state = stateOf(text);
            state.doc.descendants((node, pos) => {
                if (node.isTextblock) {
                    for (let p = pos + 1; p <= pos + node.nodeSize - 1; p++) {
                        const caret = state.apply(state.tr.setSelection(TextSelection.create(state.doc, p)));
                        const object = objectAtSelection(caret);
                        if (object !== null && isMarkObject(object)) {
                            const inline = attributeHolderAt(caret).inline;
                            assert.ok(inline !== null && sameObject(inline.object, object), `${JSON.stringify(text.slice(0, 40))} at ${p}: ${object.kind} vs ${inline?.object.kind ?? 'none'}`);
                            checked++;
                        }
                    }
                }
                if (node.type.name === 'image') {
                    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos)));
                    const object = objectAtSelection(selected) as EditorObject;
                    assert.strictEqual(object.kind, 'image');
                    assert.ok(sameObject(attributeHolderAt(selected).inline?.object ?? null, object));
                    checked++;
                }
                return true;
            });
        }
        assert.ok(checked > 100, `${checked} places checked`);
    });

    test('at a seam the one after the caret is meant, inside nested marks the innermost; across runs none', () => {
        const state = stateOf('a*b*c and *b*`c` here.\n');
        assert.strictEqual(named(at(state, 'c and', 0)), 'Emphasis', 'b|c: the emphasis before');
        assert.strictEqual(named(at(state, 'a', 1)), 'Emphasis', 'a|b: the emphasis after');
        const seam = posOf(state.doc, 'c', 0);
        let code = -1;
        state.doc.descendants((node, pos) => {
            if (code < 0 && node.marks.some(m => m.type.name === 'code')) {
                code = pos;
            }
        });
        assert.ok(code > seam);
        assert.strictEqual(named(state.apply(state.tr.setSelection(TextSelection.create(state.doc, code)))), 'Code', '*b*|`c`: the code after');

        assert.strictEqual(named(at(stateOf('A *`x`* b.\n'), 'x', 1)), 'Code', 'the innermost of two over the same text');
        assert.strictEqual(named(at(stateOf('A **_x_{.a}**{.b} b.\n'), 'x', 1)), 'Strong', 'innermost first, literals or not');
        assert.strictEqual(named(at(stateOf('A *a* b.\n'), 'a', 0, 3)), null, 'a selection from emphasis into plain text');
        assert.strictEqual(named(at(stateOf('A `code` b.\n'), 'code', 1, 2)), 'Code', 'a selection inside code');
        assert.strictEqual(named(at(stateOf('Plain text.\n'), 'text', 1)), null);
        const image = stateOf('A ![a](s.png) b.\n');
        let pos = -1;
        image.doc.descendants((n, p) => {
            pos = n.type.name === 'image' ? p : pos;
        });
        assert.strictEqual(named(image.apply(image.tr.setSelection(NodeSelection.create(image.doc, pos)))), 'Image');
    });

    test('the holder inside an object other than itself: bold in a cell, code in a link; none in plain text', () => {
        const table = at(stateOf('| a |\n| - |\n| **bold** |\n'), 'bold', 1);
        const tableObject = objectAtSelection(table) as EditorObject;
        assert.strictEqual(tableObject.kind, 'table');
        assert.strictEqual(holderInside(table, tableObject)?.holder.label, 'Strong');
        const link = at(stateOf('See [the `x` here](u) now.\n'), 'x', 0);
        const linkObject = objectAtSelection(link) as EditorObject;
        assert.strictEqual(linkObject.kind, 'link');
        assert.strictEqual(attributeHolderAt(link).inline?.holder.label, 'Link', 'the menu names the link, as its bar does');
        assert.strictEqual(holderInside(link, linkObject)?.holder.label, 'Code');
        assert.strictEqual(holderInside(at(stateOf('See [the link](u) now.\n'), 'link', 1), objectAtSelection(at(stateOf('See [the link](u) now.\n'), 'link', 1)) as EditorObject), null);
    });

    test('the Formatting entries are named by their target, and the inline one is disabled where nothing holds', () => {
        const action = (id: string) => TOOLBAR_ACTIONS.find(a => a.id === id) as (typeof TOOLBAR_ACTIONS)[number];
        const block = (state: EditorState) => evaluate(action('block-attributes'), state, false);
        const inline = (state: EditorState) => evaluate(action('inline-attributes'), state, false);
        assert.strictEqual(block(at(stateOf('A paragraph.\n'), 'para')).label, 'Attributes of Paragraph…');
        assert.strictEqual(block(at(stateOf('- an item\n'), 'item')).label, 'Attributes of List item…');
        assert.strictEqual(block(at(stateOf('| a |\n| - |\n| cell |\n'), 'cell')).label, 'Attributes of Table…');
        const contained = block(at(stateOf('::: box\nInside.\n:::\n'), 'Inside'));
        assert.deepStrictEqual(contained, { enabled: false, active: false, reason: CONTAINER_ATTRS_REFUSAL, label: 'Attributes of Block…' });
        assert.deepStrictEqual(inline(at(stateOf('A `code` b.\n'), 'code', 1)), { enabled: true, active: false, reason: null, label: 'Attributes of Code…' });
        assert.strictEqual(inline(at(stateOf('See [a link](u).\n'), 'link', 1)).label, 'Attributes of Link…');
        assert.deepStrictEqual(inline(at(stateOf('Plain text.\n'), 'text', 1)), { enabled: false, active: false, reason: INLINE_ATTRS_LOCK, label: 'Attributes of Code…' });
    });
});
