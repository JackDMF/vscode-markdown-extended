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

    // --- Bars, Label…, Delete verbs, Sort (plan step 7) ---

    const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
    const bar = () => page.$eval(BAR, el => ({
        label: el.querySelector('.mep-object-label')?.textContent ?? '',
        verbs: Array.from(el.querySelectorAll<HTMLButtonElement>('button[data-verb]')).map(b => [b.dataset.verb, b.getAttribute('aria-disabled') === 'true']),
        focus: (document.activeElement as HTMLElement | null)?.dataset.verb ?? '',
    }));
    const pressAlt = async (key: puppeteer.KeyInput) => {
        await page.keyboard.down('Alt');
        await page.keyboard.press(key);
        await page.keyboard.up('Alt');
        await delay(200);
    };
    const clickAtom = async (n: number) => {
        const box = await (await page.$$('.ProseMirror .mep-fn-ref'))[n].boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(`${BAR}[data-object="footnote"]`, { timeout: 2000 });
        await delay(300);
    };
    /** The caret in the entry's text at `needle`, and its bar after the rest. */
    const restIn = async (needle: string) => {
        await caretAt(needle);
        await page.mouse.move(2, 2);
        await page.waitForSelector(`${BAR}[data-object="footnote_entry"]`, { timeout: 3000 });
        await delay(300);
    };
    const clickVerb = async (verb: string) => {
        const box = await (await page.waitForSelector(`${BAR} [data-verb="${verb}"]`, { visible: true, timeout: 2000 }))?.boundingBox();
        assert.ok(box, verb);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(200);
    };

    test('a reference\'s bar: Go to footnote text first focus, Label…, Delete footnote for the last reference, Delete reference when more remain (AC6)', async function () {
        this.timeout(20000);
        await show(COTK.replace('fragte, wurde', 'und liebst[^liebst] fragte, wurde'));
        await clickAtom(1);
        assert.deepStrictEqual(await bar(), { label: 'Footnote 2 · Schäfchen', verbs: [['go-to-footnote', false], ['footnote-label', false], ['delete-footnote', false]], focus: '' });
        await pressAlt('Enter');
        assert.strictEqual((await bar()).focus, 'go-to-footnote', 'the jump takes the first focus (#14 exception)');
        await page.keyboard.press('Escape');
        await clickAtom(0);
        assert.deepStrictEqual((await bar()).verbs.map(v => v[0]), ['go-to-footnote', 'footnote-label', 'delete-reference']);
        await shot(page, 'footnotes-atom-bar.png');
    });

    test('an entry\'s bar on a caret rest: Back to reference first focus, Label…, Sort footnotes while out of order, Delete footnote; an orphan\'s Back is refused', async function () {
        this.timeout(20000);
        await show(COTK);
        await restIn('Verkleinerungsform');
        assert.deepStrictEqual(await bar(), {
            label: 'Footnote 2 · Schäfchen',
            verbs: [['back-to-reference', false], ['footnote-label', false], ['sort-footnotes', false], ['delete-footnote', false]],
            focus: '',
        });
        await pressAlt('Enter');
        assert.strictEqual((await bar()).focus, 'back-to-reference');
        await page.keyboard.press('Escape');
        await restIn('Senfpflanze');
        const orphan = await bar();
        assert.deepStrictEqual([orphan.label, orphan.verbs[0]], ['Footnote · Senfkorn · not referenced', ['back-to-reference', true]]);
        await pressAlt('Enter');
        assert.strictEqual((await bar()).focus, 'footnote-label', 'Back is refused: Label… first');
        await page.keyboard.press('Escape');
    });

    test('Sort footnotes on the bar puts them in number order and leaves the bar; from the palette, a sorted document says so (AC2)', async function () {
        this.timeout(20000);
        await show(COTK);
        await restIn('Verkleinerungsform');
        await clickVerb('sort-footnotes');
        await settle();
        assert.deepStrictEqual(await page.$$eval('.ProseMirror .mep-fn-num', els => els.map(e => e.textContent)), ['1.', '2.', '3.', '']);
        assert.deepStrictEqual(await hint(), { text: `Footnotes sorted — ${UNDO}`, tone: 'neutral', shown: true });
        await restIn('Verkleinerungsform');
        assert.ok(!(await bar()).verbs.some(v => v[0] === 'sort-footnotes'), 'in order: no Sort');
        await press('z');
        assert.strictEqual(await lastText(), COTK);
        await (editor as EditorPage).send({ type: 'sortFootnotes' } as never);
        await settle();
        assert.deepStrictEqual(await page.$$eval('.ProseMirror .mep-fn-num', els => els.map(e => e.textContent)), ['1.', '2.', '3.', '']);
        await (editor as EditorPage).send({ type: 'sortFootnotes' } as never);
        await delay(200);
        assert.deepStrictEqual(await hint(), { text: 'Footnotes are in number order', tone: 'neutral', shown: true });
    });

    test('Label… refuses a space and a taken label in the field, amber; a valid one renames every reference and the text in one undo (AC10)', async function () {
        this.timeout(20000);
        await show(COTK.replace('fragte, wurde', 'und liebst[^liebst] fragte, wurde'));
        await clickAtom(0);
        await clickVerb('footnote-label');
        const input = 'input.mep-inline-field';
        await page.waitForSelector(input, { visible: true });
        const refusal = async (typed: string) => {
            await page.keyboard.down(MOD);
            await page.keyboard.press('a', editCommand('a'));
            await page.keyboard.up(MOD);
            await page.keyboard.type(typed);
            await page.keyboard.press('Enter');
            await delay(200);
            return page.$eval(input, el => ({ invalid: el.getAttribute('aria-invalid'), reason: document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? '' }));
        };
        assert.deepStrictEqual(await refusal('zwei Worte'), { invalid: 'true', reason: 'Not set: a label has no spaces — use "_" instead' });
        assert.deepStrictEqual(await refusal('drittes'), { invalid: 'true', reason: 'Not set: drittes is used by footnote 3 — choose another' });
        await shot(page, 'footnotes-label-refusal.png');
        await page.keyboard.down(MOD);
        await page.keyboard.press('a', editCommand('a'));
        await page.keyboard.up(MOD);
        await page.keyboard.type('lieben');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual(await page.$('input.mep-inline-field'), null, 'set: the field closes');
        const renamed = await lastText();
        assert.ok(renamed !== undefined && !renamed.includes('liebst]') && (renamed.match(/\[\^lieben\]/g) ?? []).length === 3, renamed);
        await press('z');
        assert.ok((await lastText())?.includes('[^liebst]:'));
    });

    test('at 520 px every footnote bar keeps its verbs whole and inside the window', async function () {
        this.timeout(20000);
        await page.setViewport({ width: 520, height: 900 });
        try {
            await show(COTK);
            const whole = () => page.$eval(BAR, el => ({
                inside: el.getBoundingClientRect().right <= document.documentElement.clientWidth - 16 + 0.5 && el.getBoundingClientRect().left >= -0.5,
                whole: Array.from(el.querySelectorAll<HTMLButtonElement>('button[data-verb]')).every(b => b.scrollWidth <= b.clientWidth),
            }));
            await clickAtom(0);
            assert.deepStrictEqual(await whole(), { inside: true, whole: true }, 'the reference\'s bar');
            await shot(page, 'footnotes-atom-bar-520.png');
            await restIn('Verkleinerungsform');
            assert.deepStrictEqual(await whole(), { inside: true, whole: true }, 'the entry\'s bar');
            await shot(page, 'footnotes-entry-bar-520.png');
        } finally {
            await page.setViewport({ width: 1280, height: 900 });
        }
    });

    // --- Between a reference and its text (plan step 8) ---

    /** Whether a letter typed now stands right after `before` in the file; the letter undone again. */
    const typedAfter = async (before: string) => {
        await page.keyboard.type('Q');
        await settle();
        const holds = (await lastText())?.includes(`${before}Q`) ?? false;
        await press('z');
        return holds;
    };
    /** Where the caret is: the entry it is in, and whether it stands right after the `n`th reference. */
    const caretState = (n: number) => page.evaluate(k => {
        const sel = window.getSelection();
        const node = sel?.anchorNode ?? null;
        const el = node === null ? null : (node.nodeType === 1 ? node as Element : node.parentElement);
        const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getClientRects()[0] ?? sel.getRangeAt(0).getBoundingClientRect() : null;
        const atom = document.querySelectorAll('.ProseMirror .mep-fn-ref')[k]?.getBoundingClientRect();
        return {
            entry: el?.closest('.mep-fn-entry')?.getAttribute('data-mep-fn-entry') ?? null,
            current: document.querySelector('.ProseMirror .mep-fn-entry.mep-fn-current')?.getAttribute('data-mep-fn-entry') ?? null,
            afterAtom: range !== null && atom !== undefined && Math.abs(range.left - atom.right) < 4 && Math.abs(range.top - atom.top) < 20,
        };
    }, n);

    test('Go to footnote text on [1] lands at its text, tinted, announced; Back to reference returns right after the same [1]; from the second of two references, to the second (AC7)', async function () {
        this.timeout(25000);
        await show(COTK.replace('fragte, wurde', 'und liebst[^liebst] fragte, wurde'));
        await clickAtom(0);
        await pressAlt('Enter');
        await page.keyboard.press('Enter');
        await delay(300);
        assert.deepStrictEqual(await caretState(0), { entry: 'liebst', current: 'liebst', afterAtom: false });
        assert.strictEqual(await page.$eval('.mep-live', el => el.textContent), 'Footnote 1 text');
        await page.waitForSelector(`${BAR}[data-object="footnote_entry"]`, { timeout: 3000 });
        await pressAlt('Enter');
        assert.strictEqual((await bar()).focus, 'back-to-reference');
        await page.keyboard.press('Enter');
        await delay(300);
        assert.deepStrictEqual(await caretState(0), { entry: null, current: null, afterAtom: (await caretState(0)).afterAtom });
        assert.ok(await typedAfter('*liebst*[^liebst]'), 'right after the same [1]');
        // The second reference to liebst ([4]): back to it, not to the first.
        await clickAtom(3);
        await pressAlt('Enter');
        await page.keyboard.press('Enter');
        await delay(300);
        await page.waitForSelector(`${BAR}[data-object="footnote_entry"]`, { timeout: 3000 });
        await pressAlt('Enter');
        await page.keyboard.press('Enter');
        await delay(300);
        assert.ok(await typedAfter('und liebst[^liebst]'), 'back to the second reference');
    });

    test('Ctrl/Cmd+click on [2] goes to its text; each ↩ goes back to its own reference (AC8)', async function () {
        this.timeout(25000);
        await show(COTK.replace('fragte, wurde', 'und liebst[^liebst] fragte, wurde'));
        const box = await (await page.$$('.ProseMirror .mep-fn-ref'))[1].boundingBox();
        assert.ok(box);
        await page.keyboard.down(MOD);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.keyboard.up(MOD);
        await delay(300);
        assert.strictEqual((await caretState(1)).entry, 'Schäfchen');
        const backs = await page.$$('.ProseMirror .mep-fn-entry[data-mep-fn-entry="liebst"] .mep-fn-back');
        assert.strictEqual(backs.length, 2, 'one ↩ per reference');
        for (const [k, atom] of [[0, 0], [1, 3]] as [number, number][]) {
            const b = await backs[k].boundingBox();
            assert.ok(b);
            await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
            await delay(300);
            assert.ok(await typedAfter(atom === 0 ? '*liebst*[^liebst]' : 'und liebst[^liebst]'), `↩ ${k + 1} goes to its reference`);
        }
    });

    test('the pointer on a reference shows its text in the card, with how to go there; on an inline footnote its text rendered', async function () {
        this.timeout(25000);
        await show(`${COTK}\nEine Anleitung^[Oder *Lenkung*.] hier.\n`);
        const card = async (n: number) => {
            await page.mouse.move(2, 2);
            await delay(200);
            const box = await (await page.$$('.ProseMirror .mep-fn-ref'))[n].boundingBox();
            assert.ok(box);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForFunction(want => {
                const title = document.querySelector('.mep-language-card .mep-card-footnote .mep-card-footnote-title') as HTMLElement | null;
                return title !== null && title.offsetParent !== null && title.textContent?.startsWith(want);
            }, { timeout: 3000 }, n === 3 ? 'Inline' : 'Footnote');
            return page.$eval('.mep-language-card .mep-card-footnote', el => ({
                title: el.querySelector('.mep-card-footnote-title')?.textContent,
                body: (el.querySelector('.mep-card-footnote-body, .mep-card-hover') as HTMLElement | null)?.textContent?.trim(),
                foot: el.querySelector('.mep-card-source')?.textContent ?? null,
            }));
        };
        const first = await card(0);
        assert.deepStrictEqual(first, { title: 'Footnote 1 · liebst', body: 'liebst: Jesus fragte ihn drei Mal hintereinander, ob er ihn wirklich liebt.', foot: `${process.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+click goes to the text` });
        await shot(page, 'footnotes-hover.png');
        const inline = await card(3);
        assert.deepStrictEqual([inline.title, inline.body], ['Inline footnote 4', 'Oder Lenkung.']);
        await page.mouse.move(2, 2);
    });

    // --- Insert › Footnote in place (plan step 9) ---

    /** The DOM selection over the first `needle`, as a person drags it. */
    const selectText = (needle: string) => page.evaluate(n => {
        const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
            const at = t.data.indexOf(n);
            if (at >= 0) {
                (document.querySelector('.ProseMirror') as HTMLElement).focus();
                window.getSelection()?.setBaseAndExtent(t, at, t, at + n.length);
                return;
            }
        }
    }, needle);

    test('Insert › Footnote on `Petrus traurig.`: the reference after the word, its entry after the last one prefilled, the caret there; the hint names it (AC9)', async function () {
        this.timeout(20000);
        await show(COTK);
        await selectText('Petrus traurig');
        await delay(200);
        await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
        await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden]) [data-action="footnote-reference"]');
        await page.click('.mep-menu[data-menu="annotation"] [data-action="footnote-reference"]');
        await settle();
        assert.deepStrictEqual(await hint(), { text: `Footnote Petrus_traurig added — type its text; ↩ goes back · ${UNDO}`, tone: 'neutral', shown: true });
        await page.keyboard.type('Er weinte.');
        await settle();
        const out = await lastText();
        // The longer line wraps where the paragraph was written, as any changed one.
        assert.ok(/wurde Petrus\s+traurig\[\^Petrus_traurig\]\./.test(out ?? ''), out);
        assert.ok(out?.includes('[^Petrus_traurig]: *Petrus traurig*: Er weinte.\n'), out);
        // After the last entry, written as it is: no blank line between entries that had none.
        assert.ok(out?.includes('Samenkorn.\n\n[^Petrus_traurig]:'), out);
        assert.strictEqual(await page.$eval('.ProseMirror .mep-fn-entry[data-mep-fn-entry="Petrus_traurig"] .mep-fn-num', el => el.textContent), '4.');
        await shot(page, 'footnotes-insert.png');
    });

    // --- An inline footnote's text (plan step 10) ---

    test('Edit text… opens the inline footnote\'s text in its field; a stray `]` is refused there, amber; Enter sets it in one undo (AC13)', async function () {
        this.timeout(20000);
        const doc = `${COTK}\nMit weiser Anleitung^[Oder „geschickter Lenkung“] führt man Krieg.\n`;
        await show(doc);
        await clickAtom(3);
        assert.deepStrictEqual(await bar(), { label: 'Inline footnote 4', verbs: [['edit-inline-footnote', false], ['delete-footnote', false]], focus: '' });
        await clickVerb('edit-inline-footnote');
        const input = 'input.mep-inline-field';
        await page.waitForSelector(input, { visible: true });
        assert.strictEqual(await page.$eval(input, el => (el as HTMLInputElement).value), 'Oder „geschickter Lenkung“');
        assert.ok((await page.$eval('.mep-object-toolbar:not([hidden])', el => el.textContent ?? '')).includes('↵ set · Esc cancel'), 'the keys line');
        await page.keyboard.press('End');
        await page.keyboard.type('] mehr');
        await page.keyboard.press('Enter');
        await delay(200);
        const refused = await page.$eval(input, el => ({ invalid: el.getAttribute('aria-invalid'), reason: document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? '' }));
        assert.deepStrictEqual(refused, { invalid: 'true', reason: 'Not set: the "]" after “Oder „geschickter Lenkung“” ends the footnote early — remove it or add a "[" before it' });
        await shot(page, 'footnotes-inline-refusal.png');
        for (let i = 0; i < '] mehr'.length; i++) {
            await page.keyboard.press('Backspace');
        }
        await page.keyboard.type(', weise');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual(await lastText(), doc.replace('Lenkung“]', 'Lenkung“, weise]'));
        await press('z');
        assert.strictEqual(await lastText(), doc);
    });

    // --- A `[^x]` written as text (plan step 11) ---

    test('a misspelt `[^Schaefchen]` is dotted and says so on hover; changed, the paragraph keeps it as written', async function () {
        this.timeout(20000);
        const doc = 'Meine Schäfchen[^Schaefchen] hüten.\n\n[^Schäfchen]: *Schäfchen*: Kleine Schafe.\n';
        await show(doc);
        assert.deepStrictEqual(await page.$eval('.ProseMirror .mep-fn-literal', el => [el.textContent, getComputedStyle(el).textDecorationStyle]), ['[^Schaefchen]', 'dotted']);
        const box = await (await page.$('.ProseMirror .mep-fn-literal'))?.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector('.mep-language-card .mep-card-footnote', { visible: true, timeout: 3000 });
        assert.strictEqual(await page.$eval('.mep-language-card .mep-card-footnote-title', el => el.textContent), 'No footnote Schaefchen — give a footnote marked "not referenced" this label (Label…)');
        await shot(page, 'footnotes-literal-dotted.png');
        await page.mouse.move(2, 2);
        await caretAt(' hüten');
        await page.keyboard.type(' gern');
        await settle();
        assert.strictEqual(await lastText(), doc.replace(' hüten', ' gern hüten'));
    });

    // --- The layers at a reference (fix round 1, ux-review-build-1 "Layers") ---

    type Box = { left: number; top: number; right: number; bottom: number };
    const boxOf = (selector: string): Promise<Box | null> => page.evaluate(sel => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el === null || el.hidden || el.getClientRects().length === 0) {
            return null;
        }
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }, selector);
    /** The line of text reference `n` stands in: the box of the character beside it, not the raised `[n]`'s own. */
    const lineOf = (n: number): Promise<Box> => page.evaluate(k => {
        const ref = document.querySelectorAll('.ProseMirror .mep-fn-ref')[k];
        const range = document.createRange();
        const before = ref.previousSibling;
        const after = ref.nextSibling;
        if (before instanceof Text && before.data.length > 0) {
            range.setStart(before, before.data.length - 1);
            range.setEnd(before, before.data.length);
        } else {
            range.setStart(after as Text, 0);
            range.setEnd(after as Text, 1);
        }
        const r = range.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }, n);
    const off = (a: Box, line: Box) => a.top >= line.bottom - 0.5 || a.bottom <= line.top + 0.5;
    const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    /** The document's text the element `selector` covers. */
    const coveredText = (selector: string): Promise<string[]> => page.evaluate(sel => {
        const over = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
        const covered: string[] = [];
        const walker = document.createTreeWalker(document.querySelector('.ProseMirror') as HTMLElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const r = document.createRange();
            r.selectNodeContents(node);
            if ((node.textContent ?? '').trim() !== '' && Array.from(r.getClientRects()).some(b => b.left < over.right && b.right > over.left && b.top < over.bottom && b.bottom > over.top)) {
                covered.push(node.textContent ?? '');
            }
        }
        return covered;
    }, selector);

    test('the card at a raised [1] and the first Backspace\'s hint at [3] stand off the text line the reference is in, not just off its raised box; so does the bar', async function () {
        this.timeout(20000);
        await show(COTK);
        const line = await lineOf(0);
        const ref = await boxOf('.ProseMirror .mep-fn-ref');
        assert.ok(ref !== null && ref.bottom < line.bottom - 2, `the [1] is raised inside its line: ${JSON.stringify({ ref, line })}`);
        const box = await (await page.$$('.ProseMirror .mep-fn-ref'))[0].boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector('.mep-language-card .mep-card-footnote', { visible: true, timeout: 3000 });
        const card = await boxOf('.mep-language-card');
        assert.ok(card !== null && off(card, line), `the card is off the line of [1]: ${JSON.stringify({ card, line })}`);
        await page.mouse.move(2, 2);
        await delay(300);
        await caretAt(' fragte, wurde');
        await page.keyboard.press('Backspace');
        await delay(150);
        const third = await lineOf(2);
        const hinted = await boxOf('.mep-hint');
        assert.ok(hinted !== null && off(hinted, third), `the hint is off the line of [3]: ${JSON.stringify({ hinted, third })}`);
        await page.waitForSelector(`${BAR}[data-object="footnote"]`, { timeout: 2000 });
        const shownBar = await boxOf(BAR);
        assert.ok(shownBar !== null && off(shownBar, third), `the bar is off the line of [3]: ${JSON.stringify({ shownBar, third })}`);
        await page.keyboard.press('Escape');
    });

    test('an emoji\'s bar stands at the emoji\'s own box as before: only a reference drawn raised is grown to its line', async function () {
        this.timeout(20000);
        await show('Ein Lächeln :smile: hier und mehr Text danach.\n\n[^a]: A.\n');
        const emoji = await boxOf('.ProseMirror .mep-emoji, .ProseMirror [data-mep-emoji]');
        assert.ok(emoji, 'an emoji');
        await page.mouse.click((emoji.left + emoji.right) / 2, (emoji.top + emoji.bottom) / 2);
        await page.waitForSelector(BAR, { timeout: 2000 });
        await delay(300);
        const shownBar = await boxOf(BAR);
        assert.ok(shownBar !== null && (Math.abs(shownBar.top - (emoji.bottom + 4)) < 1 || Math.abs(shownBar.bottom - (emoji.top - 4)) < 1), JSON.stringify({ shownBar, emoji }));
        await page.keyboard.press('Escape');
    });

    test('the first Backspace\'s hint is placed again when the bar comes: at 500 ms both show, apart, and the hint stays off the line of [3]', async function () {
        this.timeout(20000);
        await show(COTK);
        await caretAt(' fragte, wurde');
        await page.keyboard.press('Backspace');
        await delay(500);
        const shownBar = await boxOf(BAR);
        const hinted = await boxOf('.mep-hint');
        const third = await lineOf(2);
        assert.ok(shownBar !== null && hinted !== null, 'bar and hint both show');
        assert.ok(!overlaps(shownBar, hinted), `the hint keeps off the bar: ${JSON.stringify({ shownBar, hinted })}`);
        assert.ok(off(hinted, third), `and off the line of [3]: ${JSON.stringify({ hinted, third })}`);
        await page.keyboard.press('Escape');
    });

    test('after Insert › Footnote the hint is placed again when the entry\'s bar comes, off the bar and off the caret\'s line', async function () {
        this.timeout(20000);
        await show(COTK);
        await selectText('Petrus traurig');
        await delay(200);
        await page.click('.mep-toolbar .mep-menu-face[data-menu="annotation"]');
        await page.waitForSelector('.mep-menu[data-menu="annotation"]:not([hidden]) [data-action="footnote-reference"]');
        await page.click('.mep-menu[data-menu="annotation"] [data-action="footnote-reference"]');
        await page.mouse.move(2, 2);
        await page.waitForSelector(`${BAR}[data-object="footnote_entry"]`, { timeout: 3000 });
        await delay(300);
        const shownBar = await boxOf(BAR);
        const hinted = await boxOf('.mep-hint');
        const line = await page.evaluate(() => {
            const r = (window.getSelection() as Selection).getRangeAt(0).getClientRects()[0] ?? (window.getSelection() as Selection).getRangeAt(0).getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        });
        assert.ok(shownBar !== null && hinted !== null, 'bar and hint both show');
        assert.ok(!overlaps(shownBar, hinted), `the hint keeps off the bar: ${JSON.stringify({ shownBar, hinted })}`);
        assert.ok(off(hinted, line), `and off the caret's line: ${JSON.stringify({ hinted, line })}`);
    });

    test('Alt+Enter on a reference whose bar stands above it: the first verb\'s tooltip goes above the bar, off the reference\'s line', async function () {
        this.timeout(20000);
        // The verse's second line runs the column's width: below [1] is text, above it the quote's title row is free.
        await show(COTK.replace('Petrus traurig.', 'Petrus traurig, und er sagte zu ihm: „Herr, du weißt alles; du weißt, dass ich dich lieb habe.“ Jesus sagte zu ihm: „Füttere meine Schäfchen.“'));
        await clickAtom(0);
        const line = await lineOf(0);
        const shownBar = await boxOf(BAR);
        assert.ok(shownBar !== null && shownBar.bottom <= line.top, `the bar stands above [1]: ${JSON.stringify({ shownBar, line })}`);
        await pressAlt('Enter');
        assert.strictEqual((await bar()).focus, 'go-to-footnote');
        const tip = await boxOf('.mep-tooltip');
        assert.ok(tip !== null && tip.bottom <= shownBar.top + 0.5, `the tooltip stands above the bar: ${JSON.stringify({ tip, shownBar })}`);
        assert.ok(off(tip, line), `off the line of [1]: ${JSON.stringify({ tip, line })}`);
        await page.keyboard.press('Escape');
    });

    /** CA-btk22's sidenote holding a reference, the entry's text two lines under it. */
    const SIDENOTE = [
        'Doch der ++Helfer|Oder „Tröster“, „Ermutiger“, „Anwalt“. (Siehe Anm. zu Joh 14:16.[^Joh14:16])++, der heilige Geist, den der Vater in meinem Namen senden wird, wird euch alles lehren.',
        '',
        '[^Joh14:16]: *Helfer*  ',
        'Oder „Tröster“, „Ermutiger“, „Anwalt“. Das mit „Helfer“ übersetzte griechische Wort paráklētos.',
        '',
    ].join('\n');

    test('a reference in a margin note: its bar stands under the note at the editor\'s edge less 16 px, over no text of the column (#15)', async function () {
        this.timeout(20000);
        await show(SIDENOTE);
        await clickAtom(0);
        const shownBar = await boxOf(BAR);
        const edge = await page.evaluate(() => document.documentElement.clientWidth - 16);
        assert.ok(shownBar !== null && Math.abs(shownBar.right - edge) < 1.5, `right-aligned at the editor's edge less 16: ${JSON.stringify({ shownBar, edge })}`);
        assert.deepStrictEqual(await coveredText(BAR), [], 'the bar covers no text');
        await page.keyboard.press('Escape');
    });

    test('a reference in a margin note beside full lines of the column: its bar keeps to the margin, its verbs drop their nouns first, over no text', async function () {
        this.timeout(20000);
        const full = 'Der Vater wird euch einen anderen Helfer geben, der für immer bei euch sein wird, den Geist der Wahrheit, den die Welt nicht empfangen kann, weil sie ihn weder sieht noch kennt.';
        await show(SIDENOTE.replace('wird euch alles lehren.', `wird euch alles lehren. ${full} ${full} ${full}`));
        await clickAtom(0);
        const shownBar = await boxOf(BAR);
        assert.ok(shownBar, 'the bar');
        assert.deepStrictEqual(await coveredText(BAR), [], `the bar covers no text: ${JSON.stringify(shownBar)}`);
        const verbs = await page.$$eval(`${BAR} button[data-verb]`, els => els.map(b => [(b as HTMLElement).dataset.verb, (b as HTMLElement).dataset.short ?? null]));
        assert.ok(verbs.some(([, short]) => short !== null), `a verb shows its short form: ${JSON.stringify(verbs)}`);
        // The title steps down, never cut mid-word (UX review 2): "Footnote 1 · Joh14:16" → "Footnote 1" → "1" → hidden.
        const title = await page.$eval(`${BAR} .mep-object-label`, el => ({ text: el.textContent, hidden: (el as HTMLElement).hidden, cut: el.scrollWidth > el.clientWidth + 1 }));
        assert.ok(title.hidden || (['Footnote 1 · Joh14:16', 'Footnote 1', '1'].includes(title.text ?? '') && !title.cut), JSON.stringify(title));
        await page.keyboard.press('Escape');
    });

    test('the bar\'s tooltips start with what the verb does; a missing reference is "No footnote x" on its bar and to a screen reader; a duplicate\'s Back says where its references go', async function () {
        this.timeout(25000);
        const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
        await show(COTK);
        await clickAtom(0);
        const tips = await page.$$eval(`${BAR} button[data-verb]`, els => Object.fromEntries(els.map(b => [(b as HTMLElement).dataset.verb, b.getAttribute('aria-description')])));
        assert.deepStrictEqual(tips, {
            'go-to-footnote': `Moves the caret to the footnote's text — ↩ or Back to reference returns (${mod}+click on [1] does the same)`,
            'footnote-label': 'Renames liebst in every reference and in its text (↵ set · Esc cancel)',
            'delete-footnote': `Deletes the reference and its text — ${UNDO}`,
        });
        await page.keyboard.press('Escape');
        await restIn('Verkleinerungsform');
        const entryTips = await page.$$eval(`${BAR} button[data-verb]`, els => Object.fromEntries(els.map(b => [(b as HTMLElement).dataset.verb, b.getAttribute('aria-description')])));
        assert.strictEqual(entryTips['back-to-reference'], 'Returns to the reference you came from, else the first');
        assert.strictEqual(entryTips['sort-footnotes'], `Puts the footnote texts in number order, unreferenced ones last — ${UNDO}`);
        await page.keyboard.press('Escape');
        // A reference whose definition went (the file spells it as text then): its label renamed under it in the page's document.
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, 'Ein Satz[^da] und mehr.\n\n[^da]: Da.\n', {})) as unknown;
        const rename = (n: unknown): void => {
            const node = n as { type?: string; attrs?: { label?: string }; content?: unknown[] };
            if (node.type === 'footnote_ref' && node.attrs) {
                node.attrs.label = 'fehlt';
            }
            node.content?.forEach(rename);
        };
        rename((json as { doc: unknown }).doc);
        version++;
        await (editor as EditorPage).send({ type: 'document', json, version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE } as never);
        await page.waitForSelector('.ProseMirror .mep-fn-ref.mep-fn-missing');
        assert.strictEqual(await page.$eval('.ProseMirror .mep-fn-ref', el => el.getAttribute('aria-label')), 'No footnote fehlt, shown as text');
        await page.mouse.click(...await page.$eval('.ProseMirror .mep-fn-ref', el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] as [number, number]; }));
        await page.waitForSelector(`${BAR}[data-object="footnote"]`, { timeout: 2000 });
        await delay(300);
        assert.strictEqual((await bar()).label, 'No footnote · fehlt');
        await page.keyboard.press('Escape');
        await show('Ein Satz[^satz] und mehr.\n\n[^satz]: Der erste Text.\n\n[^satz]: Der zweite, den die Vorschau zeigt.\n');
        await restIn('erste Text');
        assert.strictEqual(await page.$eval(`${BAR} [data-verb="back-to-reference"]`, el => el.getAttribute('aria-description')),
            'Returns to the reference you came from, else the first\nNo reference leads here — they go to footnote 1, which has the same label');
        await page.keyboard.press('Escape');
    });
});

