import * as vscode from 'vscode';
import { pickExporter, pickFormat } from "../services/exporter/exporters";
import { ensureMarkdownEngine } from '../services/exporter/shared';
import { ExportFormat, ExportOption } from "../services/exporter/interfaces";
import { MarkdownExport } from "../services/exporter/export";
import { showExportReport } from "../services/common/tools";

/**
 * Export the document at `uri`. Without `preset`, VS Code asks for the format
 * (`pickFormat`); with it — the Visual Editor's Export menu, where the format
 * was chosen already — it does not. Which exporter makes that format is asked
 * either way, and only when more than one can (`pickExporter`).
 */
export async function exportUri(uri: vscode.Uri, preset?: ExportFormat) {

    await ensureMarkdownEngine();
    const format = preset ?? await pickFormat();
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