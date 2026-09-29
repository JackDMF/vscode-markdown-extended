/**
 * The small reading of a link destination both halves need, in one place:
 * whether it has a scheme, its percent escapes decoded, a file name's stem.
 * Pure, no `vscode` and no Node modules, so the page loads it as the host does.
 */

/**
 * The scheme a destination starts with, lower-cased (`https`, `mailto`,
 * `data`, `file`); `undefined` for a path — a drive letter (`C:/notes/a.md`,
 * `C:\notes`) is a path, not a scheme.
 */
export function schemeOf(text: string): string | undefined {
    const value = text.trim();
    if (/^[A-Za-z]:[\\/]/.test(value)) {
        return undefined;
    }
    return /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)?.[1].toLowerCase();
}

/** Percent escapes decoded; the text as it is where they do not decode. */
export function decode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

/** The last segment of a path, `/` or `\` separated. */
export function baseName(p: string): string {
    return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
}

/** A file's name without its extension — the default alt text of an image; a leading dot is no extension. */
export function stemOf(p: string): string {
    const base = baseName(p);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
}
