import * as assert from 'assert';
import { plainTip, tipText } from '../../../src/editor/tips';

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
});
