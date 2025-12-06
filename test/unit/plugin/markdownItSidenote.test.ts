import * as assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import sidenotePlugin from '../../../src/plugin/markdownItSidenote';

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
