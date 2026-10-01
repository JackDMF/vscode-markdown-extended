import * as vscode from 'vscode';
import { EmbedFiles } from './dataUri';

export interface MarkdownItEnv {
    htmlExporter?: HtmlExporterEnv;
    [key: string]: unknown;
}

export interface HtmlExporterEnv {
    uri: vscode.Uri;
    workspaceFolder: vscode.Uri;
    vsUri: string;
    embedImage: boolean;
    /** `markdownExtended.export.embedFiles` as it applies to the document. */
    embedFiles: EmbedFiles;
}