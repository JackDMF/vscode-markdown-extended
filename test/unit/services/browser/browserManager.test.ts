import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { BrowserManager } from '../../../../src/services/browser/browserManager';
import { BrowserPlatform } from '@puppeteer/browsers';

suite('BrowserManager Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockContext: vscode.ExtensionContext;

    setup(() => {
        sandbox = sinon.createSandbox();
        
        // Reset singleton
        BrowserManager._reset();
        
        // Create mock context
        mockContext = {
            globalStorageUri: vscode.Uri.file('/test/global'),
            globalStoragePath: '/test/global'
        } as unknown as vscode.ExtensionContext;
    });

    teardown(() => {
        sandbox.restore();
        BrowserManager._reset();
    });

    test('should be a singleton', () => {
        const instance1 = BrowserManager.getInstance(mockContext);
        const instance2 = BrowserManager.getInstance();
        
        assert.strictEqual(instance1, instance2, 'Should return same instance');
    });

    test('should throw error when getInstance called without context on first call', () => {
        assert.throws(
            () => BrowserManager.getInstance(),
            /requires extension context/,
            'Should throw error when context not provided on first call'
        );
    });

    test('should detect Windows 64-bit platform', () => {
        const instance = BrowserManager.getInstance(mockContext);
        
        // Stub process.platform and process.arch
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
        
        try {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            Object.defineProperty(process, 'arch', { value: 'x64' });
            
            const platform = instance.detectPlatform();
            
            assert.strictEqual(platform, BrowserPlatform.WIN64);
        } finally {
            // Restore original values
            if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
            if (originalArch) Object.defineProperty(process, 'arch', originalArch);
        }
    });

    test('should detect macOS ARM platform', () => {
        const instance = BrowserManager.getInstance(mockContext);
        
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
        
        try {
            Object.defineProperty(process, 'platform', { value: 'darwin' });
            Object.defineProperty(process, 'arch', { value: 'arm64' });
            
            const platform = instance.detectPlatform();
            
            assert.strictEqual(platform, BrowserPlatform.MAC_ARM);
        } finally {
            if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
            if (originalArch) Object.defineProperty(process, 'arch', originalArch);
        }
    });

    test('should detect Linux platform', () => {
        const instance = BrowserManager.getInstance(mockContext);
        
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        
        try {
            Object.defineProperty(process, 'platform', { value: 'linux' });
            
            const platform = instance.detectPlatform();
            
            assert.strictEqual(platform, BrowserPlatform.LINUX);
        } finally {
            if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
        }
    });

    test('should throw error for unsupported platform', () => {
        const instance = BrowserManager.getInstance(mockContext);
        
        const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
        
        try {
            Object.defineProperty(process, 'platform', { value: 'freebsd' });
            
            assert.throws(
                () => instance.detectPlatform(),
                /Unsupported platform/,
                'Should throw error for unsupported platform'
            );
        } finally {
            if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
        }
    });

    test('should return browser cache directory in global storage', () => {
        const instance = BrowserManager.getInstance(mockContext);
        
        const cacheDir = instance.getBrowserCacheDir();
        
        assert.ok(cacheDir.includes('test'), 'Cache dir should include test');
        assert.ok(cacheDir.includes('global'), 'Cache dir should include global');
        assert.ok(cacheDir.includes('.chromium'), 'Cache dir should include .chromium');
    });

    test('should check if browser is installed', () => {
        const instance = BrowserManager.getInstance(mockContext);
        
        // This will check actual file system, so just verify it returns a boolean
        const isInstalled = instance.isBrowserInstalled();
        
        assert.strictEqual(typeof isInstalled, 'boolean', 'Should return boolean');
    });

    test('_reset should clear singleton instance', () => {
        BrowserManager.getInstance(mockContext);
        
        BrowserManager._reset();
        
        assert.throws(
            () => BrowserManager.getInstance(),
            /requires extension context/,
            'Should require context after reset'
        );
    });

    test('getBrowserPath should return undefined or string', () => {
        const instance = BrowserManager.getInstance(mockContext);
        
        const browserPath = instance.getBrowserPath();
        
        // Should return undefined or a string
        assert.ok(browserPath === undefined || typeof browserPath === 'string');
    });
});
