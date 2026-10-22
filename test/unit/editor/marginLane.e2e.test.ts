import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { PREVIEW_CARD_CLASS } from '../../../src/editor/webview/toolbar/actions';
import { hostEngine } from './helpers';
import { closeEditorPage, delay, EditorPage, MOD, openEditorPage, settle, shot } from './pageHarness';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, applyTheme } from './themes';
import { NOTE_SAMPLE_ONE_SIDED as ONE_SIDED, NOTE_SAMPLE_TWO_SIDED as TWO_SIDED } from './noteSample';

/** Long enough to scroll, and no note in it: the lane closed until one is made. */
const LONG = TWO_SIDED
    .replace(/\+\+([^|+]*)\|[^+]*\+\+/g, '$1')
    .replace(/!!([^|!]*)\|[^!]*!!/g, '$1')
    .replace('$Status$ ', '')
    .replace(' @Owner: Mia@', '')
    .replace('## Conflicts', [1, 2, 3, 4].map(i => `Background ${i}: the client stores every change in a local journal before it is sent, and the journal survives a restart of the app, a crash and a full battery. Each entry carries the record's identifier, the device's clock and the fields that changed, so that the server can merge entries from several devices without asking the user unless two of them changed the same field.`).join('\n\n') + '\n\n## Conflicts');

/**
 * The margin lane in the Visual Editor's page, with VS Code's `markdown.css`
 * and this extension's note stylesheet loaded as the preview's cascade loads
 * them: notes move into a lane reserved beside the column when the window is
 * wide enough (960px for one side, 1200px for both), run inline below, and the
 * reference and its note pair on hover. The update that opens or closes the
 * lane keeps the line the person is on in its place.
 */
