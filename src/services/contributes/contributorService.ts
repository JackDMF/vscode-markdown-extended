import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readContributeFile } from './tools';

/**
 * Contributor information from VS Code extensions
 */
export interface IContributor {
    extension: vscode.Extension<any>;
    type: ContributorType;
    styles: string[];
    scripts: string[];
}

/**
 * Type of contributor (official VS Code or third-party)
 */
export enum ContributorType {
    Unknown,
    Official,
    ThirdParty,
}

/**
 * Service interface for managing extension contributors
 */
export interface IContributorService {
    /**
     * Get all style contributions from extensions
     * @param filter Optional filter function to select specific contributors
     */
    getStyles(filter?: (contributor: IContributor) => boolean): string[];
    
    /**
     * Get all script contributions from extensions
     * @param filter Optional filter function to select specific contributors
     */
    getScripts(filter?: (contributor: IContributor) => boolean): string[];

    /**
     * Get contributed style items grouped into official and third-party, after a
     * single global de-duplication across both groups.
     */
    getGroupedStyles(): { official: string[]; thirdParty: string[] };
}

/**
 * Service for managing extension contributions (styles and scripts).
 * Implements singleton pattern for consistent contributor access.
 */
export class ContributorService implements IContributorService {
    private static _instance?: ContributorService;
    private readonly _contributors: IContributor[];
    
    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {
        // Initialize contributors from all extensions
        this._contributors = vscode.extensions.all
            .map(e => this.getContributor(e))
            .filter(c => c && (c.styles.length + c.scripts.length > 0)) as IContributor[];
    }
    
    /**
     * Get the ContributorService singleton instance
     */
    static get instance(): ContributorService {
        if (!ContributorService._instance) {
            ContributorService._instance = new ContributorService();
        }
        return ContributorService._instance;
    }
    
    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        ContributorService._instance = undefined;
    }
    
    /**
     * Get all style contributions from extensions
     * @param filter Optional filter function to select specific contributors
     */
    getStyles(filter?: (contributor: IContributor) => boolean): string[] {
        return this.getFiles(this._contributors, filter, true)
            .map(file => readContributeFile(file, true));
    }
    
    /**
     * Get all script contributions from extensions
     * @param filter Optional filter function to select specific contributors
     */
    getScripts(filter?: (contributor: IContributor) => boolean): string[] {
        return this.getFiles(this._contributors, filter, false)
            .map(file => readContributeFile(file, false));
    }
    
    /**
     * Extract contributor information from an extension
     */
    private getContributor(ext: vscode.Extension<any>): IContributor | undefined {
        if (!ext || !ext.packageJSON || !ext.packageJSON.contributes) {
            return undefined;
        }
        return {
            extension: ext,
            type: this.getContributorType(ext),
            styles: this.getContributeFiles(ext, "markdown.previewStyles"),
            scripts: this.getContributeFiles(ext, "markdown.previewScripts"),
        };
    }
    
    /**
     * Get contributed files from an extension
     */
    private getContributeFiles(ext: vscode.Extension<any>, name: string): string[] {
        const results: string[] = [];
        const files = ext.packageJSON.contributes[name];
        
        if (files && files.length) {
            files.forEach((file: unknown) => {
                // Some extensions contribute files as objects (e.g. URI-like {path: "..."})
                let filePath: string;
                if (typeof file === 'string') {
                    filePath = file;
                } else if (file && typeof file === 'object' && typeof (file as any).path === 'string') {
                    filePath = (file as any).path;
                } else {
                    return; // skip invalid entries
                }
                if (!path.isAbsolute(filePath)) {
                    filePath = path.join(ext.extensionPath, filePath);
                }
                if (fs.existsSync(filePath)) {
                    results.push(filePath);
                }
            });
        }
        return results;
    }
    
    /**
     * Determine the type of contributor
     */
    private getContributorType(ext: vscode.Extension<any>): ContributorType {
        if (!ext || !ext.packageJSON || !ext.packageJSON.publisher) {
            return ContributorType.Unknown;
        }
        
        if (ext.packageJSON.publisher === "vscode") {
            return ContributorType.Official;
        } else {
            return ContributorType.ThirdParty;
        }
    }
    
    /**
     * Collect the raw (non-de-duplicated) contributed files for a filter, in
     * contributor order.
     */
    private collectFiles(
        contributors: IContributor[],
        filter: ((contributor: IContributor) => boolean) | undefined,
        isStyle: boolean
    ): string[] {
        const files: string[] = [];
        const filterFn = filter || (() => true);

        contributors
            .filter(c => filterFn(c))
            .forEach(c => files.push(...(isStyle ? c.styles : c.scripts)));

        return files;
    }

    /**
     * Get files from contributors based on filter and type, de-duplicated by
     * content.
     */
    private getFiles(
        contributors: IContributor[],
        filter: ((contributor: IContributor) => boolean) | undefined,
        isStyle: boolean
    ): string[] {
        // De-duplicate by *content*. Several extensions ship a byte-for-byte
        // identical asset (most notably `katex.min.css`), and inlining it twice can
        // add ~370 KB of duplicated font data URIs to every export. Distinct files
        // that merely share a base name are all kept, so no extension's styling is
        // silently dropped.
        return dedupeContributeFiles(this.collectFiles(contributors, filter, isStyle));
    }

    /**
     * Get contributed STYLE items rendered and grouped into official and
     * third-party, after a single *global* de-duplication across both groups.
     *
     * The per-group accessors (`getStyles(officialFilter)` / `getStyles(thirdPartyFilter)`)
     * de-duplicate within each group only, so an asset shipped by both an official
     * and a third-party extension (e.g. `katex.min.css`, contributed by both
     * `vscode.markdown-math` and `markdown-all-in-one`) is still inlined twice.
     * This method de-duplicates across both groups so it is inlined once. The
     * cascade order is official then third-party, and the surviving copy keeps its
     * place.
     */
    getGroupedStyles(): { official: string[]; thirdParty: string[] } {
        const officialFiles = this.collectFiles(
            this._contributors, c => c.type === ContributorType.Official, true);
        const thirdPartyFiles = this.collectFiles(
            this._contributors, c => c.type !== ContributorType.Official, true);
        const grouped = partitionDedupedStyleFiles(officialFiles, thirdPartyFiles);
        return {
            official: grouped.official.map(f => readContributeFile(f, true)),
            thirdParty: grouped.thirdParty.map(f => readContributeFile(f, true)),
        };
    }
}

