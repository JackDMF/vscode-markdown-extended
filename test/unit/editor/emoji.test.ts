import * as assert from 'assert';
import { Fragment, Node, Slice } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { undo } from 'prosemirror-history';
import { EDITABLE_TOP_NODES, ParsedDocument, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { createPositionMap } from '../../../src/editor/positions';
import { EMOJI_AFTER_BREAK_REFUSAL, EMOJI_LINK_REFUSAL, EMOJI_RAW_REFUSAL, unwritableEmoji } from '../../../src/editor/serialize';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { noteRefusal } from '../../../src/editor/webview/notes';
import { inlineForNote } from '../../../src/editor/webview/wikiEmbeds';
import { emojiAsTextNotice, emojiAsTextTransaction } from '../../../src/editor/webview/emoji';
import { objectOfNode } from '../../../src/editor/webview/objects';
import { emojiVerbs } from '../../../src/editor/webview/objectToolbar';
import { hostEngine, topChildren, touched } from './helpers';

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

    test('an atom made code, superscript or subscript, put in a bare link, or right after a line break is refused, with its reason', () => {
        const state = stateOf('a :) b\n');
        const at = atomAt(state);
        for (const mark of [schema.marks.code, schema.marks.sup, schema.marks.sub]) {
            const tr = state.tr.addMark(at, at + 1, mark.create());
            assert.strictEqual(noteRefusal(tr), EMOJI_RAW_REFUSAL, mark.name);
            assert.strictEqual(state.apply(tr).doc, state.doc, `${mark.name}: refused`);
        }
        const link = state.tr.addMark(at, at + 1, schema.marks.link.create({ href: 'http://e.com', markup: 'linkify' }));
        assert.strictEqual(noteRefusal(link), EMOJI_LINK_REFUSAL);
        const broken = state.tr.insert(at, schema.nodes.hard_break.create());
        assert.strictEqual(noteRefusal(broken), EMOJI_AFTER_BREAK_REFUSAL);
        assert.strictEqual(state.apply(broken).doc, state.doc, 'a break before it is refused');
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
