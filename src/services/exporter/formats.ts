/**
 * The formats the export makes, as one table: the format quick pick
 * (`pickFormat`) and the Visual Editor's Export menu (`toolbar.ts`) both list
 * it, so a format, its name and how it is made read the same on both, and the
 * page and the host accept the same set (`ExportFormatName`; `interfaces.ts`
 * holds the `ExportFormat` enum to it at compile time).
 *
 * No `vscode` import: the page's bundle reads this module too.
 */
export const EXPORT_FORMATS = [
    { format: 'html', label: 'HTML', detail: 'self-contained' },
    { format: 'pdf', label: 'PDF', detail: 'via Chromium' },
    { format: 'png', label: 'PNG image', detail: 'via Chromium' },
    // The file's extension stays `.jpg`; the format is named as it is spelled elsewhere.
    { format: 'jpg', label: 'JPEG image', detail: 'via Chromium' },
] as const;

/** A format's name as the export spells it: the file's extension. */
export type ExportFormatName = typeof EXPORT_FORMATS[number]['format'];

/** Whether `name` is one of the formats, as a message from the page may name anything. */
export function isExportFormatName(name: unknown): name is ExportFormatName {
    return EXPORT_FORMATS.some(f => f.format === name);
}
