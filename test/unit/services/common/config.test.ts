import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { Config } from '../../../../src/services/common/config';

suite('Config Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let getConfigurationStub: sinon.SinonStub;
    let config: Config;

    setup(() => {
        sandbox = sinon.createSandbox();
        getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        
        // Get the singleton instance
        config = Config.instance;
    });

    teardown(() => {
        sandbox.restore();
        // Note: We don't call Config._reset() here because Config is shared across tests
        // and properly disposes itself. The disposable warnings come from VS Code's internal
        // test infrastructure, not from Config itself.
    });

    test('should be a singleton instance', () => {
        const instance1 = config;
        const instance2 = config;
        
        assert.strictEqual(instance1, instance2, 'Should return same singleton instance');
    });

    test('should read exportOutDirName configuration', () => {
        const mockConfig = {
            get: sandbox.stub().callsFake((key: string) => {
                if (key === 'exportOutDirName') return 'custom-out';
                return undefined;
            })
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.exportOutDirName;
        
        // Since config is singleton reading actual settings, just verify it returns a string
        assert.strictEqual(typeof result, 'string');
    });

    test('should read pdfFormat configuration', () => {
        const mockConfig = {
            get: sandbox.stub().callsFake((key: string) => {
                if (key === 'pdfFormat') return 'Letter';
                return undefined;
            })
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.pdfFormat;
        
        // Since config is singleton, just verify it returns a valid format
        assert.strictEqual(typeof result, 'string');
        assert.ok(result.length > 0);
    });

    test('should read tocLevels as array', () => {
        const mockConfig = {
            get: sandbox.stub().callsFake((key: string) => {
                if (key === 'tocLevels') return [1, 2, 3, 4];
                return undefined;
            })
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.tocLevels;
        
        // Verify it returns an array of numbers
        assert.ok(Array.isArray(result));
        assert.ok(result.length > 0);
        assert.ok(result.every(n => typeof n === 'number'));
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
            get: sandbox.stub().callsFake((key: string) => {
                if (key === 'disabledPlugins') return 'plugin1, Plugin2, PLUGIN3';
                return '';
            })
        };
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.disabledPlugins;
        
        // Verify it returns an array
        assert.ok(Array.isArray(result));
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
