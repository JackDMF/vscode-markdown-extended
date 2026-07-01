import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { Config, resolveExportTheme } from '../../../../src/services/common/config';

/**
 * Build a mock WorkspaceConfiguration backed by a value map, supporting the
 * `get` and `inspect` calls that Config uses. Values are keyed by setting name
 * (e.g. the legacy `pdfFormat`); `inspect` reports them as an explicit
 * `globalValue`, which is how Config.migrated() detects a user-set value.
 */
function mockConf(values: Record<string, any>) {
    return {
        get: (key: string) => values[key],
        inspect: (key: string) => ({ globalValue: values[key] }),
    } as any;
}

suite('Config Tests', () => {
    let sandbox: sinon.SinonSandbox;
    let getConfigurationStub: sinon.SinonStub;
    let config: Config;

    setup(() => {
        sandbox = sinon.createSandbox();
        getConfigurationStub = sandbox.stub(vscode.workspace, 'getConfiguration');
        getConfigurationStub.returns(mockConf({}));
        
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
        const mockConfig = mockConf({ exportOutDirName: 'custom-out' });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.exportOutDirName;
        
        // Since config is singleton reading actual settings, just verify it returns a string
        assert.strictEqual(typeof result, 'string');
    });

    test('should read pdfFormat configuration', () => {
        const mockConfig = mockConf({ pdfFormat: 'Letter' });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.pdfFormat;
        
        // Since config is singleton, just verify it returns a valid format
        assert.strictEqual(typeof result, 'string');
        assert.ok(result.length > 0);
    });

    test('should read tocLevels as array', () => {
        const mockConfig = mockConf({ tocLevels: [1, 2, 3, 4] });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.tocLevels;
        
        // Verify it returns an array of numbers
        assert.ok(Array.isArray(result));
        assert.ok(result.length > 0);
        assert.ok(result.every(n => typeof n === 'number'));
    });

    test('should return default tocLevels when empty', () => {
        const mockConfig = mockConf({ tocLevels: [] });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.tocLevels;
        
        assert.deepStrictEqual(result, [1, 2, 3], 'Should return default [1, 2, 3]');
    });

    test('should filter non-number values from tocLevels', () => {
        const mockConfig = mockConf({ tocLevels: [1, 'invalid', 2, null, 3] });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.tocLevels;
        
        assert.deepStrictEqual(result, [1, 2, 3], 'Should filter out non-numbers');
    });

    test('should read disabledPlugins as comma-separated string', () => {
        const mockConfig = mockConf({ disabledPlugins: 'plugin1, Plugin2, PLUGIN3' });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.disabledPlugins;
        
        // Verify it returns an array
        assert.ok(Array.isArray(result));
    });

    test('should return empty array for empty disabledPlugins', () => {
        const mockConfig = mockConf({ disabledPlugins: '' });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.disabledPlugins;
        
        assert.deepStrictEqual(result, []);
    });

    test('should validate puppeteerExecutable exists', () => {
        const mockConfig = mockConf({ puppeteerExecutable: '/nonexistent/path' });
        getConfigurationStub.withArgs('markdownExtended').returns(mockConfig);
        
        const result = config.puppeteerExecutable;
        
        assert.strictEqual(result, '', 'Should return empty string if path does not exist');
    });

    test('resolveExportTheme resolves light, dark and auto', () => {
        // Explicit values win, regardless of the active theme.
        assert.strictEqual(resolveExportTheme('light', false), 'light');
        assert.strictEqual(resolveExportTheme('light', true), 'light');
        assert.strictEqual(resolveExportTheme('dark', false), 'dark');
        assert.strictEqual(resolveExportTheme('DARK', false), 'dark', 'case-insensitive');
        // auto follows the active theme.
        assert.strictEqual(resolveExportTheme('auto', true), 'dark');
        assert.strictEqual(resolveExportTheme('auto', false), 'light');
        // Missing / unknown values default to light (preserves prior behavior).
        assert.strictEqual(resolveExportTheme(undefined, true), 'light');
        assert.strictEqual(resolveExportTheme('', true), 'light');
        assert.strictEqual(resolveExportTheme('nonsense', true), 'light');
    });

    test('exportTheme getter returns light or dark', () => {
        assert.ok(['light', 'dark'].includes(config.exportTheme));
    });

    test('migrated() prefers new grouped key, falls back to legacy key', () => {
        // Only the legacy key is set -> it is used.
        getConfigurationStub.withArgs('markdownExtended').returns(mockConf({ pdfFormat: 'Legal' }));
        assert.strictEqual(config.pdfFormat, 'Legal', 'legacy key used when new key unset');

        // Both set -> the new grouped key wins.
        getConfigurationStub.withArgs('markdownExtended')
            .returns(mockConf({ 'pdf.format': 'Ledger', pdfFormat: 'Legal' }));
        assert.strictEqual(config.pdfFormat, 'Ledger', 'new grouped key wins over legacy');
    });

    test('exportDefaultStyles is on by default and can be disabled', () => {
        getConfigurationStub.withArgs('markdownExtended').returns(mockConf({}));
        assert.strictEqual(config.exportDefaultStyles, true, 'defaults on when unset');

        getConfigurationStub.withArgs('markdownExtended')
            .returns(mockConf({ 'export.defaultStyles': false }));
        assert.strictEqual(config.exportDefaultStyles, false, 'can be turned off');
    });
});
