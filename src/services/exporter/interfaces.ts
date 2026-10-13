import * as vscode from 'vscode';
import type { ExportFormatName } from './formats';

export type Progress = vscode.Progress<{ message?: string; increment?: number }>;

export enum ExportFormat {
    PDF = "pdf",
    HTML = "html",
    JPG = "jpg",
    PNG = "png",
}

/** True only while the enum and the format table (`formats.ts`) name the same formats: a format added to one alone does not compile. */
type SameFormats = [`${ExportFormat}`] extends [ExportFormatName] ? ([ExportFormatName] extends [`${ExportFormat}`] ? true : false) : false;
const FORMATS_AGREE: SameFormats = true;
void FORMATS_AGREE;

/** A format's name (from the page, or the table) as the enum's member. */
export function exportFormatOf(name: ExportFormatName): ExportFormat {
    return name as `${ExportFormat}` as ExportFormat;
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

export interface ExportReport {
    duration: number,
    files: string[],
}