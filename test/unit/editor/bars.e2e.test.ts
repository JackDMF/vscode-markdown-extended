import * as assert from 'assert';
import * as puppeteer from 'puppeteer';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { parseDocument, parsedDocumentToJSON } from '../../../src/editor/parse';
import * as vscode from 'vscode';
import { lensRows } from '../../../src/editor/host/lenses';
import { WebviewMessage } from '../../../src/editor/protocol';
import { DEFAULT_INLINE_ENGINE } from '../../../src/editor/inlineEngine';
import { EMBED_WAY_BACK, FILE_STAYS } from '../../../src/editor/verbs';
import { closeEditorPage, delay, describedTip, EditMessage, EditorPage, EXTENSION_ID, openEditorPage, pointAt as textPoint, settle, shot, MOD, UNDO } from './pageHarness';
import { DARK_MODERN, LIGHT_MODERN, applyTheme } from './themes';

/** The selection's object toolbar, shown. */
const BAR = '.mep-object-toolbar[data-trigger="selection"]:not([hidden])';

const WIDE = 1280;
const NARROW = 520;
const HEIGHT = 900;

const BADGE_MARK = { rule: 'req-status-badges', kind: 'atom', artifact: 'FRS-RXE-040' };

/** One verb as a bar draws it: its id, its text, whether it is refused, whether a divider stands before it. */
type DrawnVerb = [id: string, text: string, disabled: boolean, divider: boolean];

/**
 * One row of the sketch (`wave1-sketches/bars/build.cjs`, `rows`), numbered as
 * there, and how to get its bar in the page: a document, then where the caret
 * goes (or what is selected) before `Alt+Enter`.
 */
interface Row {
    n: number;
    slug: string;
    /** The document, as Markdown; or `json` for one the test host's parser cannot make (Req Explorer's nodes). */
    source?: string;
    json?: () => Promise<{ doc: unknown; eol: string; tail: string }>;
    /** Text in the document that says it is drawn. */
    marker: string;
    includes?: boolean;
    /** Put the caret in the object, or select it. */
    enter(): Promise<void>;
    /** Before `Alt+Enter`, once the object is entered: the host's part (lenses, code actions). */
    host?(): Promise<void>;
    /** After the row's test: what it gave the page that the next row's document must not keep. */
    cleanup?(): Promise<void>;
    label: string;
    verbs: DrawnVerb[];
    /** Where `Alt+Enter` puts the focus: a verb's id, or the bar itself. */
    focus: string | 'bar';
    /**
     * At 520 px: the verbs drawn in their short form, and with what text; whether the title is cut even so,
     * or hidden (cut below the stub, the verbs needing its room); whether the bar stands past the text column.
     */
    narrow?: { short: [id: string, text: string][]; titleCut?: boolean; titleHidden?: boolean; pastColumn?: boolean };
}

/**
 * Every object bar of the sketch in the real page (wave 1, decisions #7 and
 * #14): its verbs in the slots' order with their dividers, where `Alt+Enter`
 * puts the focus, the bar's accessible name, and — in a 520 px editor — the
 * nouns dropped before the title truncates; each shot at 1280 and 520 px,
 * light and dark (`MEP_SHOTS_DIR`). Then the undo hints, each pressed: the key
 * a hint names is the key that undoes.
 */
