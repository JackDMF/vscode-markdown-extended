import * as vscode from 'vscode';
import { lowerDrive } from './images';

/**
 * The folders a document's own files may come from: every workspace folder,
 * and the document's folder when it lies in none of them, a document outside
 * any workspace included. The Visual Editor's webview loads the images the
 * document shows from these (`localResourceRoots`), and an export under
 * `markdownExtended.export.embedFiles: workspace` embeds from these, so what
 * the one shows the other embeds.
 *
 * The document's folder keeps the document's scheme; a caller that reads the
 * disk takes only the `file:` ones.
 */
export function documentRoots(documentUri?: vscode.Uri): vscode.Uri[] {
    const roots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri);
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
