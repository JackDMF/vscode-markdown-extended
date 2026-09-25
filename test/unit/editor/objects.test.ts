import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { PRESERVE_SOURCE_META } from '../../../src/editor/fidelity';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument } from '../../../src/editor/serialize';
import {
    EditorObject, changeImageTransaction, changeLinkTransaction, convertNoteRefusal, convertNoteTransaction, currentObject, deleteObjectTransaction,
    noteSource, objectAtSelection, removeLinkTransaction,
} from '../../../src/editor/webview/objects';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { inlineSourceTransaction } from '../../../src/editor/webview/toolbar/commands';
import { hostEngine } from './helpers';

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: editorPlugins() });
}

function text(state: EditorState): string {
    return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
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

function caretAt(state: EditorState, needle: string, offset = 1): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, needle) + offset)));
}

/** The first node of type `name`, selected as a node. */
function nodeSelected(state: EditorState, name: string): EditorState {
    let at = -1;
    state.doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === name) {
            at = pos;
        }
        return at < 0;
    });
    assert.ok(at >= 0, `no ${name}`);
    return state.apply(state.tr.setSelection(NodeSelection.create(state.doc, at)));
}

function objectHere(state: EditorState): EditorObject {
    const object = objectAtSelection(state);
    assert.ok(object, 'an object at the selection');
    return object;
}

