import markdownIt from 'markdown-it';
import { MarkdownIt, Token } from '../@types/markdown-it';
import { PAGE_PLUGINS, PAGE_PLUGINS_IN_ORDER, isPagePlugin } from '../plugin/inlinePlugins';
import { MarkdownItAttrs } from '../plugin/markdownItAttrs';
import { useMathStandIn } from './mathStandIn';
import { SIDEBAR_SPAN_META } from '../plugin/markdownItSidenote';
import { configureLinkify } from '../syntax/linkify';
import { WIKI_EMBED_TOKENS_OPTION } from '../syntax/markers';

/**
 * The engine the Visual Editor's page reads what it writes with, defined once
 * for the host and the page.
 *
 * The host's engine (`engine.ts`) parses the file; the page edits the document
 * it made and, after each edit, asks whether the blocks the save writes again
 * still read back as it shows them — their sidebars and attribute literals
 * (`unwritableInNote` in `serialize.ts`). It asks by parsing them, with an
 * engine built from the same definition as the host's: markdown-it with the
 * same options (`baseEngine`), and the registry's plugins the page runs
 * (`PAGE_PLUGINS`: those with an inline rule, and the container, admonition
 * and table plugins whose blocks the editor writes), as many of them as the
 * host's registry runs, in its order. The host reads the definition off the
 * engine it built (`inlineEngineDefinition`) and posts it with each document;
 * the page builds its engine from it (`createInlineEngine`).
 *
 * What the page's engine cannot see: other extensions' markdown-it plugins,
 * which run in the host's engine (`extend`) and are not in the page's bundle —
 * one that teaches linkify a new scheme, say. VS Code's math extension, which
 * reads a `$…$` as math ahead of the sidebar rule and of markdown-it-attrs, is
 * the one the definition names (`math`): the page does not bundle it, and runs
 * its tokenizer instead (`mathStandIn.ts`), so what the preview takes for
 * math the page does too — a left sidebar and a literal holding a `$` alike.
 * Nor does it see the document's own reference and
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

/** What the page's engine is built from: the host's options and the plugins of its registry the page runs (`PAGE_PLUGINS`), by name, with their arguments. */
export interface InlineEngineDefinition extends EngineOptions {
    plugins: { name: string; args: unknown[] }[];
    /**
     * Whether the host's engine reads `$…$` as math before the sidebar rule
     * and markdown-it-attrs see it: VS Code's math extension
     * (`markdown.math.enabled`, on as VS Code ships it) added its
     * `math_inline` rule (`MATH_INLINE_RULE`). The page runs a stand-in for
     * its tokenizer then (`useMathStandIn`), so a `$…$` it reads as math is
     * no left sidebar (`SIDEBAR_LEFT_MATH` in `serialize.ts`) and no literal.
     */
    math: boolean;
}

/**
 * The inline rule VS Code's math extension (`@vscode/markdown-it-katex`) adds
 * after `escape`, ahead of the sidebar rule.
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
 * (`configureLinkify`: no fuzzy links). Both keep a wiki embed a `wiki_embed`
 * token (`WIKI_EMBED_TOKENS_OPTION`, `markdownItWikiEmbed.ts`), the one option
 * that differs from the preview's engine: the editor edits it as one atom.
 */
export function baseEngine(options: EngineOptions): MarkdownIt {
    const md: MarkdownIt = markdownIt({
        html: true,
        linkify: options.linkify,
        typographer: options.typographer,
        [WIKI_EMBED_TOKENS_OPTION]: true,
    } as Parameters<typeof markdownIt>[0]);
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
        plugins: plugins.filter(p => isPagePlugin(p.name)).map(p => ({ name: p.name, args: p.args })),
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
    plugins: PAGE_PLUGINS_IN_ORDER.map(({ name, args }) => ({ name, args: [...args] })),
    // VS Code's math is another extension's extender, which the registry does not hold.
    math: false,
};

/**
 * The definition of the engine that read a file, for a parse that judges the
 * literals it finds (`groupSourceBlocks`): what `md` was built from, or
 * `DEFAULT_INLINE_ENGINE` for an engine `createEditorEngine` did not build.
 */
export function definitionOf(md: MarkdownIt): InlineEngineDefinition {
    return definitions.get(md) ?? DEFAULT_INLINE_ENGINE;
}

