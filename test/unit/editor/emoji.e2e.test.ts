import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { closeEditorPage, delay, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, pointAt, settle, shot } from './pageHarness';
import { DARK_MODERN, LIGHT_MODERN, Theme, applyTheme } from './themes';
import { undoKey } from '../../../src/editor/webview/hint';

/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

/**
 * An emoji the file holds, in the real page: drawn as its glyph like the text
 * around it, a tooltip naming its spelling, selected by a click with the
 * embed's outline, a bar naming it with its two verbs, and the caret hint an
 * edit that makes it text gives. Each state is shot in light and dark with
 * `MEP_SHOTS_DIR` set (`shot`).
 */
suite('Editor emoji atom (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    const showDocument = async (text: string, marker: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
        });
        await delay(400);
    };

    const atomBox = async () => {
        const box = await (await page.$('.ProseMirror .mep-emoji'))?.boundingBox();
        assert.ok(box, 'the emoji is drawn');
        return box;
    };

    const pickAtom = async () => {
        const box = await atomBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(`${BAR}[data-object="emoji"]`, { timeout: 2000 });
    };

    const clickVerb = async (verb: string) => {
        const button = await page.waitForSelector(`${BAR} [data-verb="${verb}"]`, { visible: true, timeout: 2000 });
        const box = await button?.boundingBox();
        assert.ok(box, `no box for ${verb}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
    };

    const barState = () => page.$eval(BAR, bar => ({
        object: (bar as HTMLElement).dataset.object,
        label: bar.querySelector('.mep-object-label')?.textContent,
        title: (bar.querySelector('.mep-object-label') as HTMLElement | null)?.title,
        code: bar.querySelector('.mep-object-label .mep-object-label-code')?.textContent,
        verbs: Array.from(bar.querySelectorAll('button[data-verb]')).map(v => (v as HTMLElement).dataset.verb),
    }));

    /** The hint put away, so a shot shows only the state it names. */
    const clearHint = () => page.evaluate(() => {
        const el = document.querySelector('.mep-hint') as HTMLElement | null;
        if (el) {
            el.hidden = true;
        }
    });

    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent, tone: (el as HTMLElement).dataset.tone, shown: !(el as HTMLElement).hidden }));

    /** The caret right after the first atom: a click right before the space that follows it. */
    const caretAfterAtom = async () => {
        const p = await pointAt(page, ' here', 0);
        await page.mouse.click(p.x, p.y);
        await delay(150);
    };

    const atoms = () => page.$$eval('.ProseMirror .mep-emoji', els => els.length);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 900, height: 420, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    test('drawn as its glyph in the text\'s own font and colour, no chip; the tooltip names its spelling', async function () {
        this.timeout(15000);
        await showDocument('Glad to see you :) here.\n', 'Glad');
        const drawn = await page.$eval('.ProseMirror .mep-emoji', el => {
            const style = getComputedStyle(el);
            const paragraph = getComputedStyle(el.parentElement as HTMLElement);
            return {
                text: el.textContent,
                title: (el as HTMLElement).title,
                editable: (el as HTMLElement).contentEditable,
                font: style.fontFamily === paragraph.fontFamily && style.fontSize === paragraph.fontSize,
                colour: style.color === paragraph.color,
                background: style.backgroundColor,
                padding: style.padding,
            };
        });
        assert.deepStrictEqual(drawn, { text: '😃', title: 'Emoji :) — kept as written', editable: 'false', font: true, colour: true, background: 'rgba(0, 0, 0, 0)', padding: '0px' });
    });

    test('a click selects it with the focus outline, the bar names it by its spelling, and Remove emoji takes it out whole', async function () {
        this.timeout(15000);
        await showDocument('Glad to see you :) here.\n', 'Glad');
        await pickAtom();
        const outline = await page.$eval('.ProseMirror .mep-emoji', el => ({ selected: el.classList.contains('ProseMirror-selectednode'), style: getComputedStyle(el).outlineStyle }));
        assert.deepStrictEqual(outline, { selected: true, style: 'solid' });
        assert.strictEqual(await page.$eval('.ProseMirror .mep-emoji', el => getComputedStyle(el).cursor), 'default');
        assert.deepStrictEqual(await barState(), { object: 'emoji', label: 'Emoji :)', title: 'Emoji :) — kept as written', code: ':)', verbs: ['edit-emoji-as-text', 'remove-emoji'] });
        const fonts = await page.$eval(`${BAR} .mep-object-label-code`, el => ({ code: getComputedStyle(el).fontFamily, background: getComputedStyle(el).backgroundColor }));
        assert.ok(/Consolas|monospace/.test(fonts.code), fonts.code);
        assert.strictEqual(fonts.background, 'rgba(0, 0, 0, 0)', 'no chip');
        await clickVerb('remove-emoji');
        await settle();
        assert.strictEqual(await atoms(), 0);
        // The two spaces it stood between are written as one, as a changed paragraph's run of spaces is.
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you here.\n');
    });

    test('Edit as text makes it its spelling with the caret after it, saved escaped; Ctrl+Z gives the atom back', async function () {
        this.timeout(20000);
        await showDocument('Glad to see you :) here.\n', 'Glad');
        await pickAtom();
        await clickVerb('edit-emoji-as-text');
        assert.deepStrictEqual(await hint(), { text: 'Emoji is text — Ctrl+Z', tone: 'neutral', shown: true });
        await settle();
        assert.strictEqual(await atoms(), 0);
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you \\:) here.\n');
        await page.keyboard.type('X');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you :)X here.\n', 'typed right after the spelling, glued to it: text, as the host reads it');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await settle();
        assert.strictEqual(await atoms(), 1);
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you :) here.\n');
    });

    test('a letter typed right after it makes it text at once, the file holds that text, and the caret hint says so', async function () {
        this.timeout(15000);
        await showDocument('Glad to see you :) here.\n', 'Glad');
        await caretAfterAtom();
        await page.keyboard.type('Z');
        await delay(80);
        assert.deepStrictEqual(await hint(), { text: `:)Z is no longer an emoji — ${undoKey()}`, tone: 'neutral', shown: true });
        await settle();
        assert.strictEqual(await atoms(), 0);
        assert.strictEqual(await page.$eval('.ProseMirror p', el => el.textContent), 'Glad to see you :)Z here.');
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you :)Z here.\n');
    });

    test('the hint goes with the next change: Ctrl+Z gives the emoji back and takes the hint away', async function () {
        this.timeout(15000);
        await showDocument('Glad to see you :) here.\n', 'Glad');
        await caretAfterAtom();
        await page.keyboard.type('Z');
        await settle();
        assert.strictEqual((await hint()).shown, true);
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you :)Z here.\n');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
        await delay(80);
        assert.strictEqual((await hint()).shown, false, 'the hint is stale once the document changed');
        assert.strictEqual(await atoms(), 1);
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you :) here.\n');
    });

    test('reached by the arrow keys the emoji is selected, and a key typed then takes its place', async function () {
        this.timeout(15000);
        await showDocument('Glad to see you :) here.\n', 'Glad');
        await caretAfterAtom();
        await page.keyboard.press('ArrowLeft');
        await delay(80);
        assert.strictEqual(await page.$eval('.ProseMirror .mep-emoji', el => el.classList.contains('ProseMirror-selectednode')), true, 'the arrow selects it');
        await page.keyboard.type('k');
        await settle();
        assert.strictEqual(await atoms(), 0);
        assert.strictEqual((await lastEdit())?.text, 'Glad to see you k here.\n');
    });

    test('its states, shot in light and dark: rest, hover, selected with the bar, after Edit as text, the hint, a full line, the arrow keys', async function () {
        this.timeout(90000);
        const themes: [Theme, string][] = [[LIGHT_MODERN, 'light'], [DARK_MODERN, 'dark']];
        const long = 'The sentence runs on long enough that the editor wraps it onto a second line, and there the emoji :) stands '
            + 'with more words after it, so that the line it is on is full and the bar has to find a place beside it.\n';
        for (const [theme, name] of themes) {
            await applyTheme(page, theme);
            await showDocument('Glad to see you :) here, and :smile: there.\n', 'Glad');
            await shot(page, `emoji-${name}-1-rest.png`);
            const box = await atomBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await delay(1200);
            assert.strictEqual(await page.$eval('.ProseMirror .mep-emoji:hover', el => (el as HTMLElement).title), 'Emoji :) — kept as written', 'the pointer rests on it');
            // No shot of the hover: the tooltip is the browser's, which a screenshot does not show, and the arrow is the page's.
            await pickAtom();
            await delay(300);
            await shot(page, `emoji-${name}-3-selected-bar.png`);
            await clickVerb('edit-emoji-as-text');
            await delay(200);
            await shot(page, `emoji-${name}-4-edit-as-text.png`);
            await clearHint();
            await showDocument('Glad to see you :) here, and :smile: there.\n', 'Glad');
            await caretAfterAtom();
            await page.keyboard.type('Z');
            await delay(150);
            assert.strictEqual((await hint()).text, `:)Z is no longer an emoji — ${undoKey()}`);
            await shot(page, `emoji-${name}-5-hint.png`);
            await clearHint();
            await showDocument(long, 'The sentence');
            await pickAtom();
            await delay(300);
            await shot(page, `emoji-${name}-6-full-line-bar.png`);
            await clearHint();
            await showDocument('Glad to see you :) here, and :smile: there.\n', 'Glad');
            await caretAfterAtom();
            await page.keyboard.press('ArrowLeft');
            await delay(300);
            await shot(page, `emoji-${name}-7-arrow-selected.png`);
            await page.keyboard.type('k');
            await delay(300);
            await shot(page, `emoji-${name}-8-arrow-typed.png`);
            await clearHint();
        }
        await applyTheme(page, LIGHT_MODERN);
    });
});
