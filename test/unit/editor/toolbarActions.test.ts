import * as assert from 'assert';
import * as path from 'path';
import { Fragment, Mark, Node, Slice } from 'prosemirror-model';
import { GapCursor } from 'prosemirror-gapcursor';
import { AllSelection, Command, EditorState, NodeSelection, Selection, TextSelection, Transaction } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument } from '../../../src/editor/serialize';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import {
    INCLUDE_SYNTAX, PREVIEW_CARD_CLASS, ROW_LAYOUT, SAMPLE_CLASS, SOURCE_FOOTNOTE, SampleSpec, TOOLBAR_ACTIONS, ToolbarAction, ariaLabelOf, elideDataUris, inBubble, inRow, isSourceAction, menuOf, submenuOf, tipOf,
} from '../../../src/editor/webview/toolbar/actions';
import { holderNamed, namesOf } from '../../../src/editor/inlineLiterals';
import { tipText } from '../../../src/editor/tips';
import {
    ALL_LOCK, ATOM_LOCK, GAP_LOCK, NODE_LOCK, REQUIREMENT_HEADING_LOCK, TABLE_LOCK, WHOLE_LOCK, blockCommand, blockLockReason, freeFootnoteLabel,
    insertSourceTransaction, insertWrapperTransaction, insertionPoint, markActive, toggleMarkType, toggleMarkup, wrapSourceTransaction,
} from '../../../src/editor/webview/toolbar/commands';
import { ADMONITION_FAMILIES, ADMONITION_TYPES } from '../../../src/syntax/markers';
import { HOVER_SECTION_CLASS } from '../../../src/editor/webview/languageCard';
import { hostEngine, readText, repoRoot } from './helpers';

/** The opening tags named `tag` in `html`, with their attributes. */
function openingTags(html: string, tag: string): Record<string, string>[] {
    const out: Record<string, string>[] = [];
    const re = new RegExp(`<${tag}(?=[\\s>/])([^>]*)>`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const attrs: Record<string, string> = {};
        for (const a of m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
            attrs[a[1]] = a[2] ?? '';
        }
        out.push(attrs);
    }
    return out;
}

/** Every element of the sample, with its classes and attributes, is one the rendered HTML has. */
function assertRendersSample(html: string, spec: SampleSpec, context: string): void {
    const classes = (spec.className ?? '').split(/\s+/).filter(Boolean);
    const found = openingTags(html, spec.tag).some(attrs => {
        const has = (attrs.class ?? '').split(/\s+/);
        return classes.every(c => has.includes(c))
            && Object.entries(spec.attrs ?? {}).every(([name, value]) => attrs[name] === value);
    });
    assert.ok(found, `${context}: no <${spec.tag}${classes.length ? ` class="${classes.join(' ')}"` : ''}> in ${html}`);
    for (const child of spec.children ?? []) {
        if (typeof child !== 'string') {
            assertRendersSample(html, child, context);
        }
    }
}

/** The index of the bracket closing the one at `open` in `text`. */
function closingOf(text: string, open: number): number {
    const pair: Record<string, string> = { '(': ')', '{': '}' };
    const close = pair[text[open]];
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === text[open]) {
            depth++;
        } else if (text[i] === close && --depth === 0) {
            return i;
        }
    }
    throw new Error(`unclosed ${text[open]} at ${open}`);
}

