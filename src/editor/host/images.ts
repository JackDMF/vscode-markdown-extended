import * as path from 'path';
import * as vscode from 'vscode';
import type { LinkedFile } from '../protocol';
import { schemeOf, stemOf } from '../paths';
import { resolveLinkTarget } from './links';

/**
 * Images and files the page links to, on the host: the path a new link or
 * image is written with, the file a pasted bitmap is saved as, and the address
 * the webview loads an image's `src` from.
 *
 * Every path the page writes comes from here, relative to the document, and
 * every `src` it shows is resolved here, by `resolveLinkTarget` — the rule a
 * Ctrl+click follows — so a link inserted, an image shown and a link followed
 * cannot read one path three ways.
 */

/** The extensions an image file is recognised by: the open dialog's filter, and which dropped file becomes an image. */
export const IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];

/** The largest pasted bitmap the host writes (base64 decoded). */
export const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024;

export function isImagePath(p: string): boolean {
    const ext = path.posix.extname(p).slice(1).toLowerCase();
    return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * A path as a link destination is written: `%`, white space, `#`, `?`, the
 * parentheses and angle brackets percent-encoded, everything else as it is.
 * `resolveLinkTarget` decodes it again, and markdown-it reads it back to the
 * same characters, so `a b.png` is written `a%20b.png` and found on disk.
 */
export function encodeDestination(p: string): string {
    return p.replace(/[%\s#?()<>]/g, ch => encodeURIComponent(ch).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));
}

/** The drive of a Windows uri path (`/d:/…` → `d:`), lower-cased; `''` for none. */
function driveOf(p: string): string {
    return /^\/([A-Za-z]:)/.exec(p)?.[1].toLowerCase() ?? '';
}

/** A uri path with its drive letter lower-cased (`/D:/x` → `/d:/x`), as `Uri.file` writes it; others unchanged. */
export function lowerDrive(p: string): string {
    return p.replace(/^\/[A-Za-z]:/, d => d.toLowerCase());
}

/**
 * `target` as a path relative to the document's folder, POSIX separators,
 * encoded as a destination (`encodeDestination`); `null` when no relative path
 * reaches it — another scheme or authority, another drive.
 */
export function relativeDestination(target: vscode.Uri, documentUri: vscode.Uri): string | null {
    if (target.scheme !== documentUri.scheme || target.authority !== documentUri.authority) {
        return null;
    }
    const from = path.posix.dirname(documentUri.path);
    if (driveOf(from) !== driveOf(target.path)) {
        return null;
    }
    const relative = path.posix.relative(lowerDrive(from), lowerDrive(target.path));
    return relative === '' ? null : encodeDestination(relative);
}

/**
 * A uri the page sent (`resourceurls`, `text/uri-list`), or a file-system
 * path: parsed as a uri when it has a scheme (`schemeOf`: a drive letter is
 * none), else as a path. `null` for what is neither.
 */
export function uriOf(value: string): vscode.Uri | null {
    const text = value.trim();
    if (text === '') {
        return null;
    }
    try {
        return schemeOf(text) !== undefined ? vscode.Uri.parse(text, true) : vscode.Uri.file(text);
    } catch {
        return null;
    }
}

/**
 * The files the page inserts, as it inserts them: an image by its relative
 * path with its stem as the alt text, any other file as a link named by its
 * file name. A file no relative path reaches is left out.
 */
export function linkedFiles(uris: readonly vscode.Uri[], documentUri: vscode.Uri): LinkedFile[] {
    const files: LinkedFile[] = [];
    for (const uri of uris) {
        const src = relativeDestination(uri, documentUri);
        if (src === null) {
            continue;
        }
        const image = isImagePath(uri.path);
        files.push({ src, alt: image ? stemOf(uri.path) : path.posix.basename(uri.path), image });
    }
    return files;
}

/**
 * The address the webview loads each `src` from, for those that name a file:
 * resolved as a followed link is (`resolveLinkTarget` — relative to the
 * document, a leading `/` to its workspace folder, escapes decoded) and turned
 * into a webview uri. A web address, a `data:` image, anything else is left
 * out and shown as written.
 */
export function displaySources(
    srcs: readonly string[],
    documentUri: vscode.Uri,
    workspaceFolder: vscode.Uri | undefined,
    asWebviewUri: (uri: vscode.Uri) => vscode.Uri,
): Record<string, string> {
    const sources: Record<string, string> = {};
    for (const src of srcs) {
        try {
            const target = resolveLinkTarget(src, documentUri, workspaceFolder);
            if (target.kind !== 'open') {
                continue;
            }
            const file = target.uri.with({ fragment: '', query: '' });
            if (file.toString() === documentUri.toString()) {
                continue;
            }
            sources[src] = asWebviewUri(file).toString();
        } catch {
            // A src no strict parse accepts is shown as written.
        }
    }
    return sources;
}

// ---------------------------------------------------------------------------
// Where a pasted bitmap is written
// ---------------------------------------------------------------------------

/** A file name the page suggested, made a plain name: no folders, no characters a file system refuses. */
export function safeFileName(suggested: string, fallback = 'image.png'): string {
    const base = suggested.split(/[\\/]/).pop()?.replace(/[\u0000-\u001F<>:"|?*]/g, '').trim() ?? '';
    return base === '' || base === '.' || base === '..' ? fallback : base;
}

function pad(n: number, width = 2): string {
    return String(n).padStart(width, '0');
}

/** `yyyymmdd-hhmmss` in local time: the default name's stamp. */
export function timestamp(now: Date): string {
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** What the destination variables need to know about the document. */
export interface DestinationContext {
    documentUri: vscode.Uri;
    workspaceFolder: vscode.Uri | undefined;
    fileName: string;
    now: Date;
}

/**
 * A `markdown.copyFiles.destination` value with its variables filled in, as
 * VS Code's built-in Markdown extension fills them (`resolveCopyDestination`
 * in markdown-language-features): a leading `/` is the workspace folder, a
 * trailing `/` takes the file's name, `${name}` and `${name/regex/replacement/}`
 * are replaced, `\$` is a literal `$`. The result is a path, absolute or
 * relative to the document's folder.
 */
export function fillDestination(dest: string, ctx: DestinationContext): string {
    let out = dest.trim() || '${fileName}';
    if (out.startsWith('/')) {
        out = '${documentWorkspaceFolder}/' + out.slice(1);
    }
    if (out.endsWith('/')) {
        out += '${fileName}';
    }
    const doc = ctx.documentUri;
    const dir = path.posix.dirname(doc.path);
    const docName = path.posix.basename(doc.path);
    const docExt = path.posix.extname(docName);
    const folder = ctx.workspaceFolder?.path;
    const vars = new Map<string, string>([
        ['documentDirName', dir],
        ['documentRelativeDirName', folder ? path.posix.relative(folder, dir) : dir],
        ['documentFileName', docName],
        ['documentBaseName', docName.slice(0, docName.length - docExt.length)],
        ['documentExtName', docExt.replace('.', '')],
        ['documentFilePath', doc.path],
        ['documentRelativeFilePath', folder ? path.posix.relative(folder, doc.path) : doc.path],
        ['documentWorkspaceFolder', folder ?? dir],
        ['fileName', ctx.fileName],
        ['fileExtName', path.posix.extname(ctx.fileName).replace('.', '')],
        ['unixTime', String(ctx.now.getTime())],
        ['isoTime', ctx.now.toISOString()],
    ]);
    const unescape = (s: string) => s.replace(/\\\//g, '/');
    return out.replace(/(\\\$)|(?<!\\)\$\{(\w+)(?:\/((?:\\\/|[^}/])+)\/((?:\\\/|[^}/])*)\/)?\}/g,
        (match: string, escape: string | undefined, name: string, pattern: string | undefined, replacement: string | undefined) => {
            if (escape) {
                return '$';
            }
            const value = vars.get(name);
            if (value === undefined) {
                return match;
            }
            if (pattern && replacement !== undefined) {
                try {
                    return value.replace(new RegExp(unescape(pattern)), unescape(replacement));
                } catch {
                    return value;
                }
            }
            return value;
        });
}

/**
 * Whether `fileName` is the name the browser gives a bitmap that came from no
 * file — a screenshot on the clipboard is `image.png` — rather than a file's
 * own name, which a dropped file keeps.
 */
export function isClipboardName(fileName: string): boolean {
    return /^image\.[A-Za-z0-9]+$/i.test(fileName) || !/\.[A-Za-z0-9]+$/.test(fileName);
}

/**
 * Where a bitmap named `fileName` goes for `document`: the destination of the
 * first `markdown.copyFiles.destination` glob the document matches — VS Code's
 * own setting for its Markdown paste, globs matched the way it matches them (a
 * leading `/` anchored to each workspace folder, one without `**` matched
 * anywhere) — else, beside the document, `images/<file name>` for a file
 * dropped from the system (it keeps its name) and
 * `images/<document stem>-<yyyymmdd-hhmmss>.<ext>` for a screenshot.
 */
export function pastedImageUri(document: vscode.TextDocument, fileName: string, now: Date): vscode.Uri {
    const uri = document.uri;
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri;
    const dir = vscode.Uri.joinPath(uri, '..');
    const setting = vscode.workspace.getConfiguration('markdown', uri).get<Record<string, unknown>>('copyFiles.destination') ?? {};
    for (const [glob, dest] of Object.entries(setting)) {
        if (typeof dest !== 'string' || !globMatches(glob, document)) {
            continue;
        }
        const filled = fillDestination(dest, { documentUri: uri, workspaceFolder: folder, fileName, now });
        return filled.startsWith('/')
            ? uri.with({ path: path.posix.normalize(filled) })
            : vscode.Uri.joinPath(dir, ...filled.split('/').filter(s => s !== ''));
    }
    if (!isClipboardName(fileName)) {
        return vscode.Uri.joinPath(dir, 'images', fileName);
    }
    const ext = path.posix.extname(fileName) || '.png';
    return vscode.Uri.joinPath(dir, 'images', `${stemOf(uri.path)}-${timestamp(now)}${ext}`);
}

function globMatches(glob: string, document: vscode.TextDocument): boolean {
    const patterns: vscode.GlobPattern[] = glob.startsWith('/')
        ? (vscode.workspace.workspaceFolders ?? []).map(f => new vscode.RelativePattern(f, glob.slice(1)))
        : [glob.startsWith('**') ? glob : `**/${glob}`];
    return patterns.some(pattern => vscode.languages.match({ pattern }, document) > 0);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

/**
 * `uri`, or — when a file is there and `markdown.copyFiles.overwriteBehavior`
 * is not `overwrite` — the first free `name-1.ext`, `name-2.ext`, …, as the
 * built-in names a pasted file incrementally.
 */
export async function freeUri(uri: vscode.Uri, document: vscode.TextDocument): Promise<vscode.Uri> {
    const behavior = vscode.workspace.getConfiguration('markdown', document.uri).get<string>('copyFiles.overwriteBehavior', 'nameIncrementally');
    if (behavior === 'overwrite' || !(await exists(uri))) {
        return uri;
    }
    const dir = vscode.Uri.joinPath(uri, '..');
    const base = path.posix.basename(uri.path);
    const ext = path.posix.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    for (let n = 1; n < 10000; n++) {
        const candidate = vscode.Uri.joinPath(dir, `${stem}-${n}${ext}`);
        if (!(await exists(candidate))) {
            return candidate;
        }
    }
    return uri;
}

/**
 * Write a pasted or dropped bitmap beside the document (`pastedImageUri`, a
 * free name `freeUri`), its folders created, and answer the image as the page
 * inserts it: its path relative to the document, encoded, and its file's stem
 * as the alt text. Throws with a reason the person can read when it cannot.
 *
 * `freeUri` looks before it writes, so two saves at once could pick one name:
 * the caller runs them one after another (`LinksAndImages`).
 */
export async function savePastedImage(document: vscode.TextDocument, base64: string, suggestedName: string, now = new Date()): Promise<LinkedFile> {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) {
        throw new Error('the pasted image is empty');
    }
    if (bytes.length > MAX_PASTED_IMAGE_BYTES) {
        throw new Error(`the pasted image is larger than ${MAX_PASTED_IMAGE_BYTES / (1024 * 1024)} MB`);
    }
    const target = await freeUri(pastedImageUri(document, safeFileName(suggestedName), now), document);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.writeFile(target, bytes);
    const src = relativeDestination(target, document.uri);
    if (src === null) {
        throw new Error(`${target.fsPath} was written, but no relative path from the document reaches it`);
    }
    return { src, alt: stemOf(target.path), image: true };
}
