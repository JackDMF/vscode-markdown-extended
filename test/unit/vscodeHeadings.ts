// eslint-disable-next-line @typescript-eslint/no-require-imports
import MarkdownIt = require('markdown-it');
import { githubSlug, headingText, slugBuilder } from '../../src/syntax/headingSlug';

/**
 * VS Code's heading rule as its Markdown engine installs it, after every
 * extension's `extendMarkdownIt` (`markdown-language-features`, its engine's
 * heading rule): the heading's text slugged by `env.slugifier.add`, else by a
 * stateless slugifier, the id set from the slug, then the rule it wrapped
 * called. `markdown.api.render` tests the real one; this stands in for it where
 * a test renders with an engine of its own.
 */
export function withVscodeHeadingRule(md: MarkdownIt.MarkdownIt): MarkdownIt.MarkdownIt {
    const wrapped = md.renderer.rules.heading_open;
    md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
        const title = headingText(tokens[idx + 1]);
        const slugifier = (env as { slugifier?: { add(heading: string): { value: string } } }).slugifier;
        tokens[idx].attrSet('id', slugifier ? slugifier.add(title).value : githubSlug(title));
        return wrapped ? wrapped(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
    };
    return md;
}

/** A render's `env` with the builder VS Code's preview passes: one per render. */
export function previewEnv(): { slugifier: { add(heading: string): { value: string } } } {
    const slug = slugBuilder();
    return { slugifier: { add: (heading: string) => ({ value: slug(heading) }) } };
}

/** The ids the rendered headings carry, in order. */
export function headingIds(html: string): string[] {
    return [...html.matchAll(/<h[1-6][^>]*\sid="([^"]*)"/g)].map(([, id]) => id);
}

/**
 * The second anchors the rendered headings keep (`<a id="…"></a>` opening
 * their content, with the heading's source map when it has one), in order.
 */
export function secondAnchors(html: string): string[] {
    return [...html.matchAll(/<h[1-6][^>]*><a id="([^"]*)"(?: class="code-line" data-line="\d+")?><\/a>/g)].map(([, id]) => id);
}