/** The bodies of the stylesheet's `@media screen and (min-width: …)` blocks: the margin layout. */
function marginBlocks(css: string): string[] {
    return [...css.matchAll(/@media screen and \(min-width:[^{]*\{/g)].map(m => {
        const open = (m.index ?? 0) + m[0].length - 1;
        return css.slice(open + 1, closingOf(css, open));
    });
}

/** The selector of every rule in a block of rules. */
function ruleSelectors(block: string): string[] {
    const out: string[] = [];
    for (let at = 0, open = block.indexOf('{'); open >= 0; at = closingOf(block, open) + 1, open = block.indexOf('{', at)) {
        out.push(block.slice(at, open).trim());
    }
    return out;
}

/** A selector without its `:has(…)` arguments, and those arguments. */
function splitHas(selector: string): { outside: string; inside: string[] } {
    const inside: string[] = [];
    let outside = '';
    let at = 0;
    for (let found = selector.indexOf(':has(', at); found >= 0; found = selector.indexOf(':has(', at)) {
        const close = closingOf(selector, found + 4);
        outside += selector.slice(at, found);
        inside.push(selector.slice(found + 5, close));
        at = close + 1;
    }
    return { outside: outside + selector.slice(at), inside };
}

function schemaTagOf(action: ToolbarAction): string {
    if (action.apply.kind !== 'mark') {
        throw new Error('not a mark action');
    }
    const type = editorSchema.marks[action.apply.mark];
    const mark = action.apply.markup === null ? type.create() : type.create({ markup: action.apply.markup });
    return (type.spec.toDOM?.(mark, true) as unknown as [string])[0];
}

/**
 * The toolbar's promise is "this button makes this element". Every action's
 * example goes through the real engine, and the sample the button is drawn as
 * must be in what it renders — so a changed plugin, class or delimiter fails
 * here rather than in front of a reader.
 */
suite('Editor toolbar: every action makes the element it shows', () => {
    const md = hostEngine();

    test('action ids are unique', () => {
        const ids = TOOLBAR_ACTIONS.map(a => a.id);
        assert.deepStrictEqual([...new Set(ids)], ids);
    });

    for (const action of TOOLBAR_ACTIONS) {
        test(`${action.id} (${action.apply.kind}): ${JSON.stringify(action.example)} renders its sample`, () => {
            if (action.apply.kind === 'insert-include') {
                // The line is the offering extension's, in its syntax: nothing
                // here can render it, so the entry claims no example, and names
                // where the line comes from instead of a syntax of its own.
                assert.strictEqual(action.example, '');
                assert.strictEqual(action.syntax, INCLUDE_SYNTAX);
                assert.ok(!/[<>{}[\]!]/.test(action.syntax), 'no directive syntax is spelled here');
                assert.strictEqual(isSourceAction(action), false, 'it becomes an expansion, not a source block');
                return;
            }
            if (action.apply.kind === 'insert-properties') {
                // Front matter renders nothing in the preview; what it makes is
                // the panel, and the fences it writes parse as front matter.
                assert.strictEqual(action.example, '');
                assert.strictEqual(md.render(`${action.syntax}\n\nText`).trim(), '<p>Text</p>');
                assert.strictEqual(parseDocument(md, `${action.syntax}\n`, {}).doc.child(0).type.name, 'front_matter');
                return;
            }
            assertRendersSample(md.render(action.example), action.sample, action.id);
            if (action.apply.kind === 'mark') {
                const rendered = /^<(\w+)>/.exec(md.renderInline(action.example));
                assert.ok(rendered, md.renderInline(action.example));
                assert.strictEqual(schemaTagOf(action), rendered[1], 'the editor draws the mark as the engine renders it');
                assert.strictEqual(action.sample.tag, rendered[1]);
            }
            if (action.apply.kind === 'wrap-node') {
                // The node the action makes draws the element the engine renders
                // its example as, and the example parses into that node.
                const type = editorSchema.nodes[action.apply.node];
                const [tag, attrs] = type.spec.toDOM?.(type.createAndFill() as Node) as unknown as [string, { class?: string }];
                assert.strictEqual(tag, action.sample.tag);
                assert.strictEqual(attrs.class, action.sample.className);
                const names: string[] = [];
                parseDocument(md, action.example, {}).doc.descendants(n => {
                    names.push(n.type.name);
                });
                assert.ok(names.includes(action.apply.node), `${action.example} parses as ${action.apply.node}: ${names.join(', ')}`);
            }
            if (action.apply.kind === 'attr-span') {
                // The span the action makes draws the element and class the
                // engine renders its example as, and the example parses into it.
                const marks: Mark[] = [];
                parseDocument(md, action.example, {}).doc.descendants(n => {
                    marks.push(...n.marks.filter(m => m.type.name === 'attr_span'));
                });
                assert.strictEqual(marks.length > 0, true, `${action.example} parses as an attribute span`);
                const [tag, attrs] = marks[0].type.spec.toDOM?.(marks[0], true) as unknown as [string, { class?: string }];
                assert.strictEqual(tag, action.sample.tag);
                assert.strictEqual(attrs.class, action.sample.className);
            }
            if (action.apply.kind === 'block-attrs') {
                // The block the example parses into carries the literal, and draws
                // the element and class the engine renders the example as.
                const block = parseDocument(md, action.example, {}).doc.child(0);
                assert.ok(action.example.endsWith(` ${block.attrs.attrsSuffix as string}`), `${action.example} carries its literal`);
                const [tag, attrs] = block.type.spec.toDOM?.(block) as unknown as [string, { class?: string }];
                assert.strictEqual(tag, action.sample.tag);
                assert.strictEqual(attrs.class, action.sample.className);
            }
            if (action.apply.kind === 'inline-attrs') {
                // The example parses into code carrying the literal, drawn as the
                // element and class the engine renders the example as.
                const marks: Mark[] = [];
                parseDocument(md, action.example, {}).doc.descendants(n => {
                    marks.push(...n.marks.filter(m => m.type.name === 'code'));
                });
                assert.strictEqual(marks[0]?.attrs.literal, '{.x}', `${action.example} parses as code carrying {.x}`);
                const [tag, attrs] = marks[0].type.spec.toDOM?.(marks[0], true) as unknown as [string, { class?: string }];
                assert.strictEqual(tag, action.sample.tag);
                assert.strictEqual(attrs.class, action.sample.className);
            }
            if (action.apply.kind === 'insert-wrapper') {
                // The node the action inserts draws the element the engine
                // renders its example as, and the example parses into that node.
                const state = EditorState.create({ doc: parseDocument(md, 'Text.\n', {}).doc });
                const inserted = state.apply(insertWrapperTransaction(state, action.apply)).doc.child(1);
                assert.strictEqual(inserted.type.name, action.apply.node);
                const [tag, attrs] = inserted.type.spec.toDOM?.(inserted) as unknown as [string, { class?: string }];
                assert.strictEqual(tag, action.sample.tag);
                assert.strictEqual(attrs.class, action.sample.className);
                const parsed = parseDocument(md, action.example, {}).doc.child(0);
                assert.strictEqual(parsed.type.name, action.apply.node, `${action.example} parses as ${action.apply.node}`);
                if (action.apply.node === 'admonition') {
                    assert.deepStrictEqual([parsed.attrs.type, parsed.attrs.title], [inserted.attrs.type, inserted.attrs.title]);
                }
            }
            const tooltipOf = (a: ToolbarAction) => tipText(tipOf(a));
            if (action.apply.kind === 'mark') {
                assert.ok(tooltipOf(action).includes(`<${action.sample.tag}>`) && tooltipOf(action).includes(action.syntax.split('text')[0]), 'the tooltip names the delimiter and the element');
            } else {
                assert.ok(tooltipOf(action).includes(action.syntax.split('\n')[0]), 'the tooltip names the syntax');
            }
        });
    }

    for (const action of TOOLBAR_ACTIONS.filter(a => a.preview)) {
        test(`${action.id}: its preview card shows what ${JSON.stringify(action.preview?.markdown)} renders`, () => {
            const html = md.render(action.preview?.markdown ?? '');
            for (const node of action.preview?.nodes ?? []) {
                assertRendersSample(html, node, `${action.id} preview`);
            }
        });
    }

    test('the row holds the five native marks; every other action is a menu entry with a preview, but the bubble\'s own {…}', () => {
        assert.deepStrictEqual(TOOLBAR_ACTIONS.filter(inRow).map(a => a.id), ['italic', 'emphasis', 'bold', 'strong', 'code']);
        assert.ok(TOOLBAR_ACTIONS.filter(inRow).every(a => a.apply.kind === 'mark'));
        const bubbleOnly = TOOLBAR_ACTIONS.filter(a => 'bubble' in a.place);
        assert.deepStrictEqual(bubbleOnly.map(a => [a.id, inBubble(a), menuOf(a)]), [['attrs-bubble', true, null]]);
        assert.strictEqual(TOOLBAR_ACTIONS.filter(inBubble).pop()?.id, 'attrs-bubble', 'last in the bubble');
        for (const action of TOOLBAR_ACTIONS.filter(a => !inRow(a) && !bubbleOnly.includes(a))) {
            assert.ok(menuOf(action) !== null, action.id);
            assert.ok(action.preview && action.preview.nodes.length > 0, `${action.id} has a preview`);
        }
        assert.deepStrictEqual(ROW_LAYOUT, [['block-type'], ['marks'], ['formatting', 'annotation', 'insert']]);
        const byMenu = (menu: string) => TOOLBAR_ACTIONS.filter(a => menuOf(a) === menu && submenuOf(a) === null).map(a => a.id);
        assert.deepStrictEqual(byMenu('formatting'), ['mark', 'superscript', 'subscript', 'strikethrough', 'kbd', 'span-class', 'inline-attributes', 'block-attributes']);
        assert.deepStrictEqual(byMenu('annotation'), ['sidenote', 'marginal-note', 'left-sidebar', 'right-sidebar', 'footnote-reference']);
        assert.deepStrictEqual(byMenu('insert'),
            ['link', 'image', 'horizontal-rule', 'table', 'container', 'task-list', 'definition-list', 'abbreviation', 'table-of-contents', 'include', 'properties']);
    });

    test('the preview card\'s class is the one both stylesheets name, and every margin rule keeps out of the card and the menus\' samples', () => {
        const notes = readText(path.join(repoRoot, 'styles', 'markdown-extended.css')).replace(/\/\*[\s\S]*?\*\//g, '');
        const guard = `:not(:is(.${PREVIEW_CARD_CLASS}, .${SAMPLE_CLASS}, .${HOVER_SECTION_CLASS}) *)`;
        const noteClass = /\.(?:sidenote|mnote|left-sidebar|right-sidebar)(?![\w-])/;
        const blocks = marginBlocks(notes);
        assert.ok(blocks.length >= 2, 'the margin layout is in min-width media blocks');
        let rules = 0;
        for (const block of blocks) {
            for (const selector of ruleSelectors(block)) {
                rules++;
                const { outside, inside } = splitHas(selector);
                for (const argument of inside) {
                    assert.ok(argument.includes(guard), `a :has() that a card's sample note would satisfy: ${selector}`);
                }
                if (noteClass.test(outside)) {
                    assert.ok(outside.includes(guard), `a margin rule that reaches the card's sample note: ${selector}`);
                }
            }
        }
        assert.ok(rules > 0);
        assert.ok(readText(path.join(repoRoot, 'styles', 'editor.css')).includes(`.${PREVIEW_CARD_CLASS} {`));
    });

    test('a note\'s glyph and its preview card draw the reference as the document does: in its anchor', () => {
        const anchorOf = (spec: SampleSpec | string): boolean =>
            typeof spec !== 'string' && (/^(?:sn|mn)-anchor$/.test(spec.className ?? '') || (spec.children ?? []).some(anchorOf));
        for (const id of ['sidenote', 'marginal-note']) {
            const action = TOOLBAR_ACTIONS.find(a => a.id === id);
            assert.ok(action && anchorOf(action.sample), `${id}: the glyph`);
            assert.ok(action.preview?.nodes.some(anchorOf), `${id}: the card`);
            assert.ok(/^(\+\+sidenote|!!marginal)\|note/.test(action.example), `${id}: the example reads the glyph's text: ${action.example}`);
        }
    });

    test('the card prints a data: URI elided, and only the printed line: the Markdown rendered keeps it', () => {
        assert.strictEqual(elideDataUris('A figure: ![A landscape](data:image/png;base64,iVBORw0KGgo+/=) here, [a](b.md)'),
            'A figure: ![A landscape](data:image/png;base64,…) here, [a](b.md)');
        const image = TOOLBAR_ACTIONS.find(a => a.id === 'image');
        assert.ok(image?.preview && image.preview.markdown.includes('base64,iVBOR'), 'the preview\'s Markdown holds the real picture');
        assert.ok(!elideDataUris(image.preview.markdown).includes('iVBOR'));
    });

    test('the four emphasis delimiters are four actions, drawn as four elements', () => {
        const emphasis = TOOLBAR_ACTIONS.filter(a => inRow(a) && a.apply.kind === 'mark' && a.apply.mark !== 'code');
        assert.deepStrictEqual(emphasis.map(a => [a.apply.kind === 'mark' ? a.apply.markup : null, a.sample.tag]),
            [['*', 'i'], ['_', 'em'], ['**', 'b'], ['__', 'strong']]);
    });

    test('the admonition menu lists exactly the plugin\'s types: the canonical ones first, then each alias naming its type', () => {
        const entries = TOOLBAR_ACTIONS.filter(a => submenuOf(a) === 'admonition');
        const listed = entries.map(a => a.id.replace(/^admonition-/, ''));
        assert.deepStrictEqual([...listed].sort(), [...ADMONITION_TYPES].sort());
        assert.deepStrictEqual(listed, [...ADMONITION_FAMILIES.map(f => f.type), ...ADMONITION_FAMILIES.flatMap(f => f.aliases)]);
        assert.deepStrictEqual(entries.filter(a => a.alias !== undefined).map(a => [a.label, a.alias]).slice(0, 2), [['Abstract', 'summary'], ['Tldr', 'summary']]);
        assert.deepStrictEqual(entries.filter(a => a.separated).map(a => a.id), ['admonition-abstract'], 'the aliases are a group of their own');
        assert.ok(entries.every(a => a.column === `!!! ${a.id.replace(/^admonition-/, '')}`), 'the column names the type, not the title it writes');
    });

    test('the row\'s marks are named and tagged by their inline holders, and name their delimiter, element and key', () => {
        const row = TOOLBAR_ACTIONS.filter(inRow);
        for (const a of row) {
            assert.ok(a.apply.kind === 'mark');
            const holder = holderNamed(a.apply.mark);
            assert.ok(holder?.tag);
            const delimiter = a.syntax.split('text')[0];
            assert.strictEqual(a.label, namesOf(holder, delimiter).label, a.id);
            assert.strictEqual(a.sample.tag, holder.tag(delimiter), a.id);
        }
        assert.deepStrictEqual(row.map(a => tipText(tipOf(a))), [
            'Italic (*, <i>) — Ctrl+I',
            'Emphasis (_, <em>)',
            'Bold (**, <b>) — Ctrl+B',
            'Strong (__, <strong>)',
            'Code (`, <code>) — Ctrl+`',
        ]);
        assert.strictEqual(tipText(tipOf(row[0], { mac: true })), 'Italic (*, <i>) — Cmd+I');
        assert.deepStrictEqual(row.map(ariaLabelOf), ['Italic, asterisk', 'Emphasis, underscore', 'Bold, double asterisk', 'Strong, double underscore', 'Code, backtick']);
        assert.deepStrictEqual(TOOLBAR_ACTIONS.filter(a => a.key !== undefined).map(a => [a.id, a.key]), [['italic', 'Mod-i'], ['bold', 'Mod-b'], ['code', 'Mod-`']], 'only marks carry a key');
        assert.strictEqual(tipText(tipOf(row[2], { reason: 'Not here.' })), 'Bold (**, <b>) — Ctrl+B\nNot here.', 'a refusal is the second line');
    });

    test('every menu entry draws its label as the element, or has its glyph decided; chrome glyphs are {…} or [ ]', () => {
        for (const a of TOOLBAR_ACTIONS.filter(x => menuOf(x) !== null)) {
            if (a.drawnLabel) {
                assert.strictEqual(menuOf(a), 'block-type', `${a.id}: only the block types draw their label`);
                continue;
            }
            assert.notStrictEqual(menuOf(a), 'block-type', `${a.id}: a block type draws its label`);
            if (a.glyph !== undefined && a.glyph !== null && 'text' in a.glyph) {
                assert.ok(['{…}', '[ ]'].includes(a.glyph.text), `${a.id}: ${a.glyph.text}`);
            }
        }
        const byMenu = (menu: string) => TOOLBAR_ACTIONS.filter(a => menuOf(a) === menu && submenuOf(a) === null && a.separated).map(a => a.id);
        assert.deepStrictEqual(byMenu('formatting'), ['span-class']);
        assert.deepStrictEqual(byMenu('annotation'), ['footnote-reference']);
        assert.deepStrictEqual(byMenu('insert'), ['horizontal-rule', 'task-list', 'include']);
        assert.deepStrictEqual(TOOLBAR_ACTIONS.filter(a => a.glyph === null).map(a => a.id), ['container', 'table-of-contents', 'include', 'properties']);
    });

    test('a source action says in its tooltip that it is edited as source; a native one does not', () => {
        for (const action of TOOLBAR_ACTIONS) {
            const source = action.apply.kind === 'wrap-source' || action.apply.kind === 'insert-source';
            assert.strictEqual(tipText(tipOf(action)).includes(SOURCE_FOOTNOTE), source, action.id);
        }
        const sourceIds = TOOLBAR_ACTIONS.filter(a => a.apply.kind === 'wrap-source').map(a => a.id);
        assert.deepStrictEqual(sourceIds, ['footnote-reference'], 'of the inline constructs only the footnote is written as source');
        const inserted = TOOLBAR_ACTIONS.filter(a => a.apply.kind === 'insert-source').map(a => a.id);
        assert.deepStrictEqual(inserted, ['task-list', 'definition-list', 'abbreviation', 'table-of-contents'],
            'admonitions, the container and the table are inserted as rich text');
    });
});

// ---------------------------------------------------------------------------

const SOURCE = [
    '## FRS-TST-001: Page {#frs-tst-001-1a2b3c4d}',
    '',
    'Alpha beta gamma.',
    '',
    'Last paragraph.',
    '',
].join('\n');

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: editorPlugins() });
}

/** The document position of `needle` inside the text of the document. */
function posOf(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && node.text?.includes(needle)) {
            found = pos + (node.text.indexOf(needle));
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}" in the document`);
    return found;
}

