import * as assert from 'assert';
import { VALUE_PREDICATE, WRITE_IT_AS, attributesTitle, attributesTyped, holdsLiteral, innerOf, isRemoval, keysFor, keysLine, literalFrom, refusalParts, stripOuterPair } from '../../../src/editor/attributeLiteral';
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

    test('refusalParts: the value is set apart only where a refusal names it, not where a sentence merely begins with the same letters', () => {
        // Typing `A` in a quote: a reason that opens "A quote's …" is prose, not the value `A` followed by words about it.
        const prose = 'A quote\'s literal is written under its last line, which the preview would read as text.';
        assert.deepStrictEqual(refusalParts(prose, 'A'), [prose], 'plain, though it starts with the typed A');
        // The same value where a refusal does name it: set apart, whatever follows (each predicate the messages are built with).
        for (const predicate of Object.values(VALUE_PREDICATE)) {
            const reason = `A ${predicate} here.`;
            assert.deepStrictEqual(refusalParts(reason, 'A'), [{ code: 'A' }, ` ${predicate} here.`], predicate);
        }
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
});
