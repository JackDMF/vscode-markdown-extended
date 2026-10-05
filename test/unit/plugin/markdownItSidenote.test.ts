import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import sidenotePlugin from '../../../src/plugin/markdownItSidenote';
import { plugins } from '../../../src/plugin/plugins';
import * as vscode from 'vscode';

suite('MarkdownItSidenote Plugin Tests', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = new MarkdownIt();
        md.use(sidenotePlugin);
    });

    suite('Sidenote Syntax (++ref|note++)', () => {
        test('should parse basic sidenote', () => {
            const result = md.render('Text ++reference|note content++ more text');
            assert.ok(result.includes('sn-ref'), 'Should contain sidenote reference class');
            assert.ok(result.includes('sidenote'), 'Should contain sidenote class');
            assert.ok(result.includes('reference'), 'Should contain reference text');
            assert.ok(result.includes('note content'), 'Should contain note content');
        });

        test('should parse sidenote with markdown in content', () => {
            const result = md.render('++ref|**bold** and *italic*++');
            assert.ok(result.includes('<strong>bold</strong>'), 'Should render bold in note');
            assert.ok(result.includes('<em>italic</em>'), 'Should render italic in note');
        });

        test('should reject sidenote without pipe separator', () => {
            const result = md.render('++no pipe here++');
            // Without pipe, it should not be parsed as sidenote
            assert.ok(!result.includes('sidenote'), 'Should not parse as sidenote without pipe');
        });

        test('should reject sidenote with empty reference text', () => {
            const result = md.render('++|note only++');
            // Empty reference should not be parsed as sidenote
            assert.ok(!result.includes('sidenote'), 'Should not parse with empty reference');
        });

        test('should handle sidenote with empty note content', () => {
            // This was causing the crash - ++ref|++ has empty note
            const result = md.render('++Phm 2|++');
            // Should either parse it or gracefully ignore, but NOT crash
            assert.ok(typeof result === 'string', 'Should return a string without crashing');
        });
    });

    suite('Marginal Note Syntax (!!ref|note!!)', () => {
        test('should parse basic marginal note', () => {
            const result = md.render('Text !!reference|note content!! more text');
            assert.ok(result.includes('mn-ref'), 'Should contain marginal note reference class');
            assert.ok(result.includes('mnote'), 'Should contain marginal note class');
        });

        test('should handle marginal note with empty note content', () => {
            const result = md.render('!!ref|!!');
            assert.ok(typeof result === 'string', 'Should return a string without crashing');
        });
    });

    suite('Left Sidebar Syntax ($content$)', () => {
        test('should parse basic left sidebar', () => {
            const result = md.render('Text $sidebar content$ more text');
            assert.ok(result.includes('left-sidebar'), 'Should contain left-sidebar class');
            assert.ok(result.includes('sidebar content'), 'Should contain sidebar content');
        });

        test('should handle left sidebar with markdown', () => {
            const result = md.render('$**bold** sidebar$');
            assert.ok(result.includes('<strong>bold</strong>'), 'Should render markdown in sidebar');
        });
    });

    suite('Right Sidebar Syntax (@content@)', () => {
        test('should parse basic right sidebar', () => {
            const result = md.render('Text @sidebar content@ more text');
            assert.ok(result.includes('right-sidebar'), 'Should contain right-sidebar class');
            assert.ok(result.includes('sidebar content'), 'Should contain sidebar content');
        });

        test('should handle right sidebar with time notation (real-world case)', () => {
            // This is from the actual document that was crashing
            const result = md.render('## WIR SIND SOLDATEN FÜR CHRISTUS @(3 Min.)@');
            assert.ok(result.includes('right-sidebar'), 'Should contain right-sidebar class');
            assert.ok(result.includes('3 Min.'), 'Should contain time notation');
        });

        test('should handle multiple right sidebars', () => {
            const result = md.render('@first@ and @second@');
            const matches = result.match(/right-sidebar/g);
            assert.strictEqual(matches?.length, 2, 'Should have two right sidebars');
        });
    });

    suite('Silent Mode (state.pos increment)', () => {
        /**
         * This test suite validates the fix for the critical bug:
         * "Error: inline rule didn't increment state.pos"
         * 
         * The bug occurred when markdown-it called tokenizers in "silent mode"
         * (validation only). The tokenizers returned true without incrementing
         * state.pos, which violated markdown-it's contract and caused infinite loops.
         */
        
        test('should not throw "inline rule didn\'t increment state.pos" error', () => {
            // This content triggered the original crash
            const problematicContent = `
# Erfüllen wir unseren Dienst und ernten die Segnungen

## WIR SIND SOLDATEN FÜR CHRISTUS @(3 Min.)@

- Paulus bezeichnete Archippus als „Mitkämpfer" Christi (++Phm 2|++)
- Wie gute Kämpfer oder Soldaten müssen Pioniere stets dienstbereit sein (++it-2 974-975|++)

## WIR MÜSSEN DIENSTBEREIT SEIN @(6 Min.)@

- Auch Pioniere haben einen Auftrag angenommen (++Gal 6:10|++; ++w09 15. 1. 14-15 Abs. 11-13|++)
`;
            
            // This should not throw any errors
            assert.doesNotThrow(() => {
                md.render(problematicContent);
            }, 'Should parse complex document without throwing');
        });

        test('should handle nested markdown parsing without infinite loop', () => {
            // Test that we don't get stuck in infinite loops
            const start = Date.now();
            const result = md.render('$left$ text @right@ more ++ref|note++ end');
            const elapsed = Date.now() - start;
            
            assert.ok(elapsed < 1000, 'Should complete in reasonable time (not stuck in loop)');
            assert.ok(typeof result === 'string', 'Should return valid string');
        });

        test('should handle deeply nested content gracefully', () => {
            // Test recursion depth limiting
            const deepNest = '++outer|++inner|++deep|content++++++;';
            assert.doesNotThrow(() => {
                md.render(deepNest);
            }, 'Should handle deep nesting without stack overflow');
        });
    });

    suite('Edge Cases', () => {
        test('should handle unclosed markers gracefully', () => {
            const result = md.render('Text ++unclosed sidenote');
            // Without closing marker, it should just be treated as plain text
            assert.ok(typeof result === 'string', 'Should handle unclosed sidenote gracefully');
        });

        test('should handle empty content between markers', () => {
            const result = md.render('$$');
            assert.ok(typeof result === 'string', 'Should handle empty sidebar');
        });

        test('should handle marker at end of line', () => {
            const result = md.render('Text ending with @sidebar@');
            assert.ok(result.includes('right-sidebar'), 'Should parse sidebar at end of line');
        });

        test('should handle consecutive sidebars', () => {
            const result = md.render('$left$$left2$@right@@right2@');
            assert.ok(typeof result === 'string', 'Should handle consecutive markers');
        });

        test('should handle special characters in content', () => {
            const result = md.render('++ref with <>&"|special chars++');
            assert.ok(typeof result === 'string', 'Should handle special characters');
        });
    });
});

