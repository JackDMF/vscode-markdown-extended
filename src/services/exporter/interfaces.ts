import * as vscode from 'vscode';
import type { ExportFormat } from './formats';

// Declared with the format table, which the page's bundle reads too; exported here for the callers that always read it here.
export { ExportFormat } from './formats';

export type Progress = vscode.Progress<{ message?: string; increment?: number }>;

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

export interface ExportReport {
    duration: number,
    files: string[],
}