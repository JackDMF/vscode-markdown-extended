import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import { ATTRIBUTES_FIELD_KEYS, ATTRIBUTES_REMOVED_HINT, ATTRIBUTES_SET_HINT } from '../../../src/editor/webview/attributes';
import { CONTAINER_ATTRS_REFUSAL } from '../../../src/editor/webview/objects';
import { INLINE_DELAY_MS } from '../../../src/editor/webview/objectToolbar';
import type { WebviewMessage } from '../../../src/editor/protocol';
import { closeEditorPage, EXTENSION_ID, EditMessage, EditorPage, openEditorPage, settle } from './pageHarness';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const TABLE = [
    '| Name  | Kind  |',
    '| ----- | ----- |',
    '| Alpha | first |',
].join('\n');

const DOC = [
    '## Overview',
    '',
    'Requirement states are configurable, and a paragraph can carry a class of its own.',
    '',
    TABLE,
    '',
    '<div>Raw HTML, kept as source.</div>',
    '',
    '::: box',
    'Inside the container.',
    ':::',
    '',
    'The last paragraph.',
    '',
].join('\n');

/** VS Code's default light theme as a webview receives it, and a stylesheet naming `.note`, `.wide` — what a class set here looks like. */
const PAGE_STYLE = `
:root {
    --vscode-font-family: -apple-system, "Segoe WPC", "Segoe UI", sans-serif;
    --vscode-font-size: 13px;
    --vscode-editor-font-family: Consolas, "Courier New", monospace;
    --vscode-editor-background: #ffffff;
    --vscode-editor-foreground: #3b3b3b;
    --vscode-foreground: #3b3b3b;
    --vscode-descriptionForeground: #3b3b3b;
    --vscode-focusBorder: #005fb8;
    --vscode-editorWidget-background: #f8f8f8;
    --vscode-editorWidget-border: #e5e5e5;
    --vscode-widget-shadow: rgba(0, 0, 0, 0.16);
    --vscode-menu-background: #ffffff;
    --vscode-menu-border: #cecece;
    --vscode-menu-selectionBackground: #005fb8;
    --vscode-menu-selectionForeground: #ffffff;
    --vscode-toolbar-hoverBackground: rgba(184, 184, 184, 0.31);
    --vscode-editor-selectionBackground: #add6ff;
    --vscode-editorWarning-foreground: #bf8803;
}
body {
    background-color: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
}
.markdown-body .note { border-left: 4px solid #005fb8; background: #eef5fc; padding: 6px 12px; }
.markdown-body h2.wide { letter-spacing: 0.08em; }`;

/** With `MEP_SHOTS_DIR` set, the suite saves a screenshot of each state it names there; without it, none. */
const SHOTS = process.env.MEP_SHOTS_DIR;

const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';
const FIELD_BAR = '.mep-object-toolbar[data-trigger="toolbar"]';
const FIELD = `${FIELD_BAR} .mep-inline-field`;
const ENTRY = '.mep-menu [data-action="block-attributes"]';

/**
 * **Formatting → Attributes…** and the bars' verb of the same name in the real
 * page: the field opens at the block the caret is in, named after it,
 * prefilled `{.}`; `Enter` writes the literal where markdown-it-attrs reads it
 * for that block and the page draws the class at once; `Esc` changes nothing;
 * where no literal can go, the entry is disabled and says why.
 */
