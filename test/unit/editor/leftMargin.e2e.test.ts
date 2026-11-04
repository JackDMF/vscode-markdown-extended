import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { EditorPage, SHOTS_DIR, closeEditorPage, delay, leaveObjects, openEditorPage, shot } from './pageHarness';
import { BAR } from './breadcrumbPage';
import { notePage } from './noteAttributes.e2e.test';
import { repoRoot } from './helpers';
import { DARK_MODERN, LIGHT_MODERN, applyTheme } from './themes';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';

const BUBBLE = '.mep-bubble:not([hidden])';

const MARGIN_LAYOUT = path.join(repoRoot, 'test', 'fixtures', 'editor', 'marginLayout.css');
/** The geometry of Daniel's archive sheet: a time margin of 3 cm (2 cm below 1200 px) that a bar's narrowest form does not fit. */
const TIME_MARGIN = path.join(repoRoot, 'test', 'fixtures', 'editor', 'timeMargin.css');

/**
 * Bars at the left margin (wave 4 #5b follow-up, mirroring #15's rule for the
 * right): a bar for an object in a left sidebar stands at the editor's left
 * edge + 16 px and reaches into the column only where the column has no text
 * at its height; its verbs drop their nouns first. Measured at 1280 with the
 * margin layout fixture (a 160 px left margin, sidebars floated into it).
 */
