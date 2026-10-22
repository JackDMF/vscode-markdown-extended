import * as assert from 'assert';
import { WRITE_IT_AS, attributesTitle, innerOf, isRemoval, keysFor, keysLine, literalFrom, refusalParts, stripOuterPair } from '../../../src/editor/attributeLiteral';
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

    test('refusalParts: the typed value and the suggestion in code parts, the sentence plain', () => {
        const typed = 'width = 300';
        const reason = `${typed} is text, not an attribute list: a space beside its = makes it text. ${WRITE_IT_AS}width=300.`;
        assert.deepStrictEqual(refusalParts(reason, typed), [
            { code: typed }, ' is text, not an attribute list: a space beside its = makes it text. ', WRITE_IT_AS, { code: 'width=300' }, '.',
        ]);
        assert.strictEqual(tipText({ parts: refusalParts(reason, typed) }), reason, 'the same words, drawn apart');
        assert.deepStrictEqual(refusalParts('href is the link\'s own: change it.', '.a'), ['href is the link\'s own: change it.'], 'a reason that does not start with the value has none to set');
        assert.deepStrictEqual(refusalParts('An empty value is no attribute list.', ''), ['An empty value is no attribute list.']);
    });
});
