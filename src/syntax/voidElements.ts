/**
 * The HTML elements that have no content and no end tag, stated once.
 *
 * Two places tell an open tag from a whole one: the export's print-date
 * rewriting (`src/services/exporter/printDate.ts`) and the task-label rule
 * (`src/plugin/markdownItCheckbox.ts`). In HTML the slash of `<br/>` is
 * redundant and the slash of `<div/>` is ignored, so only this list decides
 * whether a tag opens an element.
 *
 * It imports nothing, as `markers.ts` does.
 */
export const VOID_ELEMENTS: ReadonlySet<string> = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
