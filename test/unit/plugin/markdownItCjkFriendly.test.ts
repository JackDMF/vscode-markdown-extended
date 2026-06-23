import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import cjkFriendlyImport from 'markdown-it-cjk-friendly';

// The package is ESM-only; under CommonJS interop the default export may be
// nested. Normalise so the test works regardless of how it is loaded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cjkFriendly: (md: MarkdownIt.MarkdownIt) => void =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cjkFriendlyImport as any)?.default ?? cjkFriendlyImport;

suite('MarkdownItCjkFriendly Plugin Tests', () => {
    let md: MarkdownIt.MarkdownIt;
    let plain: MarkdownIt.MarkdownIt;

    setup(() => {
        plain = new MarkdownIt();
        md = new MarkdownIt();
        md.use(cjkFriendly);
    });

    test('renders emphasis adjacent to CJK punctuation that plain CommonMark misses', () => {
        // Closing "**" is preceded by a full-width period and followed by a CJK
        // character, which plain CommonMark leaves as literal asterisks.
        const input = '**\u5f37\u8abf\u3055\u308c\u307e\u3059\u3002**\u3053\u306e\u6587\u306e\u304a\u304b\u3052\u3067\u3002';

        assert.ok(
            !plain.renderInline(input).includes('<strong>'),
            'Baseline CommonMark should not emphasize this case'
        );
        assert.ok(
            md.renderInline(input).includes('<strong>'),
            'CJK-friendly plugin should emphasize this case'
        );
    });

    test('emphasizes Chinese text wrapped in **', () => {
        const input = '**\u8fd9\u662f\u4e2d\u6587**\u4e4b\u540e';
        assert.ok(md.renderInline(input).includes('<strong>\u8fd9\u662f\u4e2d\u6587</strong>'));
    });

    test('emphasizes Korean text wrapped in **', () => {
        const input = '**\ud55c\uad6d\uc5b4**\ub2e4\uc74c';
        assert.ok(md.renderInline(input).includes('<strong>\ud55c\uad6d\uc5b4</strong>'));
    });

    test('supports single-asterisk italic next to CJK', () => {
        const input = '*\u30a4\u30bf\u30ea\u30c3\u30af*\u306e\u6587';
        assert.ok(md.renderInline(input).includes('<em>\u30a4\u30bf\u30ea\u30c3\u30af</em>'));
    });

    test('does not break ASCII emphasis', () => {
        assert.ok(md.renderInline('**bold** and *italic*').includes('<strong>bold</strong>'));
        assert.ok(md.renderInline('**bold** and *italic*').includes('<em>italic</em>'));
    });

    test('leaves plain CJK text without markers untouched', () => {
        const input = '\u3053\u308c\u306f\u666e\u901a\u306e\u6587\u3067\u3059\u3002';
        const result = md.renderInline(input);
        assert.ok(!result.includes('<strong>'));
        assert.ok(!result.includes('<em>'));
        assert.strictEqual(result, input);
    });
});