suite('Editor left margin: a bar for a left sidebar (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    const b = notePage(() => editor as EditorPage);

    const LINES = Array.from({ length: 6 }, (_, k) => `Zeile ${k} mit etwas Text, der bis an den Rand der Spalte läuft und weitergeht.`).join('\n\n');
    const DOC = `${LINES}\n\nMitte $Uhrzeit\${class=living} und ein ruhiger Satz, der weitergeht.\n\n${LINES}\n\nThe last paragraph.\n`;
    const SHORT = 'Erster Absatz.\n\nMitte $Uhrzeit${class=living} und ein Satz.\n\nThe last paragraph.\n';

    /** The bar's box and its verbs as drawn, the column's left edge and every line of column text near the bar. */
    const measure = () => page.evaluate(sel => {
        const bar = document.querySelector(sel) as HTMLElement;
        const r = bar.getBoundingClientRect();
        const more = bar.querySelector<HTMLElement>('.mep-object-more');
        const nouns = Array.from(bar.querySelectorAll(':scope > button[data-verb]')).filter(v => !(v as HTMLElement).hidden).map(v => (v.textContent ?? '').trim());
        const pm = document.querySelector('.ProseMirror') as HTMLElement;
        const column = (pm.querySelector('p') as HTMLElement).getBoundingClientRect().left;
        const lines: { top: number; bottom: number; left: number; right: number; text: string }[] = [];
        const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!(n.textContent ?? '').trim() || (n.parentElement as HTMLElement).closest('.left-sidebar, .sidenote, .mnote, .right-sidebar')) {
                continue;
            }
            range.selectNodeContents(n);
            for (const q of Array.from(range.getClientRects())) {
                lines.push({ top: q.top, bottom: q.bottom, left: q.left, right: q.right, text: (n.textContent ?? '').slice(0, 12) });
            }
        }
        return { bar: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, more: more !== null && !more.hidden && more.isConnected, cut: bar.scrollWidth > bar.clientWidth + 1 }, nouns, column, lines };
    }, BAR);

    const overText = (m: Awaited<ReturnType<typeof measure>>) => m.lines.filter(l => m.bar.left < l.right && m.bar.right > l.left && m.bar.top < l.bottom && m.bar.bottom > l.top);

    teardown(async () => {
        if (editor !== undefined) {
            await page.keyboard.press('Escape');
            await leaveObjects(page);
        }
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    /** The bar of the sidebar at `needle`, shown, measured; a shot of it in both themes as `name` when shots are asked for. */
    async function barAt(doc: string, needle: string, name?: string) {
        await b.show(doc);
        await b.restAt(needle, 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const m = await measure();
        if (name !== undefined && SHOTS_DIR) {
            for (const [theme, label] of [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']] as const) {
                await applyTheme(page, theme);
                await delay(300);
                await shot(page, `${name}-${page.viewport()?.width ?? 0}-${label}.png`);
            }
            await applyTheme(page, LIGHT_MODERN);
        }
        return m;
    }

    test('a left sidebar between lines of text: its bar stands at the window\'s left edge + 16 px, never over column text, its words given way', async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css'], userStyles: [MARGIN_LAYOUT] });
        if (!editor) {
            this.skip();
        }
        page = (editor as EditorPage).page;
        const m = await barAt(DOC, 'Uhrzeit', 'left-between');
        assert.deepStrictEqual(overText(m), [], `never over column text: ${JSON.stringify(m)}`);
        assert.ok(Math.abs(m.bar.left - 16) < 1, `at the window's left edge + 16 px: ${JSON.stringify(m.bar)}`);
        assert.ok(m.bar.right <= m.column, `inside the margin: ${JSON.stringify(m.bar)}`);
        assert.ok(m.bar.more, `a verb gave way to "…": ${JSON.stringify(m)}`);
    });

    test('a left sidebar on the last line: nothing below it, so its bar reaches into the column, every verb on it, up to the edge less 16 px', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        const m = await barAt('Erster Absatz mit Text.\n\nZeile.\n\nThe last paragraph $Uhrzeit${class=living} und ein Rest.\n', 'Uhrzeit', 'left-last-line');
        assert.deepStrictEqual(overText(m), [], `never over column text: ${JSON.stringify(m)}`);
        assert.ok(Math.abs(m.bar.left - 16) < 1, `at the window's left edge + 16 px: ${JSON.stringify(m.bar)}`);
        assert.ok(m.bar.right > m.column + 50, `into the column where it has no text: ${JSON.stringify(m)}`);
        assert.ok(m.bar.right <= 1280 - 16 + 0.5, `inside the edge less 16 px: ${JSON.stringify(m.bar)}`);
        assert.ok(!m.bar.more, `no word gave way: ${JSON.stringify(m)}`);
    });

    test('a left sidebar on the first line: no room above it (the row), text below — its bar stays in the margin, off the text', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        const m = await barAt('$Uhrzeit${class=living} Der erste Absatz mit Text, der weitergeht.\n\nZeile.\n\nThe last paragraph.\n', 'Uhrzeit');
        assert.deepStrictEqual(overText(m), [], `never over column text: ${JSON.stringify(m)}`);
        assert.ok(Math.abs(m.bar.left - 16) < 1 && m.bar.right <= m.column, JSON.stringify(m.bar));
    });

    test('sidebars one line apart: the bar finds the gap — off the neighbouring sidebars\' text and off the column\'s', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        const doc = ['Eins $A-Zeit$ Text, der weitergeht.', 'Dazwischen Text.', 'Zwei $B-Zeit$ Text, der weitergeht.', 'Dazwischen Text.', 'Drei $C-Zeit$ Text, der weitergeht.', 'The last paragraph.'].join('\n\n') + '\n';
        const m = await barAt(doc, 'B-Zeit', 'left-spaced');
        const sidebars = await page.$$eval('.ProseMirror .left-sidebar', els => els.map(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; }));
        assert.deepStrictEqual(overText(m), [], `never over column text: ${JSON.stringify(m)}`);
        for (const other of [sidebars[0], sidebars[2]]) {
            const over = m.bar.left < other.right && m.bar.right > other.left && m.bar.top < other.bottom && m.bar.bottom > other.top;
            assert.ok(!over, `never over another sidebar: ${JSON.stringify({ bar: m.bar, other })}`);
        }
    });

    test('sidebars on every line: no gap in the margin — the bar still keeps off the column\'s text (it covers the next sidebar while it is shown)', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        const doc = ['Eins $A-Zeit$ Text, der weitergeht.', 'Zwei $B-Zeit$ Text, der weitergeht.', 'Drei $C-Zeit$ Text, der weitergeht.', 'Vier $D-Zeit$ Text, der weitergeht.', 'The last paragraph.'].join('\n\n') + '\n';
        const m = await barAt(doc, 'B-Zeit', 'left-stacked');
        assert.deepStrictEqual(overText(m), [], `never over column text: ${JSON.stringify(m)}`);
        assert.ok(Math.abs(m.bar.left - 16) < 1 && m.bar.right <= m.column, JSON.stringify(m.bar));
    });

    test('the bubble over words of a left sidebar stands in the margin, left of the column text', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        await b.show(DOC);
        await page.focus('.ProseMirror');
        await page.evaluate(() => {
            const side = Array.from(document.querySelectorAll('.ProseMirror .left-sidebar')).find(e => (e.textContent ?? '').includes('Uhrzeit')) as HTMLElement;
            side.scrollIntoView({ block: 'center' });
            const text = side.firstChild as globalThis.Node;
            (document.getSelection() as Selection).setBaseAndExtent(text, 0, text, 3);
        });
        await delay(INLINE_DELAY_MS + 300);
        await page.waitForSelector(BUBBLE, { visible: true, timeout: 3000 });
        const r = await page.$eval(BUBBLE, el => { const q = el.getBoundingClientRect(); return { left: q.left, right: q.right, top: q.top, bottom: q.bottom }; });
        const column = await page.$eval('.ProseMirror p', el => el.getBoundingClientRect().left);
        assert.ok(r.left >= 16 - 0.5 && r.left < column, `in the margin: ${JSON.stringify({ r, column })}`);
        await page.keyboard.press('Escape');
    });

    /** The box of the sidebar holding `needle`, and the page's line height. */
    const sidebarOf = (needle: string) => page.evaluate(n => {
        const el = Array.from(document.querySelectorAll('.ProseMirror .left-sidebar')).find(e => (e.textContent ?? '').includes(n)) as HTMLElement;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, line: parseFloat(getComputedStyle(document.querySelector('.ProseMirror') as HTMLElement).lineHeight) || 24 };
    }, needle);

    for (const width of [1280, 800]) {
        test(`with the archive sheet's time margin at ${width}: the narrowest bar does not fit the margin — never cut; within a line's height of its sidebar with no text between, else in the column under the block (Daniel, 2026-11-03)`, async function () {
            // Closed first: `closeEditorPage` sets the test's timeout to the close hook's.
            await closeEditorPage(this, editor);
            this.timeout(90000);
            editor = await openEditorPage({ width, height: 900, styles: ['markdown-extended.css'], userStyles: [TIME_MARGIN] });
            if (!editor) {
                this.skip();
            }
            page = (editor as EditorPage).page;
            const lines = Array.from({ length: 4 }, (_, k) => `Zeile ${k} mit etwas Text, der bis an den Rand der Spalte läuft und weitergeht und weitergeht.`).join('\n\n');
            const middle = `${lines}\n\nMitte $Uhrzeit\${class=living} und ein ruhiger Satz.\n\n- Punkt $Listenzeit$ mit Text, der weitergeht.\n- Zweiter Punkt mit Text.\n\n${lines}\n\nThe last paragraph.\n`;
            // Text above and below: no height within a line of the sidebar is free of it — the column, as before.
            for (const needle of ['Uhrzeit', 'Listenzeit']) {
                const m = await barAt(middle, needle, `time-margin-${needle === 'Uhrzeit' ? 'paragraph' : 'list'}`);
                assert.ok(!m.bar.cut, `${needle}: never cut: ${JSON.stringify(m.bar)}`);
                // The paragraph's sidebar: the column. A list item's text starts a rem in: the margin may do, then off every text.
                assert.ok(m.bar.left >= m.column - 1 || (needle === 'Listenzeit' && overText(m).length === 0), `${needle}: in the column under the block, or off the text: ${JSON.stringify(m)}`);
            }
            // Nothing below it: the bar stands right under its sidebar, in the margin, at the edge + 16 px.
            for (const [needle, doc] of [
                ['Ende', `${lines}\n\nThe last paragraph $Ende$ und ein Rest.\n`],
                ['Letzte', `${lines}\n\n- Punkt, der weitergeht.\n- The last paragraph $Letzte$ mit Text.\n`],
            ]) {
                const m = await barAt(doc, needle, `time-margin-end-${needle}`);
                const side = await sidebarOf(needle);
                assert.ok(!m.bar.cut, `${needle}: never cut: ${JSON.stringify(m.bar)}`);
                assert.deepStrictEqual(overText(m), [], `${needle}: no text under the bar: ${JSON.stringify(m)}`);
                assert.ok(Math.abs(m.bar.left - 16) < 1, `${needle}: at the edge + 16 px: ${JSON.stringify(m.bar)}`);
                const gap = m.bar.top >= side.bottom ? m.bar.top - side.bottom : side.top - m.bar.bottom;
                assert.ok(gap <= side.line, `${needle}: within a line's height of its sidebar: ${JSON.stringify({ gap, side })}`);
            }
        });
    }

    test('with the archive sheet\'s time margin: scrolling moves the bar with the text and probes nothing again', async function () {
        this.timeout(60000);
        if (editor === undefined) {
            this.skip();
        }
        const filler = Array.from({ length: 40 }, (_, k) => `Zeile ${k} mit etwas Text.`).join('\n\n');
        await b.show(`${filler}\n\nMitte $Uhrzeit\${class=living} kurz.\n\n${filler}\n\nThe last paragraph.\n`);
        await page.evaluate(() => (Array.from(document.querySelectorAll('.ProseMirror .left-sidebar')).find(e => (e.textContent ?? '').includes('Uhrzeit')) as HTMLElement).scrollIntoView({ block: 'center' }));
        await delay(300);
        await b.restAt('Uhrzeit', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const before = (await measure()).bar;
        const calls = await page.evaluate(async () => {
            let n = 0;
            const orig = document.elementFromPoint.bind(document);
            document.elementFromPoint = (x, y) => { n++; return orig(x, y); };
            window.scrollBy(0, 3);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            document.elementFromPoint = orig;
            return n;
        });
        const after = (await measure()).bar;
        assert.strictEqual(calls, 0, 'no probes for a scroll');
        assert.ok(Math.abs(after.top - (before.top - 3)) < 1.5 && Math.abs(after.left - before.left) < 1, JSON.stringify({ before, after }));
    });

    test('a bar that falls back into the column keeps off a note in the right margin beside it, as every bar does (review round 3, M-1)', async function () {
        await closeEditorPage(this, editor);
        this.timeout(90000);
        // At 800 the archive sheet's time margin (2 cm) is too narrow for the bar, and its notes float into the right margin
        // (7 cm): a bar under the block at the column's left, fitted out to the window's edge, would reach over them.
        editor = await openEditorPage({ width: 800, height: 900, styles: ['markdown-extended.css'], userStyles: [TIME_MARGIN] });
        if (!editor) {
            this.skip();
        }
        page = (editor as EditorPage).page;
        const lines = Array.from({ length: 4 }, (_, k) => `Zeile ${k} mit etwas Text, der bis an den Rand der Spalte läuft.`).join('\n\n');
        const note = 'ein langer Hinweis im Rand, der Zeile um Zeile nach unten reicht, neben dem Absatz und weit unter ihn, '
            + 'neben die folgenden Zeilen, immer weiter, bis er sicher neben der Leiste unter dem Absatz hängt, und noch ein Stück';
        // Text above and below the sidebar: no free height within a line of it — the bar falls back into the column, under the block.
        const doc = `${lines}\n\nMitte $Uhrzeit\${class=living} und ein ruhiger Satz !!Lang|${note}!! der weitergeht.\n\n${lines}\n\nThe last paragraph.\n`;
        const m = await barAt(doc, 'Uhrzeit', 'left-fallback-note');
        const notes = await page.$$eval('.ProseMirror :is(.sidenote, .mnote, .right-sidebar)', els => els.map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
        assert.ok(notes.length > 0, 'the note floats into the right margin');
        assert.ok(m.bar.left >= m.column - 1, `fallen back into the column: ${JSON.stringify(m.bar)}`);
        assert.ok(!m.bar.cut, `never cut: ${JSON.stringify(m.bar)}`);
        const beside = notes.filter(n => n.top < m.bar.bottom && n.bottom > m.bar.top);
        assert.ok(beside.length > 0, `the note hangs beside the bar (else the test proves nothing): ${JSON.stringify({ bar: m.bar, notes })}`);
        for (const n of beside) {
            assert.ok(m.bar.right <= n.left, `off the note in the right margin: ${JSON.stringify({ bar: m.bar, note: n })}`);
        }
    });

    test('a bar fallen back into the column, scrolled out of the window and back, still keeps off the note — what was measured out of sight is measured again (review round 4, H-1)', async function () {
        await closeEditorPage(this, editor);
        this.timeout(90000);
        editor = await openEditorPage({ width: 800, height: 600, styles: ['markdown-extended.css'], userStyles: [TIME_MARGIN] });
        if (!editor) {
            this.skip();
        }
        page = (editor as EditorPage).page;
        const filler = Array.from({ length: 30 }, (_, k) => `Zeile ${k} mit etwas Text.`).join('\n\n');
        const note = 'ein langer Hinweis im Rand, der Zeile um Zeile nach unten reicht, neben dem Absatz und weit unter ihn, '
            + 'neben die folgenden Zeilen, immer weiter, bis er sicher neben der Leiste unter dem Absatz hängt, und noch ein Stück';
        await b.show(`${filler}\n\nMitte $Uhrzeit\${class=living} und ein ruhiger Satz !!Lang|${note}!! der weitergeht.\n\n${filler}\n\nThe last paragraph.\n`);
        await page.evaluate(() => (Array.from(document.querySelectorAll('.ProseMirror .left-sidebar')).find(e => (e.textContent ?? '').includes('Uhrzeit')) as HTMLElement).scrollIntoView({ block: 'center' }));
        await delay(300);
        await b.restAt('Uhrzeit', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const noteBox = () => page.$eval('.ProseMirror .mnote', e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, bottom: r.bottom }; });
        const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const before = (await measure()).bar;
        const n0 = await noteBox();
        assert.ok(n0.top < before.bottom && n0.bottom > before.top, `the note hangs beside the bar: ${JSON.stringify({ before, n0 })}`);
        assert.ok(before.right <= n0.left, `off the note to start with: ${JSON.stringify({ before, n0 })}`);
        // Out of the window above (placed again there, where nothing can be probed), then back.
        const out = Math.ceil(before.bottom) + 60;
        await page.evaluate(dy => window.scrollBy(0, dy), out);
        await frames();
        const away = (await measure()).bar;
        assert.ok(away.bottom <= 0, `out of the window: ${JSON.stringify(away)}`);
        await page.evaluate(dy => window.scrollBy(0, -dy), out);
        await frames();
        const back = (await measure()).bar;
        const n1 = await noteBox();
        assert.ok(back.top >= 0 && back.bottom <= 600, `back in the window: ${JSON.stringify(back)}`);
        assert.ok(back.right <= n1.left, `still off the note: ${JSON.stringify({ back, note: n1 })}`);
    });

    // Text above the sidebar grows while its bar is up, with no scroll (the host's lens rows; a late image, an outside edit
    // alike): the sidebar moves down, the page does not — the bar follows its sidebar, it is not kept where it stood (H-2).
    for (const [label, sheet, width] of [['in the margin', MARGIN_LAYOUT, 1280], ['fallen back into the column', TIME_MARGIN, 800]] as const) {
        test(`a bar ${label}: rows of lenses drawn above its sidebar while it is up move it with the sidebar, within a line's height of it (review round 5, H-2)`, async function () {
            await closeEditorPage(this, editor);
            this.timeout(90000);
            editor = await openEditorPage({ width, height: 600, styles: ['markdown-extended.css'], userStyles: [sheet] });
            if (!editor) {
                this.skip();
            }
            page = (editor as EditorPage).page;
            const lines = Array.from({ length: 4 }, (_, k) => `Zeile ${k} mit etwas Text, der bis an den Rand der Spalte läuft.`);
            const blocks = [...lines, 'Mitte $Uhrzeit${class=living} und ein ruhiger Satz, der weitergeht.', ...lines, 'The last paragraph.'];
            const m = await barAt(`${blocks.join('\n\n')}\n`, 'Uhrzeit');
            const gapOf = async () => {
                const bar = (await measure()).bar;
                const side = await sidebarOf('Uhrzeit');
                return { gap: bar.top >= side.bottom ? bar.top - side.bottom : side.top - bar.bottom, bar, side };
            };
            const before = await gapOf();
            assert.ok(before.gap >= 0 && before.gap <= before.side.line, `under its sidebar to start with: ${JSON.stringify(before)}`);
            if (sheet === TIME_MARGIN) {
                assert.ok(m.bar.left >= m.column - 1, `fallen back into the column: ${JSON.stringify(m.bar)}`);
            } else {
                assert.ok(Math.abs(m.bar.left - 16) < 1, `in the margin: ${JSON.stringify(m.bar)}`);
            }
            // A version no document of the page reaches: the rows are for the document shown.
            await (editor as EditorPage).send({ type: 'lenses', version: 1_000_000, blocks: blocks.length, rows: [
                { blockIndex: 0, items: [{ id: 'a', title: 'Lens above the first block' }] },
                { blockIndex: 1, items: [{ id: 'b', title: 'Lens above the second block' }] },
            ] });
            await page.waitForFunction(() => document.querySelectorAll('.ProseMirror > .mep-lens-row').length === 2);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await delay(200);
            const after = await gapOf();
            assert.ok(after.side.bottom > before.side.bottom + 10, `the rows moved the sidebar down: ${JSON.stringify({ before: before.side, after: after.side })}`);
            assert.ok(after.gap >= 0 && after.gap <= after.side.line, `the bar moved with its sidebar: ${JSON.stringify({ before, after })}`);
        });
    }

    // The user's own stylesheet, read in place (`MEP_USER_STYLESHEET`; skipped without it): the rule's invariants, wherever its
    // geometry puts the bar — never cut; in the margin at the edge + 16 px off every text and within a line's height of its
    // sidebar, or in the column off every note in the right margin.
    const userSheet = process.env.MEP_USER_STYLESHEET;
    for (const width of [1280, 800]) {
        test(`with the user's own stylesheet (MEP_USER_STYLESHEET) at ${width}: a left sidebar's bar is never cut — in the margin within a line's height of its sidebar, off the text, or in the column off the notes`, async function () {
            if (userSheet === undefined || !fs.existsSync(userSheet)) {
                this.skip();
            }
            await closeEditorPage(this, editor);
            this.timeout(120000);
            editor = await openEditorPage({ width, height: 900, styles: ['markdown-extended.css'], userStyles: [userSheet as string] });
            if (!editor) {
                this.skip();
            }
            page = (editor as EditorPage).page;
            const lines = Array.from({ length: 4 }, (_, k) => `Zeile ${k} mit etwas Text, der bis an den Rand der Spalte läuft und weitergeht.`).join('\n\n');
            const note = '!!Lang|ein langer Hinweis im Rand, der Zeile um Zeile nach unten reicht, neben dem Absatz und weit unter ihn, bis er neben der Leiste hängt!!';
            const cases: [string, string][] = [
                ['Uhrzeit', `${lines}\n\nMitte $Uhrzeit\${class=living} und ein ruhiger Satz ${note} der weitergeht.\n\n${lines}\n\nThe last paragraph.\n`],
                ['Listenzeit', `${lines}\n\n- Punkt $Listenzeit$ mit Text, der weitergeht.\n- Zweiter Punkt mit Text.\n\n${lines}\n\nThe last paragraph.\n`],
                ['Ende', `${lines}\n\nThe last paragraph $Ende$ und ein Rest.\n`],
                ['Letzte', `${lines}\n\n- Punkt, der weitergeht.\n- The last paragraph $Letzte$ mit Text.\n`],
            ];
            const hidden: string[] = [];
            for (const [needle, doc] of cases) {
                // A sheet may hide `$…$` on screen (Daniel's Styles.css of 2026-11 does, `display: none`): no box, no caret in it, no bar.
                await b.show(doc);
                if (await page.evaluate(n => (Array.from(document.querySelectorAll('.ProseMirror .left-sidebar')).find(e => (e.textContent ?? '').includes(n)) as HTMLElement).getClientRects().length === 0, needle)) {
                    hidden.push(needle);
                    continue;
                }
                const m = await barAt(doc, needle, `user-sheet-${needle}`);
                const side = await sidebarOf(needle);
                const notes = await page.$$eval('.ProseMirror :is(.sidenote, .mnote, .right-sidebar)', els => els.map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }).filter(r => r.right > r.left));
                console.log(`MEP_USER_STYLESHEET ${width} ${needle}: ${JSON.stringify({ bar: m.bar, column: m.column, side })}`);
                assert.ok(!m.bar.cut, `${needle}: never cut: ${JSON.stringify(m.bar)}`);
                assert.ok(m.bar.right <= width - 16 + 0.5, `${needle}: inside the edge less 16 px: ${JSON.stringify(m.bar)}`);
                if (Math.abs(m.bar.left - 16) < 1) {
                    assert.deepStrictEqual(overText(m), [], `${needle}: in the margin, off every text: ${JSON.stringify(m)}`);
                    const gap = m.bar.top >= side.bottom ? m.bar.top - side.bottom : side.top - m.bar.bottom;
                    assert.ok(gap <= side.line, `${needle}: within a line's height of its sidebar: ${JSON.stringify({ gap, side })}`);
                } else {
                    assert.ok(m.bar.left >= m.column - 1, `${needle}: else in the column: ${JSON.stringify(m)}`);
                    for (const n of notes.filter(r => r.top < m.bar.bottom && r.bottom > m.bar.top && r.left >= m.column)) {
                        assert.ok(m.bar.right <= n.left, `${needle}: off the note in the right margin: ${JSON.stringify({ bar: m.bar, note: n })}`);
                    }
                }
            }
            if (hidden.length === cases.length) {
                console.log(`MEP_USER_STYLESHEET ${width}: the sheet hides every left sidebar on screen — no bar to place`);
                this.skip();
            }
        });
    }
});
