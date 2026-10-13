import * as vscode from 'vscode';
import { ExporterQuickPickItem, MarkdownExporter, ExportFormat, FormatQuickPickItem, exportFormatOf } from './interfaces';
import { EXPORT_FORMATS } from './formats';
import { HtmlExporter } from './html';
import { PuppeteerExporter } from './puppeteer';

/** The formats of the table (`formats.ts`), named as the Visual Editor's Export menu names them. */
export function formatPickItems(): FormatQuickPickItem[] {
    return EXPORT_FORMATS.map(f => <FormatQuickPickItem>{ label: f.label, description: f.detail, format: exportFormatOf(f.format) });
}

export async function pickFormat(): Promise<ExportFormat | undefined> {
    const items = formatPickItems();
    const pick = await vscode.window.showQuickPick<FormatQuickPickItem>(
        items,
        <vscode.QuickPickOptions>{ placeHolder: `Select export format...` }
    );
    if (!pick) {return undefined;}
    return pick.format;
}

export async function pickExporter(format: ExportFormat): Promise<MarkdownExporter | undefined> {
    const availableExporters = getAvailableExporters(format);
    if (availableExporters.length === 1) {return availableExporters[0].exporter;}
    const pick = await vscode.window.showQuickPick<ExporterQuickPickItem>(
        availableExporters,
        <vscode.QuickPickOptions>{ placeHolder: `Select an exporter to export ${format}...` }
    );
    if (!pick) {return undefined;}
    return pick.exporter;
}

/**
 * Registry of available exporters. To add a new exporter, implement
 * `MarkdownExporter` and add an entry here — `pickExporter`/`getAvailableExporters`
 * need no further changes (Open–Closed).
 */
function exporterRegistry(): ExporterQuickPickItem[] {
    return [
        <ExporterQuickPickItem>{
            label: "HTML Exporter",
            description: "export to html.",
            exporter: HtmlExporter.instance,
        },
        <ExporterQuickPickItem>{
            label: "Puppeteer Exporter",
            description: "export to pdf/png/jpg.",
            exporter: PuppeteerExporter.instance,
        },
    ];
}

function getAvailableExporters(format: ExportFormat): ExporterQuickPickItem[] {
    return exporterRegistry().filter(item => item.exporter.FormatAvailable(format));
}
