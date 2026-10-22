import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { EditorState, NodeSelection, TextSelection, Transaction } from 'prosemirror-state';
import { PRESERVE_SOURCE_META } from '../../../src/editor/fidelity';
import { BACKTICK_INFO_REFUSAL, LANGUAGE_FOLLOWED_REFUSAL, LANGUAGE_LITERAL_REFUSAL, LANGUAGE_WORD_REFUSAL, NO_FENCE_REFUSAL, shortFenceRefusal } from '../../../src/editor/fences';
import { createEditorEngine } from '../../../src/editor';
import { DEFAULT_INLINE_ENGINE, inlineEngineDefinition } from '../../../src/editor/inlineEngine';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument, setInlineEngine } from '../../../src/editor/serialize';
import { plugins } from '../../../src/plugin/plugins';
import {
    CodeBlockObject, EditorObject, NESTED_CODE_ATTRS_REFUSAL, changeLanguageTransaction, changeLinkTransaction, commitOpeningLine, convertNoteRefusal, convertNoteTransaction, currentObject, deleteObjectTransaction,
    editImageTransaction, IMAGE_LOCK, insertFilesTransaction, insertLinkTransaction, insertLockReason, isTopLevelBlock, LINK_LOCK, noteSource, objectAtSelection,
    removeLinkTransaction,
} from '../../../src/editor/webview/objects';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { inlineSourceTransaction } from '../../../src/editor/webview/toolbar/commands';
import { hostEngine } from './helpers';
import { saidText } from '../../../src/editor/tips';

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
    test('a caret in a top-level heading is its heading object, a whole top-level block; a note in it is the note', () => {
        const base = stateOf('# Title with ++a ref|body++ in it\n\nText.\n');
        const heading = objectHere(caretAt(base, 'Title'));
        assert.strictEqual(heading.kind, 'heading');
        assert.strictEqual(heading.from, 0);
        assert.ok(isTopLevelBlock(base, heading), 'a heading carries other extensions\' code actions');
        const note = objectHere(caretAt(base, 'a ref'));
        assert.strictEqual(note.kind, 'note');
        assert.ok(!isTopLevelBlock(base, note), 'a note does not: the host knows no range of it');
        assert.strictEqual(objectAtSelection(caretAt(base, 'Text')), null, 'a paragraph is still text');
    });

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
        const state = stateOf('An ![pic](p.png) here.\n\n| a | b |\n| = | = |\n| 1 | 2 |\n');
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
        assert.strictEqual(converted.doc.nodeAt(note.from)?.child(0).attrs.anchor, 'mn-anchor', 'the reference is the marginal note\'s');
        assert.ok(parseDocument(hostEngine(), text(converted), {}).doc.nodeAt(note.from)?.eq(converted.doc.nodeAt(note.from) as Node),
            'the note the page holds is the one the save reads back');
        const back = converted.apply(convertNoteTransaction(converted, note.from) as never);
        assert.strictEqual(text(back), source);
        assert.strictEqual(back.doc.nodeAt(note.from)?.child(0).attrs.anchor, 'sn-anchor', 'and back the sidenote\'s');
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
        // Code in a sidenote may hold `!!`; in a marginal note it would end the note.
        const state = caretAt(stateOf('A ++ref|see `a!!b` here++ b.\n'), 'ref');
        const reason = convertNoteRefusal(state, objectHere(state).from);
        assert.strictEqual(saidText(reason ?? ''), 'A !! can\'t go in inline code inside a marginal note — it would end the note there. Type it outside the code.');
        // Superscript may hold `@` in either sidebar: in a right one it is written `\@`, which it unescapes.
        const raised = caretAt(stateOf('A $see ^a@b^ here$ b.\n'), 'see');
        assert.strictEqual(convertNoteRefusal(raised, objectHere(raised).from), null);
        assert.strictEqual(text(raised.apply(convertNoteTransaction(raised, objectHere(raised).from) as never)), 'A @see ^a\\@b^ here@ b.\n');
        // Code may hold it in either: the sidebar rule skips a code span whole.
        const coded = caretAt(stateOf('A $see `a@b` here$ b.\n'), 'see');
        assert.strictEqual(convertNoteRefusal(coded, objectHere(coded).from), null);
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

    test('Edit image… with the alt text kept shows another image; Remove image takes it out', () => {
        const state = nodeSelected(stateOf('An ![pic](p.png "T") here.\n'), 'image');
        const image = objectHere(state);
        const changed = state.apply(editImageTransaction(state, image.from, 'pic', 'q.png') as never);
        assert.strictEqual(text(changed), 'An ![pic](q.png "T") here.\n');
        assert.ok(changed.selection instanceof NodeSelection, 'the image stays selected');
        const removed = state.apply(deleteObjectTransaction(state, image));
        // The two spaces left are written as one: a run of spaces is one in HTML.
        assert.strictEqual(text(removed), 'An here.\n');
    });

    test('Edit image… sets the alt text and the path, the title kept; nothing changed is no transaction', () => {
        const state = nodeSelected(stateOf('An ![pic](p.png "T") here.\n'), 'image');
        const image = objectHere(state);
        const edited = state.apply(editImageTransaction(state, image.from, 'A picture', 'images/q%20r.png') as never);
        assert.strictEqual(text(edited), 'An ![A picture](images/q%20r.png "T") here.\n');
        assert.ok(edited.selection instanceof NodeSelection);
        assert.strictEqual(editImageTransaction(state, image.from, 'pic', 'p.png'), null, 'unchanged');
        assert.strictEqual(editImageTransaction(state, image.from, 'pic', ' '), null, 'no path');
    });
});