suite('Editor Attributes… (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();

    const shot = async (name: string) => {
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, name) });
        }
    };

    const showDocument = async (text: string) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes: false });
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

    /** A real click just inside the left edge of character `index` of `needle`. */
    const clickAt = async (needle: string, index = 0) => {
        const p = await page.evaluate((n, k) => {
            const root = document.querySelector('.ProseMirror') as HTMLElement;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const at = (node.textContent ?? '').indexOf(n);
                if (at >= 0) {
                    const range = document.createRange();
                    range.setStart(node, at + k);
                    range.setEnd(node, at + k + 1);
                    const r = range.getBoundingClientRect();
                    return { x: r.left + 1, y: r.top + r.height / 2 };
                }
            }
            throw new Error(`no "${n}" in the document`);
        }, needle, index);
        await page.mouse.click(p.x, p.y);
        await delay(80);
    };

    const openFormatting = async () => {
        await page.click('.mep-toolbar .mep-menu-face[data-menu="formatting"]');
        await page.waitForSelector('.mep-menu[data-menu="formatting"]:not([hidden])');
    };

    const entryState = () => page.$eval(ENTRY, el => ({ disabled: el.getAttribute('aria-disabled') === 'true', title: (el as HTMLElement).title }));

    const clickVerb = async (verb: string) => {
        const button = await page.waitForSelector(`${BAR} [data-verb="${verb}"]`, { visible: true, timeout: 2000 });
        const box = await button?.boundingBox();
        assert.ok(box, `no box for ${verb}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(80);
    };

    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent, tone: (el as HTMLElement).dataset.tone, shown: !(el as HTMLElement).hidden }));

    suiteSetup(async function () {
        this.timeout(60000);
        editor = await openEditorPage({ width: 1280, height: 800, styles: ['markdown-extended.css'] });
        if (!editor) {
            this.skip();
        }
        page = editor.page;
        await page.addStyleTag({ content: PAGE_STYLE });
    });

    suiteTeardown(async function () {
        await closeEditorPage(this, editor);
    });

    teardown(async () => {
        await page.keyboard.press('Escape');
        await page.mouse.click(1270, 790);
    });

    test('Formatting → Attributes… opens the field on the paragraph, named after it; Enter writes {.note} at its end and the page draws the class', async function () {
        this.timeout(15000);
        await showDocument(DOC);
        await clickAt('configurable', 3);
        await openFormatting();
        const entry = await page.$eval(ENTRY, el => ({
            label: el.querySelector('.mep-menu-label')?.textContent ?? el.textContent,
            previous: (el.previousElementSibling as HTMLElement | null)?.dataset.action,
            disabled: el.getAttribute('aria-disabled'),
        }));
        assert.ok(entry.label?.includes('Attributes…'), JSON.stringify(entry));
        assert.strictEqual(entry.previous, 'span-class', 'right after Span with class');
        assert.strictEqual(entry.disabled, 'false');
        await page.hover(ENTRY);
        await page.waitForSelector('.mep-preview-card[data-action="block-attributes"]:not([hidden])', { timeout: 2000 });
        await shot('01-formatting-menu-attributes.png');

        await page.click(ENTRY);
        await page.waitForSelector(FIELD, { visible: true });
        const opened = await page.evaluate(sel => {
            const input = document.querySelector(sel) as HTMLInputElement;
            return {
                heading: document.querySelector('.mep-object-toolbar[data-trigger="toolbar"] .mep-object-label')?.textContent,
                value: input.value,
                caret: [input.selectionStart, input.selectionEnd],
                focused: document.activeElement === input,
            };
        }, FIELD);
        assert.deepStrictEqual(opened, { heading: 'Paragraph · Attributes', value: '{.}', caret: [2, 2], focused: true });
        assert.strictEqual(await page.$eval(`${FIELD_BAR} .mep-field-keys`, el => el.textContent), ATTRIBUTES_FIELD_KEYS, 'the keys and the syntax at the field\'s right');
        const placed = await page.evaluate(sel => {
            const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const para = Array.from(document.querySelectorAll('.ProseMirror p')).find(p => p.textContent?.includes('configurable')) as HTMLElement;
            const r = para.getBoundingClientRect();
            return { barTop: bar.top, barBottom: bar.bottom, paraTop: r.top, paraBottom: r.bottom };
        }, FIELD_BAR);
        assert.ok(placed.barTop >= placed.paraTop - 60 && placed.barTop <= placed.paraBottom + 60, `at the paragraph: ${JSON.stringify(placed)}`);

        await page.keyboard.type('note-');
        await shot('02-field-on-paragraph.png');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Enter');
        await settle();
        const edit = await lastEdit();
        assert.ok(edit?.text.includes('a paragraph can carry a class of its own. {.note}\n'), edit?.text);
        assert.strictEqual(await page.$(FIELD), null, 'the field is gone');
        const drawn = await page.$eval('.ProseMirror p.note', el => ({ text: el.textContent, border: getComputedStyle(el).borderLeftWidth }));
        assert.ok(drawn.text?.startsWith('Requirement states'), JSON.stringify(drawn));
        assert.strictEqual(drawn.border, '4px', 'the page\'s stylesheet styles the class, as the preview does');
        assert.deepStrictEqual(await hint(), { text: `${ATTRIBUTES_SET_HINT} — Ctrl+Z`, tone: 'neutral', shown: true });
        await shot('03-paragraph-with-class.png');

        // The same entry again: prefilled with the literal, `{}` removes it.
        await clickAt('configurable', 3);
        await openFormatting();
        await page.click(ENTRY);
        await page.waitForSelector(FIELD, { visible: true });
        assert.strictEqual(await page.$eval(FIELD, el => (el as HTMLInputElement).value), '{.note}');
        await page.keyboard.type('{}');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes('a paragraph can carry a class of its own.\n'), (await lastEdit())?.text);
        assert.strictEqual(await page.$('.ProseMirror p.note'), null);
        assert.strictEqual((await hint()).text, `${ATTRIBUTES_REMOVED_HINT} — Ctrl+Z`);
    });

    test('a plain heading grows no bar for Attributes… alone; with another extension\'s action its bar carries it first, and the literal goes at the end of its line', async function () {
        this.timeout(15000);
        await showDocument(DOC);
        await clickAt('Overview', 3);
        await delay(INLINE_DELAY_MS + 200);
        assert.strictEqual(await page.$(BAR), null, 'no bar whose one verb is Attributes…');
        const asked = (await (editor as EditorPage).posted())
            .filter((m): m is Extract<WebviewMessage, { type: 'actionsFor' }> => m.type === 'actionsFor');
        const request = asked[asked.length - 1];
        assert.strictEqual(request?.blockIndex, 0, 'the heading\'s actions were asked for');
        await (editor as EditorPage).send({
            type: 'actions', requestId: request.requestId, blockIndex: 0, items: [{ id: 'q.0', title: 'Quick fix', kind: 'quickfix' }],
        });
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
        const verbs = await page.$$eval(`${BAR} button[data-verb]`, vs => vs.map(v => [(v as HTMLElement).dataset.verb, v.textContent]));
        assert.deepStrictEqual(verbs, [['block-attributes', 'Attributes…'], ['code-action:q.0', 'Quick fix']]);
        await shot('04-heading-bar-attributes.png');
        await clickVerb('block-attributes');
        const field = `${BAR} .mep-inline-field`;
        await page.waitForSelector(field, { visible: true });
        assert.deepStrictEqual(await page.$eval(field, el => [(el as HTMLInputElement).value, (el as HTMLInputElement).selectionStart]), ['{.}', 2]);
        await page.keyboard.type('wide');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.startsWith('## Overview {.wide}\n'), (await lastEdit())?.text);
        assert.strictEqual(await page.$eval('.ProseMirror h2', el => el.className), 'wide');
    });

    test('a table\'s bar carries Attributes…: the literal is a line of its own under a blank line after the table', async function () {
        this.timeout(15000);
        await showDocument(DOC);
        await clickAt('first', 2);
        await page.waitForSelector(BAR, { visible: true, timeout: INLINE_DELAY_MS + 2000 });
        await clickVerb('block-attributes');
        await page.waitForSelector(`${BAR} .mep-inline-field`, { visible: true });
        await page.keyboard.type('wide');
        await page.keyboard.press('Enter');
        await settle();
        assert.ok((await lastEdit())?.text.includes(`${TABLE}\n\n{.wide}\n\n<div>`), (await lastEdit())?.text);
        assert.strictEqual(await page.$eval('.ProseMirror table', el => el.classList.contains('wide')), true);
    });

    test('Esc cancels: nothing is written, the field goes and the caret is back in the text', async function () {
        this.timeout(15000);
        await showDocument(DOC);
        const before = (await (editor as EditorPage).edits()).length;
        await clickAt('last paragraph', 2);
        await openFormatting();
        await page.click(ENTRY);
        await page.waitForSelector(FIELD, { visible: true });
        await page.keyboard.type('note');
        await page.keyboard.press('Escape');
        await settle();
        assert.strictEqual((await (editor as EditorPage).edits()).length, before, 'no edit');
        assert.strictEqual(await page.$(FIELD), null);
        assert.strictEqual(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror')), true);
    });

    test('where no literal can go the entry is disabled and says why: a source block, a container', async function () {
        this.timeout(15000);
        await showDocument(DOC);
        const raw = await page.$('.ProseMirror > .mep-raw-block');
        const box = await raw?.boundingBox();
        assert.ok(box);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(150);
        const onRaw = await entryState();
        assert.strictEqual(onRaw.disabled, true);
        assert.match(onRaw.title, /source block is edited as Markdown/);

        await clickAt('Inside the container', 3);
        await openFormatting();
        const inContainer = await entryState();
        assert.strictEqual(inContainer.disabled, true);
        assert.ok(inContainer.title.includes(CONTAINER_ATTRS_REFUSAL), inContainer.title);
        await page.hover(ENTRY);
        await page.waitForSelector('.mep-preview-card[data-action="block-attributes"]:not([hidden]) .mep-preview-refusal', { timeout: 2000 });
        assert.strictEqual(await page.$eval('.mep-preview-card .mep-preview-refusal', el => el.textContent), CONTAINER_ATTRS_REFUSAL);
        await shot('05-disabled-entry-reason.png');
        await page.click(ENTRY);
        await delay(100);
        assert.strictEqual(await page.$(FIELD), null, 'a disabled entry opens nothing');
    });
});
