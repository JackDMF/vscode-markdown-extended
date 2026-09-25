import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EDITABLE_TOP_NODES, ParsedDocument, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { drawInline } from './fakeDom';
import { hostEngine, topChildren, touched } from './helpers';

const schema = editorSchema;
const options = { defaultWrap: 90 };

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function allTouched(parsed: ParsedDocument): ParsedDocument {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return { ...parsed, doc: parsed.doc.type.create(null, children) };
}

/** A document of one paragraph holding `content`, written by rule. */
function written(content: Node[], attrs: Record<string, unknown> = {}): string {
    const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create(attrs, content)]);
    return serializeDocument({ doc, eol: '\n', tail: '' }, options);
}

const t = (s: string, ...marks: ReturnType<typeof schema.mark>[]) => schema.text(s, marks);
const ref = (...content: Node[]) => schema.nodes.note_ref.create(null, content);
const sidenote = (r: Node[], body: Node[]) => schema.nodes.sidenote.create(null, [ref(...r), schema.nodes.sidenote_body.create(null, body)]);
const marginal = (r: Node[], body: Node[]) => schema.nodes.marginal_note.create(null, [ref(...r), schema.nodes.marginal_note_body.create(null, body)]);

/**
 * A structure of the document for comparing: each node as `type(children)`,
 * text as its string with its marks in brackets.
 */
function shape(node: Node): string {
    if (node.isText) {
        const marks = node.marks.map(m => m.type.name).join(',');
        return marks ? `[${marks}]${JSON.stringify(node.text)}` : JSON.stringify(node.text);
    }
    const inner: string[] = [];
    node.forEach(child => inner.push(shape(child)));
    const marks = node.marks.length ? `[${node.marks.map(m => m.type.name).join(',')}]` : '';
    return `${marks}${node.type.name}(${inner.join(' ')})`;
}

/** The inline content of a textblock as the editor draws it, with the reference's own wrapper removed — the plugin emits none. */
function drawn(block: Node): string {
    return drawInline(block.content).html().replace(/<span data-mep-note-ref="">((?:(?!<\/?span).)*)<\/span>/g, '$1');
}

suite('Editor inline constructs: parsed as rich text', () => {
    const md = hostEngine();
    const firstBlock = (source: string) => topChildren(parseDocument(md, source).doc)[0];

    test('each of the extension\'s marks is a mark, and the paragraph stays a paragraph', () => {
        const p = firstBlock('A ==mark== ^sup^ ~sub~ ~~strike~~ [[Ctrl+S]] end.\n');
        assert.strictEqual(p.type.name, 'paragraph');
        assert.strictEqual(shape(p), 'paragraph("A " [mark]"mark" " " [sup]"sup" " " [sub]"sub" " " [strike]"strike" " " [kbd]"Ctrl+S" " end.")');
    });

    test('a sidenote is a node of a reference and a body, each rich text; the text around it stays text', () => {
        const p = firstBlock('Alpha ++beta *ref*|a **note**++ gamma.\n');
        assert.strictEqual(shape(p),
            'paragraph("Alpha " sidenote(note_ref("beta " [em]"ref") sidenote_body("a " [strong]"note")) " gamma.")');
    });

    test('a marginal note spanning a soft break, and both sidebars', () => {
        const p = firstBlock('The !!lives in|note → the\nrules!! and $ **L** $ @ R @.\n');
        assert.strictEqual(shape(p), 'paragraph("The " marginal_note(note_ref("lives in") marginal_note_body("note → the rules")) " and "'
            + ' left_sidebar(" " [strong]"L" " ") " " right_sidebar(" R ") ".")');
    });

    test('a mark around a note carries the note, not its content', () => {
        assert.strictEqual(shape(firstBlock('**a ++b|c++ d**\n')),
            'paragraph([strong]"a " [strong]sidenote(note_ref("b") sidenote_body("c")) [strong]" d")');
    });

    test('a heading with a sidenote in its title is editable', () => {
        const heading = firstBlock('## Title ++ref|note++ {#anchor}\n');
        assert.strictEqual(heading.type.name, 'heading');
        assert.strictEqual(heading.attrs.attrsSuffix, '{#anchor}');
        assert.strictEqual(shape(heading), 'heading("Title " sidenote(note_ref("ref") sidenote_body("note")))');
    });

    test('a note inside a note stays a source block: the plugin allows another kind inside, the schema one level', () => {
        for (const source of ['++ref|see !!a|b!! x++\n', '$a @b@ c$\n']) {
            const block = firstBlock(source);
            assert.strictEqual(block.type.name, 'raw_block', source);
        }
    });

    test('the schema draws each construct as the element the engine renders', () => {
        for (const source of [
            'Text with ==mark== and ^sup^ and ~sub~ and ~~strike~~ and [[Ctrl+S]].',
            'Alpha ++beta *ref*|a **note**++ gamma !!mr|mn body!! and $left$ and @right@.',
            '**Bold ++ref|body++ around** and *[[Ctrl]]*.',
        ]) {
            const block = firstBlock(`${source}\n`);
            assert.strictEqual(drawn(block), md.renderInline(source), source);
        }
    });
});

