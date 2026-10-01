/**
 * The id VS Code gives a heading, stated once.
 *
 * Three places need it: the preview's table of contents
 * (`src/plugin/markdownItTableOfContents.ts`), which must link to the ids the
 * preview's headings carry; the Visual Editor's host (`src/editor/host/links.ts`),
 * which follows a link's fragment to its heading; and the export, which hands
 * VS Code's engine the builder the preview renders with. Each of them imports
 * this module, so they slug a heading alike.
 *
 * The rule is one (`headingIds`): a heading carries its explicit `{#id}`
 * (markdown-it-attrs), else its slug; the slug is counted either way, for
 * every `heading_open` of the stream. VS Code's heading rule sets every
 * heading's id from its slug at render time, over the one attrs put there; the
 * id the author wrote is therefore kept on the token (`explicitHeadingId`) and
 * set back by a heading rule VS Code's calls after its own
 * (`src/plugin/markdownItAttrs.ts`), which also keeps the slug the heading
 * took as a second anchor inside it (`<a id="slug"></a>`), so a link written
 * to the slug before the id was honoured still lands.
 *
 * An explicit id may equal another heading's slug (`## Setup {#setup-1}`,
 * `## Setup`, `## Setup` are `setup-1`, `setup-1`, `setup-2`): nothing is
 * renamed, and the first element in document order is the one a fragment
 * names, in the browser and in the Visual Editor alike.
 *
 * VS Code's Markdown language server (link validation, Go to Definition,
 * heading completion) slugs the headings of the tokens it receives on its own
 * and never reads an explicit id: its completion offers `#fr-1-name` for
 * `## FR-1: Name {#fr-1}`, which lands on the second anchor, and with
 * `markdown.validate.enabled` it reports `[x](#fr-1)` as a missing heading —
 * a false report MEP cannot take back, since it does not own that server.
 *
 * It imports neither `vscode` nor markdown-it: a token is read by its shape.
 */
import { GITHUB_SLUG_REPLACE } from './githubSlugRegex';

/**
 * A heading's GitHub-style slug, by the rule VS Code's built-in Markdown
 * extension slugs a heading with (`githubSlugifier`, the same in its preview
 * and its language server): trimmed, lower-cased, stripped of
 * `GITHUB_SLUG_REPLACE`, each white-space character a hyphen. No public command
 * of that extension exposes it, so its rule is ported here, the regex
 * generated from its bundle.
 */
export function githubSlug(heading: string): string {
    return heading.trim().toLowerCase().replace(GITHUB_SLUG_REPLACE, '').replace(/\s/g, '-');
}

/**
 * The slugs of a document's headings in order, as the built-in's slug builder
 * gives them: a repeated slug gets `-1`, `-2`, … by how often it came before.
 * One builder is one document: the preview makes a new one for every render.
 */
export function slugBuilder(): (heading: string) => string {
    const seen = new Map<string, { count: number }>();
    return heading => {
        const slug = githubSlug(heading);
        const entry = seen.get(slug);
        if (entry) {
            entry.count++;
            return githubSlug(`${slug}-${entry.count}`);
        }
        seen.set(slug, { count: 0 });
        return slug;
    };
}

/**
 * The key under a `heading_open` token's `meta` its explicit `{#id}` is kept
 * under: a string, so the token stream stays plain data (VS Code's language
 * server receives it as JSON).
 */
export const EXPLICIT_ID = 'mepExplicitId';

/** The part of a markdown-it token an explicit id is read from. */
export interface MetaToken {
    meta?: unknown;
}

/** The `{#id}` the author wrote on the heading `open` opens, or `null`: the id it carries on every surface. */
export function explicitHeadingId(open: MetaToken | undefined): string | null {
    const id = (open?.meta as Record<string, unknown> | null | undefined)?.[EXPLICIT_ID];
    return typeof id === 'string' && id !== '' ? id : null;
}

/** The part of a markdown-it token the heading's text is read from. */
export interface TextToken {
    type: string;
    content: string;
    children?: readonly TextToken[] | null;
}

/**
 * A heading's text as the built-in slugs it (`tokenToPlainText` in its
 * engine): the text, emoji and inline code of its inline token's children,
 * at any depth. A link contributes its text; markup contributes nothing.
 */
export function headingText(inline: TextToken | undefined): string {
    const walk = (tokens: readonly TextToken[]): string => tokens.map(t => {
        if (t.children && t.children.length > 0) {
            return walk(t.children);
        }
        return t.type === 'text' || t.type === 'emoji' || t.type === 'code_inline' ? t.content : '';
    }).join('');
    return inline ? walk(inline.children ?? []) : '';
}

/** A token of a stream `headingIds` reads: its type, its text, its `meta`. */
export type HeadingToken = TextToken & MetaToken;

/** The id a heading carries, read by `headingIds`. */
export interface HeadingId {
    /** The index of its `heading_open` in the stream. */
    index: number;
    /** The id it carries: its explicit `{#id}`, else its slug (`''` when the slug is empty). */
    id: string;
    /** The slug it took from the count: its id, or its second anchor when `explicit`. */
    slug: string;
    /** Whether `id` is the author's `{#id}`. */
    explicit: boolean;
    /** The text it is slugged from. */
    text: string;
}

/**
 * The ids of a stream's headings in order, by the one rule every surface
 * names a heading with: its explicit `{#id}`, else its slug, the slug counted
 * either way, for every `heading_open` — with a source line or without, at
 * every level — as VS Code's preview counts them with one builder per render.
 */
export function headingIds(tokens: readonly HeadingToken[]): HeadingId[] {
    const slug = slugBuilder();
    const ids: HeadingId[] = [];
    tokens.forEach((token, index) => {
        if (token.type !== 'heading_open') { return; }
        const text = headingText(tokens[index + 1]);
        const slugged = slug(text);
        const explicit = explicitHeadingId(token);
        ids.push({ index, id: explicit ?? slugged, slug: slugged, explicit: explicit !== null, text });
    });
    return ids;
}
