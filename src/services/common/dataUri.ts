import * as path from 'path';
import * as fs from 'fs';
import { ExtensionContext } from './extensionContext';
import { decode, schemeOf } from '../../editor/paths';

/**
 * cssFileToDataUri embeds files referred by url(), with data uri, while fileToDataUri not
 * @param cssFileName path of the css file
 * @param scope what the document that links the stylesheet may embed;
 * `UNRESTRICTED` for a stylesheet the user configured or an extension contributed
 */
export function cssFileToDataUri(cssFileName: string, scope: EmbedScope): string {
    const URL_REG = /url\(([^()'"]+?)\)|url\(['"](.+?)['"]\)/ig;
    if (!fs.existsSync(cssFileName))
        {return "";}
    let css = fs.readFileSync(cssFileName).toString();
    css = css.replace(URL_REG, (substr, ...args: any[]) => {
        try {
            const file = urlTarget(args[0] || args[1], cssFileName, scope);
            const dataUri = file && fileToDataUri(file);
            return dataUri ? `url("${dataUri}")` : substr;
        } catch (error) {
            // Log errors but return original URL to avoid breaking CSS
            if (ExtensionContext.isInitialized) {
                const output = ExtensionContext.current.outputPanel;
                output.appendLine(`[WARNING] Failed to convert URL to data URI: ${error instanceof Error ? error.message : String(error)}`);
            }
            return substr;
        }
    });
    return `data:text/css;base64,${Buffer.from(css).toString("base64")}`;
}

/**
 * The real path of the local file a stylesheet's `url()` names, resolved
 * against the stylesheet's folder as it was linked (not a symlink's target:
 * the preview resolves it so), or undefined when it names none: a scheme
 * (`data:`, `https:`), a network path, a fragment of the page
 * (`url(#gradient)`), a file not found or of a type with no data URI. A
 * `?v=4.7.0` or `?#iefix` after a font's name is not part of its file.
 * What it names but cannot be read is left to the `url()` as written. A file
 * the setting refuses is said in the output panel; the rest is not, as a
 * stylesheet names many a file it does not need.
 * @param ref the url() argument as written
 * @param cssFileName path of the css file
 * @param scope what the document that links the stylesheet may embed
 */
function urlTarget(ref: string, cssFileName: string, scope: EmbedScope): string | undefined {
    if (schemeOf(ref) || ref.startsWith("#")) {
        return undefined;
    }
    const filePath = decode(ref.replace(/[?#].*$/, ""));
    if (!filePath) {
        return undefined;
    }
    const file = resolveLocalFile(filePath, [path.dirname(cssFileName)], hasDataUriSchema, scope);
    if ("real" in file) {
        return file.real;
    }
    if (file.bySetting && ExtensionContext.isInitialized) {
        ExtensionContext.current.outputPanel.appendLine(
            `[WARNING] url(${ref}) in "${cssFileName}" not embedded: ${file.reason}`);
    }
    return undefined;
}

/**
 * `markdownExtended.export.embedFiles`: which files a document names an
 * export may embed. `workspace`, those in the document's folder or a
 * workspace folder; `machine`, any of a type that is embedded; `none`, none.
 */
export type EmbedFiles = "workspace" | "machine" | "none";

/** The values `markdownExtended.export.embedFiles` may take, its default first. */
export const EMBED_FILES: readonly EmbedFiles[] = ["workspace", "machine", "none"];

/** What one document's export may embed. */
export interface EmbedScope {
    /** The setting as it applies to the document. */
    embedFiles: EmbedFiles;
    /** The real paths of the folders `workspace` confines a file to (`embedScope`). */
    roots: string[];
    /** Why `roots` is empty, when it is: said when `workspace` refuses for it. */
    noRoots?: string;
}

/**
 * The scope of a stylesheet the user configured (`markdown.styles`) or an
 * extension contributed: configuration, not a file a document names, so it
 * and the files its `url()`s name are embedded in every mode.
 */
export const UNRESTRICTED: EmbedScope = Object.freeze({ embedFiles: "machine", roots: [] as string[] });

/**
 * The scope of one document's export, made once per render: the folders are
 * taken by their real paths here, not again for every file.
 * @param embedFiles the setting as it applies to the document
 * @param folders the folders a file may lie in under `workspace`
 * @param noRoots why there are none, when there are none
 */
export function embedScope(embedFiles: EmbedFiles, folders: string[], noRoots?: string): EmbedScope {
    const roots: string[] = [];
    for (const folder of folders) {
        try {
            roots.push(fs.realpathSync.native(folder));
        } catch {
            // A folder that is not there holds no file.
        }
    }
    return { embedFiles, roots, noRoots };
}

/**
 * A local file found: the path it was named by and its real path. Or why
 * none was, and the value of `markdownExtended.export.embedFiles` that is
 * the reason, when it is.
 */
export type LocalFile = { path: string, real: string } | { reason: string, bySetting?: EmbedFiles };

/**
 * Whether a path names a network location (`\\host\share`, `//host/share`,
 * `/\host`). No file system call may touch one a document names: on Windows
 * it would offer the user's credentials to that host.
 */
export function isNetworkPath(name: string): boolean {
    return /^[\\/]{2}/.test(name);
}

/**
 * The one way a file named in a document or a stylesheet is found, for an
 * image, a linked stylesheet and a stylesheet's `url()` alike: a network
 * path is refused before the disk is asked, and so is a path a symlink or a
 * junction along which leads to one; an absolute path is taken as it is, a
 * relative one looked up in `folders` in order; the file's type is judged by
 * its real path (a symlink's target, the long name of an 8.3 one); and
 * `markdownExtended.export.embedFiles` decides: under `none` nothing is looked
 * up, under `workspace` the real path must lie inside one of the scope's
 * roots, under `machine` anywhere.
 * @param name the path as written, decoded
 * @param folders the folders a relative path is looked up in
 * @param accepts whether a real path is of a type that may be embedded
 * @param scope what the document may embed (`UNRESTRICTED` for configuration)
 */
export function resolveLocalFile(
    name: string, folders: string[], accepts: (real: string) => boolean, scope: EmbedScope
): LocalFile {
    if (isNetworkPath(name)) {
        return { reason: "it is a network path" };
    }
    if (scope.embedFiles === "none") {
        return { reason: `markdownExtended.export.embedFiles is "none"`, bySetting: "none" };
    }
    // Only `machine` lifts the containment: a scope without a known value is `workspace`.
    const within = scope.embedFiles !== "machine" ? scope.roots : undefined;
    if (within && !within.length) {
        return {
            reason: `${scope.noRoots ?? "the document has no folder"}, and markdownExtended.export.embedFiles is "workspace"`,
            bySetting: "workspace",
        };
    }
    const candidates = path.isAbsolute(name) ? [name] : folders.map(folder => path.join(folder, name));
    let file: string | undefined;
    for (const candidate of candidates) {
        const found = followLinks(candidate);
        if (found === "network") {
            return { reason: "a symlink or junction along it leads to a network path" };
        }
        if (found === "unreadable") {
            return { reason: "a symlink or junction along it cannot be read" };
        }
        if (found === "found" && fs.existsSync(candidate)) {
            file = candidate;
            break;
        }
    }
    if (!file) {
        return { reason: "not found" };
    }
    const real = fs.realpathSync.native(file);
    if (!accepts(real)) {
        return { reason: `"${path.basename(real)}" is not of a type that is embedded` };
    }
    if (within && !within.some(root => isInside(real, root))) {
        return {
            reason: `it is outside the document's folder and the workspace folders, and markdownExtended.export.embedFiles is "workspace" (set it to "machine" to embed it)`,
            bySetting: "workspace",
        };
    }
    return { path: file, real };
}

/**
 * Where a path leads, found by reading each symlink and junction along it
 * with `lstat` and `readlink`, which do not follow them: to a network path
 * (which `existsSync` or `realpath` would have opened), through a link whose
 * target cannot be read (Windows will not read a junction to a share back),
 * to nothing, or to a local file or folder.
 */
export function followLinks(name: string): "network" | "unreadable" | "missing" | "found" {
    let current = path.resolve(name);
    // As many links as the operating systems follow before they give up.
    for (let hops = 0; hops < 40; hops++) {
        const { root } = path.parse(current);
        const parts = current.slice(root.length).split(/[\\/]+/).filter(Boolean);
        let at = root;
        let next: string | undefined;
        for (let i = 0; i < parts.length && next === undefined; i++) {
            at = path.join(at, parts[i]);
            let isLink: boolean;
            try {
                isLink = fs.lstatSync(at).isSymbolicLink();
            } catch {
                return "missing";
            }
            if (!isLink) {continue;}
            let target: string;
            try {
                target = fs.readlinkSync(at);
            } catch {
                return "unreadable";
            }
            if (isNetworkTarget(target)) {
                return "network";
            }
            next = path.resolve(path.dirname(at), localTarget(target), ...parts.slice(i + 1));
        }
        if (next === undefined) {
            return "found";
        }
        current = next;
    }
    return "missing";
}

/** A link's target without the `\\?\`, `\\.\` or `\??\` before a drive letter. */
function localTarget(target: string): string {
    return target.replace(/^(?:[\\/]{2}[?.]|\\\?\?)[\\/](?=[A-Za-z]:)/, "");
}

/**
 * Whether a link's target is a network location: `\\host\share`, or the
 * same in its long form, `\\?\UNC\host\share` or `\??\UNC\host\share`. Any
 * other `\\?\` target than a drive's (a volume's GUID) counts as one too.
 */
export function isNetworkTarget(target: string): boolean {
    const local = localTarget(target);
    return isNetworkPath(local) || /^\\\?\?\\/.test(local);
}

/** Whether `real` lies inside `root`, both real paths. */
function isInside(real: string, root: string): boolean {
    const relative = path.relative(root, real);
    return !!relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** Whether a file's type has a data URI schema. */
export function hasDataUriSchema(fileName: string): boolean {
    try {
        getDataUriSchema(fileName);
        return true;
    } catch {
        return false;
    }
}

/**
 * fileToDataUri encodes a file as data uri
 * @param fileName path of the file
 */
export function fileToDataUri(fileName: string): string {
    if (!fs.existsSync(fileName))
        {return null;}
    const schema = getDataUriSchema(fileName);
    const buf = fs.readFileSync(fileName);
    return `${schema}${buf.toString("base64")}`
}

/**
 * getDataUriSchema returns a uri schema according to the extension of the file.
 * e.g.: "data:text/css;base64,"
 * @param fileName path of the file
 */
export function getDataUriSchema(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    let mimeType = null;
    switch (ext) {
        case ".js":
            mimeType = "text/javascript"
            break;
        case ".css":
            mimeType = "text/css"
            break;
        case ".woff":
            mimeType = "font/woff"
            break;
        case ".woff2":
            mimeType = "font/woff2"
            break;
        case ".otf":
            mimeType = "font/otf"
            break;
        case ".ttf":
            mimeType = "font/ttf"
            break;
        case ".sfnt":
            mimeType = "font/sfnt"
            break;
        case ".jpe":
        case ".jpeg":
        case ".jpg":
            mimeType = "image/jpeg"
            break;
        case ".png":
            mimeType = "image/png"
            break;
        case ".svg":
            mimeType = "image/svg+xml"
            break;
        case ".gif":
            mimeType = "image/gif"
            break;
        case ".icon":
        case ".ico":
            mimeType = "image/x-icon"
            break;
        case ".bmp":
            mimeType = "image/bmp"
            break;
        case ".webp":
            mimeType = "image/webp"
            break;
        case ".avif":
            mimeType = "image/avif"
            break;
        default:
            throw (`Unsupported mimeType for "${ext}" file.`);
    }
    return `data:${mimeType};base64,`
}
