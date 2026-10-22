import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, Transaction } from 'prosemirror-state';
import * as sinon from 'sinon';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { parseDocument } from '../../../src/editor';
import { languageOf } from '../../../src/editor/fences';
import { editorSchema } from '../../../src/editor/schema';
import { codeLanguagesPlugin } from '../../../src/editor/webview/plugins';
import { hostEngine } from './helpers';

const nodes = editorSchema.nodes;

/** What the plugin has drawn: each decorated block's span and its `data-lang`, in document order. */
function drawn(state: EditorState): string[] {
    const plugin = state.plugins.find(p => p.getState(state) instanceof DecorationSet);
    const set = plugin?.getState(state) as DecorationSet;
    return set.find().sort((x, y) => x.from - y.from)
        .map(d => `${d.from}-${d.to}:${(d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-lang']}`);
}

/** What a fresh plugin draws for the same document: the oracle for what the edited state holds. */
function fresh(doc: Node): string[] {
    return drawn(EditorState.create({ doc, plugins: [codeLanguagesPlugin()] }));
}

/** The expected spans by the document itself, not by the plugin: every code block that names a language. */
function expected(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants((node, pos) => {
        if (node.type === nodes.code_block) {
            const language = languageOf(String(node.attrs.params ?? ''));
            if (language !== '') {
                out.push(`${pos}-${pos + node.nodeSize}:${language}`);
            }
            return false;
        }
        return true;
    });
    return out;
}

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: [codeLanguagesPlugin()] });
}

/** `state` after `tr`, which must leave exactly what a fresh plugin draws for the new document. */
function applied(state: EditorState, tr: Transaction): EditorState {
    const next = state.apply(tr);
    assert.deepStrictEqual(drawn(next), fresh(next.doc), 'the kept set is what a fresh one draws');
    assert.deepStrictEqual(drawn(next), expected(next.doc), 'and what the document says');
    return next;
}

function childPos(doc: Node, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) {
        pos += doc.child(i).nodeSize;
    }
    return pos;
}

const block = (params: string, text = 'x', markup = '```') => nodes.code_block.create({ params, markup }, text === '' ? null : editorSchema.text(text));

/**
 * The corner tag's decorations (`codeLanguagesPlugin`): kept with the document by mapping, and
 * touched again only where an edit was — not rebuilt for every code block on every key.
 */
