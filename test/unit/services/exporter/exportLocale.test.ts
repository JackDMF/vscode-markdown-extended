import * as assert from 'assert';
import { exportLocale, launchOptions } from '../../../../src/services/exporter/puppeteer';

suite('exportLocale', () => {
    test('the setting wins over VS Code\'s language', () => {
        assert.strictEqual(exportLocale('en-US', 'de'), 'en-US');
    });

    test('an empty or blank setting falls back to VS Code\'s language', () => {
        assert.strictEqual(exportLocale('', 'de'), 'de');
        assert.strictEqual(exportLocale('  ', 'de'), 'de');
        assert.strictEqual(exportLocale(undefined, 'de'), 'de');
    });

    test('a lowercase region tag passes through unchanged', () => {
        assert.strictEqual(exportLocale('', 'pt-br'), 'pt-br');
    });

    test('nothing set names no locale', () => {
        assert.strictEqual(exportLocale('', ''), undefined);
        assert.strictEqual(exportLocale(undefined, undefined), undefined);
    });

    test('the pseudo-locale qps-ploc names no locale, from either source', () => {
        assert.strictEqual(exportLocale('', 'qps-ploc'), undefined);
        assert.strictEqual(exportLocale('qps-ploc', 'de'), undefined);
    });
});

suite('launchOptions', () => {
    test('a locale adds --lang and LANG, merged with the process environment', () => {
        const o = launchOptions('chrome', 'de-DE');
        assert.ok(o.args!.includes('--lang=de-DE'));
        assert.strictEqual(o.env!.LANG, 'de-DE');
        assert.strictEqual(o.env!.PATH ?? o.env!.Path, process.env.PATH ?? process.env.Path);
    });

    test('no locale adds neither argument nor environment', () => {
        const o = launchOptions('chrome', undefined);
        assert.ok(!o.args!.some(a => a.startsWith('--lang')));
        assert.strictEqual(o.env, undefined);
    });
});
