import * as path from 'path';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { ExtensionContext } from './extensionContext';

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
        let filePath: string = args[0] || args[1];
        if (filePath.substr(0, 5).toLocaleLowerCase() === "data:") {
            return substr;
        }
        if (!path.isAbsolute(filePath))
            {filePath = path.resolve(path.dirname(cssFileName), filePath)}
        try {
            return `url("${fileToDataUri(filePath)}")`;
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
        const filePath = match[1] || match[2];
        if (filePath && filePath.substr(0, 5).toLocaleLowerCase() !== "data:") {
            urlMatches.push({ match: match[0], filePath });
        }
    }
    
    // Process all URLs concurrently
    let processedCss = css;
    for (const { match: matchStr, filePath: urlPath } of urlMatches) {
        let resolvedPath = urlPath;
        if (!path.isAbsolute(resolvedPath)) {
            resolvedPath = path.resolve(path.dirname(cssFileName), resolvedPath);
        }
        
        try {
            const dataUri = await fileToDataUriAsync(resolvedPath);
            processedCss = processedCss.replace(matchStr, `url("${dataUri}")`);
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
