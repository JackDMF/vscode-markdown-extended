import * as assert from 'assert';
import * as vscode from 'vscode';
import { inlineToggleArgs } from '../../../src/commands/inlineToggleArgs';
import { toggleFormat } from '../../../src/services/helpers/toggleFormat';
import { InlineMarkerName } from '../../../src/syntax/markers';

/**
 * The text editor's inline toggles, on a real editor. A document is written
 * with its selections in it: `«` and `»` around a selection, `‸` for a cursor;
 * the result is read back the same way, so a test states where every
 * selection ends up.
 */
suite('Inline toggles: what a selection toggles', () => {
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function toggle(name: InlineMarkerName, marked: string, guarded = false): Promise<string> {
        const selections: [number, number][] = [];
        let content = '';
        let open = -1;
        for (const ch of marked) {
            if (ch === '«') {open = content.length;}
            else if (ch === '»') {selections.push([open, content.length]);}
            else if (ch === '‸') {selections.push([content.length, content.length]);}
            else {content += ch;}
        }
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        const editor = await vscode.window.showTextDocument(document);
        editor.selections = selections.map(([a, b]) => new vscode.Selection(document.positionAt(a), document.positionAt(b)));
        const [detect, multiLine, on, onReplace, off, offReplace] = inlineToggleArgs(name, guarded);
        await toggleFormat(editor, detect, on, onReplace, off, offReplace, multiLine);
        return read(editor);
    }

    function read(editor: vscode.TextEditor): string {
        const text = editor.document.getText();
        const marks = editor.selections
            .map(s => [editor.document.offsetAt(s.start), editor.document.offsetAt(s.end)])
            .flatMap(([start, end]) => start === end ? [[start, '‸']] : [[start, '«'], [end, '»']]) as [number, string][];
        marks.sort((a, b) => b[0] - a[0] || (a[1] === '«' ? -1 : 1));
        let result = text;
        for (const [at, mark] of marks) {result = result.slice(0, at) + mark + result.slice(at);}
        return result;
    }

    test('a cursor in a word bolds the word, not the punctuation after it (#173)', async () => {
        assert.strictEqual(await toggle('bold', 'I like spo‸rts, mainly football.'), 'I like **spo‸rts**, mainly football.');
        assert.strictEqual(await toggle('mark', 'I saw a wo‸lf! It escaped.'), 'I saw a ==wo‸lf==! It escaped.');
        assert.strictEqual(await toggle('italics', 'What did you d‸o? Are you serious?', true), 'What did you *d‸o*? Are you serious?');
    });

    test('a selection is toggled exactly as selected (#173)', async () => {
        assert.strictEqual(await toggle('bold', 'I like «spo»rts, mainly'), 'I like **«spo»**rts, mainly');
        assert.strictEqual(await toggle('strikethrough', 'one «two three» four'), 'one ~~«two three»~~ four');
    });

    test('a selection in CJK text is toggled as selected, not to the nearest spaces (#113)', async () => {
        assert.strictEqual(await toggle('bold', '体验这个«插件»之后，发现问题。'), '体验这个**«插件»**之后，发现问题。');
    });

    test('a cursor with no word inserts the marker pair around it', async () => {
        assert.strictEqual(await toggle('bold', 'one ‸ two'), 'one **‸** two');
        assert.strictEqual(await toggle('codeInline', '‸'), '`‸`');
    });

    test('every cursor and selection is toggled, in one undo step (#180)', async () => {
        assert.strictEqual(
            await toggle('bold', 'al‸pha beta «gam»ma\ndel‸ta'),
            'al‸pha beta «gam»ma\ndel‸ta'.replace('al‸pha', '**al‸pha**').replace('«gam»', '**«gam»**').replace('del‸ta', '**del‸ta**'),
        );
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(vscode.window.activeTextEditor.document.getText(), 'alpha beta gamma\ndelta');
    });

    test('two cursors in one word bold it once and both stay', async () => {
        assert.strictEqual(await toggle('bold', 'a‸lph‸a beta'), '**a‸lph‸a** beta');
    });

    test('adjacent selections are each wrapped', async () => {
        assert.strictEqual(await toggle('bold', '«foo»«bar»'), '**«foo»****«bar»**');
    });

    test('a cursor in or at a formatted word removes its markers', async () => {
        assert.strictEqual(await toggle('bold', 'I like **spo‸rts**, mainly'), 'I like spo‸rts, mainly');
        assert.strictEqual(await toggle('bold', 'I like **sports**‸, mainly'), 'I like sports‸, mainly');
        assert.strictEqual(await toggle('mark', 'a ==«marked text»== b'), 'a «marked text» b');
        assert.strictEqual(await toggle('codeInline', 'run `np‸m i` and `ls‸`'), 'run np‸m i and ls‸');
    });

    test('a selection only touching a formatted word is formatted itself', async () => {
        assert.strictEqual(await toggle('bold', '**foo**«bar»'), '**foo****«bar»**');
    });

    test('formatted and plain selections toggle in one go', async () => {
        assert.strictEqual(await toggle('bold', '**on‸e** tw‸o'), 'on‸e **tw‸o**');
    });

    test('a selection over two lines wraps each line\'s part', async () => {
        assert.strictEqual(await toggle('bold', 'one «two\nthree» four'), 'one **«two**\n**three»** four');
    });

    test('a reversed selection stays reversed', async () => {
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: 'one two' });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 7, 0, 4);
        const [detect, multiLine, on, onReplace, off, offReplace] = inlineToggleArgs('bold');
        await toggleFormat(editor, detect, on, onReplace, off, offReplace, multiLine);
        assert.strictEqual(document.getText(), 'one **two**');
        assert.deepStrictEqual(
            [editor.selection.anchor.character, editor.selection.active.character],
            [9, 6],
        );
    });
});

/**
 * The block toggles go the old way, one selection's lines; these hold that the
 * position of a match across lines is still read right. The expressions are
 * `markdownExtended.toggleBlockQuote`'s, from `src/commands/toggleFormats.ts`,
 * which registers its commands as it loads and so cannot be imported here.
 */
suite('Block toggles: a quote over several lines', () => {
    const quote = [
        /((^|\n)>[^\S\n]*(.*?)[^\S\n]*(?=$|\n))+/ig,
        /(^|\n)[^\S\n]*(.*?)[^\S\n]*(?=$|\n)/ig, '$1> $2',
        /(^|\n)>[^\S\n]+(.*?)[^\S\n]*(?=$|\n)/ig, '$1$2',
    ] as const;

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function run(content: string, selection: vscode.Selection): Promise<string> {
        const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = selection;
        await toggleFormat(editor, quote[0], quote[1], quote[2], quote[3], quote[4], true);
        return document.getText();
    }

    test('two lines are quoted and unquoted again', async () => {
        assert.strictEqual(await run('intro\n\none\ntwo', new vscode.Selection(2, 1, 3, 1)), 'intro\n\n> one\n> two');
        assert.strictEqual(await run('intro\n\n> one\n> two', new vscode.Selection(2, 1, 3, 1)), 'intro\n\none\ntwo');
    });
});
