import * as vscode from 'vscode';
import { ExporterQuickPickItem, MarkdownExporter, ExportFormat, FormatQuickPickItem } from './interfaces';
import { HtmlExporter } from './html';
import { PuppeteerExporter } from './puppeteer';

export async function pickFormat(): Promise<ExportFormat | undefined> {
    const items = [
        <FormatQuickPickItem>{
            label: "Self-contained HTML",
            // description: "Export to self-contained HTML.",
            format:ExportFormat.HTML,
        },
        <FormatQuickPickItem>{
            label: "PDF File",
            // description: "Export to PDF.",
            format:ExportFormat.PDF,
        },
        <FormatQuickPickItem>{
            label: "PNG Image",
            // description: "Export to PNG image.",
            format:ExportFormat.PNG,
        },
        <FormatQuickPickItem>{
            label: "JPG Image",
            // description: "Export to jpg image.",
            format:ExportFormat.JPG,
        }
    ];
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

function getAvailableExporters(format: ExportFormat): ExporterQuickPickItem[] {
    const items: ExporterQuickPickItem[] = [];

    if (HtmlExporter.instance.FormatAvailable(format)) {items.push(
        <ExporterQuickPickItem>{
            label: "HTML Exporter",
            description: "export to html.",
            exporter: HtmlExporter.instance,
        }
    );}
    if (PuppeteerExporter.instance.FormatAvailable(format)) {items.push(
        <ExporterQuickPickItem>{
            label: "Puppeteer Exporter",
            description: "export to pdf/png/jpg.",
            exporter: PuppeteerExporter.instance,
        }
    );}
    return items;
}