suite('Editor inline constructs: written back by rule', () => {
    const md = hostEngine();

    /** Parse, rewrite every editable block by rule, parse that and rewrite again: the two writes must agree. */
    function assertStable(source: string, defaultWrap = 90): string {
        const first = serializeDocument(allTouched(parseDocument(md, source)), { defaultWrap });
        const second = serializeDocument(allTouched(parseDocument(md, first)), { defaultWrap });
        assert.strictEqual(second, first);
        return first;
    }

    /** Written from a model, the text parses back to that model and is written the same again. */
    function assertRoundTrip(content: Node[]): string {
        const text = written(content);
        const reparsed = topChildren(parseDocument(md, text).doc);
        assert.strictEqual(reparsed.length, 1, text);
        const expected = schema.nodes.paragraph.create(null, content);
        assert.strictEqual(shape(reparsed[0]), shape(expected), text);
        assert.strictEqual(serializeDocument(allTouched(parseDocument(md, text)), options), text);
        return text;
    }

    for (const source of [
        'A ==mark== here.', 'Two ^sup^ here.', 'H~2~O here.', 'The ~~old~~ new.', 'Press [[Ctrl+S]] now.',
        'Alpha ++beta|note++ gamma.', 'The !!ref|marginal note!! here.', '$ left body $ then text.', 'Text @ right body @.',
        'Rich ++*em* ref|a **strong** `code` [link](x.md) body++ end.',
        '~sub~ at the start, ~~strike~~ later.', '~~strike~~ at the start.', 'A key [[a *b*]] with emphasis inside.',
    ]) {
        test(`stability: ${JSON.stringify(source)} is written as it was, and the same twice`, () => {
            assert.strictEqual(assertStable(`${source}\n`), `${source}\n`);
        });
    }

    test('the delimiters come from the marker table', () => {
        const paragraph = [
            t('mark', schema.marks.mark.create()), t(' '), t('sup', schema.marks.sup.create()), t(' '),
            t('sub', schema.marks.sub.create()), t(' '), t('strike', schema.marks.strike.create()), t(' '), t('key', schema.marks.kbd.create()),
        ];
        assert.strictEqual(written(paragraph), '==mark== ^sup^ ~sub~ ~~strike~~ [[key]]\n');
    });

    test('a | in a reference is written as a character reference, since the plugin ends the reference at the first |', () => {
        assert.strictEqual(assertRoundTrip([t('x '), sidenote([t('a|b')], [t('c|d')]), t(' y')]), 'x ++a&#124;b|c|d++ y\n');
    });

    test('a marker character touching the closing marker, or before the note, is a character reference', () => {
        assert.strictEqual(assertRoundTrip([t('x '), sidenote([t('r')], [t('a+')])]), 'x ++r|a&#43;++\n');
        assert.strictEqual(assertRoundTrip([t('x '), sidenote([t('r')], [t('a++')])]), 'x ++r|a\\+&#43;++\n');
        assert.strictEqual(assertRoundTrip([t('Wow!'), marginal([t('r')], [t('b!')])]), 'Wow&#33;!!r|b&#33;!!\n');
        assert.strictEqual(assertRoundTrip([t('x '), marginal([t('!r')], [t('b')])]), 'x !!&#33;r|b!!\n');
    });

    /** Written, the note reads back as one note with the same text, links to the same place, and is written the same again. */
    function assertNoteSurvives(content: Node[], noteType: string): string {
        const out = written(content);
        const [p] = topChildren(parseDocument(md, out).doc);
        assert.strictEqual(p.type.name, 'paragraph', out);
        const notes: Node[] = [];
        p.forEach(child => {
            if (child.type.name === noteType) {
                notes.push(child);
            }
        });
        assert.strictEqual(notes.length, 1, `one ${noteType}: ${out}`);
        const expected = schema.nodes.paragraph.create(null, content);
        assert.strictEqual(p.textContent, expected.textContent, out);
        const hrefs = (n: Node) => {
            const found: string[] = [];
            n.descendants(d => {
                d.marks.filter(m => m.type.name === 'link').forEach(m => found.push(decodeURIComponent(m.attrs.href as string)));
            });
            return found;
        };
        assert.deepStrictEqual(hrefs(p), hrefs(expected), 'the links go where they went');
        assert.strictEqual(serializeDocument(allTouched(parseDocument(md, out)), options), out, 'stable');
        return out;
    }

    test('a link in a note whose href holds the marker pair (C++) is percent-encoded there, so the note does not close inside the URL', () => {
        const cpp = 'https://en.wikipedia.org/wiki/C++';
        const link = schema.marks.link.create({ href: cpp });
        assert.strictEqual(assertNoteSurvives([t('See '), sidenote([t('the language')], [t('C++', link), t(' on Wikipedia')]), t(' end.')], 'sidenote'),
            'See ++the language|[C\\+\\+](https://en.wikipedia.org/wiki/C%2B%2B) on Wikipedia++ end.\n');
        const wow = schema.marks.link.create({ href: 'https://example.com/wow!!', title: 'so!! good' });
        assert.strictEqual(assertNoteSurvives([t('A '), marginal([t('shout', wow)], [t('body')]), t(' end.')], 'marginal_note'),
            'A !![shout](https://example.com/wow%21%21 "so&#33;&#33; good")|body!! end.\n');
    });

    test('a bare URL in a note body holding the marker character is written inline, not bare', () => {
        const cpp = 'https://en.wikipedia.org/wiki/C++';
        const bare = schema.marks.link.create({ href: cpp, markup: 'linkify' });
        assert.strictEqual(assertNoteSurvives([t('A '), sidenote([t('i')], [t(cpp, bare)]), t('.')], 'sidenote'),
            'A ++i|[https://en.wikipedia.org/wiki/C\\+\\+](https://en.wikipedia.org/wiki/C%2B%2B)++.\n');
        const plain = schema.marks.link.create({ href: 'https://example.com/a', markup: 'linkify' });
        assert.strictEqual(written([t('See '), sidenote([t('it')], [t('https://example.com/a', plain)]), t(' end.')]),
            'See ++it|https://example.com/a++ end.\n', 'one without it stays bare');
    });

    test('a marginal note whose reference is a link keeps its !! (no \\! for an image)', () => {
        const link = schema.marks.link.create({ href: 'x.md' });
        assert.strictEqual(assertRoundTrip([t('see '), marginal([t('there', link)], [t('b')]), t(' '), t('next', link)]), 'see !![there](x.md)|b!! [next](x.md)\n');
    });

    test('a $ in a left sidebar and an @ in a right one are character references; elsewhere they stay escaped', () => {
        const left = schema.nodes.left_sidebar.create(null, [t('costs $5')]);
        const right = schema.nodes.right_sidebar.create(null, [t(' mail a@b.c ')]);
        assert.strictEqual(assertRoundTrip([left, t(' and '), right, t(' $ @')]), '$costs &#36;5$ and @ mail a&#64;b.c @ \\$ \\@\n');
    });

    test('a reference with no text is written as &nbsp;, which the plugin accepts, and stays one', () => {
        const text = written([t('x '), sidenote([], [t('body')]), t(' y')]);
        assert.strictEqual(text, 'x ++&nbsp;|body++ y\n');
        assert.strictEqual(assertStable(text), text);
    });

    test('an empty body and an empty sidebar are written, and read back as notes', () => {
        assert.strictEqual(assertRoundTrip([t('x '), sidenote([t('r')], [])]), 'x ++r|++\n');
        const empty = written([t('x '), schema.nodes.right_sidebar.create()]);
        assert.strictEqual(empty, 'x @@\n');
        assert.strictEqual(assertStable(empty), empty);
        assert.strictEqual(topChildren(parseDocument(md, empty).doc)[0].child(1).type.name, 'right_sidebar');
    });

    test('a note is wrapped inside like the prose around it, since the plugin reads it across line breaks; sup, sub and kbd are not', () => {
        const long = 'Before ++a long reference|and a body that goes on for a while++ between ^a raised run^ and [[Ctrl Alt Del]] after.\n';
        const [paragraph] = topChildren(parseDocument(md, long).doc);
        const out = written(Array.from({ length: paragraph.childCount }, (_, i) => paragraph.child(i)), { wrapWidth: 30 });
        assert.strictEqual(assertStable(out), out);
        const lines = out.trimEnd().split('\n');
        assert.ok(lines.length > 3, out);
        assert.ok(lines.some(l => l.includes('^a raised run^')), out);
        assert.ok(lines.some(l => l.includes('[[Ctrl Alt Del]]')), out);
        const opening = lines.find(l => l.includes('++a'));
        assert.ok(opening !== undefined && !opening.slice(opening.indexOf('++a') + 3).includes('++'), `a line break inside the note: ${out}`);
        const reparsed = topChildren(parseDocument(md, out).doc);
        assert.deepStrictEqual(reparsed.map(n => n.type.name), ['paragraph']);
        assert.strictEqual(reparsed[0].textContent, topChildren(parseDocument(md, long).doc)[0].textContent);
    });

    test('a changed heading with a sidenote writes it inline, one line', () => {
        const parsed = parseDocument(md, '## Title ++ref|note++ {#anchor}\n');
        assert.strictEqual(serializeDocument(allTouched(parsed), options), '## Title ++ref|note++ {#anchor}\n');
    });
});
