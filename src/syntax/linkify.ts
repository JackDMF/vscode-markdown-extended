/**
 * Where a bare URL is, asked of linkify-it itself, stated once.
 *
 * The sidebar plugin reads a URL in a sidebar's text as markdown-it's linkify
 * rule will (`src/plugin/markdownItSidenote.ts`), asking the engine's own
 * linkify-it, set as VS Code's preview sets it (`configureLinkify`, which
 * every engine the editor builds runs: `src/editor/inlineEngine.ts`).
 */

/** The part of linkify-it this module asks: the URL a text starts with, if any. */
export interface UrlMatcher {
    matchAtStart(text: string): { url: string } | null;
}

/**
 * The options VS Code's preview runs linkify-it with: no fuzzy links, so a bare
 * `example.com` is no link and only a URL with its scheme (`http:`, `https:`,
 * `ftp:`, `mailto:`, `//`) is one. The editor's engine and the page's are both
 * set with these (`baseEngine`).
 */
export const LINKIFY_OPTIONS = { fuzzyLink: false } as const;

/** `linkify`, with `LINKIFY_OPTIONS` set. */
export function configureLinkify<T>(linkify: T): T {
    // linkify-it's `set` is missing from the project's markdown-it declaration.
    (linkify as unknown as { set(options: typeof LINKIFY_OPTIONS): void }).set(LINKIFY_OPTIONS);
    return linkify;
}

/** A character of a URL's scheme (RFC 3986), as markdown-it's linkify rule reads one. */
function isSchemeChar(code: number): boolean {
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)
        || code === 0x2b || code === 0x2d || code === 0x2e;
}

/**
 * The bare URL markdown-it's linkify rule reads at `colon` in `text` — the
 * `:` of a `://` — as `[start, end)`, or `null`. Found as that rule finds it
 * (markdown-it 14, `rules_inline/linkify`): the scheme in at most ten scheme
 * characters before `colon`, none before `textStart` (the rule's pending
 * text), starting with an ASCII letter; the URL by linkify-it's
 * `matchAtStart` over the text from there to `end`; a trailing `*` left out
 * (it is emphasis); one `validate` (markdown-it's `validateLink`) refuses is none.
 */
export function bareUrlAt(
    linkify: UrlMatcher, text: string, colon: number, textStart: number, end: number,
    validate: (url: string) => boolean,
): [number, number] | null {
    if (colon + 3 > end || text.charCodeAt(colon) !== 0x3a || text.charCodeAt(colon + 1) !== 0x2f || text.charCodeAt(colon + 2) !== 0x2f) {
        return null;
    }
    const protoMin = colon - Math.min(10, colon - textStart, colon);
    let start = colon;
    while (start > protoMin && isSchemeChar(text.charCodeAt(start - 1))) {
        start--;
    }
    const first = text.charCodeAt(start);
    if (start === colon || !((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) {
        return null;
    }
    const link = linkify.matchAtStart(text.slice(start, end));
    if (link === null || link.url.length <= colon - start) {
        return null;
    }
    let length = link.url.length;
    while (length > 0 && link.url.charCodeAt(length - 1) === 0x2a) {
        length--;
    }
    if (!validate(link.url.slice(0, length))) {
        return null;
    }
    return [start, start + length];
}