suite('Editor objects: which object the selection is on', () => {
    test('a caret in a note, in a link, in a link inside a note, and in plain text', () => {
        const base = stateOf('Plain ++the ref|see [spec](s.md) here++ and [a link](a.md) end.\n');
        assert.strictEqual(objectAtSelection(caretAt(base, 'Plain')), null, 'plain text is no object');
        const inNote = objectHere(caretAt(base, 'the ref'));
        assert.strictEqual(inNote.kind, 'note');
        assert.strictEqual(inNote.kind === 'note' && inNote.node.type.name, 'sidenote');
        const inLink = objectHere(caretAt(base, 'a link', 2));
        assert.strictEqual(inLink.kind, 'link');
        assert.strictEqual(base.doc.textBetween(inLink.from, inLink.to), 'a link', 'the range is the link\'s text');
        const nested = objectHere(caretAt(base, 'spec', 2));
        assert.strictEqual(nested.kind, 'link', 'the innermost object: the link, not the note around it');
        assert.strictEqual(nested.kind === 'link' && nested.mark.attrs.href, 's.md');
        // At either end of the link's text the caret touches the link.
        assert.strictEqual(objectHere(caretAt(base, 'a link', 0)).kind, 'link');
        assert.strictEqual(objectHere(caretAt(base, 'a link', 'a link'.length)).kind, 'link');
    });

    test('a node selected as a whole: an image, a source block', () => {
        const state = stateOf('An ![pic](p.png) here.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
        assert.strictEqual(objectHere(nodeSelected(state, 'image')).kind, 'image');
        assert.strictEqual(objectHere(nodeSelected(state, 'raw_block')).kind, 'raw_block');
    });

    test('an object is looked up again before a verb acts, and a changed one is not acted on', () => {
        const state = caretAt(stateOf('Alpha ++beta|body++ gamma.\n'), 'body');
        const note = objectHere(state);
        assert.ok(currentObject(state, note));
        const typed = state.apply(state.tr.insertText('X', posOf(state.doc, 'Alpha')));
        assert.strictEqual(currentObject(typed, note), null, 'the note moved: the stale object is not it');
    });
});

suite('Editor objects: a note\'s verbs', () => {
    test('a sidenote converts to a marginal note and back, reference, body and marks kept, the caret where it was', () => {
        const source = 'The ++lives *in* here|a **bold** body++ and more.\n';
        const state = caretAt(stateOf(source), 'bold', 2);
        const note = objectHere(state);
        const converted = state.apply(convertNoteTransaction(state, note.from) as never);
        assert.strictEqual(text(converted), 'The !!lives *in* here|a **bold** body!! and more.\n');
        assert.strictEqual(converted.selection.head, state.selection.head, 'the caret stays in the body');
        assert.strictEqual(converted.doc.resolve(converted.selection.head).parent.type.name, 'marginal_note_body');
        const back = converted.apply(convertNoteTransaction(converted, note.from) as never);
        assert.strictEqual(text(back), source);
        let undone = converted;
        assert.ok(undo(converted, tr => {
            undone = converted.apply(tr);
        }));
        assert.strictEqual(text(undone), source, 'one undo converts it back');
    });

    test('a sidebar moves to the other side, its text and the marks it carries kept', () => {
        const state = caretAt(stateOf('**Bold @right *side*@ around** end.\n'), 'right');
        const moved = state.apply(convertNoteTransaction(state, objectHere(state).from) as never);
        assert.strictEqual(text(moved), '**Bold $right *side*$ around** end.\n');
        const back = moved.apply(convertNoteTransaction(moved, objectHere(state).from) as never);
        assert.strictEqual(text(back), '**Bold @right *side*@ around** end.\n');
    });

    test('a conversion whose result could not be written back is refused, with the reason', () => {
        // Code in a left sidebar may hold `@`; in a right one it would end the sidebar.
        const state = caretAt(stateOf('A $see `a@b` here$ b.\n'), 'see');
        const reason = convertNoteRefusal(state, objectHere(state).from);
        assert.ok(reason?.includes('"@"'), String(reason));
        const plain = caretAt(stateOf('A ++ref|body++ b.\n'), 'ref');
        assert.strictEqual(convertNoteRefusal(plain, objectHere(plain).from), null);
    });

    test('its source is what the serializer writes for the note alone, without the marks around it', () => {
        const state = caretAt(stateOf('**Alpha ++beta *x*|the body++ gamma.**\n'), 'beta');
        const note = objectHere(state);
        assert.strictEqual(note.kind === 'note' && noteSource(note.node), '++beta *x*|the body++');
        const sidebar = objectHere(caretAt(stateOf('A @right side@ b.\n'), 'right'));
        assert.strictEqual(sidebar.kind === 'note' && noteSource(sidebar.node), '@right side@');
    });

    test('Edit source writes the typed text in its place as source, the marks around it kept, and the host\'s parse decides what it is', () => {
        const state = caretAt(stateOf('**Alpha ++beta|body++ gamma.**\n\nNext.\n'), 'beta');
        const note = objectHere(state);
        assert.ok(note.kind === 'note');
        const context = { eol: '\n' as const, defaultWrap: 90, documentText: text(state) };
        const tr = inlineSourceTransaction(state, note.from, note.to, '!!beta|the new body!!', note.node.marks, context);
        assert.ok(tr);
        assert.strictEqual(tr.getMeta(PRESERVE_SOURCE_META), true);
        const next = state.apply(tr);
        assert.strictEqual(next.doc.child(0).type.name, 'raw_block', 'source, until the host parses it again');
        assert.strictEqual(text(next), '**Alpha !!beta|the new body!! gamma.**\n\nNext.\n');
        const reparsed = parseDocument(hostEngine(), text(next), {}).doc;
        const kinds: string[] = [];
        reparsed.descendants(node => {
            kinds.push(node.type.name);
        });
        assert.ok(kinds.includes('marginal_note'), 'the host reads a marginal note');
        // Malformed, it is text to the parser: whatever the page typed stays as typed.
        const broken = state.apply(inlineSourceTransaction(state, note.from, note.to, '++beta', note.node.marks, context) as never);
        assert.strictEqual(text(broken), '**Alpha ++beta gamma.**\n\nNext.\n');
    });
});

suite('Editor objects: a link\'s and an image\'s verbs', () => {
    const linkAt = (state: EditorState) => {
        const object = objectHere(state);
        assert.ok(object.kind === 'link');
        return object;
    };

    test('Change URL links the same text elsewhere, its title kept; a bare URL becomes [text](url)', () => {
        let state = caretAt(stateOf('See [the spec](spec.md "Spec") here.\n'), 'spec');
        state = state.apply(changeLinkTransaction(state, linkAt(state), ' other.md#part ') as never);
        assert.strictEqual(text(state), 'See [the spec](other.md#part "Spec") here.\n');
        assert.strictEqual(changeLinkTransaction(state, linkAt(state), 'other.md#part'), null, 'unchanged');
        assert.strictEqual(changeLinkTransaction(state, linkAt(state), '  '), null, 'empty');

        let bare = caretAt(stateOf('Go to https://a.example now.\n'), 'a.example');
        bare = bare.apply(changeLinkTransaction(bare, linkAt(bare), 'https://b.example') as never);
        assert.strictEqual(text(bare), 'Go to [https://a.example](https://b.example) now.\n');
    });

    test('Remove link keeps its text, marks inside it too', () => {
        const state = caretAt(stateOf('See [the **spec**](spec.md) here.\n'), 'the');
        const removed = state.apply(removeLinkTransaction(state, linkAt(state)));
        assert.strictEqual(text(removed), 'See the **spec** here.\n');
        assert.strictEqual(objectAtSelection(removed), null);
    });

    test('Change source shows another image, its alt text kept; Remove image takes it out', () => {
        const state = nodeSelected(stateOf('An ![pic](p.png "T") here.\n'), 'image');
        const image = objectHere(state);
        const changed = state.apply(changeImageTransaction(state, image.from, 'q.png') as never);
        assert.strictEqual(text(changed), 'An ![pic](q.png "T") here.\n');
        assert.ok(changed.selection instanceof NodeSelection, 'the image stays selected');
        const removed = state.apply(deleteObjectTransaction(state, image));
        // The two spaces left are written as one: a run of spaces is one in HTML.
        assert.strictEqual(text(removed), 'An here.\n');
    });
});

suite('Editor objects: deleting a block', () => {
    test('Delete block removes a source block, the caret where it was', () => {
        const state = nodeSelected(stateOf('Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n'), 'raw_block');
        const deleted = state.apply(deleteObjectTransaction(state, objectHere(state)));
        assert.strictEqual(text(deleted), 'Before.\n\nAfter.\n');
        assert.ok(deleted.selection instanceof TextSelection);
    });

    test('Delete directive removes an expansion and the directive line it writes', () => {
        const mark = { rule: 'req-includes', kind: 'expansion', snippet: 'legal', line: 2, path: '/c/legal.md' };
        const doc = Node.fromJSON(editorSchema, {
            type: 'doc',
            content: [
                { type: 'paragraph', attrs: { src: 'Before.\n', gap: '' }, content: [{ type: 'text', text: 'Before.' }] },
                { type: 'injected_block', attrs: { kind: 'expansion', mark, html: '<p>Body.</p>', src: '<!-- include: legal -->\n', gap: '\n' } },
                { type: 'paragraph', attrs: { src: 'After.\n', gap: '\n' }, content: [{ type: 'text', text: 'After.' }] },
            ],
        });
        let state = EditorState.create({ doc, plugins: editorPlugins() });
        assert.strictEqual(text(state), 'Before.\n\n<!-- include: legal -->\n\nAfter.\n');
        state = nodeSelected(state, 'injected_block');
        const deleted = state.apply(deleteObjectTransaction(state, objectHere(state)));
        assert.strictEqual(text(deleted), 'Before.\n\nAfter.\n');
    });
});
