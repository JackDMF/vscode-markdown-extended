/**
 * Raw HTML in a hover (`MarkdownString.supportHtml`), made safe to hand to the
 * page — the allowlist VS Code's own Markdown renderer applies to a hover
 * (`renderMarkdown`'s `allowedMarkdownHtmlTags` and attributes), enforced
 * here on the host, where no DOM is available, by a small tag scanner.
 *
 * What passes: the allowed tags, each rebuilt from its allowed attributes with
 * their values escaped; `href` and `src` only with a scheme a hover may link
 * to (`http`, `https`, `mailto`, `file`, a `data:` image), never `command:` —
 * a command link is the link rule's to make, from Markdown, when the part is
 * trusted. Every other attribute — `on*`, `style`, `id`, any `data-*`, the
 * page's own `data-mep-command` and `data-mep-action` above all — is dropped,
 * so raw HTML cannot forge a link the card would run. The one exception is a
 * `data-mep-command` on a tag that also carries `data-mep-nonce` equal to
 * `nonce`: the mark the link rule put on the command links it made, which raw
 * HTML cannot know; the nonce itself never passes. A tag not allowed is
 * dropped and its text kept; the content of `script`, `style`, `textarea`,
 * `iframe`, `object`, `svg` and the like is dropped with it; comments and
 * declarations go; a `<` that opens no tag is text.
 */

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
    'a', 'abbr', 'b', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
    'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins',
    'kbd', 'label', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var',
]);

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
    'align', 'alt', 'class', 'colspan', 'height', 'href', 'rowspan', 'src', 'start', 'title', 'width', 'open',
]);

/** Elements whose content is not text to keep when the element goes. */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
    'script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noscript', 'noembed', 'noframes', 'template', 'object',
    'embed', 'svg', 'math', 'select', 'button', 'form', 'frameset', 'frame', 'head',
]);

const TAG = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Character references decoded far enough to read a URL's scheme (`jav&#x61;script:` is `javascript:`). */
function decodedForScheme(value: string): string {
    return value
        .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);?/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&colon;/gi, ':')
        .replace(/[\u0000- \u007f]/g, '');
}

function allowedUrl(value: string, attribute: 'href' | 'src'): boolean {
    const url = decodedForScheme(value);
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    if (scheme === undefined) {
        // Relative, or a fragment: resolved by the page's link handling like any link.
        return true;
    }
    if (attribute === 'src' && scheme === 'data') {
        return /^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(url);
    }
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'file';
}

function rebuildTag(name: string, closing: boolean, attributes: string, selfClosing: boolean, nonce: string | undefined): string {
    if (closing) {
        return `</${name}>`;
    }
    const kept: string[] = [];
    const found: [string, string][] = [];
    ATTRIBUTE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTRIBUTE.exec(attributes)) !== null) {
        found.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']);
    }
    const marked = nonce !== undefined && found.some(([key, value]) => key === 'data-mep-nonce' && value === nonce);
    for (const [key, value] of found) {
        if (key === 'data-mep-command' && marked && name === 'a') {
            kept.push(`${key}="${escapeAttribute(value)}"`);
            continue;
        }
        if (!ALLOWED_ATTRIBUTES.has(key)) {
            continue;
        }
        if ((key === 'href' || key === 'src') && !allowedUrl(value, key)) {
            continue;
        }
        if (key === 'href' && name !== 'a') {
            continue;
        }
        if (key === 'src' && name !== 'img') {
            continue;
        }
        kept.push(`${key}="${escapeAttribute(value)}"`);
    }
    return `<${name}${kept.length > 0 ? ` ${kept.join(' ')}` : ''}${selfClosing ? ' /' : ''}>`;
}

/** `html`, a raw HTML fragment, with only what a hover may show left in it. */
export function sanitizeHoverHtml(html: string, nonce?: string): string {
    let out = '';
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt < 0) {
            out += html.slice(i);
            break;
        }
        out += html.slice(i, lt);
        const rest = html.slice(lt);
        if (rest.startsWith('<!--')) {
            const end = html.indexOf('-->', lt + 4);
            i = end < 0 ? html.length : end + 3;
            continue;
        }
        if (/^<[!?]/.test(rest)) {
            const end = html.indexOf('>', lt);
            i = end < 0 ? html.length : end + 1;
            continue;
        }
        const tag = TAG.exec(rest);
        if (!tag) {
            out += '&lt;';
            i = lt + 1;
            continue;
        }
        const [whole, slash, rawName, attributes, selfClose] = tag;
        const name = rawName.toLowerCase();
        i = lt + whole.length;
        if (DROPPED_WITH_CONTENT.has(name)) {
            if (slash === '' && selfClose === '') {
                const close = new RegExp(`</${name}\\s*>`, 'i').exec(html.slice(i));
                i = close ? i + close.index + close[0].length : html.length;
            }
            continue;
        }
        if (!ALLOWED_TAGS.has(name)) {
            continue;
        }
        out += rebuildTag(name, slash === '/', attributes, selfClose === '/', nonce);
    }
    return out;
}
