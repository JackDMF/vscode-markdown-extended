import * as assert from 'assert';
import { DOMSerializer, Fragment, Node, Slice } from 'prosemirror-model';
import { EditorState, TextSelection, Transaction } from 'prosemirror-state';
import { undo } from 'prosemirror-history';
import { EDITABLE_TOP_NODES, ParsedDocument, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { createPositionMap } from '../../../src/editor/positions';
import { EMOJI_RAW_REFUSAL, onUnreadEmojiSaved, unwritableEmoji } from '../../../src/editor/serialize';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { notePasteTransaction, noteRefusal } from '../../../src/editor/webview/notes';
import { inlineForNote, wikiEmbedPastePlugin } from '../../../src/editor/webview/wikiEmbeds';
import { EMOJI_TEXT_STILL_READ, emojiAsTextNotice, emojiAsTextTransaction } from '../../../src/editor/webview/emoji';
import { objectOfNode } from '../../../src/editor/webview/objects';
import { emojiVerbs } from '../../../src/editor/webview/objectToolbar';
import { hostEngine, topChildren, touched } from './helpers';
import { FakeNode, fakeDocument } from './fakeDom';

const schema = editorSchema;

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function allTouched(parsed: ParsedDocument): ParsedDocument {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return { ...parsed, doc: parsed.doc.type.create(null, children) };
}

/** Each emoji atom of `doc`, in order: its spelling, name and glyph. */
function emojiOf(doc: Node): [string, string, string][] {
    const found: [string, string, string][] = [];
    doc.descendants(n => {
        if (n.type.name === 'emoji') {
            found.push([n.attrs.source as string, n.attrs.name as string, n.attrs.glyph as string]);
        }
    });
    return found;
}

/** The node types of `doc`, nested ones included, but text: its structure. */
function structureOf(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants(n => {
        if (!n.isText && n.type.name !== 'emoji') {
            out.push(n.type.name);
        }
    });
    return out;
}

/** Every place the plan names an emoji as raw today, with `:)` in it. */
const CONTEXTS: string[] = [
    'Hello :) there\n',
    '# Title :) here\n',
    '- item :) here\n',
    '> quoted :) here\n',
    // In the tidy form a changed table is written in, padded by the spelling's width.
    '| a    | b |\n| ---- | - |\n| x :) | y |\n',
    '[see :) here](http://e.com/)\n',
    'a ++ref :)|note body++ b\n',
    'a ++ref|note :) body++ b\n',
    'a !!ref|note :) body!! b\n',
    'a $x :) y$ b\n',
    'a @x :) y@ b\n',
    'a ==x :) y== b\n',
    'a [[Ctrl :)]] b\n',
    'a **x :) y** b\n',
    'a [x :)]{.c} b\n',
    '::: warning\nx :) y\n:::\n',
    '!!! note\n    x :) y\n',
];

suite('Editor: an emoji the file holds is an atom carrying its spelling', () => {
    const md = hostEngine();
    const serialize = (parsed: ParsedDocument) => serializeDocument(parsed, { defaultWrap: 90 });

    test('in every context the host reads one, the block is editable, as it is with a word there, and holds one atom', () => {
        for (const source of CONTEXTS) {
            const parsed = parseDocument(md, source);
            assert.deepStrictEqual(emojiOf(parsed.doc), [[':)', 'smiley', '😃']], source);
            assert.deepStrictEqual(structureOf(parsed.doc), structureOf(parseDocument(md, source.replace(':)', 'xy')).doc), source);
            assert.ok(!structureOf(parsed.doc).includes('raw_block'), source);
        }
        assert.deepStrictEqual(emojiOf(parseDocument(md, 'a :smile::+1: <3 :-) b\n').doc), [
            [':smile:', 'smile', '😄'], [':+1:', '+1', '👍'], ['<3', 'heart', '❤️'], [':-)', 'smiley', '😃'],
        ]);
    });

    test('an untouched block is written as it was read, byte for byte; a touched one writes each atom as spelled', () => {
        for (const source of [...CONTEXTS, 'a :smile::+1: <3 :-) b\n', '5\\$:)\n', 'x :) :) :) y\n', ':):-)\n', 'a :):smile: b\n']) {
            const parsed = parseDocument(md, source);
            assert.strictEqual(serialize(parsed), source, `untouched: ${source}`);
            const first = serialize(allTouched(parsed));
            assert.strictEqual(first, source, `rewritten: ${source}`);
            assert.strictEqual(serialize(allTouched(parseDocument(md, first))), source, `rewritten twice: ${source}`);
        }
    });

    test('under superscript or subscript an emoji stays a source block, saying why', () => {
        for (const source of ['a ^b :) c^ d\n', 'a ~b :) c~ d\n']) {
            const grouped = groupSourceBlocks(md.parse(source, {}), splitLines(source), definitionOf(md)).blocks;
            assert.deepStrictEqual(grouped.map(b => [b.kind, b.reason]), [['raw', 'emoji inside sup/sub']], source);
        }
    });

    test('an emoji whose spelling the host could not tell stays a source block, saying why', () => {
        const source = 'Hello :) there\n';
        const tokens = md.parse(source, {});
        for (const child of tokens.flatMap(t => t.children ?? [])) {
            if (child.type === 'emoji') {
                child.meta = { source: null };
            }
        }
        const grouped = groupSourceBlocks(tokens, splitLines(source), definitionOf(md)).blocks;
        assert.deepStrictEqual(grouped.map(b => [b.kind, b.reason]), [['raw', 'emoji without its spelling']]);
    });

    test('the atom\'s text is its glyph, and it is drawn as a span carrying its spelling and name', () => {
        const atom = schema.nodes.emoji.create({ source: ':-)', name: 'smiley', glyph: '😃' });
        const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [schema.text('a '), atom, schema.text(' b')])]);
        assert.strictEqual(doc.textContent, 'a 😃 b');
        assert.strictEqual(doc.textBetween(0, doc.content.size), 'a 😃 b');
        assert.deepStrictEqual(schema.nodes.emoji.spec.toDOM?.(atom), ['span', { class: 'mep-emoji', 'data-mep-emoji': ':-)', 'data-mep-emoji-name': 'smiley', title: 'Emoji :-) — kept as written' }, '😃']);
        const rule = schema.nodes.emoji.spec.parseDOM?.[0] as { tag: string; getAttrs: (dom: unknown) => unknown };
        assert.strictEqual(rule.tag, 'span[data-mep-emoji]');
        const attrs: Record<string, string> = { 'data-mep-emoji': ':-)', 'data-mep-emoji-name': 'smiley' };
        assert.deepStrictEqual(rule.getAttrs({ getAttribute: (name: string) => attrs[name] ?? null, textContent: '😃' }), { source: ':-)', name: 'smiley', glyph: '😃' });
    });

    test('positions: the position before an emoji is its spelling\'s start, the one after it its end', () => {
        for (const [source, expected] of [
            ['ab :) cd\n', [[3, 5]]],
            [':smile: b\n', [[0, 7]]],
            ['# t :-)\n', [[4, 7]]],
            ['- :):-)\n', [[2, 4], [4, 7]]],
            ['A ++ref|x :) b++ c\n', [[10, 12]]],
        ] as const) {
            for (const parsed of [parseDocument(md, source), allTouched(parseDocument(md, source))]) {
                const map = createPositionMap(parsed, { defaultWrap: 90 });
                const found: [number, number][] = [];
                parsed.doc.descendants((n, p) => {
                    if (n.type.name === 'emoji') {
                        const before = map.sourcePositionOf(p);
                        const after = map.sourcePositionOf(p + 1);
                        assert.ok(before && after && !before.approximate && !after.approximate, source);
                        found.push([before.character, after.character]);
                        assert.deepStrictEqual(map.pagePositionOf({ line: 0, character: after.character }), { pos: p + 1, approximate: false }, source);
                    }
                });
                assert.deepStrictEqual(found, expected, source);
            }
        }
    });
});

