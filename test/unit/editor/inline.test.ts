import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EDITABLE_TOP_NODES, ParsedDocument, editorSchema, parseDocument, serializeDocument } from '../../../src/editor';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { SIDEBAR_GLUED_AFTER, SIDEBAR_GLUED_BEFORE, SIDEBAR_GLUED_URL, setInlineEngine, unwritableInNote } from '../../../src/editor/serialize';
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

    /** How many runs of marks `content` holds: a mark counts once where it begins, and again only after a node without it. */
    function runsIn(content: Node[]): number {
        let runs = 0;
        content.forEach((node, i) => node.marks.forEach(mark => {
            if (i === 0 || !mark.isInSet(content[i - 1].marks)) {
                runs++;
            }
        }));
        return runs;
    }

    /**
     * `assertRoundTrip`, and the engine renders one element per run of a mark.
     * A run split in two reads back as the same model when the mark's two
     * halves touch (`*[a](u)*[ b](u)` is one link to the model, two to the
     * page), so the element count is what sees it; `assertStable` sees nothing,
     * a split being written the same way twice.
     */
    function assertOneElementPerRun(content: Node[], runs = runsIn(content)): string {
        const text = assertRoundTrip(content);
        const elements = md.renderInline(text.trimEnd()).match(/<(mark|i|em|b|strong|s|a|kbd|span)[ >]/g) ?? [];
        assert.strictEqual(elements.length, runs, `${text.trimEnd()} renders ${md.renderInline(text.trimEnd())}`);
        return text;
    }

    for (const source of [
        'A ==mark== here.', 'Two ^sup^ here.', 'H~2~O here.', 'The ~~old~~ new.', 'Press [[Ctrl+S]] now.',
        'Alpha ++beta|note++ gamma.', 'The !!ref|marginal note!! here.', '$ left body $ then text.', 'Text @ right body @.',
        'Rich ++*em* ref|a **strong** `code` [link](x.md) body++ end.',
        '~sub~ at the start, ~~strike~~ later.', '~~strike~~ at the start.', 'A key [[a *b*]] with emphasis inside.',
        'A ==[a]{.x} b== here.', '**_a_ b** here.', '==*a* b== here.', '[*a* b](x.md) here.', '[[*a* b]] here.',
        '*==[a]{.x} b== c* here.', '==*[a]{.x} b* c== here.',
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

    test('a sidebar touching a letter before it, or a left one a digit after it, is refused; the text is never rewritten', () => {
        const left = (...c: Node[]) => schema.nodes.left_sidebar.create(null, c);
        const right = (...c: Node[]) => schema.nodes.right_sidebar.create(null, c);
        const refusal = (content: Node[]) => unwritableInNote(schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, content)]));
        assert.strictEqual(refusal([t('x '), left(t('a')), t('b'), left(t('c'))]), SIDEBAR_GLUED_BEFORE);
        assert.strictEqual(refusal([t('x'), left(t('y')), t(' z')]), SIDEBAR_GLUED_BEFORE);
        assert.strictEqual(refusal([t('x '), left(t('y')), t('5 and z')]), SIDEBAR_GLUED_AFTER);
        // Read off the output: a mark that writes no delimiter or a badge that writes nothing stands between no characters.
        const ref = schema.marks.req_ref.create({});
        assert.strictEqual(refusal([t('see '), t('FRS-RXE-040', ref), left(t('y')), t(' z')]), SIDEBAR_GLUED_BEFORE);
        const badge = schema.nodes.inline_atom.create({ html: '<b>B</b>' });
        assert.strictEqual(refusal([t('see x'), badge, left(t('y')), t(' z')]), SIDEBAR_GLUED_BEFORE);
        assert.strictEqual(refusal([t('see '), left(t('y')), badge, t('5 z')]), SIDEBAR_GLUED_AFTER);
        // A bare URL writes its own text: one ending in a letter, or starting with a digit after a left sidebar.
        const bare = (s: string) => schema.text(s, [schema.marks.link.create({ href: `http://${s}`, markup: 'linkify' })]);
        assert.strictEqual(refusal([t('visit '), bare('example.com'), left(t('y')), t(' z')]), SIDEBAR_GLUED_BEFORE);
        assert.strictEqual(refusal([t('see '), left(t('y')), bare('1.example.com'), t(' z')]), SIDEBAR_GLUED_AFTER);
        // What the plugin reads as a sidebar is written as one.
        assert.strictEqual(refusal([t('a '), right(t('note')), t('x')]), null, 'a letter after a closer stops nothing');
        assert.strictEqual(assertRoundTrip([t('a '), right(t('note')), t('x')]), 'a @note@x\n');
        assert.strictEqual(refusal([t('这是'), left(t('侧边栏')), t('的')]), null, 'nor CJK text');
        assert.strictEqual(assertRoundTrip([t('这是'), left(t('侧边栏')), t('的')]), '这是$侧边栏$的\n');
        assert.strictEqual(refusal([t('x '), t('word', schema.marks.em.create()), left(t('y')), t(' z')]), null, 'a delimiter between is no letter');
        assert.strictEqual(refusal([t('x '), right(t('y')), t('5 z')]), null, 'an @ closes before a digit');
        // Text that reads as a character reference is escaped, so the parser decodes nothing beside the marker.
        assert.strictEqual(refusal([t('a &#120;'), left(t('y')), t(' z')]), null);
        assert.strictEqual(assertRoundTrip([t('a &#120;'), left(t('y')), t(' z')]), 'a \\&#120;$y$ z\n');
        assert.strictEqual(assertRoundTrip([t('a '), left(t('y')), t('&#53; z')]), 'a $y$\\&#53; z\n');
    });

    test('a sidebar right after a bare URL is refused: linkify reads its marker into the URL', () => {
        const left = (...c: Node[]) => schema.nodes.left_sidebar.create(null, c);
        const right = (...c: Node[]) => schema.nodes.right_sidebar.create(null, c);
        const refusal = (content: Node[]) => unwritableInNote(schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, content)]));
        const bare = (s: string) => schema.text(s, [schema.marks.link.create({ href: s, markup: 'linkify' })]);
        const strong = schema.marks.strong.create();
        for (const [label, content] of [
            ['bare URL ending in /, left', [t('a '), bare('http://e.com/'), left(t('y')), t('x z')]],
            ['bare URL ending in /, right', [t('a '), bare('http://e.com/'), right(t('y')), t(' z')]],
            ['bare URL ending in )', [t('a '), bare('http://e.com/(a)'), left(t('y')), t(' z')]],
            ['URL in plain text', [t('a http://e.com/'), left(t('y')), t(' z')]],
            ['a query', [t('a https://e.com?q=1&'), right(t('y')), t(' z')]],
            ['emphasis between', [t('a http://e.com/'), t('b', schema.marks.strong.create()), left(t('y')), t(' z')]],
            ['a host: $ is a letter to linkify', [t('see http://e.com.'), left(t('y')), t(' z')]],
            ['a user name: @ ends one', [t('see http://e.com:'), right(t('y')), t(' z')]],
            // U+FEFF is whitespace to `\s` but no separator to linkify-it, which reads on through it.
            ['a zero-width no-break space between, left', [t('a http://e.com/\uFEFF'), left(t('y')), t(' z')]],
            ['a zero-width no-break space between, right', [t('a http://e.com/\uFEFF'), right(t('y')), t(' z')]],
            // The scheme is read from the text after the note's closing marker, as the rule reads its pending text.
            ['right after a note', [t('a '), sidenote([t('r')], [t('b')]), t('http://e.com/'), left(t('y')), t(' z')]],
            // A bracket the URL opened and the sidebar's text closes: linkify reads on through the marker.
            ['a bracket closed in the sidebar', [t('a http://e.com/('), left(t('y)')), t(' z')]],
        ] as [string, Node[]][]) {
            assert.strictEqual(refusal(content), SIDEBAR_GLUED_URL, label);
            // What the refusal prevents: written anyway, the sidebar is read into the URL.
            const written = serializeDocument({ doc: schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, content)]), eol: '\n', tail: '' }, options);
            assert.notStrictEqual(shape(topChildren(parseDocument(md, written).doc)[0]), shape(schema.nodes.paragraph.create(null, content)), label);
        }
        // Where linkify reads no URL into the marker, the sidebar is written and read back.
        for (const [label, content] of [
            ['a space between', [t('a '), bare('http://e.com/'), t(' '), left(t('y')), t(' z')]],
            ['a separator between', [t('a '), bare('http://e.com/'), t('<'), left(t('y')), t(' z')]],
            ['a scheme linkify does not know', [t('a foo://e.com/'), left(t('y')), t(' z')]],
            ['the URL in a link\'s destination', [t('a '), t('x', schema.marks.link.create({ href: 'http://e.com/' })), left(t('y')), t(' z')]],
            ['the URL in code', [t('a '), t('http://e.com/', schema.marks.code.create()), left(t('y')), t(' z')]],
            // linkify-it itself says where the URL stops: before an unpaired `)`, a trailing `,`, a `)` and `**` it reads as written.
            ['a URL in parentheses', [t('a ('), bare('http://e.com'), t(')'), left(t('y')), t(' z')]],
            ['a URL before a comma', [t('a '), bare('http://e.com'), t(','), left(t('y')), t(' z')]],
            ['bold over the URL in parentheses', [t('a '), t('(', strong), schema.text('http://e.com', strong.addToSet(bare('http://e.com').marks)), t(')', strong), left(t('y')), t(' z')]],
            ['a bracket the sidebar does not close', [t('a '), bare('http://e.com/'), t('('), left(t('y z')), t(' z')]],
        ] as [string, Node[]][]) {
            assert.strictEqual(refusal(content), null, label);
            assertRoundTrip(content);
        }
        // With linkify off nothing reads a URL, so no URL refuses a sidebar (`setInlineEngine`, as the page is told).
        setInlineEngine({ ...DEFAULT_INLINE_ENGINE, linkify: false });
        try {
            assert.strictEqual(refusal([t('a '), bare('http://e.com/'), left(t('y')), t('x z')]), null);
            assert.strictEqual(refusal([t('a http://e.com/('), left(t('y)')), t(' z')]), null);
        } finally {
            setInlineEngine(DEFAULT_INLINE_ENGINE);
        }
    });

    test('code, superscript and subscript in a sidebar may hold the sidebar\'s marker: code is skipped whole, the others keep its backslash escape', () => {
        const code = schema.marks.code.create();
        const left = (...c: Node[]) => schema.nodes.left_sidebar.create(null, c);
        const right = (...c: Node[]) => schema.nodes.right_sidebar.create(null, c);
        for (const held of ['a$b', '$', 'x $ y', '$$', '$5']) {
            const content = [t('x '), left(t(held, code)), t(' y')];
            assert.strictEqual(unwritableInNote(schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, content)])), null, held);
            assertRoundTrip(content);
        }
        assertRoundTrip([t('x '), right(t('see '), t('a@b', code)), t(' y')]);
        // Superscript and subscript read no character reference (`&#36;` would stay text in them): their text keeps `\$`, which they unescape.
        const sup = schema.marks.sup.create();
        const sub = schema.marks.sub.create();
        const raised = [t('x '), left(t('a$b', sup)), t(' y')];
        assert.strictEqual(unwritableInNote(schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, raised)])), null);
        assert.strictEqual(assertRoundTrip(raised), 'x $^a\\$b^$ y\n');
        assert.strictEqual(assertRoundTrip([t('x '), right(t('see '), t('a@b', sub)), t(' y')]), 'x @see ~a\\@b~@ y\n');
    });

    test('an email address before code holding an @ is text and code, and is written back so', () => {
        const source = 'Mail a@b.c and `@x` or pay $5 for `$y`.\n';
        assert.strictEqual(shape(topChildren(parseDocument(md, source).doc)[0]), 'paragraph("Mail a@b.c and " [code]"@x" " or pay $5 for " [code]"$y" ".")');
        assert.strictEqual(assertStable(source), 'Mail a\\@b.c and `@x` or pay \\$5 for `$y`.\n');
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

    const em = () => schema.marks.em.create();
    const strong = () => schema.marks.strong.create();
    const highlight = () => schema.marks.mark.create();
    const span = () => schema.marks.attr_span.create({ literal: '{.x}' });
    const link = () => schema.marks.link.create({ href: 'https://e.org/u' });
    const key = () => schema.marks.kbd.create();

    test('marks that open on one node are opened longest run first: the one that ends later is outside', () => {
        assert.strictEqual(assertOneElementPerRun([t('a', highlight(), em()), t(' b', highlight())]), '==*a* b==\n');
        assert.strictEqual(assertOneElementPerRun([t('a', em(), strong()), t(' b', strong())]), '***a* b**\n');
    });

    test('a span at the start of a highlighted run is inside it, and the run is one', () => {
        assert.strictEqual(assertOneElementPerRun([t('a', span(), highlight()), t(' b', highlight())]), '==[a]{.x} b==\n');
        assert.strictEqual(assertOneElementPerRun([t('x '), t('a', span(), highlight()), t(' b', highlight()), t(' y')]), 'x ==[a]{.x} b== y\n');
    });

    test('a highlighted word at the start of a span is inside the span', () => {
        assert.strictEqual(assertOneElementPerRun([t('a', span(), highlight()), t(' b', span())]), '[==a== b]{.x}\n');
    });

    test('a run under both marks keeps the schema order: the span outside', () => {
        assert.strictEqual(assertOneElementPerRun([t('a', span(), highlight())]), '[==a==]{.x}\n');
    });

    test('three marks opening together nest by where each ends', () => {
        assert.strictEqual(assertOneElementPerRun([t('a', span(), em(), highlight()), t(' b', em(), highlight()), t(' c', em())]), '*==[a]{.x} b== c*\n');
        assert.strictEqual(assertOneElementPerRun([t('a', span(), em(), highlight()), t(' b', em(), highlight()), t(' c', highlight())]), '==*[a]{.x} b* c==\n');
    });

    test('a link beginning with a span or an emphasis is one link', () => {
        assert.strictEqual(assertOneElementPerRun([t('a', span(), link()), t(' b', link())]), '[[a]{.x} b](https://e.org/u)\n');
        assert.strictEqual(assertOneElementPerRun([t('a', em(), link()), t(' b', link())]), '[*a* b](https://e.org/u)\n');
    });

    test('a key cannot begin with a span or a link: the plugin counts the [[ of [[[ as a nested key, so such a run is two keys, as the page draws it', () => {
        const [fact] = topChildren(parseDocument(md, '[[[a]{.x} b]]\n').doc);
        assert.strictEqual(shape(fact), 'paragraph("[" [kbd]"a]{.x} b")', 'a key whose text begins with [ has no closing');
        const content = [t('a', span(), key()), t(' b', key())];
        assert.strictEqual(assertOneElementPerRun(content, runsIn(content) + 1), '[[[a]]]{.x}[[ b]]\n');
    });

    test('every ordered pair of mixable marks, in every position of the run, round-trips as one run of each', () => {
        const kinds: Record<string, () => ReturnType<typeof schema.mark>> = { em, strong, strike: () => schema.marks.strike.create(), mark: highlight, link, kbd: key, attr_span: span };
        const positions: Record<string, (outer: () => ReturnType<typeof schema.mark>, inner: () => ReturnType<typeof schema.mark>) => Node[]> = {
            start: (o, i) => [t('a', o(), i()), t(' b', o())],
            between: (o, i) => [t('x '), t('a', o(), i()), t(' b', o()), t(' y')],
            end: (o, i) => [t('b ', o()), t('a', o(), i())],
            middle: (o, i) => [t('b ', o()), t('a', o(), i()), t(' c', o())],
            whole: (o, i) => [t('a', o(), i())],
            startThenPlain: (o, i) => [t('a', o(), i()), t(' b', o()), t(' c')],
        };
        // A key cannot begin with a span or a link (the case above): there the run is two keys.
        const twoKeys = (outer: string, inner: string, position: string) =>
            outer === 'kbd' && (inner === 'attr_span' || inner === 'link') && position !== 'end' && position !== 'middle' && position !== 'whole';
        let oneRun = 0;
        let cases = 0;
        const failures: string[] = [];
        for (const outer of Object.keys(kinds)) {
            for (const inner of Object.keys(kinds)) {
                if (outer === inner) {
                    continue;
                }
                for (const [position, build] of Object.entries(positions)) {
                    cases++;
                    const content = build(kinds[outer], kinds[inner]);
                    const split = twoKeys(outer, inner, position);
                    try {
                        assertOneElementPerRun(content, runsIn(content) + (split ? 1 : 0));
                        oneRun += split ? 0 : 1;
                    } catch (e) {
                        failures.push(`${outer}(${inner}) ${position}: ${(e as Error).message.split('\n')[0]}`);
                    }
                }
            }
        }
        assert.deepStrictEqual(failures, [], `${oneRun} of ${cases} as one run of each`);
        assert.strictEqual(cases, 252);
        assert.strictEqual(oneRun, 246);
    });

    test('a co-opening inside a note\'s reference and body is written in order', () => {
        assert.strictEqual(assertRoundTrip([t('x '), sidenote([t('a', span(), em()), t(' b', em())], [t('body')])]), 'x ++*[a]{.x} b*|body++\n');
        assert.strictEqual(assertRoundTrip([t('x '), sidenote([t('r')], [t('a', em(), strong()), t(' b', strong())])]), 'x ++r|***a* b**++\n');
    });
});
