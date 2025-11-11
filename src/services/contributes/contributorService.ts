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
            files.forEach((file: string) => {
                if (!path.isAbsolute(file)) {
                    file = path.join(ext.extensionPath, file);
                }
                if (fs.existsSync(file)) {
                    results.push(file);
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
     * Get files from contributors based on filter and type
     */
    private getFiles(
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
}

/**
 * Singleton instance for backward compatibility
 * @deprecated Use ContributorService.instance instead
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const Contributors = {
    Type: ContributorType,
    getStyles: (filter?: (contributor: IContributor) => boolean) => 
        ContributorService.instance.getStyles(filter),
    getScripts: (filter?: (contributor: IContributor) => boolean) => 
        ContributorService.instance.getScripts(filter),
};
