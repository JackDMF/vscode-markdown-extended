import { MarkdownIt, Token } from '../@types/markdown-it';
import { MarkdownItEnv, HtmlExporterEnv } from '../services/common/interfaces';
import * as path from 'path';
import * as vscode from 'vscode';
import { cssFileToDataUri, fileToDataUri, hasDataUriSchema, LocalFile, resolveLocalFile } from '../services/common/dataUri';
import { ExtensionContext } from '../services/common/extensionContext';
import { decode, schemeOf } from '../editor/paths';

/**
 * Markdown-it plugin to prepare images for HTML export.
 *
 * This plugin:
 * - Removes VS Code file:// URIs from image paths
 * - Embeds images as base64 data URIs when embedImage is enabled
 * - Resolves relative image paths to absolute paths
 * - Embeds the local stylesheets a document links with `<link>` as data URIs
 *
 * @param md - The markdown-it instance
 * @example
 * ```typescript
 * // In export code:
 * const env: HtmlExporterEnv = {
 *   uri: documentUri,
 *   embedImage: true,
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

function exportHelperWorker(state: any, md: MarkdownIt) {
    const env = (state.env as MarkdownItEnv).htmlExporter;
    if (!env) {return;}
    enumTokens(state.tokens, env, md, {});
}
function enumTokens(tokens: Token[], env: HtmlExporterEnv, md: MarkdownIt, scan: ScanState) {
    tokens.map(t => {
        if (t.type === "image") {
            const written = t.attrGet("src");
            removeVsUri(t, env);
            if (env.embedImage) {embedImage(t, env, written);}
        }
        if (t.type === "html_block" || t.type === "html_inline") {
            t.content = embedStylesheets(t.content, env, md, scan);
        }
        if (t.children) {enumTokens(t.children, env, md, scan);}
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
    token.attrs[index][1] = decodeURIComponent(src.replace(env.vsUri, ""));
}
function embedImage(token: Token, env: HtmlExporterEnv, written: string) {
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
    token.attrs[index][1] = image2Base64(src, env) ?? written;
}
function image2Base64(src: string, env: HtmlExporterEnv): string | undefined {
    // A web address (`https:`, `//host`) or a data URI is the browser's to load.
    if (schemeOf(src) || src.startsWith("//")) {return undefined;}
    const file = localFile(`Image "${src}"`, () => resolveLocalFile(src, searchPaths(env), hasDataUriSchema));
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
function embedStylesheets(html: string, env: HtmlExporterEnv, md: MarkdownIt, scan: ScanState): string {
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
            else if (name === "link") {markup = embedLink(markup, 1 + name.length, env, md);}
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
function embedLink(tag: string, attributesAt: number, env: HtmlExporterEnv, md: MarkdownIt): string {
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
    const file = stylesheetFile(href.value, env);
    if (!file) {return tag;}
    try {
        // The linked path, not the real one: a stylesheet's url()s resolve
        // against the folder it was linked from, as in the preview.
        return tag.slice(0, href.start) + `"${cssFileToDataUri(file.path)}"` + tag.slice(href.end);
    } catch (error) {
        warn(`Stylesheet "${href.value}" not embedded`, error);
        return tag;
    }
}

/**
 * The file a stylesheet's href names, when it may be embedded: a `.css` file
 * whose real path lies in the document's folder or its workspace folder.
 * Web addresses are left to the href as written.
 */
function stylesheetFile(href: string, env: HtmlExporterEnv): { path: string, real: string } | undefined {
    const what = `Stylesheet "${href}"`;
    const roots = searchPaths(env);
    const isCss = (real: string) => path.extname(real).toLowerCase() === ".css";
    const scheme = schemeOf(href);
    if (scheme === "file") {
        return localFile(what, () => {
            // Not Node's fileURLToPath: the web bundle has no `url` module.
            const uri = vscode.Uri.parse(href, true);
            if (uri.authority) {return { reason: "it is a network path" };}
            return resolveLocalFile(uri.fsPath, roots, isCss, roots);
        });
    }
    if (scheme || href.startsWith("//")) {return undefined;}
    return localFile(what, () => resolveLocalFile(decode(href.replace(/[?#].*$/, "")), roots, isCss, roots));
}

/** The file `resolve` finds, or undefined, with why not written to the output panel. */
function localFile(what: string, resolve: () => LocalFile): { path: string, real: string } | undefined {
    try {
        const file = resolve();
        if ("real" in file) {return file;}
        warn(`${what} not embedded: ${file.reason}`);
    } catch (error) {
        warn(`${what} not embedded`, error);
    }
    return undefined;
}

/** The folders a relative path is looked up in: the document's, then its workspace's. */
function searchPaths(env: HtmlExporterEnv): string[] {
    const paths = [path.dirname(env.uri.fsPath)];
    if (env.workspaceFolder) {paths.push(env.workspaceFolder.fsPath);}
    return paths;
}

function warn(message: string, error?: unknown) {
    if (!ExtensionContext.isInitialized) {return;}
    const reason = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
    ExtensionContext.current.outputPanel.appendLine(`[WARNING] ${message}${reason}`);
}
