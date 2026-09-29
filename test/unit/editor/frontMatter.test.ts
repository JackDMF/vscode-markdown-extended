import * as assert from 'assert';
import { EditorState } from 'prosemirror-state';
import { fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import {
    addItem, addProperty, eolOf, joinFrontMatter, readProperties, removeItem, removeProperty, setBoolean, setText, splitFrontMatter,
} from '../../../src/editor/frontMatter';
import { editorSchema } from '../../../src/editor/schema';
import { insertPropertiesTransaction } from '../../../src/editor/webview/toolbar/commands';
import { conformanceDocument, hostEngine, readText, toCrlf } from './helpers';

/** A front matter holding what YAML lets an author write: comments, anchors, quoting, a block scalar, lists of both styles, a nested list of maps. */
const RICH = [
    '# The document\'s own properties.',
    'title: Hello world   # trailing comment',
    'empty:',
    'quoted: "a \\"b\\""',
    'single: \'it\'\'s\'',
    'date: 2026-09-29',
    'draft: True',
    'count: 3',
    'tags: [alpha, beta]',
    'people:',
    '  - Daniel',
    '  - Jack  # the second',
    '',
    'base: &base 1',
    'ref: *base',
    'summary: |',
    '  line one',
    '  line two',
    'uid: cc43a136-8c9f-4869-bbf1-ca74829d615e',
    'doc-id: 21b3cb02-2cd5-45fe-abc9-6648c4bb233c',
    'lang: en',
    'sections:',
    '  - heading: One',
    '    lang: de',
    '    edges:',
    '      - { type: concerns, to: X-1, note: \'a, b\' }',
    '  - heading: Two',
    'last: z',
    '',
].join('\n');

/** The lines of `after` that differ from `before`'s, as `[index, before, after]`; the two must have as many lines. */
function changedLines(before: string, after: string): [number, string, string][] {
    const a = before.split('\n');
    const b = after.split('\n');
    assert.strictEqual(b.length, a.length, 'the edit adds or removes no line');
    return a.flatMap((line, i) => (line === b[i] ? [] : [[i, line, b[i]] as [number, string, string]]));
}

suite('Front matter as properties: typing from the value', () => {
    test('each top-level key is one property, typed from its value, in the file\'s order', () => {
        const read = readProperties(RICH);
        assert.strictEqual(read.error, null);
        assert.deepStrictEqual(read.properties.map(p => [p.key, p.kind, p.text]), [
            ['title', 'text', 'Hello world'],
            ['empty', 'text', ''],
            ['quoted', 'text', 'a "b"'],
            ['single', 'text', 'it\'s'],
            ['date', 'date', '2026-09-29'],
            ['draft', 'boolean', 'true'],
            ['count', 'text', '3'],
            ['tags', 'list', 'alpha, beta'],
            ['people', 'list', 'Daniel, Jack'],
            ['base', 'text', '1'],
            ['ref', 'source', 'alias of base'],
            ['summary', 'source', 'multi-line text'],
            ['uid', 'id', 'cc43a136-8c9f-4869-bbf1-ca74829d615e'],
            ['doc-id', 'id', '21b3cb02-2cd5-45fe-abc9-6648c4bb233c'],
            ['lang', 'choice', 'en'],
            ['sections', 'source', '2 items, nested'],
            ['last', 'text', 'z'],
        ]);
    });

    test('a list keeps its style, and lang offers the values the file uses for it, the current one first', () => {
        const byKey = new Map(readProperties(RICH).properties.map(p => [p.key, p]));
        assert.strictEqual(byKey.get('tags')?.flow, true);
        assert.strictEqual(byKey.get('people')?.flow, false);
        assert.deepStrictEqual(byKey.get('people')?.items, ['Daniel', 'Jack']);
        assert.deepStrictEqual(byKey.get('lang')?.choices, ['en', 'de']);
    });

    test('an id key is read-only only for a UUID; uid always', () => {
        const read = readProperties('id: FRS-1\nuid: not-a-uuid\nrequirementId: 21b3cb02-2cd5-45fe-abc9-6648c4bb233c\nsaid: 21b3cb02-2cd5-45fe-abc9-6648c4bb233c\n');
        assert.deepStrictEqual(read.properties.map(p => p.kind), ['text', 'id', 'id', 'id']);
        // `said` ends in `id`: the rule is the key's ending and a UUID value, not a word list.
    });

    test('a date is only YYYY-MM-DD; a nested map is one source row; a sequence holding a map is nested too', () => {
        const read = readProperties('a: 2026-9-1\nb: 2026-09-01T10:00\nc: \'2026-09-01\'\nm:\n  x: 1\n  y: 2\ns: [a, {b: 1}]\n');
        assert.deepStrictEqual(read.properties.map(p => [p.kind, p.text]),
            [['text', '2026-9-1'], ['text', '2026-09-01T10:00'], ['date', '2026-09-01'], ['source', '2 items, nested'], ['source', '2 items, nested']]);
    });

    test('a YAML that does not parse, or is not a map, is said so and shown as no rows; an empty one has none', () => {
        assert.match(readProperties('a: [1\n').error ?? '', /does not parse/);
        assert.match(readProperties('a: 1\na: 2\n').error ?? '', /does not parse/);
        assert.strictEqual(readProperties('- a\n- b\n').error, 'The front matter is not a list of keys.');
        assert.deepStrictEqual(readProperties(''), { properties: [], error: null });
        assert.deepStrictEqual(readProperties('# only a comment\n'), { properties: [], error: null });
    });

    test('the fences are split off and joined back exactly, CRLF and an unclosed front matter included', () => {
        for (const src of ['---\na: 1\n---\n', '---\r\na: 1\r\n---\r\n', '---\n---\n', '---\na: 1\n---', '---\na: 1\n', '---  \na: 1\n...\n']) {
            assert.strictEqual(joinFrontMatter(splitFrontMatter(src)), src, JSON.stringify(src));
        }
        assert.deepStrictEqual(splitFrontMatter('---\r\na: 1\r\n---\r\n'), { open: '---\r\n', body: 'a: 1\r\n', close: '---\r\n' });
        assert.deepStrictEqual(splitFrontMatter('---\n---\n'), { open: '---\n', body: '', close: '---\n' });
        assert.deepStrictEqual(splitFrontMatter('---\na: 1\n'), { open: '---\n', body: 'a: 1\n', close: '' });
        assert.strictEqual(eolOf('---\r\n---\r\n'), '\r\n');
    });
});

suite('Front matter as properties: edits in place', () => {
    test('one flat scalar changed changes that line only — comments, anchors, block scalars, both list styles and nested maps byte for byte', () => {
        const after = setText(RICH, 'title', 'Goodbye') as string;
        assert.deepStrictEqual(changedLines(RICH, after), [[1, 'title: Hello world   # trailing comment', 'title: Goodbye   # trailing comment']]);
        assert.strictEqual(readProperties(after).properties[0].text, 'Goodbye');
    });

    test('every kind of value edited leaves every other line as it was', () => {
        const edits: [string, string | null, number][] = [
            ['empty', setText(RICH, 'empty', 'now'), 2],
            ['quoted', setText(RICH, 'quoted', 'x"y'), 3],
            ['single', setText(RICH, 'single', 'o\'k'), 4],
            ['date', setText(RICH, 'date', '2026-10-01'), 5],
            ['draft', setBoolean(RICH, 'draft', false), 6],
            ['count', setText(RICH, 'count', '4'), 7],
            ['tags', addItem(RICH, 'tags', 'gamma', '\n'), 8],
            ['base', setText(RICH, 'base', '2'), 13],
            ['lang', setText(RICH, 'lang', 'de'), 20],
        ];
        const expected: Record<string, string> = {
            empty: 'empty: now',
            quoted: 'quoted: "x\\"y"',
            single: 'single: \'o\'\'k\'',
            date: 'date: 2026-10-01',
            draft: 'draft: False',
            count: 'count: 4',
            tags: 'tags: [alpha, beta, gamma]',
            base: 'base: &base 2',
            lang: 'lang: de',
        };
        for (const [key, after, line] of edits) {
            assert.ok(after !== null, key);
            const changed = changedLines(RICH, after);
            assert.deepStrictEqual(changed.map(c => [c[0], c[2]]), [[line, expected[key]]], key);
            assert.strictEqual(readProperties(after).error, null, key);
        }
    });

    test('a value that would read back as something else is quoted: a plain string never turns into a boolean, a number, a comment or a map', () => {
        const cases: [string, string][] = [
            ['true', 'title: \'true\''],
            ['42', 'title: \'42\''],
            ['a # b', 'title: \'a # b\''],
            ['key: value', 'title: \'key: value\''],
            [' padded', 'title: \' padded\''],
            ['', 'title: \'\''],
        ];
        for (const [value, line] of cases) {
            const after = setText('title: x\n', 'title', value) as string;
            assert.strictEqual(after, `${line}\n`, value);
            assert.strictEqual(readProperties(after).properties[0].text, value, value);
        }
        // A number stays a number where it still is one, and is quoted where it is not.
        assert.strictEqual(setText('n: 1\n', 'n', '2.5'), 'n: 2.5\n');
        assert.strictEqual(setText('n: 1\n', 'n', 'two'), 'n: two\n');
    });

    test('a boolean keeps the case the file writes it in', () => {
        assert.strictEqual(setBoolean('a: true\n', 'a', false), 'a: false\n');
        assert.strictEqual(setBoolean('a: TRUE\n', 'a', false), 'a: FALSE\n');
        assert.strictEqual(setBoolean('a: False  # off\n', 'a', true), 'a: True  # off\n');
    });

    test('a list item goes in and out in the list\'s own style; the last item out leaves an empty flow list', () => {
        assert.strictEqual(addItem('t: [a, b]\n', 't', 'c', '\n'), 't: [a, b, c]\n');
        assert.strictEqual(addItem('t: [ a ]\n', 't', 'x, y', '\n'), 't: [ a, \'x, y\' ]\n');
        assert.strictEqual(addItem('t: []\n', 't', 'a', '\n'), 't: [a]\n');
        assert.strictEqual(removeItem('t: [a, \'b c\', d]\n', 't', 0, '\n'), 't: [\'b c\', d]\n');
        assert.strictEqual(removeItem('t: [a]\n', 't', 0, '\n'), 't: []\n');
        const block = 'p:\n  - a  # first\n  - b\nq: 1\n';
        assert.strictEqual(addItem(block, 'p', 'c', '\n'), 'p:\n  - a  # first\n  - b\n  - c\nq: 1\n');
        assert.strictEqual(removeItem(block, 'p', 0, '\n'), 'p:\n  - b\nq: 1\n');
        assert.strictEqual(removeItem('p:\n  - a\nq: 1\n', 'p', 0, '\n'), 'p: []\nq: 1\n');
        assert.strictEqual(addItem('p:\n- a\n', 'p', 'b', '\n'), 'p:\n- a\n- b\n');
    });

    test('a property goes in at the end, typed from what was typed, and out with its lines; nothing else moves', () => {
        assert.strictEqual(addProperty(RICH, 'status', 'draft', '\n'), `${RICH}status: draft\n`);
        assert.strictEqual(addProperty(RICH, 'tags2', '[x, y]', '\n'), `${RICH}tags2: [x, y]\n`);
        assert.strictEqual(addProperty(RICH, 'note', 'a: b', '\n'), `${RICH}note: 'a: b'\n`);
        assert.strictEqual(addProperty(RICH, 'blank', '', '\n'), `${RICH}blank:\n`);
        assert.strictEqual(addProperty(RICH, 'title', 'again', '\n'), null, 'a key that is there already is refused');
        assert.strictEqual(addProperty('a: 1', 'b', '2', '\n'), 'a: 1\nb: 2\n');
        assert.strictEqual(addProperty('', 'a', '1', '\n'), 'a: 1\n');
        const lines = RICH.split('\n');
        const without = (from: number, to: number) => [...lines.slice(0, from), ...lines.slice(to)].join('\n');
        assert.strictEqual(removeProperty(RICH, 'title'), without(1, 2), 'its trailing comment with it');
        assert.strictEqual(removeProperty(RICH, 'empty'), without(2, 3));
        assert.strictEqual(removeProperty(RICH, 'people'), without(9, 12), 'a block list, its lines');
        assert.strictEqual(removeProperty(RICH, 'summary'), without(15, 18), 'a block scalar, its lines');
        assert.strictEqual(removeProperty(RICH, 'sections'), without(21, 27), 'a nested list of maps, its lines');
        assert.strictEqual(removeProperty(RICH, 'last'), without(27, 28));
        assert.strictEqual(removeProperty(RICH, 'nothing'), null);
    });

    test('an edit of a key that is not there, or not of the edit\'s kind, is refused rather than guessed', () => {
        assert.strictEqual(setText(RICH, 'missing', 'x'), null);
        assert.strictEqual(setText(RICH, 'sections', 'x'), null);
        assert.strictEqual(setBoolean(RICH, 'title', true), null);
        assert.strictEqual(addItem(RICH, 'title', 'x', '\n'), null);
        assert.strictEqual(removeItem(RICH, 'tags', 5, '\n'), null);
    });

    test('CRLF: every edit keeps the file\'s line endings, and a new line is written with them', () => {
        const crlf = toCrlf(RICH);
        const results = [
            setText(crlf, 'title', 'W'),
            setBoolean(crlf, 'draft', false),
            addItem(crlf, 'people', 'Eve', '\r\n'),
            addItem(crlf, 'tags', 'g', '\r\n'),
            removeItem(crlf, 'people', 0, '\r\n'),
            removeItem('p:\r\n  - a\r\nq: 1\r\n', 'p', 0, '\r\n'),
            addProperty(crlf, 'new', 'v', '\r\n'),
            removeProperty(crlf, 'people'),
            removeProperty(crlf, 'sections'),
        ];
        for (const after of results) {
            assert.ok(after !== null);
            assert.ok(!/[^\r]\n/.test(after), JSON.stringify(after));
            assert.strictEqual(readProperties(after).error, null);
        }
        assert.strictEqual(results[5], 'p: []\r\nq: 1\r\n');
        assert.ok((results[2] as string).includes('  - Jack  # the second\r\n  - Eve\r\n'));
    });
});

suite('Front matter as properties: the cases a review found', () => {
    test('an empty value with a trailing comment is written after the colon, the comment kept a comment', () => {
        const after = setText('empty:   # note\nq: 1\n', 'empty', 'x') as string;
        assert.strictEqual(after, 'empty: x   # note\nq: 1\n');
        assert.strictEqual(readProperties(after).properties[0].text, 'x');
        assert.strictEqual(setText('empty:\n', 'empty', 'x'), 'empty: x\n');
        assert.strictEqual(setText('empty: ~\n', 'empty', 'x'), 'empty: x\n', 'an explicit null is replaced');
    });

    test('a flow list is spliced, not written again: anchors, tags and aliases survive, and an anchored item an alias names is not removed', () => {
        const flow = 't: [&x a, !!str b]\nr: *x\n';
        assert.strictEqual(addItem(flow, 't', 'c', '\n'), 't: [&x a, !!str b, c]\nr: *x\n');
        assert.strictEqual(removeItem(flow, 't', 1, '\n'), 't: [&x a]\nr: *x\n');
        assert.strictEqual(removeItem(flow, 't', 0, '\n'), null, 'removing &x would leave *x naming nothing');
        assert.strictEqual(removeItem('t: [&x a, !!str b, c]\n', 't', 0, '\n'), 't: [!!str b, c]\n');
        assert.strictEqual(removeItem('t: [a, !!str b, c]\n', 't', 1, '\n'), 't: [a, c]\n');
        assert.strictEqual(addItem('t: [ ]\n', 't', 'a', '\n'), 't: [ a]\n');
    });

    test('a block list item is added with the indentation and `- ` alone, not the last item\'s anchor or tag, also after a bare `-`', () => {
        assert.strictEqual(addItem('p:\n  - &a x\n', 'p', 'Eve', '\n'), 'p:\n  - &a x\n  - Eve\n');
        assert.strictEqual(addItem('p:\n  - !!str x\n', 'p', 'Eve', '\n'), 'p:\n  - !!str x\n  - Eve\n');
        assert.strictEqual(addItem('p:\n  - a\n  -\nq: 1\n', 'p', 'Eve', '\n'), 'p:\n  - a\n  -\n  - Eve\nq: 1\n');
        assert.strictEqual(removeItem('p:\n  - a\n  -\nq: 1\n', 'p', 1, '\n'), 'p:\n  - a\nq: 1\n');
        assert.strictEqual(removeItem('p:\n  - &a x\n  - y\nr: *a\n', 'p', 0, '\n'), null);
    });

    test('a property is added only to a block mapping, with a key that reads back as itself', () => {
        assert.strictEqual(addProperty('{a: 1}\n', 'b', '2', '\n'), null, 'a flow map');
        assert.strictEqual(addProperty('- a\n', 'b', '2', '\n'), null, 'a list');
        assert.strictEqual(addProperty('a: [1\n', 'b', '2', '\n'), null, 'a syntax error');
        assert.strictEqual(addProperty('a: 1\n', 'x: y', '2', '\n'), 'a: 1\n\'x: y\': 2\n');
        assert.strictEqual(addProperty('a: 1\n', '-x', '2', '\n'), 'a: 1\n\'-x\': 2\n');
        assert.strictEqual(addProperty('a: 1\n', '#x', '2', '\n'), 'a: 1\n\'#x\': 2\n');
        assert.strictEqual(addProperty('a: 1\n', 'a\nb', '2', '\n'), null, 'a line break in a key');
        assert.strictEqual(addProperty('# only a comment\n', 'a', '1', '\n'), '# only a comment\na: 1\n');
    });

    test('two keys that read as one name are told apart by where they stand', () => {
        const body = '1: one\n\'1\': quoted\n';
        const read = readProperties(body);
        assert.strictEqual(read.error, null);
        assert.deepStrictEqual(read.properties.map(p => [p.key, p.offset]), [['1', 0], ['1', 7]]);
        assert.strictEqual(setText(body, { key: '1', offset: 7 }, 'Q'), '1: one\n\'1\': Q\n');
        assert.strictEqual(removeProperty(body, { key: '1', offset: 0 }), '\'1\': quoted\n');
        assert.strictEqual(setText(body, { key: '1', offset: 3 }, 'Q'), null, 'no key stands there');
    });
});

suite('Front matter as properties: the document around it', () => {
    const md = hostEngine();
    const options = { defaultWrap: 90 };

    const cases = [
        { name: 'FR-CON.md', ...conformanceDocument('FR-CON.md') },
        { name: 'FR-CON.de.md', ...conformanceDocument('FR-CON.de.md') },
    ];
    for (const c of cases) {
        const why = c.present ? '' : ` — skipped: not found at ${c.file} (set REQ_EXPLORER_ROOT)`;
        for (const crlf of [false, true]) {
            test(`${c.name} (${crlf ? 'CRLF' : 'LF'}): a property edited in the panel changes its line only, and the file parses back${why}`, function () {
                if (!c.present) {
                    this.skip();
                }
                const lf = readText(c.file).replace(/\r\n/g, '\n');
                const text = crlf ? toCrlf(lf) : lf;
                const parsed = parseDocument(md, text);
                const fm = parsed.doc.child(0);
                assert.strictEqual(fm.type.name, 'front_matter');
                const parts = splitFrontMatter(fm.attrs.src as string);
                const read = readProperties(parts.body);
                assert.strictEqual(read.error, null);
                const lang = read.properties.find(p => p.key === 'lang');
                assert.ok(lang);
                const body = setText(parts.body, 'lang', lang.text === 'en' ? 'fr' : 'en') as string;
                const state = EditorState.create({ doc: parsed.doc });
                const doc = state.apply(state.tr.setNodeMarkup(0, undefined, { ...fm.attrs, src: joinFrontMatter({ ...parts, body }) })).doc;
                const written = serializeDocument({ doc, eol: parsed.eol, tail: parsed.tail }, options);
                const changed = changedLines(text.replace(/\r\n/g, '\n'), written.replace(/\r\n/g, '\n'));
                assert.strictEqual(changed.length, 1);
                assert.match(changed[0][2], /^lang: (en|fr)$/);
                if (crlf) {
                    assert.ok(!/[^\r]\n/.test(written), 'CRLF kept');
                }
                // The host's parse of the new text has the same blocks, so Req Explorer's lines and the lenses resolve alike.
                const again = parseDocument(md, written);
                assert.strictEqual(again.doc.childCount, parsed.doc.childCount);
                assert.strictEqual(serializeDocument(again, options), written);
            });
        }
    }

    test('Insert → Properties: `---` twice at the top, a blank line before the first block; refused when there are properties', () => {
        const parsed = parseDocument(md, '# Title\n\nText.\n');
        const state = EditorState.create({ doc: parsed.doc, schema: editorSchema, plugins: [fidelityPlugin()] });
        const tr = insertPropertiesTransaction(state, '\n');
        assert.ok(tr);
        // The heading follows something else now: the fidelity plugin clears its gap, and it is written a blank line below.
        const written = serializeDocument({ doc: state.applyTransaction(tr).state.doc, eol: parsed.eol, tail: parsed.tail }, options);
        assert.strictEqual(written, '---\n---\n\n# Title\n\nText.\n');
        const again = parseDocument(md, written);
        assert.strictEqual(again.doc.child(0).type.name, 'front_matter');
        assert.strictEqual(again.doc.child(1).type.name, 'heading');
        assert.strictEqual(insertPropertiesTransaction(EditorState.create({ doc: again.doc }), '\n'), null);
        const empty = EditorState.create({ doc: parseDocument(md, '').doc });
        const onEmpty = insertPropertiesTransaction(empty, '\r\n');
        assert.ok(onEmpty);
        assert.strictEqual(serializeDocument({ doc: onEmpty.doc, eol: '\r\n', tail: '' }, options), '---\r\n---\r\n');
    });
});
