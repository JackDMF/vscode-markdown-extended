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
import { hostEngine, touched } from './helpers';

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

suite('Editor read-back oracle: addresses, paths and titles', () => {
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));

    const BS = '\\';
    function linkParagraph(href: string, title: string | null): Node {
        return touched(editorSchema.nodes.paragraph.create(null, [
            editorSchema.text('A '), editorSchema.text('foo', [editorSchema.marks.link.create({ href, title })]), editorSchema.text(' y.'),
        ]));
    }
    function imageParagraph(src: string, title: string | null): Node {
        return touched(editorSchema.nodes.paragraph.create(null, [
            editorSchema.text('A '), editorSchema.nodes.image.create({ src, title, alt: 'pic' }), editorSchema.text(' y.'),
        ]));
    }
    function write(block: Node): string {
        return serializeDocument({ doc: editorSchema.topNodeType.create(null, [block]), eol: '\n', tail: '' }, { defaultWrap: 200 });
    }
    /** The first link's or image's address and title, read back by the page's engine from what the save writes. */
    function readBack(block: Node): { href: string; title: string | null } | null {
        const definition = currentInlineDefinition();
        let found: { href: string; title: string | null } | null = null;
        parseDocument(attrsEngineFor(definition), write(block), {}, definition).doc.descendants(node => {
            const link = node.marks.find(m => m.type.name === 'link');
            if (found === null && link !== undefined) {
                found = { href: link.attrs.href as string, title: link.attrs.title as string | null };
            } else if (found === null && node.type.name === 'image') {
                found = { href: node.attrs.src as string, title: node.attrs.title as string | null };
            }
        });
        return found;
    }

    test('an address, a path and a title the UI set are written so the engine reads them back, and the comparison agrees', () => {
        const md = attrsEngineFor(currentInlineDefinition());
        const hrefs = ['<x>', `${BS}*a`, `a${BS}`, `a${BS})b`, '&amp;', 'a&lt;b', ' u', 'u ', 'a b', 'a)b', '<x', 'ä', 'a"b', 'a\tb', 'a\nb'];
        for (const href of hrefs) {
            for (const block of [linkParagraph(href, null), imageParagraph(href, null)]) {
                const back = readBack(block);
                assert.strictEqual(back?.href, md.normalizeLink(href), `${JSON.stringify(href)} written ${JSON.stringify(write(block))}`);
                assert.strictEqual(literalNotReadBack(block), null, JSON.stringify(href));
            }
        }
        const titles = [`a${BS}`, `a${BS}*b`, 'a&amp;b', '&#35;', 'a\n\nb', 'a\n# b', 'a"b', 'a)b'];
        for (const title of titles) {
            for (const block of [linkParagraph('u', title), imageParagraph('u', title)]) {
                assert.strictEqual(readBack(block)?.title, title, `${JSON.stringify(title)} written ${JSON.stringify(write(block))}`);
                assert.strictEqual(literalNotReadBack(block), null, JSON.stringify(title));
            }
        }
    });

    test('an address the engine reads otherwise than the page shows is refused, named as the address', () => {
        const engine = attrsEngineFor(currentInlineDefinition());
        const parse = engine.parse;
        type Visited = { type: string; attrs: [string, string][] | null; children: Visited[] | null };
        // Every address the comparison's parse reads is somewhere else: the save would link elsewhere.
        engine.parse = ((...args: Parameters<typeof parse>) => {
            const tokens = parse.apply(engine, args);
            const visit = (list: Visited[]) => list.forEach(token => {
                if (token.type === 'link_open' || token.type === 'image') {
                    token.attrs = (token.attrs ?? []).map(([n, v]): [string, string] => [n, n === 'href' || n === 'src' ? `${v}-elsewhere` : v]);
                }
                visit(token.children ?? []);
            });
            visit(tokens as unknown as Visited[]);
            return tokens;
        }) as typeof parse;
        try {
            const link = literalNotReadBack(linkParagraph('https://example.org/oracle-address', null));
            assert.deepStrictEqual(link?.cause, { kind: 'address', noun: 'link' });
            const image = literalNotReadBack(imageParagraph('oracle-path.png', null));
            assert.deepStrictEqual(image?.cause, { kind: 'address', noun: 'image' });
            assert.ok(causeReason({ kind: 'address', noun: 'image' }).includes('image\'s path'));
            assert.ok(causeReason({ kind: 'title', noun: 'link' }).includes('link\'s title'));
        } finally {
            engine.parse = parse;
        }
    });
});

