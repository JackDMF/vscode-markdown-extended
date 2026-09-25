import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EDITABLE_TOP_NODES, ParsedDocument, fidelityPlugin, parseDocument, serializeDocument } from '../../../src/editor';
import { editorSchema } from '../../../src/editor/schema';
import { drawBlock, editorOnly, engineHtml } from './fakeDom';
import { hostEngine, topChildren, touched } from './helpers';

const options = { defaultWrap: 90 };

function write(parsed: ParsedDocument, doc = parsed.doc): string {
    return serializeDocument({ ...parsed, doc }, options);
}

/** Every top-level editable node treated as changed, so the whole document is written by rule. */
function byRule(parsed: ParsedDocument): string {
    const children = topChildren(parsed.doc).map(n => (EDITABLE_TOP_NODES.has(n.type.name) ? touched(n) : n));
    return write(parsed, parsed.doc.type.create(null, children));
}

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: [fidelityPlugin()] });
}

function text(state: EditorState): string {
    return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, options);
}

function posOf(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(needle)) {
            found = pos + (node.text ?? '').indexOf(needle);
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}" in the document`);
    return found;
}

function caretAt(state: EditorState, needle: string, offset = 0): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, needle) + offset)));
}

suite('Editor containers and admonitions: parsed as nodes that mirror the plugins\' DOM', () => {
    const md = hostEngine();
    const blocks = (source: string) => topChildren(parseDocument(md, source).doc);

    test('::: name info … ::: is a container: its name, the rest of the line verbatim, its fence; the closing fence is its last line', () => {
        const [container] = blocks('::: warning  big one\nBody.\n:::\n');
        assert.strictEqual(container.type.name, 'container');
        assert.deepStrictEqual([container.attrs.name, container.attrs.info, container.attrs.markup], ['warning', '  big one', ':::']);
        assert.strictEqual(container.attrs.src, '::: warning  big one\nBody.\n:::\n');
        assert.strictEqual(container.child(0).type.name, 'paragraph');
    });

    test('!!! type "Title" is an admonition: type, title, marker and the opening line as written', () => {
        const [titled, untitled, unquoted] = blocks('!!! warning "Mind it"\n    Body.\n\n!!! tip\n    Body.\n\n!!! note Some title\n    Body.\n');
        assert.deepStrictEqual([titled.type.name, titled.attrs.type, titled.attrs.title, titled.attrs.header], ['admonition', 'warning', 'Mind it', '!!! warning "Mind it"']);
        assert.deepStrictEqual([untitled.attrs.type, untitled.attrs.title], ['tip', '']);
        assert.deepStrictEqual([unquoted.attrs.type, unquoted.attrs.title, unquoted.attrs.header], ['note', 'Some title', '!!! note Some title']);
        assert.strictEqual(titled.childCount, 1, 'the title is an attribute, not a block of the body');
    });

    for (const [name, source] of [
        // Loose: the editor draws a tight list's items with their paragraphs, which the engine hides.
        ['a container with a nested list', '::: box wide\nText.\n\n- one\n\n- two\n:::'],
        ['a container holding a container one level deep', ':::: outer\nOuter.\n\n::: inner\nInner.\n:::\n::::'],
        ['an admonition with a title', '!!! note "A titled note"\n    Body one.\n\n    Body two.'],
        ['an admonition without a title', '!!! danger\n    Only a body.'],
        ['an admonition inside a container', '::: frame\n!!! tip "Tip"\n    Inside.\n:::'],
    ]) {
        test(`the schema draws ${name} as the engine renders it`, () => {
            const [node] = blocks(`${source}\n`);
            assert.ok(node.type.name === 'container' || node.type.name === 'admonition', node.type.name);
            assert.strictEqual(drawBlock(node).html(editorOnly), engineHtml(md.render(`${source}\n`)));
        });
    }

    test('nesting deeper than one level, equal fences, a second class, attributes on a wrapper: source blocks, each with its reason', () => {
        const reasons = (source: string) => blocks(source).map(b => b.type.name);
        assert.deepStrictEqual(reasons(':::: a\n::: b\n!!! note\n    deep\n:::\n::::\n'), ['raw_block']);
        assert.strictEqual(blocks('::: a\n::: b\nx\n:::\n:::\n')[0].type.name, 'raw_block', 'the first ::: closes the outer one');
        assert.strictEqual(blocks('!!! warning big "T"\n    x\n')[0].type.name, 'raw_block');
        assert.strictEqual(blocks('::: a {.x}\nx\n:::\n')[0].type.name, 'raw_block');
    });

    test('an untouched container or admonition is its slice; changed, it is written by rule, and that is stable', () => {
        for (const source of [
            '::: box wide\nText.\n\n- one\n- two\n:::\n',
            ':::: outer\nOuter.\n\n::: inner\nInner.\n:::\n::::\n',
            '!!! note "Title"\n    Body one.\n\n    - a\n    - b\n',
            '!!! note Unquoted title\n    Body.\n',
            '::: frame\n!!! tip "Tip"\n    Inside.\n:::\n',
            '> ::: q\n> quoted\n> :::\n',
            '- item\n\n    !!! note "In a list"\n        body\n',
        ]) {
            const parsed = parseDocument(md, source);
            assert.strictEqual(write(parsed), source, 'untouched');
            const once = byRule(parsed);
            assert.strictEqual(byRule(parseDocument(md, once)), once, `stable: ${JSON.stringify(once)}`);
            assert.deepStrictEqual(topChildren(parseDocument(md, once).doc).map(n => n.type.name), topChildren(parsed.doc).map(n => n.type.name), 'the same blocks');
        }
    });

    test('a container holding a container is written with a longer fence, and so is one holding a line of colons in code', () => {
        const outer = editorSchema.nodes.container.create({ name: 'outer', markup: ':::' }, [
            editorSchema.nodes.container.create({ name: 'inner', markup: ':::' }, editorSchema.nodes.paragraph.create(null, editorSchema.text('x'))),
        ]);
        const doc = editorSchema.topNodeType.create(null, [outer]);
        assert.strictEqual(serializeDocument({ doc, eol: '\n', tail: '' }, options), ':::: outer\n::: inner\nx\n:::\n::::\n');
        const code = editorSchema.nodes.container.create({ name: 'c' }, editorSchema.nodes.code_block.create({ markup: '```' }, editorSchema.text(':::')));
        assert.strictEqual(serializeDocument({ doc: editorSchema.topNodeType.create(null, [code]), eol: '\n', tail: '' }, options), ':::: c\n```\n:::\n```\n::::\n');
    });
});

