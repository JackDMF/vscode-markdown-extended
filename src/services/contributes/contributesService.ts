import { ContributorService, ContributorType } from './contributorService';
import { createContributeItem } from './tools';
import { mdConfig } from './mdConfig';
import * as vscode from 'vscode';

/**
 * Service interface for managing markdown contributions (styles and scripts)
 */
export interface IContributesService {
    /** Style contribution methods */
    readonly styles: {
        /** Get all contributed styles (official + third-party) */
        all(): string;
        /** Get official VS Code contributed styles */
        official(): string;
        /** Get third-party contributed styles */
        thirdParty(): string;
        /** Get user-configured styles for a document */
        user(uri: vscode.Uri): string;
    };
    
    /** Script contribution methods */
    readonly scripts: {
        /** Get all contributed scripts (official + third-party) */
        all(): string;
        /** Get official VS Code contributed scripts */
        official(): string;
        /** Get third-party contributed scripts */
        thirdParty(): string;
    };
    
    /** Create a style contribution item */
    createStyle(content: string | Buffer, comment: string): string;
    
    /** Create a script contribution item */
    createScript(content: string | Buffer, comment: string): string;
}

/**
 * Service for managing markdown preview contributions from extensions.
 * Provides access to styles and scripts contributed by VS Code and extensions.
 * Implements singleton pattern for consistent contributes access.
 */
export class ContributesService implements IContributesService {
    private static _instance?: ContributesService;
    private readonly _contributorService: ContributorService;
    
    /**
     * Private constructor to enforce singleton pattern
     */
    private constructor() {
        this._contributorService = ContributorService.instance;
    }
    
    /**
     * Get the ContributesService singleton instance
     */
    static get instance(): ContributesService {
        if (!ContributesService._instance) {
            ContributesService._instance = new ContributesService();
        }
        return ContributesService._instance;
    }
    
    /**
     * Reset the singleton instance (for testing purposes only)
     * @internal
     */
    static _reset(): void {
        ContributesService._instance = undefined;
    }
    
    /**
     * Style contribution methods
     */
    readonly styles = {
        /**
         * Get all contribute styles, include official and thirdParty
         * Notice: all() does not include user setting styles
         */
        all: (): string => {
            return this._contributorService.getStyles()
                .join("\n").trim();
        },
        
        /**
         * Get official contributed styles
         */
        official: (): string => {
            return this._contributorService.getStyles(
                c => c.type === ContributorType.official
            ).join("\n").trim();
        },
        
        /**
         * Get third party contributed styles
         */
        thirdParty: (): string => {
            return this._contributorService.getStyles(
                c => c.type !== ContributorType.official
            ).join("\n").trim();
        },
        
        /**
         * Get user setting styles for target document
         * @param uri uri of target document
         */
        user: (uri: vscode.Uri): string => {
            const conf = mdConfig.styles(uri);
            return conf.embedded.concat(conf.linked)
                .join("\n").trim();
        }
    };
    
    /**
     * Script contribution methods
     */
    readonly scripts = {
        /**
         * Get all contribute scripts, include official and thirdParty
         */
        all: (): string => {
            return this._contributorService.getScripts()
                .join("\n").trim();
        },
        
        /**
         * Get official contributed scripts
         */
        official: (): string => {
            return this._contributorService.getScripts(
                c => c.type === ContributorType.official
            ).join("\n").trim();
        },
        
        /**
         * Get third party contributed scripts
         */
        thirdParty: (): string => {
            return this._contributorService.getScripts(
                c => c.type !== ContributorType.official
            ).join("\n").trim();
        }
    };
    
    /**
     * Create contribute style item by given content
     * @param content css styles content to create
     * @param comment comment to put beside the contribute item
     */
    createStyle(content: string | Buffer, comment: string): string {
        return createContributeItem(content, true, comment);
    }
    
    /**
     * Create contribute script item by given content
     * @param content javascript content to create
     * @param comment comment to put beside the contribute item
     */
    createScript(content: string | Buffer, comment: string): string {
        return createContributeItem(content, false, comment);
    }
}

/**
 * Namespace export for backward compatibility
 * @deprecated Use ContributesService.instance instead
 */
export const Contributes = {
    Styles: {
        all: () => ContributesService.instance.styles.all(),
        official: () => ContributesService.instance.styles.official(),
        thirdParty: () => ContributesService.instance.styles.thirdParty(),
        user: (uri: vscode.Uri) => ContributesService.instance.styles.user(uri),
    },
    Scripts: {
        all: () => ContributesService.instance.scripts.all(),
        official: () => ContributesService.instance.scripts.official(),
        thirdParty: () => ContributesService.instance.scripts.thirdParty(),
    },
    createStyle: (content: string | Buffer, comment: string) => 
        ContributesService.instance.createStyle(content, comment),
    createScript: (content: string | Buffer, comment: string) => 
        ContributesService.instance.createScript(content, comment),
};
