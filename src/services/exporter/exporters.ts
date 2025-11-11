import * as vscode from 'vscode';
import { ExporterQuickPickItem, MarkdownExporter, exportFormat, FormatQuickPickItem } from './interfaces';
import { HtmlExporter } from './html';
import { PuppeteerExporter } from './puppeteer';

export async function pickFormat(): Promise<exportFormat> {
    let items = [
        <FormatQuickPickItem>{
            label: "Self-contained HTML",
            // description: "Export to self-contained HTML.",
            format:exportFormat.HTML,
        },
        <FormatQuickPickItem>{
            label: "PDF File",
            // description: "Export to PDF.",
            format:exportFormat.PDF,
        },
        <FormatQuickPickItem>{
            label: "PNG Image",
            // description: "Export to PNG image.",
            format:exportFormat.PNG,
        },
        <FormatQuickPickItem>{
            label: "JPG Image",
            // description: "Export to jpg image.",
            format:exportFormat.JPG,
        }
    ];
    let pick = await vscode.window.showQuickPick<FormatQuickPickItem>(
        items,
        <vscode.QuickPickOptions>{ placeHolder: `Select export format...` }
    );
    if (!pick) return undefined;
    return pick.format;
}

export async function pickExporter(format: exportFormat): Promise<MarkdownExporter> {
    let availableExporters = getAvailableExporters(format);
    if (availableExporters.length == 1) return availableExporters[0].exporter;
    let pick = await vscode.window.showQuickPick<ExporterQuickPickItem>(
        availableExporters,
        <vscode.QuickPickOptions>{ placeHolder: `Select an exporter to export ${format}...` }
    );
    if (!pick) return undefined;
    return pick.exporter;
}

function getAvailableExporters(format: exportFormat): ExporterQuickPickItem[] {
    let items: ExporterQuickPickItem[] = [];

    if (HtmlExporter.instance.FormatAvailable(format)) items.push(
        <ExporterQuickPickItem>{
            label: "HTML Exporter",
            description: "export to html.",
            exporter: HtmlExporter.instance,
        }
    );
    if (PuppeteerExporter.instance.FormatAvailable(format)) items.push(
        <ExporterQuickPickItem>{
            label: "Puppeteer Exporter",
            description: "export to pdf/png/jpg.",
            exporter: PuppeteerExporter.instance,
        }
    );
    return items;
}