import { commands, Disposable } from 'vscode';
import { ErrorHandler, ErrorSeverity } from '../services/common/errorHandler';

/**
 * Command worker function type.
 * Represents a function that executes command logic.
 * 
 * @template TArgs The type of arguments passed to the command
 * @template TReturn The return type of the command
 */
export type CommandWorker<TArgs extends any[] = any[], TReturn = any> = 
    (...args: TArgs) => TReturn | Promise<TReturn>;

/**
 * Command configuration interface.
 * Defines the structure for registering commands.
 */
export interface CommandConfig<TArgs extends any[] = any[]> {
    /** VS Code command ID */
    commandId: string;
    /** Function to execute when command is invoked */
    worker: CommandWorker<TArgs>;
    /** Arguments to pass to the worker function */
    args: TArgs;
}

/**
 * Manages multiple command registrations with error handling.
 * Automatically wraps commands with try-catch and error reporting.
 */
export class Commands extends Disposable {

    private _disposables: Disposable[] = [];

    constructor(protected cmds: CommandConfig[]) {
        super(() => this.dispose());
        this._disposables.push(
            ...cmds.map(
                cmd => commands.registerCommand(
                    cmd.commandId, this.makeExecutor(cmd.commandId, cmd.worker, ...cmd.args)
                )
            )
        );
    }

    dispose() {
        this._disposables && this._disposables.length && this._disposables.map(d => d.dispose());
    }

    /**
     * Creates a wrapped executor that handles errors automatically
     */
    private makeExecutor<TArgs extends any[]>(
        commandId: string,
        func: CommandWorker<TArgs>,
        ...args: TArgs
    ): () => void {
        return () => {
            try {
                const pm = func(...args);
                if (pm instanceof Promise) {
                    pm.catch(error => {
                        ErrorHandler.handle(error, {
                            operation: `Command: ${commandId}`,
                            details: { commandId, args }
                        }, ErrorSeverity.Error);
                    });
                }
            } catch (error) {
                ErrorHandler.handle(error, {
                    operation: `Command: ${commandId}`,
                    details: { commandId, args }
                }, ErrorSeverity.Error);
            }
        }
    }
}

