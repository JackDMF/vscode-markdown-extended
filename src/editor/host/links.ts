import * as vscode from 'vscode';
import { Environment, MarkdownIt, Token } from '../../@types/markdown-it';
import { GITHUB_SLUG_REPLACE } from './githubSlugRegex';

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

function decode(path: string): string {
    try {
        return decodeURIComponent(path);
    } catch {
        return path;
    }
}

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
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(link)?.[1]?.toLowerCase();
    if (scheme !== undefined && !/^[A-Za-z]:[\\/]/.test(link)) {
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

/**
 * A heading's GitHub-style slug, by the rule VS Code's built-in Markdown
 * language server resolves a link's fragment with (`githubSlugifier`): trimmed,
 * lower-cased, stripped of `GITHUB_SLUG_REPLACE`, each white-space character a
 * hyphen. No public command of that extension opens a document at a fragment
 * for another extension (`openDocumentLink` is internal to it), so its rule is
 * ported here, the regex generated from its bundle.
 */
export function githubSlug(heading: string): string {
    return heading.trim().toLowerCase().replace(GITHUB_SLUG_REPLACE, '').replace(/\s/g, '-');
}

/**
 * The slugs of a document's headings in order, as the built-in's slug builder
 * gives them: a repeated slug gets `-1`, `-2`, … by how often it came before.
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

/** A heading a fragment can name: its 0-based line, its explicit `{#id}`, its slug, and the text the slug is made of. */
export interface HeadingAnchor {
    line: number;
    id: string | null;
    slug: string;
    text: string;
}

/** A heading's text as the built-in slugs it: the text, emoji and inline code of its inline children. */
function headingText(inline: Token | undefined): string {
    const walk = (tokens: readonly Token[]): string => tokens.map(t => {
        if (t.children && t.children.length > 0) {
            return walk(t.children);
        }
        return t.type === 'text' || t.type === 'emoji' || t.type === 'code_inline' ? t.content : '';
    }).join('');
    return inline ? walk(inline.children ?? []) : '';
}

/**
 * Every heading of `text` as the engine parses it — the preview's composition,
 * so `markdown-it-attrs` has read a `{#id}` into the heading's `id` and taken
 * it out of the text that is slugged.
 */
export function headingAnchors(md: MarkdownIt, text: string, env: Environment): HeadingAnchor[] {
    const tokens = md.parse(text, env);
    const slug = slugBuilder();
    const anchors: HeadingAnchor[] = [];
    tokens.forEach((token, i) => {
        if (token.type === 'heading_open' && token.map) {
            const text = headingText(tokens[i + 1]);
            anchors.push({ line: token.map[0], id: token.attrGet('id'), slug: slug(text), text: text.trim() });
        }
    });
    return anchors;
}

/**
 * The 0-based line a fragment names, or `null`: a heading whose explicit `id`
 * is the fragment — Req Explorer's anchors are written as `{#id}`, and an id
 * the author wrote wins over a slug — else a heading whose slug is the
 * fragment, compared without case as the built-in does, else a line fragment
 * (`L12`, `12`, `L12,5`) as the built-in reads one.
 */
export function fragmentLine(anchors: readonly HeadingAnchor[], fragment: string): number | null {
    if (fragment === '') {
        return null;
    }
    const byId = anchors.find(a => a.id === fragment);
    if (byId) {
        return byId.line;
    }
    const lower = fragment.toLowerCase();
    const bySlug = anchors.find(a => a.slug.toLowerCase() === lower);
    if (bySlug) {
        return bySlug.line;
    }
    const line = /^L?(\d+)(?:,\d+)?(?:-L?\d+(?:,\d+)?)?$/i.exec(fragment);
    const n = line ? parseInt(line[1], 10) : NaN;
    return Number.isInteger(n) && n > 0 ? n - 1 : null;
}