suite('Editor code blocks: the language decorations follow the document', () => {
    test('the plugin draws data-lang for a fenced block that names a language, and for no other', () => {
        const state = stateOf('```js\na\n```\n\n```\nb\n```\n\n    c\n\n```{r, echo = FALSE}\nd\n```\n\n> ```py x\n> e\n> ```\n');
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['js', 'py']);
        assert.deepStrictEqual(drawn(state), expected(state.doc));
    });

    test('a fence added, between neighbours that already name one, is drawn and its neighbours stay', () => {
        let state = stateOf('```js\na\n```\n\n```ts\nb\n```\n');
        state = applied(state, state.tr.insert(childPos(state.doc, 1), block('py')));
        assert.strictEqual(drawn(state).length, 3);
        // At the very start and the very end, abutting a block on one side.
        state = applied(state, state.tr.insert(0, block('rb')));
        state = applied(state, state.tr.insert(state.doc.content.size, block('go')));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]).sort(), ['go', 'js', 'py', 'rb', 'ts']);
    });

    test('a fence removed leaves its neighbours drawn, shifted', () => {
        let state = stateOf('```js\na\n```\n\n```ts\nb\n```\n\n```py\nc\n```\n');
        state = applied(state, state.tr.delete(childPos(state.doc, 1), childPos(state.doc, 2)));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]).sort(), ['js', 'py']);
        state = applied(state, state.tr.delete(0, childPos(state.doc, 1)));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['py']);
    });

    test('a language changed, added to a block with none and removed, updates data-lang; text typed inside keeps it', () => {
        let state = stateOf('Before.\n\n```js\na\n```\n\n```\nb\n```\n\nAfter.\n');
        const first = childPos(state.doc, 1);
        const second = childPos(state.doc, 2);
        state = applied(state, state.tr.setNodeMarkup(first, undefined, { ...state.doc.nodeAt(first)!.attrs, params: 'ts title=x' }));
        assert.ok(drawn(state)[0].endsWith(':ts'));
        state = applied(state, state.tr.setNodeMarkup(second, undefined, { ...state.doc.nodeAt(second)!.attrs, params: 'py' }));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['ts', 'py']);
        // The attribute alone, without a step that replaces the node.
        state = applied(state, state.tr.setNodeAttribute(first, 'params', 'go'));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['go', 'py']);
        state = applied(state, state.tr.setNodeAttribute(first, 'params', ''));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['py']);
        state = applied(state, state.tr.insertText('more ', first + 1));
        state = applied(state, state.tr.insertText('Typed. ', 1));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['py']);
    });

    test('a paragraph made a fence and back, a block wrapped in a quote and lifted out, the whole content replaced', () => {
        let state = stateOf('```js\na\n```\n\nPara.\n\n```ts\nb\n```\n');
        const para = childPos(state.doc, 1);
        state = applied(state, state.tr.setBlockType(para + 1, para + 1, nodes.code_block, { params: 'rb', markup: '```' }));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['js', 'rb', 'ts']);
        state = applied(state, state.tr.setBlockType(para + 1, para + 1, nodes.paragraph));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['js', 'ts']);
        const last = childPos(state.doc, 2);
        const lastNode = state.doc.nodeAt(last)!;
        state = applied(state, state.tr.replaceWith(last, last + lastNode.nodeSize, nodes.blockquote.create(null, lastNode)));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['js', 'ts']);
        const quote = childPos(state.doc, 2);
        state = applied(state, state.tr.replaceWith(quote, quote + state.doc.nodeAt(quote)!.nodeSize, lastNode));
        state = applied(state, state.tr.replaceWith(0, state.doc.content.size, [block('a'), block(''), block('b')]));
        assert.deepStrictEqual(drawn(state).map(s => s.split(':')[1]), ['a', 'b']);
    });

    test('a long run of seeded edits: the kept set is a fresh set after every one', () => {
        let seed = 20261022;
        const next = (n: number): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed % n;
        };
        const languages = ['', 'js', 'ts', 'py', '{r}', 'sh x'];
        let state = stateOf('P0\n\n```js\na\n```\n\nP1\n\n```\nb\n```\n\n```ts\nc\n```\n\n> ```py\n> d\n> ```\n');
        for (let i = 0; i < 400; i++) {
            const count = state.doc.childCount;
            const index = next(count);
            const pos = childPos(state.doc, index);
            const child = state.doc.child(index);
            let tr = state.tr;
            switch (next(7)) {
                case 0:
                    tr = tr.insert(pos, block(languages[next(languages.length)]));
                    break;
                case 1:
                    tr = count > 1 ? tr.delete(pos, pos + child.nodeSize) : tr.insert(pos, block('js'));
                    break;
                case 2:
                    tr = child.type === nodes.code_block ? tr.setNodeAttribute(pos, 'params', languages[next(languages.length)]) : tr.insert(pos, block('go'));
                    break;
                case 3:
                    tr = child.type === nodes.code_block ? tr.setNodeMarkup(pos, undefined, { ...child.attrs, params: languages[next(languages.length)] }) : tr;
                    break;
                case 4:
                    tr = child.isTextblock ? tr.insertText('t', pos + 1) : tr;
                    break;
                case 5:
                    tr = child.isTextblock && child.type !== nodes.code_block
                        ? tr.setBlockType(pos + 1, pos + 1, nodes.code_block, { params: languages[next(languages.length)], markup: '```' })
                        : tr.setBlockType(pos + 1, pos + 1, nodes.paragraph);
                    break;
                default:
                    tr = count > 2 && index < count - 1 ? tr.delete(pos, pos + child.nodeSize + state.doc.child(index + 1).nodeSize) : tr;
                    break;
            }
            state = applied(state, tr);
        }
    });

    test('a document of 1000 code blocks: a key in a paragraph reads no block again and costs less than building the set', () => {
        const parts: string[] = [];
        for (let i = 0; i < 1000; i++) {
            parts.push(`Paragraph ${i}.\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n`);
        }
        let state = stateOf(parts.join('\n'));
        assert.strictEqual(drawn(state).length, 1000);
        const at = childPos(state.doc, 1000) + 1;
        const median = (times: number[]) => [...times].sort((a, b) => a - b)[times.length >> 1];
        // Warm up: the first transactions pay for the engine's own compilation.
        for (let i = 0; i < 5; i++) {
            state = state.apply(state.tr.insertText('w', at));
        }
        const built = sinon.spy(Decoration, 'node');
        const created = sinon.spy(DecorationSet, 'create');
        const kept: number[] = [];
        try {
            for (const key of 'abcdefghijklmnopqrst'.split('')) {
                const tr = state.tr.insertText(key, at);
                const start = performance.now();
                state = state.apply(tr);
                kept.push(performance.now() - start);
            }
            assert.strictEqual(built.callCount, 0, 'no code block was read again');
            assert.strictEqual(created.callCount, 0, 'no set was built');
        } finally {
            built.restore();
            created.restore();
        }
        // What every key cost before: the whole set built from the document.
        const rebuilt: number[] = [];
        for (let i = 0; i < 9; i++) {
            const start = performance.now();
            EditorState.create({ doc: state.doc, plugins: [codeLanguagesPlugin()] });
            rebuilt.push(performance.now() - start);
        }
        process.stdout.write(`      [codeLanguages] 1000 blocks: a key ${median(kept).toFixed(2)} ms (worst ${Math.max(...kept).toFixed(2)}), the set built anew ${median(rebuilt).toFixed(2)} ms\n`);
        // What is left is prosemirror-view's own mapping of a thousand node decorations among two thousand siblings.
        assert.ok(median(kept) < median(rebuilt), `a key costs ${median(kept).toFixed(2)} ms, building the set ${median(rebuilt).toFixed(2)} ms`);
        assert.ok(median(kept) < 25, `a key costs ${median(kept).toFixed(2)} ms at 1000 code blocks`);
        assert.deepStrictEqual(drawn(state), fresh(state.doc), 'and what it kept is still what a fresh set draws');
    });
});
