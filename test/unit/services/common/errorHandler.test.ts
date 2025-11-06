import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ErrorHandler, ErrorSeverity, ErrorContext } from '../../../../src/services/common/errorHandler';
import { ExtensionContext } from '../../../../src/services/common/extensionContext';

suite('ErrorHandler Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockContext: vscode.ExtensionContext;
    let showErrorMessageStub: sinon.SinonStub;
    let showWarningMessageStub: sinon.SinonStub;
    let showInformationMessageStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        
        // Reset ExtensionContext
        ExtensionContext._reset();
        
        // Create mock context
        mockContext = {
            subscriptions: [],
            globalStorageUri: vscode.Uri.file('/test/global'),
            globalStoragePath: '/test/global',
            extensionPath: '/test',
            extensionUri: vscode.Uri.file('/test'),
            logUri: vscode.Uri.file('/test/log'),
            storageUri: vscode.Uri.file('/test/storage'),
            storagePath: '/test/storage',
            logPath: '/test/log',
            extensionMode: vscode.ExtensionMode.Test
        } as unknown as vscode.ExtensionContext;
        
        ExtensionContext.initialize(mockContext);
        
        // Stub VS Code message functions
        showErrorMessageStub = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
        showWarningMessageStub = sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined);
        showInformationMessageStub = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    });

    teardown(() => {
        sandbox.restore();
        ExtensionContext._reset();
    });

    test('should handle error with correct message', async () => {
        const error = new Error('Test error');
        const context: ErrorContext = {
            operation: 'Test Operation'
        };
        
        await ErrorHandler.handle(error, context, ErrorSeverity.Error);
        
        assert.ok(showErrorMessageStub.calledOnce, 'Should show error message');
        const callArg = showErrorMessageStub.firstCall.args[0];
        assert.ok(callArg.includes('Test Operation'), 'Message should include operation');
        assert.ok(callArg.includes('Test error'), 'Message should include error message');
    });

    test('should handle critical error with correct prefix', async () => {
        const error = new Error('Critical issue');
        const context: ErrorContext = {
            operation: 'Critical Operation'
        };
        
        await ErrorHandler.handle(error, context, ErrorSeverity.Critical);
        
        assert.ok(showErrorMessageStub.calledOnce, 'Should show error message');
        const callArg = showErrorMessageStub.firstCall.args[0];
        assert.ok(callArg.includes('❌ Critical'), 'Should have critical prefix');
    });

    test('should handle warning correctly', async () => {
        const context: ErrorContext = {
            operation: 'Warning Operation'
        };
        
        await ErrorHandler.handle('Warning message', context, ErrorSeverity.Warning);
        
        assert.ok(showWarningMessageStub.calledOnce, 'Should show warning message');
    });

    test('should handle info correctly', async () => {
        const context: ErrorContext = {
            operation: 'Info Operation'
        };
        
        await ErrorHandler.handle('Info message', context, ErrorSeverity.Info);
        
        assert.ok(showInformationMessageStub.calledOnce, 'Should show info message');
    });

    test('should include file path in message when provided', async () => {
        const error = new Error('File error');
        const context: ErrorContext = {
            operation: 'File Operation',
            filePath: '/test/file.md'
        };
        
        await ErrorHandler.handle(error, context, ErrorSeverity.Error);
        
        const callArg = showErrorMessageStub.firstCall.args[0];
        assert.ok(callArg.includes('/test/file.md'), 'Message should include file path');
    });

    test('should provide recovery options', async () => {
        let recoveryExecuted = false;
        const error = new Error('Test error');
        const context: ErrorContext = {
            operation: 'Operation with Recovery',
            recoveryOptions: [{
                label: 'Retry',
                action: async () => { recoveryExecuted = true; }
            }]
        };
        
        showErrorMessageStub.resolves('Retry');
        
        await ErrorHandler.handle(error, context, ErrorSeverity.Error);
        
        // Check that recovery option was included in message
        const messageButtons = showErrorMessageStub.firstCall.args.slice(1);
        assert.ok(messageButtons.includes('Retry'), 'Retry button should be available');
        
        // Check that recovery was executed
        assert.strictEqual(recoveryExecuted, true, 'Recovery action should be executed');
    });

    test('retryOption should create valid recovery option', () => {
        let retryCount = 0;
        const retryOption = ErrorHandler.retryOption(() => { retryCount++; });
        
        assert.strictEqual(retryOption.label, 'Retry');
        assert.strictEqual(retryOption.isDefault, true);
        
        retryOption.action();
        assert.strictEqual(retryCount, 1, 'Retry action should increment count');
    });

    test('openSettingsOption should create valid recovery option', () => {
        const executeCommandStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();
        const settingsOption = ErrorHandler.openSettingsOption('test.setting');
        
        assert.strictEqual(settingsOption.label, 'Open Settings');
        
        settingsOption.action();
        
        assert.ok(executeCommandStub.calledWith('workbench.action.openSettings', 'test.setting'));
    });

    test('openFileOption should create valid recovery option', async () => {
        const openTextDocumentStub = sandbox.stub(vscode.workspace, 'openTextDocument').resolves({} as any);
        const showTextDocumentStub = sandbox.stub(vscode.window, 'showTextDocument').resolves({} as any);
        
        const fileOption = ErrorHandler.openFileOption('/test/file.md');
        
        assert.strictEqual(fileOption.label, 'Open File');
        
        await fileOption.action();
        
        assert.ok(openTextDocumentStub.calledOnce);
        assert.ok(showTextDocumentStub.calledOnce);
    });

    test('should extract error message from string', async () => {
        const context: ErrorContext = { operation: 'Test' };
        
        await ErrorHandler.handle('Simple string error', context, ErrorSeverity.Error);
        
        const callArg = showErrorMessageStub.firstCall.args[0];
        assert.ok(callArg.includes('Simple string error'));
    });

    test('should extract error message from Error object', async () => {
        const error = new Error('Error object message');
        const context: ErrorContext = { operation: 'Test' };
        
        await ErrorHandler.handle(error, context, ErrorSeverity.Error);
        
        const callArg = showErrorMessageStub.firstCall.args[0];
        assert.ok(callArg.includes('Error object message'));
    });

    test('should handle error details in context', async () => {
        const error = new Error('Test');
        const context: ErrorContext = {
            operation: 'Test',
            details: {
                userId: 123,
                action: 'export'
            }
        };
        
        await ErrorHandler.handle(error, context, ErrorSeverity.Error);
        
        // Details should be logged (we can't easily test output panel content, 
        // but we can verify no errors are thrown)
        assert.ok(true, 'Should handle details without error');
    });
});
