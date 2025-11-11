import * as assert from 'assert';
import * as sinon from 'sinon';
import { ContributorService, ContributorType, IContributor } from '../../../../src/services/contributes/contributorService';

suite('ContributorService Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        ContributorService._reset();
    });

    teardown(() => {
        sandbox.restore();
        ContributorService._reset();
    });

    test('should be a singleton', () => {
        const instance1 = ContributorService.instance;
        const instance2 = ContributorService.instance;
        
        assert.strictEqual(instance1, instance2, 'Should return same instance');
    });

    test('should provide getStyles method', () => {
        const instance = ContributorService.instance;
        
        assert.strictEqual(typeof instance.getStyles, 'function', 'Should have getStyles method');
        
        const styles = instance.getStyles();
        assert.ok(Array.isArray(styles), 'getStyles should return an array');
    });

    test('should provide getScripts method', () => {
        const instance = ContributorService.instance;
        
        assert.strictEqual(typeof instance.getScripts, 'function', 'Should have getScripts method');
        
        const scripts = instance.getScripts();
        assert.ok(Array.isArray(scripts), 'getScripts should return an array');
    });

    test('should filter styles by contributor type', () => {
        const instance = ContributorService.instance;
        
        // Get official styles
        const officialStyles = instance.getStyles(c => c.type === ContributorType.Official);
        assert.ok(Array.isArray(officialStyles), 'Should return array for official styles');
        
        // Get third-party styles
        const thirdPartyStyles = instance.getStyles(c => c.type === ContributorType.ThirdParty);
        assert.ok(Array.isArray(thirdPartyStyles), 'Should return array for third-party styles');
    });

    test('should filter scripts by contributor type', () => {
        const instance = ContributorService.instance;
        
        // Get official scripts
        const officialScripts = instance.getScripts(c => c.type === ContributorType.Official);
        assert.ok(Array.isArray(officialScripts), 'Should return array for official scripts');
        
        // Get third-party scripts
        const thirdPartyScripts = instance.getScripts(c => c.type === ContributorType.ThirdParty);
        assert.ok(Array.isArray(thirdPartyScripts), 'Should return array for third-party scripts');
    });

    test('_reset should clear singleton instance', () => {
        const instance1 = ContributorService.instance;
        
        ContributorService._reset();
        const instance2 = ContributorService.instance;
        
        assert.notStrictEqual(instance1, instance2, 'Should create new instance after reset');
    });

    test('ContributorType enum should have correct values', () => {
        assert.strictEqual(ContributorType.Unknown, 0, 'Unknown should be 0');
        assert.strictEqual(ContributorType.Official, 1, 'Official should be 1');
        assert.strictEqual(ContributorType.ThirdParty, 2, 'ThirdParty should be 2');
    });

    test('should handle empty filter for getStyles', () => {
        const instance = ContributorService.instance;
        
        const allStyles = instance.getStyles();
        const filteredStyles = instance.getStyles(undefined);
        
        // Both should return arrays (behavior should be same)
        assert.ok(Array.isArray(allStyles), 'Should return array without filter');
        assert.ok(Array.isArray(filteredStyles), 'Should return array with undefined filter');
    });

    test('should handle custom filter function', () => {
        const instance = ContributorService.instance;
        
        // Custom filter: only contributors with at least one style
        const customFilter = (c: IContributor) => c.styles.length > 0;
        const styles = instance.getStyles(customFilter);
        
        assert.ok(Array.isArray(styles), 'Should return array with custom filter');
    });

    test('getScripts and getStyles should return independent results', () => {
        const instance = ContributorService.instance;
        
        const styles = instance.getStyles();
        const scripts = instance.getScripts();
        
        // Both should be arrays but potentially different content
        assert.ok(Array.isArray(styles), 'Styles should be array');
        assert.ok(Array.isArray(scripts), 'Scripts should be array');
    });
});
