import * as assert from 'assert';
import { inlineToggleArgs } from '../../../src/commands/inlineToggleArgs';

/**
 * The inline toggles read their markers from `src/syntax/markers.ts` now. These
 * are the expressions they were written out as by hand before; building them
 * from the table must not change what a toggle matches.
 */
suite('Inline toggles: built from the shared marker table', () => {
    const cases = [
        ['bold', false, /\*\*(\S.*?\S)\*\*/ig, '**$1**'],
        ['italics', true, /\*(\S.*?\S)\*(?!=\*)/ig, '*$1*'],
        ['underline', false, /_(\S.*?\S)_/ig, '_$1_'],
        ['mark', false, /==(\S.*?\S)==/ig, '==$1=='],
        ['superscript', false, /\^(\S.*?\S)\^/ig, '^$1^'],
        ['subscript', true, /~(\S.*?\S)~(?!=~)/ig, '~$1~'],
        ['strikethrough', false, /~~(\S.*?\S)~~/ig, '~~$1~~'],
        ['codeInline', false, /`(\S.*?\S)`/ig, '`$1`'],
    ] as const;

    for (const [name, guarded, expression, onReplace] of cases) {
        test(`${name} is the expression it was written as`, () => {
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
});
