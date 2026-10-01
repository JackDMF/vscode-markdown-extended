import { MarkdownIt, Token } from '../@types/markdown-it';
import { MarkdownItEnv, HtmlExporterEnv } from '../services/common/interfaces';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    cssFileToDataUri, EmbedScope, embedScope, fileToDataUri, hasDataUriSchema, isNetworkPath, LocalFile, resolveLocalFile,
} from '../services/common/dataUri';
import { ExtensionContext } from '../services/common/extensionContext';
import { decode, schemeOf } from '../editor/paths';
import { documentRoots } from '../editor/host/roots';

/**
 * Markdown-it plugin to prepare images for HTML export.
 *
 * This plugin:
 * - Removes VS Code file:// URIs from image paths
 * - Embeds images as base64 data URIs when embedImage is enabled
 * - Resolves relative image paths to absolute paths
 * - Embeds the local stylesheets a document links with `<link>` as data URIs
 * - Embeds only the files `markdownExtended.export.embedFiles` allows
 *
 * @param md - The markdown-it instance
 * @example
 * ```typescript
 * // In export code:
 * const env: HtmlExporterEnv = {
 *   uri: documentUri,
 *   embedImage: true,
 *   embedFiles: 'workspace',
 *   vsUri: 'file:///',
 *   workspaceFolder: workspace.workspaceFolders[0]
 * };
 * md.render(content, { htmlExporter: env });
 * ```
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItExportHelper(md: MarkdownIt) {
    md.core.ruler.push("exportHelper", state => exportHelperWorker(state, md));
}

/**
 * Where the document's HTML stands after the html tokens read so far, in
 * source order: inside a comment, or inside a raw-text element, until the
 * html token that ends it. Text between html tokens is escaped by the
 * renderer, so it can neither open nor end either.
 */
interface ScanState {
    comment?: boolean;
    rawText?: string;
}

/**
 * Where one render finds the files the document names: the folders a
 * relative path is looked up in, and what it may embed.
 */
interface Embedding {
    folders: string[];
    scope: EmbedScope;
}

/**
 * The render's `Embedding`, made once, the first time a local file the
 * document names is looked up: a render that names none reads no folder.
 */
type RenderEmbedding = () => Embedding;

function exportHelperWorker(state: any, md: MarkdownIt) {
    const env = (state.env as MarkdownItEnv).htmlExporter;
    if (!env) {return;}
    let made: Embedding | undefined;
    const embedding = () => {
        if (made) {return made;}
        made = embeddingOf(env);
        if (made.scope.embedFiles === "none") {
            info(`"${path.basename(env.uri.fsPath)}" is exported without the files it names: markdownExtended.export.embedFiles is "none"`);
        }
        return made;
    };
    enumTokens(state.tokens, env, embedding, md, {});
}
function enumTokens(tokens: Token[], env: HtmlExporterEnv, embedding: RenderEmbedding, md: MarkdownIt, scan: ScanState) {
    tokens.map(t => {
        if (t.type === "image") {
            const written = t.attrGet("src");
            removeVsUri(t, env);
            if (env.embedImage) {embedImage(t, embedding, written);}
        }
        if (t.type === "html_block" || t.type === "html_inline") {
            t.content = embedStylesheets(t.content, embedding, md, scan);
        }
        // An image's children are its alt text, which the renderer escapes
        // into an attribute: HTML there opens and ends nothing.
        if (t.children && t.type !== "image") {enumTokens(t.children, env, embedding, md, scan);}
    });
}
function removeVsUri(token: Token, env: HtmlExporterEnv) {
    let index = 0;
    let src = "";
    for (let i = 0; i < token.attrs.length; i++) {
        if (token.attrs[i][0] === "src") {
            index = i;
            src = token.attrs[i][1];
        }
    }
    // A malformed escape (`caf%E9.png`) is left as written rather than failing the export.
    token.attrs[index][1] = decode(src.replace(env.vsUri, ""));
}
function embedImage(token: Token, embedding: RenderEmbedding, written: string) {
    let index = 0;
    let src = "";
    for (let i = 0; i < token.attrs.length; i++) {
        if (token.attrs[i][0] === "src") {
            index = i;
            src = token.attrs[i][1];
            break;
        }
    }
    if (!src) return;
    // An image that cannot be embedded keeps the src as written, not the
    // decoded path it was looked up by (`shot%231.png` is not `shot#1.png`):
    // a null src breaks html5-embed downstream (qjebbs/vscode-markdown-extended#157).
    token.attrs[index][1] = image2Base64(src, written, embedding) ?? written;
}
/**
 * The image as a data URI, or undefined when it is not embedded.
 * @param src the src decoded, as a path names the file
 * @param written the src as written, as a `file:` URL names it
 */
