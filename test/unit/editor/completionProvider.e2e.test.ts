import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import * as vscode from 'vscode';
import { buildEditorEngine } from '../../../src/editor/host/engineHost';
import { SessionWebview, VisualEditorSession } from '../../../src/editor/host/session';
import { AcceptOnEnter, HostMessage, WebviewMessage } from '../../../src/editor/protocol';
import { EXTENSION_ID, EditorPage, MOD, clickText, closeEditorPage, delay, openEditorPage, settle } from './pageHarness';

const SOURCE = 'Intro paragraph.\n\nSiehe\n\nLast paragraph.\n';

/** The books after "1. ", as the Studienhilfe offers them (`buchEintraegeZiffer`): the typed form first in `filterText`. */
const BOOKS = ['1. Mose', '1. Samuel', '1. Könige', '1. Chronika', '1. Korinther'];

/** What the fake provider was asked: the line up to the position, and how. */
interface Asked {
    before: string;
    triggerCharacter: string | undefined;
    triggerKind: vscode.CompletionTriggerKind;
}

/**
 * The Studienhilfe's books after a lone "1. " (MR !83), as a provider of
 * VS Code's own: registered with the trigger character `' '`, it answers a
 * space typed right after "1." in a line, its range from the digit to the
 * position — and nothing else, so the books show only where the provider sees
 * the space in the document.
 */
function registerBooks(asked: Asked[], meanwhile: { edit?: () => Thenable<unknown> }): vscode.Disposable {
    return vscode.languages.registerCompletionItemProvider({ language: 'markdown' }, {
        async provideCompletionItems(document, position, _token, context) {
            const before = document.lineAt(position.line).text.slice(0, position.character);
            asked.push({ before, triggerCharacter: context.triggerCharacter, triggerKind: context.triggerKind });
            // Another writer's change while the question is on its way, once.
            const edit = meanwhile.edit;
            meanwhile.edit = undefined;
            await edit?.();
            const m = /(?<![\p{L}\p{N}.])1\. $/u.exec(before);
            if (context.triggerKind !== vscode.CompletionTriggerKind.TriggerCharacter || context.triggerCharacter !== ' ' || !m) {
                return undefined;
            }
            const range = new vscode.Range(position.line, m.index, position.line, position.character);
            return BOOKS.map((name, i) => {
                const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
                item.detail = 'Bibelbuch';
                item.range = range;
                item.filterText = `${name} ${name.replace('. ', '.')}`;
                item.sortText = String(i).padStart(3, '0');
                return item;
            });
        },
    }, ' ');
}

/** The page's posts carried to the session, the session's to the page, in order: the two halves joined as VS Code joins them. */
class Bridge implements SessionWebview {
    private readonly emitter = new vscode.EventEmitter<WebviewMessage>();
    readonly onDidReceiveMessage = this.emitter.event;
    readonly sent: HostMessage[] = [];
    private chain: Promise<unknown> = Promise.resolve();
    private seen = 0;
    private timer: ReturnType<typeof setInterval> | undefined;
    private polling = false;

    constructor(private readonly editor: EditorPage) { }

    postMessage(message: HostMessage): Thenable<boolean> {
        this.sent.push(message);
        this.chain = this.chain.then(() => this.editor.send(message)).catch(() => undefined);
        return this.chain.then(() => true);
    }

    start(): void {
        this.timer = setInterval(() => void this.poll(), 15);
    }

    private async poll(): Promise<void> {
        if (this.polling) {
            return;
        }
        this.polling = true;
        try {
            const posted = await this.editor.posted();
            for (const message of posted.slice(this.seen)) {
                this.emitter.fire(message);
            }
            this.seen = posted.length;
        } catch {
            // The page is closing.
        } finally {
            this.polling = false;
        }
    }

    /** Everything carried to the page is there. */
    delivered(): Promise<unknown> {
        return this.chain;
    }

    dispose(): void {
        clearInterval(this.timer);
        this.emitter.dispose();
    }
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 5000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== undefined) {
            return value;
        }
        assert.ok(Date.now() < end, `timed out waiting for ${what}`);
        await delay(25);
    }
}

