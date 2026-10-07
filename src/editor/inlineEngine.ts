import markdownIt from 'markdown-it';
import { MarkdownIt, Token } from '../@types/markdown-it';
import { PAGE_PLUGINS, PAGE_PLUGINS_IN_ORDER, isPagePlugin } from '../plugin/inlinePlugins';
import { MarkdownItAttrs, readsAttrs } from '../plugin/markdownItAttrs';
import { useMathStandIn } from './mathStandIn';
import { SIDEBAR_SPAN_META } from '../plugin/markdownItSidenote';
import { WIKI_EMBED_TOKEN, readsWikiEmbeds } from '../plugin/markdownItWikiEmbed';
import { hasEnabledRule } from '../plugin/shared';
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
 * Whether the host reads wiki embeds is named too (`wikiEmbeds`), read off
 * the engine as built, for an extender may have turned the rule off, and
 * whether it reads attribute literals (`attrs`) the same way.
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

/**
 * A plugin of the host's registry the page runs, by name, with its arguments.
 * `threw` marks one whose `md.use` threw on the host after it had changed the
 * engine's rules: the host keeps what it installed, as the preview does
 * (`extendMarkdownIt`), so the page runs it as far as it gets too
 * (`createInlineEngine`), rather than reading without the rules the host has.
 */
export interface DefinedPlugin {
    name: string;
    args: unknown[];
    threw?: true;
}

/** What the page's engine is built from: the host's options and the plugins of its registry the page runs (`PAGE_PLUGINS`), by name, with their arguments. */
export interface InlineEngineDefinition extends EngineOptions {
    plugins: DefinedPlugin[];
    /**
     * Whether the host's engine reads `$…$` as math before the sidebar rule
     * and markdown-it-attrs see it: VS Code's math extension
     * (`markdown.math.enabled`, on as VS Code ships it) added its
     * `math_inline` rule (`MATH_INLINE_RULE`). The page runs a stand-in for
     * its tokenizer then (`useMathStandIn`), so a `$…$` it reads as math is
     * no left sidebar (`SIDEBAR_LEFT_MATH` in `serialize.ts`) and no literal.
     */
    math: boolean;
    /**
     * Whether the host's engine reads wiki embeds: its `wiki_embed` rule is in
     * the inline chain as the engine was finally built (`readsWikiEmbeds`) —
     * the registry ran `markdown-it-wiki-embed`, `plugins.disabled` does not
     * name it, and no extender disabled the rule after it. The one answer to
     * "would `![[` read as an embed": the save's escape of a `!` before a key
     * and the check of an edit write by it (`serialize.ts`), the page's
     * engine reads by it (`createInlineEngine`), and the page makes an embed
     * from typed or pasted `![[…]]` only where it holds (`wikiEmbeds.ts`).
     */
    wikiEmbeds: boolean;
    /**
     * Whether the host's engine reads attribute literals as the page would:
     * the registry's attrs plugin runs as the page runs it, its core rules all
     * in the chain and enabled as the engine was finally built (`readsAttrs`)
     * — the registry ran `markdown-it-attrs`, `plugins.disabled` does not
     * name it, and no extender disabled one of its rules after it. The one
     * answer to "is `{.x}` attributes here": the page reads a literal with
     * markdown-it-attrs only where it holds (`attrsEngineFor`), so the save
     * escapes a `{…}` the plugin would take (`escapedLiterals` in
     * `serialize.ts`) and keeps a literal line apart from the next block
     * (`endsInLiteralLine`), the check of an edit reads its literals back
     * (`readUnit`), the host recognises a literal (`attrsReadAt` in
     * `attrs.ts`), and the page offers Attributes… and a span of the
     * selection (`currentReadsAttrs`), all by the same fact.
     */
    attrs: boolean;
}

/**
 * The inline rule VS Code's math extension (`@vscode/markdown-it-katex`) adds
 * after `escape`, ahead of the sidebar rule.
 */
export const MATH_INLINE_RULE = 'math_inline';

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
 * `$` and the wiki embed rule reading `![[` — read off the engine, not the
 * settings, so it is what the host does. Made once, when the engine is built.
 */
