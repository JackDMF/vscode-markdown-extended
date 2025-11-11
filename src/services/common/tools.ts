import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { ExportRport } from '../exporter/interfaces';
import { ExtensionContext } from './extensionContext';
import { Config } from './config';

export function calculateExportPath(uri: vscode.Uri, format: string): string {
    const outDirName = Config.instance.exportOutDirName;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const wkdir = folder ? folder.uri.fsPath : "";
    let exportDir: string;
    const uriPath = uri.fsPath;
    if (!path.isAbsolute(uriPath)) {
        throw new Error("please save file before export: " + uriPath);
    }
    if (wkdir && isSubPath(uriPath, wkdir)) {
        //if current document is in workspace, organize exports in 'out' directory.
        let relDir = path.dirname(uriPath);
        if (path.isAbsolute(relDir)) {
            // saved
            relDir = path.relative(wkdir, relDir)
        }
        exportDir = path.join(path.join(wkdir, outDirName), relDir);
    } else {
        //if not, export beside the document.
        exportDir = path.dirname(uriPath);
    }
    return path.join(exportDir, path.basename(uriPath, ".md") + `.${format.toLowerCase()}`);
}

export function isSubPath(from: string, to: string): boolean {
    const rel = path.relative(to, from);
    return !(path.isAbsolute(rel) || rel.substr(0, 2) === "..")
}

export function mkdirs(dirname, callback) {
    fs.exists(dirname, function (exists) {
        if (exists) {
            callback();
        } else {
            mkdirs(path.dirname(dirname), function () {
                fs.mkdir(dirname, callback);
            });
        }
    });
}

/**
 * Create directory recursively (async version using fs.promises)
 * @param dirname Path to create
 * @returns Promise that resolves when directory is created
 */
export async function mkdirsAsync(dirname: string): Promise<void> {
    try {
        await fsPromises.mkdir(dirname, { recursive: true });
    } catch (error) {
        // Ignore error if directory already exists
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
    }
}

/**
 * Create directory recursively (synchronous version)
 * @deprecated Use mkdirsAsync for better performance and non-blocking operation
 */
export function mkdirsSync(dirname) {
    if (fs.existsSync(dirname)) {
        return true;
    } else {
        if (mkdirsSync(path.dirname(dirname))) {
            fs.mkdirSync(dirname);
            return true;
        }
    }
}

export function parseError(error: any): string {
    if (typeof (error) === "string") {
        return error;
    } else if (error instanceof TypeError || error instanceof Error) {
        const err = error as TypeError;
        return err.message + '\n' + err.stack;
    } else if (error instanceof Array) {
        const arrs = error as any[];
        return arrs.reduce((p, err) => p + '\n\n' + err.message + '\n' + err.stack, "");
    } else {
        return error.toString();
    }
}

export function mergeSettings(...args: any[]) {
    return args.reduce((p, c) => {
        return Object.assign(p, c);
    }, {});
}

/**
 * Show export report with file list
 */
export async function showExportReport(report: ExportRport) {
    const msg = `${report.files.length} file(s) exported in ${report.duration / 1000} seconds`;
    const viewReport = "View Report";
    const btn = await vscode.window.showInformationMessage(msg, viewReport);
    if (btn !== viewReport) {return;}
    
    // Show detailed report in output panel
    const outputPanel = ExtensionContext.current.outputPanel;
    outputPanel.clear();
    outputPanel.appendLine(`=== Export Report ===`);
    outputPanel.appendLine(`Time: ${new Date().toLocaleTimeString()}`);
    outputPanel.appendLine(`Duration: ${report.duration / 1000} seconds`);
    outputPanel.appendLine(`Files exported: ${report.files.length}`);
    outputPanel.appendLine('');
    outputPanel.appendLine('Files:');
    report.files.forEach((file, index) => {
        outputPanel.appendLine(`  ${index + 1}. ${file}`);
    });
    outputPanel.appendLine('');
    outputPanel.appendLine(`=== End Report ===`);
    outputPanel.show();
}

