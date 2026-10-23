import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument } from '../../../src/editor/serialize';
import {
    LiteralObject, attributeHolderAt, changeInlineLiteralRefusal, changeInlineLiteralTransaction, convertNoteTransaction, crumbsAt, noteFieldRange,
    noteLiteralMarkerRefusal, noteLiteralRemoveGlued, objectAtSelection,
} from '../../../src/editor/webview/objects';
import { saidText } from '../../../src/editor/tips';
import { unwrapNote } from '../../../src/editor/webview/notes';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine, replaceChild, topChildren, touched } from './helpers';

/** Daniel's line (Theokratie-Archiv, Vorsitz 06-30): a marginal note carrying `{.tipp}`. */
export const TEMPO = '!!Tempo|nicht zu abrupt ändern, nicht zu schnell!!{.tipp}';

const NOTE_NAMES = ['sidenote', 'marginal_note', 'left_sidebar', 'right_sidebar'];

function parsed(src: string) {
    return parseDocument(hostEngine(), src, {});
}

function write(doc: Node): string {
    return serializeDocument({ doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
}

/** Each note and sidebar of `doc` with its literal, in document order. */
function notesOf(doc: Node): [string, string | null][] {
    const out: [string, string | null][] = [];
    doc.descendants(node => {
        if (NOTE_NAMES.includes(node.type.name)) {
            out.push([node.type.name, node.attrs.literal as string | null]);
        }
    });
    return out;
}

/** How each top-level block of `src` is classified. */
function kinds(src: string): [string, string][] {
    const md = hostEngine();
    return groupSourceBlocks(md.parse(src, {}), splitLines(src), definitionOf(md)).blocks.map(b => [b.kind, b.reason]);
}

/** `src` written untouched, and with each top-level block written by rule (`touched`). */
function writes(src: string): { untouched: string; touched: string[] } {
    const { doc } = parsed(src);
    return { untouched: write(doc), touched: topChildren(doc).map((block, i) => write(replaceChild(doc, i, touched(block)))) };
}

function assertIdentical(src: string): void {
    assert.ok(kinds(src).every(([kind]) => kind === 'editable'), `${JSON.stringify(src)} opens as rich text: ${JSON.stringify(kinds(src))}`);
    const out = writes(src);
    assert.strictEqual(out.untouched, src, 'untouched');
    out.touched.forEach((text, i) => assert.strictEqual(text, src, `block ${i} written by rule`));
}

suite('Editor note attributes: a {…} glued to a note\'s closing marker is the note\'s', () => {
    test('Daniel\'s line opens as rich text, the literal on the marginal note, written back byte for byte untouched and rewritten', () => {
        // Fail-first: before #15 the paragraph was a source block, "attributes on marginal_note_open".
        for (const src of [`Tempo ${TEMPO}\n`, `3. ${TEMPO}\n   - Schneller\n`]) {
            assert.deepStrictEqual(kinds(src).map(([kind]) => kind), ['editable'], src);
            assert.deepStrictEqual(notesOf(parsed(src).doc), [['marginal_note', '{.tipp}']], src);
            assertIdentical(src);
        }
    });

    test('a rewrite never escapes the note\'s own literal, with braces of the text beside it (ownedLiterals counts the note\'s opener)', () => {
        // Proven by reverting once (2026-10-23): with the opener counted after its `+1`, the rewrite wrote
        // `!!\{.tipp\}` and `$03:00$\{class=living\}` — the escape pass runs only where the text holds a `}`.
        assertIdentical(`Tempo ${TEMPO} (Mengen: {a, b})\n`);
        assertIdentical('## Zeit $03:00${class=living} und } hier\n');
        assertIdentical(`- Punkt ${TEMPO} mit } im Text\n`);
    });

    const rows: [string, [string, string | null][]][] = [
        ['a ++r|b++{.x}\n', [['sidenote', '{.x}']]],
        ['a !!r|b!!{.x}\n', [['marginal_note', '{.x}']]],
        ['a $t${.x}\n', [['left_sidebar', '{.x}']]],
        ['a @t@{.x}\n', [['right_sidebar', '{.x}']]],
        ['a ++r|b++{.x} {.p}\n', [['sidenote', '{.x}']]],
        ['## Kopf @10:00@{.r} {.h}\n', [['right_sidebar', '{.r}']]],
        ['- item !!r|b!!{.x} {.i}\n', [['marginal_note', '{.x}']]],
        ['a ++r|b `c`{.k}++{.x}\n', [['sidenote', '{.x}']]],
        ['x !!r|a!\\\nb!!{.tipp}!\n', [['marginal_note', '{.tipp}']]],
        ['x $a${.l}5\n', [['left_sidebar', '{.l}']]],
        ['x @a@{.r}b\n', [['right_sidebar', '{.r}']]],
        ['| a       | b |\n| ------- | - |\n| @x@{.r} | y |\n', [['right_sidebar', '{.r}']]],
        ['x ++r|b++{data-sn=9}\n', [['sidenote', '{data-sn=9}']]],
        ['x !!r|a!!{.x!!} y !!c|d!!\n', [['marginal_note', '{.x!!}'], ['marginal_note', null]]],
        ['## $20:04$ Lied @Daniel Fahsig@ $03:00${class=living}\n', [['left_sidebar', null], ['right_sidebar', null], ['left_sidebar', '{class=living}']]],
    ];
    for (const [src, notes] of rows) {
        test(`${JSON.stringify(src)} keeps each literal where the engine reads it, byte for byte`, () => {
            assert.deepStrictEqual(notesOf(parsed(src).doc), notes);
            assertIdentical(src);
        });
    }

    test('the block\'s own literal after a space stays the block\'s', () => {
        const [paragraph] = topChildren(parsed('a ++r|b++{.x} {.p}\n').doc);
        assert.strictEqual(paragraph.attrs.attrsSuffix, '{.p}');
        const [heading] = topChildren(parsed('## Kopf @10:00@{.r} {.h}\n').doc);
        assert.strictEqual(heading.attrs.attrsSuffix, '{.h}');
    });

    test('a hard break in a note\'s body is written as the editor writes every one; the literal stays glued', () => {
        // `!  ` + newline is written `!\` + newline by rule, with or without a literal: the same diff.
        const src = 'x !!r|a!  \nb!!{.tipp}!\n';
        assert.strictEqual(writes(src).untouched, src);
        assert.strictEqual(writes(src).touched[0], 'x !!r|a!\\\nb!!{.tipp}!\n');
        assert.strictEqual(writes('x !!r|a!  \nb!!!\n').touched[0], 'x !!r|a!\\\nb!!!\n');
    });

    test('two literals the engine merged open as rich text; written untouched as read, rewritten in the normalized form', () => {
        const src = 'a !!r|b!!{.x}{.y}\n';
        assert.deepStrictEqual(kinds(src).map(([kind]) => kind), ['editable']);
        assert.deepStrictEqual(notesOf(parsed(src).doc), [['marginal_note', '{.x .y}']]);
        assert.strictEqual(writes(src).untouched, src);
        assert.strictEqual(writes(src).touched[0], 'a !!r|b!!{.x .y}\n');
    });

    test('a rewrapped paragraph never breaks between the closing marker and its literal; it reads back on the note', () => {
        const md = hostEngine();
        for (let n = 0; n < 24; n++) {
            const words = Array.from({ length: 30 }, (_, i) => `wort${i}`).join(' ') + 'x'.repeat(n);
            const src = `${words} !!Tempo|nicht zu abrupt ändern, nicht zu schnell, ganz ruhig bleiben bitte!!{.tipp}\n`;
            assert.ok(src.length > 200);
            const { doc } = parseDocument(md, src, {});
            const paragraph = topChildren(doc)[0];
            const narrow = paragraph.type.create({ ...paragraph.attrs, src: null, wrapWidth: 40 + n, lineWidth: null }, paragraph.content);
            const out = write(replaceChild(doc, 0, narrow));
            assert.ok(out.split('\n').length > 3, out);
            assert.ok(out.includes('!!{.tipp}') && !/(^|\n)\{/.test(out), out);
            const back = parseDocument(md, out, {});
            assert.deepStrictEqual(notesOf(back.doc), [['marginal_note', '{.tipp}']], out);
            assert.strictEqual(topChildren(back.doc)[0].attrs.attrsSuffix, null, out);
        }
    });

    test('a note and a sidebar with a literal are drawn with the plugin\'s class first, then the literal\'s', () => {
        const draw = (node: Node) => (editorSchema.nodes[node.type.name].spec.toDOM as (n: Node) => [string, Record<string, string>])(node)[1];
        const [mn, rs] = [['marginal_note', TEMPO], ['right_sidebar', '@x@{#a .r k=v}']].map(([name, src]) => {
            let found: Node | null = null;
            parsed(`t ${src}\n`).doc.descendants(n => {
                found = found ?? (n.type.name === name ? n : null);
            });
            return found as unknown as Node;
        });
        assert.deepStrictEqual(draw(mn), { class: 'mn-ref tipp', 'data-mep-attrs': '{.tipp}' });
        assert.deepStrictEqual(draw(rs), { id: 'a', class: 'right-sidebar r', k: 'v', 'data-mep-attrs': '{#a .r k=v}' });
        const bare = editorSchema.nodes.marginal_note.spec.toDOM as (n: Node) => [string, Record<string, string>];
        assert.deepStrictEqual(bare(topChildren(parsed('t !!a|b!!\n').doc)[0].child(1))[1], { class: 'mn-ref' });
    });

    test('Convert keeps the literal; removing the note takes it with the note', () => {
        const { doc } = parsed(`Tempo ${TEMPO}\n`);
        const state = EditorState.create({ doc, plugins: editorPlugins() });
        const at = 1 + 'Tempo '.length;
        const converted = state.apply(convertNoteTransaction(state, at) as NonNullable<ReturnType<typeof convertNoteTransaction>>);
        assert.deepStrictEqual(notesOf(converted.doc), [['sidenote', '{.tipp}']]);
        assert.strictEqual(write(converted.doc), 'Tempo ++Tempo|nicht zu abrupt ändern, nicht zu schnell++{.tipp}\n');
        const inside = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at + 3)));
        let next = inside;
        assert.ok(unwrapNote('marginal_note')(inside, tr => {
            next = next.apply(tr);
        }));
        assert.deepStrictEqual(notesOf(next.doc), []);
        assert.ok(!write(next.doc).includes('{.tipp}'), write(next.doc));
    });
});

