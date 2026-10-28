import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { closeEditorPage, computedColour, delay, editCommand, EditorPage, EXTENSION_ID, MOD, openEditorPage, pointAt, settle, shot, UNDO } from './pageHarness';
import { DARK_MODERN, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** CA-cotk22's shape: three references in a quote, the definitions in the file's order Schäfchen, liebst, drittes = 2, 1, 3, and one nothing refers to. */
export const COTK = [
    '!!! quote "Johannes 21:16, 17"',
    '    ^16^Dann fragte er ihn ein zweites Mal: „Simon, Sohn von Johannes, *liebst*[^liebst] du mich?“ Darauf sagte Jesus: „Hüte meine _Schäfchen_[^Schäfchen].“ ^17^Als er ihn ein drittes Mal[^drittes] fragte, wurde Petrus traurig.',
    '',
    'IN 29 MINUTEN ZU BEHANDELN',
    '',
    '[^Schäfchen]: *Schäfchen*: Das griechische Wort probátion ist die Verkleinerungsform von próbaton („Schaf“).',
    '[^liebst]: *liebst*: Jesus fragte ihn drei Mal hintereinander, ob er ihn wirklich liebt.',
    '[^drittes]: *ein drittes Mal*: Petrus hatte seinen Herrn drei Mal verleugnet.',
    '',
    '[^Senfkorn]: *Senfkorn*: Die Senfpflanze (Brassica nigra) hat ein winziges Samenkorn.',
    '',
].join('\n');

/**
 * Footnotes edited in place, in the real page (wave 4 #5b): the numbers the
 * engine gives drawn on the atoms and the entries where the file writes them,
 * the preview's ids, a `↩` per reference, the chip of an entry nothing refers
 * to, the link colour.
 */
suite('Editor footnotes (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const show = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForSelector('.ProseMirror .mep-fn-entry');
        await page.mouse.move(2, 2);
        await page.evaluate(() => window.scrollTo(0, 0));
        await delay(150);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css', 'markdown-it-admonition.css'] });
        if (!editor) {
            this.skip();
        }
        page = (editor as EditorPage).page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('the atoms show the engine\'s numbers, the entries stand where written (2, 1, 3), with the preview\'s ids and names', async function () {
        this.timeout(15000);
        await show(COTK);
        const atoms = await page.$$eval('.ProseMirror .mep-fn-ref', els => els.map(el => [el.textContent, el.id, el.getAttribute('aria-label'), el.getAttribute('aria-description'), el.getAttribute('role')]));
        assert.deepStrictEqual(atoms, [
            ['[1]', 'fnref1', 'Footnote 1', 'liebst', 'link'],
            ['[2]', 'fnref2', 'Footnote 2', 'Schäfchen', 'link'],
            ['[3]', 'fnref3', 'Footnote 3', 'drittes', 'link'],
        ]);
        const entries = await page.$$eval('.ProseMirror .mep-fn-entry', els => els.map(el => [(el.querySelector('.mep-fn-num') as HTMLElement).textContent, el.id, el.getAttribute('aria-label'), el.getAttribute('role'), el.getAttribute('aria-roledescription')]));
        assert.deepStrictEqual(entries, [
            ['2.', 'fn2', 'Footnote 2, Schäfchen', 'group', 'footnote'],
            ['1.', 'fn1', 'Footnote 1, liebst', 'group', 'footnote'],
            ['3.', 'fn3', 'Footnote 3, drittes', 'group', 'footnote'],
            ['', '', 'Footnote Senfkorn, not referenced', 'group', 'footnote'],
        ]);
        // No list of the footnotes is generated after the document, and the rule stands before the run of entries.
        assert.strictEqual(await page.$$eval('.ProseMirror .footnotes, .ProseMirror .mep-injected-block', els => els.length), 0);
        assert.strictEqual(await page.$$eval('.ProseMirror hr.mep-fn-sep', els => els.length), 1);
        await shot(page, 'footnotes-rest.png');
    });

    test('a ↩ after each numbered entry\'s text, named; the entry nothing refers to has its chip after its first word, dashed, with its tooltip', async function () {
        this.timeout(15000);
        await show(COTK);
        const backs = await page.$$eval('.ProseMirror .mep-fn-entry .mep-fn-back', els => els.map(el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('role')]));
        assert.deepStrictEqual(backs, [
            ['↩︎', 'Back to reference 2', 'link'],
            ['↩︎', 'Back to reference 1', 'link'],
            ['↩︎', 'Back to reference 3', 'link'],
        ]);
        const orphan = await page.$eval('.ProseMirror .mep-fn-entry.mep-fn-orphan', el => {
            const chip = el.querySelector('.mep-fn-chip') as HTMLElement;
            const before = chip.previousSibling;
            return {
                chip: chip.textContent,
                title: chip.title,
                after: before?.textContent,
                edge: getComputedStyle(el.querySelector('.mep-fn-body') as HTMLElement).borderLeftStyle,
                sameLine: Math.abs(chip.getBoundingClientRect().top - (el.querySelector('em, i') as HTMLElement).getBoundingClientRect().top) < 8,
            };
        });
        assert.deepStrictEqual(orphan, { chip: 'not referenced', title: 'No reference in the text — preview and export leave this out', after: 'Senfkorn', edge: 'dashed', sameLine: true });
    });

    test('#fn1 lands on footnote 1\'s entry, wherever it stands', async function () {
        this.timeout(15000);
        await page.setViewport({ width: 1280, height: 300 });
        try {
            await show(COTK);
            await (editor as EditorPage).send({ type: 'revealAnchor', anchor: 'fn1', line: null });
            await delay(300);
            const top = await page.$eval('#fn1', el => el.getBoundingClientRect().top);
            assert.ok(top >= -2 && top < 120, `fn1 is brought to the top: ${top}`);
        } finally {
            await page.setViewport({ width: 1280, height: 900 });
        }
    });

    test('[n] and ↩ in the theme\'s link colour, the number and the chip muted, in light and dark', async function () {
        this.timeout(20000);
        try {
            for (const theme of [LIGHT_MODERN, DARK_MODERN] as Theme[]) {
                await applyTheme(page, theme);
                await show(COTK);
                const seen = await page.evaluate(() => {
                    const colour = (sel: string) => getComputedStyle(document.querySelector(`.ProseMirror ${sel}`) as HTMLElement).color;
                    return { ref: colour('.mep-fn-ref'), back: colour('.mep-fn-back'), num: colour('.mep-fn-num'), chip: colour('.mep-fn-chip') };
                });
                const link = computedColour(theme.variables['textLink-foreground']);
                const muted = computedColour(theme.variables['descriptionForeground']);
                assert.deepStrictEqual(seen, { ref: link, back: link, num: muted, chip: muted }, theme.name);
            }
        } finally {
            await applyTheme(page, LIGHT_MODERN);
        }
    });

    // --- Keys and deletes (plan step 6) ---

    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent, tone: (el as HTMLElement).dataset.tone, shown: !(el as HTMLElement).hidden }));
    const lastText = async () => (await (editor as EditorPage).edits()).pop()?.text;
    /** A click right before the first `needle`'s character `index`: the caret there. */
    const caretAt = async (needle: string, index = 0) => {
        const p = await pointAt(page, needle, index);
        await page.mouse.click(p.x, p.y + 1);
        await delay(120);
    };
    const press = async (key: 'z' | 'x' | 'v', shift = false) => {
        await page.keyboard.down(MOD);
        await page.keyboard.press(key, editCommand(key, shift));
        await page.keyboard.up(MOD);
        await settle();
    };

    test('Backspace after [3]: the first press selects it and says what a second would do; the second deletes it with its text; one undo brings both back (AC5)', async function () {
        this.timeout(20000);
        await show(COTK);
        await caretAt(' fragte, wurde');
        await page.keyboard.press('Backspace');
        await delay(200);
        assert.ok(await page.$('.ProseMirror .mep-fn-ref.ProseMirror-selectednode'), 'selected');
        assert.deepStrictEqual(await hint(), { text: 'Backspace again deletes footnote drittes with its text', tone: 'neutral', shown: true });
        await page.keyboard.press('Backspace');
        await settle();
        const after = await lastText();
        assert.ok(after !== undefined && !after.includes('[^drittes]'), 'reference and definition gone');
        assert.deepStrictEqual(await hint(), { text: `Footnote drittes deleted with its text — ${UNDO}`, tone: 'neutral', shown: true });
        await press('z');
        assert.strictEqual(await lastText(), COTK, 'one undo, byte for byte');
    });

    test('Delete before a repeated reference deletes only it: footnote keeps its text, the hint says how many are left', async function () {
        this.timeout(20000);
        await show(COTK.replace('Mal[^drittes] fragte', 'Mal[^drittes] und liebst[^liebst] fragte'));
        // Right before the first reference to liebst: after the word's last letter, before its atom.
        await caretAt('liebst', 5);
        await page.keyboard.press('ArrowRight');
        await delay(80);
        await page.keyboard.press('Delete');
        await delay(150);
        assert.ok(await page.$('.ProseMirror .mep-fn-ref.ProseMirror-selectednode'), 'the first press selects');
        await page.keyboard.press('Delete');
        await settle();
        assert.deepStrictEqual(await hint(), { text: `Reference deleted, footnote liebst stays (1 more reference) — ${UNDO}`, tone: 'neutral', shown: true });
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-fn-entry', els => els.length), 4, 'the entry stays');
    });

    test('Backspace at the start of an entry\'s text is refused with the verb that deletes it; Shift+Enter breaks the line as the file does', async function () {
        this.timeout(20000);
        await show(COTK);
        await caretAt('Jesus fragte ihn');
        await page.keyboard.press('Home');
        await page.keyboard.press('Backspace');
        await delay(150);
        assert.deepStrictEqual(await hint(), { text: 'Not deleted: a footnote goes with its references — use "Delete footnote" on its bar (Alt+Enter)', tone: 'refusal', shown: true });
        await caretAt('hintereinander');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await settle();
        assert.ok((await lastText())?.includes('drei Mal  \nhintereinander'), JSON.stringify(await lastText()));
    });

    test('a typed `[^liebst]` becomes the reference, Backspace right after gives the text back; a pasted one is the reference', async function () {
        this.timeout(20000);
        await show(COTK);
        await caretAt('IN 29');
        await page.keyboard.type('Siehe[^liebst');
        await page.keyboard.type(']');
        await delay(150);
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-fn-ref', els => els.length), 4, 'an atom more');
        await page.keyboard.press('Backspace');
        await delay(150);
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-fn-ref', els => els.length), 3, 'given back as text');
        assert.ok((await page.$eval('.ProseMirror', el => el.textContent ?? '')).includes('Siehe[^liebst]'));
        await page.evaluate(() => {
            const data = new DataTransfer();
            data.setData('text/plain', ' und [^drittes]');
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        });
        await settle();
        assert.strictEqual(await page.$$eval('.ProseMirror .mep-fn-ref', els => els.length), 4, 'the pasted reference is one');
    });

    test('cut the sentence with the only [^drittes], the entry stays and says so; pasted back, it is referenced again (AC3)', async function () {
        this.timeout(20000);
        await show(COTK);
        // From "Als" to the end of "traurig.", as a person drags it: the selection made in the page.
        await page.evaluate(() => {
            const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
            let start: Text | null = null;
            let end: Text | null = null;
            for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
                start ??= n.data.includes('Als er ihn') ? n : null;
                end = n.data.includes('traurig.') ? n : end;
            }
            (document.querySelector('.ProseMirror') as HTMLElement).focus();
            window.getSelection()?.setBaseAndExtent(start as Text, (start as Text).data.indexOf('Als'), end as Text, (end as Text).data.indexOf('traurig.') + 'traurig.'.length);
        });
        await delay(150);
        await page.evaluate(() => {
            document.addEventListener('cut', e => {
                (window as unknown as { cut: unknown }).cut = { html: e.clipboardData?.getData('text/html'), text: e.clipboardData?.getData('text/plain') };
            }, { once: true });
        });
        await press('x');
        assert.deepStrictEqual(await hint(), { text: 'Footnote drittes no longer referenced — its text stays', tone: 'neutral', shown: true });
        assert.ok(await page.$('.ProseMirror .mep-fn-entry[data-mep-fn-entry="drittes"].mep-fn-orphan'), 'not referenced');
        const cut = await page.evaluate(() => (window as unknown as { cut?: { html: string; text: string } }).cut);
        assert.ok(cut?.html.includes('data-mep-fn'), 'the copy keeps the atom');
        await caretAt('IN 29');
        await page.evaluate(c => {
            const data = new DataTransfer();
            data.setData('text/html', c.html);
            data.setData('text/plain', c.text);
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        }, cut as { html: string; text: string });
        await settle();
        assert.strictEqual(await page.$('.ProseMirror .mep-fn-entry[data-mep-fn-entry="drittes"].mep-fn-orphan'), null, 'referenced again');
        assert.strictEqual(await page.$eval('.ProseMirror .mep-fn-entry[data-mep-fn-entry="drittes"] .mep-fn-num', el => el.textContent), '3.');
    });
});
