import * as assert from 'assert';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import { fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { DEFAULT_INLINE_ENGINE, attrsEngineFor, currentInlineDefinition } from '../../../src/editor/inlineEngine';
import { editorSchema } from '../../../src/editor/schema';
import { causeReason, literalLostReason, literalNotReadBack, literalsReadBack, setInlineEngine } from '../../../src/editor/serialize';
import { noteRefusal } from '../../../src/editor/webview/notes';
import {
    EditorObject, changeLinkTransaction, changeSpanRefusal, changeSpanTransaction, literalAlreadyLostRefusal, objectAtSelection, sameObject,
} from '../../../src/editor/webview/objects';
import { touched } from './helpers';

/** `text` read with the page's engine as it now is, in a state with the edit filter. */
function stateOf(text: string): EditorState {
    const definition = currentInlineDefinition();
    return EditorState.create({ doc: parseDocument(attrsEngineFor(definition), text, {}, definition).doc, plugins: [fidelityPlugin()] });
}

function posOf(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(needle)) {
            found = pos + (node.text ?? '').indexOf(needle);
        }
        return found < 0;
    });
    assert.ok(found >= 0, needle);
    return found;
}

/**
 * The save read back by the engine and compared with the model
 * (`readsBackAsShown` in `serialize.ts`), review 3: the comparison reads
 * without the typographer, a parse that throws is a refusal, and the reasons
 * name what the comparison found where it found it.
 */
suite('Editor read-back oracle: review 3', () => {
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));

    test('with the typographer on, an apostrophe, an ellipsis, (c), quotes and dashes are typed: the comparison reads without it', () => {
        setInlineEngine({ ...DEFAULT_INLINE_ENGINE, typographer: true });
        for (const typed of ['don\'t', 'it\'s', '...', '(c)', '"x"', '--', '\'quoted\'']) {
            for (const source of ['A foo y.\n', 'A **foo**{.x} y.\n']) {
                const state = stateOf(source);
                const tr = state.tr.insertText(typed, posOf(state.doc, 'foo') + 1);
                assert.strictEqual(noteRefusal(tr), null, `${typed} in ${source}`);
                assert.strictEqual(literalNotReadBack(touched(tr.doc.child(0))), null, `${typed} in ${source}`);
            }
        }
    });

    test('a parse that throws is a refusal with a reason, not a broken keystroke', () => {
        // With the typographer on, the comparison reads with an engine of its own: that one throws.
        setInlineEngine({ ...DEFAULT_INLINE_ENGINE, typographer: true });
        const engine = attrsEngineFor({ ...DEFAULT_INLINE_ENGINE, typographer: false });
        const parse = engine.parse;
        engine.parse = () => {
            throw new Error('stubbed');
        };
        try {
            const state = stateOf('A plain paragraph with nothing in it.\n');
            const tr = state.tr.insertText('z', 3);
            assert.strictEqual(noteRefusal(tr), causeReason({ kind: 'unread', noun: '' }));
        } finally {
            engine.parse = parse;
        }
    });

    test('a bare address given another address is the same link: its bar stays', () => {
        let state = stateOf('See https://example.org now.\n');
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, 'example') + 2)));
        const link = objectAtSelection(state) as Extract<EditorObject, { kind: 'link' }>;
        assert.strictEqual(link.mark.attrs.markup, 'linkify');
        const next = state.apply(changeLinkTransaction(state, link, 'https://example.com') as never);
        const after = objectAtSelection(next) as EditorObject;
        assert.strictEqual(after.kind, 'link');
        assert.ok(sameObject(after, link), 'the same object, its delimiter (none now) no matter');
    });

    test('the cause is anchored at the textblock it was found in, and named merged only where the parse reads two runs as one', () => {
        // A table: the merge is in the body cell, not the header.
        let state = stateOf('| a |\n| - |\n| foo`abc`{.x} |\n');
        const from = posOf(state.doc, 'foo');
        state = state.apply(state.tr.addMark(from, from + 3, editorSchema.marks.code.create()));
        const table = touched(state.doc.child(0));
        const lost = literalNotReadBack(table);
        assert.ok(lost !== null);
        assert.strictEqual(lost.cause?.kind, 'merged');
        assert.strictEqual(lost.at?.textContent, 'fooabc', 'the cell, not the header');
        // A literal only otherwise read — one run, `{…}` taken as text — is no merge: the literal's own verdict names it.
        let other = stateOf('A **b** y.\n');
        const at = posOf(other.doc, 'b');
        other = other.apply(other.tr.removeMark(at, at + 1, editorSchema.marks.strong).addMark(at, at + 1, editorSchema.marks.strong.create({ markup: '**', literal: '{title="a $b"}' })));
        const literal = literalNotReadBack(touched(other.doc.child(0)));
        assert.ok(literal === null || literal.cause?.kind !== 'merged', JSON.stringify(literal?.cause));
    });

    test('a block whose text the save reads otherwise still keeps a {…} it can carry: a copy asks the literals alone', () => {
        // `**)**$note$`: the bold is not read back; the paragraph's own literal is.
        let state = stateOf('See (http://e.com)$note$ here. {.k}\n');
        const at = posOf(state.doc, ')');
        let side = -1;
        state.doc.descendants((node, pos) => {
            side = side < 0 && node.type.name === 'left_sidebar' ? pos : side;
        });
        state = state.apply(state.tr.addMark(at, side, editorSchema.marks.strong.create({ markup: '**' })));
        const block = touched(state.doc.child(0));
        assert.strictEqual(literalsReadBack(block), false, 'the comparison finds the bold lost');
        assert.strictEqual(literalsReadBack(block, false), true, 'the literal itself reads back');
        assert.strictEqual(literalLostReason(literalNotReadBack(block) as never), causeReason({ kind: 'text', noun: '' }));
    });

    test('a save written with the typographer off reads back as typed', () => {
        setInlineEngine({ ...DEFAULT_INLINE_ENGINE, typographer: true });
        const state = stateOf('A foo y.\n');
        const tr = state.tr.insertText('don\'t... (c) "x"', posOf(state.doc, 'foo'));
        const next = state.apply(tr);
        assert.strictEqual(serializeDocument({ doc: next.doc, eol: '\n', tail: '' }, { defaultWrap: 90 }), 'A don\'t... (c) "x"foo y.\n');
    });
});

