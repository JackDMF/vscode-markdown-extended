import markdownIt from 'markdown-it';
import { MarkdownIt, Token } from '../@types/markdown-it';
import { INLINE_PLUGINS, isInlinePlugin } from '../plugin/inlinePlugins';
import { SIDEBAR_SPAN_META } from '../plugin/markdownItSidenote';
import { configureLinkify } from '../syntax/linkify';

/**
 * The engine the Visual Editor's page reads a textblock with, defined once for
 * the host and the page.
 *
 * The host's engine (`engine.ts`) parses the file; the page edits the document
 * it made and, after each edit, asks whether the textblocks it touched still
 * read back as the sidebars it shows (`unwritableInNote` in `serialize.ts`).
 * It asks by parsing them, with an engine built from the same definition as the
 * host's: markdown-it with the same options (`baseEngine`), and the registry's
 * plugins that have an inline rule (`INLINE_PLUGINS`), as many of them as the
 * host's registry runs, in its order. The host reads the definition off the
 * engine it built (`inlineEngineDefinition`) and posts it with each document;
 * the page builds its engine from it (`createInlineEngine`).
 *
 * What the page's engine cannot see: other extensions' markdown-it plugins,
 * which run in the host's engine (`extend`) and are not in the page's bundle —
 * one that teaches linkify a new scheme, say. VS Code's math extension, which
 * reads every `$…$` as math ahead of the sidebar rule, is the one the
 * definition names (`math`): the page does not run it, and makes no left
 * sidebar while it is on. Nor does it see the document's own reference and
 * footnote definitions, as a textblock is read on its own, or the plugins that
 * add no inline rule, which make or unmake no sidebar (`inlinePlugins.ts`).
 */

/** The settings the editor's engine and the page's are built with. */
export interface EngineOptions {
    /** VS Code's `markdown.preview.linkify`; decides which bare URLs are links. */
    linkify: boolean;
    /** VS Code's `markdown.preview.typographer`. */
    typographer: boolean;
}

/** What the page's engine is built from: the host's options and the inline plugins its registry runs, by name, with their arguments. */
export interface InlineEngineDefinition extends EngineOptions {
    plugins: { name: string; args: unknown[] }[];
    /**
     * Whether the host's engine reads every `$` as math before the sidebar
     * rule sees it: VS Code's math extension (`markdown.math.enabled`, on as
     * VS Code ships it) added its `math_inline` rule (`MATH_INLINE_RULE`). The
     * page does not run it; while it is on the host reads no left sidebar, so
     * the page makes none (`SIDEBAR_LEFT_MATH` in `serialize.ts`).
     */
    math: boolean;
}

/**
 * The inline rule VS Code's math extension (`@vscode/markdown-it-katex`) adds
 * after `escape`, ahead of the sidebar rule, and which claims every `$`.
 */
export const MATH_INLINE_RULE = 'math_inline';

/** Whether `md` holds an enabled inline rule named `name`, as the engine was actually built. */
function hasInlineRule(md: MarkdownIt, name: string): boolean {
    const rules = (md.inline.ruler as unknown as { __rules__?: { name: string; enabled: boolean }[] }).__rules__ ?? [];
    return rules.some(rule => rule.name === name && rule.enabled);
}

/**
 * markdown-it as both engines start: raw HTML allowed, linkify and typographer
 * as the host's settings say, and linkify-it set as VS Code's preview sets it
 * (`configureLinkify`: no fuzzy links).
 */
export function baseEngine(options: EngineOptions): MarkdownIt {
    const md: MarkdownIt = markdownIt({ html: true, linkify: options.linkify, typographer: options.typographer });
    configureLinkify(md.linkify);
    return md;
}

const definitions = new WeakMap<object, InlineEngineDefinition>();

/**
 * Record what `md` was built from, for `inlineEngineDefinition`: its options,
 * of the registry `plugins` it ran those the page runs too, in their order,
 * and whether the extenders that ran after them left VS Code's math reading
 * `$` — read off the engine, not the setting, so it is what the host does.
 */
export function recordInlineDefinition(md: MarkdownIt, options: EngineOptions, plugins: readonly { name: string; args: unknown[] }[]): void {
    definitions.set(md, {
        linkify: options.linkify,
        typographer: options.typographer,
        plugins: plugins.filter(p => isInlinePlugin(p.name)).map(p => ({ name: p.name, args: p.args })),
        math: hasInlineRule(md, MATH_INLINE_RULE),
    });
}

/** The page's engine as `md` (an engine `createEditorEngine` built) would have it. */
export function inlineEngineDefinition(md: MarkdownIt): InlineEngineDefinition {
    const found = definitions.get(md);
    if (found === undefined) {
        throw new Error('The engine was not built by createEditorEngine.');
    }
    return found;
}

/**
 * The definition of an engine built with VS Code's default settings and every
 * plugin of the registry: what the page reads with until the host has posted a
 * document. A unit test holds it equal to the host's.
 */
export const DEFAULT_INLINE_ENGINE: InlineEngineDefinition = {
    linkify: true,
    typographer: false,
    plugins: Object.keys(INLINE_PLUGINS).map(name => ({ name, args: [] })),
    // VS Code's math is another extension's extender, which the registry does not hold.
    math: false,
};

/** The page's engine, built from `definition`; a plugin the page does not bundle is skipped. */
export function createInlineEngine(definition: InlineEngineDefinition): MarkdownIt {
    const md = baseEngine(definition);
    for (const { name, args } of definition.plugins) {
        if (isInlinePlugin(name)) {
            md.use(INLINE_PLUGINS[name] as unknown as (md: MarkdownIt, ...args: unknown[]) => void, ...args);
        }
    }
    return md;
}

/** A sidebar the parser read: its kind, and where its opening and its closing marker stand in the text read. */
export interface ReadSidebar {
    kind: string;
    open: number;
    close: number;
}

/**
 * The sidebars `md` reads in `text`, a textblock's inline content, in their
 * order: every sidebar token the sidebar rule made, with where its markers
 * stood (`SIDEBAR_SPAN_META`), wherever it is in the token stream.
 */
export function readSidebars(md: MarkdownIt, text: string): ReadSidebar[] {
    const found: ReadSidebar[] = [];
    const walk = (tokens: readonly Token[] | null) => {
        for (const token of tokens ?? []) {
            const span = (token.meta as Record<string, unknown> | null | undefined)?.[SIDEBAR_SPAN_META] as [number, number] | undefined;
            if (span !== undefined && token.nesting === 1) {
                found.push({ kind: token.type.replace(/_open$/, ''), open: span[0], close: span[1] });
            }
            walk(token.children);
        }
    };
    walk(md.parseInline(text, {}));
    return found;
}