suite('Editor: an emoji atom that an edit makes unreadable becomes text at once', () => {
    const md = hostEngine();
    const save = (state: EditorState) => serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
    const stateOf = (source: string) => EditorState.create({ doc: parseDocument(md, source).doc, plugins: editorPlugins() });
    const atomsIn = (state: EditorState) => emojiOf(state.doc).map(([source]) => source);
    const atomAt = (state: EditorState) => {
        let at = -1;
        state.doc.descendants((n, pos) => {
            at = at < 0 && n.type.name === 'emoji' ? pos : at;
        });
        return at;
    };
    const hostEmoji = (markdown: string) => md.parse(markdown, {}).flatMap(t => t.children ?? []).filter(t => t.type === 'emoji').length;

    test('a letter typed right after it: the page shows its spelling as text, the file holds that text, in one undo step', () => {
        const state = stateOf('hi :)\n');
        const at = atomAt(state);
        // Typed with the caret right after the glyph.
        const caret = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at + 1)));
        const typed = caret.apply(caret.tr.insertText('Z'));
        assert.deepStrictEqual(atomsIn(typed), []);
        assert.strictEqual(typed.doc.textContent, 'hi :)Z');
        assert.strictEqual(save(typed), 'hi :)Z\n');
        assert.strictEqual(hostEmoji(save(typed)), 0);
        // The caret is still after the Z.
        assert.strictEqual(typed.doc.textBetween(0, typed.selection.from), 'hi :)Z');
        let undone: EditorState | undefined;
        undo(typed, tr => { undone = typed.apply(tr); });
        assert.deepStrictEqual(atomsIn(undone as EditorState), [':)'], 'one undo gives the atom back');
        assert.strictEqual(save(undone as EditorState), 'hi :)\n');
        // The Z deleted again: the text stays text, typed text, which the save escapes.
        const end = typed.selection.from;
        const deleted = typed.apply(typed.tr.delete(end - 1, end));
        assert.deepStrictEqual(atomsIn(deleted), []);
        assert.strictEqual(deleted.doc.textContent, 'hi :)');
        assert.strictEqual(save(deleted), 'hi \\:)\n');
        assert.strictEqual(hostEmoji(save(deleted)), 0);
    });

    test('the text before >:( deleted at the block start: the page makes it text, the file no quote', () => {
        const state = stateOf('x >:(\n');
        const at = atomAt(state);
        const deleted = state.apply(state.tr.delete(1, at));
        assert.deepStrictEqual(atomsIn(deleted), []);
        assert.strictEqual(deleted.doc.textContent, '>:(');
        assert.strictEqual(save(deleted), '\\>\\:(\n');
        assert.deepStrictEqual(topChildren(parseDocument(md, save(deleted)).doc).map(n => n.type.name), ['paragraph']);
    });

    test('an edit that leaves it readable keeps the atom, and an edit elsewhere leaves it be', () => {
        const state = stateOf('hi :) there\n\nother\n');
        const spaced = state.apply(state.tr.insertText(' and', atomAt(state) + 1));
        assert.deepStrictEqual(atomsIn(spaced), [':)']);
        assert.strictEqual(save(spaced), 'hi :) and there\n\nother\n');
        const elsewhere = state.apply(state.tr.insertText('!', state.doc.content.size - 1));
        assert.deepStrictEqual(atomsIn(elsewhere), [':)']);
    });

    test('adjacent atoms: only the one the edit makes unreadable turns to text', () => {
        const state = stateOf('a :):) b\n');
        let last = -1;
        state.doc.descendants((n, pos) => {
            last = n.type.name === 'emoji' ? pos : last;
        });
        const typed = state.apply(state.tr.insertText('Z', last + 1));
        assert.deepStrictEqual(atomsIn(typed), [':)']);
        assert.strictEqual(save(typed), 'a :):)Z b\n');
        assert.strictEqual(hostEmoji(save(typed)), 1);
    });

    test('an atom made code, superscript or subscript is refused, with its reason', () => {
        const state = stateOf('a :) b\n');
        const at = atomAt(state);
        for (const mark of [schema.marks.code, schema.marks.sup, schema.marks.sub]) {
            const tr = state.tr.addMark(at, at + 1, mark.create());
            assert.strictEqual(noteRefusal(tr), EMOJI_RAW_REFUSAL, mark.name);
            assert.strictEqual(state.apply(tr).doc, state.doc, `${mark.name}: refused`);
        }
        assert.strictEqual(unwritableEmoji(state.doc), null);
        assert.strictEqual(noteRefusal(state.tr.addMark(at, at + 1, schema.marks.strong.create())), null, 'bold is let through');
    });

    test('a paste into a note keeps an emoji atom an atom; under a raw mark it is its spelling', () => {
        const atom = schema.nodes.emoji.create({ source: ':)', name: 'smiley', glyph: '😃' });
        const slice = new Slice(Fragment.from(schema.nodes.paragraph.create(null, [schema.text('a '), atom])), 1, 1);
        assert.deepStrictEqual(inlineForNote(slice, []).map(n => (n.isText ? n.text : n.type.name)), ['a ', 'emoji']);
        assert.deepStrictEqual(inlineForNote(slice, [schema.marks.code.create()]).map(n => (n.isText ? n.text : n.type.name)), ['a ', ':)']);
    });
});

