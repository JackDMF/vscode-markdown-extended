import * as path from 'path';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { ExtensionContext } from './extensionContext';
import { decode, schemeOf } from '../../editor/paths';

/**
 * cssFileToDataUri embeds files referred by url(), with data uri, while fileToDataUri not
 * @param cssFileName path of the css file
 */
export function cssFileToDataUri(cssFileName: string): string {
    const URL_REG = /url\(([^()'"]+?)\)|url\(['"](.+?)['"]\)/ig;
    if (!fs.existsSync(cssFileName))
        {return "";}
    let css = fs.readFileSync(cssFileName).toString();
    css = css.replace(URL_REG, (substr, ...args: any[]) => {
        try {
            const file = urlTarget(args[0] || args[1], cssFileName);
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
 * What it names but cannot be read is left to the `url()` as written.
 * @param ref the url() argument as written
 * @param cssFileName path of the css file
 */
function urlTarget(ref: string, cssFileName: string): string | undefined {
    if (schemeOf(ref) || ref.startsWith("#")) {
        return undefined;
    }
    const filePath = decode(ref.replace(/[?#].*$/, ""));
    if (!filePath) {
        return undefined;
    }
    const file = resolveLocalFile(filePath, [path.dirname(cssFileName)], hasDataUriSchema);
    return "real" in file ? file.real : undefined;
}

/** A local file found: the path it was named by and its real path. Or why none was. */
export type LocalFile = { path: string, real: string } | { reason: string };

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
 * path is refused before the disk is asked; an absolute path is taken as it
 * is, a relative one looked up in `folders` in order; the file's type is
 * judged by its real path (a symlink's target, the long name of an 8.3 one);
 * and, given `within`, that real path must lie inside one of those folders.
 * @param name the path as written, decoded
 * @param folders the folders a relative path is looked up in
 * @param accepts whether a real path is of a type that may be embedded
 * @param within the folders the real path must lie in, when it is restricted
 */
export function resolveLocalFile(
    name: string, folders: string[], accepts: (real: string) => boolean, within?: string[]
): LocalFile {
    if (isNetworkPath(name)) {
        return { reason: "it is a network path" };
    }
    const candidates = path.isAbsolute(name) ? [name] : folders.map(folder => path.join(folder, name));
    const file = candidates.find(candidate => fs.existsSync(candidate));
    if (!file) {
        return { reason: "not found" };
    }
    const real = fs.realpathSync.native(file);
    if (!accepts(real)) {
        return { reason: `"${path.basename(real)}" is not of a type that is embedded` };
    }
    if (within && !within.some(folder => isInside(real, folder))) {
        return { reason: "it is outside the document's folder and workspace" };
    }
    return { path: file, real };
}

/** Whether `real` lies inside the folder, the folder taken by its own real path. */
function isInside(real: string, folder: string): boolean {
    let root: string;
    try {
        root = fs.realpathSync.native(folder);
    } catch {
        return false;
    }
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

/**
 * Async version: cssFileToDataUri embeds files referred by url(), with data uri
 * @param cssFileName path of the css file
 */
export async function cssFileToDataUriAsync(cssFileName: string): Promise<string> {
    const URL_REG = /url\(([^()'"]+?)\)|url\(['"](.+?)['"]\)/ig;
    
    try {
        await fsPromises.access(cssFileName);
    } catch {
        return "";
    }
    
    const css = (await fsPromises.readFile(cssFileName)).toString();
    
    // Process URLs - need to handle async file reads
    const urlMatches: Array<{match: string, filePath: string}> = [];
    let match;
    while ((match = URL_REG.exec(css)) !== null) {
        let filePath: string | undefined;
        try {
            filePath = urlTarget(match[1] || match[2], cssFileName);
        } catch (error) {
            if (ExtensionContext.isInitialized) {
                const output = ExtensionContext.current.outputPanel;
                output.appendLine(`[WARNING] Failed to convert URL to data URI (async): ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (filePath) {
            urlMatches.push({ match: match[0], filePath });
        }
    }

    // Process all URLs concurrently
    let processedCss = css;
    for (const { match: matchStr, filePath: resolvedPath } of urlMatches) {
        try {
            const dataUri = await fileToDataUriAsync(resolvedPath);
            if (dataUri) {
                processedCss = processedCss.replace(matchStr, `url("${dataUri}")`);
            }
        } catch (error) {
            // Log errors but keep original URL to avoid breaking CSS
            if (ExtensionContext.isInitialized) {
                const output = ExtensionContext.current.outputPanel;
                output.appendLine(`[WARNING] Failed to convert URL to data URI (async): ${error instanceof Error ? error.message : String(error)}`);
            }
            // Keep original if conversion fails
        }
    }
    
    return `data:text/css;base64,${Buffer.from(processedCss).toString("base64")}`;
}

/**
 * Async version: fileToDataUri encodes a file as data uri
 * @param fileName path of the file
 */
export async function fileToDataUriAsync(fileName: string): Promise<string | null> {
    try {
        await fsPromises.access(fileName);
    } catch {
        return null;
    }
    
    const schema = getDataUriSchema(fileName);
    const buf = await fsPromises.readFile(fileName);
    return `${schema}${buf.toString("base64")}`;
}
