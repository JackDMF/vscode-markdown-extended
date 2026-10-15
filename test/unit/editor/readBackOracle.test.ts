import * as assert from 'assert';
import { EditorState, TextSelection } from 'prosemirror-state';
import { Node } from 'prosemirror-model';
import { fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { DEFAULT_INLINE_ENGINE, attrsEngineFor, currentInlineDefinition } from '../../../src/editor/inlineEngine';
import { editorSchema } from '../../../src/editor/schema';
import {
    blockDiffers, causeReason, frontMatterTakeover, pairingsDiffer, literalLostReason, literalNotReadBack, literalsReadBack, readAsOne, setInlineEngine,
} from '../../../src/editor/serialize';
import { noteRefusal } from '../../../src/editor/webview/notes';
import {
    EditorObject, LITERAL_READ_WITH_BLOCK_REFUSAL, applySpanRefusal, applySpanTransaction, changeLinkTransaction, changeSpanRefusal, changeSpanTransaction, literalAlreadyLostRefusal, objectAtSelection, sameObject,
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
        let other = stateOf('A **b**$c$ y.\n');
        const at = posOf(other.doc, 'b');
        other = other.apply(other.tr.removeMark(at, at + 1, editorSchema.marks.strong).addMark(at, at + 1, editorSchema.marks.strong.create({ markup: '**', literal: '{title="a $b"}' })));
        const literal = literalNotReadBack(touched(other.doc.child(0)));
        assert.ok(literal !== null, 'the $ in the literal pairs: refused');
        assert.notStrictEqual(literal.cause?.kind, 'merged', JSON.stringify(literal.cause));
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

suite('Editor read-back oracle: a run of underscores', () => {
    /** The text of `text`'s first textblock with each character's marks, as the host's engine reads it. */
    function marked(doc: Node): string {
        let out = '';
        doc.descendants(node => {
            if (node.isText) {
                out += `${node.text ?? ''}[${node.marks.map(m => m.type.name).join(',')}]`;
            }
        });
        return out;
    }

    test('bold given to foo in foo__abc__ is applied, and the underscores read back as text', () => {
        for (const [source, word, type, wanted] of [
            ['A foo__abc__ y.\n', 'foo', editorSchema.marks.strong.create({ markup: '**' }), 'A **foo**\\_\\_abc\\_\\_ y.\n'],
            ['foo__abc__\n', 'foo', editorSchema.marks.em.create({ markup: '*' }), '*foo*\\_\\_abc\\_\\_\n'],
            ['Die größe__maße__ü bleibt.\n', 'Die', editorSchema.marks.strong.create({ markup: '**' }), '**Die** größe__maße__ü bleibt.\n'],
            ['A Straße__abc__ y.\n', 'A', editorSchema.marks.em.create({ markup: '*' }), '*A* Straße__abc\\_\\_ y.\n'],
        ] as const) {
            const state = stateOf(source);
            const at = posOf(state.doc, word);
            const tr = state.tr.addMark(at, at + word.length, type);
            assert.strictEqual(noteRefusal(tr), null, source);
            const next = state.apply(tr);
            const written = serializeDocument({ doc: next.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
            assert.strictEqual(written, wanted);
            assert.strictEqual(marked(parseDocument(hostEngine(), written, {}).doc), marked(next.doc));
        }
    });

    test('a run inside a word stays as it is; one at a word\'s edge is escaped whole', () => {
        const state = stateOf('A y.\n');
        // Which runs the engine reads inside a word is asked of it: ASCII, Latin-1, umlauts and ß, CJK and digits alike.
        for (const [typed, wanted] of [
            ['snake__case ', 'A snake__case y.\n'], ['__init__ ', 'A \\_\\_init\\_\\_ y.\n'], ['a_b ', 'A a_b y.\n'],
            ['é__abc__é ', 'A é__abc__é y.\n'], ['größe__x__ü ', 'A größe__x__ü y.\n'], ['中__abc__中 ', 'A 中__abc__中 y.\n'], ['1__a__2 ', 'A 1__a__2 y.\n'],
            ['Maße__ ', 'A Maße\\_\\_ y.\n'],
        ]) {
            const tr = state.tr.insertText(typed, posOf(state.doc, 'y'));
            assert.strictEqual(noteRefusal(tr), null, typed);
            const written = serializeDocument({ doc: state.apply(tr).doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
            assert.strictEqual(written, wanted);
        }
    });
});

suite('Editor read-back oracle: the merge review', () => {
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));

    const p = (text: string) => editorSchema.nodes.paragraph.create(null, text === '' ? [] : [editorSchema.text(text)]);
    const doc = (...blocks: Node[]) => editorSchema.topNodeType.create(null, blocks);
    const raw = () => editorSchema.nodes.raw_block.create({ src: 'x\n', html: '<p>x</p>' });
    /** `found` is the block cause `expected.cause`, anchored at `expected.at` — by identity: a node is not compared deeply. */
    const assertCause = (found: ReturnType<typeof blockDiffers>, expected: { cause: { kind: string; noun: string }; at: Node }) => {
        assert.ok(found !== null && 'cause' in found, 'a cause');
        assert.deepStrictEqual(found.cause, expected.cause);
        assert.ok(found.at === expected.at, 'anchored at the textblock it was found at');
    };

    test('a block the editor shows as its source stands for the textblocks it took; the rest of the part is compared', () => {
        const a = p('A'), b = p('B');
        /** The distinct pairings, each as `shown→read` texts. */
        const texts = (found: ReturnType<typeof blockDiffers>) => {
            assert.ok(found !== null && 'pairings' in found, 'pairings');
            return found.pairings.map(pairs => pairs.map(([shown, read]) => `${shown.textContent}→${read.textContent}`).join(' '));
        };
        assert.deepStrictEqual(texts(blockDiffers([a, b], doc(raw(), p('B')), a)), ['B→B']);
        // Beside it, another kind of textblock than the page shows is still a difference.
        const h = editorSchema.nodes.heading.create({ level: 2 }, [editorSchema.text('H')]);
        const heading = editorSchema.nodes.heading.create({ level: 2 }, [editorSchema.text('H')]);
        assertCause(blockDiffers([a, h], doc(raw(), heading, p('C')), a), { cause: { kind: 'block', noun: 'more than one block' }, at: h });
        assert.deepStrictEqual(texts(blockDiffers([a, b], doc(p('A'), raw()), a)), ['A→A']);
        // Two source blocks side by side take what they take together: one pairing, compared.
        const together = blockDiffers([a, b], doc(raw(), raw(), p('Bchanged')), a);
        assert.deepStrictEqual(texts(together), ['B→Bchanged']);
        assert.deepStrictEqual(pairingsDiffer((together as { pairings: [Node, Node][][] }).pairings)?.cause, { kind: 'text', noun: '' });
        // Around one paragraph: two pairings, and it reads back under neither — refused; under one of them — not.
        const around = blockDiffers([a, b], doc(raw(), p('Bchanged'), raw()), a);
        assert.deepStrictEqual(texts(around).sort(), ['A→Bchanged', 'B→Bchanged']);
        assert.deepStrictEqual(pairingsDiffer((around as { pairings: [Node, Node][][] }).pairings)?.cause, { kind: 'text', noun: '' });
        const either = blockDiffers([a, b], doc(raw(), p('B'), raw()), a) as { pairings: [Node, Node][][] };
        assert.strictEqual(pairingsDiffer(either.pairings), null);
        assert.ok(texts(blockDiffers([a, b, p('C')], doc(raw(), raw(), p('B'), p('C')), a)).includes('B→B C→C'));
    });

    test('an empty paragraph in a respelled first list is no other shape: the list is kept out of front matter, not refused', () => {
        const li = (...content: Node[]) => editorSchema.nodes.list_item.create(null, content);
        const list = editorSchema.nodes.bullet_list.create({ bullet: '-' }, [li(p('x---'), p(''))]);
        const state = EditorState.create({ doc: doc(list), plugins: [fidelityPlugin()] });
        const tr = state.tr.insertText('y', 7);
        assert.strictEqual(noteRefusal(tr), null);
        const written = serializeDocument({ doc: state.apply(tr).doc, eol: '\n', tail: '' }, { defaultWrap: 80 });
        assert.ok(written.startsWith('* '), JSON.stringify(written));
        assert.ok(!parseDocument(hostEngine(), written, {}).doc.content.content.some(n => n.type.name === 'front_matter'), JSON.stringify(written));
    });

    test('a block of a document that wrote nothing which comes to open the file is held to the front-matter rule', () => {
        const li = (...content: Node[]) => editorSchema.nodes.list_item.create(null, content);
        const state = EditorState.create({ doc: doc(p(''), p('')), plugins: [fidelityPlugin()] });
        const list = editorSchema.nodes.bullet_list.create({ bullet: '-' }, [li(p('x---'), p(''))]);
        const second = state.doc.child(0).nodeSize;
        const tr = state.tr.replaceWith(second, second + state.doc.child(1).nodeSize, list);
        const refusal = noteRefusal(tr);
        const written = serializeDocument({ doc: state.apply(tr).doc, eol: '\n', tail: '' }, { defaultWrap: 80 });
        const host = parseDocument(hostEngine(), written, {}).doc;
        // Kept out by another bullet, or refused: never saved as front matter.
        assert.ok(refusal !== null || !host.content.content.some(n => n.type.name === 'front_matter'), `${refusal} ${JSON.stringify(written)}`);
        assert.strictEqual(frontMatterTakeover(tr.doc, state.doc), frontMatterTakeover(tr.doc));
        // A block no spelling keeps out of front matter — one kept as the file spells it — coming to open such a file: refused.
        const kept = editorSchema.nodes.raw_block.create({ src: '---\nfoo\n', gap: '', html: '<hr>' });
        const pasted = state.tr.replaceWith(second, second + state.doc.child(1).nodeSize, kept);
        assert.strictEqual(noteRefusal(pasted), causeReason({ kind: 'block', noun: 'front matter' }));
        assert.strictEqual(frontMatterTakeover(pasted.doc, state.doc), causeReason({ kind: 'block', noun: 'front matter' }));
    });

    test('three source blocks side by side in a long part take what they take as one: a changed paragraph is still refused', () => {
        const shown = Array.from({ length: 30 }, (_, k) => p(`P${k}`));
        const read = [raw(), raw(), raw(), ...shown.slice(1).map((n, k) => p(k === 14 ? 'changed' : n.textContent))];
        const found = blockDiffers(shown, doc(...read), shown[0]);
        assert.ok(found !== null && 'pairings' in found, 'compared');
        assert.strictEqual(found.pairings.length, 1);
        assert.deepStrictEqual(pairingsDiffer(found.pairings)?.cause, { kind: 'text', noun: '' });
    });

    test('a list item that is a rule is written with a character its list\'s marker is not', () => {
        const li = (...content: Node[]) => editorSchema.nodes.list_item.create(null, content);
        for (const [bullet, wanted] of [['*', '* a\n\n* ---\n'], ['-', '- a\n\n- ***\n'], ['+', '+ a\n\n+ ***\n']] as const) {
            const list = editorSchema.nodes.bullet_list.create({ bullet }, [li(p('a')), li(editorSchema.nodes.horizontal_rule.create({ markup: bullet === '-' ? '---' : '***' }))]);
            const written = serializeDocument({ doc: doc(touched(list)), eol: '\n', tail: '' }, { defaultWrap: 80 });
            assert.strictEqual(written, wanted);
            const back = parseDocument(hostEngine(), written, {}).doc;
            assert.strictEqual(back.childCount, 1, written);
            assert.strictEqual(back.child(0).childCount, 2, written);
            assert.strictEqual(back.child(0).child(1).firstChild?.type.name, 'horizontal_rule', written);
        }
    });

    test('a first list kept out of front matter by another bullet still reads back as the same list', () => {
        const li = (...content: Node[]) => editorSchema.nodes.list_item.create(null, content);
        const list = editorSchema.nodes.bullet_list.create({ bullet: '-' }, [li(p('x---')), li(editorSchema.nodes.horizontal_rule.create({ markup: '***' }))]);
        // The intro above it emptied: the list opens the file.
        const state = EditorState.create({ doc: doc(p('Intro'), list), plugins: [fidelityPlugin()] });
        const tr = state.tr.delete(1, 1 + 'Intro'.length);
        assert.strictEqual(noteRefusal(tr), null);
        const written = serializeDocument({ doc: state.apply(tr).doc, eol: '\n', tail: '' }, { defaultWrap: 80 });
        assert.strictEqual(written, '* x---\n\n* ---\n');
        const back = parseDocument(hostEngine(), written, {}).doc;
        assert.deepStrictEqual(back.content.content.map(n => `${n.type.name}(${n.childCount})`), ['bullet_list(2)']);
    });

    test('a block read as another kind is named by what is read where it stood, not by the count', () => {
        const heading = editorSchema.nodes.heading.create({ level: 1 }, [editorSchema.text('H')]);
        assertCause(blockDiffers([heading], doc(p('H')), heading), { cause: { kind: 'block', noun: 'a paragraph' }, at: heading });
        const a = p('A'), b = p('B');
        const code = editorSchema.nodes.code_block.create(null, [editorSchema.text('A')]);
        assertCause(blockDiffers([a], doc(code), a), { cause: { kind: 'block', noun: 'a code block' }, at: a });
        // The block that took B's place, after A — not the first code block anywhere.
        const read = blockDiffers([a, b], doc(code, p('A'), editorSchema.nodes.horizontal_rule.create()), a);
        assertCause(read, { cause: { kind: 'block', noun: 'a rule' }, at: b });
    });

    test('an edit after which the host would read the file\'s start as front matter is refused', () => {
        for (const source of ['---\na: 1\n---\n---\n\nText.\n', '---\na: 1\n---\n- x---y\n']) {
            // The host's engine: only it reads front matter.
            const state = EditorState.create({ doc: parseDocument(hostEngine(), source, {}).doc, plugins: [fidelityPlugin()] });
            assert.strictEqual(state.doc.child(0).type.name, 'front_matter');
            const tr = state.tr.delete(0, state.doc.child(0).nodeSize);
            assert.strictEqual(noteRefusal(tr), causeReason({ kind: 'block', noun: 'front matter' }), source);
            assert.strictEqual(frontMatterTakeover(tr.doc), causeReason({ kind: 'block', noun: 'front matter' }));
        }
        assert.strictEqual(frontMatterTakeover(stateOf('- a\n').doc), null);
    });
});

suite('Editor read-back oracle: the follow-ups', () => {
    teardown(() => setInlineEngine(DEFAULT_INLINE_ENGINE));

    test('a parse whose element reaches over text the model leaves unmarked reads no second run: not merged', () => {
        const withX = editorSchema.marks.strong.create({ markup: '**', literal: '{.x}' });
        const plain = editorSchema.marks.strong.create({ markup: '**' });
        const want = [{ key: '|a', marks: [withX] }, { key: '|b', marks: [] }];
        const got = [{ key: '|a', marks: [plain] }, { key: '|b', marks: [plain] }];
        assert.strictEqual(readAsOne(want, got, 0, withX), false, 'one run, and text the element took');
        const two = [{ key: '|a', marks: [withX] }, { key: '|b', marks: [plain] }];
        assert.strictEqual(readAsOne(two, got, 0, withX), true, 'two runs of the model read as one');
    });

    test('Span with class over a selection starting inside emphasis gives the edit filter\'s answer, not a $ pairing', () => {
        for (const source of ['A *foo* bar y.\n', 'A **foo** bar y.\n']) {
            let state = stateOf(source);
            const from = posOf(state.doc, 'oo');
            const to = posOf(state.doc, 'bar') + 3;
            state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
            const refusal = applySpanRefusal(state, '{.c}');
            assert.ok(refusal !== null, source);
            assert.notStrictEqual(refusal, LITERAL_READ_WITH_BLOCK_REFUSAL, source);
            assert.strictEqual(refusal, noteRefusal(state.tr.addMark(from, to, editorSchema.marks.attr_span.create({ literal: '{.c}' }))), source);
        }
    });

    test('Span with class: its field\'s reason and its transaction are one decision', () => {
        const cases: [string, string, string, string][] = [
            ['A *foo* bar y.\n', 'oo', 'bar', '{.c}'], ['A foo bar y.\n', 'foo', 'bar', '{.c}'], ['A foo bar y.\n', 'foo', 'bar', '{.c'],
            ['A **b**$c$ y.\n', 'A', 'y', '{title="a $b"}'], ['Text ++ref|a b body++ end.\n', 'b', 'body', '{title="x|y"}'], ['A `foo` bar y.\n', 'oo', 'bar', '{.c}'],
        ];
        let refused = 0;
        for (const [source, start, end, literal] of cases) {
            let state = stateOf(source);
            state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, start), posOf(state.doc, end) + end.length)));
            const refusal = applySpanRefusal(state, literal);
            refused += refusal === null ? 0 : 1;
            assert.strictEqual(applySpanTransaction(state, literal) === null, refusal !== null, `${source} ${literal}: ${refusal}`);
        }
        assert.ok(refused > 0 && refused < cases.length, `${refused} of ${cases.length} refused`);
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
