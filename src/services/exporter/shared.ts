import * as vscode from 'vscode';
import * as path from 'path';
import { ExtensionContext } from '../common/extensionContext';
import { MarkdownDocument } from '../common/markdownDocument';
import { Contributes } from '../contributes/contributes';
import { MarkdownItEnv } from '../common/interfaces';
import { config } from '../common/config';
import { readContributeFile } from '../contributes/tools';

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function renderPage(
    document: MarkdownDocument | vscode.TextDocument,
    injectStyle?: string
): string {
    let doc: MarkdownDocument = undefined;
    if (document instanceof MarkdownDocument)
        {doc = document;}
    else if (document.getText)
        {doc = new MarkdownDocument(document);}

    const title = escapeHtml(doc.meta.raw.title || path.basename(doc.document.uri.fsPath));
    const styles = getStyles(doc.document.uri, injectStyle);
    const scripts = getScripts();
    const html = renderHTML(doc);
    // Set the preview body theme class so theme-aware stylesheets render in the
    // chosen mode (markdownExtended.exportTheme: light | dark | auto). Keep
    // `vscode-body` too, as we cannot tell whether a user style URL is a theme.
    const mdClass = `markdown-body vscode-body vscode-${config.exportTheme}`;
    
    // Use template literal directly instead of eval()
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${title}</title>
${styles}
</head>
<body class="${mdClass}">
<div class="content">
    ${html}
</div>
${scripts}
</body>
</html>`;
}

export function renderHTML(doc: MarkdownDocument): string {
    const env: MarkdownItEnv = {
        htmlExporter: {
            uri: doc.document.uri,
            workspaceFolder: getworkspaceFolder(doc.document.uri),
            vsUri: getVsUri(doc.document.uri),
            embedImage: true,
        },
    }
    const markdown = ExtensionContext.current.markdown;
    const content = markdown.render(doc.content, env);
    return content.trim();
}
function getworkspaceFolder(uri): vscode.Uri {
    const root = vscode.workspace.getWorkspaceFolder(uri);
    return (root && root.uri) ? root.uri : undefined;
}
function getVsUri(uri: vscode.Uri): string {
    const root = vscode.workspace.getWorkspaceFolder(uri);
    const p = (root && root.uri) ? '/' + root.uri.fsPath + '/' : "";
    // FIXME: vscode has a bug encoding shared path, which cannot be replaced
    // nor can vscode display images if workspace is in a shared folder.
    // FIXME: can special chr exists in uri that need escape when use regex?
    return "vscode-resource:" + encodeURI(p.replace(/[\\/]+/g, '/'));
}

function getStyles(uri: vscode.Uri, injectStyle?: string): string {
    const styles: string[] = [];

    // official + third-party are de-duplicated together (globally) so an asset
    // shipped by both kinds of extension is inlined once; user styles stay last.
    const contributed = Contributes.Styles.contributed();
    const official = contributed.official;
    const thirdParty = contributed.thirdParty;
    const user = Contributes.Styles.user(uri);

    if (injectStyle) {
        styles.push("");
        styles.push(Contributes.createStyle(injectStyle, "injected by exporter"));
    }
    if (official) {
        styles.push("");
        styles.push("<!-- official styles start -->");
        styles.push(official);
        styles.push("<!-- official styles end -->");
    }
    if (thirdParty) {
        styles.push("");
        styles.push("<!-- third party styles start -->");
        styles.push(thirdParty);
        styles.push("<!-- third party styles end -->");
    }
    // Built-in accessible base stylesheet (export only), layered AFTER contributed
    // styles and BEFORE user styles, so `markdown.styles` overrides it. Toggle via
    // `markdownExtended.export.defaultStyles`.
    if (config.exportDefaultStyles) {
        const cssPath = ExtensionContext.current.vsContext
            .asAbsolutePath('styles/markdown-extended-default.css');
        const defaultStyles = readContributeFile(cssPath, true);
        if (defaultStyles) {
            styles.push("");
            styles.push("<!-- markdown-extended default styles start -->");
            styles.push(defaultStyles);
            styles.push("<!-- markdown-extended default styles end -->");
        }
    }
    if (user) {
        styles.push("");
        styles.push("<!-- user styles start -->");
        styles.push(user);
        styles.push("<!-- user styles end -->");
    }
    styles.push("");
    return styles.join('\n');
}
function getScripts(): string {
    const scripts: string[] = [];

    // let official = Contributes.Scripts.official();
    const thirdParty = Contributes.Scripts.thirdParty();

    // if (official) {
    //     scripts.push("");
    //     scripts.push("<!-- official scripts start -->");
    //     scripts.push(official);
    //     scripts.push("<!-- official scripts end -->");
    // }
    if (thirdParty) {
        scripts.push("");
        scripts.push("<!-- third party scripts start -->");
        scripts.push(thirdParty);
        scripts.push("<!-- third party scripts end -->");
    }
    scripts.push("");
    return scripts.join('\n');
}

/**
 * Ensure markdown engine is initialized
 */
export async function ensureMarkdownEngine() {
    if (!ExtensionContext.current.isMarkdownInitialized) {
        await vscode.commands.executeCommand('markdown.api.render', 'init markdown engine');
    }
}

