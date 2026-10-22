import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { refusalMs } from '../../../src/editor/refusal';
import { EditorPage, EXTENSION_ID, closeEditorPage, clickText, delay, editCommand, openEditorPage, pointAt, shot, MOD, UNDO } from './pageHarness';
import { MOD_NAME } from './rowLock';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, applyTheme } from './themes';

/** One document holding every place a refusal is made in: a table with code in its cells, a one-row table, a list, a source block, bold text. */
export const REFUSALS_DOC = [
    '# Refusals',
    '',
    'First paragraph with **bold** words.',
    '',
    '| Name | Code |',
    '| ---- | ---- |',
    '| one | `ab` |',
    '| two | `cd` |',
    '| three | `ef` |',
    '',
    'Between the tables.',
    '',
    '| Only | Row |',
    '| ---- | --- |',
    '| x | y |',
    '',
    '- item one',
    '- item two',
    '',
    '<div>raw block</div>',
    '',
    'Glad to see you :) here.',
    '',
    'Last paragraph.',
    '',
].join('\n');

/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const MENU = `${BAR} .mep-object-menu`;

/**
 * The one refusal component (#10) in the real page: where a refusal stands,
 * what ends it — the next caret move, a press, focus elsewhere, a mode change,
 * a document from the host — how long it stays otherwise, that a repeat is
 * said again, and that the other hints keep their own rules.
 */
