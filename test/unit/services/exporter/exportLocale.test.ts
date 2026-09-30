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

    test('a malformed tag falls back to the default locale and warns once, naming the setting', () => {
        const warnings: string[] = [];
        const text = formatPrintDate('not_a_locale!', now, m => warnings.push(m));
        assert.strictEqual(text, formatPrintDate(undefined, now));
        assert.strictEqual(warnings.length, 1);
        assert.ok(warnings[0].includes('markdownExtended.pdf.locale'));
    });

    test('a well-formed but unknown tag is invalid too', () => {
        for (const tag of ['German', 'xx-YY']) {
            const warnings: string[] = [];
            assert.strictEqual(formatPrintDate(tag, now, m => warnings.push(m)), formatPrintDate(undefined, now), tag);
            assert.strictEqual(warnings.length, 1, tag);
        }
    });
});

suite('fillPrintDate', () => {
    const D = '30.09.26, 13:20';

    test('fills an empty span in single and double quotes, and renames the class', () => {
        assert.strictEqual(fillPrintDate(`<span class='date'></span>`, D), `<span class='print-date'>${D}</span>`);
        assert.strictEqual(fillPrintDate(`<span class="date"></span>`, D), `<span class="print-date">${D}</span>`);
    });

    test('the filled element never carries class date, which Chrome would overwrite', () => {
        const out = fillPrintDate(`<span class="a date b"></span><div class=date></div>`, D);
        const lists = [...out.matchAll(/class="([^"]*)"/g)].map(m => m[1].split(' '));
        assert.strictEqual(lists.length, 2, out);
        assert.ok(lists.every(l => l.includes('print-date') && !l.includes('date')), out);
    });

    test('tolerates whitespace, other attributes and unquoted values', () => {
        assert.strictEqual(fillPrintDate(`<span  style="x" class = "date" > </span>`, D), `<span  style="x" class = "print-date" >${D}</span>`);
        assert.strictEqual(fillPrintDate(`<span class=date></span>`, D), `<span class="print-date">${D}</span>`);
    });

    test('keeps every other class and attribute, in place', () => {
        assert.strictEqual(fillPrintDate(`<span id="d" class="a date b" style="font-size: 9px"></span>`, D),
            `<span id="d" class="a print-date b" style="font-size: 9px">${D}</span>`);
    });

    test('matches date among other classes, not as a substring of one', () => {
        const other = `<span class="update"></span><span class="date-x"></span>`;
        assert.strictEqual(fillPrintDate(other, D), other);
    });

    test('fills several elements and leaves the others alone', () => {
        const t = `<span class='title'></span> <span class='date'></span> | <span class='pageNumber'></span> <span class='date'></span>`;
        assert.strictEqual(fillPrintDate(t, D),
            `<span class='title'></span> <span class='print-date'>${D}</span> | <span class='pageNumber'></span> <span class='print-date'>${D}</span>`);
    });

    test('a template without a date element is unchanged', () => {
        const t = `<div style="font-size: 9px"><span class='pageNumber'></span></div>`;
        assert.strictEqual(fillPrintDate(t, D), t);
        assert.strictEqual(fillPrintDate('', D), '');
    });

    test('content already in the element is replaced', () => {
        assert.strictEqual(fillPrintDate(`<span class='date'>old</span>`, D), `<span class='print-date'>${D}</span>`);
    });

    test('an outer non-date element does not swallow an inner date element', () => {
        assert.strictEqual(fillPrintDate(`<span class="wrap">Stand: <span class="date"></span></span>`, D),
            `<span class="wrap">Stand: <span class="print-date">${D}</span></span>`);
    });

    test('any element name counts', () => {
        assert.strictEqual(fillPrintDate(`<div class="date"></div>`, D), `<div class="print-date">${D}</div>`);
        assert.strictEqual(fillPrintDate(`<p class="x date">old</p>`, D), `<p class="x print-date">${D}</p>`);
    });

    test('a > inside a quoted attribute does not end the tag', () => {
        assert.strictEqual(fillPrintDate(`<span title="a>b" class="date"></span>`, D), `<span title="a>b" class="print-date">${D}</span>`);
        assert.strictEqual(fillPrintDate(`<span class="date" title='a>b'>x</span>`, D), `<span class="print-date" title='a>b'>${D}</span>`);
    });

    test('a nested span inside the date element goes with it', () => {
        assert.strictEqual(fillPrintDate(`<span class="date">a<span>b</span>c</span> tail`, D), `<span class="print-date">${D}</span> tail`);
    });

    test('self-closing syntax on a non-void element opens it, as in HTML', () => {
        assert.strictEqual(fillPrintDate(`<span class="date"/> tail</span> after`, D), `<span class="print-date">${D}</span> after`);
        assert.strictEqual(fillPrintDate(`<div class="date" />x</div>y`, D), `<div class="print-date" >${D}</div>y`);
        // a same-named self-closing tag inside counts as open, so it needs its own end tag
        assert.strictEqual(fillPrintDate(`<span class="date"><span/>a</span>b</span>c`, D), `<span class="print-date">${D}</span>c`);
    });

    test('a void date element is empty and gets no text', () => {
        assert.strictEqual(fillPrintDate(`<br class="date"/> tail`, D), `<br class="print-date"> tail`);
        assert.strictEqual(fillPrintDate(`<img class="x date" src="a.png"> tail`, D), `<img class="x print-date" src="a.png"> tail`);
    });

    test('a comment inside the date element is skipped while looking for its end', () => {
        assert.strictEqual(fillPrintDate(`<span class="date"><!-- </span> -->x</span>tail`, D), `<span class="print-date">${D}</span>tail`);
    });

    test('an unclosed date element swallows the rest of the template, as Chrome does', () => {
        assert.strictEqual(fillPrintDate(`<b>a</b><span class="date">rest <i>of</i> it`, D), `<b>a</b><span class="print-date">${D}</span>`);
    });

    test('character references in the class value are decoded before testing for date', () => {
        assert.strictEqual(fillPrintDate(`<span class="&#100;ate"></span>`, D), `<span class="print-date">${D}</span>`);
        assert.strictEqual(fillPrintDate(`<span class="x &#x64;&#97;te"></span>`, D), `<span class="x print-date">${D}</span>`);
        const other = `<span class="&amp;date"></span>`;
        assert.strictEqual(fillPrintDate(other, D), other);
    });

    test('CSS strings and comments in a style block are left alone; attribute selectors follow', () => {
        assert.strictEqual(
            fillPrintDate(`<style>/* .date */ a::after { content: "v1.date" } b::after { content: 'x.date' } .date { } [class~="date"] { } [class~='date'] { } [class="date"] { } [class~="dated"] { }</style>`, D),
            `<style>/* .date */ a::after { content: "v1.date" } b::after { content: 'x.date' } .print-date { } [class~="print-date"] { } [class~='print-date'] { } [class="print-date"] { } [class~="dated"] { }</style>`);
    });

    test('an inline style block follows the rename', () => {
        assert.strictEqual(fillPrintDate(`<style>.date { color: red } .date-x { } .update {}</style><span class="date"></span>`, D),
            `<style>.print-date { color: red } .date-x { } .update {}</style><span class="print-date">${D}</span>`);
    });

    test('the printed time is escaped', () => {
        assert.strictEqual(fillPrintDate(`<span class="date"></span>`, 'a<b&c'), `<span class="print-date">a&lt;b&amp;c</span>`);
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
        assert.strictEqual(options.headerTemplate, `<span class='title'></span> <span class='print-date'>30.09.26, 13:20</span>`);
        assert.strictEqual(options.footerTemplate, `<span class="print-date">30.09.26, 13:20</span> / <span class='pageNumber'></span>`);
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