suite('Editor object bars (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let version = 0;

    const lastEdit = async (): Promise<EditMessage | undefined> => (await (editor as EditorPage).edits()).pop();
    const posted = () => (editor as EditorPage).posted();

    const settleOut = async () => {
        // Out of any object the last test left the caret or the pointer in, and back at the top it may have scrolled from.
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
            (document.activeElement as HTMLElement | null)?.blur();
            window.scrollTo(0, 0);
        });
        await delay(400);
    };

    const showDocument = async (text: string, marker: string, includes = false) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        version++;
        await (editor as EditorPage).send({ type: 'document', json: parsedDocumentToJSON(parseDocument(md, text, {})), version, defaultWrap: 90, includes, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await settleOut();
    };

    const showJson = async (json: { doc: unknown; eol: string; tail: string }, marker: string, includes = false) => {
        version++;
        await (editor as EditorPage).send({ type: 'document', json: json as never, version, defaultWrap: 90, includes, inline: DEFAULT_INLINE_ENGINE });
        await page.waitForFunction(m => document.querySelector('.ProseMirror')?.textContent?.includes(m), {}, marker);
        await settleOut();
    };

    /** A Markdown document's JSON, edited before it is sent: what Req Explorer's plugins would have made of it. */
    const parsed = async (text: string, edit: (content: { type: string; attrs: Record<string, unknown>; content?: Record<string, unknown>[] }[]) => void) => {
        const md = await buildEditorEngine(EXTENSION_ID, () => undefined);
        const json = parsedDocumentToJSON(parseDocument(md, text, {}));
        edit(json.doc.content as never);
        return json as unknown as { doc: unknown; eol: string; tail: string };
    };

    const pointAt = (needle: string, index = 0) => textPoint(page, needle, index);

    const clickBefore = async (needle: string, index = 0) => {
        const p = await pointAt(needle, index);
        await page.mouse.click(p.x, p.y);
        await delay(100);
    };

    const clickCentre = async (selector: string) => {
        const box = await (await page.$(selector))?.boundingBox();
        assert.ok(box, `no ${selector}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(150);
    };

    const pressAlt = async (key: puppeteer.KeyInput) => {
        await page.keyboard.down('Alt');
        await page.keyboard.press(key);
        await page.keyboard.up('Alt');
        await delay(120);
    };

    /** Places the bar anew, as a resize does, and waits for its frame. */
    const viewport = async (width: number) => {
        await page.setViewport({ width, height: HEIGHT });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await delay(80);
    };

    /** What the bar draws: its title, each verb, where the focus is, its accessible name. */
    const drawn = () => page.$eval(BAR, bar => {
        const verbs: [string, string, boolean, boolean][] = [];
        let divider = false;
        for (const child of Array.from(bar.children)) {
            // The title's own divider (#11) divides no verbs.
            if (child.classList.contains('mep-object-separator') && child.previousElementSibling?.classList.contains('mep-object-label')) {
                continue;
            }
            if (child.classList.contains('mep-object-separator')) {
                divider = true;
            } else if (child instanceof HTMLButtonElement) {
                verbs.push([child.dataset.verb ?? '', child.textContent ?? '', child.getAttribute('aria-disabled') === 'true', divider]);
                divider = false;
            }
        }
        const active = document.activeElement as HTMLElement | null;
        return {
            label: bar.querySelector('.mep-object-label')?.textContent ?? '',
            verbs,
            focus: active === bar ? 'bar' : active?.dataset.verb ?? `elsewhere: ${active?.className}`,
            aria: bar.getAttribute('aria-label') ?? '',
        };
    });

    /** At the bar's current width: which verbs are in their short form, whether the title is cut, and whether everything stays inside. */
    const fitted = () => page.$eval(BAR, bar => {
        const mount = (bar.parentElement as HTMLElement).getBoundingClientRect();
        const label = bar.querySelector('.mep-object-label') as HTMLElement;
        const buttons = Array.from(bar.querySelectorAll<HTMLButtonElement>('button[data-verb]'));
        return {
            short: buttons.filter(b => b.dataset.short !== undefined).map(b => [b.dataset.verb ?? '', b.textContent ?? ''] as [string, string]),
            titleCut: !label.hidden && label.scrollWidth > label.clientWidth + 1,
            titleHidden: label.hidden,
            // The bar from the text column's left edge to the editor's right edge less the 16 px gutter, and nothing drawn past its own edge.
            inside: bar.getBoundingClientRect().right <= document.documentElement.clientWidth - 16 + 0.5 && bar.getBoundingClientRect().left >= mount.left - 0.5
                && bar.scrollWidth <= bar.clientWidth + 1,
            pastColumn: bar.getBoundingClientRect().right > mount.right + 0.5,
            verbsWhole: buttons.every(b => b.scrollWidth <= b.clientWidth),
            width: Math.round(bar.getBoundingClientRect().width),
            mount: Math.round(mount.width),
        };
    });

    /** A verb's tooltip, read in one place: what its hover says (`describedTip`). */
    const tooltipOf = (id: string) => describedTip(page, `${BAR} [data-verb="${id}"]`);

    const hint = () => page.$eval('.mep-hint', el => ({ text: el.textContent ?? '', shown: !(el as HTMLElement).hidden }));

    const clickVerb = async (verb: string) => {
        const button = await page.waitForSelector(`${BAR} [data-verb="${verb}"]`, { visible: true, timeout: 2000 });
        const box = await button?.boundingBox();
        assert.ok(box, `no box for ${verb}`);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(100);
    };

    /** Press the key a hint names: `Ctrl+Z` or `Cmd+Z`, as written in it. */
    const pressNamed = async (keys: string) => {
        const [modifier, key] = keys.split('+');
        const held: puppeteer.KeyInput = modifier === 'Cmd' ? 'Meta' : 'Control';
        await page.keyboard.down(held);
        await page.keyboard.press(key.toLowerCase() as puppeteer.KeyInput);
        await page.keyboard.up(held);
        await settle();
    };

    /** The host's answer to the last `actionsFor` the page asked. */
    const answerActions = async (items: { id: string; title: string; kind: string }[]) => {
        const asked = (await posted()).filter((m): m is Extract<WebviewMessage, { type: 'actionsFor' }> => m.type === 'actionsFor');
        const request = asked[asked.length - 1];
        assert.ok(request, 'the page asked for the block\'s code actions');
        await (editor as EditorPage).send({ type: 'actions', requestId: request.requestId, blockIndex: request.blockIndex, items });
        await delay(150);
    };

    const MULTILINE = 'It holds a line break';

    const rows: Row[] = [
        {
            n: 1, slug: 'link', source: 'See [the docs](https://example.com/docs) here.\n', marker: 'See',
            enter: () => clickBefore('docs', 1),
            label: 'Link',
            verbs: [['open-link', 'Open', false, false], ['edit-link', 'Edit link…', false, false], ['link-attributes', 'Attributes…', false, false], ['remove-link', 'Remove link, keep text', false, true]],
            focus: 'edit-link',
        },
        {
            n: 2, slug: 'link-in-bold', source: 'See [the **bold** docs](https://example.com/docs) here.\n', marker: 'See',
            enter: () => clickBefore('bold', 1),
            label: 'Link',
            verbs: [['open-link', 'Open', false, false], ['edit-link', 'Edit link…', false, false], ['link-attributes', 'Attributes…', false, false],
                ['inline-attributes', 'Attributes of Bold…', false, false], ['remove-link', 'Remove link, keep text', false, true]],
            focus: 'edit-link',
            // At the harness's 520 px the column is 416 px and the verbs alone are wider: the bar stands past it.
            narrow: { short: [['edit-link', 'Edit…'], ['remove-link', 'Remove, keep text']], pastColumn: true },
        },
        {
            n: 3, slug: 'image', source: 'A picture: ![Setup](img/setup.png) here.\n', marker: 'picture',
            enter: () => clickCentre('.ProseMirror img'),
            label: 'Image',
            verbs: [['open-image', 'Open file', false, false], ['edit-image', 'Edit image…', false, false], ['image-attributes', 'Attributes…', false, false], ['delete-image', 'Delete image', false, true]],
            focus: 'edit-image',
        },
        {
            n: 4, slug: 'sidenote', source: 'Alpha ++beta ref|the body++ gamma.\n', marker: 'Alpha',
            enter: () => clickBefore('ref', 1),
            label: 'Sidenote',
            verbs: [['convert-note', 'Convert to marginal note', false, false], ['edit-source', 'Edit source', false, false], ['delete-note', 'Delete note', false, true]],
            focus: 'edit-source',
        },
        {
            // A hard line break in the body: the one-line field cannot hold it.
            n: 5, slug: 'sidenote-multiline', source: 'Alpha ++beta ref|the body\\\nmore++ gamma.\n', marker: 'Alpha',
            enter: () => clickBefore('ref', 1),
            label: 'Sidenote',
            verbs: [['convert-note', 'Convert to marginal note', false, false], ['edit-source', 'Edit source', true, false], ['delete-note', 'Delete note', false, true]],
            focus: 'bar',
        },
        {
            // Right sidebars: the test host's math would claim `$…$`.
            n: 6, slug: 'sidebar', source: 'Alpha @side text@ gamma.\n', marker: 'Alpha',
            enter: () => clickBefore('side', 1),
            label: 'Right sidebar',
            verbs: [['convert-note', 'Move to left', false, false], ['edit-source', 'Edit source', false, false], ['remove-note', 'Remove sidebar, keep text', false, true]],
            focus: 'edit-source',
        },
        {
            n: 7, slug: 'sidebar-multiline', source: 'Alpha @side\\\ntext@ gamma.\n', marker: 'Alpha',
            enter: () => clickBefore('side', 1),
            label: 'Right sidebar',
            verbs: [['convert-note', 'Move to left', false, false], ['edit-source', 'Edit source', true, false], ['remove-note', 'Remove sidebar, keep text', false, true]],
            focus: 'bar',
        },
        {
            n: 8, slug: 'span', source: 'A [spanned]{.k} word.\n', marker: 'spanned',
            enter: () => clickBefore('spanned', 2),
            label: 'Span',
            verbs: [['edit-attributes', 'Attributes…', false, false], ['remove-attributes', 'Remove attributes, keep text', false, true]],
            focus: 'edit-attributes',
            narrow: { short: [] },
        },
        {
            n: 9, slug: 'formatting-attrs', source: 'Run `--flag`{.flag} to skip the cache.\n', marker: 'Run',
            enter: () => clickBefore('flag', 1),
            label: 'Code {.flag}',
            verbs: [['edit-attributes', 'Attributes…', false, false], ['remove-attributes', 'Remove attributes, keep formatting', false, true]],
            focus: 'edit-attributes',
            narrow: { short: [] },
        },
        {
            n: 10, slug: 'formatting', source: 'A **bold** word.\n', marker: 'bold',
            enter: () => clickBefore('bold', 2),
            label: 'Bold',
            verbs: [['edit-attributes', 'Attributes…', false, false]],
            focus: 'edit-attributes',
        },
        {
            n: 11, slug: 'emoji', source: 'Launch :rocket: now.\n', marker: 'Launch',
            enter: () => clickCentre('.ProseMirror .mep-emoji'),
            label: 'Emoji :rocket:',
            verbs: [['convert-emoji-to-text', 'Convert to text', false, false], ['delete-emoji', 'Delete emoji', false, true]],
            focus: 'bar',
        },
        {
            n: 12, slug: 'wiki-embed', source: 'See ![[roadmap]] here.\n', marker: 'See',
            enter: () => clickCentre('.ProseMirror .mep-wiki-embed'),
            label: 'Wiki embed',
            verbs: [['convert-embed-to-text', 'Convert to text', false, false], ['delete-embed', 'Delete embed', false, true]],
            focus: 'bar',
        },
        {
            n: 13, slug: 'badge', marker: 'Status',
            json: () => parsed('Status here.\n', content => {
                content[0].content = [{ type: 'text', text: 'Status ' }, { type: 'inline_atom', attrs: { html: '<span class="req-badge req-badge-implemented">implemented</span>', mark: BADGE_MARK } }, { type: 'text', text: ' here.' }];
            }),
            enter: () => clickCentre('.ProseMirror .mep-inline-atom'),
            label: 'Status badge',
            verbs: [],
            focus: 'bar',
        },
        {
            n: 14, slug: 'container', source: '::: warning\nBody text here.\n:::\n', marker: 'Body',
            enter: () => clickBefore('text here', 1),
            label: 'Container warning',
            verbs: [['edit-classes', 'Edit classes…', false, false], ['block-attributes', 'Attributes…', true, false], ['remove-container', 'Remove container, keep content', false, true]],
            focus: 'edit-classes',
            // The title does not name the classes: Edit classes… keeps its noun; Remove drops it.
            narrow: { short: [['remove-container', 'Remove, keep content']], pastColumn: true },
        },
        {
            n: 15, slug: 'admonition', source: '!!! warning "Check the inputs"\n    Body text here.\n', marker: 'Body',
            enter: () => clickBefore('text here', 1),
            label: 'Warning admonition',
            verbs: [['edit-title', 'Edit title…', false, false], ['change-type', 'Type', false, false], ['block-attributes', 'Attributes…', true, false], ['remove-admonition', 'Remove admonition, keep content', false, true]],
            focus: 'edit-title',
            // The title's short form, "Warning", before it truncates (wave 2 #2): it fits the column now.
            narrow: { short: [['remove-admonition', 'Remove, keep content']] },
        },
        {
            n: 16, slug: 'table', source: '| a | b |\n| - | - |\n| one | two |\n', marker: 'one',
            enter: () => clickBefore('one', 1),
            label: 'Table',
            verbs: [['row', 'Row', false, false], ['column', 'Column', false, false], ['align', 'Align', false, false], ['block-attributes', 'Attributes…', false, true],
                ['edit-source', 'Edit source', false, false], ['delete-table', 'Delete table', false, true]],
            focus: 'row',
            narrow: { short: [['delete-table', 'Delete']], pastColumn: true },
        },
        {
            n: 18, slug: 'source-block', source: 'Before.\n\n| a | b |\n| = | = |\n| 1 | 2 |\n\nAfter.\n', marker: 'Before',
            enter: () => clickCentre('.mep-raw-block table'),
            host: () => answerActions([{ id: 'fix', title: 'Fix all', kind: 'quickfix' }]),
            label: 'Source · multimd table',
            verbs: [['show-in-text-editor', 'Show in text editor', false, false], ['edit-source', 'Edit source', false, false], ['code-action:fix', 'Fix all', false, true], ['delete-block', 'Delete block', false, true]],
            focus: 'edit-source',
            // Delete drops its noun, and the title is still cut: verbs never are.
            narrow: { short: [['delete-block', 'Delete']], pastColumn: true },
        },
        {
            n: 19, slug: 'snippet', marker: 'Snippet body', includes: true,
            json: async () => ({
                doc: {
                    type: 'doc',
                    content: [
                        { type: 'paragraph', attrs: { src: 'Before.\n', gap: '' }, content: [{ type: 'text', text: 'Before.' }] },
                        {
                            type: 'injected_block',
                            attrs: {
                                kind: 'expansion',
                                mark: { rule: 'req-includes', kind: 'expansion', snippet: 'intro.md', line: 2, path: 'C:\\corpus\\snippets\\intro.md' },
                                html: '<p>Snippet body.</p>',
                                src: '<!-- include: intro.md -->\n',
                                gap: '\n',
                            },
                        },
                        { type: 'paragraph', attrs: { src: 'After.\n', gap: '\n' }, content: [{ type: 'text', text: 'After.' }] },
                    ],
                },
                eol: '\n',
                tail: '',
            }),
            enter: () => clickCentre('.mep-injected-block .mep-atom-content'),
            label: 'Included snippet intro.md',
            verbs: [['open-snippet', 'Open snippet', false, false], ['show-in-text-editor', 'Show in text editor', false, false], ['change-snippet', 'Change snippet…', false, false], ['delete-directive', 'Delete directive', false, true]],
            // Change snippet… asks the host for a choice: nothing opens in place, so the bar takes the focus.
            focus: 'bar',
            narrow: { short: [['open-snippet', 'Open'], ['change-snippet', 'Change…']], titleCut: true, pastColumn: true },
        },
        {
            n: 20, slug: 'requirement-heading', marker: 'Intro',
            json: () => parsed('# FRS-RXE-040: Page\n\nIntro.\n', content => {
                content[0].attrs.reqPrefix = 'FRS-RXE-040: ';
                content[0].content = [{ type: 'text', text: 'Page' }];
            }),
            enter: async () => {
                // Through the host's lensRows, as VS Code's lenses reach the page: Req Explorer's front-matter lens
                // (its surface the page renders itself, a24cc4f) is left out there, and the bar holds the rest.
                const lens = (title: string, surface: string) => new vscode.CodeLens(
                    new vscode.Range(0, 0, 0, 1), { title, command: 'test.lens', arguments: [{ reqExplorer: { surface, artifact: 'FRS-RXE-040' } }] },
                );
                const { rows: lenses } = lensRows([
                    lens('metadata for 1 requirement · show', 'front-matter'),
                    ...['Show trace', 'Open in matrix', 'Add test', 'Copy link', 'Rename'].map(title => lens(title, 'action')),
                ], [[0, 1], [2, 3]], 'a');
                assert.deepStrictEqual(lenses.flatMap(r => r.items.map(i => i.title)), ['Show trace', 'Open in matrix', 'Add test', 'Copy link', 'Rename'], 'the front-matter lens is not drawn');
                await (editor as EditorPage).send({ type: 'lenses', version, blocks: 2, rows: lenses });
                await delay(150);
                await clickBefore('Page', 1);
            },
            // The lenses go with the row: the next document must not inherit them.
            cleanup: () => (editor as EditorPage).send({ type: 'lenses', version, blocks: 2, rows: [] }),
            label: 'Requirement FRS-RXE-040',
            verbs: [['lens:a.0', 'Show trace', false, false], ['lens:a.1', 'Open in matrix', false, false], ['lens:a.2', 'Add test', false, false], ['lens-overflow', 'Actions', false, false]],
            focus: 'bar',
            // At the title's 11px (#11) it fits whole at 520 px; the bar still stands past the column.
            narrow: { short: [], pastColumn: true },
        },
        {
            n: 21, slug: 'block-attrs', source: 'A paragraph with attributes.\n{.lead}\n\nAfter.\n', marker: 'paragraph',
            enter: () => clickBefore('paragraph', 2),
            label: 'Paragraph attributes',
            verbs: [['block-attributes', 'Attributes…', false, false]],
            focus: 'block-attributes',
        },
        {
            // Wave 2 #4: a fence with a literal is a code block, not a block with attributes.
            n: 22, slug: 'code-block', source: '```js {.numbered}\nconst a = 1;\n```\n\nAfter.\n', marker: 'const',
            enter: () => clickBefore('const', 2),
            label: 'Code block js {.numbered}',
            verbs: [['language', 'Language…', false, false], ['block-attributes', 'Attributes…', false, false], ['edit-source', 'Edit source', false, false],
                ['delete-code-block', 'Delete code block', false, true]],
            focus: 'language',
            // #2's rule: the noun drops first, then the title cuts; at 520 that is enough — no verb moves into "…".
            narrow: { short: [['delete-code-block', 'Delete']], titleCut: true, pastColumn: true },
        },
        {
            n: 23, slug: 'code-block-indented', source: 'Text.\n\n    indented code\n\nAfter.\n', marker: 'indented',
            enter: () => clickBefore('indented', 2),
            label: 'Indented code block',
            verbs: [['language', 'Language…', false, false], ['block-attributes', 'Attributes…', false, false], ['edit-source', 'Edit source', false, false],
                ['delete-code-block', 'Delete code block', false, true]],
            focus: 'language',
            narrow: { short: [['delete-code-block', 'Delete']] },
        },
    ];

    /** Show the row's document, enter its object, answer for the host, and open its bar with `Alt+Enter`. */
    const openRow = async (row: Row) => {
        await viewport(WIDE);
        if (row.json) {
            await showJson(await row.json(), row.marker, row.includes);
        } else {
            await showDocument(row.source as string, row.marker, row.includes);
        }
        await row.enter();
        await row.host?.();
        await pressAlt('Enter');
        await page.waitForSelector(BAR, { visible: true, timeout: 2000 });
    };

    const name = (row: Row, width: number, theme: string) => `${String(row.n).padStart(2, '0')}-${row.slug}-${width}-${theme}.png`;

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
            await applyTheme(page, LIGHT_MODERN);
            await viewport(WIDE);
        }
    });

    for (const row of rows) {
        test(`${String(row.n).padStart(2, '0')} ${row.slug}: ${row.verbs.map(v => v[1]).join(' · ') || 'no verbs'}; Alt+Enter → ${row.focus}; at ${NARROW} px nouns before the title`, async function () {
            this.timeout(30000);
            try {
                await checkRow(row);
            } finally {
                await row.cleanup?.();
            }
        });
    }

    async function checkRow(row: Row): Promise<void> {
        await openRow(row);

        const wide = await drawn();
        const count = row.verbs.filter(v => !v[2]).length;
        assert.deepStrictEqual({ label: wide.label, verbs: wide.verbs }, { label: row.label, verbs: row.verbs }, `${row.slug}: the bar as the sketch has it`);
        assert.strictEqual(wide.focus, row.focus, `${row.slug}: where Alt+Enter puts the focus`);
        assert.strictEqual(wide.aria, count === 0 ? `${row.label}, no actions available` : `${row.label}, ${count} ${count === 1 ? 'action' : 'actions'}, arrow keys to choose`);
        const wideFit = await fitted();
        assert.deepStrictEqual(wideFit.short, [], `${row.slug}: nothing shortened at ${WIDE} px`);
        assert.strictEqual(wideFit.titleCut, false, `${row.slug}: the title whole at ${WIDE} px`);
        assert.strictEqual(wideFit.pastColumn, false, `${row.slug}: a bar that fits the text column stays within it (${JSON.stringify(wideFit)})`);
        await shot(page, name(row, WIDE, 'light'));
        await applyTheme(page, DARK_MODERN);
        await shot(page, name(row, WIDE, 'dark'));
        await applyTheme(page, LIGHT_MODERN);

        await viewport(NARROW);
        const narrow = await fitted();
        assert.ok(narrow.inside, `${row.slug}: inside the editor at ${NARROW} px, nothing past the bar's edge: ${JSON.stringify(narrow)}`);
        assert.ok(narrow.verbsWhole, `${row.slug}: no verb truncated: ${JSON.stringify(narrow)}`);
        assert.deepStrictEqual(narrow.short, row.narrow?.short ?? [], `${row.slug}: the short forms at ${NARROW} px (${JSON.stringify(narrow)})`);
        assert.deepStrictEqual(
            { titleCut: narrow.titleCut, titleHidden: narrow.titleHidden, pastColumn: narrow.pastColumn },
            { titleCut: row.narrow?.titleCut ?? false, titleHidden: row.narrow?.titleHidden ?? false, pastColumn: row.narrow?.pastColumn ?? false },
            `${row.slug}: the title and the column at ${NARROW} px (${JSON.stringify(narrow)})`,
        );
        await shot(page, name(row, NARROW, 'light'));
        await applyTheme(page, DARK_MODERN);
        await shot(page, name(row, NARROW, 'dark'));
        await applyTheme(page, LIGHT_MODERN);

        // Wide again: every verb has its full label back.
        await viewport(WIDE);
        assert.deepStrictEqual((await fitted()).short, [], `${row.slug}: the full labels back at ${WIDE} px`);
    }

    test('a focused bar: its name says the object, its count and the keys; Enter moves into its first verb, a second Enter runs it', async function () {
        this.timeout(15000);
        await showDocument('Launch :rocket: now.\n', 'Launch');
        await clickCentre('.ProseMirror .mep-emoji');
        await pressAlt('Enter');
        const bar = await drawn();
        assert.strictEqual(bar.focus, 'bar');
        assert.strictEqual(bar.aria, 'Emoji :rocket:, 2 actions, arrow keys to choose');
        await page.keyboard.press('Enter');
        await delay(80);
        assert.strictEqual((await drawn()).focus, 'convert-emoji-to-text', 'Enter moved into the first verb');
        await page.keyboard.press('Enter');
        await settle();
        assert.strictEqual((await lastEdit())?.text, 'Launch \\:rocket: now.\n', 'the second Enter ran Convert to text');
    });

    test('a bar without verbs draws its title and no divider after it', async function () {
        this.timeout(15000);
        await openRow(rows.find(r => r.slug === 'badge') as Row);
        assert.deepStrictEqual(await page.$eval(BAR, bar => Array.from(bar.children).map(c => c.className)), ['mep-object-label']);
    });

    test('a field\'s heading has no hover of the object\'s: the heading says what the field edits', async function () {
        this.timeout(15000);
        await openRow(rows.find(r => r.slug === 'link') as Row);
        assert.notStrictEqual(await page.$eval(`${BAR} .mep-object-label`, el => el.getAttribute('aria-description')), null, 'the title has the object\'s hover');
        await clickVerb('edit-link');
        await page.waitForSelector(`${BAR} .mep-inline-field`);
        assert.strictEqual(await page.$eval(`${BAR} .mep-object-label`, el => el.getAttribute('aria-description')), null, 'the heading has none');
        await page.keyboard.press('Escape');
        await delay(100);
    });

    test('a menu entry\'s hover goes with the bar, and an entry the pointer focuses shows none at once', async function () {
        this.timeout(20000);
        const tipShown = () => page.$eval('.mep-tooltip', el => !(el as HTMLElement).hidden);
        const entryCentre = (index: number) => page.$eval(`${BAR} .mep-object-menu`, (panel, i) => {
            const r = (panel.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')[i as number] as HTMLElement).getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, index);
        await openRow({ ...(rows.find(r => r.slug === 'table') as Row), source: 'Intro.\n\n| a | b |\n| - | - |\n| one | two |\n', marker: 'one' });
        // The keyboard opens Align's menu: the focus is the keyboard's; then the pointer arrives on another entry.
        await page.focus(`${BAR} [data-verb="align"]`);
        await page.keyboard.press('Enter');
        await page.waitForSelector(`${BAR} .mep-object-menu`);
        await delay(100);
        const second = await entryCentre(1);
        await page.mouse.move(second.x, second.y);
        await delay(120);
        assert.strictEqual(await tipShown(), false, 'an entry focused under the pointer waits for the rest, as a pointed-at control does');
        await delay(700);
        assert.strictEqual(await tipShown(), true, 'and shows after it');
        // The bar goes (the caret leaves the table): its entry's hover goes with it.
        await clickBefore('Intro', 1);
        await delay(150);
        assert.strictEqual(await tipShown(), false, 'no hover left standing beside a menu that is gone');
    });

    test('a block bar grown past the column stops short of a reserved margin lane: the notes there stay uncovered', async function () {
        this.timeout(30000);
        // A wide lane, so the column is narrower than the table's bar: the bar must grow, and the lane is where it would.
        // Then a narrow gap: the notes begin close to the column, well inside <html>'s padding.
        for (const sheet of [':root { --md-note-width: 500px; }', ':root { --md-note-width: 500px; --md-note-gap: 8px; }']) {
            await page.addStyleTag({ content: sheet });
            try {
                await openRow({ ...(rows.find(r => r.slug === 'table') as Row), source: 'Intro with a ++note|beside the column++ here.\n\n| a | b |\n| - | - |\n| one | two |\n', marker: 'one' });
                await viewport(1000);
                const placed = await page.$eval(BAR, bar => {
                    const note = document.querySelector('.ProseMirror .sidenote') as HTMLElement;
                    return { right: bar.getBoundingClientRect().right, noteLeft: note.getBoundingClientRect().left, float: getComputedStyle(note).float };
                });
                assert.strictEqual(placed.float, 'right', `${sheet}: the note is in the margin`);
                // Wider than the column, or — where even past it there is no room — its verbs moved into "…" (wave 2 #2): either way it stops short of the lane.
                const grown = await fitted();
                const more = await page.$eval(BAR, bar => bar.querySelector('.mep-object-more') !== null);
                assert.ok(grown.pastColumn || more, `${sheet}: the table's bar is wider than the column, or holds "…" (${JSON.stringify({ grown, more })})`);
                assert.ok(placed.right <= placed.noteLeft - 4 + 0.5, `${sheet}: the bar ends 4px short of the notes: ${JSON.stringify(placed)}`);
            } finally {
                await page.evaluate(s => document.querySelectorAll('style').forEach(el => {
                    if (el.textContent === s) {
                        el.remove();
                    }
                }), sheet);
                await viewport(WIDE);
            }
        }
    });

    test('a block bar grown past the column keeps out of an open card in the part past it: the band checked is the band it stands in', async function () {
        this.timeout(20000);
        // Two rules above the table and nothing below it: room for the bar on both sides — the card takes one, the other is free.
        await openRow({ ...(rows.find(r => r.slug === 'table') as Row), source: 'Intro.\n\n***\n\n***\n\n| a | b |\n| - | - |\n| one | two |\n', marker: 'one' });
        await viewport(NARROW);
        assert.ok((await fitted()).pastColumn, 'the table\'s bar is wider than the column at 520 px');
        // A card (as a hover would open) exactly over the part of the bar past the column.
        const card = await page.evaluate(sel => {
            const bar = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
            const mount = (document.querySelector(sel) as HTMLElement).parentElement as HTMLElement;
            const base = mount.getBoundingClientRect();
            const el = document.createElement('div');
            el.className = 'mep-language-card';
            el.id = 'test-card';
            Object.assign(el.style, { position: 'absolute', left: `${base.width}px`, top: `${bar.top - base.top}px`, width: `${bar.right - base.right}px`, height: `${bar.height}px` });
            mount.append(el);
            return el.getBoundingClientRect().toJSON() as DOMRect;
        }, BAR);
        try {
            await page.evaluate(() => window.dispatchEvent(new Event('resize')));
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const bar = await page.$eval(BAR, el => el.getBoundingClientRect().toJSON() as DOMRect);
            const overlaps = bar.left < card.right && card.left < bar.right && bar.top < card.bottom && card.top < bar.bottom;
            assert.ok(!overlaps, `the bar moved off the card: bar ${JSON.stringify(bar)}, card ${JSON.stringify(card)}`);
        } finally {
            await page.evaluate(() => document.getElementById('test-card')?.remove());
        }
    });

    test('narrower still, the title hides once cut below the stub; the bar\'s name still says the object, and no verb is cut', async function () {
        this.timeout(20000);
        await openRow(rows.find(r => r.slug === 'link-in-bold') as Row);
        await viewport(490);
        const tight = await fitted();
        assert.ok(tight.titleHidden, JSON.stringify(tight));
        assert.ok(tight.inside && tight.verbsWhole, JSON.stringify(tight));
        assert.strictEqual((await drawn()).aria, 'Link, 5 actions, arrow keys to choose');
        await shot(page, '91-title-hidden-490-light.png');
        await viewport(WIDE);
        assert.strictEqual((await fitted()).titleHidden, false, 'wide again, the title is back');
    });

    test('↓ on a focused bar moves into its first verb too', async function () {
        this.timeout(15000);
        await showDocument('Alpha ++beta ref|the body\\\nmore++ gamma.\n', 'Alpha');
        await clickBefore('ref', 1);
        await pressAlt('Enter');
        assert.strictEqual((await drawn()).focus, 'bar');
        await page.keyboard.press('ArrowDown');
        await delay(80);
        assert.strictEqual((await drawn()).focus, 'convert-note');
    });

    test('tooltips: a Delete whose file stays says so; Convert to text names the text it becomes', async function () {
        this.timeout(30000);
        const image = rows.find(r => r.slug === 'image') as Row;
        await openRow(image);
        assert.strictEqual(await tooltipOf('delete-image'), FILE_STAYS);
        const embed = rows.find(r => r.slug === 'wiki-embed') as Row;
        await openRow(embed);
        assert.strictEqual(await tooltipOf('delete-embed'), FILE_STAYS);
        assert.strictEqual(await tooltipOf('convert-embed-to-text'), `Convert to text ("![[roadmap]]"); ${EMBED_WAY_BACK}`);
        const snippet = rows.find(r => r.slug === 'snippet') as Row;
        await openRow(snippet);
        assert.strictEqual(await tooltipOf('delete-directive'), FILE_STAYS);
        const emoji = rows.find(r => r.slug === 'emoji') as Row;
        await openRow(emoji);
        assert.strictEqual(await tooltipOf('convert-emoji-to-text'), `Convert to text (":rocket:"): it is saved as text; ${UNDO} restores the emoji.`);
    });

    /** Each verb that leaves nothing to see: its hint, in the one pattern, and the key it names pressed — the document is back. */
    const undoRows: { slug: string; verb: string; done: string; back: string }[] = [
        { slug: 'image', verb: 'delete-image', done: 'Image deleted', back: 'img' },
        { slug: 'link', verb: 'remove-link', done: 'Link removed', back: 'a[href]' },
        { slug: 'emoji', verb: 'convert-emoji-to-text', done: 'Emoji converted to text', back: '.mep-emoji' },
        { slug: 'sidenote', verb: 'delete-note', done: 'Note deleted', back: '.sn-ref' },
        { slug: 'sidebar', verb: 'remove-note', done: 'Sidebar removed', back: '.right-sidebar' },
        { slug: 'container', verb: 'remove-container', done: 'Container removed', back: 'div.warning' },
    ];
    for (const u of undoRows) {
        test(`${u.done}: the hint reads "<Object> <participle> — <undo key>", and that key undoes it`, async function () {
            this.timeout(20000);
            const row = rows.find(r => r.slug === u.slug) as Row;
            await openRow(row);
            assert.ok(await page.$(`.ProseMirror ${u.back}`), `${u.slug}: there before`);
            await clickVerb(u.verb);
            await settle();
            const said = await hint();
            assert.ok(said.shown, `${u.slug}: a hint`);
            assert.match(said.text, /^[A-Z][a-z]+( [a-z]+)* (deleted|removed|converted to text) — (Ctrl|Cmd)\+Z$/);
            assert.strictEqual(said.text, `${u.done} — ${UNDO}`);
            assert.strictEqual(await page.$(`.ProseMirror ${u.back}`), null, `${u.slug}: gone`);
            if (u.slug === 'image') {
                // The hint as it shows, for the critique: light, then dark.
                await shot(page, '90-undo-hint-1280-light.png');
                await applyTheme(page, DARK_MODERN);
                await shot(page, '90-undo-hint-1280-dark.png');
                await applyTheme(page, LIGHT_MODERN);
            }
            // The page's own modifier is the one the hint names.
            assert.ok(said.text.endsWith(`${MOD === 'Meta' ? 'Cmd' : 'Ctrl'}+Z`), said.text);
            await pressNamed(said.text.split(' — ')[1]);
            assert.ok(await page.$(`.ProseMirror ${u.back}`), `${u.slug}: the key the hint names brought it back`);
        });
    }
});
