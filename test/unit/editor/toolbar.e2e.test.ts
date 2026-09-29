import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { PREVIEW_CARD_CLASS, TOOLBAR_ACTIONS, inRow, menuOf } from '../../../src/editor/webview/toolbar/actions';
import { ALL_LOCK, REQUIREMENT_HEADING_LOCK } from '../../../src/editor/webview/toolbar/commands';
import { ADMONITION_TYPES } from '../../../src/syntax/markers';
import { EXTENSION_ID, EditMessage, EditorPage, openEditorPage, settle } from './pageHarness';

const SOURCE = [
    '## FRS-TST-001: Page {#frs-tst-001-1a2b3c4d}',
    '',
    'Alpha beta gamma.',
    '',
    'Second paragraph here.',
    '',
].join('\n');

/**
 * Wider than the 1280px breakpoint of the notes' margin layout
 * (`styles/markdown-extended.css`), on purpose: the preview card must hold its
 * notes where the page's own notes would float into the margin.
 */
const WIDE = 1400;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The formatting toolbar — its row, menus, preview card — and the selection
 * bubble in the real page bundle, driven in headless Chromium (see
 * `pageHarness.ts`) with this extension's note, admonition and key stylesheets
 * loaded as the preview's cascade would load them. Each test starts from a
 * fresh document the test posts as the host, so none depends on another.
 */