suite('Editor margin lane (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const showDocument = async (text: string, marker: string) => {
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(hostEngine(), text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await delay(80);
    };

    const at = async (width: number) => {
        await page.setViewport({ width, height: 800 });
        await delay(80);
    };

    /** What the stylesheet decided: the lane on `<html>`, how the notes lie, the anchor's line. */
    const layout = () => page.evaluate(() => {
        const html = getComputedStyle(document.documentElement);
        const notes = Array.from(document.querySelectorAll('.ProseMirror :is(.sidenote, .mnote, .left-sidebar, .right-sidebar)'));
        const anchor = getComputedStyle(document.querySelector('.ProseMirror .sn-anchor') as HTMLElement);
        return {
            padding: [html.paddingLeft, html.paddingRight],
            floats: [...new Set(notes.map(n => getComputedStyle(n).float))],
            displays: [...new Set(notes.map(n => getComputedStyle(n).display))],
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            anchor: [anchor.textDecorationLine, anchor.textDecorationStyle],
        };
    });

    const selectText = async (needle: string) => {
        await page.focus('.ProseMirror');
        await page.evaluate(n => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const found = (node.textContent ?? '').indexOf(n);
                if (found >= 0) {
                    (document.getSelection() as Selection).setBaseAndExtent(node, found, node, found + n.length);
                    return;
                }
            }
            throw new Error(`no "${n}" in the document`);
        }, needle);
        await delay(150);
    };

    /** The top of the selection's first line on screen. */
    const selectionTop = () => page.evaluate(() => (document.getSelection() as Selection).getRangeAt(0).getClientRects()[0].top);
    /** The top of the first line of the first sidenote's reference on screen. */
    const anchorTop = () => page.evaluate(() => (document.querySelector('.ProseMirror .sn-anchor') as HTMLElement).getClientRects()[0].top);
    /** The top of the line holding `needle`'s first character on screen. */
    const textTop = (needle: string) => page.evaluate(n => {
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const found = (node.textContent ?? '').indexOf(n);
            if (found >= 0) {
                const range = document.createRange();
                range.setStart(node, found);
                range.setEnd(node, found + 1);
                return range.getBoundingClientRect().top;
            }
        }
        throw new Error(`no "${n}" in the document`);
    }, needle);
    const lanePadding = () => page.evaluate(() => getComputedStyle(document.documentElement).paddingRight);
    const near = (actual: number, expected: number, what: string, within = 1) =>
        assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} instead of ${expected} (±${within}px)`);
    const pressWith = async (modifier: puppeteer.KeyInput, key: puppeteer.KeyInput) => {
        await page.keyboard.down(modifier);
        await page.keyboard.press(key);
        await page.keyboard.up(modifier);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 800, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('a one-sided document: in the margin at 1600 and 1280, the lane reserved, nothing sideways; inline at 900 and 600; the anchor dotted in both', async function () {
        this.timeout(60000);
        await showDocument(ONE_SIDED, 'Offline Sync');
        for (const [name, theme] of [['light', LIGHT_MODERN], ['dark', DARK_MODERN]] as const) {
            await applyTheme(page, theme);
            for (const width of [1600, 1280]) {
                await at(width);
                await page.evaluate(() => window.scrollTo(0, 0));
                assert.deepStrictEqual(await layout(), {
                    padding: ['26px', '250px'], floats: ['right'], displays: ['block'], overflow: 0, anchor: ['underline', 'dotted'],
                }, `${name} at ${width}px`);
                await shot(page, `margin-${name}-${width}.png`);
            }
            for (const width of [900, 600]) {
                await at(width);
                assert.deepStrictEqual(await layout(), {
                    padding: ['26px', '26px'], floats: ['none'], displays: ['inline'], overflow: 0, anchor: ['underline', 'dotted'],
                }, `${name} at ${width}px`);
                await shot(page, `inline-${name}-${width}.png`);
            }
        }
        await applyTheme(page, LIGHT_MODERN);
    });

    test('in High Contrast a note is the page\'s text on the page\'s ground, its bar and underline in the contrast border', async function () {
        this.timeout(30000);
        await showDocument(TWO_SIDED, 'Offline Sync');
        await applyTheme(page, HC_DARK);
        try {
            for (const width of [1280, 900]) {
                await at(width);
                await page.evaluate(() => window.scrollTo(0, 0));
                const look = await page.evaluate(w => {
                    const probe = document.createElement('span');
                    probe.style.color = 'var(--vscode-contrastBorder)';
                    document.body.append(probe);
                    const border = getComputedStyle(probe).color;
                    probe.remove();
                    const note = getComputedStyle(document.querySelector('.ProseMirror .sidenote') as HTMLElement);
                    const anchor = getComputedStyle(document.querySelector('.ProseMirror .sn-anchor') as HTMLElement);
                    return {
                        text: note.color === getComputedStyle(document.body).color,
                        tint: note.backgroundColor,
                        bar: w === 900 ? note.borderLeftColor === border : true,
                        underline: anchor.textDecorationColor === border,
                    };
                }, width);
                assert.deepStrictEqual(look, { text: true, tint: 'rgba(0, 0, 0, 0)', bar: true, underline: true }, `High Contrast at ${width}px`);
                await shot(page, `hc-${width}.png`);
            }
        } finally {
            await applyTheme(page, LIGHT_MODERN);
        }
    });

    test('a two-sided document switches together: inline at 1100, where one side would fit; both lanes from 1200', async function () {
        this.timeout(30000);
        await showDocument(TWO_SIDED, 'Offline Sync');
        await at(1100);
        const narrow = await layout();
        assert.deepStrictEqual([narrow.padding, narrow.floats, narrow.overflow], [['26px', '26px'], ['none'], 0], 'at 1100: every note inline, no lane');
        await shot(page, 'two-sided-1100.png');
        for (const width of [1280, 1600]) {
            await at(width);
            const wide = await layout();
            assert.deepStrictEqual([wide.padding, wide.overflow], [['250px', '250px'], 0], `at ${width}: a lane on each side`);
            assert.deepStrictEqual(wide.floats.sort(), ['left', 'right'], `at ${width}`);
        }
        await at(1280);
        await shot(page, 'two-sided-1280.png');
    });

    test('pointing at a displaced note or at its reference tints both; away, neither', async function () {
        this.timeout(30000);
        await showDocument(ONE_SIDED, 'Offline Sync');
        await at(1280);
        await page.evaluate(() => window.scrollTo(0, 0));
        const backgrounds = () => page.evaluate(() => {
            const note = document.querySelectorAll('.ProseMirror .sidenote')[2] as HTMLElement;
            const anchor = (note.parentElement as HTMLElement).querySelector('.sn-anchor') as HTMLElement;
            return [getComputedStyle(anchor).backgroundColor, getComputedStyle(note).backgroundColor];
        });
        const pointAtNote = (part: 'note' | 'anchor') => page.evaluate(p => {
            const note = document.querySelectorAll('.ProseMirror .sidenote')[2] as HTMLElement;
            const target = p === 'note' ? note : (note.parentElement as HTMLElement).querySelector('.sn-anchor') as HTMLElement;
            target.scrollIntoView({ block: 'center' });
            const r = target.getClientRects()[0];
            return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
        }, part);
        const transparent = 'rgba(0, 0, 0, 0)';
        for (const part of ['note', 'anchor'] as const) {
            const p = await pointAtNote(part);
            await page.mouse.move(p.x, p.y);
            await delay(80);
            const [anchor, note] = await backgrounds();
            assert.notStrictEqual(anchor, transparent, `pointing at the ${part}: the anchor is tinted`);
            assert.notStrictEqual(note, transparent, `pointing at the ${part}: the note is tinted`);
            // The same mix of each one's text colour: the note's is muted, so its tint is lighter, of the same hue.
            const channels = (c: string) => c.replace(/\s*\/\s*[\d.]+\)$/, ')');
            assert.strictEqual(channels(note), channels(anchor), `pointing at the ${part}: one tint (${anchor}, ${note})`);
            if (part === 'note') {
                await shot(page, 'hover-1280.png');
            }
        }
        await page.mouse.move(5, 790);
        await delay(80);
        assert.deepStrictEqual(await backgrounds(), [transparent, transparent], 'pointing away');
    });

    test('the first note opens the lane and the reference line stays in place; undo, redo and a re-sync from the host keep it too', async function () {
        this.timeout(40000);
        await at(1280);
        await showDocument(LONG, 'Offline Sync');
        assert.strictEqual(await lanePadding(), '26px', 'no note: no lane');
        // The paragraph in the middle of the window.
        await page.evaluate(() => {
            const p = Array.from(document.querySelectorAll('.ProseMirror p')).find(x => (x.textContent ?? '').startsWith('When two devices')) as HTMLElement;
            window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 400);
        });
        await delay(80);
        await selectText('asks the user');
        const before = await selectionTop();
        await shot(page, 'lane-open-before.png');

        await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
        await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden])');
        await page.click('.mep-menu[data-menu="annotation"] [data-action="sidenote"]');
        await delay(150);
        assert.strictEqual(await lanePadding(), '250px', 'the first note opened the lane');
        near(await anchorTop(), before, 'the reference line after the lane opened');
        await shot(page, 'lane-open-after.png');

        await page.focus('.ProseMirror');
        await pressWith(MOD, 'z');
        await delay(150);
        assert.strictEqual(await lanePadding(), '26px', 'undo closed the lane');
        near(await textTop('asks the user'), before, 'the line after undo');
        await shot(page, 'lane-closed-after.png');

        await pressWith(MOD, 'y');
        await delay(150);
        assert.strictEqual(await lanePadding(), '250px', 'redo opened it again');
        near(await anchorTop(), before, 'the reference line after redo');

        // Back to no note, the caret in the paragraph, then the host sends a
        // document whose change elsewhere — a paragraph above — holds a note.
        await pressWith(MOD, 'z');
        await delay(150);
        assert.strictEqual(await lanePadding(), '26px');
        await selectText('which one to keep');
        await settle();
        const caretBefore = await selectionTop();
        version++;
        const changed = LONG.replace('Background 2: the client', 'Background 2: the ++client|the phone or tablet++');
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(hostEngine(), changed, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForSelector('.ProseMirror .sidenote');
        await delay(150);
        assert.strictEqual(await lanePadding(), '250px', 'the host\'s note opened the lane');
        near(await selectionTop(), caretBefore, 'the caret line after the re-sync');
    });

    test('the preview card\'s sample note opens no lane', async function () {
        this.timeout(20000);
        await at(1600);
        await showDocument(LONG, 'Offline Sync');
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
        await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden])');
        await page.hover('.mep-menu[data-menu="annotation"] [data-action="sidenote"]');
        await page.waitForSelector(`.${PREVIEW_CARD_CLASS}[data-action="sidenote"]:not([hidden])`, { timeout: 2000 });
        assert.ok(await page.$(`.${PREVIEW_CARD_CLASS} .sidenote`), 'the card shows a sidenote');
        assert.strictEqual(await lanePadding(), '26px', 'and the page reserves nothing for it');
        // The pointer on the entry: its glyph keeps the underline, and takes no pairing tint.
        const glyph = await page.$eval('.mep-menu[data-menu="annotation"] [data-action="sidenote"] .sn-anchor', el => {
            const style = getComputedStyle(el);
            return [style.textDecorationStyle, style.backgroundColor];
        });
        assert.deepStrictEqual(glyph, ['dotted', 'rgba(0, 0, 0, 0)']);
        await page.keyboard.press('Escape');
    });

    test('between the thresholds, after markdown.css\'s own padding: a one-sided document at 1000px reserves its lane', async function () {
        this.timeout(20000);
        await showDocument(ONE_SIDED, 'Offline Sync');
        await at(1000);
        await page.evaluate(() => window.scrollTo(0, 0));
        assert.deepStrictEqual(await layout(), {
            padding: ['26px', '250px'], floats: ['right'], displays: ['block'], overflow: 0, anchor: ['underline', 'dotted'],
        });
        await shot(page, 'margin-light-1000.png');
    });

    test('a lane opened while the caret\'s line is off screen leaves the scrolling to ProseMirror', async function () {
        this.timeout(20000);
        await at(1280);
        const closing = 'A closing paragraph, long enough to take a line of its own and push the end further down. '.repeat(12);
        const longer = [LONG, closing, '', 'The very end.', ''].join('\n');
        await showDocument(longer, 'The very end');
        assert.strictEqual(await lanePadding(), '26px');
        await selectText('The very end');
        await page.evaluate(() => window.scrollTo(0, 0));
        await delay(100);
        const caret = await selectionTop();
        assert.ok(caret > 800, `the caret is below the window: ${caret}, scrolled ${await page.evaluate(() => window.scrollY)}`);
        version++;
        const changed = longer.replace('the user\'s workspace', 'the ++user\'s|the person signed in++ workspace');
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(hostEngine(), changed, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForSelector('.ProseMirror .sidenote');
        await delay(150);
        assert.strictEqual(await lanePadding(), '250px');
        assert.strictEqual(await page.evaluate(() => window.scrollY), 0, 'the page stays where it was');
    });

    test('with a stylesheet\'s own margin (--mep-note-lane: 0) a switch between margin and text keeps the line too', async function () {
        this.timeout(30000);
        await page.addStyleTag({ content: ':root { --mep-note-lane: 0; }' });
        try {
            await at(1100);
            await showDocument(ONE_SIDED, 'Offline Sync');
            assert.strictEqual(await lanePadding(), '26px', 'the stylesheet reserves nothing');
            assert.strictEqual(await page.$eval('.ProseMirror .sidenote', el => getComputedStyle(el).float), 'right', 'one side: in the margin');
            await page.evaluate(() => {
                const p = Array.from(document.querySelectorAll('.ProseMirror p')).find(x => (x.textContent ?? '').startsWith('The last open point')) as HTMLElement;
                window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 400);
            });
            await delay(80);
            await selectText('the batch size');
            const before = await textTop('The last open point');
            await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
            await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden])');
            await page.click('.mep-menu [data-action="left-sidebar"]');
            await delay(150);
            assert.strictEqual(await page.$eval('.ProseMirror .sidenote', el => getComputedStyle(el).float), 'none', 'both sides at 1100: every note in the text');
            // Within a few pixels, not one: the sidebar made in this line, a padded inline run, makes the line itself a little taller.
            near(await textTop('The last open point'), before, 'the line after the notes moved into the text', 4);
        } finally {
            await page.evaluate(() => document.querySelectorAll('style').forEach(s => {
                if (s.textContent === ':root { --mep-note-lane: 0; }') {
                    s.remove();
                }
            }));
        }
    });
});