function stateOf(src: string): EditorState {
    return EditorState.create({ doc: parsed(src).doc, plugins: editorPlugins() });
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

function select(state: EditorState, from: number, to = from): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function noteAt(state: EditorState, name = 'marginal_note'): { pos: number; node: Node } {
    let found: { pos: number; node: Node } | null = null;
    state.doc.descendants((node, pos) => {
        found = found ?? (node.type.name === name ? { pos, node } : null);
        return found === null;
    });
    assert.ok(found !== null, `no ${name}`);
    return found;
}

suite('Editor note attributes: the note is the holder at a caret or a selection in it', () => {
    const src = `- Punkt ${TEMPO} {.i}\n`;

    test('a caret in the reference or the body, a selection in the body or across both, and a selected note all name the note', () => {
        const state = stateOf(src);
        const note = noteAt(state);
        const places: [string, EditorState][] = [
            ['caret in the reference', select(state, posOf(state.doc, 'Tempo', 2))],
            ['caret in the body', select(state, posOf(state.doc, 'abrupt', 1))],
            ['selection in the body', select(state, posOf(state.doc, 'abrupt'), posOf(state.doc, 'abrupt', 6))],
            ['selection across reference and body', select(state, posOf(state.doc, 'Tempo', 1), posOf(state.doc, 'nicht', 3))],
            ['the note selected', state.apply(state.tr.setSelection(NodeSelection.create(state.doc, note.pos)))],
        ];
        for (const [what, at] of places) {
            const inline = attributeHolderAt(at).inline;
            assert.strictEqual(inline?.object.kind, 'note', what);
            assert.strictEqual(inline?.object.from, note.pos, what);
            assert.strictEqual(inline?.holder.label, 'Marginal note', what);
            assert.strictEqual(objectAtSelection(at)?.kind, 'note', `${what}: the bar shows the note`);
        }
        assert.strictEqual(attributeHolderAt(select(state, posOf(state.doc, 'Punkt', 1))).inline, null, 'outside the note');
        assert.strictEqual(attributeHolderAt(select(state, posOf(state.doc, 'Punkt', 1), posOf(state.doc, 'abrupt'))).inline, null, 'from outside into it');
    });

    test('code with a literal inside a note wins over the note, as inside a link', () => {
        const state = stateOf('a !!r|b `c`{.k} d!!{.tipp}\n');
        const inline = attributeHolderAt(select(state, posOf(state.doc, 'c') + 1)).inline;
        assert.strictEqual(inline?.holder.label, 'Code');
        assert.strictEqual(attributeHolderAt(select(state, posOf(state.doc, ' d', 1))).inline?.holder.label, 'Marginal note');
    });

    test('the breadcrumb: List item {.i} › Marginal note {.tipp}; Heading {.h} › Right sidebar {.r}; a bare note alone', () => {
        const item = crumbsAt(select(stateOf(src), posOf(stateOf(src).doc, 'abrupt', 1)));
        assert.deepStrictEqual([item?.current.name, item?.current.literal, item?.outer?.name, item?.outer?.literal],
            ['Marginal note', '{.tipp}', 'List item', '{.i}']);
        const heading = stateOf('## Kopf @10:00@{.r} {.h}\n');
        const crumbs = crumbsAt(select(heading, posOf(heading.doc, '10:00', 2)));
        assert.deepStrictEqual([crumbs?.current.name, crumbs?.current.literal, crumbs?.outer?.name, crumbs?.outer?.literal],
            ['Right sidebar', '{.r}', 'Heading', '{.h}']);
        const bare = stateOf('Text !!r|b!! more.\n');
        const alone = crumbsAt(select(bare, posOf(bare.doc, 'b', 0) + 1));
        assert.deepStrictEqual([alone?.current.name, alone?.current.literal, alone?.outer ?? null], ['Marginal note', null, null]);
    });

    test('the field opens at the reference, never at the body in the margin; a sidebar at itself', () => {
        const state = stateOf(src);
        const note = noteAt(state);
        const ref = noteFieldRange({ from: note.pos, to: note.pos + note.node.nodeSize, node: note.node });
        assert.deepStrictEqual(ref, { from: note.pos + 1, to: note.pos + 1 + note.node.child(0).nodeSize });
        assert.strictEqual(state.doc.textBetween(ref.from, ref.to), 'Tempo');
        const item = crumbsAt(select(state, posOf(state.doc, 'abrupt', 1)));
        assert.deepStrictEqual([item?.current.from, item?.current.to], [ref.from, ref.to]);
        const sidebar = stateOf('x @a@{.r} y\n');
        const s = noteAt(sidebar, 'right_sidebar');
        assert.deepStrictEqual(noteFieldRange({ from: s.pos, to: s.pos + s.node.nodeSize, node: s.node }), { from: s.pos, to: s.pos + s.node.nodeSize });
    });
});

suite('Editor note attributes: setting and removing a note\'s literal', () => {
    function noteObject(state: EditorState, name = 'marginal_note'): LiteralObject {
        const note = noteAt(state, name);
        return { kind: 'note', from: note.pos, to: note.pos + note.node.nodeSize, node: note.node };
    }

    test('one step sets it, written glued to the marker; the re-parse gives the same literal; undo is one step', () => {
        const state = stateOf(`Tempo ${TEMPO}\n`);
        const tr = changeInlineLiteralTransaction(state, noteObject(state), '{.tipp .x}');
        assert.ok(tr !== null);
        assert.strictEqual(tr.steps.length, 1);
        const next = state.apply(tr);
        const out = write(next.doc);
        assert.strictEqual(out, 'Tempo !!Tempo|nicht zu abrupt ändern, nicht zu schnell!!{.tipp .x}\n');
        assert.deepStrictEqual(notesOf(parsed(out).doc), [['marginal_note', '{.tipp .x}']]);
        const removed = state.apply(changeInlineLiteralTransaction(state, noteObject(state), '') as NonNullable<ReturnType<typeof changeInlineLiteralTransaction>>);
        assert.strictEqual(write(removed.doc), 'Tempo !!Tempo|nicht zu abrupt ändern, nicht zu schnell!!\n');
    });

    test('a literal holding a note marker the engine still reads is set: {.x!!}', () => {
        const state = stateOf('x !!r|a!! y !!c|d!!\n');
        assert.strictEqual(changeInlineLiteralRefusal(state, noteObject(state), '{.x!!}'), null);
        const next = state.apply(changeInlineLiteralTransaction(state, noteObject(state), '{.x!!}') as NonNullable<ReturnType<typeof changeInlineLiteralTransaction>>);
        assert.deepStrictEqual(notesOf(parsed(write(next.doc)).doc), [['marginal_note', '{.x!!}'], ['marginal_note', null]]);
    });

    test('R2: one that would pair with a later sidebar is refused, naming the marker', () => {
        const state = stateOf('x @a@ and @b@\n');
        const refusal = changeInlineLiteralRefusal(state, noteObject(state, 'right_sidebar'), '{data-x="@"}');
        assert.ok(refusal !== null);
        assert.strictEqual(saidText(refusal), saidText(noteLiteralMarkerRefusal('right sidebar', '@')));
        assert.strictEqual(changeInlineLiteralTransaction(state, noteObject(state, 'right_sidebar'), '{data-x="@"}'), null);
    });

    test('R4: removing a left sidebar\'s literal that keeps it apart from a digit is refused', () => {
        const state = stateOf('x $a${.l}5\n');
        const refusal = changeInlineLiteralRefusal(state, noteObject(state, 'left_sidebar'), '');
        assert.ok(refusal !== null);
        assert.strictEqual(saidText(refusal), noteLiteralRemoveGlued('left sidebar'));
        assert.strictEqual(changeInlineLiteralTransaction(state, noteObject(state, 'left_sidebar'), ''), null);
        // With a space after it, the removal goes through.
        const spaced = stateOf('x $a${.l} 5\n');
        assert.strictEqual(changeInlineLiteralRefusal(spaced, noteObject(spaced, 'left_sidebar'), ''), null);
    });
});
