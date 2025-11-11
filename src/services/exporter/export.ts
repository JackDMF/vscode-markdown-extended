import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExportOption, ExportItem, ExportRport } from "./interfaces";
import { calculateExportPath, isSubPath } from "../common/tools";
import { StopWatch } from '../common/stopWatch';

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownExport(uri: vscode.Uri, option: ExportOption): Promise<ExportRport>;
// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownExport(uris: vscode.Uri[], option: ExportOption): Promise<ExportRport>;
// eslint-disable-next-line @typescript-eslint/naming-convention
export async function MarkdownExport(arg: vscode.Uri | vscode.Uri[], option: ExportOption): Promise<ExportRport> {
    const confs = (await getFileList(arg)).map(uri => <ExportItem>{
        uri: uri,
        format: option.format,
        fileName: calculateExportPath(uri, option.format)
    });
    const timer = new StopWatch();
    return option.exporter.Export(confs, option.progress)
        .then(() => {
            return <ExportRport>{
                duration: timer.stop(),
                files: confs.map(c => c.fileName)
            }
        });
}

async function getFileList(arg?: vscode.Uri | vscode.Uri[]): Promise<vscode.Uri[]> {
    const _files: vscode.Uri[] = [];

    if (arg && arg instanceof vscode.Uri && !isDirectoryUri(arg)) {return [arg];}

    if (!vscode.workspace.workspaceFolders) { return []; }

    if (!arg) {
        for (const folder of vscode.workspace.workspaceFolders) {
            _files.push(...await getFileList(folder.uri));
        }
    } else if (arg instanceof Array) {
        for (const u of arg.filter(p => p instanceof vscode.Uri)) {
            _files.push(...await getFileList(u));
        }
    } else if (arg instanceof vscode.Uri) {
        if (isDirectoryUri(arg)) {
            const folder = vscode.workspace.getWorkspaceFolder(arg);
            let relPath = path.relative(folder.uri.fsPath, arg.fsPath);
            if (relPath) {relPath += '/';}
            const files = await vscode.workspace.findFiles(`${relPath}**/*.md`, "");
            _files.push(...files.filter(file => isSubPath(file.fsPath, folder.uri.fsPath)));
        } else {
            _files.push(arg);
        }
    }
    return _files;
}

function isDirectoryUri(uri: vscode.Uri): boolean {
    return fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory();
}