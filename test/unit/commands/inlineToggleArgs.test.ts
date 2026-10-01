import * as assert from 'assert';
import { inlineToggleArgs } from '../../../src/commands/inlineToggleArgs';

/**
 * The inline toggles read their markers from `src/syntax/markers.ts`. Building
 * them from the table must give each toggle the expression that finds what it
 * writes: a span of one character or more, the shortest first, guarded where a
 * single-character marker is half of another.
 */
suite('Inline toggles: built from the shared marker table', () => {
    const cases = [
        ['bold', false, /\*\*(\S(?:.*?\S)??)\*\*/ig, '**$1**'],
        ['italics', true, /(?<!\*)\*(?!\*)(\S(?:.*?\S)??)(?<!\*)\*(?!\*)/ig, '*$1*'],
        ['underline', false, /(?<!\w)_(?!_)(\S(?:.*?\S)??)(?<!_)_(?!\w)/ig, '_$1_'],
        ['mark', false, /==(\S(?:.*?\S)??)==/ig, '==$1=='],
        ['superscript', false, /\^(\S(?:.*?\S)??)\^/ig, '^$1^'],
        ['subscript', true, /(?<!~)~(?!~)(\S(?:.*?\S)??)(?<!~)~(?!~)/ig, '~$1~'],
        ['strikethrough', false, /~~(\S(?:.*?\S)??)~~/ig, '~~$1~~'],
        ['codeInline', false, /`(\S(?:.*?\S)??)`/ig, '`$1`'],
    ] as const;

    for (const [name, guarded, expression, onReplace] of cases) {
        test(`${name} detects with the expression it is meant to`, () => {
            const [detect, multiLine, on, replace, off, offReplace] = inlineToggleArgs(name, guarded);
            assert.strictEqual(detect.source, expression.source);
            assert.strictEqual(detect.flags, expression.flags);
            assert.strictEqual(multiLine, false);
            assert.strictEqual(on.source, '(.+)');
            assert.strictEqual(replace, onReplace);
            assert.strictEqual(off.source, expression.source);
            assert.notStrictEqual(off, detect, 'separate instances: a global expression keeps its lastIndex');
            assert.strictEqual(offReplace, '$1');
        });
    }

    test('a span of one character, and adjacent spans, are each found', () => {
        const [detect] = inlineToggleArgs('bold');
        assert.deepStrictEqual('**a****bc**'.match(detect), ['**a**', '**bc**']);
    });
});
