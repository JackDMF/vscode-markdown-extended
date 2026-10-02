/** `text` as a regular expression that matches it literally. It imports nothing, as `markers.ts` does. */
export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