suite('Editor read-back oracle: the textblocks themselves', () => {
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));

    function save(state: EditorState): string {
        return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 200 });
    }
    /** The top-level blocks the host's engine, front-matter rule and all, reads in `text`. */
    function hostBlocks(text: string): string[] {
        const blocks: string[] = [];
        parseDocument(hostEngine(), text, {}).doc.forEach(node => blocks.push(node.type.name));
        return blocks;
    }

    test('a tab typed at a paragraph\'s start is not written: the paragraph stays one, not a code block', () => {
        for (const [source, first] of [['A foo y.\n', 'A '], ['- item foo\n', 'item'], ['!!! note\n    body foo\n', 'body'], ['::: warning\nbody foo\n:::\n', 'body']]) {
            const state = stateOf(source);
            const tr = state.tr.insertText('\t', posOf(state.doc, first));
            assert.strictEqual(noteRefusal(tr), null, source);
            const written = save(state.apply(tr));
            assert.ok(!written.includes('\t'), JSON.stringify(written));
            assert.deepStrictEqual(hostBlocks(written), hostBlocks(source), JSON.stringify(written));
        }
    });

    test('text the save would read as another block, or as more than one, is refused, named by what it would be', () => {
        const state = stateOf('A foo y.\n');
        const at = posOf(state.doc, 'foo');
        assert.strictEqual(noteRefusal(state.tr.insertText('\n\n', at)), causeReason({ kind: 'block', noun: 'more than one block' }));
        const heading = stateOf('# Head foo\n');
        assert.strictEqual(noteRefusal(heading.tr.insertText('\n# ', posOf(heading.doc, 'foo'))), causeReason({ kind: 'block', noun: 'a heading' }));
        assert.strictEqual(noteRefusal(heading.tr.insertText('\n', posOf(heading.doc, 'foo'))), causeReason({ kind: 'block', noun: 'more than one block' }));
        // Where a line start can be escaped, it is, and nothing is refused: `A\n\# foo y.` is one paragraph.
        assert.strictEqual(noteRefusal(state.tr.insertText('\n# ', at)), null);
        // An emptied paragraph is written as nothing and read as nothing: no refusal.
        const items = stateOf('- one\n- two\n');
        const two = posOf(items.doc, 'two');
        assert.strictEqual(noteRefusal(items.tr.delete(two, two + 3)), null);
    });

    test('a document\'s first list is not written so that the host reads front matter in its first item', () => {
        for (const [source, typed, wanted] of [
            ['- a | b\n', '---', '* \\---a | b\n'],
            ['- a | b\n', 'x---', '* x---a | b\n'],
            ['- a\n\n* b\n', 'x---', '+ x---a\n\n* b\n'],
        ] as const) {
            const state = stateOf(source);
            const tr = state.tr.insertText(typed, posOf(state.doc, 'a'));
            assert.strictEqual(noteRefusal(tr), null, source);
            const written = save(state.apply(tr));
            assert.strictEqual(written, wanted);
            assert.deepStrictEqual(hostBlocks(written), hostBlocks(source), JSON.stringify(written));
        }
        // Not at the file's start, the list keeps its bullet.
        const later = stateOf('Text.\n\n- a\n');
        const tr = later.tr.insertText('x---', posOf(later.doc, 'a'));
        assert.strictEqual(save(later.apply(tr)), 'Text.\n\n- x---a\n');
    });

    test('a rule inserted at a document\'s start is not written as the --- that opens front matter', () => {
        const doc = editorSchema.topNodeType.create(null, [
            editorSchema.nodes.horizontal_rule.create(), touched(editorSchema.nodes.paragraph.create(null, [editorSchema.text('A y.')])),
        ]);
        const written = serializeDocument({ doc, eol: '\n', tail: '' }, { defaultWrap: 80 });
        assert.strictEqual(written, '***\n\nA y.\n');
        assert.deepStrictEqual(hostBlocks(written), ['horizontal_rule', 'paragraph']);
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
