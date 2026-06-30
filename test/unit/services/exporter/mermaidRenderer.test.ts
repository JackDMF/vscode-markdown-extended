import * as assert from 'assert';
import { MermaidRenderer, hasMermaid } from '../../../../src/services/exporter/mermaidRenderer';

suite('MermaidRenderer Tests', () => {
    teardown(() => {
        MermaidRenderer._reset();
    });

    test('hasMermaid detects a mermaid pre block', () => {
        assert.ok(hasMermaid('<pre class="mermaid">graph TD;A--&gt;B</pre>'));
        assert.ok(hasMermaid('<pre class="foo mermaid" data-x="1">x</pre>'), 'should match extra classes/attrs');
        assert.ok(hasMermaid('<PRE CLASS="MERMAID">x</PRE>'), 'should be case-insensitive');
    });

    test('hasMermaid is false when there is no mermaid block', () => {
        assert.strictEqual(hasMermaid('<pre><code>graph TD</code></pre>'), false);
        assert.strictEqual(hasMermaid('<p>the word mermaid appears here</p>'), false);
        assert.strictEqual(hasMermaid(''), false);
    });

    test('process returns html unchanged and does NOT invoke the renderer when no mermaid present', async () => {
        let called = false;
        const html = '<p>hello world</p>';
        const result = await MermaidRenderer.instance.process(html, async () => {
            called = true;
            return 'SHOULD_NOT_HAPPEN';
        });
        assert.strictEqual(result, html);
        assert.strictEqual(called, false, 'the page renderer must not run for non-mermaid documents');
    });

    test('process uses the page renderer to inline SVG when mermaid is present', async () => {
        const html = '<pre class="mermaid">graph TD;A--&gt;B</pre>';
        const rendered = '<div class="mermaid"><svg id="rendered"></svg></div>';
        const result = await MermaidRenderer.instance.process(html, async () => rendered);
        assert.strictEqual(result, rendered);
    });

    test('process falls back to the original html when the renderer throws', async () => {
        const html = '<pre class="mermaid">not-a-valid-diagram</pre>';
        const result = await MermaidRenderer.instance.process(html, async () => {
            throw new Error('boom');
        });
        assert.strictEqual(result, html, 'export must never hard-fail because of mermaid');
    });

    test('instance is a singleton and _reset clears it', () => {
        const a = MermaidRenderer.instance;
        const b = MermaidRenderer.instance;
        assert.strictEqual(a, b);
        MermaidRenderer._reset();
        assert.notStrictEqual(a, MermaidRenderer.instance);
    });
});