const markdownEditor = () => vscode.workspace.getConfiguration('editor', { languageId: 'markdown' });

/**
 * Completion through VS Code itself (`executeCompletionItemProvider`), a
 * provider of its own registered as the Studienhilfe registers its books, and
 * the real page joined to the real session: Enter as
 * `editor.acceptSuggestionOnEnter` for Markdown says, Tab always; and a space
 * typed at a paragraph's end reaches the provider — the page keeps it in its
 * edit while the list is asked or open — while the file, when nothing is
 * accepted, ends as typing alone leaves it. Each case on a page, a session and
 * a file of its own. Skips without a browser, as every e2e suite.
 */
suite('Editor completion with a provider of VS Code\'s (e2e)', () => {
    let editor: EditorPage | undefined;
    let page: puppeteer.Page;
    let bridge: Bridge;
    let session: VisualEditorSession;
    let textDocument: vscode.TextDocument;
    let file: string;
    let provider: vscode.Disposable;
    const asked: Asked[] = [];
    const meanwhile: { edit?: () => Thenable<unknown> } = {};
    /** Another writer's change: "Intro" becomes "Opening" on the first line. */
    const otherWriter = () => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(textDocument.uri, new vscode.Range(0, 0, 0, 5), 'Opening');
        return vscode.workspace.applyEdit(edit);
    };
    const engineChanged = new vscode.EventEmitter<void>();

    /** Set Enter's setting for Markdown, and wait until the page has it. */
    const acceptOnEnter = async (value: AcceptOnEnter | undefined) => {
        const before = bridge?.sent.length ?? 0;
        await markdownEditor().update('acceptSuggestionOnEnter', value, vscode.ConfigurationTarget.Global, true);
        if (bridge) {
            await until(() => bridge.sent.slice(before).find(m => m.type === 'completionSettings' && m.acceptSuggestionOnEnter === (value ?? 'on')), `completionSettings ${value}`);
            await bridge.delivered();
        }
    };
    const rows = () => page.$$eval('.mep-caret-completions .mep-completion-label', els => els.map(el => el.textContent));
    const paragraphs = () => page.$$eval('.ProseMirror > p', els => els.map(el => el.textContent));
    /** The caret to the end of the "Siehe" paragraph. */
    const toSiehe = async () => {
        await clickText(page, 'Siehe', 2);
        await page.keyboard.press('End');
        await delay(80);
    };
    /** Typing has reached the file and nothing more is on its way. */
    const settled = async () => {
        await settle();
        await bridge.delivered();
        await session.settled();
    };

    suiteSetup(async () => {
        // Word-based suggestions would answer where the books do not; Markdown's own are off in VS Code too.
        await markdownEditor().update('wordBasedSuggestions', 'off', vscode.ConfigurationTarget.Global, true);
        provider = registerBooks(asked, meanwhile);
    });

    suiteTeardown(async () => {
        provider.dispose();
        engineChanged.dispose();
        await markdownEditor().update('wordBasedSuggestions', undefined, vscode.ConfigurationTarget.Global, true);
        await markdownEditor().update('acceptSuggestionOnEnter', undefined, vscode.ConfigurationTarget.Global, true);
    });

    const open = async (context: Mocha.Context, setting: AcceptOnEnter, width = 1000) => {
        await markdownEditor().update('acceptSuggestionOnEnter', setting, vscode.ConfigurationTarget.Global, true);
        editor = await openEditorPage({ width });
        if (!editor) {
            context.skip();
        }
        page = editor.page;
        file = path.join(os.tmpdir(), `mep-books-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
        fs.writeFileSync(file, SOURCE, 'utf8');
        textDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const engine = buildEditorEngine(EXTENSION_ID, () => undefined);
        bridge = new Bridge(editor);
        session = new VisualEditorSession(textDocument, bridge, { engine: () => engine, onDidChangeEngine: engineChanged.event, log: () => undefined });
        bridge.start();
        await page.waitForSelector('.ProseMirror');
        await until(() => bridge.sent.find(m => m.type === 'completionSettings' && m.acceptSuggestionOnEnter === setting), `completionSettings ${setting}`);
        await bridge.delivered();
        asked.length = 0;
    };

    setup(function () {
        this.timeout(60000);
    });

    teardown(async function () {
        session?.dispose();
        bridge?.dispose();
        await closeEditorPage(this, editor);
        editor = undefined;
        if (textDocument?.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert', textDocument.uri).then(undefined, () => undefined);
        }
        fs.rmSync(file, { force: true });
    });

    test('off: "1. " at a paragraph\'s end reaches the provider; Enter closes the list and starts the new line; the file ends as typing alone leaves it', async function () {
        this.timeout(30000);
        await open(this, 'off');
        await toSiehe();
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        assert.deepStrictEqual(await rows(), BOOKS);
        const spaced = asked.find(a => a.triggerCharacter === ' ' && a.before.endsWith('1. '));
        assert.deepStrictEqual(spaced, { before: 'Siehe 1. ', triggerCharacter: ' ', triggerKind: vscode.CompletionTriggerKind.TriggerCharacter }, `the provider sees the space: ${JSON.stringify(asked)}`);
        await until(() => (textDocument.lineAt(2).text === 'Siehe 1.' ? true : undefined), 'the space let go while the list stands open');
        assert.strictEqual(await page.$eval('.mep-caret-completions .mep-completions-keys', el => el.textContent), '↹ accept · Esc close');

        await page.keyboard.press('Enter');
        assert.strictEqual(await page.$('.mep-caret-completions'), null, 'Enter closes the list');
        await page.keyboard.type('Next');
        await settled();
        assert.deepStrictEqual(await paragraphs(), ['Intro paragraph.', 'Siehe 1. ', 'Next', 'Last paragraph.'], 'Enter was the new line');
        assert.strictEqual(textDocument.getText(), 'Intro paragraph.\n\nSiehe 1.\n\nNext\n\nLast paragraph.\n', 'the space dropped, as the save drops it');
    });

    test('Esc: nothing accepted, the held space goes again — the file as typing alone leaves it', async function () {
        this.timeout(30000);
        await open(this, 'off');
        await toSiehe();
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        await page.keyboard.press('Escape');
        assert.strictEqual(await page.$('.mep-caret-completions'), null);
        await settled();
        assert.strictEqual(textDocument.getText(), 'Intro paragraph.\n\nSiehe 1.\n\nLast paragraph.\n');
        assert.deepStrictEqual(await paragraphs(), ['Intro paragraph.', 'Siehe 1. ', 'Last paragraph.'], 'the page keeps what was typed');
        assert.strictEqual((await (editor as EditorPage).posted()).filter(m => m.type === 'applyCompletion').length, 0);
    });

    test('Ctrl+S while the list is open writes no space; the list stays', async function () {
        this.timeout(30000);
        await open(this, 'off');
        await toSiehe();
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        await page.keyboard.down(MOD);
        await page.keyboard.press('s');
        await page.keyboard.up(MOD);
        assert.ok(await page.$('.mep-caret-completions'), 'the list stays: the space was let go when it opened');
        const saved = 'Intro paragraph.\n\nSiehe 1.\n\nLast paragraph.\n';
        await until(() => (fs.readFileSync(file, 'utf8') === saved && !textDocument.isDirty ? true : undefined), 'the save');
        await settled();
        assert.strictEqual(textDocument.getText(), saved);
        assert.strictEqual(textDocument.isDirty, false, 'nothing written after the save');
    });

    test('VS Code saving while the list is open writes no space', async function () {
        this.timeout(30000);
        await open(this, 'off');
        await toSiehe();
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        // The space goes back out when the list opens; the save comes after, as any save a person starts does.
        await until(() => (textDocument.lineAt(2).text === 'Siehe 1.' ? true : undefined), 'the space let go');
        assert.ok(await textDocument.save(), 'saved');
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'Intro paragraph.\n\nSiehe 1.\n\nLast paragraph.\n');
        assert.ok(await page.$('.mep-caret-completions'), 'the list still open');
    });

    test('another writer\'s change while the list is open: the file keeps no space', async function () {
        this.timeout(30000);
        await open(this, 'off');
        await toSiehe();
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        await otherWriter();
        await until(async () => ((await paragraphs())[0] === 'Opening paragraph.' ? true : undefined), 'the page shows the change');
        await page.keyboard.press('Escape');
        await settled();
        assert.strictEqual(textDocument.getText(), 'Opening paragraph.\n\nSiehe 1.\n\nLast paragraph.\n');
    });

    test('another writer\'s change while the question is on its way, the space in the file: the next edit drops it', async function () {
        this.timeout(30000);
        await open(this, 'off');
        await toSiehe();
        meanwhile.edit = otherWriter;
        await page.keyboard.type(' 1. ');
        await until(async () => ((await paragraphs())[0] === 'Opening paragraph.' ? true : undefined), 'the page shows the change');
        await settled();
        await delay(300);
        await settled();
        assert.strictEqual(await page.$('.mep-caret-completions'), null, 'the answer for the text before is dropped');
        assert.strictEqual(textDocument.getText(), 'Opening paragraph.\n\nSiehe 1.\n\nLast paragraph.\n', 'the space the host parsed is not kept');
    });

    test('Tab accepts in a narrow window: "1. M" is replaced by the book, the caret after it', async function () {
        this.timeout(30000);
        await open(this, 'off', 420);
        await toSiehe();
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        await page.keyboard.type('M');
        await page.waitForFunction(() => document.querySelectorAll('.mep-caret-completions .mep-completion').length === 1);
        assert.deepStrictEqual(await rows(), ['1. Mose'], 'filtered by "1. M"');
        const list = await page.$eval('.mep-caret-completions', el => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: window.innerWidth };
        });
        assert.ok(list.left >= 0 && list.right <= list.width, `inside the narrow window: ${JSON.stringify(list)}`);
        await page.keyboard.press('Tab');
        await until(async () => ((await paragraphs())[1] === 'Siehe 1. Mose' ? true : undefined), 'the paragraph redrawn from the file');
        assert.strictEqual(textDocument.getText(), 'Intro paragraph.\n\nSiehe 1. Mose\n\nLast paragraph.\n');
        await delay(100);
        await page.keyboard.type('!');
        await settled();
        assert.strictEqual(textDocument.getText(), 'Intro paragraph.\n\nSiehe 1. Mose!\n\nLast paragraph.\n', 'the caret after the insertion');
    });

    test('a changed setting is followed: on accepts with Enter; smart leaves Enter to a book typed out in full', async function () {
        this.timeout(30000);
        await open(this, 'off');
        await acceptOnEnter('on');
        await toSiehe();
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        assert.strictEqual(await page.$eval('.mep-caret-completions .mep-completions-keys', el => el.textContent), '↹ ↵ accept · Esc close');
        await page.keyboard.press('Enter');
        await until(async () => ((await paragraphs())[1] === 'Siehe 1. Mose' ? true : undefined), 'Enter accepted the first book');
        assert.strictEqual(textDocument.getText(), 'Intro paragraph.\n\nSiehe 1. Mose\n\nLast paragraph.\n');

        await acceptOnEnter('smart');
        await page.keyboard.type(' 1. ');
        await page.waitForSelector('.mep-caret-completions .mep-completion');
        await page.keyboard.type('Samuel');
        await page.waitForFunction(() => document.querySelectorAll('.mep-caret-completions .mep-completion').length === 1);
        await page.keyboard.press('Enter');
        assert.strictEqual(await page.$('.mep-caret-completions'), null, 'the list closes');
        await settled();
        assert.deepStrictEqual(await paragraphs(), ['Intro paragraph.', 'Siehe 1. Mose 1. Samuel', '', 'Last paragraph.'], 'accepting would change nothing: Enter is the new line');
        assert.strictEqual((await (editor as EditorPage).posted()).filter(m => m.type === 'applyCompletion').length, 1, 'only the first Enter accepted');
    });
});