export function recordInlineDefinition(md: MarkdownIt, options: EngineOptions, plugins: readonly DefinedPlugin[]): void {
    definitions.set(md, {
        linkify: options.linkify,
        typographer: options.typographer,
        plugins: plugins.filter(p => isPagePlugin(p.name)).map(p => (p.threw ? { name: p.name, args: p.args, threw: true } : { name: p.name, args: p.args })),
        math: hasEnabledRule(md.inline.ruler, MATH_INLINE_RULE),
        wikiEmbeds: readsWikiEmbeds(md),
        attrs: readsAttrs(md),
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
    // The registry holds markdown-it-wiki-embed.
    wikiEmbeds: true,
    // The registry holds markdown-it-attrs.
    attrs: true,
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
 * bundle is skipped, and one that threw on the host after changing its rules
 * (`threw`) runs as far as it gets here too. Then what the host's extenders
 * did after its registry: the wiki embed rule disabled where the host's is
 * not read (`wikiEmbeds`), and with `math` the stand-in for VS Code's math.
 */
export function createInlineEngine(definition: InlineEngineDefinition): MarkdownIt {
    const md = baseEngine(definition);
    for (const { name, args, threw } of definition.plugins) {
        if (isPagePlugin(name)) {
            const plugin = PAGE_PLUGINS[name] as unknown as (md: MarkdownIt, ...args: unknown[]) => void;
            if (threw) {
                try {
                    md.use(plugin, ...args);
                } catch {
                    // It threw on the host too; what it installed before that stays, as there.
                }
            } else {
                md.use(plugin, ...args);
            }
        }
    }
    // Only the registry's plugin is the rule `readsWikiEmbeds` reads, so a host
    // that reads embeds listed it above; one that does not may still have run it.
    if (!definition.wikiEmbeds && readsWikiEmbeds(md)) {
        md.inline.ruler.disable(WIKI_EMBED_TOKEN);
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
 * Whether the current definition's engine reads wiki embeds
 * (`InlineEngineDefinition.wikiEmbeds`): what the serializer writes by, the
 * save and the check of an edit alike, and what the page's embed input asks.
 */
export function currentReadsWikiEmbeds(): boolean {
    return currentDefinition.wikiEmbeds;
}

/**
 * Whether the current definition's engine reads attribute literals
 * (`InlineEngineDefinition.attrs`): what the page's Attributes… commands, a
 * span of the selection and a typed literal are offered by.
 */
export function currentReadsAttrs(): boolean {
    return currentDefinition.attrs;
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
 * top where the host reads attributes (`attrs`), registered as the host
 * registers it (`MarkdownItAttrs`, no options): what reads a literal where the
 * editor finds or writes it, as the preview reads it there (`attrsReadAt` in
 * `attrs.ts`). The host's parse asks it with the definition of the engine
 * that read the file, the page with the one it was posted, and the page reads
 * back with it the blocks its save writes (`readUnit` in `serialize.ts`).
 * Where the host reads none it is the page's engine alone, which takes no
 * `{…}`: nothing is escaped, read back or recognised as a literal.
 */
export function attrsEngineFor(definition: InlineEngineDefinition): MarkdownIt {
    if (definition === currentDefinition) {
        currentEngines.attrs ??= withAttrs(currentDefinition);
        return currentEngines.attrs;
    }
    const key = JSON.stringify(definition);
    let md = attrsEngines.get(key);
    if (md === undefined) {
        md = withAttrs(definition);
        attrsEngines.set(key, md);
    }
    return md;
}

/**
 * `createInlineEngine(definition)` with markdown-it-attrs where the definition
 * says the host runs it; where not, the page's engine itself — the current
 * one for the current definition, rather than a second copy of it.
 */
function withAttrs(definition: InlineEngineDefinition): MarkdownIt {
    if (!definition.attrs) {
        return definition === currentDefinition ? currentInlineEngine() : createInlineEngine(definition);
    }
    return createInlineEngine(definition).use(MarkdownItAttrs);
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