suite('Editor refusals: one component, one dismiss rule (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    /** Post `text` parsed, as the host does; `fresh` hides what the last test left (the host's document ends a refusal anyway). */
    const showDocument = async (text = REFUSALS_DOC, marker = 'Refusals') => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await delay(100);
    };

    const fresh = async (text = REFUSALS_DOC, marker = 'Refusals') => {
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            // A menu the last test left open is closed as Esc in it closes it.
            for (const menu of Array.from(document.querySelectorAll('.mep-menu:not([hidden])'))) {
                menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
        });
        await showDocument(text, marker);
        await page.evaluate(() => {
            const hint = document.querySelector('.mep-hint') as HTMLElement | null;
            if (hint) {
                hint.hidden = true;
            }
        });
        await delay(200);
    };

    /** The page as it stands, saved as `<name>-<width>.png` in `MEP_SHOTS_DIR` (none without it). */
    const shotAs = async (name: string) => shot(page, `${name}-${page.viewport()?.width ?? 0}.png`);

    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent ?? '', shown: !(el as HTMLElement).hidden, tone: (el as HTMLElement).dataset.tone, at: (el as HTMLElement).dataset.at }));
    const shown = async () => (await hint()).shown;

    /** A `|` typed into the inline code `ab` in a table cell: refused (C3), the hint at the caret. */
    const refuseInCell = async (needle = 'ab') => {
        // Two presses at one spot within 500 ms are a double click to ProseMirror, not a click that focuses the text.
        await delay(500);
        await clickText(page, needle, 1);
        await page.keyboard.type('|');
        await page.waitForSelector('.mep-hint:not([hidden])', { timeout: 2000 });
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

    test('D1: a refusal goes at a click elsewhere, an arrow key, focus into the row, a source box opening and a document from the host', async function () {
        this.timeout(30000);
        await fresh();
        // (a) A click into another paragraph.
        await refuseInCell();
        await clickText(page, 'Last paragraph', 2);
        await delay(100);
        assert.strictEqual(await shown(), false, 'gone at the click');
        // (b) ArrowRight.
        await refuseInCell();
        await page.keyboard.press('ArrowRight');
        await delay(100);
        assert.strictEqual(await shown(), false, 'gone at the arrow key');
        // (c) Focus into the row.
        await refuseInCell();
        await page.focus('.mep-toolbar [data-action="bold"]');
        await delay(100);
        assert.strictEqual(await shown(), false, 'gone with the focus in the row');
        // (d) The source box opened by a double click.
        await refuseInCell();
        const raw = await pointAt(page, 'raw block', 1);
        await page.mouse.click(raw.x, raw.y, { clickCount: 2 });
        await page.waitForSelector('.mep-raw-editor', { timeout: 2000 });
        assert.strictEqual(await shown(), false, 'gone with the source box opened');
        await page.keyboard.press('Escape');
        await delay(100);
        // (e) The host's document.
        await refuseInCell();
        await showDocument();
        assert.strictEqual(await shown(), false, 'gone with the document the host sent');
    });

    test('D11: the refused keystroke itself does not end its refusal', async function () {
        this.timeout(15000);
        await fresh();
        await refuseInCell();
        await delay(300);
        assert.strictEqual(await shown(), true, 'still there after the arming frame');
        assert.strictEqual((await hint()).tone, 'refusal');
    });

    test('D2: the same refusal again restarts its time and is said again; a repeat within a second is not said twice', async function () {
        this.timeout(30000);
        await fresh();
        await page.evaluate(() => {
            const live = document.querySelector('.mep-live');
            const w = window as unknown as { said: string[] };
            w.said = [];
            if (live) {
                new MutationObserver(() => {
                    if (live.textContent) {
                        w.said.push(live.textContent);
                    }
                }).observe(live, { childList: true, characterData: true, subtree: true });
            }
        });
        const said = () => page.evaluate(() => (window as unknown as { said: string[] }).said.slice());
        await refuseInCell();
        const text = (await hint()).text;
        const ms = refusalMs(text);
        await delay(2000);
        await page.keyboard.type('|');
        await delay(ms - 1000);
        assert.strictEqual(await shown(), true, `visible ${ms - 1000} ms after the second (its time restarted)`);
        assert.deepStrictEqual(await said(), [text, text], 'said twice, two seconds apart');
        await fresh();
        await page.evaluate(() => {
            (window as unknown as { said: string[] }).said = [];
        });
        await refuseInCell('cd');
        await delay(300);
        await page.keyboard.type('|');
        await delay(200);
        assert.strictEqual((await said()).length, 1, 'two refusals 300 ms apart at one place: said once');
    });

    test('D9: a refusal stays its time (2 s + 50 ms a character); a neutral hint three seconds', async function () {
        this.timeout(30000);
        await fresh();
        await refuseInCell();
        const ms = refusalMs((await hint()).text);
        await delay(ms - 400);
        assert.strictEqual(await shown(), true, `still there at ${ms - 400} ms`);
        await delay(800);
        assert.strictEqual(await shown(), false, `gone at ${ms + 400} ms`);
        // A neutral hint: the table's "Row deleted".
        await clickText(page, 'two', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        await chooseEntry('row', 'delete-row');
        assert.strictEqual((await hint()).text, `Row deleted — ${UNDO}`);
        await delay(3300);
        assert.strictEqual(await shown(), false, 'a neutral hint gone at 3.3 s');
    });

    test('D12: the other hints keep their rules — a change hint survives a click and goes at the next change; a paragraph hint stays in its paragraph', async function () {
        this.timeout(30000);
        await fresh();
        await clickText(page, 'two', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        await chooseEntry('row', 'delete-row');
        assert.strictEqual((await hint()).text, `Row deleted — ${UNDO}`);
        await clickText(page, 'Last paragraph', 3);
        await delay(100);
        assert.strictEqual(await shown(), true, 'a change hint survives a click');
        await page.keyboard.type('x');
        await delay(100);
        assert.strictEqual(await shown(), false, 'and goes at the next change');
        // The paragraph hint: an emoji made text by a letter typed after it.
        const p = await pointAt(page, ' here', 0);
        await page.mouse.click(p.x, p.y);
        await delay(150);
        await page.keyboard.type('Z');
        await delay(100);
        assert.strictEqual((await hint()).text, `:)Z is no longer an emoji — ${UNDO}`);
        await clickText(page, 'Glad', 1);
        await delay(100);
        assert.strictEqual(await shown(), true, 'a click in the same paragraph keeps it');
    });

    test('A1: the drawn hint is hidden from the reader, one status region in the mount says it once', async function () {
        this.timeout(15000);
        await fresh();
        await refuseInCell();
        await delay(100);
        const aria = await page.evaluate(() => {
            const mount = (document.querySelector('.ProseMirror') as HTMLElement).parentElement as HTMLElement;
            return {
                hidden: document.querySelector('.mep-hint')?.getAttribute('aria-hidden'),
                regions: mount.querySelectorAll('[role="status"]').length,
                live: document.querySelector('.mep-live')?.textContent,
                text: document.querySelector('.mep-hint')?.textContent,
            };
        });
        assert.deepStrictEqual(aria, { hidden: 'true', regions: 1, live: aria.text, text: aria.text });
    });

    test('A2: the refusal\'s bar stands at 3:1 or more against the hint in Light Modern, Dark Modern and HC Dark', async function () {
        this.timeout(20000);
        await fresh();
        for (const theme of [LIGHT_MODERN, DARK_MODERN, HC_DARK]) {
            await applyTheme(page, theme);
            await refuseInCell();
            const [bar, back] = await page.$eval('.mep-hint', el => [getComputedStyle(el).borderLeftColor, getComputedStyle(el).backgroundColor]);
            const ratio = contrastOf(bar, back);
            assert.ok(ratio >= 3, `${theme.name}: ${ratio.toFixed(2)}:1 (${bar} on ${back})`);
            await page.keyboard.press('ArrowRight');
        }
        await applyTheme(page, LIGHT_MODERN);
    });

    test('C24: a container title ending in {…} is refused in its Classes field, which stays open with what was typed', async function () {
        this.timeout(20000);
        await fresh('Intro.\n\n::: box\nFirst kept.\n:::\n\nAfter.\n', 'First');
        const before = (await (editor as EditorPage).edits()).length;
        await clickText(page, 'First kept', 2);
        await page.waitForSelector(BAR, { timeout: 2000 });
        await page.click(`${BAR} [data-verb="edit-classes"]`);
        const input = await page.waitForSelector(`${BAR} .mep-inline-field`, { visible: true, timeout: 2000 });
        assert.ok(input);
        await page.keyboard.down(MOD);
        await page.keyboard.press('a', editCommand('a'));
        await page.keyboard.up(MOD);
        await page.keyboard.type('box {.x}');
        await page.keyboard.press('Enter');
        await delay(150);
        const field = await page.evaluate(sel => {
            const el = document.querySelector(`${sel} .mep-inline-field`) as HTMLInputElement | null;
            return {
                value: el?.value ?? null,
                focused: document.activeElement === el,
                invalid: el?.getAttribute('aria-invalid') ?? null,
                reason: document.querySelector(`${sel} .mep-field-refusal-text`)?.textContent ?? null,
                codes: Array.from(document.querySelectorAll(`${sel} .mep-field-refusal-text code`)).map(c => c.textContent),
            };
        }, BAR);
        assert.deepStrictEqual(field, {
            value: 'box {.x}', focused: true, invalid: 'true',
            reason: 'Not set: a container\'s title can\'t end in {…} — it would be read as attributes. Remove the {…} at its end.',
            codes: ['{…}', '{…}'],
        });
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'nothing written');
        await page.keyboard.press('Escape');
    });

    /** The hint's box and its placement, and the boxes of `controls` (selectors), in the window's coordinates. */
    const placed = (...controls: string[]) => page.evaluate(sels => {
        const box = (el: Element | null) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        const hint = document.querySelector('.mep-hint') as HTMLElement;
        return {
            hint: box(hint),
            at: hint.dataset.at,
            shown: !hint.hidden,
            text: hint.textContent ?? '',
            controls: sels.map(s => box(document.querySelector(s))),
        };
    }, controls);

    const BOLD = '.mep-toolbar [data-action="bold"]';
    const ITALIC = '.mep-toolbar [data-action="italic"]';
    const ROW = '.mep-toolbar';
    /** A document with properties, for the property field's and the panel button's locks. */
    const PROPS_DOC = '---\ntitle: Demo\nstream: UXD\n---\n\nSome words here to select.\n\nLast paragraph.\n';

    test('D4: a press on a locked tool says why under it — the source box\'s key — the note at the row\'s end still flashes, the tool keeps aria-disabled', async function () {
        this.timeout(20000);
        await fresh();
        const raw = await pointAt(page, 'raw block', 1);
        await page.mouse.click(raw.x, raw.y, { clickCount: 2 });
        await page.waitForSelector('.mep-raw-editor', { timeout: 2000 });
        await delay(100);
        const bold = await page.$eval(BOLD, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await page.mouse.click(bold.x, bold.y);
        await delay(80);
        const p = await placed(BOLD, ROW);
        assert.strictEqual(p.shown, true, 'a hint at the pressed tool');
        assert.strictEqual(p.at, 'control');
        assert.strictEqual(p.text, `Formatting is off while editing source — ${MOD_NAME}+Enter applies`);
        assert.ok(Math.abs(p.hint.left - p.controls[0].left) <= 2, `at Bold's left: ${p.hint.left} vs ${p.controls[0].left}`);
        assert.ok(Math.abs(p.hint.top - (p.controls[1].bottom + 4)) <= 1, `under the row: ${p.hint.top} vs ${p.controls[1].bottom + 4}`);
        assert.strictEqual(await page.$eval(`${ROW} .mep-row-lock`, el => el.classList.contains('mep-row-lock-flash')), true, 'the note at the row\'s end flashes');
        assert.deepStrictEqual(await page.$eval(BOLD, el => [el.getAttribute('aria-disabled'), el.hasAttribute('disabled')]), ['true', false]);
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement).className), 'mep-raw-editor', 'the box keeps the focus');
        await shotAs('s3-source-lock');
        // D10: the hint never takes the pointer — a press on what it covers reaches that.
        const covered = await page.evaluate(sel => {
            const hint = (document.querySelector('.mep-hint') as HTMLElement).getBoundingClientRect();
            const el = document.elementFromPoint(hint.left + 4, hint.top + 4);
            return el?.closest('.mep-hint') === null;
        }, ITALIC);
        assert.strictEqual(covered, true, 'pointer-events: none');
        await page.keyboard.press('Escape');
        await delay(100);
    });

    test('D4b/D4c: a property\'s field says Enter applies; a panel button says Esc or click into the text — at 520 at "…"', async function () {
        this.timeout(30000);
        await fresh(PROPS_DOC, 'Some words');
        await page.click('.mep-properties .mep-props-toggle');
        await page.waitForSelector('.mep-prop-row', { visible: true });
        await page.click('.mep-prop-row[data-key="stream"] input');
        await delay(120);
        await page.click(BOLD);
        await delay(80);
        assert.strictEqual((await hint()).text, 'Formatting is off while editing a property — Enter applies');
        assert.strictEqual((await hint()).at, 'control');
        await page.keyboard.press('Escape');
        await delay(120);
        await page.focus('.mep-properties .mep-props-toggle');
        await delay(120);
        await page.click(BOLD);
        await delay(80);
        assert.deepStrictEqual([(await hint()).text, (await hint()).at], ['Formatting is off while the focus is outside the text — press Esc or click into the text', 'control']);
        await shotAs('s4-quiet-lock');
        await page.setViewport({ width: 520, height: 800 });
        await delay(300);
        await page.focus('.mep-properties .mep-props-toggle');
        await delay(120);
        const more = `${ROW} .mep-more-face`;
        assert.strictEqual(await page.$eval(more, el => el.getAttribute('aria-disabled')), 'true', 'the refused tools gave way into a disabled "…"');
        await page.click(more);
        await delay(80);
        const p = await placed(more, ROW);
        assert.deepStrictEqual([p.shown, p.at, p.text], [true, 'control', 'Formatting is off while the focus is outside the text — press Esc or click into the text']);
        assert.ok(p.hint.left >= 0 && p.hint.right <= 520, `inside the window: ${JSON.stringify(p.hint)}`);
        await shotAs('s4-quiet-lock-520');
        await page.setViewport({ width: 1280, height: 800 });
        await delay(300);
    });

    test('D4d: a state lock — the gap cursor — said at the Block type face', async function () {
        this.timeout(20000);
        await fresh('| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter the table.\n', 'After');
        await clickText(page, 'a', 0);
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowLeft');
        await delay(120);
        assert.ok(await page.$('.ProseMirror-gapcursor'), 'a gap cursor before the table');
        // The face opens — its Attributes of … entry keeps Formatting's state — and its types are refused with the gap's reason.
        const face = `${ROW} .mep-menu-face[data-menu="block-type"]`;
        await page.click(face);
        const menu = '.mep-menu[data-menu="block-type"]';
        await page.waitForSelector(`${menu}:not([hidden])`);
        const entry = `${menu} [data-action="heading-2"]`;
        assert.strictEqual(await page.$eval(entry, el => el.getAttribute('aria-disabled')), 'true');
        await page.click(entry);
        await delay(80);
        const p = await placed(entry, menu);
        assert.deepStrictEqual([p.shown, p.at, p.text], [true, 'menu-entry', 'No block here to change — Insert adds one at this spot.']);
        assert.ok(Math.abs(p.hint.top - p.controls[0].top) <= 1);
        await shotAs('s11-gap-lock');
        await page.click(face);
    });

    test('D4e: a refused Block type entry (a table cell) says why beside the menu, at the entry; the card is put away', async function () {
        this.timeout(20000);
        await fresh();
        await clickText(page, 'one', 1);
        const face = `${ROW} .mep-menu-face[data-menu="block-type"]`;
        await page.click(face);
        const menu = '.mep-menu[data-menu="block-type"]';
        await page.waitForSelector(`${menu}:not([hidden])`);
        const entry = `${menu} [data-action="heading-2"]`;
        await page.hover(entry);
        await delay(400);
        await page.click(entry);
        await delay(80);
        const p = await placed(entry, menu);
        assert.deepStrictEqual([p.shown, p.at, p.text], [true, 'menu-entry', 'A table cell has no block type — the table\'s bar adds rows and columns.']);
        assert.ok(Math.abs(p.hint.top - p.controls[0].top) <= 1, `at the entry's top: ${p.hint.top} vs ${p.controls[0].top}`);
        assert.ok(Math.abs(p.hint.left - (p.controls[1].right + 4)) <= 1 || Math.abs(p.hint.right - (p.controls[1].left - 4)) <= 1, `beside the menu: ${JSON.stringify(p)}`);
        assert.strictEqual(await page.$eval('.mep-preview-card', el => (el as HTMLElement).hidden), true, 'the card put away');
        assert.strictEqual(await page.$eval(menu, el => (el as HTMLElement).hidden), false, 'the menu stays open');
        await shotAs('s8-blocktype-entry');
        // A press on the face closes the menu; the hint goes with the press.
        await page.click(face);
        await delay(80);
        assert.deepStrictEqual([await page.$eval(menu, el => (el as HTMLElement).hidden), await shown()], [true, false], 'the menu closed, the hint gone with it');
    });

    test('D5/D6: a refused entry of a table bar\'s menu says why beside the menu, at the entry; the menu stays open', async function () {
        this.timeout(20000);
        await fresh('| Only | Row |\n| ---- | --- |\n\nAfter the table.\n', 'After');
        await clickText(page, 'Only', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        await chooseEntry('row', 'delete-row');
        const entry = `${MENU} [data-entry="delete-row"]`;
        assert.strictEqual(await page.$eval(entry, el => el.getAttribute('aria-disabled')), 'true');
        let p = await placed(entry, MENU);
        assert.deepStrictEqual([p.shown, p.at, p.text], [true, 'menu-entry', 'A table needs at least one row — Delete table deletes the whole table.']);
        assert.ok(Math.abs(p.hint.top - p.controls[0].top) <= 1, `at the entry's top: ${JSON.stringify(p)}`);
        assert.ok(p.hint.left >= p.controls[1].right + 3 || p.hint.right <= p.controls[1].left - 3, `beside the menu, not over it: ${JSON.stringify(p)}`);
        assert.ok(await page.$(MENU), 'the menu stays open');
        await shotAs('s7-bar-entry');
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await shown(), false, 'gone with the menu');

        await fresh('| Only |\n| ---- |\n| x |\n\nAfter the table.\n', 'After');
        await clickText(page, 'x', 0);
        await page.waitForSelector(BAR, { timeout: 2000 });
        await chooseEntry('column', 'delete-column');
        p = await placed(`${MENU} [data-entry="delete-column"]`, MENU);
        assert.deepStrictEqual([p.shown, p.at, p.text], [true, 'menu-entry', 'A table needs at least one column — Delete table deletes the whole table.']);
        await page.keyboard.press('Escape');
    });

    test('D5b: a refused bar verb says why under the bar at the verb; moved into the bar\'s "…", at its entry', async function () {
        this.timeout(30000);
        await fresh('Alpha ++beta|the body++@y@ gamma.\n', 'Alpha');
        await clickText(page, 'body', 1);
        await page.waitForSelector(BAR, { timeout: 2000 });
        const verb = `${BAR} [data-verb="delete-note"]`;
        assert.deepStrictEqual(await page.$eval(verb, el => [el.getAttribute('aria-disabled'), el.hasAttribute('disabled')]), ['true', false]);
        const reason = (await page.$eval(verb, el => el.getAttribute('aria-description') ?? '')).split('\n').pop() ?? '';
        const edits = (await (editor as EditorPage).edits()).length;
        await page.click(verb);
        await delay(80);
        const p = await placed(verb, BAR);
        assert.deepStrictEqual([p.shown, p.at, p.text], [true, 'control', reason]);
        assert.ok(Math.abs(p.hint.left - p.controls[0].left) <= 2, `at the verb: ${JSON.stringify(p)}`);
        assert.ok(p.hint.top >= p.controls[1].bottom + 3 || p.hint.bottom <= p.controls[0].top - 3, `under the bar (or above the verb at the floor): ${JSON.stringify(p)}`);
        assert.strictEqual((await (editor as EditorPage).edits()).length, edits, 'nothing posted');
        await shotAs('s6-bar-verb');
        // The narrowest of these widths moves Delete note — Delete/Remove moves first — into the bar's "…".
        const more = `${BAR} .mep-object-more`;
        let width = 0;
        for (const w of [520, 420, 360, 300, 260]) {
            width = w;
            await page.setViewport({ width: w, height: 800 });
            await delay(300);
            // The caret out of the note and back: the bar comes at the rest in it, laid out for the width.
            await clickText(page, 'Alpha', 1);
            await delay(500);
            await clickText(page, 'body', 2);
            await page.waitForSelector(BAR, { timeout: 2000 });
            if (await page.$(`${verb}:not([hidden])`) === null) {
                break;
            }
        }
        if (await page.$(`${more}:not([hidden])`) !== null && await page.$(`${verb}:not([hidden])`) === null) {
            await page.click(more);
            await page.waitForSelector(MENU, { visible: true, timeout: 2000 });
            const entry = `${MENU} [data-entry="delete-note"]`;
            await page.click(entry);
            await delay(80);
            const q = await placed(entry, MENU);
            assert.deepStrictEqual([q.shown, q.at, q.text], [true, 'menu-entry', reason]);
            assert.ok(q.hint.bottom <= 800 && q.hint.right <= width, `inside the window: ${JSON.stringify(q)}`);
            await shotAs('s6-bar-entry');
        } else {
            assert.fail(`Delete note moves into the bar's "…" by ${width} px`);
        }
        await page.setViewport({ width: 1280, height: 800 });
        await delay(300);
    });

    /** Open the bar's `verb` menu and press `entry` with the mouse. */
    async function chooseEntry(verb: string, entry: string): Promise<void> {
        const button = await page.waitForSelector(`${BAR} [data-verb="${verb}"]`, { visible: true, timeout: 2000 });
        const box = await button?.boundingBox();
        assert.ok(box, `no box for ${verb}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(MENU, { visible: true, timeout: 2000 });
        const item = await page.$(`${MENU} [data-entry="${entry}"]`);
        const itemBox = await item?.boundingBox();
        assert.ok(itemBox, `no entry ${entry}`);
        await page.mouse.click(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
        await delay(80);
    }
});

/** WCAG's contrast ratio of two computed colours (`rgb(…)`, `rgba(…)`, or `color(srgb …)` as `color-mix` computes). */
export function contrastOf(a: string, b: string): number {
    const rgb = (c: string): number[] => {
        const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(c);
        if (srgb) {
            return srgb.slice(1, 4).map(x => Number(x) * 255);
        }
        const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(c);
        assert.ok(m, `not a colour: ${c}`);
        return m.slice(1, 4).map(Number);
    };
    const lum = (c: number[]) => {
        const [r, g, bl] = c.map(x => {
            const s = x / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
