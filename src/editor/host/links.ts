import * as vscode from 'vscode';
import { Environment, MarkdownIt } from '../../@types/markdown-it';
import { decode, schemeOf } from '../paths';
import { headingIds } from '../../syntax/headingSlug';

/**
 * Where a link the person Ctrl/Cmd+clicked in the rich editor goes.
 *
 * - `external`: a web or mail address, opened by the system (`env.openExternal`).
 * - `open`: a file, opened in VS Code (`vscode.open`), its `#fragment` kept on
 *   the uri for an opener that understands it.
 * - `refused`: anything else. The href comes from the page, and a scheme that
 *   runs something (`command:`, `vscode:`, `javascript:`) is not followed.
 */
export type LinkTarget =
    | { kind: 'external'; uri: vscode.Uri }
    | { kind: 'open'; uri: vscode.Uri }
    | { kind: 'refused'; reason: string };

const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * Resolve `href` as the preview would: a scheme names the target; a path is
 * relative to the document's folder, or with a leading `/` to the workspace
 * folder the document is in (the file system root when it is in none); an
 * empty path with a fragment is the document itself. A query is dropped — a
 * file has none. Percent escapes are decoded (markdown-it encodes non-ASCII
 * in a destination; the file on disk is named with the characters).
 */
export function resolveLinkTarget(href: string, documentUri: vscode.Uri, workspaceFolder?: vscode.Uri): LinkTarget {
    const link = href.trim();
    if (link === '') {
        return { kind: 'refused', reason: 'the link is empty' };
    }
    // A drive letter is no scheme: `C:/notes/a.md` is a path.
    const scheme = schemeOf(link);
    if (scheme !== undefined) {
        if (EXTERNAL_SCHEMES.has(scheme)) {
            return { kind: 'external', uri: vscode.Uri.parse(link, true) };
        }
        if (scheme === 'file') {
            return { kind: 'open', uri: vscode.Uri.parse(link, true) };
        }
        return { kind: 'refused', reason: `links with the scheme ${scheme}: are not followed from the editor` };
    }
    const hash = link.indexOf('#');
    const fragment = hash < 0 ? '' : decode(link.slice(hash + 1));
    const beforeHash = hash < 0 ? link : link.slice(0, hash);
    const path = decode(beforeHash.split('?')[0]).replace(/\\/g, '/');
    if (path === '') {
        return { kind: 'open', uri: documentUri.with({ fragment }) };
    }
    if (/^[A-Za-z]:\//.test(path)) {
        return { kind: 'open', uri: vscode.Uri.file(path).with({ fragment }) };
    }
    const base = path.startsWith('/')
        ? workspaceFolder ?? documentUri.with({ path: '/' })
        : vscode.Uri.joinPath(documentUri, '..');
    const segments = path.split('/').filter(s => s !== '');
    return { kind: 'open', uri: vscode.Uri.joinPath(base, ...segments).with({ fragment }) };
}

// ---------------------------------------------------------------------------
// Fragments: the element a link lands on
// ---------------------------------------------------------------------------

/*
 * A heading's slug is the built-in's (`src/syntax/headingSlug.ts`): no public
 * command of that extension opens a document at a fragment for another
 * extension (`openDocumentLink` is internal to it), so its rule is ported, and
 * the preview's table of contents links with the same one.
 */
export { githubSlug, slugBuilder } from '../../syntax/headingSlug';

/**
 * A heading a fragment can name: its 0-based line (`null` for a heading
 * without a source line, which a core rule may push), the id it carries and
 * whether it is `explicit` (`headingIds`: its explicit `{#id}`, else its
 * slug), the slug it took from the count, its second anchor, and the text its
 * slug is made of.
 */
export interface HeadingAnchor {
    line: number | null;
    id: string;
    explicit: boolean;
    slug: string;
    anchor: string | null;
    text: string;
}

/**
 * Every heading of `text` as the engine parses it — the preview's composition,
 * so `markdown-it-attrs` has read a `{#id}` and taken it out of the text that
 * is slugged — named by the preview's rule (`headingIds`).
 */
export function headingAnchors(md: MarkdownIt, text: string, env: Environment): HeadingAnchor[] {
    const tokens = md.parse(text, env);
    return headingIds(tokens).map(({ index, id, explicit, slug, anchor, text }) => ({
        line: tokens[index].map?.[0] ?? null, id, explicit, slug, anchor, text: text.trim(),
    }));
}

/**
 * The heading a fragment names, or `null`: the first in document order that
 * carries it — as its id, or as its second anchor — the element the browser
 * lands on, so an explicit id another heading's slug repeats names the first
 * of the two; else the first one of whose slugs it is without case, as the
 * built-in compares a fragment — further than the browser goes, which finds
 * no element for `#Setup`. A slug is the id of a heading without an explicit
 * one, an explicit id that is the heading's slug (`## Setup {#setup}`), or a
 * second anchor; any other explicit id is compared as written.
 */
export function fragmentHeading(anchors: readonly HeadingAnchor[], fragment: string): HeadingAnchor | null {
    if (fragment === '') {
        return null;
    }
    const exact = anchors.find(a => a.id === fragment || a.anchor === fragment);
    if (exact) {
        return exact;
    }
    const lower = fragment.toLowerCase();
    const slugs = (a: HeadingAnchor) => [!a.explicit || a.id === a.slug ? a.id : null, a.anchor];
    return anchors.find(a => slugs(a).some(s => s !== null && s.toLowerCase() === lower)) ?? null;
}

/**
 * The 0-based line a fragment names, or `null`: the line of the heading it
 * names (`fragmentHeading`), else a line fragment (`L12`, `12`, `L12,5`) as
 * the built-in reads one. A heading without a source line that is the first
 * to carry the fragment names no line: `null`, never a later heading.
 */
export function fragmentLine(anchors: readonly HeadingAnchor[], fragment: string): number | null {
    const heading = fragmentHeading(anchors, fragment);
    if (heading) {
        return heading.line;
    }
    const line = /^L?(\d+)(?:,\d+)?(?:-L?\d+(?:,\d+)?)?$/i.exec(fragment);
    const n = line ? parseInt(line[1], 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n - 1 : null;
}
