/**
 * The formats the export makes, as one table: the format quick pick
 * (`pickFormat`) and the Visual Editor's Export menu (`toolbar.ts`) both list
 * it, so a format, its name and how it is made read the same on both, and the
 * page and the host accept the same set. Every member of the enum has its row
 * (`exportCurrent.test.ts` holds them together).
 *
 * No `vscode` import: the page's bundle reads this module too.
 */
export enum ExportFormat {
    PDF = "pdf",
    HTML = "html",
    JPG = "jpg",
    PNG = "png",
}

/** A format as the menu and the quick pick name it, and how it is made. */
export interface ExportFormatEntry {
    format: ExportFormat;
    label: string;
    detail: string;
}

export const EXPORT_FORMATS: readonly ExportFormatEntry[] = [
    { format: ExportFormat.HTML, label: 'HTML', detail: 'self-contained' },
    { format: ExportFormat.PDF, label: 'PDF', detail: 'via Chromium' },
    { format: ExportFormat.PNG, label: 'PNG image', detail: 'via Chromium' },
    // The file's extension stays `.jpg`; the format is named as it is spelled elsewhere.
    { format: ExportFormat.JPG, label: 'JPEG image', detail: 'via Chromium' },
];

/** A format's name as a message carries it: the enum's value, the file's extension. */
export type ExportFormatName = `${ExportFormat}`;

/** The format a message names; `undefined` for a name that is none — a message may name anything. */
export function formatNamed(name: unknown): ExportFormat | undefined {
    return EXPORT_FORMATS.find(f => f.format === name)?.format;
}
