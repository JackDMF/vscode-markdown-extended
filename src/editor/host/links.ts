import * as vscode from 'vscode';

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
