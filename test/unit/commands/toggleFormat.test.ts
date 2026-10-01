import * as assert from 'assert';
import * as vscode from 'vscode';
import { BLOCK_TOGGLE_ARGS } from '../../../src/commands/blockToggleArgs';
import { toggleFormat, toggleInlineFormat } from '../../../src/services/helpers/toggleFormat';
import { INLINE_MARKERS, InlineMarkerName } from '../../../src/syntax/markers';
import { hostEngine } from '../editor/helpers';

const md = hostEngine();

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

async function open(content: string, selections: [number, number][]): Promise<vscode.TextEditor> {
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
    const editor = await vscode.window.showTextDocument(document);
    editor.selections = selections.map(([a, b]) => new vscode.Selection(document.positionAt(a), document.positionAt(b)));
    return editor;
}

async function inline(name: InlineMarkerName, content: string, selections: [number, number][]): Promise<vscode.TextEditor> {
    const editor = await open(content, selections);
    await toggleInlineFormat(editor, INLINE_MARKERS[name], md);
    return editor;
}

suite('Inline toggles: what a selection toggles', () => {
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function toggle(name: InlineMarkerName, marked: string): Promise<string> {
        const { content, selections } = parse(marked);
        return read(await inline(name, content, selections));
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

    test('an empty pair next to another marker is removed again', async () => {
        assert.strictEqual(await toggle('italics', '**b**‸'), '**b***‸*');
        assert.strictEqual(await toggle('italics', '**b***‸*'), '**b**‸');
    });

    test('no pair is inserted where it would open a fence', async () => {
        assert.strictEqual(await toggle('strikethrough', '‸'), '‸');
    });

    test('every cursor and selection is toggled, in one undo step (#180)', async () => {
        const { content, selections } = parse('al‸pha beta «gam»ma\ndel‸ta');
        const editor = await inline('bold', content, selections);
        assert.strictEqual(read(editor), '**al‸pha** beta **«gam»**ma\n**del‸ta**');
        // `undo` acts on the focused editor: focus this one, whatever the suites before left open.
        await vscode.window.showTextDocument(editor.document, { preserveFocus: false });
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(editor.document.getText(), 'alpha beta gamma\ndelta');
    });

    test('two cursors in one word bold it once and both stay', async () => {
        assert.strictEqual(await toggle('bold', 'a‸lph‸a beta'), '**a‸lph‸a** beta');
    });

    test('selections side by side are written as one span', async () => {
        assert.strictEqual(await toggle('bold', '«foo»«bar»'), '**«foo»«bar»**');
        assert.strictEqual(await toggle('bold', '**«foo»«bar»**'), '«foo»«bar»');
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

    test('markers side by side are read as Markdown reads them: one span', async () => {
        assert.strictEqual(await toggle('bold', '**a**‸**b**'), 'a**‸**b');
    });

    test('italics finds its span around or inside bold, and not in bold\'s markers', async () => {
        assert.strictEqual(await toggle('italics', 'x **bo‸ld** y'), 'x ***bo‸ld*** y');
        assert.strictEqual(await toggle('italics', 'x ***bo‸ld*** y'), 'x **bo‸ld** y');
        assert.strictEqual(await toggle('bold', 'x ***bo‸ld*** y'), 'x *bo‸ld* y');
        assert.strictEqual(await toggle('bold', 'x *bo‸ld* y'), 'x ***bo‸ld*** y');
        assert.strictEqual(await toggle('italics', '*see **th‸is***'), 'see **th‸is**');
        assert.strictEqual(await toggle('italics', 'x *it‸al* y'), 'x it‸al y');
    });

    test('subscript does not take strikethrough\'s markers for its own', async () => {
        // The engine reads the result as a strikethrough between two `~`s, so
        // a second toggle finds no subscript there: Markdown has no `~` inside `~~` here.
        assert.strictEqual(await toggle('subscript', 'x ~~st‸rike~~ y'), 'x ~~~st‸rike~~~ y');
    });

    test('superscript leaves footnote references alone', async () => {
        const notes = '\n\n[^1]: x\n[^2]: y';
        assert.strictEqual(await toggle('superscript', `see[^1] a‸nd[^2]${notes}`), `see[^1] ^a‸nd^[^2]${notes}`);
        assert.strictEqual(await toggle('superscript', `see[^1] ^a‸nd^[^2]${notes}`), `see[^1] a‸nd[^2]${notes}`);
    });

    test('underline takes in the rest of a word a selection ends in', async () => {
        assert.strictEqual(await toggle('underline', 'fo«ob»ar baz'), '_fo«ob»ar_ baz');
        assert.strictEqual(await toggle('underline', '体验这个«插件»之后，发现问题。'), '_体验这个«插件»之后_，发现问题。');
        assert.strictEqual(await toggle('underline', 'x «a» y'), 'x _«a»_ y');
        assert.strictEqual(await toggle('underline', 'x a«(b)»c y'), 'x _a«(b)»c_ y');
    });

    test('underline\'s marker is no marker inside a word', async () => {
        assert.strictEqual(await toggle('underline', '_snake_ca‸se_'), 'snake_ca‸se');
        assert.strictEqual(await toggle('underline', 'snake_ca‸se'), '_snake_ca‸se_');
    });

    test('a selection is wrapped as selected: spans inside it are kept, and removed again innermost first', async () => {
        assert.strictEqual(await toggle('bold', '«make **this** bold»'), '**«make **this** bold»**');
        assert.strictEqual(await toggle('bold', '**«make **this** bold»**'), '«make **this** bold»');
        assert.strictEqual(await toggle('bold', '**make **th‸is** bold**'), '**make th‸is bold**');
        // A span the selection holds whole, markers and all, stays whole inside the new markers.
        assert.strictEqual(await toggle('mark', '«==a== b ==c==»'), '==«==a== b ==c==»==');
    });

    test('formatted and plain selections toggle in one go', async () => {
        assert.strictEqual(await toggle('bold', '**on‸e** tw‸o'), 'on‸e **tw‸o**');
    });

    test('nothing is written into code', async () => {
        assert.strictEqual(await toggle('codeInline', '```j‸s'), '```j‸s');
        assert.strictEqual(await toggle('bold', '```\nco‸de\n```'), '```\nco‸de\n```');
    });

    test('a selection over several lines wraps each line\'s text, and is unwrapped again', async () => {
        assert.strictEqual(await toggle('bold', 'one «two\nthree» four'), 'one **«two**\n**three»** four');
        assert.strictEqual(await toggle('bold', 'one **«two**\n**three»** four'), 'one «two\nthree» four');
        assert.strictEqual(await toggle('bold', 'one «two\r\nthree» four'), 'one **«two**\r\n**three»** four');
    });

    test('over several lines, block prefixes, blank lines and trailing whitespace stay outside', async () => {
        assert.strictEqual(await toggle('bold', '«- item one\n- item two»'), '«- **item one**\n- **item two»**');
        assert.strictEqual(await toggle('bold', '«- [ ] task one\n- [x] task two»'), '«- [ ] **task one**\n- [x] **task two»**');
        assert.strictEqual(await toggle('bold', '«# Title\n> quoted»'), '«# **Title**\n> **quoted»**');
        assert.strictEqual(await toggle('bold', 'o«ne\n   \ntw»o'), 'o**«ne**\n   \n**tw»**o');
        assert.strictEqual(await toggle('bold', '«one two \nthree»'), '**«one two** \n**three»**');
        assert.strictEqual(await toggle('bold', '«- **item one**\n- **item two»**'), '«- item one\n- item two»');
    });

    test('over several lines, lines that are a block\'s syntax are left as they are', async () => {
        assert.strictEqual(await toggle('bold', '«one\n```js\nlet a = 1;\n```\ntwo»'), '**«one**\n```js\nlet a = 1;\n```\n**two»**');
        // A table's delimiter row is left alone; its cells are text, each toggled on its own.
        assert.strictEqual(await toggle('bold', '«| a | b |\n|---|---|\n| 1 | 2 |»'), '«| **a** | **b** |\n|---|---|\n| **1** | **2** |»');
        assert.strictEqual(await toggle('bold', '«one\n\n---\n\ntwo»'), '**«one**\n\n---\n\n**two»**');
        assert.strictEqual(await toggle('bold', '«Title\n=====»'), '**«Title**\n=====»');
        assert.strictEqual(await toggle('bold', '«<div>\nhtml\n</div>»'), '«<div>\nhtml\n</div>»');
        assert.strictEqual(await toggle('bold', '«::: warning\ntext\n:::»'), '«::: warning\n**text**\n:::»');
        // A footnote nothing refers to is no text in the preview, and its label is never.
        assert.strictEqual(await toggle('bold', '«[^1]: a note\ntext»'), '«[^1]: a note\ntext»');
        assert.strictEqual(await toggle('bold', 'x[^1]\n\n«[^1]: a note\ntext»'), 'x[^1]\n\n«[^1]: **a note**\n**text»**');
    });

    test('a line already formatted is left as it is when the others are wrapped', async () => {
        assert.strictEqual(await toggle('bold', '«**one**\ntwo»'), '«**one**\n**two»**');
    });

    test('overlapping selections are toggled as one, whichever is primary', async () => {
        const content = 'ab bar bar';
        for (const selections of [[[9, 9], [1, 8]], [[1, 8], [9, 9]]] as [number, number][][]) {
            const editor = await inline('strikethrough', content, selections);
            assert.strictEqual(editor.document.getText(), 'a~~b bar bar~~');
            assert.deepStrictEqual(
                editor.selections.map(s => [editor.document.offsetAt(s.anchor), editor.document.offsetAt(s.active)]),
                selections[0][0] === 9 ? [[11, 11], [3, 10]] : [[3, 10], [11, 11]],
            );
        }
    });

    test('a code span\'s markers are not another marker\'s', async () => {
        assert.strictEqual(await toggle('bold', 'Use `**/*.ts` o‸r `**/*.js`'), 'Use `**/*.ts` **o‸r** `**/*.js`');
        assert.strictEqual(await toggle('italics', 'run `ls *.md` a‸nd `rm *.bak` now'), 'run `ls *.md` *a‸nd* `rm *.bak` now');
        assert.strictEqual(await toggle('bold', '`np‸m i`'), '`np‸m i`');
    });

    test('an escaped marker is text, and `_` inside a word is no marker', async () => {
        assert.strictEqual(await toggle('bold', '\\*\\*not\\*\\* a‸nd'), '\\*\\*not\\*\\* **a‸nd**');
        assert.strictEqual(await toggle('underline', 'the _cache field and the l‸ock'), 'the _cache field and the _l‸ock_');
        assert.strictEqual(await toggle('underline', 'the _cache field and the _l‸ock_'), 'the _cache field and the l‸ock');
    });

    test('blocks are read as the preview reads them', async () => {
        assert.strictEqual(await toggle('bold', '!!! note Title\n    para one\n\n    para t‸wo'), '!!! note Title\n    para one\n\n    para **t‸wo**');
        assert.strictEqual(await toggle('bold', '- a\n\n  ```\n  co‸de\n  ```'), '- a\n\n  ```\n  co‸de\n  ```');
        assert.strictEqual(await toggle('bold', '> ```\n> co‸de\n> ```'), '> ```\n> co‸de\n> ```');
        assert.strictEqual(await toggle('bold', '<kbd>Ctrl</kbd> sa‸ves'), '<kbd>Ctrl</kbd> **sa‸ves**');
        assert.strictEqual(await toggle('bold', 'text^[an inline note] a‸nd'), 'text^[an inline note] **a‸nd**');
    });

    test('a link\'s URL and a table cell\'s padding stay outside', async () => {
        assert.strictEqual(await toggle('bold', '[li«nk](url)» after'), '[li**«nk**](url)» after');
        assert.strictEqual(await toggle('bold', '| a | b |\n|---|---|\n| on‸e | two |'), '| a | b |\n|---|---|\n| **on‸e** | two |');
    });

    test('a longer run of the marker is no empty pair, and a pair that would change the line is not written', async () => {
        assert.notStrictEqual(await toggle('italics', '***‸***'), '**‸**');
        assert.strictEqual(await toggle('mark', 'Some paragraph\n‸'), 'Some paragraph\n‸');
    });

    test('a reversed selection stays reversed', async () => {
        const editor = await inline('bold', 'one two', [[7, 4]]);
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
        const editor = await open(content, selections);
        const [detect, on, onReplace, off, offReplace] = BLOCK_TOGGLE_ARGS[name];
        await toggleFormat(editor, detect, on, onReplace, off, offReplace);
        return editor.document.getText();
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