suite('Editor read-back oracle: the targeted check', () => {
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));

    test('the writer\'s mark order is chosen by the same parse: with the typographer on, quotes change no order', () => {
        const highlight = editorSchema.marks.mark.create();
        const em = editorSchema.marks.em.create({ markup: '*' });
        const write = () => serializeDocument({
            doc: editorSchema.topNodeType.create(null, [touched(editorSchema.nodes.paragraph.create(null, [
                editorSchema.text('a\'', [em, highlight]), editorSchema.text(' b\'...', [highlight]),
            ]))]),
            eol: '\n', tail: '',
        }, { defaultWrap: 90 });
        const off = write();
        assert.strictEqual(off, '==*a\'* b\'...==\n');
        setInlineEngine({ ...DEFAULT_INLINE_ENGINE, typographer: true });
        assert.strictEqual(write(), off);
    });

    test('a throw anywhere in the check, with the typographer off and a { in the text, is the unread refusal, and is said', () => {
        const state = stateOf('A x{y} b.\n');
        const engine = attrsEngineFor(currentInlineDefinition());
        const parse = engine.parse;
        const error = console.error;
        const said: unknown[] = [];
        engine.parse = () => {
            throw new Error('stubbed');
        };
        const replacement = (...args: unknown[]) => {
            said.push(args);
        };
        console.error = replacement;
        // VS Code's extension host keeps its own console.error: there the error goes to its log, unseen here.
        const watched = console.error === replacement;
        try {
            assert.strictEqual(noteRefusal(state.tr.insertText('z', 3)), causeReason({ kind: 'unread', noun: '' }));
            const lost = literalNotReadBack(touched(state.tr.insertText('q', 3).doc.child(0)));
            assert.strictEqual(lost?.cause?.kind, 'unread');
        } finally {
            engine.parse = parse;
            console.error = error;
        }
        assert.ok(!watched || said.length > 0, 'the error is logged');
        assert.strictEqual(literalAlreadyLostRefusal({ literal: null, cause: { kind: 'unread', noun: '' } }), causeReason({ kind: 'unread', noun: '' }));
    });

    test('changing a span\'s literal is refused with the edit filter\'s answer, as the change itself is', () => {
        let state = stateOf('Text ++ref|a [b]{.c} body++ end.\n');
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, 'b') + 1)));
        const span = objectAtSelection(state) as Extract<EditorObject, { kind: 'span' }>;
        assert.strictEqual(span.kind, 'span');
        const refusal = changeSpanRefusal(state, span, '{title="x|y"}');
        assert.ok(refusal !== null && refusal.includes('note'), refusal ?? 'none');
        assert.strictEqual(changeSpanTransaction(state, span, '{title="x|y"}'), null);
    });
});
