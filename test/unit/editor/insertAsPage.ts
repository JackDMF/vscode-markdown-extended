import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { minimalReplacement } from '../../../src/editor/minimalEdit';
import { parseDocument } from '../../../src/editor/parse';
import type { InsertedBlocks } from '../../../src/editor/protocol';
import { serializeDocument } from '../../../src/editor/serialize';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { insertBlockTransaction } from '../../../src/editor/webview/toolbar/commands';

/**
 * The page's half of `insertBlock`, without a page: `file` parsed, `markdown`
 * inserted after its top-level block `after` as the page inserts it
 * (`insertBlockTransaction`), and the edit it sends — the text, and what the
 * host checks (`InsertedBlocks`): the page's document, the source block's
 * index, the text without it.
 */
export function insertAsThePage(md: MarkdownIt, file: string, markdown: string, after: number, requestId = 1): { text: string; insert: InsertedBlocks; page: Node } {
    const parsed = parseDocument(md, file, {});
    let offset = 0;
    for (let i = 0; i < after; i++) {
        offset += parsed.doc.child(i).nodeSize;
    }
    let state = EditorState.create({ doc: parsed.doc, plugins: editorPlugins() });
    state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, offset)));
    const result = insertBlockTransaction(state, markdown, parsed.eol);
    assert.ok(result, 'the page takes the block');
    const page = state.apply(result.tr).doc;
    const text = serializeDocument({ doc: page, eol: parsed.eol, tail: parsed.tail }, { defaultWrap: 90 });
    const without = minimalReplacement(text, file);
    assert.ok(without, 'the block changes the text');
    return { text, page, insert: { requestId, page: page.toJSON() as Record<string, unknown>, index: page.resolve(result.pos).index(0), without } };
}
