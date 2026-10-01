import * as assert from 'assert';
import * as vscode from 'vscode';
import { BLOCK_TOGGLE_ARGS } from '../../../src/commands/blockToggleArgs';
import { inlineToggleArgs, ToggleArgs } from '../../../src/commands/inlineToggleArgs';
import { toggleFormat } from '../../../src/services/helpers/toggleFormat';
import { InlineMarkerName } from '../../../src/syntax/markers';

/**
 * The text editor's toggles, on a real editor. A document is written with its
 * selections in it: `«` and `»` around a selection, `‸` for a cursor; the
 * result is read back the same way, so a test states where every selection
 * ends up.
 */
function parse(marked: string): { content: string, selections: [number, number][] } {
    const selections: [number, number][] = [];
    let content = '';
    let open = -1;
    for (const ch of marked) {
        if (ch === '«') {open = content.length;}
        else if (ch === '»') {selections.push([open, content.length]);}
        else if (ch === '‸') {selections.push([content.length, content.length]);}
        else {content += ch;}
    }
    return { content, selections };
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

async function run(args: ToggleArgs, content: string, selections: [number, number][]): Promise<vscode.TextEditor> {
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
    const editor = await vscode.window.showTextDocument(document);
    editor.selections = selections.map(([a, b]) => new vscode.Selection(document.positionAt(a), document.positionAt(b)));
    const [detect, multiLine, on, onReplace, off, offReplace] = args;
    await toggleFormat(editor, detect, on, onReplace, off, offReplace, multiLine);
    return editor;
}

/** The inline toggles' arguments, guarded as `toggleFormats.ts` registers them. */
function inline(name: InlineMarkerName): ToggleArgs {
    return inlineToggleArgs(name, name === 'italics' || name === 'subscript');
}

suite('Inline toggles: what a selection toggles', () => {
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function toggle(name: InlineMarkerName, marked: string): Promise<string> {
        const { content, selections } = parse(marked);
        return read(await run(inline(name), content, selections));
    }

    test('a cursor in a word bolds the word, not the punctuation after it (#173)', async () => {
        assert.strictEqual(await toggle('bold', 'I like spo‸rts, mainly football.'), 'I like **spo‸rts**, mainly football.');
        assert.strictEqual(await toggle('mark', 'I saw a wo‸lf! It escaped.'), 'I saw a ==wo‸lf==! It escaped.');
        assert.strictEqual(await toggle('italics', 'What did you d‸o? Are you serious?'), 'What did you *d‸o*? Are you serious?');
    });

    test('a selection is toggled exactly as selected (#173)', async () => {
        assert.strictEqual(await toggle('bold', 'I like «spo»rts, mainly'), 'I like **«spo»**rts, mainly');
        assert.strictEqual(await toggle('strikethrough', 'one «two three» four'), 'one ~~«two three»~~ four');
    });

    test('a selection in CJK text is toggled as selected, not to the nearest spaces (#113)', async () => {
        assert.strictEqual(await toggle('bold', '体验这个«插件»之后，发现问题。'), '体验这个**«插件»**之后，发现问题。');
    });

    test('a cursor in CJK text takes the run of characters up to the punctuation', async () => {
        assert.strictEqual(await toggle('bold', '体验这个插‸件之后，发现问题。'), '**体验这个插‸件之后**，发现问题。');
    });

    test('whitespace at the ends of a selection stays outside the markers', async () => {
        assert.strictEqual(await toggle('bold', 'one« two »three'), 'one« **two** »three');
    });

    test('a cursor with no word inserts the marker pair around it, and removes it again', async () => {
        assert.strictEqual(await toggle('bold', 'one ‸ two'), 'one **‸** two');
        assert.strictEqual(await toggle('bold', 'one **‸** two'), 'one ‸ two');
        assert.strictEqual(await toggle('codeInline', '‸'), '`‸`');
        assert.strictEqual(await toggle('codeInline', '`‸`'), '‸');
    });

    test('every cursor and selection is toggled, in one undo step (#180)', async () => {
        assert.strictEqual(await toggle('bold', 'al‸pha beta «gam»ma\ndel‸ta'), '**al‸pha** beta **«gam»**ma\n**del‸ta**');
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(vscode.window.activeTextEditor.document.getText(), 'alpha beta gamma\ndelta');
    });

    test('two cursors in one word bold it once and both stay', async () => {
        assert.strictEqual(await toggle('bold', 'a‸lph‸a beta'), '**a‸lph‸a** beta');
    });

    test('adjacent selections are each wrapped, and each is found again', async () => {
        assert.strictEqual(await toggle('bold', '«foo»«bar»'), '**«foo»****«bar»**');
        assert.strictEqual(await toggle('bold', '**«foo»****«bar»**'), '«foo»«bar»');
        assert.strictEqual(await toggle('bold', '**a**‸**b**'), 'a‸**b**');
        assert.strictEqual(await toggle('bold', '**a****‸b**'), '**a**‸b');
    });

    test('a cursor in or at a formatted word removes its markers', async () => {
        assert.strictEqual(await toggle('bold', 'I like **spo‸rts**, mainly'), 'I like spo‸rts, mainly');
        assert.strictEqual(await toggle('bold', 'I like **sports**‸, mainly'), 'I like sports‸, mainly');
        assert.strictEqual(await toggle('mark', 'a ==«marked text»== b'), 'a «marked text» b');
        assert.strictEqual(await toggle('codeInline', 'run `np‸m i` and `ls‸`'), 'run np‸m i and ls‸');
    });

    test('a span of one character is found', async () => {
        assert.strictEqual(await toggle('bold', 'x ‸a y'), 'x **‸a** y');
        assert.strictEqual(await toggle('bold', 'x **‸a** y'), 'x ‸a y');
        assert.strictEqual(await toggle('superscript', '2^1‸^'), '21‸');
    });

    test('italics and subscript do not take bold\'s or strikethrough\'s markers for their own', async () => {
        assert.strictEqual(await toggle('italics', 'x **bo‸ld** y'), 'x ***bo‸ld*** y');
        assert.strictEqual(await toggle('italics', 'x *it‸al* y'), 'x it‸al y');
        assert.strictEqual(await toggle('subscript', 'x ~~st‸rike~~ y'), 'x ~~~st‸rike~~~ y');
    });

    test('underline\'s marker is no marker inside a word', async () => {
        assert.strictEqual(await toggle('underline', '_snake_ca‸se_'), 'snake_ca‸se');
        assert.strictEqual(await toggle('underline', 'snake_ca‸se'), '_snake_ca‸se_');
    });

    test('a selection only touching a formatted word is formatted itself', async () => {
        assert.strictEqual(await toggle('bold', '**foo**«bar»'), '**foo****«bar»**');
    });

    test('a selection that is not within one span is wrapped, the spans inside it kept', async () => {
        assert.strictEqual(await toggle('bold', '«make **this** bold»'), '**«make **this** bold»**');
    });

    test('a selection is cut short of a span it only partly covers', async () => {
        assert.strictEqual(await toggle('bold', '«a **b»c** d'), '**«a** **b»c** d');
    });

    test('formatted and plain selections toggle in one go', async () => {
        assert.strictEqual(await toggle('bold', '**on‸e** tw‸o'), 'on‸e **tw‸o**');
    });

    test('a selection over several lines wraps each line\'s text, and is unwrapped again', async () => {
        assert.strictEqual(await toggle('bold', 'one «two\nthree» four'), 'one **«two**\n**three»** four');
        assert.strictEqual(await toggle('bold', 'one **«two**\n**three»** four'), 'one «two\nthree» four');
        assert.strictEqual(await toggle('bold', 'one «two\r\nthree» four'), 'one **«two**\r\n**three»** four');
    });

    test('over several lines, block prefixes, blank lines and trailing whitespace stay outside', async () => {
        assert.strictEqual(await toggle('bold', '«- item one\n- item two»'), '«- **item one**\n- **item two»**');
        assert.strictEqual(await toggle('bold', '«# Title\n> quoted»'), '«# **Title**\n> **quoted»**');
        assert.strictEqual(await toggle('bold', 'o«ne\n   \ntw»o'), 'o**«ne**\n   \n**tw»**o');
        assert.strictEqual(await toggle('bold', '«one two \nthree»'), '**«one two** \n**three»**');
        assert.strictEqual(await toggle('bold', '«- **item one**\n- **item two»**'), '«- item one\n- item two»');
    });

    test('a line already formatted is left as it is when the others are wrapped', async () => {
        assert.strictEqual(await toggle('bold', '«**one**\ntwo»'), '«**one**\n**two»**');
    });

    test('overlapping selections are toggled as one, whichever is primary', async () => {
        const content = 'ab bar bar';
        for (const selections of [[[9, 9], [1, 8]], [[1, 8], [9, 9]]] as [number, number][][]) {
            const editor = await run(inline('strikethrough'), content, selections);
            assert.strictEqual(editor.document.getText(), 'a~~b bar bar~~');
            assert.deepStrictEqual(
                editor.selections.map(s => [editor.document.offsetAt(s.anchor), editor.document.offsetAt(s.active)]),
                selections[0][0] === 9 ? [[11, 11], [3, 10]] : [[3, 10], [11, 11]],
            );
        }
    });

    test('a reversed selection stays reversed', async () => {
        const editor = await run(inline('bold'), 'one two', [[7, 4]]);
        assert.strictEqual(editor.document.getText(), 'one **two**');
        assert.deepStrictEqual([editor.selection.anchor.character, editor.selection.active.character], [9, 6]);
    });
});

/**
 * The block toggles keep their behaviour: one selection's lines, and a block
 * found when it meets the selection anywhere, touching included. Each case is
 * what the toggle did before the inline toggles changed.
 */
suite('Block toggles: as they were', () => {
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function toggle(name: keyof typeof BLOCK_TOGGLE_ARGS, marked: string): Promise<string> {
        const { content, selections } = parse(marked);
        return (await run(BLOCK_TOGGLE_ARGS[name], content, selections)).document.getText();
    }

    test('lines are quoted and unquoted again', async () => {
        assert.strictEqual(await toggle('blockQuote', 'intro\n\n«one\ntwo»'), 'intro\n\n> one\n> two');
        assert.strictEqual(await toggle('blockQuote', 'intro\n\n«> one\n> two»'), 'intro\n\none\ntwo');
    });

    test('a selection only touching a block, from the end of its line, unwraps it', async () => {
        assert.strictEqual(await toggle('blockQuote', '> a«\nb»'), 'a\nb');
        assert.strictEqual(await toggle('oList', '1. a«\nb»'), 'a\nb');
        assert.strictEqual(await toggle('uList', '- a«\nb»'), 'a\nb');
    });

    test('a block after the first line, with CRLF line ends', async () => {
        assert.strictEqual(await toggle('blockQuote', 'intro\r\n\r\n> o«ne\r\n> t»wo'), 'intro\r\n\r\none\r\ntwo');
        assert.strictEqual(await toggle('blockQuote', 'intro\r\n\r\no«ne\r\nt»wo'), 'intro\r\n\r\n> one\r\n> two');
        assert.strictEqual(await toggle('uList', 'x\r\n- o«ne\r\n- t»wo'), 'x\r\none\r\ntwo');
        assert.strictEqual(await toggle('blockQuote', 'x\n> t‸wo'), 'x\ntwo');
    });
});