/**
 * De-duplicate contributed file paths by *content*, in a way that preserves the
 * CSS cascade.
 *
 * Markdown preview contributions from different extensions frequently include a
 * byte-for-byte identical asset (e.g. `katex.min.css`). Inlining each copy as a
 * base64 data URI bloats the export, so identical copies are collapsed to one.
 *
 * Two rules keep this safe:
 *  - Files are compared by *content* (a hash of their bytes), never by file name.
 *    Distinct files that merely share a base name (e.g. two different
 *    `markdown.css`) are all kept, so no extension's styling is silently dropped.
 *  - The *last* occurrence is kept in its original position. Later styles win the
 *    CSS cascade, so dropping an earlier identical copy leaves the final
 *    appearance unchanged.
 *
 * Files that cannot be read are keyed by their absolute path, so each survives.
 *
 * @param files Absolute file paths to de-duplicate.
 * @param keyOf Maps a file to its de-dup key (defaults to a content hash). Exposed
 *              for testing.
 */
export function dedupeContributeFiles(
    files: string[],
    keyOf: (file: string) => string = contentKey,
): string[] {
    const keys = files.map(keyOf);
    const lastIndex = new Map<string, number>();
    keys.forEach((key, i) => lastIndex.set(key, i));
    return files.filter((_file, i) => lastIndex.get(keys[i]) === i);
}

/**
 * Compute a content-based de-dup key for a file. Unreadable or missing files are
 * keyed by their absolute path so they are treated as unique (never collapsed).
 *
 * Uses a pure-JS FNV-1a hash (no Node `crypto`) so the function also bundles for
 * the browser/web build, combined with the byte length to make collisions between
 * distinct files effectively impossible.
 */
function contentKey(file: string): string {
    try {
        const buf = fs.readFileSync(file);
        return 'h:' + buf.length.toString(16) + ':' + fnv1a(buf);
    } catch {
        return 'p:' + file;
    }
}

/**
 * 32-bit FNV-1a hash of a byte buffer, returned as a hex string.
 */
function fnv1a(buf: Buffer | Uint8Array): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < buf.length; i++) {
        hash ^= buf[i];
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}

/**
 * Partition contributed style files into official and third-party groups after a
 * single *global* content de-duplication across both groups.
 *
 * The two groups are concatenated in cascade order (official, then third-party)
 * and de-duplicated together with {@link dedupeContributeFiles} (content-based,
 * keep-last). Survivors are then sorted back into their original group, so an
 * asset shipped by both an official and a third-party extension is kept only once
 * — in the later (third-party) position, which preserves the CSS cascade.
 *
 * @param officialFiles Style files contributed by official (publisher `vscode`) extensions.
 * @param thirdPartyFiles Style files contributed by third-party extensions.
 * @param keyOf Maps a file to its de-dup key (defaults to a content hash). Exposed for testing.
 */
export function partitionDedupedStyleFiles(
    officialFiles: string[],
    thirdPartyFiles: string[],
    keyOf?: (file: string) => string,
): { official: string[]; thirdParty: string[] } {
    const deduped = dedupeContributeFiles([...officialFiles, ...thirdPartyFiles], keyOf);
    const officialSet = new Set(officialFiles);
    return {
        official: deduped.filter(f => officialSet.has(f)),
        thirdParty: deduped.filter(f => !officialSet.has(f)),
    };
}
