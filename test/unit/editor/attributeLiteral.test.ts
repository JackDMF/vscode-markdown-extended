import * as assert from 'assert';
import { attributesTitle, innerOf, isRemoval, keysFor, keysLine, literalFrom, stripOuterPair } from '../../../src/editor/attributeLiteral';
import { tipText } from '../../../src/editor/tips';

/** The attributes field's spelling rules: the braces drawn by the field, the value what stands between them. */
suite('Attribute literal: what the field shows and what it commits', () => {
    test('innerOf: the literal without its outer pair; none is empty', () => {
        const rows: [string | null, string][] = [
            [null, ''],
            ['{.x #y}', '.x #y'],
            ['{title="a}"}', 'title="a}"'],
            ['{}', ''],
        ];
        for (const [literal, inner] of rows) {
            assert.strictEqual(innerOf(literal), inner, String(literal));
        }
    });

    test('stripOuterPair: one pair, only when both are there', () => {
        const rows: [string, string][] = [
            ['{.x}', '.x'],
            ['{.x', '{.x'],
            ['.x}', '.x}'],
            ['{.a} {.b}', '.a} {.b'],
            ['{', '{'],
            ['', ''],
        ];
        for (const [value, stripped] of rows) {
            assert.strictEqual(stripOuterPair(value), stripped, value);
        }
    });

    test('literalFrom: braced, a stray brace dropped; empty stays empty (a removal)', () => {
        const rows: [string, string][] = [
            ['', ''],
            ['  ', ''],
            ['.x', '{.x}'],
            ['{.x', '{.x}'],
            ['.x}', '{.x}'],
            [' .x #y ', '{.x #y}'],
        ];
        for (const [inner, literal] of rows) {
            assert.strictEqual(literalFrom(inner), literal, JSON.stringify(inner));
        }
    });

    test('isRemoval: nothing or {} removes, anything else sets', () => {
        assert.strictEqual(isRemoval(''), true);
        assert.strictEqual(isRemoval(' '), true);
        assert.strictEqual(isRemoval('{}'), true);
        assert.strictEqual(isRemoval(' {} '), true);
        assert.strictEqual(isRemoval('.x'), false);
        assert.strictEqual(isRemoval('{.x}'), false);
    });

    test('attributesTitle names the element edited', () => {
        assert.strictEqual(attributesTitle('Bold'), 'Bold · Attributes');
        assert.strictEqual(attributesTitle('Code block'), 'Code block · Attributes');
    });

    test('keysLine: the three states, the syntax or the literal in the code font', () => {
        const fresh = keysLine({ kind: 'set', hadLiteral: false });
        assert.strictEqual(tipText({ parts: fresh }), '↵ set · Esc cancel · .class #id key=value');
        assert.deepStrictEqual(fresh[fresh.length - 1], { code: '.class #id key=value' });
        assert.strictEqual(tipText({ parts: keysLine({ kind: 'set', hadLiteral: true }) }), '↵ set · Esc cancel · empty removes · .class #id key=value');
        const removes = keysLine({ kind: 'removes', literal: '.warning #intro' });
        assert.strictEqual(tipText({ parts: removes }), '↵ removes .warning #intro · Esc keeps them');
        assert.deepStrictEqual(removes[1], { code: '.warning #intro' });
    });

    test('keysFor: an existing literal emptied is removed by Enter; never one, nothing to remove', () => {
        assert.deepStrictEqual(keysFor('', '{.x}'), { kind: 'removes', literal: '.x' });
        assert.deepStrictEqual(keysFor('  ', '{.x}'), { kind: 'removes', literal: '.x' });
        assert.deepStrictEqual(keysFor('.x', '{.x}'), { kind: 'set', hadLiteral: true });
        assert.deepStrictEqual(keysFor('', null), { kind: 'set', hadLiteral: false });
        assert.deepStrictEqual(keysFor('.y', null), { kind: 'set', hadLiteral: false });
    });
});
