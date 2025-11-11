import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ContributesService } from '../../../../src/services/contributes/contributesService';

suite('ContributesService Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let mockUri: vscode.Uri;

    setup(() => {
        sandbox = sinon.createSandbox();
        ContributesService._reset();
        
        mockUri = vscode.Uri.file('/test/document.md');
    });

    teardown(() => {
        sandbox.restore();
        ContributesService._reset();
    });

    test('should be a singleton', () => {
        const instance1 = ContributesService.instance;
        const instance2 = ContributesService.instance;
        
        assert.strictEqual(instance1, instance2, 'Should return same instance');
    });

    test('should have styles object with all methods', () => {
        const instance = ContributesService.instance;
        
        assert.ok(instance.styles, 'Should have styles object');
        assert.strictEqual(typeof instance.styles.all, 'function', 'Should have styles.all method');
        assert.strictEqual(typeof instance.styles.official, 'function', 'Should have styles.official method');
        assert.strictEqual(typeof instance.styles.thirdParty, 'function', 'Should have styles.thirdParty method');
        assert.strictEqual(typeof instance.styles.user, 'function', 'Should have styles.user method');
    });

    test('should have scripts object with all methods', () => {
        const instance = ContributesService.instance;
        
        assert.ok(instance.scripts, 'Should have scripts object');
        assert.strictEqual(typeof instance.scripts.all, 'function', 'Should have scripts.all method');
        assert.strictEqual(typeof instance.scripts.official, 'function', 'Should have scripts.official method');
        assert.strictEqual(typeof instance.scripts.thirdParty, 'function', 'Should have scripts.thirdParty method');
    });

    test('styles.all should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.styles.all();
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
    });

    test('styles.official should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.styles.official();
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
    });

    test('styles.thirdParty should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.styles.thirdParty();
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
    });

    test('styles.user should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.styles.user(mockUri);
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
    });

    test('scripts.all should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.scripts.all();
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
    });

    test('scripts.official should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.scripts.official();
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
    });

    test('scripts.thirdParty should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.scripts.thirdParty();
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
    });

    test('createStyle should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.createStyle('body { color: red; }', 'test style');
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
        assert.ok(result.length > 0, 'Should return non-empty string');
    });

    test('createScript should return string', () => {
        const instance = ContributesService.instance;
        
        const result = instance.createScript('console.log("test");', 'test script');
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
        assert.ok(result.length > 0, 'Should return non-empty string');
    });

    test('createStyle should accept Buffer', () => {
        const instance = ContributesService.instance;
        
        const buffer = Buffer.from('body { color: blue; }');
        const result = instance.createStyle(buffer, 'test style');
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
        assert.ok(result.length > 0, 'Should return non-empty string');
    });

    test('createScript should accept Buffer', () => {
        const instance = ContributesService.instance;
        
        const buffer = Buffer.from('console.log("test");');
        const result = instance.createScript(buffer, 'test script');
        
        assert.strictEqual(typeof result, 'string', 'Should return string');
        assert.ok(result.length > 0, 'Should return non-empty string');
    });

    test('_reset should clear singleton instance', () => {
        const instance1 = ContributesService.instance;
        
        ContributesService._reset();
        const instance2 = ContributesService.instance;
        
        assert.notStrictEqual(instance1, instance2, 'Should create new instance after reset');
    });
});
