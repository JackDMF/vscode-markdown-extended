import { MarkdownIt, Token } from '../@types/markdown-it';
import { MarkdownItEnv, HtmlExporterEnv } from '../services/common/interfaces';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { cssFileToDataUri, fileToDataUri } from '../services/common/dataUri';
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

function exportHelperWorker(state: any, md: MarkdownIt) {
    const env = (state.env as MarkdownItEnv).htmlExporter;
    if (!env) {return;}
    enumTokens(state.tokens, env, md);
}
function enumTokens(tokens: Token[], env: HtmlExporterEnv, md: MarkdownIt) {
    // A raw-text element (`<script>`, `<textarea>`, …) one inline html token
    // opens and a later one closes: nothing between them is markup.
    let rawText: string | undefined;
    tokens.map(t => {
        if (t.type === "image") {
            const written = t.attrGet("src");
            removeVsUri(t, env);
            if (env.embedImage) {embedImage(t, env, written);}
        }
        if (t.type === "html_block" || t.type === "html_inline") {
            const embedded = embedStylesheets(t.content, env, md, rawText);
            t.content = embedded.html;
            rawText = embedded.rawText;
        }
        if (t.children) {enumTokens(t.children, env, md);}
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
    const file = searchFile(src, searchPaths(env));
    if (!file) {return undefined;}
    try {
        return fileToDataUri(file) ?? undefined;
    } catch (error) {
        warn(`Image "${src}" not embedded`, error);
        return undefined;
    }
}

// Raw-text elements: what they hold is text, never a tag.
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
// A comment (to its end, or the content's), or a tag: `/`, name, attributes.
const MARKUP = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
// One attribute: a name after white space or `/`, and its value as quoted or unquoted.
const ATTRIBUTE = /[\s/]*([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/y;

/**
 * Inline the local stylesheets a document links itself, as data URIs, the
 * `url()`s inside them included (qjebbs/vscode-markdown-extended#162).
 * The PDF is printed from `page.setContent`, where a relative href resolves
 * against about:blank. A `<base>` for the document folder would resolve it,
 * but it would also turn every `#fragment` link into a link to that folder,
 * and point a self-contained HTML export at the author's disk.
 * A `<link>` inside a comment or a raw-text element is text and stays so;
 * `rawText` is the element still open from the token before, and the one
 * still open after this one is returned.
 */
function embedStylesheets(
    html: string, env: HtmlExporterEnv, md: MarkdownIt, rawText: string | undefined
): { html: string, rawText: string | undefined } {
    let out = "";
    let i = 0;
    while (i < html.length) {
        if (rawText) {
            const close = new RegExp(`</${rawText}[\\s/>]`, "ig");
            close.lastIndex = i;
            const end = close.exec(html);
            if (!end) {break;}
            out += html.slice(i, end.index);
            i = end.index;
            rawText = undefined;
        }
        MARKUP.lastIndex = i;
        const m = MARKUP.exec(html);
        if (!m) {break;}
        out += html.slice(i, m.index);
        let markup = m[0];
        const name = m[2]?.toLowerCase();
        if (name && !m[1]) {
            if (RAW_TEXT.has(name)) {rawText = name;}
            else if (name === "link") {markup = embedLink(markup, 1 + name.length, env, md);}
        }
        out += markup;
        i = m.index + m[0].length;
    }
    return { html: out + html.slice(i), rawText };
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
        return tag.slice(0, href.start) + `"${cssFileToDataUri(file)}"` + tag.slice(href.end);
    } catch (error) {
        warn(`Stylesheet "${href.value}" not embedded`, error);
        return tag;
    }
}

/**
 * The file a stylesheet's href names, when it may be embedded: a `.css` file
 * whose real path lies in the document's folder or its workspace folder, so a
 * document cannot pull any other file of the author's disk into the export.
 * Web addresses, and files not found, are left to the href as written.
 */
function stylesheetFile(href: string, env: HtmlExporterEnv): string | undefined {
    let name: string;
    const scheme = schemeOf(href);
    try {
        // Not Node's fileURLToPath: the web bundle has no `url` module.
        if (scheme === "file") {name = vscode.Uri.parse(href, true).fsPath;}
        else if (scheme || href.startsWith("//")) {return undefined;}
        else {name = decode(href.replace(/[?#].*$/, ""));}
    } catch (error) {
        warn(`Stylesheet "${href}" not embedded`, error);
        return undefined;
    }
    if (path.extname(name).toLowerCase() !== ".css") {return undefined;}
    const roots = searchPaths(env);
    const file = searchFile(name, roots);
    if (!file) {return undefined;}
    try {
        const real = fs.realpathSync.native(file);
        const inside = roots.some(root => {
            const relative = path.relative(fs.realpathSync.native(root), real);
            return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
        });
        if (inside) {return real;}
        warn(`Stylesheet "${href}" not embedded: it is outside the document's folder and workspace`);
    } catch (error) {
        warn(`Stylesheet "${href}" not embedded`, error);
    }
    return undefined;
}

/** The folders a relative path is looked up in: the document's, then its workspace's. */
function searchPaths(env: HtmlExporterEnv): string[] {
    const paths = [path.dirname(env.uri.fsPath)];
    if (env.workspaceFolder) {paths.push(env.workspaceFolder.fsPath);}
    return paths;
}

/** The first existing file `name` names, as an absolute path or in one of `paths`. */
function searchFile(name: string, paths: string[]): string | undefined {
    if (path.isAbsolute(name)) {return fs.existsSync(name) ? name : undefined;}
    for (const p of paths) {
        const file = path.join(p, name);
        if (fs.existsSync(file))
            {return file;}
    }
    return undefined;
}

function warn(message: string, error?: unknown) {
    if (!ExtensionContext.isInitialized) {return;}
    const reason = error === undefined ? "" : `: ${error instanceof Error ? error.message : String(error)}`;
    ExtensionContext.current.outputPanel.appendLine(`[WARNING] ${message}${reason}`);
}
