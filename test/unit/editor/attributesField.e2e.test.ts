import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { ATTRIBUTES_REMOVED_HINT } from '../../../src/editor/webview/attributes';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import { closeEditorPage, delay, describedTip, hoverTip, EditMessage, EditorPage, EXTENSION_ID, MOD, openEditorPage, pointAt, settle, shot, UNDO } from './pageHarness';
import { DARK_MODERN, HC_DARK, LIGHT_MODERN, Theme, applyTheme } from './themes';

/** The caret's bar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
/** The row's field bar. */
const ROW_FIELD = '.mep-object-toolbar[data-trigger="toolbar"]';
/** Whichever bar holds the open field. */
const ANY_FIELD_BAR = '.mep-object-toolbar.mep-field-bar:not([hidden])';
const FORMATTING_ENTRY = '.mep-menu[data-menu="formatting"] [data-action="block-attributes"]';
const BLOCK_TYPE_ENTRY = '.mep-menu[data-menu="block-type"] [data-action="block-type-attributes"]';

const DOC = [
    'Requirement states are **configurable** for each project, and a paragraph can carry a class.',
    '',
    '> A warning to the reader.',
    '> {.warning #intro}',
    '',
    '| Name | Kind |',
    '| ----- | ----- |',
    '| **Alpha** | first |',
    '',
    'Some *italic*, _emphasis_ and __strong__ words.',
    '',
    'The last paragraph.',
    '',
].join('\n');

/** Literals written with spaces inside the braces, the way an author may: an unchanged field must leave them as they are. */
const SPACED_DOC = [
    'First paragraph. { .a }',
    '',
    'A **bold**{ .b } run.',
    '',
    'A [span]{ .s } run.',
    '',
    '> A quote.',
    '> { .q #long-identifier title="a rather long title that keeps the field wide" data-one=1 data-two=2 }',
    '',
    'The last paragraph.',
    '',
].join('\n');

const THEMES: readonly [string, Theme][] = [['light', LIGHT_MODERN], ['dark', DARK_MODERN], ['hc', HC_DARK]];

/** The open field's bar as the eye and a screen reader meet it. */
interface FieldState {
    heading: string;
    value: string;
    placeholder: string;
    selected: [number, number];
    focused: boolean;
    braces: { text: string; hidden: string | null; select: string }[];
    keys: string | null;
    keysCode: string[];
    keysRemoves: boolean;
    reason: string | null;
    reasonRole: string | null;
    describedBy: 'keys' | 'reason' | 'none' | 'other';
    invalid: string | null;
    frameBorder: { color: string; style: string; width: string };
    narrow: boolean;
    labelCut: boolean;
}

/**
 * The attributes field (wave 2 · #13) in the real page, every route to it:
 * the braces drawn by the field and never in the value, one outer pair
 * stripped on a paste or a typed `}`, a stray brace dropped on Enter; one
 * title `<Name> · Attributes`; a keys line that says what Enter does with the
 * value as typed; a refusal under the keys line, amber, cleared on the next
 * edit; the field at the element it edits; a narrow bar's second line. With
 * `MEP_SHOTS_DIR` set, the states are saved light, dark and High Contrast.
 */
