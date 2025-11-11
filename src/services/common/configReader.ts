import * as vscode from 'vscode';

type ConfigMap = {
    [key: string]: vscode.WorkspaceConfiguration;
}

/**
 * Configuration transformer function type.
 * Transforms a configuration value based on workspace context.
 * 
 * @template T The type of the configuration value
 * @param workspaceFolder The workspace folder URI
 * @param value The configuration value to transform
 * @returns The transformed configuration value
 */
export type ConfigTransformer<T> = (workspaceFolder: vscode.Uri, value: T) => T;

/**
 * Abstract base class for reading VS Code configuration.
 * Provides type-safe configuration reading with workspace folder support.
 */
export abstract class ConfigReader extends vscode.Disposable {

    private _section: string;
    private _disposable: vscode.Disposable;
    private _conf: vscode.WorkspaceConfiguration;
    private _folderConfs: ConfigMap = {};

    constructor(section: string) {
        super(() => this.dispose());
        this._section = section;
        this.getConfObjects(section);
        this._disposable = vscode.workspace.onDidChangeConfiguration(
            e => {
                this.onChange(e);
                this.getConfObjects(section);
            }
        );
    }
    dispose() {
        // Clean up event listener
        this._disposable && this._disposable.dispose();
        
        // Clear folder configuration cache to prevent memory leaks
        this._folderConfs = {};
    }
    /**
     * read the value of a window scope setting.
     * @param key the key name of a setting
     */
    read<T>(key: string): T;

    /**
     * read the value of a source scope setting.
     * @param key the key name of a setting
     * @param uri target uri to get setting for
     */
    read<T>(key: string, uri: vscode.Uri): T;

    /**
     * read and convert the value of a source scope setting.
     * @param key the key name of a setting
     * @param uri target uri to get setting for
     * @param transformer the function to convert the setting value. eg.: convert a relative path to absolute.
     */
    read<T>(key: string, uri: vscode.Uri, transformer: ConfigTransformer<T>): T;
    read<T>(key: string, uri?: vscode.Uri, transformer?: ConfigTransformer<T>): T {
        // Validate parameters: transformer requires uri
        if (transformer && !uri) {
            throw new Error('ConfigReader.read: transformer requires uri parameter');
        }
        
        if (!uri) {return this._conf.get<T>(key);} // no uri? return global value.
        
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        if (!folder || !folder.uri) {return this._conf.get<T>(key);} // new file or not current workspace file? return global value.
        
        let folderConf = this._folderConfs[folder.uri.fsPath];
        if (!folderConf) {
            folderConf = vscode.workspace.getConfiguration(this._section, folder.uri);
            this._folderConfs[folder.uri.fsPath] = folderConf;
        }
        const results = folderConf.inspect<T>(key);

        let value: T | undefined = undefined;
        if (results.workspaceFolderValue !== undefined)
            {value = results.workspaceFolderValue;}
        else if (results.workspaceValue !== undefined)
            {value = results.workspaceValue;}
        else if (results.globalValue !== undefined)
            {value = results.globalValue;}
        else
            {value = results.defaultValue;}
            
        if (transformer && folder && folder.uri && value !== undefined) {
            return transformer(folder.uri, value);
        }
        
        return value as T;
    }

    /**
     * Called when configuration changes.
     * Override this method to handle configuration change events.
     */
    abstract onChange(e?: vscode.ConfigurationChangeEvent): void;

    private getConfObjects(configName: string) {
        this._conf = vscode.workspace.getConfiguration(configName);
        this._folderConfs = {};
        if (!vscode.workspace.workspaceFolders) {return;}
        vscode.workspace.workspaceFolders.map(
            f => this._folderConfs[f.uri.fsPath] = vscode.workspace.getConfiguration(configName, f.uri)
        );
    }
}