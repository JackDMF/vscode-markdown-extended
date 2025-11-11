import { MarkdownIt } from '../@types/markdown-it';
import { slugify } from './shared';

/** Regular expression to match markdown anchor links like [text](#anchor) */
const anchorLinkReg = /\[.+?\]\(\s*#(\S+?)\s*\)/ig;

/**
 * Markdown-it plugin to automatically convert anchor link references to slugified IDs.
 * Ensures that anchor links like [text](#My Title) are converted to [text](#my-title)
 * to match the slugified heading IDs.
 * 
 * @param md - The markdown-it instance
 * @example
 * ```markdown
 * ## My Heading
 * 
 * See [My Heading](#My Heading) for details.
 * // Link href will be converted to "#my-heading"
 * ```
 */
export function MarkdownItAnchorLink(md: MarkdownIt) {
    md.core.ruler.push("anchorLink", anchorLinkWorker);
}

function anchorLinkWorker(state: any) {
    state.tokens.map(t => {
        if (
            t.type === "inline" &&
            t.children &&
            t.children.length &&
            anchorLinkReg.test(t.content)
        ) {
            let matches: RegExpMatchArray;
            const links: string[] = [];
            anchorLinkReg.lastIndex = 0;
            while (matches = anchorLinkReg.exec(t.content)) {
                links.push("#" + slugify(matches[1]));
            }
            const linkCount: number = t.children.reduce((p, c) => p += c.type === "link_open" ? 1 : 0, 0);
            if (linkCount !== links.length) {
                console.log("markdownExtended: Link count and link token count mismatch!");
            } else {
                t.children.map(t => {
                    if (t.type === "link_open")
                        {t.attrs = [["href", links.shift()]];}
                });
            }
        }
    });
}
