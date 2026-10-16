import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as puppeteer from 'puppeteer';
import { vscodeMarkdownCss } from '../../editor/pageHarness';

const EXTENSION_ID = 'jackdmf.markdown-extended-pro';

/**
 * End-to-end test for the sidenote/sidebar stylesheet as it is actually applied
 * to an export: `styles/markdown-extended.css` (contributed via
 * `markdown.previewStyles`) followed by `styles/markdown-extended-default.css`
 * (the built-in export theme), on a body carrying the resolved `vscode-light` /
 * `vscode-dark` class that `renderPage` writes.
 *
 * The layout is decided by the window's width: a document using one side of
 * the page moves its notes into the margin from 960px, one using both sides
 * from 1200px, all of its notes together; below, and in print, a note is an
 * inline run in its sentence. The margin is a lane reserved on `<html>`, so a
 * note never leaves the window.
 *
 * CI-safe in the same way as the mermaid e2e test: it skips unless a browser is
 * already available (`MTE_E2E_CHROME`, or the one Puppeteer installed), and never
 * triggers a download.
 */
suite('Note Styles (e2e)', () => {
    const MIN_CONTRAST = 4.5;
    /** A bar is a graphical object: WCAG 1.4.11 asks 3:1 of it. */
    const MIN_BAR_CONTRAST = 3;
    let executablePath: string | undefined;
    let browser: puppeteer.Browser | undefined;
    let styles: string;

    const note = (ref: string, body: string) => `<span class="sn-ref"><span class="sn-anchor">${ref}</span><span class="sidenote">${body}</span></span>`;
    const mnote = (ref: string, body: string) => `<span class="mn-ref"><span class="mn-anchor">${ref}</span><span class="mnote">${body}</span></span>`;
    /** Notes on the right only: one side of the page. */
    const ONE_SIDED = `<p>Body text ${note('1', 'A sidenote.')} after.</p>`
        + `<p>More ${mnote('*', 'A marginal note.')}</p>`
        + `<p>Text.<span class="right-sidebar">Right.</span></p>`;
    /** A left sidebar as well: both sides. */
    const TWO_SIDED = ONE_SIDED + `<p><span class="left-sidebar">Left.</span>Text.</p>`;

    let previewStyles: string | undefined;

    const pageOf = (content: string, extra = '', sheets = styles) => `<!DOCTYPE html><html><head><meta charset="UTF-8">${sheets}${extra}</head>`
        + `<body class="markdown-body vscode-body vscode-THEME"><div class="content">${content}</div></body></html>`;

    suiteSetup(async function () {
        this.timeout(60000);
        const extensionPath = vscode.extensions.getExtension(EXTENSION_ID)?.extensionPath;
        const noteCss = extensionPath && path.join(extensionPath, 'styles', 'markdown-extended.css');
        const themeCss = extensionPath && path.join(extensionPath, 'styles', 'markdown-extended-default.css');
        if (!noteCss || !themeCss || !fs.existsSync(noteCss) || !fs.existsSync(themeCss)) {
            this.skip();
        }

        // Resolve a browser without touching BrowserManager: its singleton is
        // reset by other suites, and going through it would also risk a download.
        const envChrome = process.env.MTE_E2E_CHROME;
        if (envChrome && fs.existsSync(envChrome)) {
            executablePath = envChrome;
        } else {
            try {
                const bundled = puppeteer.executablePath();
                executablePath = bundled && fs.existsSync(bundled) ? bundled : undefined;
            } catch {
                executablePath = undefined;
            }
        }
        if (!executablePath) {
            this.skip();
        }

        // Mirrors renderPage(): contributed styles first, built-in theme second.
        styles = [noteCss, themeCss]
            .map(f => `<style>${fs.readFileSync(f, 'utf8')}</style>`)
            .join('\n');
        // The preview's cascade: VS Code's markdown.css (padding on html and body) first, then this extension's.
        const markdownCss = vscodeMarkdownCss();
        previewStyles = fs.existsSync(markdownCss) ? [markdownCss, noteCss].map(f => `<style>${fs.readFileSync(f, 'utf8')}</style>`).join('\n') : undefined;
        browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    });

    suiteTeardown(async () => {
        await browser?.close();
    });

    interface Measured {
        /** Each note's and sidebar's float and display, in document order. */
        floats: string[];
        displays: string[];
        padding: [string, string];
        overflow: number;
        anchorLine: string;
        anchorStyle: string;
        page: string;
        tint: string;
        bar: string;
        barWidth: number;
        text: string;
    }

    /** Measure `html` in one theme / viewport / media combination. */
    async function measure(html: string, theme: 'light' | 'dark', width: number, media: 'screen' | 'print'): Promise<Measured> {
        const p = await (browser as puppeteer.Browser).newPage();
        try {
            await p.setViewport({ width, height: 900 });
            await p.emulateMediaType(media);
            await p.setContent(html.replace('vscode-THEME', `vscode-${theme}`), { waitUntil: 'load' });
            return await p.evaluate(() => {
                const all = Array.from(document.querySelectorAll('.sidenote, .mnote, .left-sidebar, .right-sidebar'));
                const el = document.querySelector('.sidenote') as HTMLElement;
                const cs = getComputedStyle(el);
                const anchor = getComputedStyle(document.querySelector('.sn-anchor') as HTMLElement);
                // The page: the first opaque background from the body up.
                let page = 'rgb(255, 255, 255)';
                for (const n of [document.body, document.documentElement]) {
                    const c = getComputedStyle(n).backgroundColor;
                    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
                        page = c;
                        break;
                    }
                }
                const root = getComputedStyle(document.documentElement);
                return {
                    floats: all.map(n => getComputedStyle(n).float),
                    displays: all.map(n => getComputedStyle(n).display),
                    padding: [root.paddingLeft, root.paddingRight] as [string, string],
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    anchorLine: anchor.textDecorationLine,
                    anchorStyle: anchor.textDecorationStyle,
                    page,
                    tint: cs.backgroundColor,
                    bar: cs.borderLeftColor,
                    barWidth: parseFloat(cs.borderLeftWidth),
                    text: cs.color,
                };
            });
        } finally {
            await p.close();
        }
    }

    type Rgba = [number, number, number, number];
    /** A computed colour, `rgb()`/`rgba()` or `color(srgb …)` as color-mix() serializes, as 0–1 channels and alpha. */
    function parse(colour: string): Rgba {
        let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(colour);
        if (m) {
            return [+m[1] / 255, +m[2] / 255, +m[3] / 255, m[4] === undefined ? 1 : +m[4]];
        }
        m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+))?\)/.exec(colour);
        if (m) {
            return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
        }
        throw new Error(`unparsed colour ${colour}`);
    }
    /** `fg` painted over the opaque `bg`. */
    const over = (fg: Rgba, bg: Rgba): Rgba => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as Rgba;
    /** WCAG 2.1 contrast of two opaque colours. */
    function ratio(a: Rgba, b: Rgba): number {
        const lum = (c: Rgba) => {
            const f = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
            return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
        };
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
    }
    /** The note's bar against the page and its text against its tint, as painted. */
    function contrasts(m: Measured): { bar: number; text: number } {
        const page = parse(m.page);
        const tint = over(parse(m.tint), page);
        return { bar: ratio(over(parse(m.bar), page), page), text: ratio(over(parse(m.text), tint), tint) };
    }

    test('in print a note is an inline run with a bar that carries it alone, readable in both export themes', async function () {
        this.timeout(60000);
        for (const theme of ['light', 'dark'] as const) {
            const m = await measure(pageOf(TWO_SIDED), theme, 1280, 'print');
            assert.ok(m.floats.every(f => f === 'none'), `${theme}: notes must not float in print: ${m.floats}`);
            assert.ok(m.displays.every(d => d === 'inline'), `${theme}: inline runs in print: ${m.displays}`);
            // max(3px, 0.8mm): 3.02px, which Chromium snaps to whole device pixels.
            assert.ok(m.barWidth >= 3, `${theme}: the bar is max(3px, 0.8mm) in print, not ${m.barWidth}px`);
            const c = contrasts(m);
            assert.ok(c.bar >= MIN_BAR_CONTRAST, `${theme}: bar ${c.bar.toFixed(2)}:1 against the page (${m.bar} on ${m.page})`);
            const screen = contrasts(await measure(pageOf(TWO_SIDED), theme, 900, 'screen'));
            assert.ok(c.bar > screen.bar, `${theme}: the print bar is darker than the screen's (${c.bar.toFixed(2)} vs ${screen.bar.toFixed(2)})`);
            assert.ok(c.text >= MIN_CONTRAST, `${theme}: note text ${c.text.toFixed(2)}:1 on its tint (${m.text} on ${m.tint})`);
        }
    });

    test('inline below the threshold: tinted, a bar of 3:1, text of 4.5:1, the anchor underlined dotted', async function () {
        this.timeout(60000);
        for (const theme of ['light', 'dark'] as const) {
            const m = await measure(pageOf(ONE_SIDED), theme, 900, 'screen');
            assert.ok(m.displays.every(d => d === 'inline'), `${theme}: ${m.displays}`);
            const c = contrasts(m);
            assert.ok(c.bar >= MIN_BAR_CONTRAST, `${theme}: bar ${c.bar.toFixed(2)}:1 (${m.bar} on ${m.page})`);
            assert.ok(c.text >= MIN_CONTRAST, `${theme}: note text ${c.text.toFixed(2)}:1 (${m.text} on ${m.tint})`);
            assert.deepStrictEqual([m.anchorLine, m.anchorStyle], ['underline', 'dotted'], theme);
        }
    });

    test('a document using both sides moves into the margin from 1200px, both lanes reserved, nothing overflowing', async function () {
        this.timeout(60000);
        for (const theme of ['light', 'dark'] as const) {
            const m = await measure(pageOf(TWO_SIDED), theme, 1280, 'screen');
            assert.deepStrictEqual(m.floats, ['right', 'right', 'right', 'left'], `${theme}: notes should move into the margin at 1280px`);
            assert.deepStrictEqual(m.padding, ['250px', '250px'], `${theme}: a lane on each side`);
            assert.strictEqual(m.overflow, 0, `${theme}: notes overflow the viewport by ${m.overflow}px`);
            assert.deepStrictEqual([m.anchorLine, m.anchorStyle], ['underline', 'dotted'], `${theme}: the anchor in the margin layout too`);
        }
        const below = await measure(pageOf(TWO_SIDED), 'light', 1199, 'screen');
        assert.ok(below.floats.every(f => f === 'none'), `1199px: ${below.floats}`);
        const at = await measure(pageOf(TWO_SIDED), 'light', 1200, 'screen');
        assert.ok(at.floats.every(f => f !== 'none'), `1200px: ${at.floats}`);
    });

    test('a document using one side moves into the margin from 960px, its one lane reserved', async function () {
        this.timeout(60000);
        const below = await measure(pageOf(ONE_SIDED), 'light', 959, 'screen');
        assert.ok(below.floats.every(f => f === 'none'), `959px: ${below.floats}`);
        assert.deepStrictEqual(below.padding, ['0px', '0px'], '959px: no lane');
        const at = await measure(pageOf(ONE_SIDED), 'light', 960, 'screen');
        assert.deepStrictEqual(at.floats, ['right', 'right', 'right'], '960px');
        assert.deepStrictEqual(at.padding, ['0px', '250px'], '960px: the right lane only');
        assert.strictEqual(at.overflow, 0);
    });

    test('a document using both sides switches together: at 1100px a one-sided page floats, the two-sided one stays inline throughout', async function () {
        this.timeout(60000);
        const one = await measure(pageOf(ONE_SIDED), 'light', 1100, 'screen');
        assert.ok(one.floats.every(f => f === 'right'), `one-sided: ${one.floats}`);
        const two = await measure(pageOf(TWO_SIDED), 'light', 1100, 'screen');
        assert.ok(two.floats.every(f => f === 'none'), `two-sided: ${two.floats}`);
        assert.deepStrictEqual(two.padding, ['0px', '0px'], 'two-sided: no lane at all');
    });

    test('nothing scrolls sideways at any width, in either kind of document', async function () {
        this.timeout(60000);
        for (const width of [600, 960, 1200, 1600]) {
            for (const [name, content] of [['one-sided', ONE_SIDED], ['two-sided', TWO_SIDED]]) {
                const m = await measure(pageOf(content), 'light', width, 'screen');
                assert.strictEqual(m.overflow, 0, `${name} at ${width}px overflows by ${m.overflow}px`);
            }
        }
    });

    test('a reader\'s stylesheet loaded after both wins with a bare class', async function () {
        this.timeout(60000);
        const m = await measure(pageOf(ONE_SIDED, '<style>.sidenote { float: none }</style>'), 'light', 1600, 'screen');
        assert.strictEqual(m.floats[0], 'none', 'the reader\'s .sidenote wins over the margin layout');
        assert.strictEqual(m.floats[1], 'right', 'and only where it says');
    });

    test('notes run inline at the image-export viewport', async function () {
        this.timeout(60000);
        // Puppeteer's default viewport — the width PNG/JPG export renders at.
        const m = await measure(pageOf(TWO_SIDED), 'light', 800, 'screen');
        assert.ok(m.floats.every(f => f === 'none'), 'notes should run inline at 800px');
        assert.strictEqual(m.overflow, 0, `notes overflow the viewport by ${m.overflow}px`);
    });

    test('in the preview\'s cascade, after markdown.css\'s own padding on html, the lane is reserved on either tier', async function () {
        this.timeout(60000);
        if (!previewStyles) {
            this.skip();
        }
        const preview = (content: string) => pageOf(content, '', previewStyles);
        for (const width of [960, 1000, 1199]) {
            const m = await measure(preview(ONE_SIDED), 'light', width, 'screen');
            assert.deepStrictEqual([m.padding, m.floats, m.overflow], [['26px', '250px'], ['right', 'right', 'right'], 0], `one-sided at ${width}px`);
        }
        const between = await measure(preview(TWO_SIDED), 'light', 1100, 'screen');
        assert.deepStrictEqual([between.padding, between.overflow], [['26px', '26px'], 0], 'two-sided at 1100px: no lane');
        const wide = await measure(preview(TWO_SIDED), 'light', 1250, 'screen');
        assert.deepStrictEqual([wide.padding, wide.overflow], [['250px', '250px'], 0], 'two-sided at 1250px');
    });

    test('a paragraph that opens with a sidebar starts at the column\'s edge in the margin layout: the space after it collapses', async function () {
        this.timeout(60000);
        const p = await (browser as puppeteer.Browser).newPage();
        try {
            await p.setViewport({ width: 1600, height: 900 });
            await p.setContent(pageOf(`<h2>Heading</h2><p><span class="left-sidebar">Status</span> On track ${note('r', 'n')}.</p>`, '', previewStyles ?? styles).replace('vscode-THEME', 'vscode-light'));
            const [column, text] = await p.evaluate(() => {
                const t = (document.querySelector('p') as HTMLElement).childNodes[1];
                const range = document.createRange();
                range.setStart(t, 0);
                range.setEnd(t, (t.textContent ?? '').length);
                return [(document.querySelector('h2') as HTMLElement).getBoundingClientRect().left, Array.from(range.getClientRects()).find(r => r.width > 5)?.left ?? -1];
            });
            assert.ok(Math.abs(text - column) <= 0.5, `"On track" starts at ${text}, the column at ${column}`);
        } finally {
            await p.close();
        }
    });

    test('in print a reader who dropped the bar keeps it dropped', async function () {
        this.timeout(60000);
        for (const reader of ['body { --md-note-border-width: 0; }', 'body { --md-note-border-width: 0px; }']) {
            const m = await measure(pageOf(ONE_SIDED, `<style>${reader}</style>`), 'light', 1280, 'print');
            assert.strictEqual(m.barWidth, 0, reader);
        }
        const m = await measure(pageOf(ONE_SIDED, '<style>body { --md-note-border: transparent; }</style>'), 'light', 1280, 'print');
        assert.strictEqual(parse(m.bar)[3], 0, `a transparent bar stays transparent in print: ${m.bar}`);
    });
});
