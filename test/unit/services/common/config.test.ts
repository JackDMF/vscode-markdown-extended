import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { config } from '../../../../src/services/common/config';

suite('Config Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let getConfigurationStub: sinon.SinonStub;

    setup(() => {
        sandbox = sinon.createSandbox();
        getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
    });

    teardown(() => {
        sandbox.restore();
    });

    test('should be a singleton instance', () => {
        const instance1 = config;
        const instance2 = config;
        
        assert.strictEqual(instance1, instance2, 'Should return same singleton instance');
    });

    test('should read exportOutDirName configuration', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('exportOutDirName').returns('custom-out')
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.exportOutDirName;
        
        assert.strictEqual(result, 'custom-out');
    });

    test('should read pdfFormat configuration', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('pdfFormat').returns('Letter')
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.pdfFormat;
        
        assert.strictEqual(result, 'Letter');
    });

    test('should read tocLevels as array', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('tocLevels').returns([1, 2, 3, 4])
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.tocLevels;
        
        assert.deepStrictEqual(result, [1, 2, 3, 4]);
    });

    test('should return default tocLevels when empty', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('tocLevels').returns([])
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.tocLevels;
        
        assert.deepStrictEqual(result, [1, 2, 3], 'Should return default [1, 2, 3]');
    });

    test('should filter non-number values from tocLevels', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('tocLevels').returns([1, 'invalid', 2, null, 3])
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.tocLevels;
        
        assert.deepStrictEqual(result, [1, 2, 3], 'Should filter out non-numbers');
    });

    test('should read disabledPlugins as comma-separated string', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('disabledPlugins').returns('plugin1, Plugin2, PLUGIN3')
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.disabledPlugins;
        
        assert.deepStrictEqual(result, ['plugin1', 'plugin2', 'plugin3'], 'Should lowercase and trim');
    });

    test('should return empty array for empty disabledPlugins', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('disabledPlugins').returns('')
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.disabledPlugins;
        
        assert.deepStrictEqual(result, []);
    });

    test('should validate puppeteerExecutable exists', () => {
        const mockConfig = {
            get: sandbox.stub().withArgs('puppeteerExecutable').returns('/nonexistent/path')
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.puppeteerExecutable;
        
        assert.strictEqual(result, '', 'Should return empty string if path does not exist');
    });
});
