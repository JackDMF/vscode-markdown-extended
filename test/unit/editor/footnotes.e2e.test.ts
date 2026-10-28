import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { closeEditorPage, computedColour, delay, EditorPage, EXTENSION_ID, openEditorPage, shot } from './pageHarness';
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
});
