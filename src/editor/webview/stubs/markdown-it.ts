/**
 * What `markdown-it` resolves to in the editor page's bundle (the `alias` in
 * `esbuild.js`), in place of the real parser.
 *
 * The page serializes and never parses — the host parses and sends the
 * document — but `prosemirror-markdown`'s entry module builds its
 * `defaultMarkdownParser` when it loads, calling `markdownit("commonmark", …)`,
 * and so would carry all of markdown-it into the page for an object nothing
 * uses. `MarkdownParser`'s constructor only stores the tokenizer it is given; it
 * is called in `parse()`, which the page never calls. So the stub has to be
 * callable, with or without `new`, and nothing more.
 *
 * What would break it: `prosemirror-markdown` starting to use the tokenizer
 * while loading (reading its options, say, or calling `parse`). The page would
 * then throw as the bundle loads, and the headless page test
 * (`test/unit/editor/webview.e2e.test.ts`), which loads the real bundle and
 * requires it to raise no page error, fails.
 */
export default function markdownIt(): object {
    return {};
}
