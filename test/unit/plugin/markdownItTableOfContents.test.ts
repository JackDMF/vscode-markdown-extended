import * as assert from 'assert';
import * as vscode from 'vscode';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { plugins } from '../../../src/plugin/plugins';
import { parseDocument } from '../../../src/editor';
import { hostEngine, topChildren } from '../editor/helpers';
import { headingIds, previewEnv, secondAnchors, withVscodeHeadingRule } from '../vscodeHeadings';

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
    '## [x] Done',
];
const EXPECTED = ['what-is-new', 'qa', 'größe', '标题', '-emoji', 'inline-code-here', 'a-link-in-it', 'setup', 'setup-1', 'setup-2', 'custom', 'done'];

// Headings whose slug is empty, or whose text is: the first empty slug is the
// id "", each one after it a repeat of "" (`-1`, `-2`, …).
// Explicit ids among repeats, Req Explorer's anchor first: each explicit-id
// heading takes its slug from the count, so the repeats after it go on.
const EXPLICIT = ['## FR-1: Name {#fr-1}', '## Setup', '## Setup {#intro}', '## Setup', '## FR-1: Name'];
const EXPLICIT_IDS = ['fr-1', 'setup', 'intro', 'setup-2', 'fr-1-name-1'];

const EMPTY = ['## ???', '## \u{1F680}', '## ![](x.png)', '## ![](x.png)', '## ???'];

suite('markdown-it-table-of-contents links the ids the preview gives the headings', () => {
    let md: MarkdownIt.MarkdownIt;

    setup(() => {
        md = preview();
    });

    test('punctuation, non-ASCII, emoji, inline code, a link and a repeat are linked by the preview slug, an explicit {#id} by that id', () => {
        const html = md.render(['[[TOC]]', '', ...HEADINGS, ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html).map(decodeURIComponent), EXPECTED);
    });

    test('a heading with an explicit {#id} is linked by it and still counts for the repeats after it', () => {
        const html = md.render(['[[TOC]]', '', ...EXPLICIT, ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html), EXPLICIT_IDS);
    });

    test('an explicit id is escaped into the link: a quote cannot close the href', () => {
        const html = md.render(['[[TOC]]', '', '## T {#x"onmouseover="alert(1)}', '## U {id="a & b"}', '## V {#a>b}', ''].join('\n'));
        assert.ok(!tocOf(html).includes('"onmouseover'), tocOf(html));
        // (`{id="<b>"}` is no literal with raw HTML on: `<b>` is an HTML tag there.)
        assert.deepStrictEqual(tocHrefs(html), ['x&quot;onmouseover=&quot;alert(1)', 'a &amp; b', 'a&gt;b']);
    });

    test('under VS Code\'s heading rule the TOC links the explicit id, not the second anchor', () => {
        const html = withVscodeHeadingRule(preview()).render(['[[TOC]]', '', ...EXPLICIT, ''].join('\n'), previewEnv());
        assert.deepStrictEqual(tocHrefs(html), headingIds(html));
        assert.deepStrictEqual(secondAnchors(html), ['fr-1-name', 'setup-1']);
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

    test('@[toc](Title) takes parentheses nested one deep', () => {
        const html = md.render(['@[toc](Contents (draft))', '', '## Sub 1', ''].join('\n'));
        assert.ok(html.startsWith('<div class="table-of-contents"><p class="table-of-contents-title">Contents (draft)</p><ul>'), html);
        assert.ok(!md.render('@[toc](a ((b)))\n').includes('table-of-contents'), 'deeper is no TOC');
    });

    test('[[TOC]] at the start of a line makes a TOC, and drops the rest of the line', () => {
        const html = md.render(['[[TOC]] trailing', '', '## Sub 1', ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html), ['sub-1']);
        assert.ok(!html.includes('trailing'), html);
    });

    test('a heading with an empty slug is listed unlinked, one with no text not at all, and both count', () => {
        const html = md.render(['[[TOC]]', '', ...EMPTY, ''].join('\n'));
        assert.strictEqual(tocOf(html), '<ul><li>???</li><li><a href="#-1">\u{1F680}</a></li><li><a href="#-4">???</a></li></ul>');
        assert.ok(!html.includes('null'), html);
    });

    test('the text a later core rule leaves is the one slugged: markdown-it-checkbox takes [x] out of a heading', () => {
        assert.deepStrictEqual(tocHrefs(md.render(['[[TOC]]', '', '## [x] Done', ''].join('\n'))), ['done']);
    });

    test('a TOC body without the parse\'s state is still linked by the preview rule, never by the plugin\'s slug', () => {
        // A copy of the TOC token is one no parse knows.
        const tokens = md.parse(['[[TOC]]', '', '## What is new?', '## What is new?', ''].join('\n'), {})
            .map(t => t.type === 'toc_body' ? Object.assign(Object.create(Object.getPrototypeOf(t)), t) : t);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        assert.deepStrictEqual(tocHrefs(md.renderer.render(tokens, (md as any).options, {})), ['what-is-new', 'what-is-new-1']);
    });

    test('a document with a TOC parses to plain data: VS Code\'s language server receives the tokens as JSON', () => {
        const tokens = md.parse(['[[TOC]]', '', '## A', '', '@[toc](Title)', ''].join('\n'), {});
        assert.doesNotThrow(() => JSON.stringify(tokens));
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

    test('a heading\'s explicit {#id} is its id in the preview, and the TOC links it', async () => {
        const html = await vscode.commands.executeCommand<string>('markdown.api.render', ['[[TOC]]', '', ...EXPLICIT, ''].join('\n'));
        assert.deepStrictEqual(headingIds(html), EXPLICIT_IDS);
        assert.deepStrictEqual(tocHrefs(html), headingIds(html));
    });

    test('an empty slug is an empty id in the preview, and the headings after it count it', async () => {
        const html = await vscode.commands.executeCommand<string>('markdown.api.render', ['[[TOC]]', '', ...EMPTY, ''].join('\n'));
        assert.deepStrictEqual(headingIds(html), ['', '-1', '-2', '-3', '-4']);
        assert.deepStrictEqual(tocHrefs(html), ['-1', '-4']);
    });

    test('@[toc] renders as a table of contents in the preview', async () => {
        const html = await vscode.commands.executeCommand<string>('markdown.api.render', ['@[toc]', '', '## Sub 1', '## Sub 1', ''].join('\n'));
        assert.deepStrictEqual(tocHrefs(html), headingIds(html));
        assert.deepStrictEqual(headingIds(html), ['sub-1', 'sub-1-1']);
    });
});
