import * as assert from 'assert';
import {
    EDITABLE_TOP_NODES,
    ParsedDocument,
    editorSchema,
    parseDocument,
    serializeDocument,
} from '../../../src/editor';
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
});
