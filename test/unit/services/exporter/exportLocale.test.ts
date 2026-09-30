import * as assert from 'assert';
import { exportLocale, formatPrintDate, fillPrintDate, applyPrintDate } from '../../../../src/services/exporter/puppeteer';

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

suite('formatPrintDate', () => {
    // 2026-09-30 13:20 local time, so the expectation does not depend on the test host's zone.
    const now = new Date(2026, 8, 30, 13, 20);
    // Newer ICU writes a narrow no-break space before AM/PM; compare with whitespace folded.
    const fold = (s: string) => s.replace(/[\s ]+/g, ' ');

    test('de gives dd.mm.yy, hh:mm', () => {
        assert.strictEqual(formatPrintDate('de', now), '30.09.26, 13:20');
    });

    test('en-US gives m/d/yy, h:mm AM/PM', () => {
        assert.strictEqual(fold(formatPrintDate('en-US', now)), '9/30/26, 1:20 PM');
    });

    test('regional variants are honoured, not mapped to their language', () => {
        assert.match(formatPrintDate('fr-CH', now), /^30\.09\.26,? 13[:.]20$/);
        assert.match(fold(formatPrintDate('en-CA', now)), /^2026-09-30, 1:20 p\.m\.$/);
    });

    test('an invalid tag falls back to the default locale and warns once, naming the setting', () => {
        const warnings: string[] = [];
        const text = formatPrintDate('not_a_locale!', now, m => warnings.push(m));
        assert.strictEqual(text, formatPrintDate(undefined, now));
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes('markdownExtended.pdf.locale'));
    });
});

suite('fillPrintDate', () => {
    const D = '30.09.26, 13:20';

    test('fills an empty span in single and double quotes', () => {
        assert.strictEqual(fillPrintDate(`<span class='date'></span>`, D), `<span class='date'>${D}</span>`);
        assert.strictEqual(fillPrintDate(`<span class="date"></span>`, D), `<span class="date">${D}</span>`);
    });

    test('tolerates whitespace, other attributes and unquoted values', () => {
        assert.strictEqual(fillPrintDate(`<span  style="x" class = "date" > </span>`, D), `<span  style="x" class = "date" >${D}</span>`);
        assert.strictEqual(fillPrintDate(`<span class=date></span>`, D), `<span class=date>${D}</span>`);
    });

    test('matches date among other classes, not as a substring of one', () => {
        assert.strictEqual(fillPrintDate(`<span class="a date b"></span>`, D), `<span class="a date b">${D}</span>`);
        const other = `<span class="update"></span><span class="date-x"></span>`;
        assert.strictEqual(fillPrintDate(other, D), other);
    });

    test('fills several spans and leaves the other spans alone', () => {
        const t = `<span class='title'></span> <span class='date'></span> | <span class='pageNumber'></span> <span class='date'></span>`;
        assert.strictEqual(fillPrintDate(t, D),
            `<span class='title'></span> <span class='date'>${D}</span> | <span class='pageNumber'></span> <span class='date'>${D}</span>`);
    });

    test('a template without a date span is unchanged', () => {
        const t = `<div style="font-size: 9px"><span class='pageNumber'></span></div>`;
        assert.strictEqual(fillPrintDate(t, D), t);
        assert.strictEqual(fillPrintDate('', D), '');
    });

    test('content already in the span is replaced', () => {
        assert.strictEqual(fillPrintDate(`<span class='date'>old</span>`, D), `<span class='date'>${D}</span>`);
    });
});

suite('applyPrintDate', () => {
    const now = new Date(2026, 8, 30, 13, 20);

    test('the header and footer handed to page.pdf carry the formatted date', () => {
        const options: { headerTemplate?: unknown; footerTemplate?: unknown; format: string } = {
            format: 'A4',
            headerTemplate: `<span class='title'></span> <span class='date'></span>`,
            footerTemplate: `<span class="date"></span> / <span class='pageNumber'></span>`,
        };
        applyPrintDate(options, 'de', now);
        assert.strictEqual(options.headerTemplate, `<span class='title'></span> <span class='date'>30.09.26, 13:20</span>`);
        assert.strictEqual(options.footerTemplate, `<span class="date">30.09.26, 13:20</span> / <span class='pageNumber'></span>`);
        assert.strictEqual(options.format, 'A4');
    });

    test('a missing or non-string template is left alone', () => {
        const options: { headerTemplate?: unknown; footerTemplate?: unknown } = { headerTemplate: undefined };
        applyPrintDate(options, 'de', now);
        assert.strictEqual(options.headerTemplate, undefined);
        assert.strictEqual(options.footerTemplate, undefined);
    });

    test('two folders with two locales give two dates', () => {
        const a = { footerTemplate: `<span class='date'></span>` };
        const b = { footerTemplate: `<span class='date'></span>` };
        applyPrintDate(a, 'de', now);
        applyPrintDate(b, 'en-US', now);
        assert.notStrictEqual(a.footerTemplate, b.footerTemplate);
    });
});
