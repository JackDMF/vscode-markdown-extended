import frontMatter from 'markdown-it-front-matter';
import { MarkdownIt } from '../@types/markdown-it';
import { baseEngine, recordInlineDefinition } from './inlineEngine';

/**
 * One entry of a plugin registry, in the shape `src/plugin/plugins.ts` exports
 * it: its name there, the plugin function and the arguments `md.use` passes
 * after the instance. Declared structurally here because that registry's own
 * interface is private.
 */
export interface MarkdownItPlugin {
    name: string;
    // The registry types its plugins' parameters as `any`; `unknown` accepts them.
    plugin: (md: MarkdownIt, ...args: unknown[]) => void;
    args: unknown[];
}

/**
 * A host extension's `extendMarkdownIt`, as VS Code calls it for the preview: it
 * receives the engine and may return it (or nothing). Req Explorer's is one.
 */
export type MarkdownItExtender = (md: MarkdownIt) => MarkdownIt | void;

export interface EditorEngineOptions {
    /** VS Code's `markdown.preview.linkify`; decides which bare URLs are links. */
    linkify: boolean;
    /** VS Code's `markdown.preview.typographer`. When on, text carries typographic quotes and dashes, and a changed block writes them back. */
    typographer: boolean;
    /** Markdown Extended Pro's own registry, `plugins` from `src/plugin/plugins.ts`. */
    plugins: MarkdownItPlugin[];
    /** Other extensions' `extendMarkdownIt`, applied after this extension's plugins, in the order given. */
    extend?: MarkdownItExtender[];
}

/**
 * The markdown-it instance the rich editor tokenizes with.
 *
 * It is composed the way VS Code composes its preview engine, because the
 * editor's contract is "one parser, two renderers": the editor must see the same
 * tokens the preview renders, including what other extensions inject. So: raw
 * HTML allowed, linkify and typographer from the host's settings, linkify-it
 * with no fuzzy links (`baseEngine`, which the editor's page starts from too), a
 * front-matter rule first, then this extension's registry, then every other
 * extension's extender. The page's engine is recorded with it
 * (`inlineEngineDefinition`), for the host to post with each document.
 *
 * One option differs from the preview's engine: `WIKI_EMBED_TOKENS_OPTION`,
 * which keeps each wiki embed a `wiki_embed` token where the preview's engine
 * makes it text (`markdownItWikiEmbed.ts`, and "The one exception: wiki
 * embeds" in ARCHITECTURE.md). Text read from tokens goes through `tokenText`,
 * which reads both alike.
 *
 * The front-matter rule is registered here and nowhere else. The preview engine
 * must not get one from this extension — VS Code's own preview already
 * registers it, and the comment on `plugins` in `src/plugin/plugins.ts` records
 * why a second one conflicts. This engine is built from scratch rather than
 * handed over by VS Code, so it has no front-matter rule unless it adds one, and
 * without it the YAML block would tokenize as a thematic break and a setext
 * heading — the one block Req Explorer requires to leave the editor byte for
 * byte.
 *
 * markdown-it is pinned to major 14, the one VS Code's preview runs. Several
 * registry plugins (`markdown-it-multimd-table` among them) call
 * `md.utils.assign`, which markdown-it 15 removed.
 */
export function createEditorEngine(options: EditorEngineOptions): MarkdownIt {
    let md = baseEngine(options);
    // The plugin's declarations are written against @types/markdown-it, which is
    // not the declaration this project compiles against; the runtime contract
    // (a plugin taking the instance and a callback) is the same.
    const frontMatterPlugin = frontMatter as unknown as MarkdownItPlugin['plugin'];
    // The callback receives the YAML; the editor reads the block from its token.
    md.use(frontMatterPlugin, () => undefined);
    const used = options.plugins.filter(p => typeof p.plugin === 'function');
    for (const { plugin, args } of used) {
        md.use(plugin, ...args);
    }
    for (const extend of options.extend ?? []) {
        md = extend(md) || md;
    }
    recordInlineDefinition(md, options, used);
    return md;
}
