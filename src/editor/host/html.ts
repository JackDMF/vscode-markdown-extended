import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ContributesService } from '../../services/contributes/contributesService';
import { BUILTIN_MARKDOWN_EXTENSION } from './engineHost';
import { lowerDrive } from './images';

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The font variables the built-in preview sets on `<body>`, from the same
 * settings, so `markdown.css` sizes the editor as it sizes the preview.
 */
function fontVariables(): string {
    const preview = vscode.workspace.getConfiguration('markdown.preview');
    const family = preview.get<string>('fontFamily', '');
    const size = Number(preview.get<number>('fontSize', 14));
    const lineHeight = Number(preview.get<number>('lineHeight', 1.6));
    return [
        family ? `--markdown-font-family: ${family};` : '',
        Number.isNaN(size) ? '' : `--markdown-font-size: ${size}px;`,
        Number.isNaN(lineHeight) ? '' : `--markdown-line-height: ${lineHeight};`,
    ].filter(Boolean).join(' ');
}

/**
 * The folders the webview may load from: this extension (the script, the
 * editor's stylesheet and the codicon font under `dist/codicons`), the built-in Markdown extension (the preview's
 * stylesheets), the workspace folders and the document's own folder — for the
 * images the document shows, whose `src` the page loads through
 * `asWebviewUri` (`host/images.ts`), a document outside any workspace included.
 */
export function localResourceRoots(extensionUri: vscode.Uri, documentUri?: vscode.Uri): vscode.Uri[] {
    const roots = [extensionUri];
    const builtin = vscode.extensions.getExtension(BUILTIN_MARKDOWN_EXTENSION);
    if (builtin) {
        roots.push(builtin.extensionUri);
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        roots.push(folder.uri);
    }
    if (documentUri) {
        const dir = vscode.Uri.joinPath(documentUri, '..');
        const dirPath = lowerDrive(dir.path);
        const inside = (root: vscode.Uri) => {
            const rootPath = lowerDrive(root.path);
            return root.scheme === dir.scheme && root.authority === dir.authority
                && (dirPath === rootPath || dirPath.startsWith(rootPath.endsWith('/') ? rootPath : `${rootPath}/`));
        };
        if (!roots.some(inside)) {
            roots.push(dir);
        }
    }
    return roots;
}

/**
 * The webview's page.
 *
 * Stylesheets come in the preview's cascade, so a block looks in the editor as
 * it looks in the preview: the built-in `markdown.css` and `highlight.css`,
 * then every extension's `markdown.previewStyles` (official, then third-party —
 * Req Explorer's `req-status.css` and this extension's own arrive here), then
 * the person's `markdown.styles`, and last the editor's own chrome, which
 * styles only what the preview does not have.
 *
 * `<body>` carries `markdown-body vscode-body` and nothing else: VS Code adds
 * `vscode-light`, `vscode-dark` or `vscode-high-contrast` to a webview's body
 * itself, and the theme-aware stylesheets key on exactly that.
 */
export function editorPage(webview: vscode.Webview, extensionUri: vscode.Uri, documentUri: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        // `https:` for a `markdown.styles` entry given by URL, which the
        // preview loads too, and for the fonts such a stylesheet pulls in.
        `style-src ${webview.cspSource} 'unsafe-inline' https: data:`,
        `font-src ${webview.cspSource} https: data:`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const link = (uri: vscode.Uri) => `<link rel="stylesheet" type="text/css" href="${escapeAttribute(webview.asWebviewUri(uri).toString())}">`;
    const builtin = vscode.extensions.getExtension(BUILTIN_MARKDOWN_EXTENSION);
    const previewStyles = builtin
        ? [link(vscode.Uri.joinPath(builtin.extensionUri, 'media', 'markdown.css')),
            link(vscode.Uri.joinPath(builtin.extensionUri, 'media', 'highlight.css'))].join('\n')
        : '';
    const contributed = ContributesService.instance.styles.contributed();
    const userStyles = ContributesService.instance.styles.user(documentUri);
    // The codicon font, copied beside the script by the build (esbuild.js): `$(icon)` in a lens or code-action title.
    const codicons = link(vscode.Uri.joinPath(extensionUri, 'dist', 'codicons', 'codicon.css'));
    const editorStyle = link(vscode.Uri.joinPath(extensionUri, 'styles', 'editor.css'));
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'editor-webview.js'));

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${previewStyles}
${contributed.official}
${contributed.thirdParty}
${userStyles}
${codicons}
${editorStyle}
</head>
<body class="markdown-body vscode-body" style="${escapeAttribute(fontVariables())}">
<div id="mep-editor" class="mep-editor"></div>
<script nonce="${nonce}" src="${escapeAttribute(script.toString())}"></script>
</body>
</html>`;
}
