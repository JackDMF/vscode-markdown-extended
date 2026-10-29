import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { BACKTICK_INFO_REFUSAL, LANGUAGE_FOLLOWED_REFUSAL, LANGUAGE_WORD_REFUSAL, NO_FENCE_REFUSAL, shortFenceRefusal } from '../../../src/editor/fences';
import { NO_TARGET_HINT } from '../../../src/editor/verbs';
import { NESTED_CODE_ATTRS_REFUSAL } from '../../../src/editor/webview/objects';
import { saidText } from '../../../src/editor/tips';
import { LAYER_SELECTOR } from '../../../src/editor/webview/placement';
import { closeEditorPage, delay, describedTip, EditMessage, EditorPage, EXTENSION_ID, hoverTip, MOD, openEditorPage, pointAt, settle, shot, UNDO } from './pageHarness';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, applyTheme } from './themes';

/** The caret's bar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const FIELD = `${BAR} input.mep-inline-field`;
const LIST = '.mep-completions';

const WIDE = 1280;
const NARROW = 520;
const HEIGHT = 900;

const DOC = [
    'Run the check before you commit:',
    '',
    '```js {.numbered}',
    'import { check } from \'./check.js\';',
    '',
    'const result = await check(files);',
    '```',
    '',
    'The result lists each file it read.',
    '',
    '```json',
    '{ "files": 2 }',
    '```',
    '',
].join('\n');

const INDENTED = 'Run it from the shell:\n\n    echo hi\n\nThen read the log.\n';

/**
 * The code block as an object (wave 2 · #4), in the real page with the real
 * keyboard and mouse: its bar, Language… with its completions, Edit source on
 * the opening line, an indented block fenced on apply, Delete, the corner tag,
 * and `Alt+Enter` with nothing to act on. With `MEP_SHOTS_DIR` set, each named
 * state is saved light and dark, as the sketch's frames are named.
 */
