import * as assert from 'assert';
import * as sinon from 'sinon';
import { ParsedDocument, parseDocument, serializeDocument } from '../../../src/editor';
import * as serializeModule from '../../../src/editor/serialize';
import { hostEngine, topChildren } from './helpers';

/**
 * The stopgap for an emoji atom the judge cannot place (`unreadEmoji` is
 * `null`): its block opens as a source block, as one holding an emoji did
 * before the editor made atoms of them (`withUnplacedAsSource` in `parse.ts`).
 */
suite('Editor: emoji atoms, review 3 — a block whose atoms cannot be placed opens as a source block', () => {
    const md = hostEngine();

    test('a block the judge cannot place an atom of, as read, opens as a source block, the others as they were', () => {
        // Constructed: no input the judge cannot place at load is known since the wrap reports its escapes, so the judge says so.
        const source = 'a :) b\n\nc :smile: d\n\ne f\n';
        const judge = serializeModule.unreadEmoji;
        const stub = sinon.stub(serializeModule, 'unreadEmoji').callsFake(block => (block.textContent.includes('a') ? null : judge(block)));
        let parsed: ParsedDocument;
        try {
            parsed = parseDocument(md, source);
        } finally {
            stub.restore();
        }
        assert.deepStrictEqual(topChildren(parsed.doc).map(n => n.type.name), ['raw_block', 'paragraph', 'paragraph']);
        assert.strictEqual(topChildren(parsed.doc)[0].attrs.src, 'a :) b\n');
        assert.ok((topChildren(parsed.doc)[0].attrs.html as string).includes('😃'), 'drawn as the preview draws it');
        assert.strictEqual(serializeDocument(parsed, { defaultWrap: 90 }), source);
        assert.deepStrictEqual(topChildren(parseDocument(md, source).doc).map(n => n.type.name), ['paragraph', 'paragraph', 'paragraph'], 'unstubbed, all three are placed');
    });

    test('blocks whose atoms can be placed open as they did: the contexts the judge places', () => {
        for (const source of ['a :) b :) c {.c}\n', '| a :) b | :) c |\n| --- | --- |\n| e | f |\n', 'x ++r|a :) b++ y\n']) {
            assert.ok(!topChildren(parseDocument(md, source).doc).some(n => n.type.name === 'raw_block'), source);
        }
    });
});