suite('Editor: an emoji atom on the page — its look, its bar and its verbs', () => {
    const md = hostEngine();
    const save = (state: EditorState) => serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
    const stateOf = (source: string) => EditorState.create({ doc: parseDocument(md, source).doc, plugins: editorPlugins() });
    const atomAt = (state: EditorState) => {
        let at = -1;
        state.doc.descendants((n, pos) => {
            at = at < 0 && n.type.name === 'emoji' ? pos : at;
        });
        return at;
    };

    test('drawn as its glyph with a tooltip naming its spelling', () => {
        const atom = schema.nodes.emoji.create({ source: ':)', name: 'smiley', glyph: '😃' });
        const [, attrs] = schema.nodes.emoji.spec.toDOM?.(atom) as [string, Record<string, string>, string];
        assert.strictEqual(attrs.title, 'Emoji :) — kept as written');
    });

    test('it is an object of its own, whose bar offers Edit as text and Remove emoji', () => {
        const state = stateOf('a *:)* b\n');
        const at = atomAt(state);
        const object = objectOfNode(state.doc.nodeAt(at) as Node, at);
        assert.ok(object !== null && object.kind === 'emoji');
        const verbs = emojiVerbs(state, object, { asText: () => undefined, remove: () => undefined });
        assert.deepStrictEqual(verbs.map(v => [v.id, v.label, v.refusal]), [['edit-emoji-as-text', 'Edit as text', null], ['remove-emoji', 'Remove emoji', null]]);
    });

    test('Edit as text: its spelling as text with its marks and the caret after it, saved escaped, undone as one step', () => {
        const state = stateOf('a *:)* b\n');
        const at = atomAt(state);
        const tr = emojiAsTextTransaction(state, at, at + 1);
        assert.ok(tr !== null);
        const asText = state.apply(tr);
        assert.strictEqual(atomAt(asText), -1);
        assert.strictEqual(asText.doc.textBetween(0, asText.selection.from), 'a :)');
        assert.ok(asText.doc.nodeAt(at)?.marks.some(m => m.type.name === 'em'), 'it keeps the emphasis');
        assert.strictEqual(save(asText), 'a *\\:)* b\n');
        let undone: EditorState | undefined;
        undo(asText, t => { undone = asText.apply(t); });
        assert.strictEqual(atomAt(undone as EditorState), at);
        assert.strictEqual(emojiAsTextTransaction(state, 1, 2), null, 'a text position is no emoji');
    });

    test('an edit that makes an atom text says so once, naming what the page now shows', () => {
        const state = stateOf('hi :) there\n');
        const at = atomAt(state);
        const caret = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at + 1)));
        const typed = caret.apply(caret.tr.insertText('Z'));
        assert.deepStrictEqual(emojiAsTextNotice(typed), ':)Z is no longer an emoji');
        // The next edit, which makes none text, says nothing.
        const more = typed.apply(typed.tr.insertText('Y'));
        assert.strictEqual(emojiAsTextNotice(more), null);
        assert.strictEqual(emojiAsTextNotice(caret), null);
    });
});

