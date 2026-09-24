import * as assert from 'assert';
import { Fragment, Node, Slice } from 'prosemirror-model';
import { Command, EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { editorSchema } from '../../../src/editor/schema';
import { serializeDocument } from '../../../src/editor/serialize';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { SampleSpec, TOOLBAR_ACTIONS, ToolbarAction, tooltipOf } from '../../../src/editor/webview/toolbar/actions';
import {
    REQUIREMENT_HEADING_LOCK, blockCommand, blockLockReason, freeFootnoteLabel, insertSourceTransaction, markActive, toggleMarkup,
    wrapSourceTransaction,
} from '../../../src/editor/webview/toolbar/commands';
import { ADMONITION_TYPES } from '../../../src/syntax/markers';
import { hostEngine } from './helpers';

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
        assertRendersSample(html, child, context);
    }
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
            assertRendersSample(md.render(action.example), action.sample, action.id);
            if (action.apply.kind === 'mark') {
                const rendered = /^<(\w+)>/.exec(md.renderInline(action.example));
                assert.ok(rendered, md.renderInline(action.example));
                assert.strictEqual(schemaTagOf(action), rendered[1], 'the editor draws the mark as the engine renders it');
                assert.strictEqual(action.sample.tag, rendered[1]);
            }
            assert.ok(tooltipOf(action).includes(action.syntax.split('\n')[0]), 'the tooltip names the syntax');
        });
    }

    test('the four emphasis delimiters are four actions, drawn as four elements', () => {
        const emphasis = TOOLBAR_ACTIONS.filter(a => a.apply.kind === 'mark' && a.apply.mark !== 'code');
        assert.deepStrictEqual(emphasis.map(a => [a.apply.kind === 'mark' ? a.apply.markup : null, a.sample.tag]),
            [['*', 'i'], ['_', 'em'], ['**', 'b'], ['__', 'strong']]);
    });

    test('the admonition menu lists exactly the plugin\'s types', () => {
        const listed = TOOLBAR_ACTIONS.filter(a => a.menu === 'admonition').map(a => a.id.replace(/^admonition-/, ''));
        assert.deepStrictEqual(listed, [...ADMONITION_TYPES]);
    });

    test('a source action says in its tooltip that it edits as source until stage 2', () => {
        for (const action of TOOLBAR_ACTIONS) {
            const source = action.apply.kind === 'wrap-source' || action.apply.kind === 'insert-source';
            assert.strictEqual(tooltipOf(action).includes('edits as source until stage 2'), source, action.id);
        }
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
        const apply = action('sidenote').apply;
        assert.strictEqual(apply.kind, 'wrap-source');
        const tr = wrapSourceTransaction(state, apply as Extract<typeof apply, { kind: 'wrap-source' }>, CONTEXT);
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