function image2Base64(src: string, written: string, embedding: RenderEmbedding): string | undefined {
    const file = addressedFile(`Image "${src}"`, schemeOf(src) === "file" ? written : src, () => src, hasDataUriSchema, embedding);
    if (!file) {return undefined;}
    try {
        return fileToDataUri(file.real) ?? undefined;
    } catch (error) {
        warn(`Image "${src}" not embedded`, error);
        return undefined;
    }
}

// Elements whose content is text, never a tag, to their end tag: RAWTEXT
// (script, style, xmp, iframe, noembed, noframes, and noscript, since the
// page the PDF is printed from runs scripts and so does a browser opening
// the HTML export), RCDATA (textarea, title), and plaintext, which no end
// tag ends.
const RAW_TEXT = new Set([
    "script", "style", "xmp", "iframe", "noembed", "noframes", "noscript",
    "textarea", "title", "plaintext",
]);
// A comment as HTML ends it (`<!-->`, `<!--->`, `-->`, `--!>`; group 1 holds
// the rest of one the content does not end), or a tag: `/`, name, attributes.
const MARKUP = /<!--(?:-?>|[\s\S]*?--!?>|([\s\S]*))|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// One attribute: a name after white space or `/`, and its value as quoted,
// or unquoted to white space or `>`.
const ATTRIBUTE = /[\s/]*([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/y;

/**
 * Inline the local stylesheets a document links itself, as data URIs, the
 * `url()`s inside them included (qjebbs/vscode-markdown-extended#162).
 * The PDF is printed from `page.setContent`, where a relative href resolves
 * against about:blank. A `<base>` for the document folder would resolve it,
 * but it would also turn every `#fragment` link into a link to that folder,
 * and point a self-contained HTML export at the author's disk.
 * A `<link>` inside a comment or a raw-text element is text and stays so,
 * also where an earlier html token opened it (`scan`, updated here).
 */
function embedStylesheets(html: string, embedding: RenderEmbedding, md: MarkdownIt, scan: ScanState): string {
    let out = "";
    let i = 0;
    while (i < html.length) {
        if (scan.comment || scan.rawText === "plaintext") {
            const end = scan.comment ? find(/--!?>/g, html, i) : undefined;
            if (!end) {break;}
            scan.comment = false;
            out += html.slice(i, end.index + end[0].length);
            i = end.index + end[0].length;
            continue;
        }
        if (scan.rawText) {
            const end = find(new RegExp(`</${scan.rawText}[\\s/>]`, "ig"), html, i);
            if (!end) {break;}
            scan.rawText = undefined;
            out += html.slice(i, end.index);
            i = end.index;
        }
        MARKUP.lastIndex = i;
        const m = MARKUP.exec(html);
        if (!m) {break;}
        out += html.slice(i, m.index);
        let markup = m[0];
        const name = m[3]?.toLowerCase();
        if (m[1] !== undefined) {scan.comment = true;}
        else if (name && !m[2]) {
            if (RAW_TEXT.has(name)) {scan.rawText = name;}
            else if (name === "link") {markup = embedLink(markup, 1 + name.length, embedding, md);}
        }
        out += markup;
        i = m.index + m[0].length;
    }
    return out + html.slice(i);
}

function find(pattern: RegExp, text: string, from: number): RegExpExecArray | undefined {
    pattern.lastIndex = from;
    return pattern.exec(text) ?? undefined;
}

/** The `<link>` tag with its stylesheet's href made a data URI, or as written. */
function embedLink(tag: string, attributesAt: number, embedding: RenderEmbedding, md: MarkdownIt): string {
    const attributes = new Map<string, { value: string, start: number, end: number }>();
    ATTRIBUTE.lastIndex = attributesAt;
    for (let a = ATTRIBUTE.exec(tag); a && a[0]; a = ATTRIBUTE.exec(tag)) {
        const name = a[1].toLowerCase();
        // Of two attributes of one name, the first is the one that counts.
        if (attributes.has(name)) {continue;}
        const raw = a[2] ?? "";
        const quoted = raw.startsWith('"') || raw.startsWith("'");
        const value = (quoted ? raw.slice(1, -1) : raw)
            .replace(/&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, e => md.utils.unescapeAll(e));
        attributes.set(name, { value, start: ATTRIBUTE.lastIndex - raw.length, end: ATTRIBUTE.lastIndex });
    }
    const rel = attributes.get("rel")?.value.toLowerCase().split(/\s+/) ?? [];
    const href = attributes.get("href");
    if (!rel.includes("stylesheet") || !href?.value) {return tag;}
    const file = stylesheetFile(href.value, embedding);
    if (!file) {return tag;}
    try {
        // The linked path, not the real one: a stylesheet's url()s resolve
        // against the folder it was linked from, as in the preview.
        return tag.slice(0, href.start) + `"${cssFileToDataUri(file.path, embedding().scope)}"` + tag.slice(href.end);
    } catch (error) {
        warn(`Stylesheet "${href.value}" not embedded`, error);
        return tag;
    }
}

/**
 * The file a stylesheet's href names, when it may be embedded: a `.css` file,
 * judged by its real path, that `markdownExtended.export.embedFiles` lets the
 * document embed. Web addresses are left to the href as written.
 */
function stylesheetFile(href: string, embedding: RenderEmbedding): { path: string, real: string } | undefined {
    const isCss = (real: string) => path.extname(real).toLowerCase() === ".css";
    return addressedFile(`Stylesheet "${href}"`, href, () => decode(href.replace(/[?#].*$/, "")), isCss, embedding);
}

/**
 * The local file an image's src or a stylesheet's href names, by one rule
 * for both: a `file:` URL by its path, unless it names a host; a path as
 * `plain` reads it. A web address (`https:`, `//host`) or a data URI is the
 * browser's to load, and left as written.
 */
function addressedFile(
    what: string, address: string, plain: () => string, accepts: (real: string) => boolean, embedding: RenderEmbedding
): { path: string, real: string } | undefined {
    const scheme = schemeOf(address);
    if (scheme === "file") {
        return localFile(what, () => {
            const { folders, scope } = embedding();
            // Not Node's fileURLToPath: the web bundle has no `url` module.
            const uri = vscode.Uri.parse(address, true);
            if (uri.authority) {return { reason: "it is a network path" };}
            return resolveLocalFile(uri.fsPath, folders, accepts, scope);
        });
    }
    if (scheme || address.startsWith("//")) {return undefined;}
    return localFile(what, () => {
        const { folders, scope } = embedding();
        return resolveLocalFile(plain(), folders, accepts, scope);
    });
}

/**
 * The file `resolve` finds, or undefined, with why not written to the output
 * panel; under `none` the render says it once (`exportHelperWorker`).
 */
function localFile(what: string, resolve: () => LocalFile): { path: string, real: string } | undefined {
    try {
        const file = resolve();
        if ("real" in file) {return file;}
        if (file.bySetting !== "none") {warn(`${what} not embedded: ${file.reason}`);}
    } catch (error) {
        warn(`${what} not embedded`, error);
    }
    return undefined;
}

/**
 * Where the document's files are found, and what it may embed.
 *
 * A relative path is looked up in the document's folder, then its workspace
 * folder. `workspace` confines a file to the folders the Visual Editor shows
 * the document's images from (`documentRoots`): every workspace folder, and
 * the document's folder when it lies in none.
 *
 * The document's folder is its `file:` folder, or, for another scheme (`git:`),
 * the folder its path names when that is a folder on this machine's disk. An
 * untitled document has none: a relative path finds nothing.
 */
function embeddingOf(env: HtmlExporterEnv): Embedding {
    const own = documentFolder(env.uri);
    const folders: string[] = [];
    if ("folder" in own) {folders.push(own.folder);}
    if (env.workspaceFolder) {folders.push(env.workspaceFolder.fsPath);}
    const roots = documentRoots(env.uri).filter(root => root.scheme === "file").map(root => root.fsPath);
    if (env.uri.scheme !== "file" && "folder" in own) {roots.push(own.folder);}
    if (env.workspaceFolder) {roots.push(env.workspaceFolder.fsPath);}
    return { folders, scope: embedScope(env.embedFiles, roots, "reason" in own ? own.reason : undefined) };
}

/** The folder on this machine's disk the document lies in, or why it has none. */
function documentFolder(uri: vscode.Uri): { folder: string } | { reason: string } {
    if (uri.scheme === "file") {return { folder: path.dirname(uri.fsPath) };}
    if (uri.scheme === "untitled") {return { reason: "the document is untitled and has no folder" };}
    const folder = path.dirname(uri.fsPath);
    if (path.isAbsolute(folder) && !isNetworkPath(folder) && fs.existsSync(folder)) {return { folder };}
    return { reason: `the document (${uri.scheme}:) is not in a folder on this machine's disk` };
}

function info(message: string) {
    if (!ExtensionContext.isInitialized) {return;}
    ExtensionContext.current.outputPanel.appendLine(`[INFO] ${message}`);
}

function warn(message: string, error?: unknown) {
    if (!ExtensionContext.isInitialized) {return;}
    const reason = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
    ExtensionContext.current.outputPanel.appendLine(`[WARNING] ${message}${reason}`);
}
