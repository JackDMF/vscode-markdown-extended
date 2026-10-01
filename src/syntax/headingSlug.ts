/**
 * The id VS Code gives a heading, stated once.
 *
 * Three places need it: the preview's table of contents
 * (`src/plugin/markdownItTableOfContents.ts`), which must link to the ids the
 * preview's headings carry; the Visual Editor's host (`src/editor/host/links.ts`),
 * which follows a link's fragment to its heading; and the export, which hands
 * VS Code's engine the builder the preview renders with. Each of them imports
 * this module, so they slug a heading alike. They still differ on an explicit
 * `{#id}`: the editor's link following resolves one (`fragmentLine`), while the
 * preview and the export overwrite it with the slug, and the TOC links the slug.
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
