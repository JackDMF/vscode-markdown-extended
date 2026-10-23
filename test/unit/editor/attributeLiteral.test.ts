import * as assert from 'assert';
import { attributesTip, attributesTitle, attributesTyped, holdsLiteral, innerOf, isRemoval, keysFor, keysLine, literalFrom, stripOuterPair } from '../../../src/editor/attributeLiteral';
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

    test('keysFor reads what Enter will do: a lone brace commits as a removal, so the line says it removes', () => {
        for (const typed of ['{', '}', '{}', ' { ']) {
            assert.deepStrictEqual(keysFor(typed, '{.x}'), { kind: 'removes', literal: '.x' }, JSON.stringify(typed));
            assert.strictEqual(isRemoval(literalFrom(typed)), true, `${JSON.stringify(typed)} commits as a removal`);
        }
        assert.deepStrictEqual(keysFor('{', null), { kind: 'set', hadLiteral: false }, 'nothing to remove');
        assert.deepStrictEqual(keysFor('{.y', '{.x}'), { kind: 'set', hadLiteral: true });
    });

    test('attributesTyped: "empty removes it" only where there is a literal to remove', () => {
        assert.strictEqual(attributesTyped(null), '.class #id key=value', 'a bare run: nothing to remove');
        assert.strictEqual(attributesTyped('{}'), '.class #id key=value', '{} holds nothing');
        assert.strictEqual(attributesTyped('{.x}'), '.class #id key=value; empty removes it');
        assert.strictEqual(holdsLiteral('{ }'), false);
        assert.strictEqual(holdsLiteral('{.x}'), true);
        assert.strictEqual(holdsLiteral(null), false);
        // The tooltip and the keys line read one answer.
        for (const literal of [null, '{}', '{.x}']) {
            assert.strictEqual(attributesTyped(literal).includes('empty removes'), keysFor('', literal).kind === 'removes', String(literal));
        }
    });

    test('attributesTip (#8 review 1, W1/W4): the part named, "Leave empty to remove them." only with a literal, Enter\'s verb "set"', () => {
        assert.strictEqual(attributesTip('List item', '{.lead}'), 'Attributes of List item: .class #id key=value. Leave empty to remove them. Enter to set, Esc to cancel.');
        assert.strictEqual(attributesTip('List', null), 'Attributes of List: .class #id key=value. Enter to set, Esc to cancel.');
        assert.strictEqual(attributesTip('Bold', '{.t}', ' Written right after it.'), 'Attributes of Bold: .class #id key=value. Leave empty to remove them. Written right after it. Enter to set, Esc to cancel.');
    });
});
