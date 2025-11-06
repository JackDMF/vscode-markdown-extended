import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ExtensionContext } from '../../../../src/services/common/extensionContext';

suite('ExtensionContext Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockContext: vscode.ExtensionContext;

    setup(() => {
        sandbox = sinon.createSandbox();
        
        // Reset singleton before each test
        ExtensionContext._reset();
        
        // Create mock VS Code extension context
        mockContext = {
            subscriptions: [],
            globalState: {
                get: sandbox.stub(),
                update: sandbox.stub(),
                keys: sandbox.stub().returns([]),
                setKeysForSync: sandbox.stub()
            },
            workspaceState: {
                get: sandbox.stub(),
                update: sandbox.stub(),
                keys: sandbox.stub().returns([]),
                setKeysForSync: sandbox.stub()
            },
            extensionPath: '/test/path',
            extensionUri: vscode.Uri.file('/test/path'),
            globalStorageUri: vscode.Uri.file('/test/global'),
            logUri: vscode.Uri.file('/test/log'),
            storageUri: vscode.Uri.file('/test/storage'),
            storagePath: '/test/storage',
            globalStoragePath: '/test/global',
            logPath: '/test/log',
            extensionMode: vscode.ExtensionMode.Test,
            extension: {} as any,
            secrets: {} as any,
            environmentVariableCollection: {} as any,
            languageModelAccessInformation: {} as any,
            asAbsolutePath: (relativePath: string) => `/test/path/${relativePath}`
        } as unknown as vscode.ExtensionContext;
    });

    teardown(() => {
        sandbox.restore();
        ExtensionContext._reset();
    });

    test('should initialize singleton instance', () => {
        const instance = ExtensionContext.initialize(mockContext);
        
        assert.ok(instance, 'Instance should be created');
        assert.strictEqual(ExtensionContext.isInitialized, true);
    });

    test('should return same instance on multiple initialize calls', () => {
        const instance1 = ExtensionContext.initialize(mockContext);
        const instance2 = ExtensionContext.initialize(mockContext);
        
        assert.strictEqual(instance1, instance2, 'Should return same instance');
    });

    test('should throw error when accessing current before initialization', () => {
        assert.throws(
            () => ExtensionContext.current,
            /ExtensionContext not initialized/,
            'Should throw error when not initialized'
        );
    });

    test('should provide access to VS Code context', () => {
        const instance = ExtensionContext.initialize(mockContext);
        
        assert.strictEqual(instance.vsContext, mockContext);
    });

    test('should provide output panel', () => {
        const instance = ExtensionContext.initialize(mockContext);
        
        assert.ok(instance.outputPanel, 'Output panel should exist');
        assert.strictEqual(typeof instance.outputPanel.appendLine, 'function');
    });

    test('should manage markdown engine state', () => {
        const instance = ExtensionContext.initialize(mockContext);
        const mockMarkdown = { render: sandbox.stub() } as any;
        
        assert.strictEqual(instance.isMarkdownInitialized, false);
        
        instance.setMarkdown(mockMarkdown);
        
        assert.strictEqual(instance.isMarkdownInitialized, true);
        assert.strictEqual(instance.markdown, mockMarkdown);
    });

    test('should throw error when accessing markdown before initialization', () => {
        const instance = ExtensionContext.initialize(mockContext);
        
        assert.throws(
            () => instance.markdown,
            /Markdown engine not initialized/,
            'Should throw error when markdown not set'
        );
    });

    test('should provide global storage path', () => {
        const instance = ExtensionContext.initialize(mockContext);
        
        assert.strictEqual(instance.globalStoragePath, '/test/global');
    });

    test('_reset should clear singleton instance', () => {
        ExtensionContext.initialize(mockContext);
        assert.strictEqual(ExtensionContext.isInitialized, true);
        
        ExtensionContext._reset();
        
        assert.strictEqual(ExtensionContext.isInitialized, false);
        assert.throws(
            () => ExtensionContext.current,
            /ExtensionContext not initialized/
        );
    });
});
