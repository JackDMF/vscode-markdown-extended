import { MarkdownIt, Token, TokenRender } from "../@types/markdown-it";
import markdownItHtml5Embed from 'markdown-it-html5-embed';

// markdown-it-html5-embed 0.3.3 embeds a link to a media file by hiding the
// link's text — but it hides every token from the link to the end of the
// inline, and throws on any it does not expect (`Unexpected token: softbreak`,
// `… strong_open`), which blanks the whole preview
// (qjebbs/vscode-markdown-extended#154). The plugin's link rule is therefore
// shown only the link — its open, its text, a close — and the tokens up to the
// link's own close are hidden here.
//
// It also asks mimoza for the type, and mimoza reads `.ts` and `.mts` as
// MPEG-TS video, so a link to TypeScript source became a `<video>`
// (qjebbs/vscode-markdown-extended#177). A link to `video/mp2t` stays a link;
// `![](clip.ts)` still embeds, since an image is asked for.
const LINK_REFUSED = ['video/mp2t'];
// What the plugin's link rule falls back to; tells this module to render the link.
const NOT_EMBEDDED = '\u0000mep-html5-embed: not embedded';
const HIDDEN = 'mep_html5_embed_hidden';

interface Html5EmbedOptions {
    useImageSyntax?: boolean;
    useLinkSyntax?: boolean;
    isAllowedMimeType?: (match: RegExpExecArray) => boolean;
    [key: string]: unknown;
}

type TokenClass = new (type: string, tag: string, nesting: number) => Token;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItHtml5Embed(md: MarkdownIt, options?: { html5embed?: Html5EmbedOptions }) {
    const { useImageSyntax, useLinkSyntax, ...rest } = options?.html5embed ?? { useImageSyntax: true };
    if (useImageSyntax) {
        md.use(markdownItHtml5Embed, { html5embed: { ...rest, useImageSyntax: true } });
    }
    if (useLinkSyntax) {
        useLink(md, rest);
    }
}

function useLink(md: MarkdownIt, options: Html5EmbedOptions) {
    const previous = md.renderer.rules.link_open as TokenRender | undefined;
    const allowed = options.isAllowedMimeType;
    md.renderer.rules.link_open = () => NOT_EMBEDDED;
    md.use(markdownItHtml5Embed, {
        html5embed: {
            ...options,
            useLinkSyntax: true,
            isAllowedMimeType: (match: RegExpExecArray) =>
                !LINK_REFUSED.includes(match[0].toLowerCase()) && (!allowed || allowed(match)),
        },
    });
    const embed = md.renderer.rules.link_open;
    const render: TokenRender = previous ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));

    md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
        const close = closeOf(tokens, idx);
        if (close < 0) {
            return render(tokens, idx, opts, env, self);
        }
        const tokenClass = tokens[idx].constructor as TokenClass;
        const title = new tokenClass('text', '', 0);
        title.content = textOf(tokens.slice(idx + 1, close));
        const html = embed([tokens[idx], title, new tokenClass('link_close', 'a', -1)], 0, opts, env, self);
        if (html === NOT_EMBEDDED) {
            return render(tokens, idx, opts, env, self);
        }
        // Replaced, not changed: a token another reader holds keeps its content.
        for (let i = idx + 1; i < close; i++) {
            tokens[i] = new tokenClass(HIDDEN, '', 0);
            tokens[i].hidden = true;
        }
        tokens[close].hidden = true;
        return html;
    };
}

function closeOf(tokens: Token[], open: number): number {
    let depth = 0;
    for (let i = open; i < tokens.length; i++) {
        if (tokens[i].type === 'link_open') {
            depth++;
        } else if (tokens[i].type === 'link_close' && --depth === 0) {
            return i;
        }
    }
    return -1;
}

// The link's text as the embed's fallback content: what a reader reads of it.
function textOf(tokens: Token[]): string {
    return tokens.map(t => {
        switch (t.type) {
            case 'text':
            case 'code_inline':
                return t.content;
            case 'softbreak':
            case 'hardbreak':
                return ' ';
            default:
                return t.children ? textOf(t.children) : '';
        }
    }).join('');
}
