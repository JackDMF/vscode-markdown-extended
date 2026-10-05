import markdownIt from 'markdown-it';
import frontMatter from 'markdown-it-front-matter';
import { MarkdownIt } from '../@types/markdown-it';

/**
 * One entry of a plugin registry, in the shape `src/plugin/plugins.ts` exports
 * it: the plugin function and the arguments `md.use` passes after the instance.
 * Declared structurally here because that registry's own interface is private.
 */
export interface MarkdownItPlugin {
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
    /** Where a registry plugin that fails to load is reported; it is skipped either way. */
    log?: (line: string) => void;
}

/**
 * The markdown-it instance the rich editor tokenizes with.
 *
 * It is composed the way VS Code composes its preview engine, because the
 * editor's contract is "one parser, two renderers": the editor must see the same
 * tokens the preview renders, including what other extensions inject. So: raw
 * HTML allowed, linkify and typographer from the host's settings, a front-matter
 * rule first, then this extension's registry, then every other extension's
 * extender.
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
    let md: MarkdownIt = markdownIt({
        html: true,
        linkify: options.linkify,
        typographer: options.typographer,
    });
    // The plugin's declarations are written against @types/markdown-it, which is
    // not the declaration this project compiles against; the runtime contract
    // (a plugin taking the instance and a callback) is the same.
    const frontMatterPlugin = frontMatter as unknown as MarkdownItPlugin['plugin'];
    // The callback receives the YAML; the editor reads the block from its token.
    md.use(frontMatterPlugin, () => undefined);
    for (const { plugin, args } of options.plugins) {
        if (typeof plugin === 'function') {
            // One plugin that throws must not take the engine down with it, as in `extendMarkdownIt`.
            try {
                md.use(plugin, ...args);
            } catch (error) {
                options.log?.(`[ERROR] Failed to load markdown plugin: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    for (const extend of options.extend ?? []) {
        md = extend(md) || md;
    }
    return md;
}
