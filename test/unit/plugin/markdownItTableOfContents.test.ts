import * as assert from 'assert';
import * as vscode from 'vscode';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { parseDocument } from '../../../src/editor';
import { hostEngine, topChildren } from '../editor/helpers';

// The preview's own registry, in its order, with raw HTML on as the preview has it.
function preview(): MarkdownIt.MarkdownIt {
    const md = new MarkdownIt({ html: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins.forEach(p => md.use(p.plugin as any, ...p.args));
    return md;
}

/** The fragments a rendered TOC links to, in order. */
function tocHrefs(html: string): string[] {
    return [...tocOf(html).matchAll(/<a href="#([^"]*)">/g)].map(([, href]) => href);
}

/** What the rendered TOC holds. */
function tocOf(html: string): string {
    const toc = /<div class="table-of-contents">([\s\S]*?)<\/div>/.exec(html);
    assert.ok(toc, 'a table of contents is rendered');
    return toc[1];
}

/** The ids the rendered headings carry, in order. */
function headingIds(html: string): string[] {
    return [...html.matchAll(/<h[1-6][^>]*\sid="([^"]*)"/g)].map(([, id]) => id);
}

// Every case the slug rule treats differently, each heading at a level the
// TOC lists (the default 1–3), so the TOC links every one of them.
const HEADINGS = [
    '# What is new?',
    '## Q&A',
    '## Größe',
    '## 标题',
    '## :smile: Emoji',
    '## Inline `code` here',
    '## A [link](https://example.net) in it',
    '## Setup',
    '### Setup',
    '## Setup',
    '## Title {#custom}',
];
const EXPECTED = ['what-is-new', 'qa', 'größe', '标题', '-emoji', 'inline-code-here', 'a-link-in-it', 'setup', 'setup-1', 'setup-2', 'title'];

suite('markdown-it-table-of-contents links the ids the preview gives the headings', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('punctuation, non-ASCII, emoji, inline code, a link, a repeat and an explicit {#id} are linked by the preview slug', () => {
        const html = md.render(['[[TOC]]', '', ...HEADINGS, ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html).map(decodeURIComponent), EXPECTED);
    });

    test('a heading at a level the TOC leaves out still counts for the repeats after it', () => {
        const html = md.render(['[[TOC]]', '', '## Setup', '#### Setup', '## Setup', ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html), ['setup', 'setup-2']);
    });

    test('the counting restarts with every render', () => {
        const src = ['[[TOC]]', '', '## Setup', '## Setup', ''].join('\n');
        md.render(src);
        assert.deepStrictEqual(tocHrefs(md.render(src)), ['setup', 'setup-1']);
    });

    test('an entry is the heading\'s text: emoji kept, no link inside the link (qjebbs/vscode-markdown-extended#70)', () => {
        const html = md.render(['[[TOC]]', '', '## :smile: A [link](https://example.net) and `code`', ''].join('\n'));
        assert.strictEqual(tocOf(html), '<ul><li><a href="#-a-link-and-code">\u{1F604} A link and code</a></li></ul>');
    });

    test('<!-- omit from toc --> still leaves a heading out, and it still counts', () => {
        const html = md.render(['[[TOC]]', '', '## Setup', '', '<!-- omit from toc -->', '## Setup', '', '## Setup', ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html), ['setup', 'setup-2']);
    });

    test('@[toc] is the same table of contents as [[TOC]] (qjebbs/vscode-markdown-extended#174)', () => {
        const body = ['', '## Sub 1', '### Sub 1.1', '## Sub 2', ''];
        assert.strictEqual(md.render(['@[toc]', ...body].join('\n')), md.render(['[[TOC]]', ...body].join('\n')));
        assert.deepStrictEqual(tocHrefs(md.render(['@[TOC]', ...body].join('\n'))), ['sub-1', 'sub-11', 'sub-2']);
    });

    test('@[toc](Title) writes the title above the list', () => {
        const html = md.render(['@[toc](Contents & more)', '', '## Sub 1', ''].join('\n'));
        assert.ok(html.startsWith('<div class="table-of-contents"><p class="table-of-contents-title">Contents &amp; more</p><ul>'), html);
    });

    test('@[toc] inside a sentence is text', () => {
        assert.strictEqual(md.render('See @[toc] here.\n'), '<p>See @[toc] here.</p>\n');
    });
});

suite('The Visual Editor renders a TOC block with the document\'s headings', () => {
    test('a [[TOC]] source block lists the headings after it, linked as the preview links them', () => {
        const text = ['[[TOC]]', '', '## Setup', '', '## Setup', ''].join('\n');
        const toc = topChildren(parseDocument(hostEngine(), text).doc).find(b => b.type.name === 'raw_block');
        assert.ok(toc, 'the TOC is a source block');
        assert.deepStrictEqual(tocHrefs(toc.attrs.html as string), ['setup', 'setup-1']);
    });
});

suite('The TOC against VS Code\'s own render (markdown.api.render)', () => {
    test('every TOC link names the id the preview gives its heading', async () => {
        const html = await vscode.commands.executeCommand<string>('markdown.api.render', ['[[TOC]]', '', ...HEADINGS, ''].join('\n'));
        assert.deepStrictEqual(headingIds(html), EXPECTED, 'the preview\'s ids are the ones this suite expects');
        assert.deepStrictEqual(tocHrefs(html).map(decodeURIComponent), headingIds(html));
    });

    test('@[toc] renders as a table of contents in the preview', async () => {
        const html = await vscode.commands.executeCommand<string>('markdown.api.render', ['@[toc]', '', '## Sub 1', '## Sub 1', ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html), headingIds(html));
        assert.deepStrictEqual(headingIds(html), ['sub-1', 'sub-1-1']);
    });
});
