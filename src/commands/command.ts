import { commands, Disposable } from 'vscode';
import { ErrorHandler, ErrorSeverity } from '../services/common/errorHandler';

/**
 * Abstract base class for VS Code commands with automatic error handling.
 * Wraps command execution with try-catch and centralized error reporting.
 */
export abstract class Command extends Disposable {

    private _disposable: Disposable;

    constructor(protected command: string) {
        super(() => this.dispose());
        this._disposable = commands.registerCommand(command, this.executeCatch, this);
    }

    dispose() {
        this._disposable && this._disposable.dispose();
    }

    private executeCatch(...args: any[]): any {
        try {
            let pm = this.execute(...args);
            if (pm instanceof Promise) {
                pm.catch(error => {
                    ErrorHandler.handle(error, {
                        operation: `Command: ${this.command}`,
                        details: { commandId: this.command, args }
                    }, ErrorSeverity.Error);
                });
            }
        } catch (error) {
            ErrorHandler.handle(error, {
                operation: `Command: ${this.command}`,
                details: { commandId: this.command, args }
            }, ErrorSeverity.Error);
        }
    }

    /**
     * Execute the command logic. Override this method in subclasses.
     * @param args Command arguments
     */
    abstract execute(...args: any[]): any;

}