suite('Editor: an atom is judged where it was written, not by its name', () => {
    const md = hostEngine();
    const save = (state: EditorState) => serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
    const stateOf = (source: string) => EditorState.create({ doc: parseDocument(md, source).doc, plugins: editorPlugins() });
    const atoms = (state: EditorState) => {
        const out: [number, string][] = [];
        state.doc.descendants((n, pos) => {
            if (n.type.name === 'emoji') {
                out.push([pos, n.attrs.source as string]);
            }
        });
        return out;
    };
    /** `source` with Q typed right after its atom `k`: the atoms the page keeps, and the file the save writes. */
    const typedAfter = (source: string, k: number) => {
        const state = stateOf(source);
        const typed = state.apply(state.tr.insertText('Q', atoms(state)[k][0] + 1));
        const saved = save(typed);
        // The page and the file agree: reopened, the saved file holds the page's atoms.
        assert.deepStrictEqual(atoms(stateOf(saved)).map(a => a[1]), atoms(typed).map(a => a[1]), `${source}: reopened ${saved}`);
        return { kept: atoms(typed).map(a => a[1]), saved };
    };

    test('Q typed after one of six equal atoms: only that one becomes text', () => {
        assert.deepStrictEqual(typedAfter('a :) :) :) :) :) :) b\n', 2), { kept: [':)', ':)', ':)', ':)', ':)'], saved: 'a :) :) :)Q :) :) :) b\n' });
    });

    test('Q typed after the first of two: the second stays an atom, written as it was', () => {
        assert.deepStrictEqual(typedAfter('x :) y :) z\n', 0), { kept: [':)'], saved: 'x :)Q y :) z\n' });
        assert.deepStrictEqual(typedAfter('x <3 y <3 z\n', 0), { kept: ['<3'], saved: 'x <3Q y <3 z\n' });
        assert.deepStrictEqual(typedAfter('# x :) y :) z\n', 0), { kept: [':)'], saved: '# x :)Q y :) z\n' });
        assert.deepStrictEqual(typedAfter('| :) a | :) b |\n| ---- | ---- |\n| c    | d    |\n', 0).kept, [':)']);
    });

    test('an emoji read elsewhere — in superscript, in another note — does not keep a broken atom an atom', () => {
        const state = stateOf('a ^b^ x :) y\n');
        let inSup = -1;
        state.doc.descendants((n, pos) => {
            inSup = inSup < 0 && n.isText && n.text === 'b' ? pos + 1 : inSup;
        });
        const typed = state.apply(state.tr.insertText(' :) ', inSup));
        const broken = typed.apply(typed.tr.insertText('Q', atoms(typed)[0][0] + 1));
        assert.deepStrictEqual(atoms(broken), []);
        assert.strictEqual(save(broken), 'a ^b \\:) ^ x :)Q y\n');
        assert.deepStrictEqual(typedAfter('a ++r|x :) y++ b ++s|z :) w++ c\n', 0), { kept: [':)'], saved: 'a ++r|x :)Q y++ b ++s|z :) w++ c\n' });
    });
});

