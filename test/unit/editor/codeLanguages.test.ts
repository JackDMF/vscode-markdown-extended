import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { DecorationSet } from 'prosemirror-view';
import { parseDocument } from '../../../src/editor';
import { languageOf } from '../../../src/editor/fences';
import { editorSchema } from '../../../src/editor/schema';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine } from './helpers';

const nodes = editorSchema.nodes;

/** The `<pre>` attributes the schema draws for a code block. */
const preAttrs = (node: Node): Record<string, string> => (node.type.spec.toDOM!(node) as unknown as [string, Record<string, string>])[1];

/** The `data-lang` the schema draws on each code block's `<pre>`, in document order: `''` for none. */
function drawn(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants(node => {
        if (node.type === nodes.code_block) {
            out.push(preAttrs(node)['data-lang'] ?? '');
            return false;
        }
        return true;
    });
    return out;
}

/** What the document itself says: the first word of each code block's info string, unless it opens with a brace. */
function expected(doc: Node): string[] {
    const out: string[] = [];
    doc.descendants(node => {
        if (node.type === nodes.code_block) {
            out.push(languageOf(String(node.attrs.params ?? '')));
            return false;
        }
        return true;
    });
    return out;
}

function stateOf(text: string): EditorState {
    const { doc } = parseDocument(hostEngine(), text, {});
    return EditorState.create({ doc, plugins: editorPlugins() });
}

function childPos(doc: Node, index: number): number {
    let pos = 0;
    for (let i = 0; i < index; i++) {
        pos += doc.child(i).nodeSize;
    }
    return pos;
}

const block = (params: string, text = 'x') => nodes.code_block.create({ params, markup: '```' }, text === '' ? null : editorSchema.text(text));

/**
 * The corner tag (`data-lang`, `editor.css`): drawn by the schema's `toDOM` on the block's own
 * `<pre>` — one more attribute where the node is rendered, no decoration set kept in step with
 * the document, so a key costs nothing for it however many blocks the document has.
 */
suite('Editor code blocks: the language the corner tag names', () => {
    test('toDOM draws data-lang for a fenced block that names a language, and for no other', () => {
        const state = stateOf('```js\na\n```\n\n```\nb\n```\n\n    c\n\n```{r, echo = FALSE}\nd\n```\n\n> ```py x\n> e\n> ```\n');
        assert.deepStrictEqual(drawn(state.doc), ['js', '', '', '', 'py']);
        assert.deepStrictEqual(drawn(state.doc), expected(state.doc));
    });

    test('toDOM carries the info string as data-params and the language as data-lang', () => {
        const attrs = preAttrs(block('js title=x'));
        assert.strictEqual(attrs['data-params'], 'js title=x');
        assert.strictEqual(attrs['data-lang'], 'js');
        assert.deepStrictEqual(preAttrs(block('')), {}, 'no info string, no attribute');
    });

    test('a fence added, removed, and a language changed, added or removed — by node replacement and by the attribute alone', () => {
        let state = stateOf('Before.\n\n```js\na\n```\n\n```\nb\n```\n\nAfter.\n');
        state = state.apply(state.tr.insert(childPos(state.doc, 1), block('py')));
        assert.deepStrictEqual(drawn(state.doc), ['py', 'js', '']);
        state = state.apply(state.tr.delete(childPos(state.doc, 2), childPos(state.doc, 3)));
        assert.deepStrictEqual(drawn(state.doc), ['py', '']);
        const first = childPos(state.doc, 1);
        state = state.apply(state.tr.setNodeMarkup(first, undefined, { ...state.doc.nodeAt(first)!.attrs, params: 'ts title=x' }));
        assert.deepStrictEqual(drawn(state.doc), ['ts', '']);
        const second = childPos(state.doc, 2);
        state = state.apply(state.tr.setNodeAttribute(second, 'params', 'go'));
        assert.deepStrictEqual(drawn(state.doc), ['ts', 'go']);
        state = state.apply(state.tr.setNodeAttribute(first, 'params', ''));
        assert.deepStrictEqual(drawn(state.doc), ['', 'go']);
        state = state.apply(state.tr.insertText('more ', first + 1));
        assert.deepStrictEqual(drawn(state.doc), expected(state.doc));
    });

    test('a paragraph made a fence and back, a block wrapped in a quote, the whole content replaced', () => {
        let state = stateOf('```js\na\n```\n\nPara.\n\n```ts\nb\n```\n');
        const para = childPos(state.doc, 1);
        state = state.apply(state.tr.setBlockType(para + 1, para + 1, nodes.code_block, { params: 'rb', markup: '```' }));
        assert.deepStrictEqual(drawn(state.doc), ['js', 'rb', 'ts']);
        state = state.apply(state.tr.setBlockType(para + 1, para + 1, nodes.paragraph));
        assert.deepStrictEqual(drawn(state.doc), ['js', 'ts']);
        const last = childPos(state.doc, 2);
        const lastNode = state.doc.nodeAt(last)!;
        state = state.apply(state.tr.replaceWith(last, last + lastNode.nodeSize, nodes.blockquote.create(null, lastNode)));
        assert.deepStrictEqual(drawn(state.doc), ['js', 'ts']);
        state = state.apply(state.tr.replaceWith(0, state.doc.content.size, [block('a'), block(''), block('b')]));
        assert.deepStrictEqual(drawn(state.doc), ['a', '', 'b']);
    });

    test('a document of 1000 code blocks: no plugin draws the tag, and a key in a paragraph costs what it does with no tag', () => {
        const withTags: string[] = [];
        const without: string[] = [];
        for (let i = 0; i < 1000; i++) {
            withTags.push(`Paragraph ${i}.\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n`);
            without.push(`Paragraph ${i}.\n\n\`\`\`\nconst x${i} = ${i};\n\`\`\`\n`);
        }
        const median = (times: number[]) => [...times].sort((a, b) => a - b)[times.length >> 1];
        const keys = (start: EditorState): number[] => {
            let state = start;
            const at = childPos(state.doc, 1000) + 1;
            for (let i = 0; i < 5; i++) {
                state = state.apply(state.tr.insertText('w', at));
            }
            const times: number[] = [];
            for (const key of 'abcdefghijklmnopqrst'.split('')) {
                const tr = state.tr.insertText(key, at);
                const began = performance.now();
                state = state.apply(tr);
                times.push(performance.now() - began);
            }
            return times;
        };
        const tagged = stateOf(withTags.join('\n'));
        const plain = stateOf(without.join('\n'));
        assert.strictEqual(drawn(tagged.doc).filter(l => l !== '').length, 1000);
        // No plugin of the editor offers a decoration that carries the tag: it is the schema's.
        for (const plugin of tagged.plugins) {
            const set = plugin.props.decorations?.call(plugin, tagged);
            if (set instanceof DecorationSet) {
                for (const d of set.find()) {
                    const attrs = (d as unknown as { type: { attrs?: Record<string, string> } }).type.attrs ?? {};
                    assert.ok(!('data-lang' in attrs), 'no decoration names data-lang');
                }
            }
        }
        const withMedian = median(keys(tagged));
        const withoutMedian = median(keys(plain));
        process.stdout.write(`      [codeLanguages] 1000 blocks: a key ${withMedian.toFixed(2)} ms with the tags, ${withoutMedian.toFixed(2)} ms with none\n`);
        // Generous: the two documents differ in one attribute per block, which `apply` never reads.
        assert.ok(withMedian < withoutMedian * 2 + 2, `a key costs ${withMedian.toFixed(2)} ms with tags and ${withoutMedian.toFixed(2)} ms without`);
    });
});
