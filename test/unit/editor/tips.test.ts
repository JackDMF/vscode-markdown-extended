import * as assert from 'assert';
import { plainTip, said, saidText, tipText, value } from '../../../src/editor/tips';

/** A tooltip's parts as one string: what the control's `aria-description` says and the hover draws apart. */
suite('Editor tips: a tooltip as data, and as one string', () => {
    test('a mark\'s tip: the code parts bare, the keys after an em dash', () => {
        assert.strictEqual(tipText({ parts: ['Italic (', { code: '*' }, ', ', { code: '<i>' }, ')', { keys: 'Ctrl+I' }] }), 'Italic (*, <i>) — Ctrl+I');
    });

    test('a plain tip with a note: the note on a second line; without one, one line', () => {
        assert.strictEqual(tipText(plainTip('Export', 'Applies the open source box first')), 'Export\nApplies the open source box first');
        assert.strictEqual(tipText(plainTip('Export')), 'Export');
        assert.strictEqual(tipText(plainTip('Export', null)), 'Export');
    });

    test('a note of parts: its syntax in the code font to the eye, the same words to the ear; an empty one says nothing', () => {
        const note = ['Over plain text: Span with class… — ', { code: '[text]{.class}' }] as const;
        assert.strictEqual(tipText({ parts: ['Attributes — ', { code: '**text**{.class}' }], note }), 'Attributes — **text**{.class}\nOver plain text: Span with class… — [text]{.class}');
        assert.strictEqual(tipText({ parts: ['Export'], note: [] }), 'Export');
    });

    test('a value in a message: a single character quoted plain around the mono part, a longer one mono only', () => {
        assert.deepStrictEqual(value('|'), ['"', { code: '|' }, '"']);
        assert.deepStrictEqual(value('ab'), [{ code: 'ab' }]);
    });

    test('said: values stay parts, words are joined, and saidText reads it as one string', () => {
        const s = said`A ${value('|')} can't go in ${'inline code'} here — row ${3}.`;
        assert.deepStrictEqual(s, ['A "', { code: '|' }, '" can\'t go in inline code here — row 3.']);
        assert.strictEqual(saidText(s), 'A "|" can\'t go in inline code here — row 3.');
        assert.strictEqual(saidText('plain'), 'plain');
        assert.deepStrictEqual(said`Not set: ${value('width = 300')}`, ['Not set: ', { code: 'width = 300' }]);
        assert.strictEqual(tipText(plainTip('Delete row', s)), 'Delete row\nA "|" can\'t go in inline code here — row 3.');
    });
});
