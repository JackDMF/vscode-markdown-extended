import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * The stylesheet VS Code puts into every webview before the page's own, copied
 * from VS Code 1.142.0 (commit 6d62b1d5), `out/vs/workbench/contrib/webview/
 * browser/pre/index.html`: the `defaultStyles` element, `id="_defaultStyles"`,
 * prepended to the document's `<head>` (`newDocument.head.prepend`), so it is
 * the head's first child. Its rules sit in `@layer vscode-default`, so any
 * unlayered rule of the page's beats them whatever its specificity.
 *
 * Without it the page harness drew what VS Code never shows: a link in the
 * browser's own `#0000ee`, where VS Code gives every `<a>` the theme's
 * `textLink-foreground`. The rules are the same and in the same order, only
 * re-indented; `webviewDefaults.e2e.test.ts` holds this copy to the one in the
 * VS Code the tests run in.
 */
export const WEBVIEW_DEFAULT_STYLES_ID = '_defaultStyles';

export const WEBVIEW_DEFAULT_STYLES = `
@layer vscode-default {
    html {
        scrollbar-color: var(--vscode-scrollbarSlider-background) var(--vscode-editor-background);
    }

    body {
        overscroll-behavior-x: none;
        background-color: transparent;
        color: var(--vscode-editor-foreground);
        font-family: var(--vscode-font-family);
        font-weight: var(--vscode-font-weight);
        font-size: var(--vscode-font-size);
        margin: 0;
        padding: 0 20px;
    }

    img, video {
        max-width: 100%;
        max-height: 100%;
    }

    a, a code {
        color: var(--vscode-textLink-foreground);
    }

    p > a {
        text-decoration: var(--text-link-decoration);
    }

    a:hover {
        color: var(--vscode-textLink-activeForeground);
    }

    a:focus,
    input:focus,
    select:focus,
    textarea:focus {
        outline: 1px solid -webkit-focus-ring-color;
        outline-offset: -1px;
    }

    code {
        font-family: var(--monaco-monospace-font);
        color: var(--vscode-textPreformat-foreground);
        background-color: var(--vscode-textPreformat-background);
        padding: 1px 3px;
        border-radius: 4px;
    }

    pre code {
        padding: 0;
    }

    blockquote {
        background: var(--vscode-textBlockQuote-background);
        border-color: var(--vscode-textBlockQuote-border);
    }

    kbd {
        background-color: var(--vscode-keybindingLabel-background);
        color: var(--vscode-keybindingLabel-foreground);
        border-style: solid;
        border-width: 1px;
        border-radius: 3px;
        border-color: var(--vscode-keybindingLabel-border);
        border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
        box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow);
        vertical-align: middle;
        padding: 1px 3px;
    }

    ::-webkit-scrollbar {
        width: 10px;
        height: 10px;
    }

    ::-webkit-scrollbar-corner {
        background-color: var(--vscode-editor-background);
    }

    ::-webkit-scrollbar-thumb {
        background-color: var(--vscode-scrollbarSlider-background);
    }
    ::-webkit-scrollbar-thumb:hover {
        background-color: var(--vscode-scrollbarSlider-hoverBackground);
    }
    ::-webkit-scrollbar-thumb:active {
        background-color: var(--vscode-scrollbarSlider-activeBackground);
    }
    ::highlight(find-highlight) {
        background-color: var(--vscode-editor-findMatchHighlightBackground);
    }
    ::highlight(current-find-highlight) {
        background-color: var(--vscode-editor-findMatchBackground);
    }
}`;

/**
 * The default styles of the VS Code the tests run in, read from its webview
 * page; `undefined` when that page or the element is not where 1.142 has them.
 */
export function installedWebviewDefaultStyles(): string | undefined {
    const file = path.join(vscode.env.appRoot, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', 'index.html');
    if (!fs.existsSync(file)) {
        return undefined;
    }
    const html = fs.readFileSync(file, 'utf8');
    const match = /defaultStyles\.textContent = `([^`]*)`/.exec(html);
    return match?.[1];
}
