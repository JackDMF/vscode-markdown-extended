import * as assert from 'assert';
import {
    createEditorEngine,
    EDITABLE_TOP_NODES,
    ParsedDocument,
    editorSchema,
    parseDocument,
    serializeDocument,
    fidelityPlugin,
} from '../../../src/editor';
import { OrderedInlineState, serializeNode } from '../../../src/editor/serialize';
import { MarkdownSerializerState } from 'prosemirror-markdown';
import { Node } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { seamHolds } from '../../../src/editor/serialize';
import { DEFAULT_INLINE_ENGINE, createInlineEngine, readAutoLinks } from '../../../src/editor/inlineEngine';
import emojiShortcuts from 'markdown-it-emoji/lib/data/shortcuts.mjs';
import { plugins } from '../../../src/plugin/plugins';
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

    test('a re-marked list changes its item markers and nothing else: its own spelling stays, and the list after it is not touched', () => {
        for (const [source, expected] of [
            // `+`, not `*`: the list after it uses `*`, and re-marking must not join it to that one.
            ['- a\n\nMid\n\n- b\n* c\n', '- a\n\n+ b\n* c\n'],
            // An entity and a two-space hard break are the file's spelling, which a rule-written list would replace.
            ['- a\n\nMid\n\n- x &#42;y&#42;  \n  z\n- w\n', '- a\n\n* x &#42;y&#42;  \n  z\n* w\n'],
            // A nested list keeps its markers: only the list's own items are re-marked.
            ['- a\n\nMid\n\n- b\n  - inner\n', '- a\n\n* b\n  - inner\n'],
            // Lists the page holds as source blocks (task lists) are re-marked the same way.
            ['- a\n\nMid\n\n- [ ] task\n', '- a\n\n* [ ] task\n'],
            ['- [ ] a\n\nMid\n\n- [ ] b\n', '- [ ] a\n\n* [ ] b\n'],
            // `* ***` would be a thematic break, not the list: the parser refuses that marker, `+` keeps the item.
            ['- a\n\nMid\n\n- ***\n', '- a\n\n+ ***\n'],
        ] as const) {
            const out = serialize(withoutChild(parseDocument(md, source), 1));
            assert.strictEqual(out, expected);
            assert.strictEqual(serialize(parseDocument(md, out)), out);
        }
    });

    test('a block emptied to nothing leaves a new seam between its neighbours, and that seam is read: two lists stay two, two tables stay two', () => {
        for (const [source, expected] of [
            ['- a\n\nb\n- c\n', '- a\n\n* c\n'],
            ['| a |\n| - |\n| 1 |\n\nb\n| c |\n| - |\n| 2 |\n', '| a |\n| - |\n| 1 |\n\n\n| c |\n| - |\n| 2 |\n'],
        ] as const) {
            const parsed = parseDocument(md, source);
            const [first, middle, last] = topChildren(parsed.doc);
            assert.deepStrictEqual([middle.type.name, last.attrs.gap], ['paragraph', ''], source);
            const emptied = schema.nodes.paragraph.create({ ...middle.attrs, src: null });
            const out = serialize({ ...parsed, doc: parsed.doc.type.create(null, [first, emptied, last]) });
            assert.strictEqual(out, expected);
            assert.strictEqual(topChildren(parseDocument(md, out).doc).length, 2, out);
        }
    });

    test('a seam holds only where the follower is read as its own: a token opens on its line, or it yields none and leaves the leader as it read alone', () => {
        assert.strictEqual(seamHolds('- a\n', '\n', '* b\n'), true, 'another bullet starts another list');
        assert.strictEqual(seamHolds('- a\n', '\n', '- b\n'), false, 'one list crosses the line');
        assert.strictEqual(seamHolds('text\n', '\n', '[a]: http://x\n'), true, 'a reference definition yields no token and changes nothing');
        // A literal paragraph under a table yields no token either: markdown-it-attrs gives its class to the table.
        assert.strictEqual(seamHolds('| a |\n| - |\n| 1 |\n', '\n', '{.a}\n'), false, 'the table took the follower');
        assert.strictEqual(seamHolds('- x\n', '\n', '{.a}\n'), false, 'the list took the follower');
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
        const hostile = 'Price $5 @ noon, x^2, a == b, c ++ d, e !! f, <div> &amp; a*b_c [x] :smile: 1. - # > | ~ end :) ;-) <3 8-) o:) x-) :D';
        const doc = schema.topNodeType.create(null, [schema.nodes.paragraph.create({ wrapWidth: 8 }, text(hostile))]);
        const first = serialize({ doc, eol: '\n', tail: '' });
        const reparsed = parseDocument(md, first);
        const nodes = topChildren(reparsed.doc);
        assert.deepStrictEqual(nodes.map(n => n.type.name), ['paragraph'], first);
        assert.strictEqual(nodes[0].textContent, hostile);
        assert.strictEqual(serialize(allTouched(reparsed)), first);
    });

    /** A paragraph of one plain text node, as the page leaves a typed one, saved by rule. */
    const savePlain = (typed: string) => serialize({ doc: schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, text(typed))]), eol: '\n', tail: '' });
    /** Every inline token the host reads in `markdown`. */
    const inlineTokens = (markdown: string) => md.parse(markdown, {}).flatMap(t => t.children ?? []);

    test('every shortcut of markdown-it-emoji\'s table, written by the serializer, reads back on the host as the text shown', () => {
        const aliases = Object.values(emojiShortcuts as Record<string, string[]>).flat();
        assert.ok(aliases.includes(':)') && aliases.includes('<3'), 'the table is the plugin\'s');
        // Beside punctuation, a symbol the serializer escapes or a node edge the
        // host reads the shortcut; beside a letter, digit or mark it does not, and
        // `_` is punctuation whose escape makes a token edge.
        const contexts = ['A', '5$A', 'A$5', 'x*A', '(A', 'a A b', 'A.', 'a&A', 'aA', 'Aa', '1A1', 'üA', 'a_A', 'A_a'];
        const failures = aliases.flatMap(alias => contexts.map(context => {
            const shown = context.replace('A', () => alias);
            return misread(savePlain(shown), shown);
        })).filter(f => f !== null);
        assert.deepStrictEqual(failures, []);
    });

    test('a paragraph typed 5$:) on the page saves as 5\\$\\:) and that file opens editable with the same text', () => {
        const saved = savePlain('5$:)');
        assert.strictEqual(saved, '5\\$\\:)\n');
        const nodes = topChildren(parseDocument(md, saved).doc);
        assert.deepStrictEqual(nodes.map(n => n.type.name), ['paragraph']);
        assert.strictEqual(nodes[0].textContent, '5$:)');
    });

    test('a shortcut at the start of the text is escaped: ://x saves as \\://x and reads back as text', () => {
        const saved = savePlain('://x');
        assert.strictEqual(saved, '\\://x\n');
        assert.deepStrictEqual(inlineTokens(saved).map(t => `${t.type} ${t.content}`), ['text ://x']);
    });

    test('URLs typed in prose still linkify after a save: a letter before :/ leaves the shortcut unescaped', () => {
        // Not a mailto: its `@` is escaped as a sidebar marker, which keeps it from linking already.
        const typed = 'see http://x/y and https://e.com/a_b?q=1, ftp://f.org/p';
        const linkified = (markdown: string) => inlineTokens(markdown).filter(t => t.type === 'link_open' && t.markup === 'linkify').length;
        assert.strictEqual(savePlain(typed), `${typed}\n`);
        assert.strictEqual(linkified(savePlain(typed)), 3);
        assert.strictEqual(savePlain('$http://x'), '\\$http://x\n');
        assert.strictEqual(linkified(savePlain('$http://x')), 1);
    });

    /** The host's engine without markdown-it-emoji: the links it reads in the text shown, typed as it is. */
    const noEmoji = createEditorEngine({ linkify: true, typographer: false, plugins: plugins.filter(p => p.name !== 'markdown-it-emoji'), extend: [] });

    /**
     * What is wrong with `saved` as the save of a paragraph showing `shown`: an
     * emoji the host reads, another block, other text, a second save that
     * differs, or links other than those the host reads in the text shown
     * typed as it is (`noEmoji`).
     */
    function misread(saved: string, shown: string): string | null {
        const tokens = inlineTokens(saved);
        const emoji = tokens.filter(t => t.type === 'emoji').map(t => t.markup);
        const reparsed = parseDocument(md, saved);
        const nodes = topChildren(reparsed.doc);
        const kinds = nodes.map(n => n.type.name).join(',');
        const links = tokens.filter(t => t.type === 'link_open').map(t => t.attrGet('href')).join(' ');
        const linkified = noEmoji.parse(shown, {}).flatMap(t => t.children ?? []).filter(t => t.type === 'link_open').map(t => t.attrGet('href')).join(' ');
        // Not claimed: a backslash the text holds is written `\\`, an escape whose token ends
        // linkify's text before a digit (`<\3http://x` links nothing once saved), as it always was.
        const linksClaimed = !shown.includes('\\');
        if (emoji.length > 0 || kinds !== 'paragraph' || nodes[0].textContent !== shown || serialize(allTouched(reparsed)) !== saved || (linksClaimed && links !== linkified)) {
            return `${JSON.stringify(shown)} saved as ${JSON.stringify(saved)}: ${kinds}${emoji.length > 0 ? ` emoji ${emoji.join(' ')}` : ''} links [${links}] for [${linkified}]`;
        }
        return null;
    }

    test('the page\'s engine says where a bare link starts and ends: linkify\'s own edges, read by parsing', () => {
        const page = createInlineEngine(DEFAULT_INLINE_ENGINE);
        const read = (s: string) => readAutoLinks(page, s).map(l => [l.text, l.href, l.start]);
        assert.deepStrictEqual(read('http://x.com:)'), [['http://x.com', 'http://x.com', 0]]);
        assert.deepStrictEqual(read('http://x.com/p:)'), [['http://x.com/p:', 'http://x.com/p:', 0]]);
        assert.deepStrictEqual(read('ahttp://x.com'), []);
        assert.deepStrictEqual(read('a@b.com:)').length, 1);
        assert.deepStrictEqual(read('see <http://a.b> and http://a.b ok'), [['http://a.b', 'http://a.b', 5], ['http://a.b', 'http://a.b', 21]]);
        assert.deepStrictEqual(read('[http://x.com](http://x.com)'), [], 'an inline link is not one by itself');
        // Not placed where that is not certain: the text stands elsewhere too, or the parser normalised it.
        assert.deepStrictEqual(read('thttp://x.com and http://x.com:)'), [['http://x.com', 'http://x.com', null]]);
        assert.deepStrictEqual(read('see http://x.com/%41 ok'), [['http://x.com/A', 'http://x.com/%41', null]]);
    });

    /** A paragraph of `before`, a bare link to `href` and `after`: a link the page read with linkify, and text an edit put beside it. */
    const besideLink = (href: string, after: string, before = 'see ') => {
        const link = schema.marks.link.create({ href, markup: 'linkify' });
        return schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [text(before), text(href, link), text(after)])]);
    };
    /** The links the host reads in `markdown`, as `href text`. */
    const linksIn = (markdown: string) => {
        const tokens = inlineTokens(markdown);
        return tokens.flatMap((t, i) => (t.type === 'link_open' ? [`${t.attrGet('href')} ${tokens[i + 1].content}`] : []));
    };

    test('a bare link an edit glued to a letter is written [url](url): the host keeps its address, and the letter is text', () => {
        for (const [before, after, saved] of [
            ['see ', 'b ok', 'see [http://x.com](http://x.com)b ok\n'],
            ['see a', ' ok', 'see a[http://x.com](http://x.com) ok\n'],
        ] as const) {
            const out = serialize({ doc: besideLink('http://x.com', after, before), eol: '\n', tail: '' });
            assert.strictEqual(out, saved);
            assert.deepStrictEqual(linksIn(out), ['http://x.com http://x.com'], out);
            assert.strictEqual(topChildren(parseDocument(md, out).doc)[0].textContent, `${before}http://x.com${after}`, out);
        }
        // Written as a link's text, a shortcut in the address is no link's: it is escaped as in any text.
        const smiley = serialize({ doc: besideLink('http://x.com/:)', 'b ok'), eol: '\n', tail: '' });
        assert.strictEqual(smiley, 'see [http://x.com/\\:)](http://x.com/:\\))b ok\n');
        assert.ok(!inlineTokens(smiley).some(t => t.type === 'emoji'), smiley);
        assert.strictEqual(topChildren(parseDocument(md, smiley).doc)[0].textContent, 'see http://x.com/:)b ok', smiley);
        // Beside a space or punctuation linkify ends the link where the page has it: it stays bare.
        for (const [before, after] of [['see ', ' ok'], ['see (', ') ok'], ['see ', ', ok'], ['see ', '. ok']] as const) {
            assert.strictEqual(serialize({ doc: besideLink('http://x.com', after, before), eol: '\n', tail: '' }), `${before}http://x.com${after}\n`);
        }
    });

    test('a bare link inside emphasis glued to what follows the closer stays bare: the closer ends it, and the emphasis reads back', () => {
        for (const source of ['see **https://example.com**s and more\n', 'see *http://x.com*b ok\n', 'see **http://x.com**2 ok\n', 'see **http://x.com**. ok\n']) {
            assert.strictEqual(assertStable(source), source);
            const kinds = inlineTokens(source).map(t => t.type);
            assert.ok(kinds.includes('link_open') && (kinds.includes('strong_open') || kinds.includes('em_open')), source);
        }
    });

    test('a bare link the node after it would run into is written [url](url), whatever that node is', () => {
        const em = schema.marks.em.create();
        const link = schema.marks.link.create({ href: 'http://x.com/p', markup: 'linkify' });
        const emphasised = schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [text('see '), text('http://x.com/p', link), text('.'), text('b', em), text(' ok')])]);
        const out = serialize({ doc: emphasised, eol: '\n', tail: '' });
        assert.strictEqual(out, 'see [http://x.com/p](http://x.com/p).*b* ok\n');
        assert.deepStrictEqual(linksIn(out), ['http://x.com/p http://x.com/p']);
        const image = schema.nodes.image.create({ src: 'b.png', alt: 'a' });
        const pictured = serialize({ doc: schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [text('see '), text('http://x.com/p', link), image, text(' ok')])]), eol: '\n', tail: '' });
        assert.deepStrictEqual(linksIn(pictured), ['http://x.com/p http://x.com/p'], pictured);
        assert.ok(inlineTokens(pictured).some(t => t.type === 'image'), pictured);
    });

    test('a bare link is written bare only with its own address: a link whose text an edit changed keeps its href', () => {
        const out = serialize({ doc: schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [
            text('see '), text('http://e.com', schema.marks.link.create({ href: 'https://e.com', markup: 'linkify' })), text(' ok'),
        ])]), eol: '\n', tail: '' });
        assert.strictEqual(out, 'see [http://e.com](https://e.com) ok\n');
        // The page reads `%41` as `A` in a link's text; written bare, that text would be the address.
        assert.strictEqual(assertStable('see http://x.com/%41 ok\n'), 'see [http://x.com/A](http://x.com/%41) ok\n');
    });

    test('a shortcut is escaped by the links of the textblock as written: a node before it that writes no delimiter makes no URL', () => {
        const ref = schema.marks.req_ref.create({});
        for (const [nodes, shown] of [
            [[text('FRS-1', ref), text('http://x.com/:) ok')], 'FRS-1http://x.com/:) ok'],
            [[text('a', ref), text('http://x.com/:o')], 'ahttp://x.com/:o'],
        ] as const) {
            const out = serialize({ doc: schema.topNodeType.create(null, [schema.nodes.paragraph.create(null, [...nodes])]), eol: '\n', tail: '' });
            assert.ok(!inlineTokens(out).some(t => t.type === 'emoji'), out);
            assert.deepStrictEqual(topChildren(parseDocument(md, out).doc).map(n => n.type.name), ['paragraph'], out);
            assert.strictEqual(topChildren(parseDocument(md, out).doc)[0].textContent, shown, out);
        }
    });

    test('a shortcut\'s escape is the one judged for that very text: a sidebar\'s spelt markers, escapes and an image\'s alt before it move nothing', () => {
        const em = schema.marks.em.create();
        const bare = (url: string) => text(url, schema.marks.link.create({ href: url, markup: 'linkify' }));
        const image = (alt: string) => schema.nodes.image.create({ src: 'b.png', alt });
        const left = (s: string) => schema.nodes.left_sidebar.create(null, [text(s)]);
        const right = (s: string) => schema.nodes.right_sidebar.create(null, [text(s)]);
        const cases: [string, Node[]][] = [
            ['left sidebar, a $ spelt before', [text('see '), left('costs 5$ http://x.com :) b'), text(' ok')]],
            ['right sidebar, an @ spelt before', [text('see '), right('a@b http://x.com :) b'), text(' ok')]],
            ['left sidebar, three $ spelt before', [text('see '), left('a 5$ 6$ 7$ http://x.com/abc ;) b'), text(' ok')]],
            ['escapes before, emphasis between', [text('a :) x '), text('b', em), text(' see http://x.com:) ok')]],
            ['escapes before, a path', [text('a :) x '), text('b', em), text(' see http://x.com/;) ok')]],
            ['an alt before a bare link', [text('see '), image('a http://y.com:) b'), text(' '), bare('http://x.com'), text(' :) ok')]],
            ['an alt after a bare link', [text('see '), bare('http://x.com'), text(' :) '), image('a http://y.com:) b'), text(' and http://z.com:) ok')]],
        ];
        for (const [label, nodes] of cases) {
            const paragraph = schema.nodes.paragraph.create(null, nodes);
            const out = serialize({ doc: schema.topNodeType.create(null, [paragraph]), eol: '\n', tail: '' });
            const tokens = inlineTokens(out);
            assert.ok(!tokens.some(t => t.type === 'emoji'), `${label}: ${out}`);
            const back = topChildren(parseDocument(md, out).doc);
            assert.deepStrictEqual(back.map(n => n.type.name), ['paragraph'], `${label}: ${out}`);
            assert.strictEqual(back[0].textContent, paragraph.textContent, `${label}: ${out}`);
            // No backslash put into an address: the host reads each where the page has it.
            assert.ok(!linksIn(out).some(l => l.includes('%5C')), `${label}: ${out}`);
        }
    });

    test('two bare links in one word are each read where they stand: neither is rewritten', () => {
        const source = 'see http://x.com,http://y.com ok\n';
        assert.strictEqual(assertStable(source), source);
    });

    test('a shortcut beside a link whose text the parser normalises, or whose text stands elsewhere too, reads back as text, the address kept', () => {
        assert.strictEqual(misread(savePlain('thttp://x.com and http://x.com:)'), 'thttp://x.com and http://x.com:)'), null);
        // The page reads `%41` as `A` in the link's text (on master too), so a second save writes that link
        // `[…](…)` to keep its address: not compared here, the save of what was typed is.
        for (const typed of ['see :)http://x.com/%41 ok', 'see http://x.com/%41/:)/x ok']) {
            const saved = savePlain(typed);
            const hrefs = (tokens: { type: string; attrGet(name: string): string | null }[]) => tokens.filter(t => t.type === 'link_open').map(t => t.attrGet('href'));
            assert.ok(!inlineTokens(saved).some(t => t.type === 'emoji'), saved);
            assert.deepStrictEqual(hrefs(inlineTokens(saved)), hrefs(noEmoji.parse(typed, {}).flatMap(t => t.children ?? [])), saved);
            assert.deepStrictEqual(topChildren(parseDocument(md, saved).doc).map(n => n.type.name), ['paragraph'], saved);
        }
    });

    test('a shortcut typed after a bare link with a path is no part of its address: the link is written [url](url), the shortcut escaped', () => {
        const out = serialize({ doc: besideLink('http://x.com/p', ':) ok'), eol: '\n', tail: '' });
        assert.strictEqual(out, 'see [http://x.com/p](http://x.com/p)\\:) ok\n');
        assert.deepStrictEqual(linksIn(out), ['http://x.com/p http://x.com/p']);
        assert.ok(!inlineTokens(out).some(t => t.type === 'emoji'), out);
        assert.strictEqual(topChildren(parseDocument(md, out).doc)[0].textContent, 'see http://x.com/p:) ok');
    });

    test('a shortcut typed against a URL in prose is escaped at the URL\'s edge; one linkify reads into the URL is left there', () => {
        for (const [typed, saved] of [
            ['see http://x.com:) ok', 'see http://x.com\\:) ok\n'],
            ['see :)http://x.com ok', 'see \\:)http://x.com ok\n'],
            ['see http://x.com/:) ok', 'see http://x.com/:) ok\n'],
        ] as const) {
            assert.strictEqual(savePlain(typed), saved, typed);
            assert.strictEqual(misread(savePlain(typed), typed), null, typed);
        }
    });

    /**
     * After a URL with a path linkify takes almost every character in; `<`,
     * `>`, `]`, `)` and whitespace end it. Typed right after one, these two
     * shortcuts are read as an emoji however the save writes them: the
     * backslash that would break one is taken into the URL (a known limit; the
     * paragraph reopens as a source block). `>:(` after one is escaped at its
     * `:`, which linkify leaves out, and reads back.
     */
    const PATH_RESIDUE = ['</3', '<3'];
    /**
     * Read as no emoji after a URL with a path, but an escape the save writes
     * in them for another syntax — `]`, `*`, the sidebars' `@` and `$` — is
     * taken into the URL: other escapes after a path URL, a separate follow-up.
     */
    const OTHER_ESCAPE_RESIDUE = [']:(', ']:-(', ']:)', ']:-)', ':*', ':-*', ':@', ':-@', ':$', ':-$'];

    test('every shortcut of the table beside a URL typed in prose reads back as the text shown, and the URL as the link linkify reads', () => {
        // The host's linkify ends a text token at a URL's edges, where the plugin
        // looks at no neighbour: a letter beside the shortcut does not keep it text there.
        const aliases = Object.values(emojiShortcuts as Record<string, string[]>).flat();
        const contexts = ['visit http://x.comA now', 'http://x.comA', 'see http://x.com/pA ok', 'see http://x.com/p-A ok', 'https://x.de/a?b=1A',
            'http://x.com:80A', 'x Ahttp://x.com', 'Ahttp://x.com', 'Aftp://x.org', 'ftp://x.orgA', 'mailto:aA'];
        const pathContexts = ['see http://x.com/pA ok', 'see http://x.com/p-A ok', 'https://x.de/a?b=1A'];
        const failures = aliases.flatMap(alias => contexts.map(context => {
            const shown = context.replace('A', () => alias);
            const wrong = misread(savePlain(shown), shown);
            return wrong === null ? [] : [{ shown, wrong }];
        })).flat();
        const residue = [...PATH_RESIDUE, ...OTHER_ESCAPE_RESIDUE].flatMap(alias => pathContexts.map(context => context.replace('A', () => alias)));
        assert.deepStrictEqual(failures.filter(f => !residue.includes(f.shown)).map(f => f.wrong), [], 'outside the residue');
        assert.deepStrictEqual(residue.filter(r => !failures.some(f => f.shown === r)), [], 'the residue, as stated, still misread');
    });

    test('every shortcut of the table typed right after a bare link reads back as the text shown, the link kept', () => {
        const aliases = Object.values(emojiShortcuts as Record<string, string[]>).flat();
        const failures: string[] = [];
        for (const href of ['http://e.com/', 'http://e.com/p', 'http://e.com']) {
            for (const alias of aliases) {
                const saved = serialize({ doc: besideLink(href, `${alias} ok`), eol: '\n', tail: '' });
                const tokens = inlineTokens(saved);
                const links = tokens.filter(t => t.type === 'link_open').map(t => t.attrGet('href'));
                const nodes = topChildren(parseDocument(md, saved).doc);
                if (tokens.some(t => t.type === 'emoji') || nodes.length !== 1 || nodes[0].textContent !== `see ${href}${alias} ok` || links.join() !== href) {
                    failures.push(`${JSON.stringify(href)} + ${JSON.stringify(alias)} saved as ${JSON.stringify(saved)}: links ${links.join()}`);
                }
            }
        }
        assert.deepStrictEqual(failures, []);
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

    /** Whether a node of `block`'s inline content begins two marks or more at once: where the ordered state may write otherwise than the library's. */
    function coOpens(block: Node): boolean {
        const parents: Node[] = block.inlineContent ? [block] : [];
        block.descendants(node => {
            if (node.inlineContent) {
                parents.push(node);
            }
        });
        return parents.some(parent => Array.from({ length: parent.childCount }, (_, i) => i).some(i => {
            const before = i > 0 ? parent.child(i - 1).marks : [];
            return parent.child(i).marks.filter(mark => !mark.isInSet(before)).length > 1;
        }));
    }

    /** A block as the comparison sees it: each node by its type and marks, text by its string, no attributes. */
    function structure(node: Node): string {
        const marks = node.marks.map(m => m.type.name).join(',');
        if (node.isText) {
            return `[${marks}]${JSON.stringify(node.text)}`;
        }
        const inner: string[] = [];
        node.forEach(child => inner.push(structure(child)));
        return `[${marks}]${node.type.name}(${inner.join(' ')})`;
    }

    /** Each editable top-level block of `source` written by rule, through the library's own `renderInline` when `stock`. */
    function blocksWritten(source: string, stock: boolean): Array<{ text: string; coOpens: boolean; block: Node }> {
        const ordered = OrderedInlineState.prototype.renderInline;
        if (stock) {
            OrderedInlineState.prototype.renderInline = MarkdownSerializerState.prototype.renderInline;
        }
        try {
            return topChildren(parseDocument(md, source).doc)
                .filter(n => EDITABLE_TOP_NODES.has(n.type.name))
                .map(n => ({ text: serializeNode(touched(n), options), coOpens: coOpens(n), block: n }));
        } finally {
            OrderedInlineState.prototype.renderInline = ordered;
        }
    }

    test('the ordered state writes what prosemirror-markdown writes wherever no node opens two marks, and where one does what reads back: the copy of renderInline has not drifted', () => {
        const sources = [
            readText(constructsFixture),
            ...[conformanceDocument('FR-CON.md'), conformanceDocument('FR-CON.de.md')].filter(c => c.present).map(c => readText(c.file)),
            'A ==mark== here, ^sup^ and ~sub~, ~~strike~~ and [[Ctrl+S]].\n\nRich ++*em* ref|a **strong** `code` [link](x.md) body++ end.\n',
            'A key [[a *b*]], **bold *and em* inside**, *em **and bold***, [see [term]{.x}](x.md) and [[t](x.md) more]{.x}.\n',
            '- item *a* and **b**\n- [x] done ==c==\n\n> quoted *d* [e](x.md)\n\n| a | *b* |\n| - | --- |\n| `c` | ==d== |\n',
            'A ==[a]{.x} b==, **_a_ b**, [*a* b](x.md) and ~~*==a==*~~~~b~~.\n\n- ==*[a]{.x} b* c== in an item\n\n> [[*a* b]] and ++*[r]{.x} s*|*==b==* c++ quoted\n',
        ];
        let compared = 0;
        let judged = 0;
        for (const source of sources) {
            const stock = blocksWritten(source, true);
            const own = blocksWritten(source, false);
            assert.strictEqual(own.length, stock.length);
            own.forEach((written, i) => {
                if (!written.coOpens) {
                    compared++;
                    assert.strictEqual(written.text, stock[i].text);
                } else {
                    judged++;
                    const [back] = topChildren(parseDocument(md, `${written.text}\n`).doc);
                    assert.strictEqual(structure(back), structure(written.block), written.text);
                }
            });
        }
        assert.ok(compared > 30, `${compared} blocks compared`);
        assert.ok(judged >= 3, `${judged} blocks where marks open together read back`);
        // The comparison is between two writers: where two marks open together they differ.
        assert.deepStrictEqual([blocksWritten('**_a_ b**\n', true)[0].text, blocksWritten('**_a_ b**\n', false)[0].text], ['_**a**_ **b**', '**_a_ b**']);
    });

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