/**
 * The page's engine, built from `definition`; a plugin the page does not
 * bundle is skipped. With `math`, the stand-in for VS Code's math is added
 * after the plugins, as the host's extenders run after its registry.
 */
export function createInlineEngine(definition: InlineEngineDefinition): MarkdownIt {
    const md = baseEngine(definition);
    for (const { name, args } of definition.plugins) {
        if (isPagePlugin(name)) {
            md.use(PAGE_PLUGINS[name] as unknown as (md: MarkdownIt, ...args: unknown[]) => void, ...args);
        }
    }
    return definition.math ? useMathStandIn(md) : md;
}

/** The definition the page reads with now (`setCurrentInlineDefinition`), and the engines built from it, made when first asked. */
let currentDefinition: InlineEngineDefinition = DEFAULT_INLINE_ENGINE;
let currentEngines: { inline: MarkdownIt | null; attrs: MarkdownIt | null } = { inline: null, attrs: null };

/**
 * Read with the engine `definition` describes from now on — the host's, which
 * the page is posted with each document (`setInlineEngine` in `serialize.ts`).
 * Whether it changed. Until a document is posted, and wherever nothing sets
 * one (the extension host, whose parse reads with its full engine), it is
 * `DEFAULT_INLINE_ENGINE`.
 */
export function setCurrentInlineDefinition(definition: InlineEngineDefinition): boolean {
    if (JSON.stringify(definition) === JSON.stringify(currentDefinition)) {
        return false;
    }
    currentDefinition = definition;
    currentEngines = { inline: null, attrs: null };
    return true;
}

/** The definition the page reads with now. */
export function currentInlineDefinition(): InlineEngineDefinition {
    return currentDefinition;
}

/**
 * Whether the current definition's engine reads wiki embeds: the host's
 * registry ran `markdown-it-wiki-embed` (`readsWikiEmbeds`, `markdownItWikiEmbed.ts`).
 * What the serializer writes by (`SerializeOptions.wikiEmbeds`) where no caller
 * passes it: the check of an edit writes as the save does.
 */
export function currentReadsWikiEmbeds(): boolean {
    return currentDefinition.plugins.some(plugin => plugin.name === 'markdown-it-wiki-embed');
}

/** The page's engine (`createInlineEngine`) for the current definition. */
export function currentInlineEngine(): MarkdownIt {
    currentEngines.inline ??= createInlineEngine(currentDefinition);
    return currentEngines.inline;
}

/** The engines `attrsEngineFor` built, by definition; few, as a session reads with one at a time. */
const attrsEngines = new Map<string, MarkdownIt>();

/**
 * The page's engine for `definition` with the registry's markdown-it-attrs on
 * top, registered as the host registers it (`MarkdownItAttrs`, no options):
 * what reads a literal where the editor finds or writes it, as the preview
 * reads it there (`attrsReadAt` in `attrs.ts`). The host's parse asks it with
 * the definition of the engine that read the file, the page with the one it
 * was posted, and the page reads back with it the blocks its save writes
 * (`readUnit` in `serialize.ts`).
 */
export function attrsEngineFor(definition: InlineEngineDefinition): MarkdownIt {
    if (definition === currentDefinition) {
        currentEngines.attrs ??= createInlineEngine(currentDefinition).use(MarkdownItAttrs);
        return currentEngines.attrs;
    }
    const key = JSON.stringify(definition);
    let md = attrsEngines.get(key);
    if (md === undefined) {
        md = createInlineEngine(definition).use(MarkdownItAttrs);
        attrsEngines.set(key, md);
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
    return sidebarsIn(md.parseInline(text, {}));
}

/** The sidebars read in `tokens` and their children, as `readSidebars` finds them, where an inline token's content is the text read. */
export function sidebarsIn(tokens: readonly Token[]): ReadSidebar[] {
    const found: ReadSidebar[] = [];
    const walk = (list: readonly Token[] | null) => {
        for (const token of list ?? []) {
            const span = (token.meta as Record<string, unknown> | null | undefined)?.[SIDEBAR_SPAN_META] as [number, number] | undefined;
            if (span !== undefined && token.nesting === 1) {
                found.push({ kind: token.type.replace(/_open$/, ''), open: span[0], close: span[1] });
            }
            walk(token.children);
        }
    };
    walk(tokens);
    return found;
}