suite('Attributes field (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    const showDocument = async (text: string = DOC) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('last paragraph'));
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

    const clickAt = async (needle: string, index = 0) => {
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

    const clickVerb = async (verb: string) => {
        const button = await page.waitForSelector(`${BAR} [data-verb="${verb}"]`, { visible: true, timeout: INLINE_DELAY_MS + 2000 });
        const box = await button?.boundingBox();
        assert.ok(box, `no box for ${verb}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForSelector(`${ANY_FIELD_BAR} .mep-inline-field`, { visible: true });
        await delay(80);
    };

    const openMenu = async (menu: 'formatting' | 'block-type') => {
        await page.click(`.mep-toolbar .mep-menu-face[data-menu="${menu}"]`);
        await page.waitForSelector(`.mep-menu[data-menu="${menu}"]:not([hidden])`);
    };

    const chooseEntry = async (menu: 'formatting' | 'block-type', entry: string) => {
        await openMenu(menu);
        await page.click(entry);
        await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { visible: true });
        await delay(80);
    };

    const field = (): Promise<FieldState> => page.evaluate(sel => {
        const bar = document.querySelector(sel) as HTMLElement;
        const input = bar.querySelector('.mep-inline-field') as HTMLInputElement;
        const keys = bar.querySelector(':scope > .mep-field-keys') as HTMLElement | null;
        const reason = bar.querySelector(':scope > .mep-field-refusal') as HTMLElement | null;
        const frame = bar.querySelector('.mep-attr-field') as HTMLElement;
        const label = bar.querySelector('.mep-object-label') as HTMLElement;
        const by = input.getAttribute('aria-describedby');
        const fs = getComputedStyle(frame);
        return {
            heading: label.textContent ?? '',
            value: input.value,
            placeholder: input.placeholder,
            selected: [input.selectionStart ?? -1, input.selectionEnd ?? -1] as [number, number],
            focused: document.activeElement === input,
            braces: Array.from(frame.querySelectorAll('.mep-attr-brace')).map(b => ({ text: b.textContent ?? '', hidden: b.getAttribute('aria-hidden'), select: getComputedStyle(b).userSelect })),
            keys: keys?.textContent ?? null,
            keysCode: Array.from(keys?.querySelectorAll('code') ?? []).map(c => c.textContent ?? ''),
            keysRemoves: keys?.classList.contains('mep-keys-removes') ?? false,
            reason: reason?.textContent ?? null,
            reasonRole: reason?.getAttribute('role') ?? null,
            describedBy: (by === null ? 'none' : by === keys?.id ? 'keys' : by === reason?.id ? 'reason' : 'other') as FieldState['describedBy'],
            invalid: input.getAttribute('aria-invalid'),
            frameBorder: { color: fs.borderTopColor, style: fs.borderTopStyle, width: fs.borderTopWidth },
            narrow: bar.classList.contains('mep-narrow'),
            labelCut: label.scrollWidth > label.clientWidth + 1,
        };
    }, ANY_FIELD_BAR);

    /** The open field's bar and the box of a run of text, in the viewport. */
    const boxes = (needle: string) => page.evaluate((sel, n) => {
        const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
        const root = document.querySelector('.ProseMirror') as HTMLElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(n);
            if (at >= 0) {
                const range = document.createRange();
                range.setStart(node, at);
                range.setEnd(node, at + n.length);
                const r = range.getBoundingClientRect();
                return { bar: { left: bar.left, top: bar.top, bottom: bar.bottom }, run: { left: r.left, top: r.top, bottom: r.bottom } };
            }
        }
        throw new Error(`no "${n}"`);
    }, ANY_FIELD_BAR, needle);

    /** `name` saved in every theme: the state is drawn again by the theme's variables, nothing re-run. */
    const shots = async (name: string, themes: readonly [string, Theme][] = THEMES) => {
        for (const [id, theme] of themes) {
            await applyTheme(page, theme);
            await delay(60);
            await shot(page, `${name}-${id}.png`);
        }
        await applyTheme(page, LIGHT_MODERN);
    };

    const width = async (w: number, h: number) => {
        await page.setViewport({ width: w, height: h });
        await delay(150);
    };

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 900, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    setup(async () => {
        await width(1280, 900);
        await applyTheme(page, LIGHT_MODERN);
    });

    teardown(async () => {
        await page.keyboard.press('Escape');
        await page.mouse.click(2, 890);
    });

    test('F1 Formatting → Attributes of Paragraph…: the braces drawn outside an empty value, `.class` its placeholder, one title, the keys line describing the field', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('configurable', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        const s = await field();
        assert.deepStrictEqual({ heading: s.heading, value: s.value, placeholder: s.placeholder, focused: s.focused }, { heading: 'Paragraph · Attributes', value: '', placeholder: '.class', focused: true });
        assert.deepStrictEqual(s.braces, [{ text: '{', hidden: 'true', select: 'none' }, { text: '}', hidden: 'true', select: 'none' }]);
        assert.strictEqual(s.keys, '↵ set · Esc cancel · .class #id key=value');
        assert.deepStrictEqual(s.keysCode, ['.class #id key=value'], 'the syntax in the code font');
        assert.strictEqual(s.describedBy, 'keys');
        assert.strictEqual(s.invalid, null);
        assert.strictEqual(s.labelCut, false);
        await shots('field-empty-1280');
    });

    test('F2 the quote\'s bar, Attributes…: its literal between the braces, selected whole; "empty removes" said; named Quote', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('warning to', 3);
        await clickVerb('block-attributes');
        const s = await field();
        assert.deepStrictEqual({ heading: s.heading, value: s.value, selected: s.selected, placeholder: s.placeholder }, { heading: 'Quote · Attributes', value: '.warning #intro', selected: [0, 15], placeholder: '' });
        assert.strictEqual(s.keys, '↵ set · Esc cancel · empty removes · .class #id key=value');
        await shots('field-prefilled-1280');
    });

    test('F3 a pasted {.x #y} and a typed {.lead} lose their outer braces, the caret at the end; Enter writes {.lead}', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('configurable', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        await page.evaluate(() => {
            const input = document.activeElement as HTMLInputElement;
            const data = new DataTransfer();
            data.setData('text/plain', '{.x #y}');
            // What a paste does to an input: the text goes in, then `input`.
            input.setRangeText('{.x #y}', input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end');
            input.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', dataTransfer: data, bubbles: true }));
        });
        let s = await field();
        assert.deepStrictEqual([s.value, s.selected], ['.x #y', [5, 5]]);
        await shots('field-pasted-1280', [['light', LIGHT_MODERN]]);
        await page.keyboard.down(MOD);
        await page.keyboard.press('a');
        await page.keyboard.up(MOD);
        await page.keyboard.type('{.lead');
        assert.strictEqual((await field()).value, '{.lead', 'one brace alone stays while typing');
        await page.keyboard.type('}');
        s = await field();
        assert.deepStrictEqual([s.value, s.selected], ['.lead', [5, 5]]);
        await shots('field-pasted-1280', [['dark', DARK_MODERN], ['hc', HC_DARK]]);
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('carry a class. {.lead}\n'), (await lastEdit())?.text);
    });

    test('F4 a stray brace is dropped on Enter: `.a}` and `{.a` both write {.a}', async function () {
        this.timeout(20000);
        for (const typed of ['.a}', '{.a']) {
            await showDocument();
            await clickAt('configurable', 3);
            await chooseEntry('formatting', FORMATTING_ENTRY);
            await page.keyboard.type(typed);
            await page.keyboard.press('Enter');
            await settle();
            assert.ok((await lastEdit())?.text.includes('carry a class. {.a}\n'), `${typed}: ${(await lastEdit())?.text}`);
        }
    });

    test('F5–F6 a refused value: the field kept with it, framed amber, the keys line kept, the reason under it; the next key clears it all', async function () {
        this.timeout(20000);
        await showDocument();
        const before = (await (editor as EditorPage).edits()).length;
        await clickAt('configurable', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        await page.keyboard.type('width = 300');
        await page.keyboard.press('Enter');
        await delay(150);
        let s = await field();
        assert.deepStrictEqual(
            { value: s.value, focused: s.focused, keys: s.keys !== null, invalid: s.invalid, describedBy: s.describedBy, role: s.reasonRole },
            { value: 'width = 300', focused: true, keys: true, invalid: 'true', describedBy: 'reason', role: null },
        );
        assert.strictEqual(s.reason, 'Not set: width = 300 has spaces around "=", so it would show as text. Write it as width=300.');
        assert.ok(!/\{width|300\}/.test(s.reason ?? ''), 'the value named without the braces the field draws');
        // D3 (#10): the values carried as parts, in the code font; the refusal component's bar, 3 px.
        assert.deepStrictEqual(await page.$eval(`${ANY_FIELD_BAR} .mep-field-refusal-text`, el => ({
            codes: Array.from(el.querySelectorAll('code')).map(c => c.textContent),
            bar: getComputedStyle(el).borderLeftWidth,
        })), { codes: ['width = 300', '=', 'width=300'], bar: '3px' });
        assert.strictEqual(s.frameBorder.color, await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--vscode-inputValidation-warningBorder').trim() || '#b89500';
            document.body.append(probe);
            const c = getComputedStyle(probe).color;
            probe.remove();
            return c;
        }), 'framed in the refusal\'s amber');
        const reasonBox = await page.$eval(`${ANY_FIELD_BAR} > .mep-field-refusal`, (el, sel) => {
            const r = el.getBoundingClientRect();
            const f = (document.querySelector(`${sel} .mep-attr-field`) as HTMLElement).getBoundingClientRect();
            return { top: r.top, fieldBottom: f.bottom };
        }, ANY_FIELD_BAR);
        assert.ok(reasonBox.top >= reasonBox.fieldBottom - 1, `the reason on a line of its own: ${JSON.stringify(reasonBox)}`);
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'nothing written');
        await shots('field-refused-1280');
        await applyTheme(page, HC_DARK);
        s = await field();
        assert.deepStrictEqual([s.frameBorder.style, s.frameBorder.width], ['dashed', '2px'], 'High Contrast: the form changes, not the colour alone');
        await applyTheme(page, LIGHT_MODERN);

        await page.keyboard.press('Backspace');
        await delay(80);
        s = await field();
        assert.deepStrictEqual({ reason: s.reason, invalid: s.invalid, describedBy: s.describedBy, style: s.frameBorder.style }, { reason: null, invalid: null, describedBy: 'keys', style: 'solid' });
        await shots('field-cleared-1280');
        await page.keyboard.press('Enter');
        await delay(150);
        assert.notStrictEqual((await field()).reason, null, 'Enter checks again');
    });

    test('F7–F8 the quote\'s literal emptied: "↵ removes … · Esc keeps them", no placeholder; Esc keeps it, Enter removes it in one undo step', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('warning to', 3);
        await clickVerb('block-attributes');
        await page.keyboard.press('Backspace');
        await delay(80);
        const s = await field();
        assert.deepStrictEqual({ keys: s.keys, code: s.keysCode, removes: s.keysRemoves, placeholder: s.placeholder, value: s.value }, {
            keys: '↵ removes .warning #intro · Esc keeps them', code: ['.warning #intro'], removes: true, placeholder: '', value: '',
        });
        const colours = await page.$eval(`${ANY_FIELD_BAR} > .mep-field-keys`, el => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--vscode-foreground)';
            el.append(probe);
            const text = getComputedStyle(probe).color;
            probe.remove();
            return [getComputedStyle(el).color, text];
        });
        assert.strictEqual(colours[0], colours[1], 'in the text\'s colour');
        await shots('field-emptied-1280');
        const before = (await (editor as EditorPage).edits()).length;
        await page.keyboard.press('Escape');
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'Esc keeps them');

        // Esc dismissed the quote's bar until the caret leaves it (wave 2 #9): Alt+Enter brings it back.
        await clickAt('warning to', 3);
        await pressAlt('Enter');
        await clickVerb('block-attributes');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok(!(await lastEdit())?.text.includes('{.warning'), (await lastEdit())?.text);
        assert.strictEqual(await page.$eval('.mep-hint', el => el.textContent), `${ATTRIBUTES_REMOVED_HINT} — ${UNDO}`);
        await page.keyboard.down(MOD);
        await page.keyboard.press('z');
        await page.keyboard.up(MOD);
        await settle();
        assert.ok((await lastEdit())?.text.includes('> {.warning #intro}'), `one undo step brings it back: ${(await lastEdit())?.text}`);
    });

    test('F9 a copy from the field holds the value as shown, without the braces', async function () {
        this.timeout(20000);
        await showDocument();
        // Through plain text first: what Esc dismissed stays dismissed until the caret has left the object, also across a document sent again.
        await clickAt('The last', 1);
        await clickAt('warning to', 3);
        await clickVerb('block-attributes');
        const copied = await page.evaluate(() => {
            const input = document.activeElement as HTMLInputElement;
            input.select();
            let text = '';
            const listen = (e: ClipboardEvent) => {
                text = (input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0));
                e.clipboardData?.setData('text/plain', text);
            };
            document.addEventListener('copy', listen, true);
            document.execCommand('copy');
            document.removeEventListener('copy', listen, true);
            return text;
        });
        assert.strictEqual(copied, '.warning #intro');
    });

    test('R1 the bold run\'s bar (Alt+Enter) → Attributes…: Bold · Attributes, the field at the run, not where the bar was', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('configurable', 3);
        await pressAlt('Enter');
        // A bare run has no literal to remove: its verb's tooltip does not say an empty value removes one, as its keys line does not.
        const bare = await describedTip(page, `${BAR} [data-verb="edit-attributes"]`);
        assert.ok(bare.includes('.class #id key=value') && !bare.includes('empty removes'), bare);
        await clickVerb('edit-attributes');
        const s = await field();
        assert.strictEqual(s.heading, 'Bold · Attributes');
        assert.ok(!(s.keys ?? '').includes('empty removes'), s.keys ?? 'no keys line');
        const b = await boxes('configurable');
        assert.ok(Math.abs(b.bar.left - b.run.left) <= 2, `at the run's start: ${JSON.stringify(b)}`);
        assert.ok(b.bar.top >= b.run.bottom - 1 || b.bar.bottom <= b.run.top + 1, `off the run's line: ${JSON.stringify(b)}`);
        await shots('routes-bar-1280', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
    });

    test('R1b the run that has a literal says an empty value removes it, in its verb\'s tooltip as in the keys line', async function () {
        this.timeout(20000);
        await showDocument(SPACED_DOC);
        await clickAt('bold', 1);
        await pressAlt('Enter');
        const tip = await describedTip(page, `${BAR} [data-verb="edit-attributes"]`);
        assert.ok(tip.includes('.class #id key=value; empty removes it'), tip);
        await clickVerb('edit-attributes');
        assert.ok(((await field()).keys ?? '').includes('empty removes'));
    });

    test('R2 the bubble\'s {…} over the bold run says what it does there, and over plain text', async function () {
        this.timeout(20000);
        await showDocument();
        const a = await pointAt(page, 'configurable', 0);
        const b = await pointAt(page, 'configurable', 11);
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        await page.mouse.move(b.x + 6, b.y, { steps: 4 });
        await page.mouse.up();
        await page.waitForSelector('.mep-bubble:not([hidden]) [data-action="attrs-bubble"]', { timeout: 3000 });
        const tip = await describedTip(page, '.mep-bubble [data-action="attrs-bubble"]');
        assert.strictEqual(tip, 'Attributes of Bold… — **text**{.class}\nOver plain text: Span with class… — [text]{.class}');
        // The bubble takes the pointer once its inert time is over (`placement.ts`).
        await delay(400);
        const shown = await hoverTip(page, '.mep-bubble [data-action="attrs-bubble"]');
        assert.ok(shown?.text.includes('Over plain text'), `the hover draws the note too: ${shown?.text}`);
        const noteCode = await page.$$eval('.mep-tooltip .mep-tip-note code', els => els.map(el => el.textContent));
        assert.deepStrictEqual(noteCode, ['[text]{.class}'], 'the note\'s syntax in the code font, as the line\'s is');
        await shots('routes-bubble-1280', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
    });

    test('R3–R4 Formatting keeps Attributes of Paragraph… after its divider; Block type gains it last, after a divider, the same card and field', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('configurable', 3);
        await openMenu('formatting');
        const formatting = await page.$eval(FORMATTING_ENTRY, el => ({ label: el.querySelector('.mep-entry-label')?.textContent, previous: (el.previousElementSibling as HTMLElement | null)?.dataset.action }));
        assert.deepStrictEqual(formatting, { label: 'Attributes of Paragraph…', previous: 'inline-attributes' });
        await page.hover(FORMATTING_ENTRY);
        await delay(500);
        await shots('routes-formatting-1280', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
        await page.keyboard.press('Escape');

        await openMenu('block-type');
        const entry = await page.$eval(BLOCK_TYPE_ENTRY, el => ({
            label: el.querySelector('.mep-entry-label')?.textContent ?? el.textContent,
            last: el.nextElementSibling === null,
            divider: el.previousElementSibling?.getAttribute('role') === 'separator' || (el.previousElementSibling?.className ?? '').includes('separator'),
            syntax: el.querySelector('.mep-entry-syntax')?.textContent,
            role: el.getAttribute('role'),
        }));
        assert.deepStrictEqual(entry, { label: 'Attributes of Paragraph…', last: true, divider: true, syntax: 'text {.class}', role: 'menuitem' });
        await page.hover(BLOCK_TYPE_ENTRY);
        await page.waitForSelector('.mep-preview-card[data-action="block-type-attributes"]:not([hidden])', { timeout: 2000 });
        await shots('routes-blocktype-1280', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
        await page.click(BLOCK_TYPE_ENTRY);
        await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { visible: true });
        assert.strictEqual((await field()).heading, 'Paragraph · Attributes');
        await page.keyboard.press('Escape');

        await clickAt('warning to', 3);
        await page.keyboard.press('Escape');
        await openMenu('block-type');
        assert.strictEqual(await page.$eval(`${BLOCK_TYPE_ENTRY} .mep-entry-label`, el => el.textContent), 'Attributes of Quote…');
    });

    test('R5 Attributes of Bold… on a table\'s bar opens Bold · Attributes; Italic, Emphasis and Strong runs title by their own names', async function () {
        this.timeout(30000);
        await showDocument();
        await clickAt('Alpha', 2);
        await pressAlt('Enter');
        await clickVerb('inline-attributes');
        assert.strictEqual((await field()).heading, 'Bold · Attributes');
        await page.keyboard.press('Escape');
        for (const [needle, name] of [['italic', 'Italic'], ['emphasis', 'Emphasis'], ['strong', 'Strong']]) {
            await clickAt(needle, 2);
            await pressAlt('Enter');
            await clickVerb('edit-attributes');
            const s = await field();
            assert.strictEqual(s.heading, `${name} · Attributes`);
            assert.strictEqual(s.labelCut, false);
            await page.keyboard.press('Escape');
            await delay(100);
        }
    });

    test('R6 the attributes input is named by its heading, whichever bar opened it: "Bold · Attributes", not "Attributes" alone', async function () {
        this.timeout(30000);
        const accessibleName = async (): Promise<string> => {
            const input = await page.waitForSelector(`${ANY_FIELD_BAR} .mep-inline-field`, { visible: true });
            assert.ok(input, 'the field input');
            const snapshot = await page.accessibility.snapshot({ root: input, interestingOnly: false });
            return snapshot?.name ?? '';
        };
        await showDocument();
        // A table's bar: "Attributes of Bold…" for the bold the caret is in.
        await clickAt('Alpha', 2);
        await pressAlt('Enter');
        await clickVerb('inline-attributes');
        assert.strictEqual(await accessibleName(), 'Bold · Attributes');
        await page.keyboard.press('Escape');
        await delay(100);
        // The formatting row's field bar.
        await clickAt('configurable', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        assert.strictEqual(await accessibleName(), 'Paragraph · Attributes');
    });

    test('N1–N2 at 420 the keys line goes under the field, the title whole; refused, the reason on a line of its own', async function () {
        this.timeout(20000);
        await width(420, 640);
        await showDocument();
        await clickAt('warning to', 3);
        await clickVerb('block-attributes');
        let s = await field();
        assert.strictEqual(s.narrow, true, 'the keys line wrapped: mep-narrow');
        assert.strictEqual(s.labelCut, false);
        const layout = await page.evaluate(sel => {
            const bar = document.querySelector(sel) as HTMLElement;
            const r = (q: string) => (bar.querySelector(q) as HTMLElement).getBoundingClientRect();
            const b = bar.getBoundingClientRect();
            return { keysTop: r(':scope > .mep-field-keys').top, fieldBottom: r('.mep-attr-field').bottom, keysWidth: r(':scope > .mep-field-keys').width, barWidth: b.width, barRight: b.right, window: window.innerWidth };
        }, ANY_FIELD_BAR);
        assert.ok(layout.keysTop >= layout.fieldBottom - 1, JSON.stringify(layout));
        assert.ok(layout.keysWidth >= layout.barWidth - 20, `the keys line full width: ${JSON.stringify(layout)}`);
        assert.ok(layout.barRight <= layout.window, `inside the window: ${JSON.stringify(layout)}`);
        await shots('narrow-prefilled-420', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
        await page.keyboard.press('End');
        await page.keyboard.type(' title="a');
        await page.keyboard.press('Enter');
        await delay(150);
        s = await field();
        assert.ok(s.reason?.includes('has an open quote'), s.reason ?? 'none');
        assert.strictEqual(s.labelCut, false);
        await shots('narrow-refused-420', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
    });

    test('R6 where the block type is locked (a table cell) the Block type face still opens: its types dimmed with the reason, Attributes of Table… enabled and working', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('first', 0);
        const face = await page.$eval('.mep-toolbar .mep-menu-face[data-menu="block-type"]', el => el.getAttribute('aria-disabled'));
        assert.strictEqual(face, 'false', 'the face opens: one of its entries applies');
        await openMenu('block-type');
        const entries = await page.$$eval('.mep-menu[data-menu="block-type"] .mep-menu-item', els => els.map(el => ({ id: (el as HTMLElement).dataset.action ?? '', disabled: el.getAttribute('aria-disabled'), reason: el.getAttribute('aria-description') ?? '' })));
        const types = entries.filter(e => e.id !== 'block-type-attributes');
        assert.ok(types.length > 5 && types.every(e => e.disabled === 'true' && e.reason !== ''), `every type drawn disabled, saying why: ${JSON.stringify(types)}`);
        const attrs = entries.find(e => e.id === 'block-type-attributes');
        assert.deepStrictEqual({ disabled: attrs?.disabled, reason: attrs?.reason }, { disabled: 'false', reason: '' }, 'the attributes entry keeps Formatting\'s state');
        await page.click(BLOCK_TYPE_ENTRY);
        await page.waitForSelector(`${ROW_FIELD} .mep-inline-field`, { visible: true });
        assert.strictEqual((await field()).heading, 'Table · Attributes');
    });

    /** What the caret hint says, or `''` while it is hidden. */
    const hintText = (): Promise<string> => page.$eval('.mep-hint', el => ((el as HTMLElement).hidden ? '' : el.textContent ?? ''));

    test('U1 Enter in a field left as it was commits nothing: no edit, no undo step, no hint — a literal spaced inside its braces stays spaced, on every route', async function () {
        this.timeout(40000);
        await showDocument(SPACED_DOC);
        const routes: [string, () => Promise<void>, string][] = [
            ['a block, from Formatting', async () => { await clickAt('First paragraph', 3); await chooseEntry('formatting', FORMATTING_ENTRY); }, ' .a '],
            ['a bold run, from its bar', async () => { await clickAt('bold', 2); await pressAlt('Enter'); await clickVerb('edit-attributes'); }, ' .b '],
            ['a span, from its bar', async () => { await clickAt('span', 2); await clickVerb('edit-attributes'); }, ' .s '],
        ];
        for (const [route, open, shown] of routes) {
            const before = (await (editor as EditorPage).edits()).length;
            await open();
            assert.strictEqual((await field()).value, shown, `${route}: the literal as it stands, spaces and all`);
            await page.keyboard.press('Enter');
            await settle();
            assert.strictEqual((await (editor as EditorPage).edits()).length, before, `${route}: nothing written`);
            assert.strictEqual(await page.$(ANY_FIELD_BAR), null, `${route}: the field is closed`);
            assert.ok(!(await hintText()).includes('Attributes set'), `${route}: no hint — ${await hintText()}`);
            await page.keyboard.press('Escape');
            await page.mouse.click(2, 890);
        }
        // Changed, it still commits: the spaces the author wrote are theirs to change.
        await clickAt('First paragraph', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        await page.keyboard.type('.x');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('First paragraph. {.x}'), (await lastEdit())?.text);
    });

    test('K1 a lone brace typed over an existing literal says Enter removes it, as it will', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('warning to', 3);
        await clickVerb('block-attributes');
        await page.keyboard.type('{');
        await delay(80);
        const s = await field();
        assert.deepStrictEqual({ keys: s.keys, removes: s.keysRemoves }, { keys: '↵ removes .warning #intro · Esc keeps them', removes: true });
    });

    test('M1 a refusal sets the values it names in muted mono and keeps its sentence plain; the line is capped near 80 characters and wraps', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('configurable', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        await page.keyboard.type('width = 300');
        await page.keyboard.press('Enter');
        await delay(150);
        const look = await page.$eval(`${ANY_FIELD_BAR} > .mep-field-refusal > .mep-field-refusal-text`, el => {
            const text = getComputedStyle(el);
            const bar = (el.closest('.mep-field-bar') as HTMLElement).getBoundingClientRect().width;
            const muted = document.createElement('span');
            muted.style.color = 'var(--vscode-descriptionForeground, GrayText)';
            el.append(muted);
            const mutedColour = getComputedStyle(muted).color;
            muted.remove();
            const eighty = document.createElement('span');
            eighty.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;width:80ch';
            el.append(eighty);
            const cap = eighty.getBoundingClientRect().width;
            eighty.remove();
            return {
                codes: Array.from(el.querySelectorAll('code')).map(c => ({ text: c.textContent, family: getComputedStyle(c).fontFamily, colour: getComputedStyle(c).color })),
                sentenceFamily: text.fontFamily,
                mutedColour,
                width: el.getBoundingClientRect().width,
                bar,
                height: el.getBoundingClientRect().height,
                lineHeight: parseFloat(text.lineHeight),
                cap,
            };
        });
        assert.deepStrictEqual(look.codes.map(c => c.text), ['width = 300', '=', 'width=300'], 'the typed value, the character it names (quoted) and the suggestion');
        assert.ok(look.codes.every(c => c.family !== look.sentenceFamily && c.colour === look.mutedColour), JSON.stringify(look));
        assert.ok(look.width <= look.cap + 1 && look.width > look.cap * 0.5, `capped at about 80 characters: ${look.width} against ${look.cap}`);
        const kids = await page.$eval(ANY_FIELD_BAR, el => Array.from(el.children).map(c => `${c.className}:${Math.round(c.getBoundingClientRect().width)}`).join(' | '));
        assert.ok(look.bar <= look.cap + 60, `the bar is not stretched by the reason: ${look.bar} against ${look.cap} — ${kids}`);
        assert.ok(look.height > look.lineHeight * 1.5, `the long reason wraps instead of stretching the bar: ${JSON.stringify(look)}`);
        await shots('field-refused-1280', [['light', LIGHT_MODERN], ['dark', DARK_MODERN], ['hc', HC_DARK]]);
    });

    test('B1 a block\'s attributes field stands at the block\'s left edge from every route; a mark\'s at its run', async function () {
        this.timeout(40000);
        const left = (selector: string) => page.$eval(selector, el => el.getBoundingClientRect().left);
        const barLeft = () => page.$eval(ANY_FIELD_BAR, el => el.getBoundingClientRect().left);
        // Each route from a document of its own: no bar, dismissal or menu left over from the one before.
        const routes: [string, string, () => Promise<void>][] = [
            ['Formatting, a paragraph', '.ProseMirror > p', async () => { await clickAt('configurable', 5); await chooseEntry('formatting', FORMATTING_ENTRY); }],
            ['Block type, a paragraph', '.ProseMirror > p', async () => { await clickAt('configurable', 5); await chooseEntry('block-type', BLOCK_TYPE_ENTRY); }],
            ['the quote\'s bar', '.ProseMirror > blockquote', async () => { await clickAt('warning to', 7); await clickVerb('block-attributes'); }],
            ['Formatting, a quote', '.ProseMirror > blockquote', async () => { await clickAt('warning to', 7); await chooseEntry('formatting', FORMATTING_ENTRY); }],
        ];
        for (const [route, block, open] of routes) {
            await showDocument();
            await open();
            const at = [await barLeft(), await left(block)];
            assert.ok(Math.abs(at[0] - at[1]) <= 2, `${route}: ${at}`);
            if (route === 'the quote\'s bar') {
                await shots('routes-bar-block-1280', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
            }
        }
        await showDocument();
        await clickAt('configurable', 3);
        await pressAlt('Enter');
        await clickVerb('edit-attributes');
        const b = await boxes('configurable');
        assert.ok(Math.abs(b.bar.left - b.run.left) <= 2, `a mark's field still at its run: ${JSON.stringify(b)}`);
    });

    test('B2 a heading\'s field from Formatting and from its bar stands at the same place where it flips above the heading', async function () {
        this.timeout(40000);
        // The heading last in a long page, scrolled to the window's foot (12px short of it): no room under it, so the field flips above
        // — to where the heading's text starts, whichever route opened it. A stylesheet's padding makes that differ from the box's top.
        const style = await page.addStyleTag({ content: '.ProseMirror h2 { padding-top: 24px; }' });
        const doc = [...Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i}.\n`), '## The last paragraph {.wide}', ''].join('\n');
        const open = async (route: () => Promise<void>) => {
            await showDocument(doc);
            await page.evaluate(() => {
                const h = document.querySelector('.ProseMirror h2') as HTMLElement;
                window.scrollTo(0, window.scrollY + h.getBoundingClientRect().bottom - window.innerHeight + 12);
            });
            await delay(300);
            await clickAt('The last paragraph', 4);
            await route();
            return page.$eval(ANY_FIELD_BAR, el => {
                const r = el.getBoundingClientRect();
                const h = document.querySelector('.ProseMirror h2') as HTMLElement;
                return { top: r.top, bottom: r.bottom, left: r.left, heading: h.getBoundingClientRect().top, floor: window.innerHeight };
            });
        };
        try {
            const fromMenu = await open(() => chooseEntry('formatting', FORMATTING_ENTRY));
            await page.keyboard.press('Escape');
            const fromBar = await open(() => clickVerb('block-attributes'));
            assert.ok(fromBar.top < fromBar.heading, `above the heading, as the bar flips: ${JSON.stringify(fromBar)}`);
            assert.ok(fromBar.bottom > fromBar.heading, `above its text, which the padding sets below the box's top: ${JSON.stringify(fromBar)}`);
            for (const key of ['top', 'bottom', 'left'] as const) {
                assert.ok(Math.abs(fromMenu[key] - fromBar[key]) <= 1, `${key}: from Formatting ${JSON.stringify(fromMenu)}, from the bar ${JSON.stringify(fromBar)}`);
            }
        } finally {
            await style.evaluate(el => el.remove());
        }
    });

    test('T1 a title left alone on its row takes its divider with it; beside the field it keeps it', async function () {
        this.timeout(30000);
        await showDocument(SPACED_DOC);
        const state = () => page.evaluate(sel => {
            const bar = document.querySelector(sel) as HTMLElement;
            const label = bar.querySelector('.mep-object-label') as HTMLElement;
            const box = bar.querySelector('.mep-attr-field') as HTMLElement;
            const divider = bar.querySelector('.mep-object-separator') as HTMLElement;
            return { alone: box.getBoundingClientRect().top >= label.getBoundingClientRect().bottom - 1, divider: getComputedStyle(divider).display };
        }, ANY_FIELD_BAR);
        await clickAt('First paragraph', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        const beside = await state();
        assert.deepStrictEqual(beside, { alone: false, divider: beside.divider }, 'beside the field at 1280');
        assert.notStrictEqual(beside.divider, 'none');
        await page.keyboard.press('Escape');
        await width(420, 640);
        await clickAt('A quote', 3);
        await clickVerb('block-attributes');
        const wide = await state();
        assert.deepStrictEqual(wide, { alone: true, divider: 'none' }, 'the long literal sends the field to a line of its own');
        await shots('narrow-title-alone-420', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
    });

    test('C1 a composition keeps its braces until it ends; the strip leaves the field\'s own undo working', async function () {
        this.timeout(20000);
        await showDocument();
        await clickAt('configurable', 3);
        await chooseEntry('formatting', FORMATTING_ENTRY);
        // An IME composes `{.a}` as one text: mid-composition nothing is stripped, at its end one pair is.
        await page.evaluate(() => {
            const input = document.activeElement as HTMLInputElement;
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            input.setRangeText('{.a}', 0, input.value.length, 'end');
            input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
        });
        assert.strictEqual((await field()).value, '{.a}', 'mid-composition');
        await page.evaluate(() => (document.activeElement as HTMLInputElement).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        assert.strictEqual((await field()).value, '.a', 'after it');
        // Typed with real keys: the closing brace strips the pair, and Ctrl+Z is the field's own — it undoes the strip, not the page's.
        await page.keyboard.down(MOD);
        await page.keyboard.press('a');
        await page.keyboard.up(MOD);
        await page.keyboard.type('{.lead}');
        assert.strictEqual((await field()).value, '.lead');
        const before = (await (editor as EditorPage).edits()).length;
        await page.keyboard.down(MOD);
        await page.keyboard.press('z');
        await page.keyboard.up(MOD);
        await delay(80);
        const undone = await field();
        assert.ok(undone.value !== '.lead' && undone.value.includes('.lead'), `the field's own undo took the strip back: ${undone.value}`);
        assert.strictEqual(undone.focused, true);
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'the document untouched');
    });

    test('N3 at 420 the Block type menu shows the entry inside the window', async function () {
        this.timeout(20000);
        await width(420, 640);
        await showDocument();
        await clickAt('configurable', 3);
        await openMenu('block-type');
        await page.hover(BLOCK_TYPE_ENTRY);
        await delay(400);
        const r = await page.$eval(BLOCK_TYPE_ENTRY, el => {
            el.scrollIntoView({ block: 'nearest' });
            const b = el.getBoundingClientRect();
            const m = (el.closest('.mep-menu') as HTMLElement).getBoundingClientRect();
            return { right: m.right, left: m.left, w: window.innerWidth, visible: b.height > 0 };
        });
        assert.ok(r.visible && r.left >= 0 && r.right <= r.w, JSON.stringify(r));
        await shots('narrow-blocktype-420', [['light', LIGHT_MODERN], ['dark', DARK_MODERN]]);
    });
});
