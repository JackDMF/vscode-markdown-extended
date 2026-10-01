import { MarkdownIt, Token } from '../@types/markdown-it';
import { MarkdownItEnv, HtmlExporterEnv } from '../services/common/interfaces';
import * as path from 'path';
import * as fs from 'fs';
import { cssFileToDataUri, fileToDataUri } from '../services/common/dataUri';

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
    md.core.ruler.push("exportHelper", exportHelperWorker);
}

function exportHelperWorker(state: any) {
    const env = (state.env as MarkdownItEnv).htmlExporter;
    if (!env) {return;}
    enumTokens(state.tokens, env);
}
function enumTokens(tokens: Token[], env: HtmlExporterEnv) {
    tokens.map(t => {
        if (t.type === "image") {
            removeVsUri(t, env);
            if (env.embedImage) {embedImage(t, env);}
        }
        if (t.type === "html_block" || t.type === "html_inline") {
            t.content = embedStylesheets(t.content, env);
        }
        if (t.children) {enumTokens(t.children, env);}
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
function embedImage(token: Token, env: HtmlExporterEnv) {
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
    token.attrs[index][1] = image2Base64(src, env);
}
function image2Base64(src: string, env: HtmlExporterEnv): string {
    const paths = [path.dirname(env.uri.fsPath)];
    if (env.workspaceFolder) {paths.push(env.workspaceFolder.fsPath);}
    const file = searchFile(src, paths);
    if (!file) {return src;}
    // A missing file (searchFile returns an absolute path unchecked) or a type
    // with no data URI schema keeps the original src: a null src breaks
    // html5-embed downstream (qjebbs/vscode-markdown-extended#157).
    try {
        return fileToDataUri(file) ?? src;
    } catch {
        return src;
    }
}

/**
 * Inline the local stylesheets a document links itself, as data URIs, the
 * `url()`s inside them included (qjebbs/vscode-markdown-extended#162).
 * The PDF is printed from `page.setContent`, where a relative href resolves
 * against about:blank. A `<base>` for the document folder would resolve it,
 * but it would also turn every `#fragment` link into a link to that folder,
 * and point a self-contained HTML export at the author's disk.
 * Web addresses, and files that cannot be found, are left as written.
 */
function embedStylesheets(html: string, env: HtmlExporterEnv): string {
    return html.replace(/<link\b[^>]*>/gi, tag => {
        if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) {return tag;}
        const href = /(\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
        if (!href) {return tag;}
        const value = href[2] ?? href[3] ?? href[4];
        // a scheme (http:, data:, …) of two letters or more, not a drive letter
        if (!value || /^([a-z][a-z0-9+.-]+:|\/\/)/i.test(value)) {return tag;}
        const paths = [path.dirname(env.uri.fsPath)];
        if (env.workspaceFolder) {paths.push(env.workspaceFolder.fsPath);}
        try {
            const file = searchFile(decodeURI(value.replace(/[?#].*$/, "")), paths);
            if (!file || !fs.existsSync(file)) {return tag;}
            const dataUri = cssFileToDataUri(file);
            return tag.slice(0, href.index) + `${href[1]}"${dataUri}"` + tag.slice(href.index + href[0].length);
        } catch {
            return tag;
        }
    });
}

function searchFile(name: string, paths: string[]): string {
    if (path.isAbsolute(name)) {return name;}
    for (const p of paths) {
        const file = path.join(p, name);
        if (fs.existsSync(file))
            {return file;}
    }
    return undefined;
}