suite('Editor objects: making a link, inserting files', () => {
    const select = (state: EditorState, needle: string) => {
        const from = posOf(state.doc, needle);
        return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + needle.length)));
    };

    test('a link around selected text keeps the text; at a caret the text typed is inserted linked, or the address when none was', () => {
        const selected = select(stateOf('See the spec here.\n'), 'the spec');
        assert.strictEqual(insertLockReason(selected, LINK_LOCK), null);
        assert.strictEqual(text(selected.apply(insertLinkTransaction(selected, '', ' docs/spec.md#scope ') as never)), 'See [the spec](docs/spec.md#scope) here.\n');

        const caret = caretAt(stateOf('See here.\n'), 'here', 0);
        const typed = caret.apply(insertLinkTransaction(caret, 'the spec', 'spec.md') as never);
        assert.strictEqual(text(typed), 'See [the spec](spec.md)here.\n');
        assert.strictEqual(typed.selection.from, posOf(caret.doc, 'here') + 'the spec'.length, 'the caret after the link');
        assert.strictEqual(text(caret.apply(insertLinkTransaction(caret, '', 'https://example.com') as never)), 'See [https://example.com](https://example.com)here.\n');
        assert.strictEqual(insertLinkTransaction(caret, 'x', '  '), null, 'no address, no link');
    });

    test('no link or image in code', () => {
        const code = caretAt(stateOf('```\ncode\n```\n'), 'code');
        assert.strictEqual(insertLockReason(code, LINK_LOCK), LINK_LOCK);
        assert.strictEqual(insertLockReason(code, IMAGE_LOCK), IMAGE_LOCK);
        assert.strictEqual(insertLinkTransaction(code, 'x', 'y.md'), null);
        assert.strictEqual(insertFilesTransaction(code, [{ src: 'a.png', alt: 'a', image: true }]), null);
    });

    test('files go in at the caret: an image by its path and stem, one selected for its alt text; another file as a link named by its name', () => {
        const caret = caretAt(stateOf('Before after.\n'), 'after', 0);
        const one = caret.apply(insertFilesTransaction(caret, [{ src: 'images/a%20b.png', alt: 'a b', image: true }]) as never);
        assert.strictEqual(text(one), 'Before ![a b](images/a%20b.png)after.\n');
        assert.ok(one.selection instanceof NodeSelection && one.selection.node.type.name === 'image', 'the one image is selected');

        const two = caret.apply(insertFilesTransaction(caret, [
            { src: 'images/x.png', alt: 'x', image: true },
            { src: '../docs/spec.pdf', alt: 'spec.pdf', image: false },
        ]) as never);
        assert.strictEqual(text(two), 'Before ![x](images/x.png) [spec.pdf](../docs/spec.pdf)after.\n');
        assert.ok(two.selection instanceof TextSelection, 'the caret after them');
    });
});