// The preview's own registry, in its order, as the preview composes it.
function preview(options: MarkdownIt.Options = {}): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt({ html: true, linkify: true, ...options });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

/** The fastest of five runs of `run`, in milliseconds: the least a slow or busy machine adds. */
function fastest(run: () => void): number {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
        const started = process.hrtime.bigint();
        run();
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
}

/** The sidebars `html` holds, as `left:…`/`right:…` with their inner HTML. */
function sidebars(html: string): string[] {
    return [...html.matchAll(/<span class="(left|right)-sidebar">(.*?)<\/span>/g)].map(([, side, inner]) => `${side}:${inner}`);
}

suite('Sidebars: the closing marker is found by the inline parser, and the opening one flanks', () => {
    const md = preview();
    const inline = (text: string) => md.renderInline(text);

    test('an email address and code holding an @ make no right sidebar (the defect: a<span>b.c and `</span>x`)', () => {
        assert.strictEqual(inline('mail a@b.c and `@x`'), 'mail a@b.c and <code>@x</code>');
        assert.strictEqual(inline('mail me@example.com and `@x`'), 'mail <a href="mailto:me@example.com">me@example.com</a> and <code>@x</code>');
    });

    test('a marker after an ASCII letter or digit opens nothing, a $ before a digit closes nothing', () => {
        for (const text of ['costs $5 and $10', 'user@host and more@', 'a@b.c', 'US$5 or US$6', 'write to @{name} later', 'a@b@ c', 'Text$x$ mehr']) {
            assert.deepStrictEqual(sidebars(inline(text)), [], text);
        }
    });

    test('a character reference beside a marker counts as the character it decodes to', () => {
        for (const text of ['See REQ-&#49;$the note$ later.', 'a &#120;$y$ z', 'a &#x78;@y@ z', 'a $y$&#53; z', 'a $y$&#x35; z']) {
            assert.deepStrictEqual(sidebars(inline(text)), [], text);
        }
        assert.strictEqual(inline('a &#120;$y$ z'), 'a x$y$ z');
        // Decoding to anything but an ASCII letter or digit, escaped, or no reference at all: as before.
        assert.deepStrictEqual(sidebars(inline('a &amp;$y$ z')), ['left:y']);
        assert.deepStrictEqual(sidebars(inline('a &#233;$y$ z')), ['left:y']);
        assert.deepStrictEqual(sidebars(inline('a \\&#120;$y$ z')), ['left:y']);
        assert.deepStrictEqual(sidebars(inline('a &nosuch;$y$ z')), ['left:y']);
        assert.deepStrictEqual(sidebars(inline('a @y@&#53; z')), ['right:y'], 'an @ closes before a digit');
        assert.deepStrictEqual(sidebars(inline('a $y$&#120; z')), ['left:y'], 'a letter after a closer stops nothing');
    });

    test('beside CJK and other non-ASCII text a sidebar opens as it always did', () => {
        assert.deepStrictEqual(sidebars(inline('这是$侧边栏内容$的例子')), ['left:侧边栏内容']);
        assert.deepStrictEqual(sidebars(inline('本文@右侧注释@继续')), ['right:右侧注释']);
        assert.deepStrictEqual(sidebars(inline('é$x$ mehr')), ['left:x']);
        assert.deepStrictEqual(sidebars(inline('a @note@x and $y$z')), ['right:note', 'left:y'], 'what follows a closer may be a letter');
    });

    test('a bracketed span inside a sidebar is rendered once', () => {
        assert.strictEqual(inline('$see [x]{.c} here$'), '<span class="left-sidebar">see <span class="c">x</span> here</span>');
        assert.strictEqual(inline('[[$see [x]{.c} here$]]'), '<kbd><span class="left-sidebar">see <span class="c">x</span> here</span></kbd>');
    });

    test('many markers without a closer: four times the text grows the time about as text without markers does', () => {
        // The plugin alone: the whole registry grows faster than linearly on such text without it.
        const alone = new MarkdownIt({ html: true, linkify: true });
        alone.use(sidenotePlugin);
        // A slow machine slows both sizes alike; what is asserted is the growth, against this run's own
        // growth on text of the same length without markers. Linear is 4, quadratic 16: at most twice
        // the baseline's growth, never 10. Both sizes are long enough to be timed, so no floor hides a growth.
        const growth = (unit: string) => fastest(() => alone.render(unit.repeat(4000) + '`$@`')) / fastest(() => alone.render(unit.repeat(1000) + '`$@`'));
        for (const unit of ['$a @a ', '$x @y ', '[$a ']) {
            const baseline = growth('x'.repeat(unit.length - 1) + ' ');
            const measured = growth(unit);
            assert.ok(measured < Math.min(2 * Math.max(baseline, 4), 10), `${unit}: grew ${measured.toFixed(1)}× for four times the text; text without markers grew ${baseline.toFixed(1)}×`);
        }
    });

    test('bracketed spans nested in sidebars are not tokenized during every look-ahead', () => {
        const nested = (depth: number) => '$['.repeat(depth) + 'a' + ']{.c}$'.repeat(depth);
        // Each sidebar's look-ahead reads to its closer, past the ones nested in it: twice the depth is
        // about four times the time (the square of text without markers, which grows about 2×). When every
        // look-ahead let markdown-it-bracketed-spans tokenize, it was 15 to 18 times; 16 must fail.
        const growth = (text: (n: number) => string) => fastest(() => md.render(text(48))) / fastest(() => md.render(text(24)));
        const baseline = growth(depth => 'x'.repeat(nested(depth).length));
        const measured = growth(nested);
        assert.ok(measured < Math.min(2 * Math.max(baseline, 2) ** 2, 10), `grew ${measured.toFixed(1)}× for twice the depth; text without markers grew ${baseline.toFixed(1)}×`);
    });

    test('a URL in a sidebar ends at the sidebar\'s closing marker, as it always did, wherever the sidebar stands', () => {
        assert.strictEqual(inline('A @see https://medium.com/@user here@ and more'),
            'A <span class="right-sidebar">see <a href="https://medium.com/">https://medium.com/</a></span>user here@ and more');
        for (const before of ['A', 'Longer text']) {
            assert.strictEqual(inline(`${before} $see https://example.com/docs/$ more`),
                `${before} <span class="left-sidebar">see <a href="https://example.com/docs/">https://example.com/docs/</a></span> more`);
        }
        assert.strictEqual(inline('See @http://a.co/x@'), 'See <span class="right-sidebar"><a href="http://a.co/x">http://a.co/x</a></span>');
        // An @ of the other kind in a URL opens nothing: the URL is read whole.
        for (const before of ['a', 'Some text']) {
            assert.strictEqual(inline(`${before} $see https://medium.com/@user now$ and @r@ end.`),
                `${before} <span class="left-sidebar">see <a href="https://medium.com/@user">https://medium.com/@user</a> now</span> and <span class="right-sidebar">r</span> end.`);
        }
    });

    test('what the look-ahead learns does not leak: a sidebar nested in one is read within it, a footnote is counted once', () => {
        assert.strictEqual(inline('x $Note @costs $5 total@ end$ y'),
            'x <span class="left-sidebar">Note <span class="right-sidebar">costs $5 total</span> end</span> y');
        const html = md.render('[[$see [x^[inl] ]{.c} here$]]');
        assert.strictEqual(html.match(/class="footnote-item"/g)?.length, 1, html);
        assert.ok(html.includes('<kbd><span class="left-sidebar">see <span class="c">x<sup class="footnote-ref">'), html);
        assert.strictEqual(inline('@ [[ ab[]{.c}@'), '<span class="right-sidebar"> [[ ab<span class="c"></span></span>');
    });

    test('a rule that tokenizes while it is only asked to skip leaves no footnote behind when no sidebar closes', () => {
        // As a preview plugin from another extension may: `{{…}}` tokenized
        // whatever `silent` says, so the footnote rules list footnotes and count
        // references during a look-ahead that then finds no closer.
        const noisy = preview();
        noisy.inline.ruler.before('sidebars', 'noisy', ((inlineState: unknown) => {
            const state = inlineState as unknown as { src: string; pos: number; posMax: number; md: MarkdownIt.MarkdownIt; push(type: string, tag: string, nesting: number): unknown };
            const src = state.src;
            const end = src.indexOf('}}', state.pos + 2);
            if (src.charCodeAt(state.pos) !== 0x7b || src.charCodeAt(state.pos + 1) !== 0x7b || end === -1 || end > state.posMax) {
                return false;
            }
            const max = state.posMax;
            state.push('noisy_open', 'b', 1);
            state.pos += 2;
            state.posMax = end;
            (state.md.inline as unknown as { tokenize(s: unknown): void }).tokenize(state);
            state.posMax = max;
            state.push('noisy_close', 'b', -1);
            state.pos = end + 2;
            return true;
        }) as never);
        for (const [text, definitions] of [
            ['$a {{x[^1]}} b `$`', '\n\n[^1]: one'],
            ['[^1] $a {{x[^1]}} b `$` [^1]', '\n\n[^1]: one'],
            ['[^1] $a {{x[^2]}} b `$` [^2] [^1]', '\n\n[^1]: one\n[^2]: two'],
            ['[^1] $a {{x^[inl]}} b `$` [^1]', '\n\n[^1]: one'],
            ['$a {{x^[inl]}} b `$` and ^[after]', ''],
            ['$a @b {{x[^2]}} `@` c `$` [^2]', '\n\n[^2]: two'],
        ]) {
            // The same text with the opening marker escaped: no look-ahead at all.
            const escaped = noisy.render(text.replace('$a', '\\$a') + definitions);
            assert.strictEqual(noisy.render(text + definitions), escaped, text);
        }
    });

    test('the sidebars the corpus writes still are sidebars', () => {
        assert.deepStrictEqual(sidebars(inline('Text $sidebar content$ more @right@ end')), ['left:sidebar content', 'right:right']);
        assert.deepStrictEqual(sidebars(inline('$ left body $ and @ right body @.')), ['left: left body ', 'right: right body ']);
        assert.deepStrictEqual(sidebars(inline('WIR SIND SOLDATEN @(3 Min.)@')), ['right:(3 Min.)']);
        assert.deepStrictEqual(sidebars(inline('$left$$left2$@right@@right2@')), ['left:left', 'left:left2', 'right:right', 'right:right2']);
        assert.deepStrictEqual(sidebars(inline('a $costs $5$ b')), ['left:costs $5'], 'a $ that cannot close is the text of one');
    });

    test('a marker inside code, an autolink, inline HTML, a link or after a backslash does not close the sidebar', () => {
        assert.deepStrictEqual(sidebars(inline('$a `b$` c$')), ['left:a <code>b$</code> c']);
        assert.deepStrictEqual(sidebars(inline('@see <https://x.org/@a> now@')), ['right:see <a href="https://x.org/@a">https://x.org/@a</a> now']);
        assert.deepStrictEqual(sidebars(inline('@a <abbr title="@">b</abbr> c@')), ['right:a <abbr title="@">b</abbr> c']);
        assert.deepStrictEqual(sidebars(inline('@a [l](https://x.org/@) b@')), ['right:a <a href="https://x.org/@">l</a> b']);
        assert.deepStrictEqual(sidebars(inline('@a \\@ b@')), ['right:a @ b']);
        assert.deepStrictEqual(sidebars(inline('$a &#36; b$')), ['left:a $ b']);
    });

    test('a sidebar of the other kind inside one is read whole', () => {
        assert.deepStrictEqual(sidebars(inline('@see $x@y$ z@')), ['right:see <span class="left-sidebar">x@y']);
        assert.ok(inline('@see $x@y$ z@').includes('<span class="left-sidebar">x@y</span> z</span>'));
    });

    test('a sidebar in a link\'s text is the link\'s own; one cannot reach into a link', () => {
        assert.strictEqual(inline('[a $b$ c](u) and $x [y$](z)'), '<a href="u">a <span class="left-sidebar">b</span> c</a> and $x <a href="z">y$</a>');
    });

    test('VS Code\'s math extension claims every $ before the sidebar rule sees it; @ sidebars and email addresses are unaffected', async function () {
        const math = vscode.extensions.getExtension('vscode.markdown-math');
        if (math === undefined) {
            this.skip();
        }
        const exported = (await math.activate()) as { extendMarkdownIt?: (md: MarkdownIt.MarkdownIt) => MarkdownIt.MarkdownIt };
        if (!vscode.workspace.getConfiguration('markdown').get<boolean>('math.enabled', true) || exported?.extendMarkdownIt === undefined) {
            this.skip();
        }
        const withMath = exported.extendMarkdownIt(preview());
        const html = withMath.renderInline('$x$ and $ left $ and @right@, mail a@b.c and `@x`');
        assert.strictEqual(html.match(/<annotation encoding="application\/x-tex">/g)?.length, 2, `$x$ and $ left $ are formulas: ${html}`);
        assert.deepStrictEqual(sidebars(html), ['right:right'], 'no left sidebar');
        assert.ok(html.endsWith(', mail a@b.c and <code>@x</code>'), html);
    });
});
