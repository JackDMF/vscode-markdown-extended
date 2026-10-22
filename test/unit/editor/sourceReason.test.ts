import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseDocument } from '../../../src/editor';
import { sourceReasonWords } from '../../../src/editor/sourceReason';
import { constructsFixture, hostEngine, readText, repoRoot, topChildren } from './helpers';

/**
 * Why a block is a source block, in words (wave 3 #5a): set at parse on
 * `raw_block.construct`, read by its bar ("Source · footnote") and its name
 * ("Source block: footnote").
 */
suite('Editor source block reason', () => {
    test('constructs.md: each source block\'s reason in words', () => {
        const raw = topChildren(parseDocument(hostEngine(), readText(constructsFixture)).doc)
            .filter(n => n.type.name === 'raw_block')
            .map(n => [(n.attrs.src as string).split('\n')[0], n.attrs.construct]);
        assert.deepStrictEqual(raw, [
            ['[[toc]]', 'table of contents'],
            ['Setext heading', 'setext heading'],
            ['A sentence with a footnote.[^first]', 'footnote'],
            ['[^first]: The footnote body.', 'footnote text'],
            ['Term', 'definition list'],
            ['- [ ] An open task', 'task list'],
            ['Press <kbd>Ctrl</kbd> or [[Ctrl+S]], ==mark== this, H~2~O and x^2^, :smile:, ~~gone~~.', 'inline HTML'],
            ['*[HTML]: HyperText Markup Language', 'abbreviation'],
            ['An abbreviation: HTML.', 'abbreviation'],
            ['[ref]: https://example.net/ref', 'link reference'],
        ]);
    });

    test('a table keeps its kind; a reason no word says more for is null', () => {
        const [table] = topChildren(parseDocument(hostEngine(), '| a | b |\n| = | = |\n| 1 | 2 |\n').doc);
        assert.deepStrictEqual([table.type.name, table.attrs.construct], ['raw_block', 'multimd table']);
        assert.strictEqual(sourceReasonWords('paragraph_open overlapping lines an earlier block holds', ''), null);
        assert.strictEqual(sourceReasonWords('source lines no token accounts for', 'stray text\n'), null);
    });

    for (const [reason, src, words] of [
        ['inline footnote_ref', 'x[^1]\n', 'footnote'],
        ['footnote_ref inside another note', '', 'footnote'],
        ['nested dl_open', '', 'definition list'],
        ['nested html_block', '', 'HTML'],
        ['source lines no token accounts for', '\n   [^long label]: text\n', 'footnote text'],
        ['container attributes on its ::: line, which the container node does not keep', '', 'container attributes'],
        ['emoji without its spelling', '', 'emoji'],
    ] as const) {
        test(`${JSON.stringify(reason)} is "${words}"`, () => {
            assert.strictEqual(sourceReasonWords(reason, src), words);
        });
    }

    test('the chip is the editor\'s alone: no preview or export stylesheet draws it, and the rendering carries none', () => {
        const styles = path.join(repoRoot, 'styles');
        for (const sheet of fs.readdirSync(styles).filter(f => f.endsWith('.css') && f !== 'editor.css')) {
            const css = fs.readFileSync(path.join(styles, sheet), 'utf8');
            assert.ok(!/mep-raw-block|content:\s*"source"/.test(css), `${sheet} draws no source chip`);
        }
        const editorCss = fs.readFileSync(path.join(styles, 'editor.css'), 'utf8');
        assert.ok(editorCss.includes('.ProseMirror .mep-raw-block::before'), 'editor.css draws it, inside the editor');
        // What the preview and an export render: the host's HTML, which knows no source block.
        const html = hostEngine().render('A sentence with a footnote.[^1]\n\n[^1]: The body.\n');
        assert.ok(!/mep-|>source</.test(html), html);
        // Only the editor's page links editor.css; the exporters and the preview never do.
        const linking = grepSources(path.join(repoRoot, 'src'), /editor\.css['"]/);
        assert.deepStrictEqual(linking, [path.join('editor', 'host', 'html.ts')]);
    });
});

/** The files under `dir` (relative to `src/`) whose text matches `re`. */
function grepSources(dir: string, re: RegExp, root = dir): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...grepSources(full, re, root));
        } else if (/\.(ts|js)$/.test(entry.name) && re.test(fs.readFileSync(full, 'utf8'))) {
            out.push(path.relative(root, full));
        }
    }
    return out;
}