suite('Editor objects: deleting a block', () => {
    test('Delete block removes a source block, the caret where it was', () => {
        const state = nodeSelected(stateOf('Before.\n\n| a | b |\n| = | = |\n| 1 | 2 |\n\nAfter.\n'), 'raw_block');
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

suite('Editor code blocks: the object, its opening line and its language', () => {
    /** The code block the caret is in, as `currentObject` hands it to the fields: its place and its node. */
    const blockHere = (state: EditorState): CodeBlockObject => {
        const object = objectHere(state);
        assert.strictEqual(object.kind, 'code_block');
        return object as CodeBlockObject;
    };
    const blockPos = (state: EditorState) => blockHere(state).from;

    /** What Edit source does with `line` on the block the caret is in: the opening line's transaction, or why not. */
    const edit = (state: EditorState, line: string) => commitOpeningLine(state, blockHere(state), line);
    const refusalOf = (done: ReturnType<typeof commitOpeningLine>) => done !== null && 'refusal' in done ? saidText(done.refusal) : null;
    const trOf = (done: ReturnType<typeof commitOpeningLine>) => done !== null && 'tr' in done ? done.tr : null;
    /** What Language… does with `word` on the block the caret is in. */
    const lang = (state: EditorState, word: string) => changeLanguageTransaction(state, blockHere(state), word);

    test('a fence is a code block — with a literal too, not a block with attributes; an indented one as well', () => {
        assert.strictEqual(objectHere(caretAt(stateOf('```js {.numbered}\nconst a = 1;\n```\n'), 'const')).kind, 'code_block');
        assert.strictEqual(objectHere(caretAt(stateOf('```\nplain\n```\n'), 'plain')).kind, 'code_block');
        assert.strictEqual(objectHere(caretAt(stateOf('Text.\n\n    indented\n'), 'indented')).kind, 'code_block');
    });

    test('a nested fence is found, innermost: in a list item, in a quote, in a container', () => {
        for (const source of ['- item\n\n  ```js\n  inner\n  ```\n', '> ```js\n> inner\n> ```\n', '::: warning\n```js\ninner\n```\n:::\n']) {
            const state = caretAt(stateOf(source), 'inner');
            const object = objectHere(state);
            assert.strictEqual(object.kind, 'code_block', source);
            assert.strictEqual(object.from, blockPos(state), source);
            assert.ok(!isTopLevelBlock(state, object), 'nested: no lenses');
        }
    });

    test('Edit source sets the fence, the info string and the literal; refusals keep the block', () => {
        const state = caretAt(stateOf('```js {.numbered}\nconst a = 1;\n```\n'), 'const');
        const pos = blockPos(state);
        const tr = trOf(edit(state, '~~~~ts {.x}'));
        assert.ok(tr);
        const node = tr.doc.nodeAt(pos)!;
        assert.deepStrictEqual([node.attrs.markup, node.attrs.params, node.attrs.attrsSuffix], ['~~~~', 'ts', '{.x}']);
        assert.strictEqual(text(state.apply(tr)), '~~~~ts {.x}\nconst a = 1;\n~~~~\n');
        assert.strictEqual(edit(state, '```js {.numbered}'), null, 'unchanged');
        assert.strictEqual(refusalOf(edit(state, 'js {.x}')), NO_FENCE_REFUSAL);
        assert.strictEqual(refusalOf(edit(state, '```a`b')), BACKTICK_INFO_REFUSAL);
        assert.match(refusalOf(edit(state, '```js {.}')) ?? '', /\{\.\} isn't an attribute\. Write \{\.class\}/);
        assert.strictEqual(trOf(edit(state, 'js')), null);
        const holding = caretAt(stateOf('````\na\n```\nb\n````\n'), 'a');
        assert.strictEqual(refusalOf(edit(holding, '```')), shortFenceRefusal('````'));
    });

    test('an opening line typed back as the field showed it changes nothing — the info string\'s spacing included', () => {
        for (const source of ['``` js\ncode\n```\n', '~~~ a`b\ncode\n~~~\n', '```  js  title=x\ncode\n```\n', '```js {}\ncode\n```\n']) {
            const state = caretAt(stateOf(source), 'code');
            const line = source.split('\n')[0];
            assert.strictEqual(edit(state, line), null, JSON.stringify(line));
        }
    });

    test('text braces the user never touched are no literal: they stay in the info string through a change of the fence', () => {
        // As the file holds them: `{}` is no attribute list, and a knitr header is text.
        for (const [source, typed, written] of [
            ['```js {}\ncode\n```\n', '~~~js {}', '~~~js {}\ncode\n~~~\n'],
            ['```js {.}\ncode\n```\n', '~~~js {.}', '~~~js {.}\ncode\n~~~\n'],
            ['```{r, echo = FALSE}\ncode\n```\n', '~~~{r, echo = FALSE}', '~~~{r, echo = FALSE}\ncode\n~~~\n'],
        ]) {
            const state = caretAt(stateOf(source), 'code');
            const done = edit(state, typed);
            assert.ok(done !== null && 'tr' in done, `${typed}: ${JSON.stringify(done)}`);
            assert.strictEqual(text(state.apply(done.tr)), written);
            const node = state.apply(done.tr).doc.nodeAt(blockPos(state))!;
            assert.strictEqual(node.attrs.attrsSuffix, null, `${typed}: still text, no literal`);
        }
    });

    test('a brace pair typed now is read as a literal and refused for what it is', () => {
        const state = caretAt(stateOf('```js\ncode\n```\n'), 'code');
        assert.match(refusalOf(edit(state, '```js {}')) ?? '', /isn't an attribute/);
        assert.match(refusalOf(edit(state, '```js {.}')) ?? '', /\{\.\} isn't an attribute/);
        assert.match(refusalOf(edit(state, '```{r, echo = FALSE}')) ?? '', /has spaces around "=", so it would show as text/);
    });

    test('Edit source on an indented block: empty fences it with ```; a typed line fences it with that', () => {
        const state = caretAt(stateOf('Text.\n\n    indented\n'), 'indented');
        const empty = edit(state, '');
        assert.ok(empty !== null && 'tr' in empty && empty.fenced);
        assert.strictEqual(text(state.apply(empty.tr)), 'Text.\n\n```\nindented\n```\n');
        const typed = edit(state, '~~~sh');
        assert.ok(typed !== null && 'tr' in typed && typed.fenced);
        assert.strictEqual(text(state.apply(typed.tr)), 'Text.\n\n~~~sh\nindented\n~~~\n');
        const fenced = caretAt(stateOf('```\nx\n```\n'), 'x');
        assert.deepStrictEqual(edit(fenced, ''), { refusal: NO_FENCE_REFUSAL }, 'a fenced block is not made indented');
    });

    test('Language… changes only the first word of the info string; empty removes it unless other words follow; an indented block is fenced', () => {
        const state = caretAt(stateOf('```js title=x {.n}\ncode\n```\n'), 'code');
        const pos = blockPos(state);
        const ts = lang(state, 'typescript');
        assert.ok(ts !== null && 'tr' in ts && !ts.fenced);
        assert.strictEqual(text(state.apply(ts.tr)), '```typescript title=x {.n}\ncode\n```\n');
        // The next word would become the language: refused, the way named (Daniel, #4 build questions).
        assert.deepStrictEqual(lang(state, ''), { refusal: LANGUAGE_FOLLOWED_REFUSAL });
        const alone = caretAt(stateOf('```js {.n}\ncode\n```\n'), 'code');
        const none = lang(alone, '');
        assert.ok(none !== null && 'tr' in none, 'the literal is no info word: the language goes');
        assert.strictEqual(text(alone.apply(none.tr)), '``` {.n}\ncode\n```\n');
        assert.strictEqual(lang(state, 'js'), null, 'unchanged');
        assert.deepStrictEqual(lang(state, 'a`b'), { refusal: BACKTICK_INFO_REFUSAL });
        const indented = caretAt(stateOf('Text.\n\n    echo hi\n'), 'echo');
        const sh = lang(indented, 'sh');
        assert.ok(sh !== null && 'tr' in sh && sh.fenced);
        const after = indented.apply(sh.tr);
        assert.strictEqual(text(after), 'Text.\n\n```sh\necho hi\n```\n');
        assert.strictEqual(text(after.apply(undoOnce(after))), 'Text.\n\n    echo hi\n', 'one undo step restores the indented form');
    });

    /** `state` with the code block at its caret given `attrs` — as the page leaves a block whose text grew after its fence was set. */
    const withBlockAttrs = (state: EditorState, attrs: Record<string, unknown>) => {
        const pos = blockPos(state);
        return state.apply(state.tr.setNodeMarkup(pos, undefined, { ...state.doc.nodeAt(pos)!.attrs, ...attrs }));
    };

    test('Language… on a ```js block that grew a ``` line inside: the fence the save writes, not the node\'s own', () => {
        const parsed = caretAt(stateOf('````js\na\n```\nb\n````\n'), 'a');
        const state = withBlockAttrs(parsed, { markup: '```' });
        const pos = blockPos(state);
        assert.strictEqual(text(state), '````js\na\n```\nb\n````\n', 'the save lengthens the fence');
        const ts = lang(state, 'ts');
        assert.ok(ts !== null && 'tr' in ts, 'not refused as a fence too short');
        assert.strictEqual(text(state.apply(ts.tr)), '````ts\na\n```\nb\n````\n');
        assert.strictEqual(lang(state, 'js'), null, 'the same language: the file does not change');
        assert.strictEqual(edit(state, '````js'), null, 'the line the field shows, typed back: unchanged');
        const edited = edit(state, '````js {.x}');
        assert.ok(edited !== null && 'tr' in edited);
        assert.strictEqual(text(state.apply(edited.tr)), '````js {.x}\na\n```\nb\n````\n');
    });

    test('Language… on a block whose info string holds a backtick: it is saved as ~~~, and the language changes on that', () => {
        const parsed = caretAt(stateOf('~~~js a`b\ncode\n~~~\n'), 'code');
        const state = withBlockAttrs(parsed, { markup: '```' });
        const pos = blockPos(state);
        assert.strictEqual(text(state), '~~~js a`b\ncode\n~~~\n');
        const ts = lang(state, 'ts');
        assert.ok(ts !== null && 'tr' in ts, 'not refused for a backtick after a ``` fence');
        assert.strictEqual(text(state.apply(ts.tr)), '~~~ts a`b\ncode\n~~~\n');
        assert.strictEqual(edit(state, '~~~js a`b'), null, 'the line the field shows, typed back: unchanged');
        // A language that is itself the backtick is still refused on the fence it would stand on.
        const plain = caretAt(stateOf('```js\ncode\n```\n'), 'code');
        assert.deepStrictEqual(lang(plain, 'a`b'), { refusal: BACKTICK_INFO_REFUSAL });
    });

    test('Language… takes one word: a space, or a brace, is refused with the way to Edit source', () => {
        const state = caretAt(stateOf('```js title=x {.n}\ncode\n```\n'), 'code');
        const pos = blockPos(state);
        for (const typed of ['js title=y', 'ts {.x}', 'a b', '{.x}', '}', 'js\tx']) {
            assert.deepStrictEqual(lang(state, typed), { refusal: LANGUAGE_WORD_REFUSAL }, JSON.stringify(typed));
        }
        assert.match(LANGUAGE_WORD_REFUSAL, /Edit source/);
        const indented = caretAt(stateOf('Text.\n\n    echo hi\n'), 'echo');
        assert.deepStrictEqual(lang(indented, 'sh -x'), { refusal: LANGUAGE_WORD_REFUSAL });
        const ts = lang(state, ' ts ');
        assert.ok(ts !== null && 'tr' in ts, 'the spaces around a word are not part of it');
        assert.strictEqual(text(state.apply(ts.tr)), '```ts title=x {.n}\ncode\n```\n');
    });

    test('Edit source: an info-string line inside closes nothing, so a ``` opening line is allowed on a ````-fenced block holding ```python', () => {
        const state = caretAt(stateOf('````\n```python\nprint(1)\n````\n'), 'print');
        const pos = blockPos(state);
        assert.strictEqual(refusalOf(edit(state, '```')), null);
        const tr = trOf(edit(state, '```'));
        assert.ok(tr);
        const written = text(state.apply(tr));
        assert.strictEqual(written, '```\n```python\nprint(1)\n```\n');
        const again = parseDocument(hostEngine(), written, {}).doc.firstChild!;
        assert.strictEqual(again.textContent, '```python\nprint(1)', 'what the file reads is the block that was edited');
        // A closing-shaped line is still a danger.
        const closing = caretAt(stateOf('````\n```\nx\n````\n'), 'x');
        assert.strictEqual(refusalOf(edit(closing, '```')), shortFenceRefusal('````'));
    });

    test('a nested fence: Language… works, a literal is refused with the nested reason', () => {
        const state = caretAt(stateOf('> ```js\n> inner\n> ```\n'), 'inner');
        const ts = lang(state, 'ts');
        assert.ok(ts !== null && 'tr' in ts);
        assert.strictEqual(text(state.apply(ts.tr)), '> ```ts\n> inner\n> ```\n');
        assert.strictEqual(refusalOf(edit(state, '```js {.x}')), saidText(NESTED_CODE_ATTRS_REFUSAL));
    });

    test('a nested fence with a literal in its info string: Language… changes the word, emptying names the literal, the line typed back is unchanged', () => {
        // Where the engine reads attributes, a nested fence with a literal is a source block, not a code block; where it reads none the
        // {…} is text in the info string of an ordinary nested block (`1. a` / `~~~ py {.x}`), which is where this state is met.
        const noAttrs = createEditorEngine({ linkify: true, typographer: false, plugins: plugins.filter(p => p.name !== 'markdown-it-attrs') });
        setInlineEngine(inlineEngineDefinition(noAttrs));
        try {
            const source = '1. a\n\n   ~~~ py {.x}\n   code\n   ~~~\n';
            const state = caretAt(EditorState.create({ doc: parseDocument(noAttrs, source, {}).doc, plugins: editorPlugins() }), 'code');
            assert.strictEqual(blockHere(state).node.attrs.params, ' py {.x}', 'the pair is text in the info string');
            assert.strictEqual(state.doc.resolve(blockPos(state)).depth, 2, 'in a list item');
            const ts = lang(state, 'ts');
            assert.ok(ts !== null && 'tr' in ts, JSON.stringify(ts));
            assert.strictEqual(text(state.apply(ts.tr)), '1. a\n\n   ~~~ ts {.x}\n   code\n   ~~~\n', 'the spacing around the word stays');
            assert.deepStrictEqual(lang(state, ''), { refusal: LANGUAGE_LITERAL_REFUSAL }, 'a literal follows, not "other words"');
            assert.strictEqual(lang(state, 'py'), null, 'the same language');
            assert.strictEqual(edit(state, '~~~ py {.x}'), null, 'the line typed back');
            assert.strictEqual(refusalOf(edit(state, '~~~ py {.y}')), saidText(NESTED_CODE_ATTRS_REFUSAL), 'a literal typed now is the nested refusal');
        } finally {
            setInlineEngine(DEFAULT_INLINE_ENGINE);
        }
    });

    test('Language… on text braces: "{r, echo = FALSE}" names no language and gets one in front; "js {}" and "js {.}" keep their braces', () => {
        const knitr = caretAt(stateOf('```{r, echo = FALSE}\ncode\n```\n'), 'code');
        const added = lang(knitr, 'ts');
        assert.ok(added !== null && 'tr' in added, JSON.stringify(added));
        assert.strictEqual(text(knitr.apply(added.tr)), '```ts {r, echo = FALSE}\ncode\n```\n');
        assert.strictEqual(lang(knitr, ''), null, 'no language to remove');
        for (const braces of ['{}', '{.}']) {
            const state = caretAt(stateOf(`\`\`\`js ${braces}\ncode\n\`\`\`\n`), 'code');
            const ts = lang(state, 'ts');
            assert.ok(ts !== null && 'tr' in ts, `${braces}: ${JSON.stringify(ts)}`);
            assert.strictEqual(text(state.apply(ts.tr)), `\`\`\`ts ${braces}\ncode\n\`\`\`\n`);
        }
    });

    test('Language… keeps the info string\'s spacing: the same language rewrites nothing, another replaces the word in place', () => {
        const state = caretAt(stateOf('```  js  title=x\ncode\n```\n'), 'code');
        assert.strictEqual(lang(state, 'js'), null);
        const ts = lang(state, 'ts');
        assert.ok(ts !== null && 'tr' in ts);
        assert.strictEqual(text(state.apply(ts.tr)), '```  ts  title=x\ncode\n```\n');
        const spaced = caretAt(stateOf('``` js\ncode\n```\n'), 'code');
        assert.strictEqual(lang(spaced, 'js'), null);
    });
});

/** The transaction `undo` would dispatch on `state`. */
function undoOnce(state: EditorState): Transaction {
    let made: Transaction | null = null;
    undo(state, tr => {
        made = tr;
    });
    assert.ok(made, 'something to undo');
    return made;
}