suite('Editor block attributes: kept verbatim, written where they stood', () => {
    const md = hostEngine();
    /** The last top-level block: a rule goes after a paragraph, since `---` opening a file is front matter. */
    const last = (source: string) => topChildren(parseDocument(md, source).doc).pop() as Node;
    const first = (source: string) => topChildren(parseDocument(md, source).doc)[0];

    for (const [name, source, placement] of [
        ['a paragraph, at the end of its last line', 'Some text here. {.lead}\n', 'end'],
        ['a paragraph, on a line of its own', 'Some text\nhere\n{.aside}\n', 'line'],
        ['a list, under its last item', '- one\n- two\n{.checklist}\n', 'line'],
        ['a list, under a blank line', '1. one\n2. two\n\n{.steps}\n', 'blank'],
        ['a fence, on its opening line', '```js {.numbered}\nx\n```\n', 'end'],
        ['a rule', 'Text.\n\n--- {#cut}\n', 'end'],
    ]) {
        test(`${name}: attrsSuffix, placement ${placement}, untouched as written and stable when changed`, () => {
            const block = last(source);
            assert.notStrictEqual(block.type.name, 'raw_block', source);
            assert.strictEqual(block.attrs.attrsPlacement, placement);
            const parsed = parseDocument(md, source);
            assert.strictEqual(write(parsed), source);
            const once = byRule(parsed);
            assert.strictEqual(once, source, 'written by rule as it was written');
            assert.strictEqual(byRule(parseDocument(md, once)), once);
        });
    }

    test('a changed block keeps its literal where it stood', () => {
        let state = stateOf('Some text here. {.lead}\n\nNext\n{.aside}\n');
        state = state.apply(caretAt(state, 'here', 4).tr.insertText(' and more'));
        state = state.apply(caretAt(state, 'Next', 4).tr.insertText(' one'));
        assert.strictEqual(text(state), 'Some text here and more. {.lead}\n\nNext one\n{.aside}\n');
    });

    test('a list the literal could no longer reach through a lazy line takes the blank-line form, which reads back as the list\'s', () => {
        let state = stateOf('- one\n- two\n{.checklist}\n');
        // A second paragraph in the last item: `{…}` under it would be that paragraph's.
        state = state.apply(caretAt(state, 'two', 3).tr.split(posOf(state.doc, 'two') + 3));
        state = state.apply(state.tr.insertText('three'));
        const once = text(state);
        assert.ok(once.endsWith('\n\n{.checklist}\n'), once);
        const list = first(once);
        assert.strictEqual(list.type.name, 'bullet_list', once);
        assert.strictEqual(list.attrs.attrsSuffix, '{.checklist}');
        assert.strictEqual(list.attrs.attrsPlacement, 'blank');
    });

    test('the elements carry the attributes the engine renders', () => {
        for (const [source, tag] of [
            ['Some text here. {#p1 .lead}', 'p'],
            ['- one\n- two\n{.checklist}', 'ul'],
            ['Text.\n\n--- {#cut}', 'hr'],
            ['## A heading {.unnumbered #h}', 'h2'],
        ] as const) {
            const html = engineHtml(md.render(`${source}\n`));
            const open = new RegExp(`<${tag}[^>]*>`).exec(html)?.[0];
            const drawn = new RegExp(`<${tag}[^>]*>`).exec(drawBlock(last(`${source}\n`)).html(editorOnly))?.[0];
            assert.strictEqual(drawn, open, source);
        }
    });

    test('the second half of a split paragraph does not carry the literal again; a paragraph wrapped into a quote loses it', () => {
        let state = stateOf('Alpha beta. {#p1}\n');
        state = state.apply(state.tr.split(posOf(state.doc, 'beta')));
        assert.deepStrictEqual(topChildren(state.doc).map(n => n.attrs.attrsSuffix), ['{#p1}', null]);
        assert.strictEqual(text(state), 'Alpha {#p1}\n\nbeta.\n');

        let quoted = stateOf('Alpha beta. {.lead}\n');
        const $from = quoted.doc.resolve(1);
        const range = $from.blockRange(quoted.doc.resolve(quoted.doc.child(0).nodeSize - 1));
        assert.ok(range);
        quoted = quoted.apply(quoted.tr.wrap(range, [{ type: editorSchema.nodes.blockquote }]));
        let nested: unknown = 'unset';
        quoted.doc.descendants(n => {
            if (n.type.name === 'paragraph') {
                nested = n.attrs.attrsSuffix;
            }
        });
        assert.strictEqual(nested, null, 'the page shows what the file will hold');
    });
});
