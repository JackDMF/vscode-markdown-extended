import * as assert from 'assert';
import * as sinon from 'sinon';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContributorService, ContributorType, IContributor, dedupeContributeFiles, partitionDedupedStyleFiles } from '../../../../src/services/contributes/contributorService';

suite('ContributorService Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        ContributorService._reset();
    });

    teardown(() => {
        sandbox.restore();
        ContributorService._reset();
    });

    test('should be a singleton', () => {
        const instance1 = ContributorService.instance;
        const instance2 = ContributorService.instance;
        
        assert.strictEqual(instance1, instance2, 'Should return same instance');
    });

    test('should provide getStyles method', () => {
        const instance = ContributorService.instance;
        
        assert.strictEqual(typeof instance.getStyles, 'function', 'Should have getStyles method');
        
        const styles = instance.getStyles();
        assert.ok(Array.isArray(styles), 'getStyles should return an array');
    });

    test('should provide getScripts method', () => {
        const instance = ContributorService.instance;
        
        assert.strictEqual(typeof instance.getScripts, 'function', 'Should have getScripts method');
        
        const scripts = instance.getScripts();
        assert.ok(Array.isArray(scripts), 'getScripts should return an array');
    });

    test('should filter styles by contributor type', () => {
        const instance = ContributorService.instance;
        
        // Get official styles
        const officialStyles = instance.getStyles(c => c.type === ContributorType.Official);
        assert.ok(Array.isArray(officialStyles), 'Should return array for official styles');
        
        // Get third-party styles
        const thirdPartyStyles = instance.getStyles(c => c.type === ContributorType.ThirdParty);
        assert.ok(Array.isArray(thirdPartyStyles), 'Should return array for third-party styles');
    });

    test('should filter scripts by contributor type', () => {
        const instance = ContributorService.instance;
        
        // Get official scripts
        const officialScripts = instance.getScripts(c => c.type === ContributorType.Official);
        assert.ok(Array.isArray(officialScripts), 'Should return array for official scripts');
        
        // Get third-party scripts
        const thirdPartyScripts = instance.getScripts(c => c.type === ContributorType.ThirdParty);
        assert.ok(Array.isArray(thirdPartyScripts), 'Should return array for third-party scripts');
    });

    test('_reset should clear singleton instance', () => {
        const instance1 = ContributorService.instance;
        
        ContributorService._reset();
        const instance2 = ContributorService.instance;
        
        assert.notStrictEqual(instance1, instance2, 'Should create new instance after reset');
    });

    test('ContributorType enum should have correct values', () => {
        assert.strictEqual(ContributorType.Unknown, 0, 'Unknown should be 0');
        assert.strictEqual(ContributorType.Official, 1, 'Official should be 1');
        assert.strictEqual(ContributorType.ThirdParty, 2, 'ThirdParty should be 2');
    });

    test('should handle empty filter for getStyles', () => {
        const instance = ContributorService.instance;
        
        const allStyles = instance.getStyles();
        const filteredStyles = instance.getStyles(undefined);
        
        // Both should return arrays (behavior should be same)
        assert.ok(Array.isArray(allStyles), 'Should return array without filter');
        assert.ok(Array.isArray(filteredStyles), 'Should return array with undefined filter');
    });

    test('should handle custom filter function', () => {
        const instance = ContributorService.instance;
        
        // Custom filter: only contributors with at least one style
        const customFilter = (c: IContributor) => c.styles.length > 0;
        const styles = instance.getStyles(customFilter);
        
        assert.ok(Array.isArray(styles), 'Should return array with custom filter');
    });

    test('getScripts and getStyles should return independent results', () => {
        const instance = ContributorService.instance;
        
        const styles = instance.getStyles();
        const scripts = instance.getScripts();
        
        // Both should be arrays but potentially different content
        assert.ok(Array.isArray(styles), 'Styles should be array');
        assert.ok(Array.isArray(scripts), 'Scripts should be array');
    });

    test('dedupeContributeFiles collapses identical content, keeping the last occurrence', () => {
        // KaTeX is shipped byte-for-byte identical by more than one extension.
        // Keeping the *last* copy preserves the CSS cascade (later styles win).
        const input = [
            '/ext-a/node_modules/katex/dist/katex.min.css',
            '/ext-c/media/markdown.css',
            '/ext-b/notebook-out/katex.min.css',
        ];
        // Stub the key fn to simulate identical content for the two katex files.
        const keyOf = (f: string) => path.basename(f).toLowerCase();
        assert.deepStrictEqual(
            dedupeContributeFiles(input, keyOf),
            [
                '/ext-c/media/markdown.css',
                '/ext-b/notebook-out/katex.min.css',
            ],
            'the earlier identical katex.min.css should be dropped, last kept'
        );
    });

    test('dedupeContributeFiles keeps distinct files that share a base name', () => {
        // Two extensions each ship their own `markdown.css` with different content,
        // so *both* must survive. Regression test for 2.7.0, where blockquote
        // padding vanished because one was dropped purely by name.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mte-dedupe-'));
        try {
            const fileA = path.join(dir, 'a', 'markdown.css');
            const fileB = path.join(dir, 'b', 'markdown.css');
            fs.mkdirSync(path.dirname(fileA));
            fs.mkdirSync(path.dirname(fileB));
            fs.writeFileSync(fileA, 'blockquote{padding:0 16px}');
            fs.writeFileSync(fileB, 'blockquote{padding:0 1em}');
            assert.deepStrictEqual(
                dedupeContributeFiles([fileA, fileB]),
                [fileA, fileB],
                'distinct same-named files must both be kept'
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('dedupeContributeFiles collapses identical content regardless of file name', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mte-dedupe-'));
        try {
            const fileA = path.join(dir, 'one.css');
            const fileB = path.join(dir, 'two.css');
            fs.writeFileSync(fileA, 'body{color:red}');
            fs.writeFileSync(fileB, 'body{color:red}');
            assert.deepStrictEqual(
                dedupeContributeFiles([fileA, fileB]),
                [fileB],
                'identical content collapses to the last occurrence'
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('dedupeContributeFiles preserves the order of distinct content', () => {
        const keyOf = (f: string) => f; // treat every path as unique content
        const input = ['/a/x.css', '/b/y.css', '/c/z.js'];
        assert.deepStrictEqual(dedupeContributeFiles(input, keyOf), input);
    });

    test('partitionDedupedStyleFiles dedupes across groups, keeping the third-party copy', () => {
        // KaTeX is shipped by both an official (vscode.markdown-math) and a
        // third-party (markdown-all-in-one) extension. It must be inlined once.
        const official = ['/o/node_modules/katex/katex.min.css', '/o/media/markdown.css'];
        const thirdParty = ['/tp/katex/katex.min.css', '/tp/extra.css'];
        const keyOf = (f: string) => path.basename(f).toLowerCase();
        assert.deepStrictEqual(
            partitionDedupedStyleFiles(official, thirdParty, keyOf),
            {
                official: ['/o/media/markdown.css'],
                thirdParty: ['/tp/katex/katex.min.css', '/tp/extra.css'],
            },
            'the shared asset should survive once, in the later (third-party) group'
        );
    });

    test('partitionDedupedStyleFiles keeps distinct same-named files in both groups', () => {
        // An official and a third-party extension each ship a different markdown.css;
        // both must survive in their own group (content-based comparison).
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mte-partition-'));
        try {
            const off = path.join(dir, 'o', 'markdown.css');
            const tp = path.join(dir, 'tp', 'markdown.css');
            fs.mkdirSync(path.dirname(off));
            fs.mkdirSync(path.dirname(tp));
            fs.writeFileSync(off, 'blockquote{padding:0 16px}');
            fs.writeFileSync(tp, 'blockquote{padding:0 1em}');
            assert.deepStrictEqual(
                partitionDedupedStyleFiles([off], [tp]),
                { official: [off], thirdParty: [tp] }
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('getStyles result has no exact duplicate entries', () => {
        const instance = ContributorService.instance;
        const styles = instance.getStyles();
        assert.ok(Array.isArray(styles), 'Styles should be array');
        assert.strictEqual(
            new Set(styles).size,
            styles.length,
            'identical contributed styles should be de-duplicated'
        );
    });
});