suite('Code block (e2e)', () => {
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
            const hint = document.querySelector('.mep-hint') as HTMLElement | null;
            if (hint) {
                hint.hidden = true;
            }
            window.scrollTo(0, 0);
        });
        await delay(300);
    };

    const clickBefore = async (needle: string, index = 0) => {
        const p = await pointAt(page, needle, index);
        await page.mouse.click(p.x, p.y);
        await delay(80);
    };

    const pressAlt = async (key: puppeteer.KeyInput) => {
        await page.keyboard.down('Alt');
        await page.keyboard.press(key);
        await page.keyboard.up('Alt');
        await delay(150);
    };

    const undo = async () => {
        assert.match(UNDO, /\+Z$/);
        await page.keyboard.down(MOD);
        await page.keyboard.press('z');
        await page.keyboard.up(MOD);
        await settle();
    };

    const viewport = async (width: number) => {
        await page.setViewport({ width, height: HEIGHT });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await delay(80);
    };

    /** Both themes under one name: `<name>-light.png`, `<name>-dark.png`. */
    const shots = async (name: string) => {
        await shot(page, `${name}-light.png`);
        await applyTheme(page, DARK_MODERN);
        await shot(page, `${name}-dark.png`);
        await applyTheme(page, LIGHT_MODERN);
    };

    /** The caret's bar for the code block holding `needle`, by `Alt+Enter`. */
    const barFor = async (needle: string, index = 2) => {
        await clickBefore(needle, index);
        await pressAlt('Enter');
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        // Alt+Enter's first focus shows no hover (wave 4 #5b UX review 2): a hover is the pointer's, which the bar
        // takes once its inert time is over (`placement.ts`).
        await page.waitForSelector(`${BAR}:not([data-inert])`, { timeout: 2000 });
    };

    const clickVerb = async (verb: string) => {
        await page.click(`${BAR} [data-verb="${verb}"]`);
        await delay(150);
    };

    const bar = () => page.$eval(BAR, el => ({
        label: el.querySelector('.mep-object-label')?.textContent ?? '',
        verbs: Array.from(el.querySelectorAll('button[data-verb]')).map(b => (b as HTMLElement).dataset.verb),
        aria: el.getAttribute('aria-label') ?? '',
        focus: (document.activeElement as HTMLElement | null)?.dataset.verb ?? '',
    }));

    const field = () => page.$eval(FIELD, el => {
        const input = el as HTMLInputElement;
        const owner = input.closest('.mep-object-toolbar') as HTMLElement;
        return {
            heading: owner.querySelector('.mep-object-label')?.textContent ?? '',
            value: input.value,
            placeholder: input.placeholder,
            selected: input.selectionStart === 0 && input.selectionEnd === input.value.length && input.value.length > 0,
            keys: owner.querySelector('.mep-field-keys')?.textContent ?? '',
            refusal: owner.querySelector('.mep-field-refusal')?.textContent ?? '',
        };
    });

    const listed = () => page.$$eval(`${LIST} .mep-completion`, els => els.map(el => [
        el.querySelector('.mep-completion-label')?.textContent ?? '', el.querySelector('.mep-completion-detail')?.textContent ?? '',
    ]));

    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent ?? '', shown: !(el as HTMLElement).hidden, tone: (el as HTMLElement).dataset.tone }));

    /** Replace what the focused field holds by `text` and press Enter. */
    const typeInField = async (text: string, enter = true) => {
        await page.$eval(FIELD, el => (el as HTMLInputElement).select());
        await page.keyboard.press('Backspace');
        if (text !== '') {
            await page.keyboard.type(text);
        }
        if (enter) {
            await page.keyboard.press('Enter');
            await settle();
        }
    };

    /** The corner tag of the `index`th `pre`: its text and box, the pre's, the first line's top. */
    const tag = (index = 0) => page.evaluate(i => {
        const pre = document.querySelectorAll('.ProseMirror pre')[i] as HTMLElement;
        const style = getComputedStyle(pre, '::before');
        const box = pre.getBoundingClientRect();
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode();
        const range = document.createRange();
        if (first) {
            range.setStart(first, 0);
            range.setEnd(first, 1);
        }
        const line = range.getClientRects()[0];
        return {
            content: style.content,
            top: box.top + parseFloat(style.top || '0'),
            bottom: box.top + parseFloat(style.top || '0') + parseFloat(style.lineHeight || '0'),
            right: box.right - parseFloat(style.right || '0'),
            pre: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
            lineTop: line ? line.top : box.top,
            events: style.pointerEvents,
        };
    }, index);

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: WIDE, height: HEIGHT, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    teardown(async () => {
        if (page) {
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await applyTheme(page, LIGHT_MODERN);
            await viewport(WIDE);
        }
    });

    test('B1 a caret rest in a fence: its bar below the pre at its left, titled with the language and the literal', async function () {
        this.timeout(20000);
        await showDocument(DOC, 'result');
        await clickBefore('result', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const b = await bar();
        assert.strictEqual(b.label, 'Code block js {.numbered}');
        assert.deepStrictEqual(b.verbs, ['language', 'block-attributes', 'edit-source', 'delete-code-block']);
        assert.strictEqual(b.aria, 'Code block js {.numbered}, 4 actions, arrow keys to choose');
        const where = await page.evaluate(sel => {
            const pre = (document.querySelector('.ProseMirror pre') as HTMLElement).getBoundingClientRect();
            const el = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            return { below: el.top >= pre.bottom, atLeft: Math.abs(el.left - pre.left) < 2 };
        }, BAR);
        assert.deepStrictEqual(where, { below: true, atLeft: true });
        await shots('rest-1280');
    });

    test('B2 Alt+Enter at 520 px: Language… has the focus, the bar inside the editor', async function () {
        this.timeout(20000);
        await viewport(NARROW);
        await showDocument(DOC, 'result');
        await barFor('result');
        assert.strictEqual((await bar()).focus, 'language');
        const inside = await page.$eval(BAR, el => el.getBoundingClientRect().right <= document.documentElement.clientWidth - 16 + 0.5 && el.scrollWidth <= el.clientWidth + 1);
        assert.ok(inside, 'the bar within the layer edge, nothing drawn past it');
        await shots('rest-520');
    });

    test('L1 Language…: the language selected, the list at once — this document\'s first — and the keys', async function () {
        this.timeout(20000);
        await showDocument(DOC, 'result');
        await barFor('result');
        await page.keyboard.press('Enter');
        await page.waitForSelector(LIST, { visible: true, timeout: 2000 });
        const f = await field();
        assert.deepStrictEqual({ heading: f.heading, value: f.value, selected: f.selected, keys: f.keys },
            { heading: 'Code block · Language', value: 'js', selected: true, keys: '↵ set · Esc cancel · empty: no language' });
        const list = await listed();
        assert.deepStrictEqual(list.slice(0, 2), [['js', 'JavaScript · in this document'], ['json', 'JSON · in this document']]);
        await page.keyboard.press('Backspace');
        await delay(300);
        const all = await listed();
        assert.deepStrictEqual(all.slice(0, 2), [['js', 'JavaScript · in this document'], ['json', 'JSON · in this document']], 'emptied: the document\'s first');
        assert.ok(all.length > 100, `then every language highlight.js highlights (${all.length})`);
        await page.keyboard.type('j');
        await delay(300);
        await shots('language-1280');
        // At 520 px, opened there: a field is placed as it opens.
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await viewport(NARROW);
        await showDocument(DOC, 'result');
        await barFor('result');
        await page.keyboard.press('Enter');
        await page.waitForSelector(FIELD, { visible: true });
        await page.keyboard.type('j');
        await delay(300);
        const fits = await page.$eval(BAR, el => ({ right: el.getBoundingClientRect().right, edge: document.documentElement.clientWidth }));
        assert.ok(fits.right <= fits.edge, `the field's bar inside the window at ${NARROW} px: ${JSON.stringify(fits)}`);
        await shots('language-520');
    });

    test('L2 type "ty", ↓, Enter: only the first word changes; the title and the corner tag show it; no hint', async function () {
        this.timeout(20000);
        await showDocument('Text.\n\n```js title=x\ncode\n```\n\nAfter.\n', 'code');
        await barFor('code');
        await page.keyboard.press('Enter');
        await page.waitForSelector(FIELD, { visible: true });
        await page.keyboard.type('ty');
        await page.waitForFunction(() => document.querySelector('.mep-completions .mep-completion-label')?.textContent === 'typescript', { timeout: 2000 });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Text.\n\n```typescript title=x\ncode\n```\n\nAfter.\n');
        assert.strictEqual((await tag()).content, '"typescript"');
        assert.strictEqual((await hint()).shown, false, 'the change is on the page: no hint');
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        assert.strictEqual((await bar()).label, 'Code block typescript');
    });

    test('L3 Language… emptied: refused while other words follow; alone, the language goes and the corner tag with it', async function () {
        this.timeout(20000);
        await showDocument('Text.\n\n```js title=x\ncode\n```\n\nAfter.\n', 'code');
        await barFor('code');
        await page.keyboard.press('Enter');
        await page.waitForSelector(FIELD, { visible: true });
        await typeInField('');
        assert.strictEqual((await field()).refusal, LANGUAGE_FOLLOWED_REFUSAL, 'the next word would become the language');
        assert.strictEqual((await tag()).content, '"js"', 'nothing changed');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        await showDocument('Text.\n\n```js {.n}\ncode\n```\n\nAfter.\n', 'code');
        await barFor('code');
        await page.keyboard.press('Enter');
        await page.waitForSelector(FIELD, { visible: true });
        await typeInField('');
        assert.strictEqual((await lastEdit())?.text, 'Text.\n\n``` {.n}\ncode\n```\n\nAfter.\n');
        assert.strictEqual((await tag()).content, 'none', 'no language, no corner tag');
    });

    test('L4 Esc with the list open closes the list; Esc again closes the field and the bar, the focus in the text', async function () {
        this.timeout(20000);
        await showDocument(DOC, 'result');
        await barFor('result');
        await page.keyboard.press('Enter');
        await page.waitForSelector(LIST, { visible: true, timeout: 2000 });
        await page.keyboard.press('Escape');
        await delay(100);
        assert.strictEqual(await page.$(LIST), null, 'the list closed');
        assert.ok(await page.$(FIELD), 'the field still open');
        await page.keyboard.press('Escape');
        await delay(200);
        assert.strictEqual(await page.$(FIELD), null, 'the field closed');
        assert.strictEqual(await page.$(BAR), null, 'the slot dismissed');
        assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 'the focus in the text');
    });

    test('L5 Language… on an indented block fences it, the hint says so, and the key it names restores it', async function () {
        this.timeout(20000);
        await showDocument(INDENTED, 'echo');
        await barFor('echo');
        assert.strictEqual((await bar()).label, 'Indented code block');
        assert.match(await describedTip(page, `${BAR} [data-verb="language"]`), /setting one makes the block fenced/);
        const tip = await hoverTip(page, `${BAR} [data-verb="language"]`);
        assert.ok(tip, 'the tooltip on Language…');
        await shots('indented-1280');
        await page.mouse.move(2, 2);
        await page.focus(`${BAR} [data-verb="language"]`);
        await page.keyboard.press('Enter');
        await page.waitForSelector(FIELD, { visible: true });
        await typeInField('sh');
        assert.strictEqual((await lastEdit())?.text, 'Run it from the shell:\n\n```sh\necho hi\n```\n\nThen read the log.\n');
        const h = await hint();
        assert.strictEqual(h.text, `Code block fenced — ${UNDO}`);
        await undo();
        assert.strictEqual((await lastEdit())?.text, INDENTED);
    });

    test('S1-S2 Edit source: the opening line, selected, and what is typed is the file\'s opening line', async function () {
        this.timeout(20000);
        await showDocument(DOC, 'result');
        await barFor('result');
        await clickVerb('edit-source');
        await page.waitForSelector(FIELD, { visible: true });
        const f = await field();
        assert.deepStrictEqual({ heading: f.heading, value: f.value, selected: f.selected, keys: f.keys },
            { heading: 'Code block · Opening line', value: '```js {.numbered}', selected: true, keys: '↵ set · Esc cancel · fence, info, {…}' });
        await shots('source-1280');
        await typeInField('~~~~ts {.x}');
        const lines = ((await lastEdit())?.text ?? '').split('\n');
        assert.strictEqual(lines[2], '~~~~ts {.x}');
        assert.strictEqual(lines[6], '~~~~');
    });

    test('S3 refused opening lines keep the field, with the reason', async function () {
        this.timeout(30000);
        await showDocument('Text.\n\n````md\nA fence inside:\n```\nx\n```\n````\n\nAfter.\n', 'inside');
        await barFor('inside');
        await clickVerb('edit-source');
        await page.waitForSelector(FIELD, { visible: true });
        const refused = async (typed: string) => {
            await typeInField(typed);
            const f = await field();
            assert.strictEqual(f.value, typed, 'what was typed is kept');
            return f.refusal;
        };
        assert.strictEqual(await refused('md {.x}'), NO_FENCE_REFUSAL);
        assert.strictEqual(await refused('``'), NO_FENCE_REFUSAL);
        assert.strictEqual(await refused('```md'), shortFenceRefusal('````'));
        assert.strictEqual(await refused('````a`b'), BACKTICK_INFO_REFUSAL);
        assert.match(await refused('````md {.}'), /\{\.\} isn't an attribute/);
    });

    test('S4 Edit source on an indented block opens empty with a ``` placeholder; Enter fences it', async function () {
        this.timeout(20000);
        await showDocument(INDENTED, 'echo');
        await barFor('echo');
        await clickVerb('edit-source');
        await page.waitForSelector(FIELD, { visible: true });
        const f = await field();
        assert.deepStrictEqual({ heading: f.heading, value: f.value, placeholder: f.placeholder }, { heading: 'Indented code block · Opening line', value: '', placeholder: '```' });
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Run it from the shell:\n\n```\necho hi\n```\n\nThen read the log.\n');
        assert.strictEqual((await hint()).text, `Code block fenced — ${UNDO}`);
    });

    test('S5 Attributes… on an indented block is offered; {.x} fences it, one undo step', async function () {
        this.timeout(20000);
        await showDocument(INDENTED, 'echo');
        await barFor('echo');
        const disabled = await page.$eval(`${BAR} [data-verb="block-attributes"]`, el => el.getAttribute('aria-disabled'));
        assert.notStrictEqual(disabled, 'true');
        assert.match(await describedTip(page, `${BAR} [data-verb="block-attributes"]`), /Setting one makes the block fenced\./);
        await clickVerb('block-attributes');
        await page.waitForSelector(FIELD, { visible: true });
        await typeInField('{.x}');
        assert.strictEqual((await lastEdit())?.text, 'Run it from the shell:\n\n``` {.x}\necho hi\n```\n\nThen read the log.\n');
        assert.strictEqual((await hint()).text, `Code block fenced — ${UNDO}`);
        await undo();
        assert.strictEqual((await lastEdit())?.text, INDENTED);
    });

    test('S6 a block whose text grew a ``` line: Edit source shows, and Language… saves, the fence the file holds', async function () {
        this.timeout(30000);
        await showDocument('Text.\n\n```js\ncode\n```\n\nAfter.\n', 'code');
        await clickBefore('code', 3);
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('```');
        await delay(400);
        await pressAlt('Enter');
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        await clickVerb('edit-source');
        await page.waitForSelector(FIELD, { visible: true });
        assert.strictEqual((await field()).value, '````js', 'the opening line the file will hold, not the fence the block was opened with');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await pressAlt('Enter');
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        await clickVerb('language');
        await page.waitForSelector(FIELD, { visible: true });
        await typeInField('ts');
        assert.strictEqual((await field().catch(() => null)), null, 'accepted: the field closed, nothing refused');
        assert.strictEqual((await lastEdit())?.text, 'Text.\n\n````ts\ncode\n```\n````\n\nAfter.\n');
    });

    test('S7 Language… takes one word: a space or a brace is refused, pointing to Edit source; what was typed stays', async function () {
        this.timeout(20000);
        await showDocument('Text.\n\n```js title=x\ncode\n```\n\nAfter.\n', 'code');
        await barFor('code');
        await page.keyboard.press('Enter');
        await page.waitForSelector(FIELD, { visible: true });
        for (const typed of ['ts title=y', 'ts{.x}']) {
            await typeInField(typed);
            const f = await field();
            assert.deepStrictEqual({ value: f.value, refusal: f.refusal }, { value: typed, refusal: LANGUAGE_WORD_REFUSAL });
        }
        assert.match(LANGUAGE_WORD_REFUSAL, /Edit source/);
        await shots('language-refused-1280');
    });

    test('S8 a field opened from a block\'s bar opens where that bar stands, under the block', async function () {
        this.timeout(30000);
        for (const verb of ['language', 'edit-source']) {
            await showDocument(DOC, 'result');
            // Through plain text first: what Esc dismissed stays dismissed until the caret has left the object, also across a document sent again.
            await clickBefore('Run', 1);
            await clickBefore('result', 2);
            await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
            await delay(400);
            const rect = () => page.evaluate(sel => {
                const r = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
                const pre = (document.querySelector('.ProseMirror pre') as HTMLElement).getBoundingClientRect();
                return { left: r.left, top: r.top, preBottom: pre.bottom, preLeft: pre.left };
            }, BAR);
            const stood = await rect();
            await clickVerb(verb);
            await page.waitForSelector(FIELD, { visible: true });
            await delay(300);
            const opened = await rect();
            assert.ok(Math.abs(opened.top - stood.top) <= 2, `${verb}: the field's top ${opened.top} within the bar's place ${stood.top}`);
            assert.ok(Math.abs(opened.left - stood.left) <= 2, `${verb}: at the bar's left`);
            assert.ok(opened.top >= opened.preBottom, `${verb}: under the block, not at the caret's line inside it`);
            await shot(page, `field-place-${verb}-1280.png`);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
        }
    });

    test('S9 the indented block\'s Language… tooltip draws the fence in the code font', async function () {
        this.timeout(20000);
        await showDocument(INDENTED, 'echo');
        await barFor('echo');
        await page.mouse.move(2, 2);
        const tip = await hoverTip(page, `${BAR} [data-verb="language"]`);
        assert.ok(tip, 'the tooltip shows');
        assert.strictEqual(tip.text, 'Language — setting one makes the block fenced (```); its text stays.');
        const parts = await page.$$eval('.mep-tooltip code', els => els.map(el => ({ text: el.textContent, mono: getComputedStyle(el).fontFamily, around: getComputedStyle(el.parentElement as HTMLElement).fontFamily })));
        assert.strictEqual(parts.length, 1, 'the fence is a code part of its own');
        assert.strictEqual(parts[0].text, '```');
        assert.notStrictEqual(parts[0].mono, parts[0].around, 'in the editor\'s code font, not the tooltip\'s');
        await shots('tooltip-fence-1280');
    });

    test('T3 a copy carries the block and its info string, not the editor\'s corner tag', async function () {
        this.timeout(20000);
        await showDocument(DOC, 'result');
        await clickBefore('result', 2);
        await page.keyboard.down(MOD);
        await page.keyboard.press('a');
        await page.keyboard.up(MOD);
        const html = await page.evaluate(() => {
            const data = new DataTransfer();
            (document.querySelector('.ProseMirror') as HTMLElement).dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
            return data.getData('text/html');
        });
        assert.ok(/<pre[^>]*data-params="js/.test(html), `the info string travels: ${html.slice(0, 300)}`);
        assert.ok(!html.includes('data-lang'), 'the corner tag is the editor\'s chrome');
        assert.strictEqual((await tag(0)).content, '"js"', 'and still shows in the editor');
    });

    test('D1 Delete code block: the block goes, the hint names the key, the key restores it', async function () {
        this.timeout(20000);
        await showDocument(DOC, 'result');
        await barFor('result');
        await clickVerb('delete-code-block');
        await settle();
        assert.ok(!((await lastEdit())?.text ?? '').includes('check(files)'), 'the block gone');
        assert.strictEqual((await hint()).text, `Code block deleted — ${UNDO}`);
        await shots('deleted-1280');
        await undo();
        assert.strictEqual((await lastEdit())?.text, DOC);
    });

    test('T1-T2 the corner tag: the language, inside the pre\'s top padding, inert; none without a language', async function () {
        this.timeout(20000);
        await showDocument(`${DOC}\n\`\`\`\nno language\n\`\`\`\n\n    indented\n`, 'indented');
        const t = await tag(0);
        assert.strictEqual(t.content, '"js"');
        assert.ok(t.bottom <= t.lineTop + 0.5, `above the first line: ${JSON.stringify(t)}`);
        assert.ok(t.top >= t.pre.top && t.right <= t.pre.right, `inside the pre: ${JSON.stringify(t)}`);
        assert.strictEqual(t.events, 'none');
        assert.strictEqual((await tag(1)).content, '"json"');
        assert.strictEqual((await tag(2)).content, 'none', 'a fence without a language');
        assert.strictEqual((await tag(3)).content, 'none', 'an indented block');
        const hit = await page.evaluate((x, y, layers) => {
            const el = document.elementFromPoint(x, y);
            const inside = Array.from(document.querySelectorAll('.ProseMirror pre')).reduce((n, pre) => n + pre.querySelectorAll(layers).length, 0);
            return { inPre: Boolean(el?.closest('pre')), layer: Boolean(el?.closest(layers)), layers: inside };
        }, t.right - 4, (t.top + t.bottom) / 2, LAYER_SELECTOR);
        assert.deepStrictEqual(hit, { inPre: true, layer: false, layers: 0 });
    });

    test('H1 Alt+Enter in plain text: the key is taken, the neutral hint at the caret, the caret and the focus stay; gone after 3 s', async function () {
        this.timeout(20000);
        await showDocument('Plain text with nothing to act on.\n', 'Plain');
        await clickBefore('nothing', 3);
        await page.evaluate(() => {
            (window as unknown as { altEnter: boolean | null }).altEnter = null;
            document.addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.altKey) {
                    (window as unknown as { altEnter: boolean | null }).altEnter = e.defaultPrevented;
                }
            });
        });
        const before = await page.evaluate(() => (document.getSelection() as Selection).focusOffset);
        await pressAlt('Enter');
        const h = await hint();
        assert.deepStrictEqual(h, { text: NO_TARGET_HINT, shown: true, tone: 'neutral' });
        const rows = await page.$eval('.mep-hint', el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return new Set(Array.from(range.getClientRects()).map(r => Math.round(r.top))).size;
        });
        assert.strictEqual(rows, 1, `the hint fits one line at ${WIDE} px`);
        assert.strictEqual(await page.evaluate(() => (window as unknown as { altEnter: boolean | null }).altEnter), true, 'default prevented');
        assert.strictEqual(await page.evaluate(() => (document.getSelection() as Selection).focusOffset), before, 'the caret stays');
        assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), 'the focus in the text');
        assert.strictEqual(await page.$(BAR), null, 'no bar');
        await shots('notarget-1280');
        await delay(3300);
        assert.strictEqual((await hint()).shown, false);
    });

    test('H3 Alt+Enter at an object whose bar cannot be drawn: the key is taken, and the hint says what the object is — not "no actions here", there was an object', async function () {
        this.timeout(20000);
        await showDocument('# Title\n\nText.\n', 'Title');
        await clickBefore('Title', 2);
        await page.evaluate(() => {
            (window as unknown as { altEnter: boolean | null }).altEnter = null;
            document.addEventListener('keydown', e => {
                if (e.key === 'Enter' && e.altKey) {
                    (window as unknown as { altEnter: boolean | null }).altEnter = e.defaultPrevented;
                }
            });
        });
        await pressAlt('Enter');
        assert.strictEqual(await page.$(BAR), null, 'a heading with no lenses has no bar');
        // The presentation's label, then its title (`ownPresentation`) — the label leads where the title does not name the object: "Heading 1: A heading."
        // A requirement heading's title names it already: "A requirement heading: its id and anchor are Req Explorer's."
        assert.deepStrictEqual(await hint(), { text: 'Heading 1: A heading.', shown: true, tone: 'neutral' }, 'the object\'s label and own title, neutral — not NO_TARGET_HINT');
        assert.notStrictEqual((await hint()).text, NO_TARGET_HINT);
        const rows = await page.$eval('.mep-hint', el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return new Set(Array.from(range.getClientRects()).map(r => Math.round(r.top))).size;
        });
        assert.strictEqual(rows, 1, 'the hint stays one line');
        assert.strictEqual(await page.evaluate(() => (window as unknown as { altEnter: boolean | null }).altEnter), true, 'the key is still taken');
    });

    test('H2 Alt+Enter in a fence inside a quote: the bar, Attributes… refused with the nested reason', async function () {
        this.timeout(20000);
        await showDocument('> ```js\n> inner\n> ```\n>\n> Quoted.\n\nAfter.\n', 'inner');
        await barFor('inner');
        const b = await bar();
        assert.deepStrictEqual(b.verbs, ['language', 'block-attributes', 'edit-source', 'delete-code-block']);
        assert.strictEqual(b.focus, 'language');
        assert.strictEqual(await page.$eval(`${BAR} [data-verb="block-attributes"]`, el => el.getAttribute('aria-disabled')), 'true');
        assert.ok((await describedTip(page, `${BAR} [data-verb="block-attributes"]`)).includes(saidText(NESTED_CODE_ATTRS_REFUSAL)));
    });

    test('H4 an indented block\'s title names Attributes… only where it is offered: not in a quote', async function () {
        this.timeout(30000);
        await showDocument('Text.\n\n    top block\n\nAfter.\n', 'top block');
        await barFor('top block');
        assert.strictEqual(await page.$eval(`${BAR} [data-verb="block-attributes"]`, el => el.getAttribute('aria-disabled')), 'false');
        const top = await describedTip(page, `${BAR} .mep-object-label`);
        assert.ok(top.includes('Language…, Attributes… or Edit source'), top);
        await showDocument('> Quoted.\n>\n>     nested block\n\nAfter.\n', 'nested block');
        await barFor('nested block');
        assert.strictEqual(await page.$eval(`${BAR} [data-verb="block-attributes"]`, el => el.getAttribute('aria-disabled')), 'true');
        const nested = await describedTip(page, `${BAR} .mep-object-label`);
        assert.ok(nested.includes('Language… or Edit source'), nested);
        assert.ok(!nested.includes('Attributes…'), nested);
    });

    // -- the table's active cell (the same item: the caret's place in a table, the tint on demand) --

    const TABLE_DOC = 'Intro paragraph.\n\n| Name  | Kind   | Count |\n| :---- | :----: | ----: |\n| Alpha | first  | 1     |\n| Beta  | second | 22    |\n\nAfter the table.\n';

    const tinted = (cls: string) => page.$$eval(`.ProseMirror .${cls}`, els => els.map(e => e.textContent ?? ''));

    /**
     * The caret into the cell at `needle`, through plain text first: what Esc dismissed stays dismissed
     * until the caret has left the object, also across a document sent again, so an earlier test's Esc
     * would keep this table's bar away.
     */
    const intoCell = async (needle: string) => {
        await clickBefore('Intro', 1);
        await clickBefore(needle, 1);
    };

    /** Until no layer ignores the pointer (`INERT_MS`): a hover before that reaches nothing. */
    const settledLayers = () => page.waitForFunction(() => document.querySelector('.mep-layer[data-inert]') === null, { timeout: 2000, polling: 20 });

    /** The tint once the view's microtask and its transaction have run. */
    const tintAfter = async (cls: string) => {
        await delay(120);
        return tinted(cls);
    };

    test('C1 the caret in a cell, the bar up: the cell ringed 2 px inside, no row or column tinted', async function () {
        this.timeout(20000);
        await showDocument(TABLE_DOC, 'Alpha');
        await intoCell('first');
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        assert.deepStrictEqual(await tinted('mep-cell-active'), ['first']);
        const ring = await page.$eval('.ProseMirror .mep-cell-active', el => getComputedStyle(el).boxShadow);
        assert.match(ring, /inset 0px 0px 0px 2px$|^rgb.*\) 0px 0px 0px 2px inset$/, ring);
        assert.deepStrictEqual(await tinted('mep-table-column'), []);
        assert.deepStrictEqual(await tinted('mep-table-row'), []);
        await shots('table-rest-1280');
    });

    test('C2 Row ▾ opened, focused or hovered tints the caret\'s row; closed, left and blurred, none', async function () {
        this.timeout(20000);
        await showDocument(TABLE_DOC, 'Alpha');
        await intoCell('first');
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        await settledLayers();
        const row = await page.$(`${BAR} [data-verb="row"]`);
        const box = await row?.boundingBox();
        assert.ok(box);
        // Hovered.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        assert.deepStrictEqual(await tintAfter('mep-table-row'), ['Alpha', 'first', '1']);
        await page.mouse.move(2, 2);
        assert.deepStrictEqual(await tintAfter('mep-table-row'), [], 'left: none');
        // Opened.
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(`${BAR} .mep-object-menu`, { visible: true, timeout: 2000 });
        await page.mouse.move(2, 2);
        assert.deepStrictEqual(await tintAfter('mep-table-row'), ['Alpha', 'first', '1'], 'its menu open');
        assert.deepStrictEqual(await tinted('mep-cell-active'), ['first'], 'the cell keeps its ring');
        await shots('table-row-1280');
        // Closed, the focus back on Row: still active (focused).
        await page.keyboard.press('Escape');
        await delay(80);
        assert.strictEqual(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.verb), 'row', 'Esc returns to Row');
        assert.deepStrictEqual(await tintAfter('mep-table-row'), ['Alpha', 'first', '1'], 'focused');
        await page.keyboard.press('ArrowRight');
        assert.deepStrictEqual(await tintAfter('mep-table-row'), [], 'focus moved on to Column');
        assert.deepStrictEqual(await tintAfter('mep-table-column'), ['Kind', 'first', 'second'], 'Column focused');
        await page.keyboard.press('Escape');
        await delay(150);
        assert.deepStrictEqual(await tintAfter('mep-table-row'), []);
        assert.deepStrictEqual(await tintAfter('mep-table-column'), []);
    });

    test('C3 Column ▾ or Align ▾ hovered tints the caret\'s column; the cell keeps its ring', async function () {
        this.timeout(20000);
        await showDocument(TABLE_DOC, 'Alpha');
        await intoCell('second');
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        await settledLayers();
        for (const verb of ['column', 'align']) {
            const box = await (await page.$(`${BAR} [data-verb="${verb}"]`))?.boundingBox();
            assert.ok(box);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            assert.deepStrictEqual(await tintAfter('mep-table-column'), ['Kind', 'first', 'second'], verb);
            assert.deepStrictEqual(await tinted('mep-table-row'), [], verb);
            assert.deepStrictEqual(await tinted('mep-cell-active'), ['second'], verb);
            await page.mouse.move(2, 2);
            assert.deepStrictEqual(await tintAfter('mep-table-column'), [], `${verb} left`);
        }
    });

    test('C3b a field opened while the pointer rests on Row: the row is not tinted for as long as the field is open', async function () {
        this.timeout(20000);
        await showDocument(TABLE_DOC, 'Alpha');
        await intoCell('first');
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        await settledLayers();
        const box = await (await page.$(`${BAR} [data-verb="row"]`))?.boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        assert.deepStrictEqual(await tintAfter('mep-table-row'), ['Alpha', 'first', '1'], 'hovered');
        // The keyboard opens Attributes… under the resting pointer: its field replaces the row, and no pointerleave comes.
        await page.$eval(`${BAR} [data-verb="block-attributes"]`, el => (el as HTMLElement).focus());
        await page.keyboard.press('Enter');
        await page.waitForSelector(FIELD, { visible: true, timeout: 2000 });
        assert.deepStrictEqual(await tintAfter('mep-table-row'), [], 'the hover went with the buttons');
        assert.deepStrictEqual(await tinted('mep-table-column'), []);
    });

    test('C4 a verb moved into "…" stays active there: its entry focused, or its menu open, tints the caret\'s column', async function () {
        this.timeout(60000);
        await showDocument(TABLE_DOC, 'Alpha');
        let moved = false;
        for (const width of [420, 380, 340, 300, 260, 220, 180]) {
            await viewport(width);
            await showDocument(TABLE_DOC, 'Alpha');
            await intoCell('second');
            await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
            await delay(300);
            moved = await page.$eval(`${BAR} [data-verb="align"]`, el => (el as HTMLElement).hidden);
            if (moved) {
                break;
            }
        }
        assert.ok(moved, 'a width at which Align has moved into "…"');
        assert.deepStrictEqual(await tintAfter('mep-table-column'), [], 'at rest: none');
        await page.click(`${BAR} .mep-object-more`);
        await page.waitForSelector(`${BAR} .mep-object-menu`, { visible: true, timeout: 2000 });
        const entry = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.entry ?? '');
        const focusEntry = async (id: string) => {
            for (let i = 0; i < 8 && (await entry()) !== id; i++) {
                await page.keyboard.press('ArrowDown');
            }
            assert.strictEqual(await entry(), id);
        };
        await focusEntry('align');
        assert.deepStrictEqual(await tintAfter('mep-table-column'), ['Kind', 'first', 'second'], 'its entry focused');
        assert.deepStrictEqual(await tinted('mep-table-row'), []);
        await shots('table-more-focus-420');
        await page.keyboard.press('ArrowDown');
        assert.notStrictEqual(await entry(), 'align');
        assert.deepStrictEqual(await tintAfter('mep-table-column'), [], 'another entry: none');
        await focusEntry('align');
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${BAR} .mep-object-menu [data-entry="align-left"]`, { visible: true, timeout: 2000 });
        assert.deepStrictEqual(await tintAfter('mep-table-column'), ['Kind', 'first', 'second'], 'its menu open under "…"');
        await page.keyboard.press('Escape');
        await delay(150);
        assert.deepStrictEqual(await tintAfter('mep-table-column'), [], 'closed: none');
    });

    test('C5 Row and Column menus keep the entry that takes something away apart, after a divider', async function () {
        this.timeout(20000);
        await showDocument(TABLE_DOC, 'Alpha');
        await intoCell('first');
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        await settledLayers();
        for (const [verb, doomed, others] of [['row', 'delete-row', ['insert-row-above', 'insert-row-below']], ['column', 'delete-column', ['insert-column-left', 'insert-column-right']]] as const) {
            await page.click(`${BAR} [data-verb="${verb}"]`);
            await page.waitForSelector(`${BAR} .mep-object-menu`, { visible: true, timeout: 2000 });
            const rules = await page.$eval(`${BAR} .mep-object-menu`, (menu, id, rest) => ({
                before: menu.querySelector(`[data-entry="${id}"]`)?.previousElementSibling?.getAttribute('role') ?? '',
                others: rest.map(other => menu.querySelector(`[data-entry="${other}"]`)?.previousElementSibling?.getAttribute('role') ?? ''),
            }), doomed, [...others]);
            assert.strictEqual(rules.before, 'separator', `${verb}: a divider before ${doomed}`);
            assert.ok(!rules.others.includes('separator'), `${verb}: none between the inserts`);
            if (verb === 'row') {
                await shots('table-row-menu-1280');
            }
            await page.keyboard.press('Escape');
            await delay(100);
        }
    });

    test('C6 the active cell\'s ring is not the focus outline\'s colour — dark and high contrast included', async function () {
        this.timeout(30000);
        await showDocument(TABLE_DOC, 'Alpha');
        await intoCell('first');
        await page.waitForSelector(BAR, { visible: true, timeout: 3000 });
        const colours = () => page.evaluate(() => {
            const ring = getComputedStyle(document.querySelector('.ProseMirror .mep-cell-active') as HTMLElement).boxShadow;
            const probe = document.createElement('span');
            probe.style.color = 'var(--vscode-focusBorder)';
            document.body.append(probe);
            const focus = getComputedStyle(probe).color;
            probe.remove();
            return { ring: /rgba?\([^)]*\)/.exec(ring)?.[0] ?? ring, focus };
        });
        for (const theme of [LIGHT_MODERN, DARK_MODERN, HC_DARK]) {
            await applyTheme(page, theme);
            await delay(150);
            const c = await colours();
            assert.notStrictEqual(c.ring, c.focus, `${theme.name}: the ring ${c.ring} is not the focus colour ${c.focus}`);
            if (theme === DARK_MODERN) {
                await shot(page, 'table-rest-dark-1280.png');
            }
            if (theme === HC_DARK) {
                await shot(page, 'table-rest-hc-1280.png');
            }
        }
    });
});
