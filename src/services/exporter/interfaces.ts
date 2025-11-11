import * as vscode from 'vscode';

export type Progress = vscode.Progress<{ message?: string; increment?: number }>;

export enum ExportFormat {
    PDF = "pdf",
    HTML = "html",
    JPG = "jpg",
    PNG = "png",
}

export enum ExporterType {
    HTML,
    Phantom,
    Puppeteer,
}

export interface FormatQuickPickItem extends vscode.QuickPickItem {
    format: ExportFormat;
}

export interface ExporterQuickPickItem extends vscode.QuickPickItem {
    exporter: MarkdownExporter;
}

export interface ExportItem {
    uri: vscode.Uri,
    format: ExportFormat,
    fileName: string,
}
export interface MarkdownExporter {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Export: (confs: ExportItem[], progress: Progress) => Promise<any>;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    FormatAvailable: (format: ExportFormat) => boolean;
}
export interface ExportOption {
    exporter: MarkdownExporter,
    progress: Progress,
    format: ExportFormat
}

export interface ExportRport {
    duration: number,
    files: string[],
}