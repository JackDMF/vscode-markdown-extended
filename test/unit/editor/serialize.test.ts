import * as assert from 'assert';
import {
    EDITABLE_TOP_NODES,
    ParsedDocument,
    editorSchema,
    parseDocument,
    serializeDocument,
    fidelityPlugin,
} from '../../../src/editor';
import { EditorState } from 'prosemirror-state';
import { conformanceDocument, constructsFixture, hostEngine, readText, replaceChild, toCrlf, topChildren, touched } from './helpers';

const schema = editorSchema;
const text = (s: string, ...marks: Array<ReturnType<typeof schema.mark>>) => schema.text(s, marks);

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function allTouched(parsed: ParsedDocument): ParsedDocument {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return { ...parsed, doc: parsed.doc.type.create(null, children) };
}

suite('Editor serializer for changed blocks', () => {
    const md = hostEngine();
    const options = { defaultWrap: 90 };
    const serialize = (parsed: ParsedDocument, defaultWrap = 90) => serializeDocument(parsed, { defaultWrap });

    /** Parse, rewrite every editable block by rule, parse that and rewrite again: the two writes must agree. */
    function assertStable(source: string): string {
        const first = serialize(allTouched(parseDocument(md, source)));
        const second = serialize(allTouched(parseDocument(md, first)));
        assert.strictEqual(second, first);
        return first;
    }

    test('a changed paragraph is wrapped at its own wrapWidth, the longest line it had', () => {
        const source = 'A first paragraph that is\nwrapped at twenty-five.\n\nSecond.\n';
        const parsed = parseDocument(md, source);
        const [paragraph] = topChildren(parsed.doc);
        assert.strictEqual(paragraph.attrs.wrapWidth, 25);
        const edited = touched(paragraph, schema.nodes.paragraph.create(null, text('An edited first paragraph that is now much longer than it was before.')).content);
        const out = serialize({ ...parsed, doc: replaceChild(parsed.doc, 0, edited) });
        const lines = out.split('\n\n')[0].split('\n');
        assert.ok(lines.length > 2, out);
        for (const line of lines) {
            assert.ok(line.length <= 25, `${JSON.stringify(line)} fits 25`);
        }
        assert.strictEqual(lines.join(' '), 'An edited first paragraph that is now much longer than it was before.');
        assert.ok(out.endsWith('\n\nSecond.\n'), 'the untouched block after it is still its slice');
    });

    test('a new paragraph (no wrapWidth) is wrapped at defaultWrap', () => {
        const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
        const parsed = parseDocument(md, 'Before.\n');
        const doc = parsed.doc.type.create(null, [...topChildren(parsed.doc), schema.nodes.paragraph.create(null, text(words))]);
        const out = serialize({ ...parsed, doc }, 40);
        const lines = out.split('\n\n')[1].trimEnd().split('\n');
        assert.ok(lines.length > 1);
        for (const line of lines) {
            assert.ok(line.length <= 40, `${JSON.stringify(line)} fits 40`);
        }
    });

    test('no break inside a code span or a link destination, and a word longer than the width stays whole', () => {
        const code = schema.marks.code.create();
        const link = schema.marks.link.create({ href: 'https://example.com/a/long/path', title: 'a title with spaces' });
        const paragraph = schema.nodes.paragraph.create({ wrapWidth: 12 }, [
            text('see '),
            text('code with many spaces inside', code),
            text(' and '),
            text('the link text', link),
            text(' then averyveryverylongwordthatcannotbreak end'),
        ]);
        const doc = schema.topNodeType.create(null, [paragraph]);
        const out = serialize({ doc, eol: '\n', tail: '' });
        const lines = out.trimEnd().split('\n');
        assert.ok(lines.some(l => l.includes('`code with many spaces inside`')), out);
        assert.ok(lines.some(l => l.includes('](https://example.com/a/long/path "a title with spaces")')), out);
        assert.ok(lines.includes('averyveryverylongwordthatcannotbreak'), out);
        assert.deepStrictEqual(topChildren(parseDocument(md, out).doc).map(n => n.type.name), ['paragraph']);
    });

    test('a hand-wrapped paragraph with a link on a line of its own is re-wrapped at its widest breakable line, not the link (REL-RXE-135)', () => {
        // Req Explorer's requirements/releases/REL-REQEXPLORER.md, as written by
        // hand: lines of 86, 89, 24, 105, 86, 90, 91, 91 and 46 characters (93
        // bytes for the seventh, whose dash is three). The 105 is one link,
        // which the 24 was cut short before.
        const lines = [
            'Three changes, one of them the reason for the release. A rich Markdown editor for this',
            'corpus is built in Markdown Extended Pro over the same markdown-it instance VS Code hands',
            'both extensions, and the',
            '[2026-09-21 editor-integration contract](../workshops/2026-09-21-workshop-editor-integration-contract.md)',
            'settled what Req Explorer owes it. `CR-RXE-124` ships the first piece: every token the',
            'preview plugin injects carries a mark naming the rule that made it, one of three kinds and',
            'what it stands for, so the editor can refuse the edit that cannot be saved — and it reaches',
            'the editor only through an installed extension, which is why this release is cut before the',
            'neighbouring gaps of the same note are closed.',
        ];
        assert.deepStrictEqual(lines.map(l => Array.from(l).length), [86, 89, 24, 105, 86, 90, 91, 91, 46]);
        const parsed = parseDocument(md, `${lines.join('\n')}\n`);
        const [paragraph] = topChildren(parsed.doc);
        assert.strictEqual(paragraph.attrs.wrapWidth, 91, 'the widest line that could have been broken');

        // One word changed, as Daniel did.
        const edited = paragraph.content.replaceChild(0, text('Three changes, one of them the whole reason for the release. A rich Markdown editor for this corpus is built in Markdown Extended Pro over the same markdown-it instance VS Code hands both extensions, and the '));
        const out = serialize({ ...parsed, doc: replaceChild(parsed.doc, 0, touched(paragraph, edited)) });
        const link = lines[3];
        for (const line of out.trimEnd().split('\n')) {
            if (line === link) {
                continue;
            }
            assert.ok(Array.from(line).length <= 91, `${JSON.stringify(line)} fits 91:\n${out}`);
        }
        assert.ok(out.split('\n').includes(link), `the link keeps a line of its own:\n${out}`);
        assert.ok(out.includes('the whole reason'), out);
        assert.strictEqual(assertStable(out), out, 'and a second save writes it the same');
    });

    test('a changed list keeps its bullet character, and an ordered list its start and delimiter', () => {
        const parsed = parseDocument(md, '* one\n* two\n\n3) three\n4) four\n');
        const [bullets, ordered] = topChildren(parsed.doc);
        const doc = parsed.doc.type.create(null, [touched(bullets), touched(ordered)]);
        assert.strictEqual(serialize({ ...parsed, doc }), '* one\n* two\n\n3) three\n4) four\n');
    });

    test('nested lists indent by the marker width, and tightness is kept', () => {
        const source = '- outer\n  - inner\n    - innermost\n- second\n\n1. first\n\n2. loose\n';
        assert.strictEqual(serialize(allTouched(parseDocument(md, source))), source);
    });

    test('a changed requirement heading writes reqPrefix and attrsSuffix back verbatim around the edited text', () => {
        const heading = schema.nodes.heading.create(
            { level: 2, reqPrefix: 'FR-X-001: ', attrsSuffix: '{#fr-x-001--abcdef12}', anchor: 'fr-x-001--abcdef12' },
            text('An edited title'));
        const doc = schema.topNodeType.create(null, [heading]);
        assert.strictEqual(serialize({ doc, eol: '\n', tail: '' }), '## FR-X-001: An edited title {#fr-x-001--abcdef12}\n');
    });

    test('a changed block with gap null is separated by one blank line, in the document\'s line ending', () => {
        const parsed = parseDocument(md, toCrlf('First.\n\nThird.\n'));
        const [first, third] = topChildren(parsed.doc);
        const inserted = schema.nodes.paragraph.create(null, text('Second.'));
        const doc = parsed.doc.type.create(null, [first, inserted, third]);
        assert.strictEqual(serialize({ ...parsed, doc }), 'First.\r\n\r\nSecond.\r\n\r\nThird.\r\n');
    });

    test('deleting a block takes its gap with it', () => {
        const parsed = parseDocument(md, '# Title\n\nGone.\n\n\nKept.\n');
        const [title, , kept] = topChildren(parsed.doc);
        const doc = parsed.doc.type.create(null, [title, kept]);
        assert.strictEqual(serialize({ ...parsed, doc }), '# Title\n\n\nKept.\n');
    });

    /** `parsed` with top-level child `index` dropped and the node after it given `gap: null`, as a deletion leaves it. */
    function withoutChild(parsed: ParsedDocument, index: number): ParsedDocument {
        const children = topChildren(parsed.doc);
        const follower = children[index + 1];
        children.splice(index, 2, follower.type.create({ ...follower.attrs, gap: null }, follower.content, follower.marks));
        return { ...parsed, doc: parsed.doc.type.create(null, children) };
    }

    test('an emptied first item straight under a paragraph is written after a blank line: `text\\n-` is a setext heading and `*`, `+`, `1.` are swallowed, so the list vanished', () => {
        for (const [marker, second, list] of [['-', '-', 'bullet_list'], ['*', '*', 'bullet_list'], ['+', '+', 'bullet_list'], ['1.', '2.', 'ordered_list']] as const) {
            const parsed = parseDocument(md, `text\n${marker} a\n${second} b\n`);
            const [paragraph, items] = topChildren(parsed.doc);
            assert.strictEqual(items.attrs.gap, '', 'the file held them tight');
            const first = items.child(0);
            const emptied = first.type.create(first.attrs, first.content.replaceChild(0, first.child(0).type.create(first.child(0).attrs)));
            const doc = parsed.doc.type.create(null, [paragraph, touched(items, items.content.replaceChild(0, emptied))]);
            const out = serialize({ ...parsed, doc });
            assert.strictEqual(out, `text\n\n${marker} \n${second} b\n`, 'the writer\'s empty item is its marker and a space');
            const again = topChildren(parseDocument(md, out).doc);
            assert.deepStrictEqual(again.map(n => n.type.name), ['paragraph', list], out);
            assert.strictEqual(again[1].childCount, 2, out);
        }
    });

    test('two lists of one marker a blank line apart are one list to the parser: the second is written with the other marker', () => {
        for (const [source, expected] of [
            ['- a\n\nMiddle.\n\n- b\n', '- a\n\n* b\n'],
            ['* a\n\nMiddle.\n\n* b\n', '* a\n\n- b\n'],
            ['1. a\n\nMiddle.\n\n1. b\n', '1. a\n\n1) b\n'],
            ['3) a\n\nMiddle.\n\n7) b\n', '3) a\n\n7. b\n'],
        ] as const) {
            const out = serialize(withoutChild(parseDocument(md, source), 1));
            assert.strictEqual(out, expected);
            const again = topChildren(parseDocument(md, out).doc);
            assert.strictEqual(again.length, 2, out);
            assert.ok(again.every(n => n.type.name.endsWith('_list') && n.attrs.tight === true), out);
        }
    });

    test('two tables a blank line apart are one table to multimd: a second blank line goes between them', () => {
        const a = '| a |\n| - |\n| 1 |\n';
        const b = '| b |\n| - |\n| 2 |\n';
        const expected = `${a}\n\n${b}`;
        // After a deletion between them.
        assert.strictEqual(serialize(withoutChild(parseDocument(md, `${a}\nMiddle.\n\n${b}`), 1)), expected);
        // After an insertion: a new table (gap `null`) under one the file holds.
        const parsed = parseDocument(md, a);
        const [inserted] = topChildren(parseDocument(md, b).doc);
        const doc = parsed.doc.type.create(null, [...topChildren(parsed.doc), inserted.type.create({ ...inserted.attrs, src: null, gap: null }, inserted.content)]);
        const out = serialize({ ...parsed, doc });
        assert.strictEqual(out, expected);
        assert.deepStrictEqual(topChildren(parseDocument(md, out).doc).map(n => n.type.name), ['table', 'table']);
    });

    test('a seam the file holds is not judged: `text\\n- a` with the item edited stays tight, and two lists it held as written stay as written', () => {
        const parsed = parseDocument(md, 'text\n- a\n');
        const [paragraph, items] = topChildren(parsed.doc);
        const item = items.child(0);
        const edited = item.type.create(item.attrs, item.content.replaceChild(0, item.child(0).type.create(item.child(0).attrs, text('edited'))));
        const doc = parsed.doc.type.create(null, [paragraph, touched(items, items.content.replaceChild(0, edited))]);
        assert.strictEqual(serialize({ ...parsed, doc }), 'text\n- edited\n');
        assert.strictEqual(serialize(parseDocument(md, '- a\n* b\n')), '- a\n* b\n');
        // Two blocks written from their slices with a gap the edit kept: the parser would read `- a` and `- b` as one
        // list, but the seam is the file's own reading of a pair it never wrote, so it is not read and not changed.
        const kept = parseDocument(md, '- a\n\nMiddle.\n\n- b\n');
        const [first, , last] = topChildren(kept.doc);
        assert.strictEqual(serialize({ ...kept, doc: kept.doc.type.create(null, [first, last]) }), '- a\n\n- b\n');
    });

    test('stability: a seam the layout widened or re-marked is written the same once the file is read again', () => {
        for (const out of [
            'text\n\n- \n- b\n', 'text\n\n* \n* b\n', 'text\n\n+ \n+ b\n', 'text\n\n1. \n2. b\n',
            '- a\n\n* b\n', '1. a\n\n1) b\n', '| a |\n| - |\n| 1 |\n\n\n| b |\n| - |\n| 2 |\n',
        ]) {
            assert.strictEqual(assertStable(out), out);
            assert.strictEqual(serialize(parseDocument(md, out)), out);
        }
    });

    test('fences keep their marker and info string, and grow when the content holds a fence', () => {
        const out = serialize(allTouched(parseDocument(md, '~~~python\nprint(1)\n~~~\n\n```\ninner\n```\n')));
        assert.strictEqual(out, '~~~python\nprint(1)\n~~~\n\n```\ninner\n```\n');
        const holding = schema.nodes.code_block.create({ params: 'md' }, text('```js\nx\n```'));
        const written = serialize({ doc: schema.topNodeType.create(null, [holding]), eol: '\n', tail: '' });
        assert.strictEqual(written, '````md\n```js\nx\n```\n````\n');
    });

    test('emphasis keeps _ and * as written, and falls back to * where _ would be glued to a word', () => {
        assert.strictEqual(assertStable('*a* _b_ **c** __d__\n'), '*a* _b_ **c** __d__\n');
        const em = schema.marks.em.create({ markup: '_' });
        const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [text('glued'), text('emph', em), text(' end')])]);
        assert.strictEqual(serialize({ doc, eol: '\n', tail: '' }), 'glued*emph* end\n');
    });

    test('emphasis keeps _ next to a _: only a letter or digit glues it to a word', () => {
        assert.strictEqual(serialize(allTouched(parseDocument(md, '\\__word_\n'))), '\\__word_\n');
        // The text's `_` is escaped, as it always was; the emphasis beside it keeps its `_`.
        assert.strictEqual(serialize(allTouched(parseDocument(md, 'a_ _b_\n'))), 'a\\_ _b_\n');
    });

    test('bare and angle autolinks keep their form; links keep their href, non-ASCII as written', () => {
        const source = 'See https://example.com/a_b and <https://example.org> and [Übersicht](Übersicht.md#teil).\n';
        assert.strictEqual(assertStable(source), source);
    });

    test('stability: characters that are syntax in this engine are escaped once and stay escaped', () => {
        const hostile = 'Price $5 @ noon, x^2, a == b, c ++ d, e !! f, <div> &amp; a*b_c [x] :smile: 1. - # > | ~ end';
        const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create({ wrapWidth: 8 }, text(hostile))]);
        const first = serialize({ doc, eol: '\n', tail: '' });
        const reparsed = parseDocument(md, first);
        const nodes = topChildren(reparsed.doc);
        assert.deepStrictEqual(nodes.map(n => n.type.name), ['paragraph'], first);
        assert.strictEqual(nodes[0].textContent, hostile);
        assert.strictEqual(serialize(allTouched(reparsed)), first);
    });

    test('stability: a code span whose content starts or ends with a space or backtick', () => {
        const code = schema.marks.code.create();
        for (const content of [' padded ', '`tick', 'a ` b', ' lead']) {
            const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, text(content, code))]);
            const first = serialize({ doc, eol: '\n', tail: '' });
            const reparsed = parseDocument(md, first);
            assert.strictEqual(topChildren(reparsed.doc)[0].textContent, content, first);
            assert.strictEqual(serialize(allTouched(reparsed)), first);
        }
    });

    for (const [name, fixture] of [
        ['FR-CON.md', conformanceDocument('FR-CON.md')],
        ['FR-CON.de.md', conformanceDocument('FR-CON.de.md')],
        ['constructs.md', { file: constructsFixture, present: true }],
    ] as const) {
        const why = fixture.present ? '' : ` — skipped: not found at ${fixture.file} (set REQ_EXPLORER_ROOT)`;
        test(`stability: ${name} with every editable block rewritten by rule serializes the same twice${why}`, function () {
            if (!fixture.present) {
                this.skip();
            }
            assertStable(readText(fixture.file));
        });
    }

    test('the options object is the only configuration: defaultWrap does not touch untouched blocks', () => {
        const source = 'A line that is much longer than ten characters stays as it is.\n';
        assert.strictEqual(serializeDocument(parseDocument(md, source), { ...options, defaultWrap: 10 }), source);
    });

    test('a paragraph split right under a heading is written as two paragraphs, and read back as two', () => {
        const source = '# H\nAlpha beta\n';
        const before = EditorState.create({ doc: parseDocument(md, source).doc, plugins: [fidelityPlugin()] });
        const split = before.doc.child(0).nodeSize + 1 + 'Alpha '.length;
        const after = before.apply(before.tr.split(split));
        const out = serializeDocument({ doc: after.doc, eol: '\n', tail: '' }, options);
        assert.strictEqual(out, '# H\nAlpha\n\nbeta\n');
        const reread = topChildren(parseDocument(md, out).doc).map(n => `${n.type.name}:${n.textContent}`);
        assert.deepStrictEqual(reread, ['heading:H', 'paragraph:Alpha', 'paragraph:beta']);
    });
});