suite('Editor: emoji atoms, review 1', () => {
    const md = hostEngine();
    const save = (state: EditorState) => serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
    const stateOf = (source: string) => EditorState.create({ doc: parseDocument(md, source).doc, plugins: editorPlugins() });
    const atoms = (state: EditorState) => {
        const out: [number, string][] = [];
        state.doc.descendants((n, pos) => {
            if (n.type.name === 'emoji') {
                out.push([pos, n.attrs.source as string]);
            }
        });
        return out;
    };
    const posOf = (state: EditorState, needle: string) => {
        let found = -1;
        state.doc.descendants((n, pos) => {
            if (found < 0 && n.isText && (n.text ?? '').includes(needle)) {
                found = pos + (n.text ?? '').indexOf(needle);
            }
        });
        assert.ok(found >= 0, `no ${needle}`);
        return found;
    };
    const atom = (source: string, name = 'smiley', ...marks: ReturnType<typeof schema.mark>[]) => schema.nodes.emoji.create({ source, name, glyph: '😃' }, null, marks);

    test('a paste into a note keeps an emoji atom of the editor\'s own copy', () => {
        const state = stateOf('x ++r|body++ y\n');
        const inBody = posOf(state, 'body') + 4;
        const at = state.apply(state.tr.setSelection(TextSelection.create(state.doc, inBody)));
        const slice = new Slice(Fragment.from(schema.nodes.paragraph.create(null, [schema.text('a '), atom(':)')])), 1, 1);
        const pasted = at.apply(notePasteTransaction(at, slice));
        assert.deepStrictEqual(atoms(pasted).map(a => a[1]), [':)']);
        assert.strictEqual(save(pasted), 'x ++r|bodya :)++ y\n');
    });

    test('Edit as text is refused where the text would still read as an emoji: inside a sidenote', () => {
        for (const [source, refused] of [['a ++r|x :) y++ b\n', true], ['a !!r|x :) y!! b\n', true], ['a $x :) y$ b\n', false], ['a :) b\n', false]] as const) {
            const state = stateOf(source);
            const [at] = atoms(state)[0];
            const object = objectOfNode(state.doc.nodeAt(at) as Node, at);
            assert.ok(object !== null);
            const [asText, remove] = emojiVerbs(state, object, { asText: () => undefined, remove: () => undefined });
            assert.strictEqual(asText.refusal, refused ? EMOJI_TEXT_STILL_READ : null, source);
            assert.strictEqual(remove.refusal, null, source);
        }
    });

    test('an atom right after a line break is no refusal: bold over it applies, and a >:( there becomes text, no quote', () => {
        const state = stateOf('a\\\n:) b\n');
        const [at] = atoms(state)[0];
        const bold = state.tr.addMark(at, at + 1, schema.marks.strong.create());
        assert.strictEqual(noteRefusal(bold), null);
        const applied = state.apply(bold);
        assert.deepStrictEqual(atoms(applied).map(a => a[1]), [':)']);
        // The paragraph keeps the width its lines were wrapped at.
        assert.strictEqual(save(applied), 'a\\\n**:)**\nb\n');
        assert.deepStrictEqual(emojiOf(parseDocument(md, save(applied)).doc).map(e => e[0]), [':)']);
        const quoteLike = stateOf('a\\\nx >:( b\n');
        const x = posOf(quoteLike, 'x ');
        const moved = quoteLike.apply(quoteLike.tr.delete(x, x + 2));
        assert.deepStrictEqual(atoms(moved), []);
        assert.strictEqual(save(moved), 'a\\\n\\>\\:( b\n');
        assert.deepStrictEqual(topChildren(parseDocument(md, save(moved)).doc).map(n => n.type.name), ['paragraph']);
    });

    test('an atom in a link read with linkify is written in the link\'s label, where it reads back', () => {
        const link = schema.marks.link.create({ href: 'http://e.com/', markup: 'linkify' });
        const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [schema.text('see '), schema.text('http://e.com/', [link]), atom(':)', 'smiley', link), schema.text(' y')])]);
        assert.strictEqual(unwritableEmoji(doc), null);
        const saved = serializeDocument({ doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
        assert.strictEqual(saved, 'see [http://e.com/:)](http://e.com/) y\n');
        assert.deepStrictEqual(emojiOf(parseDocument(md, saved).doc).map(e => e[0]), [':)']);
    });

    test('one edit in two blocks, the second holding a note: both atoms become text, and nothing is refused', () => {
        const state = stateOf('x :) y\n\nz :) w ++r|n++\n');
        const [[first], [second]] = atoms(state);
        const tr = state.tr.insertText('R', second + 1).insertText('Q', first + 1);
        assert.strictEqual(noteRefusal(tr), null);
        const typed = state.apply(tr);
        assert.deepStrictEqual(atoms(typed), []);
        assert.strictEqual(save(typed), 'x :)Q y\n\nz :)R w ++r|n++\n');
    });

    test('a pasted span with an empty spelling is no atom', () => {
        const rule = schema.nodes.emoji.spec.parseDOM?.[0] as { getAttrs: (dom: unknown) => unknown };
        const attrs: Record<string, string> = { 'data-mep-emoji': '', 'data-mep-emoji-name': 'smiley' };
        assert.strictEqual(rule.getAttrs({ getAttribute: (name: string) => attrs[name] ?? null, textContent: '😃' }), false);
    });

    test('the hint names the text as it now stands around each spelling made text, in document order, whole characters', () => {
        const typeAt = (source: string, edit: (state: EditorState) => Transaction) => {
            const state = stateOf(source);
            return emojiAsTextNotice(state.apply(edit(state)));
        };
        const undoing = '';
        assert.strictEqual(typeAt('x :) y\n', s => s.tr.insertText('5', atoms(s)[0][0])), `5:) is no longer an emoji${undoing}`);
        assert.strictEqual(typeAt('x :) y\n', s => s.tr.insertText('😀', atoms(s)[0][0] + 1)), `:)😀 is no longer an emoji${undoing}`);
        assert.strictEqual(typeAt('a :) b\n\nc :) d\n', s => {
            const [[first], [second]] = atoms(s);
            return s.tr.insertText('R', second + 1).insertText('Q', first + 1);
        }), `:)Q, :)R are no longer emoji${undoing}`);
    });

    test('the position map writes an atom that does not read back without the save\'s report', () => {
        const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [atom('>:(', 'angry'), schema.text(' x')])]);
        const seen: string[][] = [];
        onUnreadEmojiSaved(sources => seen.push([...sources]));
        try {
            createPositionMap({ doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
        } finally {
            onUnreadEmojiSaved(null);
        }
        assert.deepStrictEqual(seen, []);
    });

    test('a copy\'s HTML carries no editor tooltip on an emoji', () => {
        const props = wikiEmbedPastePlugin(() => true).props as unknown as { clipboardSerializer: DOMSerializer };
        const slice = Fragment.from(schema.nodes.paragraph.create(null, [schema.text('a '), atom(':)')]));
        const html = (props.clipboardSerializer.serializeFragment(slice, { document: fakeDocument as unknown as Document }) as unknown as FakeNode).html();
        assert.ok(html.includes('data-mep-emoji=":)"'), html);
        assert.ok(!html.includes('title='), html);
    });

});