suite('Editor toolbar (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    /** Post `text` parsed, as the host does; the requirement heading shaped as Req Explorer's badge leaves it. */
    const showDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, text, {}));
        const heading = (json.doc.content as { type: string; attrs: Record<string, unknown>; content: { text: string }[] }[])
            .find(n => n.type === 'heading');
        if (heading && heading.content[0].text.startsWith('FRS-TST-001: ')) {
            heading.attrs.reqPrefix = 'FRS-TST-001: ';
            heading.content = [{ ...heading.content[0], text: heading.content[0].text.slice('FRS-TST-001: '.length) }];
        }
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Alpha'));
        await delay(50);
    };

    /** Select `needle` in the document the way the pointer would, and let ProseMirror read it. */
    const selectText = async (needle: string) => {
        await page.focus('.ProseMirror');
        await page.evaluate(n => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf(n);
                if (at >= 0) {
                    (document.getSelection() as Selection).setBaseAndExtent(node, at, node, at + n.length);
                    return;
                }
            }
            throw new Error(`no "${n}" in the document`);
        }, needle);
        await delay(150);
    };

    const rowTool = (id: string) => `.mep-toolbar [data-action="${id}"]`;
    const face = (menu: string) => `.mep-toolbar .mep-menu-face[data-menu="${menu}"]`;
    const panel = (menu: string) => `.mep-menu[data-menu="${menu}"]`;
    const entry = (id: string) => `.mep-menu [data-action="${id}"]`;
    const openMenu = async (menu: string) => {
        await page.click(face(menu));
        await page.waitForSelector(`${panel(menu)}:not([hidden])`);
    };
    const pressWith = async (modifier: puppeteer.KeyInput, key: puppeteer.KeyInput) => {
        await page.keyboard.down(modifier);
        await page.keyboard.press(key);
        await page.keyboard.up(modifier);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: WIDE, styles: ['markdown-extended.css', 'markdown-it-admonition.css', 'markdown-it-kbd.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await showDocument(SOURCE);
        await page.waitForSelector('.mep-toolbar');
    });

    suiteTeardown(async () => {
        await editor?.close();
    });

    teardown(async () => {
        // Leave no menu open for the next test.
        await page.mouse.click(WIDE - 20, 880);
    });

    test('the row is one line: block type, the five marks, three menus, every control the same height', async () => {
        await selectText('Second');
        const row = await page.evaluate(() => {
            const bar = document.querySelector('.mep-toolbar') as HTMLElement;
            const controls = Array.from(bar.querySelectorAll<HTMLElement>('.mep-tool'));
            return {
                groups: Array.from(bar.children).map(g => Array.from(g.children).map(c => (c as HTMLElement).dataset.action ?? `menu:${(c as HTMLElement).dataset.menu}`)),
                heights: [...new Set(controls.map(c => c.offsetHeight))],
                tops: [...new Set(controls.map(c => Math.round(c.getBoundingClientRect().top)))],
                faces: Array.from(bar.querySelectorAll('.mep-menu-face')).map(f => ({ text: f.textContent, samples: f.querySelectorAll('.mep-sample').length })),
                sticky: getComputedStyle(bar).position === 'sticky' && bar.nextElementSibling?.classList.contains('ProseMirror'),
            };
        });
        assert.deepStrictEqual(row.groups, [
            ['menu:block-type'],
            ['italic', 'emphasis', 'bold', 'strong', 'code'],
            ['menu:formatting', 'menu:annotation', 'menu:insert'],
        ]);
        assert.strictEqual(row.heights.length, 1, `one height: ${row.heights.join(', ')}`);
        assert.strictEqual(row.tops.length, 1, 'one line');
        assert.deepStrictEqual(row.faces, [
            { text: 'Paragraph▾', samples: 0 }, { text: 'Formatting▾', samples: 0 }, { text: 'Annotation▾', samples: 0 }, { text: 'Insert▾', samples: 0 },
        ]);
        assert.strictEqual(row.sticky, true);

        const marks = await page.$$eval('.mep-toolbar .mep-mark-tool', tools => tools.map(t => t.querySelector('.mep-sample > *')?.tagName.toLowerCase()));
        assert.deepStrictEqual(marks, ['i', 'em', 'b', 'strong', 'code'], 'a mark\'s glyph is its real element');
    });

    test('narrow, the row scrolls sideways instead of wrapping, and keeps its height', async function () {
        this.timeout(10000);
        try {
            await page.setViewport({ width: 420, height: 900 });
            await delay(100);
            const narrow = await page.evaluate(() => {
                const bar = document.querySelector('.mep-toolbar') as HTMLElement;
                const tops = Array.from(bar.querySelectorAll<HTMLElement>('.mep-tool')).map(c => Math.round(c.offsetTop));
                return { height: bar.offsetHeight, scrolls: bar.scrollWidth > bar.clientWidth, lines: new Set(tops).size };
            });
            assert.deepStrictEqual(narrow, { height: 34, scrolls: true, lines: 1 });
        } finally {
            await page.setViewport({ width: WIDE, height: 900 });
        }
    });

    test('every action is in its place once; menu entries are one height, samples fitted into them', async function () {
        this.timeout(15000);
        const inMenus = await page.$$eval('.mep-menu [data-action]', els => els.map(e => (e as HTMLElement).dataset.action));
        assert.deepStrictEqual([...inMenus].sort(), TOOLBAR_ACTIONS.filter(a => !inRow(a)).map(a => a.id).sort());
        for (const menu of ['block-type', 'formatting', 'annotation', 'insert']) {
            await openMenu(menu);
            const entries = await page.$$eval(`${panel(menu)} .mep-menu-item`, items => items.map(item => {
                const holder = item.querySelector('.mep-entry-sample') as HTMLElement;
                const sample = holder.querySelector('.mep-sample > *') as HTMLElement | null;
                const h = holder.getBoundingClientRect();
                const s = sample?.getBoundingClientRect();
                const block = sample !== null && !getComputedStyle(sample).display.startsWith('inline');
                return {
                    height: (item as HTMLElement).offsetHeight,
                    fits: !block || !s || (s.top >= h.top - 0.5 && s.bottom <= h.bottom + 0.5 && s.right <= h.right + 0.5),
                    syntax: item.querySelector('.mep-entry-syntax')?.textContent ?? '',
                    id: (item as HTMLElement).dataset.action ?? (item as HTMLElement).dataset.submenu,
                };
            }));
            assert.strictEqual(new Set(entries.map(e => e.height)).size, 1, `${menu}: ${JSON.stringify(entries.map(e => e.height))}`);
            for (const e of entries) {
                assert.ok(e.fits, `${menu}/${e.id}: a block sample is scaled into its entry`);
                assert.ok(e.syntax.length > 0, `${menu}/${e.id} names its syntax`);
            }
            await page.keyboard.press('Escape');
            await page.mouse.click(WIDE - 20, 880);
        }
        const expected = TOOLBAR_ACTIONS.filter(a => menuOf(a) === 'formatting').map(a => a.id);
        assert.deepStrictEqual(await page.$$eval(`${panel('formatting')} [data-action]`, els => els.map(e => (e as HTMLElement).dataset.action)), expected);
    });

    test('*i* marks the selection with *, and _em_ on it swaps the delimiter', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('beta');
        await page.click(rowTool('italic'));
        await settle();
        assert.ok((await lastEdit())?.text.includes('Alpha *beta* gamma.'), (await lastEdit())?.text);
        assert.strictEqual(await page.$eval('.ProseMirror p i', el => el.textContent), 'beta');
        assert.strictEqual(await page.$eval(rowTool('italic'), el => el.classList.contains('mep-active')), true);

        await page.click(rowTool('emphasis'));
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('Alpha _beta_ gamma.'), edit?.text);
        assert.strictEqual(await page.$('.ProseMirror p i'), null, 'swapped, not nested');
        assert.strictEqual(await page.$eval('.ProseMirror p em', el => el.textContent), 'beta');
        const active = await page.$$eval('.mep-toolbar .mep-active[data-action]', els => els.map(el => (el as HTMLElement).dataset.action));
        assert.deepStrictEqual(active.filter(id => id === 'italic' || id === 'emphasis'), ['emphasis']);
    });

    test('a row button acts on Enter; a menu opens on ArrowDown, moves with the arrows, acts on Enter, closes on Esc', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('gamma');
        await page.focus(rowTool('bold'));
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('Alpha beta **gamma**.'), (await lastEdit())?.text);

        await selectText('Second');
        await page.focus(face('block-type'));
        await page.keyboard.press('ArrowDown');
        await page.waitForSelector(`${panel('block-type')}:not([hidden])`);
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.action), 'paragraph');
        await page.keyboard.press('Escape');
        assert.strictEqual(await page.$eval(panel('block-type'), el => (el as HTMLElement).hidden), true);
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.menu), 'block-type', 'the focus is back on the face');

        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.action), 'heading-3');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('\n### Second paragraph here.\n'), (await lastEdit())?.text);
    });

    test('the sidenote is made in place: the paragraph stays rich text, and one undo takes it back', async function () {
        this.timeout(15000);
        await showDocument(SOURCE);
        await selectText('beta');
        await openMenu('annotation');
        await page.click(entry('sidenote'));
        assert.strictEqual(await page.$eval(panel('annotation'), el => (el as HTMLElement).hidden), true, 'choosing closes the menu');
        await settle();
        const edit = await lastEdit();
        assert.strictEqual(edit?.text, SOURCE.replace('beta', '++beta|note++'));
        assert.strictEqual(edit?.reparse, undefined, 'nothing for the host to parse: the note is the editor\'s own');
        assert.strictEqual(await page.$('.ProseMirror .mep-raw-block'), null, 'no source block');
        assert.strictEqual(await page.$eval('.ProseMirror p .sn-ref .sidenote', el => el.textContent), 'note');

        await page.focus('.ProseMirror');
        await pressWith('Control', 'z');
        await settle();
        assert.strictEqual((await lastEdit())?.text, SOURCE, 'one undo');
        assert.strictEqual(await page.$('.ProseMirror .sn-ref'), null);
    });

    test('Formatting → Highlight toggles the mark on the selection, and off again', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('beta');
        await openMenu('formatting');
        await page.click(entry('mark'));
        await settle();
        assert.ok((await lastEdit())?.text.includes('Alpha ==beta== gamma.'), (await lastEdit())?.text);
        assert.strictEqual(await page.$eval('.ProseMirror p mark', el => el.textContent), 'beta');
        await selectText('beta');
        await page.click('.mep-bubble [data-action="mark"]');
        await settle();
        assert.ok((await lastEdit())?.text.includes('Alpha beta gamma.'), (await lastEdit())?.text);
    });

    test('the block-type menu turns a paragraph into a heading, and its face names the type as text', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('Second');
        assert.strictEqual(await page.$eval(face('block-type'), el => el.textContent), 'Paragraph▾');
        await openMenu('block-type');
        assert.strictEqual(await page.$eval(entry('paragraph'), el => el.classList.contains('mep-active')), true);
        await page.click(entry('heading-2'));
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('\n## Second paragraph here.\n'), edit?.text);
        const shown = await page.$eval(face('block-type'), el => ({ text: el.textContent, shows: (el as HTMLElement).dataset.shows, samples: el.querySelectorAll('.mep-sample').length }));
        assert.deepStrictEqual(shown, { text: 'Heading 2▾', shows: 'heading-2', samples: 0 });
        assert.strictEqual(await page.$eval(panel('block-type'), el => (el as HTMLElement).hidden), true, 'the menu closed');
    });

    test('on a requirement heading the block-type menu is disabled and says why', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('Page');
        const locked = await page.$eval(face('block-type'), el => ({ disabled: el.getAttribute('aria-disabled'), title: (el as HTMLElement).title, text: el.textContent }));
        assert.strictEqual(locked.disabled, 'true');
        assert.ok(locked.title.includes(REQUIREMENT_HEADING_LOCK), locked.title);
        assert.strictEqual(locked.text, 'Heading 2▾', 'still named while locked');
        await page.click(face('block-type'));
        assert.strictEqual(await page.$eval(panel('block-type'), el => (el as HTMLElement).hidden), true, 'the menu does not open');
        assert.strictEqual(await page.$eval(rowTool('italic'), el => el.getAttribute('aria-disabled')), 'false', 'the title can still be formatted');
    });

    test('Ctrl+A then Horizontal rule puts the rule last, never first, and the face names why it is locked', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('beta');
        await pressWith('Control', 'a');
        await delay(100);
        const locked = await page.$eval(face('block-type'), el => ({ disabled: el.getAttribute('aria-disabled'), title: (el as HTMLElement).title }));
        assert.strictEqual(locked.disabled, 'true');
        assert.ok(locked.title.includes(ALL_LOCK), locked.title);

        await openMenu('insert');
        await page.click(entry('horizontal-rule'));
        await settle();
        assert.strictEqual((await lastEdit())?.text, `${SOURCE}\n---\n`, 'the document starts as before, and the rule is its last block');
    });

    test('one Ctrl+B removes __strong__, and one Ctrl+I removes _em_', async function () {
        this.timeout(10000);
        await showDocument(SOURCE.replace('Alpha beta gamma.', 'Alpha __beta__ _gamma_.'));
        await selectText('beta');
        await pressWith('Control', 'b');
        await selectText('gamma');
        await pressWith('Control', 'i');
        await settle();
        assert.ok((await lastEdit())?.text.includes('\nAlpha beta gamma.\n'), (await lastEdit())?.text);
    });

    test('the bubble holds the ten marks and the two notes, appears above a selection where that covers no text and below where it would, and hides when it collapses or loses the focus', async function () {
        this.timeout(10000);
        const placement = () => page.evaluate(() => {
            const bubble = document.querySelector('.mep-bubble') as HTMLElement;
            const range = (document.getSelection() as Selection).getRangeAt(0).getBoundingClientRect();
            const box = bubble.getBoundingClientRect();
            // The text of the block before the selection's, which the bubble must leave readable.
            const block = (document.getSelection() as Selection).anchorNode?.parentElement?.closest('.ProseMirror > *');
            const before = block?.previousElementSibling;
            const lineRange = document.createRange();
            if (before) {
                lineRange.selectNodeContents(before);
            }
            const covers = before ? Array.from(lineRange.getClientRects()).some(r => r.width > 0 && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top) : false;
            return {
                hidden: bubble.hidden,
                above: box.bottom <= range.top + 1,
                below: box.top >= range.bottom - 1,
                overlapsHorizontally: box.left < range.right && box.right > range.left,
                coversTheLineAbove: covers,
                tools: Array.from(bubble.querySelectorAll('[data-action]')).map(t => (t as HTMLElement).dataset.action),
            };
        });
        const tools = ['italic', 'emphasis', 'bold', 'strong', 'code', 'mark', 'superscript', 'subscript', 'strikethrough', 'kbd', 'sidenote', 'marginal-note'];
        // Right under a line whose text the bubble would cover: below.
        const shown = (marker: string) => page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await showDocument('A first paragraph whose one line runs on, well across where the word below it stands.\n\nAlpha beta gamma.\n');
        await shown('well across');
        await selectText('gamma');
        const underText = await placement();
        assert.deepStrictEqual(underText, { hidden: false, above: false, below: true, overlapsHorizontally: true, coversTheLineAbove: false, tools });
        // Under a short line that ends before it: above, where the bubble has always been.
        // (The bubble is wide, and centred on the word: the word stands far enough along that "Short." ends before it.)
        await showDocument('Short.\n\nAlpha, a longer paragraph whose one line runs on and on, far along, until the word gamma.\n');
        await shown('far along');
        await selectText('gamma');
        const underShort = await placement();
        assert.deepStrictEqual(underShort, { hidden: false, above: true, below: false, overlapsHorizontally: true, coversTheLineAbove: false, tools });
        await showDocument(SOURCE);
        await selectText('gamma');

        await page.evaluate(() => (document.getSelection() as Selection).collapseToStart());
        await delay(150);
        assert.strictEqual(await page.$eval('.mep-bubble', el => (el as HTMLElement).hidden), true, 'a collapsed selection has no bubble');

        await selectText('gamma');
        assert.strictEqual(await page.$eval('.mep-bubble', el => (el as HTMLElement).hidden), false);
        await page.evaluate(() => (document.activeElement as HTMLElement).blur());
        await delay(50);
        assert.strictEqual(await page.$eval('.mep-bubble', el => (el as HTMLElement).hidden), true, 'nor does an editor without the focus');
    });

    test('Insert → Admonition lists exactly the plugin\'s types; one is inserted in place, and typed text is its indented body', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        const listed = await page.$$eval(`${panel('admonition')} [data-action]`, els => els.map(el => (el as HTMLElement).dataset.action));
        assert.deepStrictEqual(listed, ADMONITION_TYPES.map(t => `admonition-${t}`));

        await selectText('beta');
        await openMenu('insert');
        await page.hover('.mep-menu [data-submenu="admonition"]');
        await page.waitForSelector(`${panel('admonition')}:not([hidden])`);
        await page.click(entry('admonition-warning'));
        await page.waitForSelector('.ProseMirror div.admonition.warning');
        assert.strictEqual(await page.$('.mep-raw-editor'), null, 'no source box: the admonition is rich text');
        const drawn = await page.$eval('.ProseMirror div.admonition.warning', el => ({
            first: el.firstElementChild?.className,
            title: el.querySelector(':scope > .admonition-title')?.textContent,
        }));
        assert.deepStrictEqual(drawn, { first: 'admonition-title', title: 'Warning' }, 'the title bar is the first child, as the plugin renders it');
        await page.keyboard.type('Mind the step.');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('Alpha beta gamma.\n\n!!! warning "Warning"\n    Mind the step.\n\nSecond paragraph here.'), edit?.text);
        assert.strictEqual(edit?.reparse, undefined, 'native: the host is not asked to parse it');
    });

    test('Formatting → Span with class asks for the literal in the inline field and makes the selection a span with that class', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await selectText('beta');
        await openMenu('formatting');
        await page.click(entry('span-class'));
        const field = '.mep-object-toolbar[data-trigger="toolbar"] .mep-inline-field';
        await page.waitForSelector(field, { visible: true });
        const opened = await page.$eval(field, el => {
            const input = el as HTMLInputElement;
            return { value: input.value, caret: [input.selectionStart, input.selectionEnd], focused: document.activeElement === input };
        });
        assert.deepStrictEqual(opened, { value: '{.}', caret: [2, 2], focused: true }, 'prefilled, the caret after the dot');
        await page.keyboard.type('klasse');
        await page.keyboard.press('Enter');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('Alpha [beta]{.klasse} gamma.'), edit?.text);
        assert.strictEqual(await page.$eval('.ProseMirror span.klasse', el => el.textContent), 'beta', 'the rendered span carries the class');
        assert.strictEqual(await page.$(field), null, 'the field is gone');
    });

    test('the preview card shows after a pause, on hover and on focus, beside the menu', async function () {
        this.timeout(10000);
        await showDocument(SOURCE);
        await openMenu('formatting');
        await page.hover(entry('mark'));
        await delay(100);
        assert.strictEqual(await page.$eval(`.${PREVIEW_CARD_CLASS}`, el => (el as HTMLElement).hidden), true, 'not at once');
        await page.waitForSelector(`.${PREVIEW_CARD_CLASS}[data-action="mark"]:not([hidden])`, { timeout: 2000 });
        const card = await page.evaluate(cls => {
            const c = document.querySelector(`.${cls}`) as HTMLElement;
            const m = document.querySelector('.mep-menu[data-menu="formatting"]') as HTMLElement;
            return {
                besideMenu: c.getBoundingClientRect().left >= m.getBoundingClientRect().right,
                mark: c.querySelector('.mep-preview-body mark')?.textContent,
                syntax: c.querySelector('.mep-preview-syntax')?.textContent,
            };
        }, PREVIEW_CARD_CLASS);
        assert.deepStrictEqual(card, { besideMenu: true, mark: 'the point', syntax: 'Highlight ==the point== of a sentence.' });

        // The pointer out of the way, so the menu opening under it hovers nothing.
        await page.mouse.click(WIDE - 20, 880);
        await page.focus(face('insert'));
        await page.keyboard.press('ArrowDown');
        // The first entry the selection allows: Link… and Image… need a caret in text.
        const first = await page.$eval('.mep-menu[data-menu="insert"]', menu =>
            (menu.querySelector('[data-action]:not([aria-disabled="true"])') as HTMLElement).dataset.action);
        await page.waitForSelector(`.${PREVIEW_CARD_CLASS}[data-action="${first}"]:not([hidden])`, { timeout: 2000 });
    });

    test(`at ${WIDE}px, wider than the notes' breakpoint, every Annotation preview stays inside its card`, async function () {
        this.timeout(20000);
        assert.strictEqual(page.viewport()?.width, WIDE);
        // The page is in the margin layout: a note outside the card floats.
        const outside = await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.className = 'sidenote';
            document.body.append(probe);
            const float = getComputedStyle(probe).float;
            probe.remove();
            return float;
        });
        assert.strictEqual(outside, 'right', 'outside the card a note would float into the margin');

        await showDocument(SOURCE);
        await openMenu('annotation');
        const ids = TOOLBAR_ACTIONS.filter(a => menuOf(a) === 'annotation').map(a => a.id);
        for (const id of ids) {
            await page.hover(entry(id));
            await page.waitForSelector(`.${PREVIEW_CARD_CLASS}[data-action="${id}"]:not([hidden])`, { timeout: 2000 });
            const boxes = await page.evaluate(cls => {
                const card = (document.querySelector(`.${cls}`) as HTMLElement).getBoundingClientRect();
                return Array.from(document.querySelectorAll(`.${cls} *`)).map(node => {
                    const r = node.getBoundingClientRect();
                    const w = Math.min(r.right, card.right) - Math.max(r.left, card.left);
                    const h = Math.min(r.bottom, card.bottom) - Math.max(r.top, card.top);
                    return {
                        what: `${node.tagName.toLowerCase()}.${(node as HTMLElement).className}`,
                        inside: r.left >= card.left - 0.5 && r.right <= card.right + 0.5 && r.top >= card.top - 0.5 && r.bottom <= card.bottom + 0.5,
                        visible: w > 0 && h > 0,
                        float: getComputedStyle(node).float,
                    };
                });
            }, PREVIEW_CARD_CLASS);
            assert.ok(boxes.length > 2, `${id}: the card shows the construct`);
            for (const b of boxes) {
                assert.ok(b.inside, `${id}: ${b.what} lies inside the card`);
                assert.ok(b.visible, `${id}: ${b.what} is visible in the card, not clipped away`);
                assert.strictEqual(b.float, 'none', `${id}: ${b.what} renders stacked in the card`);
            }
        }
    });
});
