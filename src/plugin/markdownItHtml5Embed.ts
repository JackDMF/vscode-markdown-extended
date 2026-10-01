import { MarkdownIt, Token, TokenRender } from "../@types/markdown-it";
import markdownItHtml5Embed from 'markdown-it-html5-embed';
import mimoza from 'mimoza';

// markdown-it-html5-embed 0.3.3 embeds a link to a media file by hiding the
// link's text — but it hides every token from the link to the end of the
// inline, and throws on any it does not expect (`Unexpected token: softbreak`,
// `… strong_open`), which blanks the whole preview
// (qjebbs/vscode-markdown-extended#154). Its rules are therefore never given
// the document's tokens: an embeddable link is collapsed, in a copy of the
// inline's tokens made at render time, into one token holding only the link —
// its open, its text, a close — and the parsed tokens stay as they were, so a
// second render of them is the first.
//
// It embeds every type mimoza calls audio or video, and mimoza reads `.ts` and
// `.mts` as MPEG-TS video, `.dts` and `.m3u` as audio, so a link to TypeScript
// source became a `<video>` (qjebbs/vscode-markdown-extended#177). A link is
// embedded only when its type is one a browser plays; image syntax asks for the
// embed and keeps every audio and video type.
//
// It writes the source and the title into the HTML as they are, but markdown-it
// has already decoded them (`&lt;` is `<`), so both are escaped here first.
const LINK_PLAYABLE = new Set([
    'video/mp4', 'video/x-m4v', 'video/webm', 'video/ogg',
    'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/x-aac',
    'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/flac', 'audio/x-flac',
]);
const MEDIA = /^(audio|video)\/.*/i;
// What a plugin rule falls back to; tells this module the token is not embedded.
const NOT_EMBEDDED = '\u0000mep-html5-embed: not embedded';
const EMBED = 'mep_html5_embed';

type MimeMatch = RegExpExecArray;

interface Html5EmbedOptions {
    useImageSyntax?: boolean;
    useLinkSyntax?: boolean;
    isAllowedMimeType?: (match: MimeMatch) => boolean;
    /* eslint-disable @typescript-eslint/naming-convention -- the library's own aliases */
    use_image_syntax?: boolean;
    use_link_syntax?: boolean;
    is_allowed_mime_type?: (match: MimeMatch) => boolean;
    /* eslint-enable @typescript-eslint/naming-convention */
    [key: string]: unknown;
}

interface EmbedMeta {
    probe: Token[];
    span: Token[];
}

type TokenClass = new (type: string, tag: string, nesting: number) => Token;

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItHtml5Embed(md: MarkdownIt, options?: { html5embed?: Html5EmbedOptions }) {
    const {
        useImageSyntax, use_image_syntax: imageAlias,
        useLinkSyntax, use_link_syntax: linkAlias,
        isAllowedMimeType, is_allowed_mime_type: allowedAlias,
        ...rest
    } = options?.html5embed ?? { useImageSyntax: true };
    const allowed = isAllowedMimeType ?? allowedAlias;
    if (useImageSyntax ?? imageAlias) {
        useImage(md, rest, allowed);
    }
    if (useLinkSyntax ?? linkAlias) {
        useLink(md, rest, allowed);
    }
}

function useImage(md: MarkdownIt, options: Html5EmbedOptions, allowed: Html5EmbedOptions['isAllowedMimeType']) {
    const embed = pluginRule(md, 'image', { ...options, useImageSyntax: true, isAllowedMimeType: allowed });
    const image = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, opts, env, self) => {
        const html = embed([escapedCopy(md, tokens[idx])], 0, opts, env, self);
        return html === NOT_EMBEDDED ? image(tokens, idx, opts, env, self) : html;
    };
}

function useLink(md: MarkdownIt, options: Html5EmbedOptions, allowed: Html5EmbedOptions['isAllowedMimeType']) {
    const playable = (match: MimeMatch) => LINK_PLAYABLE.has(match[0].toLowerCase()) && (!allowed || allowed(match));
    const embed = pluginRule(md, 'link_open', { ...options, useLinkSyntax: true, isAllowedMimeType: playable });
    const renderInline = md.renderer.renderInline;

    md.renderer.rules[EMBED] = (tokens, idx, opts, env, self) => {
        const { probe, span } = tokens[idx].meta as EmbedMeta;
        const html = embed(probe, 0, opts, env, self);
        return html === NOT_EMBEDDED ? renderInline.call(self, span, opts, env) : html;
    };
    md.renderer.renderInline = function (tokens, opts, env) {
        const embeddable = (token: Token) => {
            const match = MEDIA.exec(mimoza.getMimeType(token.attrGet('href') ?? '') ?? '');
            return match !== null && playable(match);
        };
        return renderInline.call(this, collapsed(md, tokens, embeddable), opts, env);
    };
}

/**
 * The plugin's rule for `name`, installed with a stand-in as its default so a
 * token it does not embed answers `NOT_EMBEDDED`; the rule before it is put
 * back, also when the plugin throws.
 */
function pluginRule(md: MarkdownIt, name: string, html5embed: Html5EmbedOptions): TokenRender {
    const rules = md.renderer.rules;
    const previous = rules[name];
    rules[name] = () => NOT_EMBEDDED;
    try {
        md.use(markdownItHtml5Embed, { html5embed });
        return rules[name];
    } finally {
        if (previous) {
            rules[name] = previous;
        } else {
            delete rules[name];
        }
    }
}

// The inline's tokens with every embeddable link as one EMBED token, or the tokens themselves when there is none.
function collapsed(md: MarkdownIt, tokens: Token[], embeddable: (token: Token) => boolean): Token[] {
    let out: Token[] | undefined;
    for (let i = 0; i < tokens.length; i++) {
        const close = tokens[i].type === 'link_open' && embeddable(tokens[i]) ? closeOf(tokens, i) : -1;
        if (close < 0) {
            out?.push(tokens[i]);
            continue;
        }
        out ??= tokens.slice(0, i);
        const tokenClass = tokens[i].constructor as TokenClass;
        const title = new tokenClass('text', '', 0);
        title.content = md.utils.escapeHtml(textOf(tokens.slice(i + 1, close)));
        const token = new tokenClass(EMBED, '', 0);
        token.meta = {
            probe: [escapedCopy(md, tokens[i]), title, new tokenClass('link_close', 'a', -1)],
            span: tokens.slice(i, close + 1),
        } satisfies EmbedMeta;
        out.push(token);
        i = close;
    }
    return out ?? tokens;
}

// A copy of a link or an image for the plugin, its attributes and its text escaped.
function escapedCopy(md: MarkdownIt, token: Token): Token {
    const copy = new (token.constructor as TokenClass)(token.type, token.tag, token.nesting);
    copy.attrs = token.attrs?.map(([name, value]) => [name, md.utils.escapeHtml(value)]) ?? null;
    copy.content = md.utils.escapeHtml(token.content);
    return copy;
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
// A leaf's content is its text (an emoji's is the emoji); raw HTML is not text.
function textOf(tokens: Token[]): string {
    return tokens.map(t => {
        if (t.type === 'softbreak' || t.type === 'hardbreak') {
            return ' ';
        }
        if (t.children) {
            return textOf(t.children);
        }
        return t.nesting === 0 && t.type !== 'html_inline' ? t.content : '';
    }).join('');
}
