import * as vscode from 'vscode';
import { pickExporter, pickFormat } from "../services/exporter/exporters";
import { ensureMarkdownEngine } from '../services/exporter/shared';
import { ExportOption } from "../services/exporter/interfaces";
import { MarkdownExport } from "../services/exporter/export";
import { showExportReport } from "../services/common/tools";

export async function exportUri(uri: vscode.Uri) {

    await ensureMarkdownEngine();
    const format = await pickFormat();
    if (!format) {return;}
    const exporter = await pickExporter(format);
    if (!exporter) {return;}

    return vscode.window.withProgress(
        <vscode.ProgressOptions>{
            location: vscode.ProgressLocation.Notification,
            title: `Markdown Export`
        },
        progress => MarkdownExport(
            uri,
            <ExportOption>{
                exporter: exporter,
                progress: progress,
                format: format
            }
        )
    ).then(report => showExportReport(report));
}