function select(state: EditorState, needle: string): EditorState {
    const from = posOf(state.doc, needle);
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, from + needle.length)));
}

function text(state: EditorState): string {
    return serializeDocument({ doc: state.doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
}

function run(state: EditorState, command: Command): EditorState {
    let next = state;
    assert.ok(command(state, tr => {
        next = state.apply(tr);
    }), 'the command applies');
    return next;
}

const CONTEXT = { eol: '\n' as const, defaultWrap: 90, documentText: SOURCE };

function action(id: string): ToolbarAction {
    const found = TOOLBAR_ACTIONS.find(a => a.id === id);
    assert.ok(found, id);
    return found;
}

suite('Editor toolbar: commands', () => {
    const em = editorSchema.marks.em;

    test('toggling _ on text that is * swaps the delimiter, and toggling it again removes it', () => {
        let state = select(stateOf(SOURCE), 'beta');
        state = run(state, toggleMarkup(em, '*'));
        assert.ok(markActive(state, em, '*'));
        assert.ok(text(state).includes('Alpha *beta* gamma.'), text(state));

        state = run(state, toggleMarkup(em, '_'));
        assert.ok(markActive(state, em, '_') && !markActive(state, em, '*'));
        assert.ok(text(state).includes('Alpha _beta_ gamma.'), text(state));
        let ems = 0;
        state.doc.descendants(node => {
            ems += node.marks.filter(m => m.type === em).length;
        });
        assert.strictEqual(ems, 1, 'one emphasis, not two nested');

        state = run(state, toggleMarkup(em, '_'));
        assert.ok(text(state).includes('Alpha beta gamma.'), text(state));
    });

    test('wrap-source writes the markers unescaped around the selection and makes the block a source block', () => {
        const state = select(stateOf(SOURCE), 'beta ');
        // The footnote is the one inline construct still written this way; the
        // mechanism is the same for any markers.
        const apply = { kind: 'wrap-source' as const, open: '++', close: '|note++', placeholder: '' };
        const tr = wrapSourceTransaction(state, apply, CONTEXT);
        assert.ok(tr);
        const next = state.apply(tr);
        const block = next.doc.child(1);
        assert.strictEqual(block.type.name, 'raw_block');
        assert.strictEqual(block.attrs.src, 'Alpha ++beta|note++ gamma.\n', 'the space the selection ended with stays outside');
        assert.strictEqual(block.attrs.gap, '\n', 'the blank line above it is kept');
        assert.ok(next.selection instanceof NodeSelection);
        assert.strictEqual(text(next), SOURCE.replace('beta', '++beta|note++'), 'every other byte is as it was');
    });

    test('a footnote goes after the selection with the first free label, and its definition below', () => {
        const state = select(stateOf(SOURCE), 'gamma');
        const apply = action('footnote-reference').apply as Extract<ToolbarAction['apply'], { kind: 'wrap-source' }>;
        const tr = wrapSourceTransaction(state, apply, { ...CONTEXT, documentText: `${SOURCE}[^1]: taken\n` });
        assert.ok(tr);
        const next = state.apply(tr);
        assert.strictEqual(next.doc.child(1).attrs.src, 'Alpha beta gamma[^2].\n');
        assert.strictEqual(next.doc.child(2).attrs.src, '[^2]: Footnote text\n');
        assert.strictEqual(freeFootnoteLabel('a[^1] b[^2] [^x]'), '3');
    });

    test('insert-source puts a source block with the template after the current block', () => {
        const state = select(stateOf(SOURCE), 'beta');
        const { tr, pos, src } = insertSourceTransaction(state, 'Term\n:   Definition', { ...CONTEXT, eol: '\r\n' });
        const next = state.apply(tr);
        assert.strictEqual(src, 'Term\r\n:   Definition\r\n');
        assert.strictEqual(next.doc.nodeAt(pos)?.type.name, 'raw_block');
        assert.strictEqual(next.doc.nodeAt(pos)?.attrs.src, src);
        assert.strictEqual(next.doc.child(2), next.doc.nodeAt(pos), 'right after the paragraph');
    });

    test('the block type of a requirement heading is locked, with the reason', () => {
        const parsed = parseDocument(hostEngine(), SOURCE, {});
        // As the parser leaves it when Req Explorer's badge names the artifact.
        const heading = parsed.doc.child(0);
        const lifted = heading.type.create({ ...heading.attrs, reqPrefix: 'FRS-TST-001: ' }, editorSchema.text('Page'));
        const doc = parsed.doc.replace(0, heading.nodeSize, new Slice(Fragment.from(lifted), 0, 0));
        let state = EditorState.create({ doc, plugins: editorPlugins() });
        state = select(state, 'Page');
        assert.strictEqual(blockLockReason(state), REQUIREMENT_HEADING_LOCK);
        assert.strictEqual(blockCommand('paragraph')(state), false);
        assert.strictEqual(blockCommand('heading', 3)(state), false);
        assert.strictEqual(blockCommand('blockquote')(state), false);

        const para = select(state, 'beta');
        assert.strictEqual(blockLockReason(para), null);
        const heading2 = run(para, blockCommand('heading', 2));
        assert.ok(text(heading2).includes('\n## Alpha beta gamma.\n'), text(heading2));
    });
});

suite('Editor toolbar: keys toggle by mark type, buttons by delimiter', () => {
    const em = editorSchema.marks.em;
    const strong = editorSchema.marks.strong;
    const WRITTEN = 'Plain __strong__ and _em_ and **bold** and *it*.\n';

    for (const [word, type, key, other] of [
        ['strong', strong, '**', '__'], ['bold', strong, '**', '**'],
        ['em', em, '*', '_'], ['it', em, '*', '*'],
    ] as const) {
        test(`one key press removes ${other}${word}${other}, whatever its delimiter`, () => {
            const state = run(select(stateOf(WRITTEN), word), toggleMarkType(type, key));
            assert.strictEqual(markActive(state, type, null), false);
            assert.ok(text(state).includes(` ${word} `) || text(state).includes(` ${word}.`), text(state));
        });
    }

    test('a key press on plain text adds the CommonMark delimiter', () => {
        const bolded = run(select(stateOf(WRITTEN), 'Plain'), toggleMarkType(strong, '**'));
        assert.ok(text(bolded).startsWith('**Plain** __strong__'), text(bolded));
        const italic = run(select(stateOf(WRITTEN), 'Plain'), toggleMarkType(em, '*'));
        assert.ok(text(italic).startsWith('*Plain* __strong__'), text(italic));
    });

    test('a button on another delimiter swaps it, and on its own delimiter removes it', () => {
        const swapped = run(select(stateOf(WRITTEN), 'strong'), toggleMarkup(strong, '**'));
        assert.ok(markActive(swapped, strong, '**'));
        assert.ok(text(swapped).includes('Plain **strong** and'), text(swapped));
        const removed = run(select(stateOf(WRITTEN), 'strong'), toggleMarkup(strong, '__'));
        assert.strictEqual(markActive(removed, strong, null), false);
        assert.ok(text(removed).includes('Plain strong and'), text(removed));
    });

    test('Mod-b and Mod-i in the keymap are the type toggles', () => {
        const state = select(stateOf(WRITTEN), 'strong');
        let next = state;
        const handled = state.plugins.some(plugin => plugin.props.handleKeyDown?.call(plugin, {
            state, dispatch: (tr: Transaction) => {
                next = state.apply(tr);
            },
        } as never, { key: 'b', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, keyCode: 66, type: 'keydown' } as KeyboardEvent));
        assert.ok(handled, 'the keymap takes Ctrl+B');
        assert.strictEqual(markActive(next, strong, null), false, 'one press un-bolds __strong__');
    });
});

suite('Editor toolbar: where a block is inserted, and why the block type is locked', () => {
    const docOf = (state: EditorState) => state.doc;

    test('Ctrl+A then a rule puts it after the last block; the document starts as before', () => {
        let state = stateOf(SOURCE);
        state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
        assert.strictEqual(insertionPoint(state), state.doc.content.size);
        const next = run(state, blockCommand('horizontal_rule'));
        assert.strictEqual(docOf(next).lastChild?.type.name, 'horizontal_rule');
        assert.strictEqual(text(next), `${SOURCE}\n---\n`);
    });

    test('Ctrl+A then an insert-source template puts it after the last block too', () => {
        let state = stateOf(SOURCE);
        state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));
        const { tr } = insertSourceTransaction(state, '[[TOC]]', CONTEXT);
        const next = state.apply(tr);
        assert.strictEqual(next.doc.lastChild?.attrs.src, '[[TOC]]\n');
        assert.ok(text(next).startsWith(SOURCE), text(next));
    });

    test('a selection over several blocks inserts after the last of them', () => {
        let state = stateOf(SOURCE);
        const from = posOf(state.doc, 'beta');
        const to = posOf(state.doc, 'Last') + 2;
        state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
        assert.strictEqual(insertionPoint(state), state.doc.content.size);
    });

    test('nothing is inserted before the first block, whatever stands at position 0', () => {
        // A multimd table (its `=` delimiter row): a source block, an atom at position 0.
        const withAtom = `| a |\n| = |\n| 1 |\n\n${SOURCE}`;
        let state = stateOf(withAtom);
        assert.strictEqual(state.doc.firstChild?.type.name, 'raw_block');
        state = state.apply(state.tr.setSelection(new GapCursor(state.doc.resolve(0))));
        assert.strictEqual(insertionPoint(state), state.doc.child(0).nodeSize, 'a gap cursor before the first block inserts after it');
        const next = run(state, blockCommand('horizontal_rule'));
        assert.ok(!text(next).startsWith('---'), text(next));

        const fm = stateOf(`---\ntitle: x\n---\n\n${SOURCE}`);
        const all = fm.apply(fm.tr.setSelection(TextSelection.create(fm.doc, fm.doc.child(0).nodeSize + 1)));
        assert.ok(insertionPoint(all) >= fm.doc.child(0).nodeSize, 'never before the front matter');
    });

    test('each kind of selection gets its own reason', () => {
        const base = stateOf(`| a |\n| = |\n| 1 |\n\n${SOURCE}Tail.\n\n---\n`);
        const at = (sel: Selection) => blockLockReason(base.apply(base.tr.setSelection(sel)));
        assert.strictEqual(at(NodeSelection.create(base.doc, 0)), ATOM_LOCK, 'a source block is an atom');
        const rulePos = base.doc.content.size - (base.doc.lastChild as Node).nodeSize;
        assert.strictEqual(base.doc.lastChild?.type.name, 'horizontal_rule');
        assert.strictEqual(at(NodeSelection.create(base.doc, rulePos)), NODE_LOCK, 'a rule is no atom, and no text block');
        assert.strictEqual(at(new GapCursor(base.doc.resolve(0))), GAP_LOCK);
        assert.strictEqual(at(new AllSelection(base.doc)), ALL_LOCK);
        const single = stateOf('Only.\n');
        assert.strictEqual(blockLockReason(single.apply(single.tr.setSelection(new AllSelection(single.doc)))), WHOLE_LOCK);
        const caret = posOf(base.doc, 'beta');
        assert.strictEqual(at(TextSelection.create(base.doc, caret)), null, 'text in a paragraph can be retyped');
        const table = stateOf('| a | b |\n| - | - |\n| cell | 2 |\n');
        assert.strictEqual(table.doc.firstChild?.type.name, 'table');
        assert.strictEqual(blockLockReason(table.apply(table.tr.setSelection(TextSelection.create(table.doc, posOf(table.doc, 'cell'))))), TABLE_LOCK, 'a cell is no block to retype');
    });
});
