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
        // `~~~strike~~~` reads as a strikethrough between two `~`s, no
        // subscript: a toggle that would not read as written is not made.
        assert.strictEqual(await toggle('subscript', 'x ~~st‸rike~~ y'), 'x ~~st‸rike~~ y');
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

    test('a wiki embed is toggled whole, and nothing is written into it', async () => {
        assert.strictEqual(await toggle('bold', 'x «see ![[a b]] here» y'), 'x **«see ![[a b]] here»** y');
        assert.strictEqual(await toggle('italics', 'x «see ![[a b]] here» y'), 'x *«see ![[a b]] here»* y');
        // The embed alone is no text a part takes, as a code span or an image alone is not: nothing to wrap.
        assert.strictEqual(await toggle('bold', 'see «![[a b]]» here'), 'see «![[a b]]» here');
        assert.strictEqual(await toggle('italics', 'see «![[a b]]» here'), 'see «![[a b]]» here');
        assert.strictEqual(await toggle('bold', 'see «![a](b)» here'), 'see «![a](b)» here');
        assert.strictEqual(await toggle('bold', '**see ![[a b]] he‸re**'), 'see ![[a b]] he‸re');
        assert.strictEqual(await toggle('bold', 'see ![[a ‸b]] here'), 'see ![[a ‸b]] here');
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
        assert.strictEqual(await toggle('bold', '«- [ ] **task one**\n- [x] **task two»**'), '«- [ ] task one\n- [x] task two»');
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

    test('an empty pair inside another is removed again, and a pair that would change the line is not written', async () => {
        assert.strictEqual(await toggle('italics', 'x **‸** y'), 'x ***‸*** y');
        assert.strictEqual(await toggle('italics', 'x ***‸*** y'), 'x **‸** y');
        assert.strictEqual(await toggle('bold', 'x ***‸*** y'), 'x *‸* y');
        assert.strictEqual(await toggle('mark', 'Some paragraph\n‸'), 'Some paragraph\n‸');
    });

    test('an empty list item, quote or definition gets the pair', async () => {
        assert.strictEqual(await toggle('bold', '- ‸'), '- **‸**');
        assert.strictEqual(await toggle('bold', '1. ‸'), '1. **‸**');
        assert.strictEqual(await toggle('bold', '> ‸'), '> **‸**');
        assert.strictEqual(await toggle('bold', '- a\n- ‸'), '- a\n- **‸**');
        assert.strictEqual(await toggle('bold', 'Term\n: ‸'), 'Term\n: **‸**');
        assert.strictEqual(await toggle('mark', '- ‸'), '- ==‸==');
        assert.strictEqual(await toggle('codeInline', '- ‸'), '- `‸`');
    });

    test('a task\'s text is toggled inside its label, which takes the whole text', async () => {
        assert.strictEqual(await toggle('bold', '- [ ] ta‸sk one'), '- [ ] **ta‸sk** one');
        assert.strictEqual(await toggle('bold', '- [ ] «task one»'), '- [ ] **«task one»**');
        assert.strictEqual(await toggle('bold', '- [ ] **«task one»**'), '- [ ] «task one»');
        assert.strictEqual(await toggle('codeInline', '- [x] see ‸this'), '- [x] see `‸this`');
    });

    test('Code over an entity or an escape in a link or a task\'s label keeps the element\'s text', async () => {
        assert.strictEqual(await toggle('codeInline', '[a «&amp; b»](u) c'), '[a `«&amp; b»`](u) c');
        assert.strictEqual(await toggle('codeInline', '- [ ] a «&amp; b» c'), '- [ ] a `«&amp; b»` c');
        assert.strictEqual(await toggle('codeInline', '- [ ] a `&amp;‸` c'), '- [ ] a &amp;‸ c');
        assert.strictEqual(await toggle('codeInline', '- [ ] a «\\*b\\*» c'), '- [ ] a `«\\*b\\*»` c');
        assert.strictEqual(await toggle('codeInline', '- [ ] rename «foo\\_bar»'), '- [ ] rename `«foo\\_bar»`');
        assert.strictEqual(await toggle('codeInline', '- [ ] rename `foo\\_bar‸`'), '- [ ] rename foo\\_bar‸');
        // In a paragraph, as before.
        assert.strictEqual(await toggle('codeInline', 'a «&amp; b» c'), 'a `«&amp; b»` c');
        assert.strictEqual(await toggle('codeInline', 'a `&amp;‸` c'), 'a &amp;‸ c');
    });

    test('a span of the marker the selection touches becomes part of it; one it crosses is not broken', async () => {
        assert.strictEqual(await toggle('bold', '**foo**«bar»'), '**foo«bar»**');
        assert.strictEqual(await toggle('bold', '«foo»**bar**'), '**«foo»bar**');
        assert.strictEqual(await toggle('italics', '*foo*«bar»'), '*foo«bar»*');
        assert.strictEqual(await toggle('superscript', '^a^«b»'), '^a«b»^');
        // Neither `*a*b*c` nor `__foo_bar_` reads as written: nothing is.
        assert.strictEqual(await toggle('italics', '«a*b»*c'), '«a*b»*c');
        assert.strictEqual(await toggle('underline', '_foo_«bar»'), '_foo_«bar»');
    });

    test('Code over a code span takes its backticks out: code does not nest', async () => {
        assert.strictEqual(await toggle('codeInline', '«run `npm i` now»'), '`«run npm i now»`');
        assert.strictEqual(await toggle('codeInline', '«a `b` c»'), '`«a b c»`');
    });

    test('Code joins a code span the selection touches, as the other markers join theirs', async () => {
        assert.strictEqual(await toggle('codeInline', 'x `foo`«bar» y'), 'x `foo«bar»` y');
        assert.strictEqual(await toggle('codeInline', '«foo»`bar`'), '`«foo»bar`');
        // Its content holds a backtick: joined, it would not be one code span.
        assert.strictEqual(await toggle('codeInline', '``a`b``«c»'), '``a`b``«c»');
    });

    test('a span the selection holds over two lines stays one, inside the new markers', async () => {
        assert.strictEqual(await toggle('italics', '«x **a\nb** y»'), '*«x **a\nb** y»*');
        assert.strictEqual(await toggle('mark', '«x **a\nb** y»'), '==«x **a\nb** y»==');
        assert.strictEqual(await toggle('italics', '*«x **a\nb** y»*'), '«x **a\nb** y»');
        assert.strictEqual(await toggle('italics', '«**a\nb**»'), '«***a*\n*b***»');
        assert.strictEqual(await toggle('bold', '**a «b\nc» d**'), 'a «b\nc» d');
    });

    test('no toggle leaves a run of tildes that opens a fence', async () => {
        const after = '\n\nnext paragraph\n\n# Heading';
        assert.strictEqual(await toggle('strikethrough', `«~/.bashrc» holds the settings${after}`), `«~/.bashrc» holds the settings${after}`);
        assert.strictEqual(await toggle('subscript', `~~Dep‸recated~~ since 2.0${after}`), `~~Dep‸recated~~ since 2.0${after}`);
        assert.strictEqual(await toggle('strikethrough', `~«x»~ y${after}`), `~«x»~ y${after}`);
    });

    test('no pair is written into a definition, and no toggle loses one', async () => {
        for (const [name, marked] of [
            ['bold', 'see [a][x] and [b][x]\n\n[x]:‸ http://u'],
            ['bold', 'see [a][x]\n\n‸[x]: http://u'],
            ['italics', 'see [a][x]\n\n[x]: http://u ‸'],
            ['mark', 'see [a][x]\n\n[x]: http://u "T"‸'],
            ['bold', 'see [a][x]\n\n> [x]:‸ http://u'],
            ['bold', '- [x]:‸ http://u\n\nsee [a][x]'],
            ['bold', 'the HTML\n\n*[HTML]:‸ Hyper'],
            // `[x]:` is text until a destination follows: the pair would be one.
            ['bold', 'see [a][x]\n\n[x]: ‸'],
        ] as [InlineMarkerName, string][]) {
            assert.strictEqual(await toggle(name, marked), marked);
        }
        // A footnote's label is a container's: its empty body gets the pair.
        assert.strictEqual(await toggle('bold', 'x[^1]\n\n[^1]: ‸'), 'x[^1]\n\n[^1]: **‸**');
    });

    test('a pair on a blank line does not join the block below it', async () => {
        for (const [name, marked] of [
            ['italics', '# T\n\n‸\n---'],
            ['italics', 'text\n\n‸\n    code line'],
            ['italics', 'text\n\n‸\n==='],
        ] as [InlineMarkerName, string][]) {
            assert.strictEqual(await toggle(name, marked), marked);
        }
        // `****` is a thematic break: the code below stays code.
        assert.strictEqual(await toggle('bold', 'text\n\n‸\n    code line'), 'text\n\n**‸**\n    code line');
    });

    test('nothing is written into a link\'s destination or inline HTML', async () => {
        assert.strictEqual(await toggle('bold', 'see [a](‸./b.md) now'), 'see [a](‸./b.md) now');
        assert.strictEqual(await toggle('bold', 'x <‸/span> y'), 'x <‸/span> y');
    });

    test('no attribute goes from one element to another', async () => {
        for (const [name, marked] of [
            // A block's `{…}` would go to the span written before it.
            ['bold', '# Title f‸oo{#x}'],
            ['bold', 'Some f‸oo{.note}'],
            ['codeInline', '## Head wo‸rd{#h}'],
            // A span's would go to its block, or to the element inside it.
            ['bold', 'para **x‸**{.c}'],
            ['italics', '## Head *wo‸rd*{#h}'],
            ['codeInline', 'para `x‸`{#y}'],
            ['bold', '**x [a](u)‸**{#x} y'],
        ] as [InlineMarkerName, string][]) {
            assert.strictEqual(await toggle(name, marked), marked);
        }
        // Away from them, the attributes stay where they are.
        assert.strictEqual(await toggle('bold', '# T‸itle foo{#x}'), '# **T‸itle** foo{#x}');
        assert.strictEqual(await toggle('bold', '«x [a](u)»{#x} y'), '**«x** [**a**](u)»{#x} y');
    });

    test('a definition made by the pair at one cursor does not let another cursor change a block', async () => {
        assert.strictEqual(await toggle('mark', 'foo\n‸\n\nTerm\n: ‸'), 'foo\n‸\n\nTerm\n: ==‸==');
        // Nor the list item it stands in: `b` would leave it, under a thematic break.
        assert.strictEqual(await toggle('bold', '- Term\n  : ‸\n\n‸\n  b'), '- Term\n  : **‸**\n\n‸\n  b');
    });

    test('a pair makes a definition inside a quote as outside one', async () => {
        assert.strictEqual(await toggle('bold', '> Term\n> : ‸'), '> Term\n> : **‸**');
        assert.strictEqual(await toggle('bold', '> Term\n> : **‸**'), '> Term\n> : ‸');
    });

    test('a definition made by the pair takes no attribute from its term\'s paragraph, nor gives one back', async () => {
        // The id would go from the paragraph `Term` stands in to an empty one after the list.
        assert.strictEqual(await toggle('bold', 'Term\n: ‸\n{#anchor}'), 'Term\n: ‸\n{#anchor}');
        assert.strictEqual(await toggle('bold', 'Term\n: **‸**\n{#anchor}'), 'Term\n: **‸**\n{#anchor}');
        // A paragraph of the pair alone keeps its own.
        assert.strictEqual(await toggle('mark', '‸\n{.c}'), '==‸==\n{.c}');
    });

    test('a definition made by the pair joins the list before or after it', async () => {
        assert.strictEqual(await toggle('bold', 'Term1\n: def1\n\nTerm2\n: ‸'), 'Term1\n: def1\n\nTerm2\n: **‸**');
        assert.strictEqual(await toggle('bold', 'Term1\n: def1\n\nTerm2\n: **‸**'), 'Term1\n: def1\n\nTerm2\n: ‸');
        assert.strictEqual(await toggle('bold', 'Term1\n: ‸\n\nTerm2\n: def2'), 'Term1\n: **‸**\n\nTerm2\n: def2');
        assert.strictEqual(await toggle('bold', 'Term1\n: def1\n\nTerm2\n: ‸\n\nTerm3\n: def3'), 'Term1\n: def1\n\nTerm2\n: **‸**\n\nTerm3\n: def3');
        // The definition after it stands a blank line below its term.
        assert.strictEqual(await toggle('bold', 'Term1\n: ‸\n\nTerm2\n\n: def2'), 'Term1\n: **‸**\n\nTerm2\n\n: def2');
        assert.strictEqual(await toggle('bold', 'Term1\n: **‸**\n\nTerm2\n\n: def2'), 'Term1\n: ‸\n\nTerm2\n\n: def2');
        // In a quote the line between is `>`, which holds no text and is as blank.
        assert.strictEqual(await toggle('bold', '> Term1\n> : ‸\n>\n> Term2\n>\n> : def2'), '> Term1\n> : **‸**\n>\n> Term2\n>\n> : def2');
        assert.strictEqual(await toggle('bold', '> Term1\n> : **‸**\n>\n> Term2\n>\n> : def2'), '> Term1\n> : ‸\n>\n> Term2\n>\n> : def2');
        // `Term2` continues `def1`: the pair would take it out of that paragraph.
        assert.strictEqual(await toggle('bold', 'Term1\n: def1\nTerm2\n: ‸'), 'Term1\n: def1\nTerm2\n: ‸');
    });

    test('an empty pair is taken out only where the rest reads as before', async () => {
        for (const [name, marked] of [
            // Its markers are another span's.
            ['italics', 'see *‸*[link](u)** now'],
            ['codeInline', 'run `‸` `x` `` now'],
            // Its line is a thematic break, a setext underline, a fence, code.
            ['italics', 'x\n\n*‸**\n\ny'],
            ['mark', 'Title\n==‸=='],
            ['strikethrough', '~~‸~~\ncode\n~~~~\n\nafter'],
            ['mark', '```\n==‸==\n```'],
            // Without it, the line would be indented code.
            ['bold', 'x\n\n  **‸**  text here'],
        ] as [InlineMarkerName, string][]) {
            assert.strictEqual(await toggle(name, marked), marked);
        }
        // Refused, the cursor toggles the span it stands next to.
        assert.strictEqual(await toggle('italics', '*‸**bold***'), '‸**bold**');
        // Beside another cursor's wrap, each is read again with the other.
        assert.strictEqual(await toggle('mark', 'x\n\n ==‸==   «w y»'), 'x\n\n ==‸==   ==«w y»==');
    });

    test('cursors that each need their alternative are read again in a few parses, not one per cursor', async () => {
        let parsed = 0;
        const counting = Object.create(md) as typeof md;
        counting.parse = (src, env) => {
            parsed += src.length;
            return md.parse(src, env);
        };
        // One list; at every cursor `~**zed**~` does not read as written, `**~zed~**` does.
        const items = Array.from({ length: 100 }, (_, i) => `- item ~zed~ number ${i}`);
        const content = items.join('\n');
        const editor = await open(content, items.map((_, i) => {
            const at = content.indexOf('zed', i === 0 ? 0 : content.indexOf(items[i])) + 1;
            return [at, at] as [number, number];
        }));
        await toggleInlineFormat(editor, INLINE_MARKERS.bold, counting);
        assert.strictEqual(editor.document.getText(), items.map(item => item.replace('~zed~', '**~zed~**')).join('\n'));
        assert.ok(parsed <= 10 * content.length, `${parsed} characters parsed for ${content.length}`);
    });

    /** The characters `md` parses while `marker` is toggled at every cursor of `content`, and the result. */
    async function parsedFor(marker: string, content: string, cursors: [number, number][]): Promise<{ parsed: number; text: string }> {
        let parsed = 0;
        const counting = Object.create(md) as typeof md;
        counting.parse = (src, env) => {
            parsed += src.length;
            return md.parse(src, env);
        };
        const editor = await open(content, cursors.map(([line, character]) => {
            const at = content.split('\n').slice(0, line).reduce((sum, l) => sum + l.length + 1, 0) + character;
            return [at, at] as [number, number];
        }));
        await toggleInlineFormat(editor, marker, counting);
        return { parsed, text: editor.document.getText() };
    }

    test('one cursor changing a block among many is found in a few readings, not one per cursor', async () => {
        // `==` on the blank line under `Title` would make it a heading; every other cursor wraps its word.
        const paragraphs = Array.from({ length: 100 }, (_, i) => `para zed number ${i}`);
        const content = 'Title\n\n\n' + paragraphs.join('\n\n');
        const { parsed, text } = await parsedFor(INLINE_MARKERS.mark, content, [[1, 0], ...paragraphs.map((_, i) => [3 + 2 * i, 6] as [number, number])]);
        assert.strictEqual(text, 'Title\n\n\n' + paragraphs.map(p => p.replace('zed', '==zed==')).join('\n\n'));
        assert.ok(parsed <= 20 * content.length, `${parsed} characters parsed for ${content.length}`);
    });

    test('one cursor changing a block all the others stand in is found in a few readings, not one per cursor', async () => {
        // `==` on the line under `- Title` would make it a heading; every item's cursor wraps its word.
        const items = Array.from({ length: 100 }, (_, i) => `- item zed number ${i}`);
        const content = '- Title\n  \n' + items.join('\n');
        const { parsed, text } = await parsedFor(INLINE_MARKERS.mark, content, [[1, 2], ...items.map((_, i) => [2 + i, 7] as [number, number])]);
        assert.strictEqual(text, '- Title\n  \n' + items.map(item => item.replace('zed', '==zed==')).join('\n'));
        assert.ok(parsed <= 40 * content.length, `${parsed} characters parsed for ${content.length}`);
    });

    test('a cursor going wrong before any reading does not hide the one changing the block', async () => {
        // Between `=` and `=` the pair would not read as one; it fails before the text is read again.
        const items = Array.from({ length: 100 }, (_, i) => `- item zed number ${i}`);
        const content = '- Title\n  \n- a == b\n' + items.join('\n');
        const { parsed, text } = await parsedFor(INLINE_MARKERS.mark, content, [[1, 2], [2, 5], ...items.map((_, i) => [3 + i, 7] as [number, number])]);
        assert.strictEqual(text, '- Title\n  \n- a == b\n' + items.map(item => item.replace('zed', '==zed==')).join('\n'));
        assert.ok(parsed <= 40 * content.length, `${parsed} characters parsed for ${content.length}`);
    });

    test('one cursor going wrong among many in one paragraph is found in a few readings, not one per cursor', async () => {
        // At the first line's cursor `~**zed**~` does not read as written, `**~zed~**` does.
        const lines = Array.from({ length: 100 }, (_, i) => (i === 0 ? 'line ~zed~ number ' : 'line zed number ') + i);
        const content = lines.join('\n');
        const { parsed, text } = await parsedFor(INLINE_MARKERS.bold, content, lines.map((_, i) => [i, i === 0 ? 7 : 6] as [number, number]));
        assert.strictEqual(text, lines.map(l => l.replace('~zed~', '**~zed~**').replace(/ zed /, ' **zed** ')).join('\n'));
        assert.ok(parsed <= 40 * content.length, `${parsed} characters parsed for ${content.length}`);
    });

    test('a reversed selection stays reversed', async () => {
        const editor = await inline('bold', 'one two', [[7, 4]]);
        assert.strictEqual(editor.document.getText(), 'one **two**');
        assert.deepStrictEqual([editor.selection.anchor.character, editor.selection.active.character], [9, 6]);
    });
});

/**
 * The toggles with the engine of a host whose built-in Markdown Math is on:
 * its own extender, the one the Visual Editor's engine collects, so `$…$`
 * and `$$` are what that extension makes them.
 */
suite('Inline toggles: with VS Code\'s math', () => {
    let mathMd: typeof md;

    suiteSetup(async () => {
        const math = vscode.extensions.getExtension<{ extendMarkdownIt(md: typeof mathMd): typeof mathMd }>('vscode.markdown-math');
        assert.ok(math, 'VS Code\'s built-in markdown-math is installed');
        const api = await math.activate();
        mathMd = hostEngine([engine => api.extendMarkdownIt(engine) || engine]);
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function toggle(name: InlineMarkerName, marked: string): Promise<string> {
        const { content, selections } = parse(marked);
        const editor = await open(content, selections);
        await toggleInlineFormat(editor, INLINE_MARKERS[name], mathMd);
        return read(editor);
    }

    test('the engine reads math as math', () => {
        assert.ok(mathMd.parse('x $a$ y', {})[1].children.some(t => t.type === 'math_inline'));
    });

    test('nothing is written into math, inline or a block', async () => {
        for (const [name, marked] of [
            ['bold', 'x $a +‸ b$ y'],
            ['italics', 'x $a ‸ b$ y'],
            ['bold', 'x $$a +‸ b$$ y'],
            ['bold', '$$\na +‸ b\n$$'],
        ] as [InlineMarkerName, string][]) {
            assert.strictEqual(await toggle(name, marked), marked);
        }
    });

    test('the text between math is toggled, math left outside', async () => {
        assert.strictEqual(await toggle('bold', 'x $a$ wo‸rd $b$ y'), 'x $a$ **wo‸rd** $b$ y');
        assert.strictEqual(await toggle('codeInline', 'x $a$ «b» $c$'), 'x $a$ `«b»` $c$');
        // A `$` that opens no math is text.
        assert.strictEqual(await toggle('italics', 'cost $5 and «word» $6 here'), 'cost $5 and *«word»* $6 here');
    });
});

/**
 * Text stays in the element it stands in. The engine's elements keep their
 * text when toggled (a task's label takes the task's whole text), so the
 * check is read with a plugin whose element ends where the first text does,
 * as the label once did: a pair written inside would take text out of it.
 */
suite('Inline toggles: text stays in its element', () => {
    let tagMd: typeof md;

    suiteSetup(() => {
        tagMd = hostEngine([engine => {
            engine.core.ruler.push('first_text_tag', state => {
                for (const token of state.tokens) {
                    const first = token.type === 'inline' ? token.children?.[0] : undefined;
                    if (first?.type === 'text' && first.content.startsWith('tag ')) {
                        token.children.splice(0, 1, new state.Token('tag_open', 'span', 1), first, new state.Token('tag_close', 'span', -1));
                    }
                }
            });
            return engine;
        }]);
    });

    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    async function toggle(name: InlineMarkerName, marked: string): Promise<string> {
        const { content, selections } = parse(marked);
        const editor = await open(content, selections);
        await toggleInlineFormat(editor, INLINE_MARKERS[name], tagMd);
        return read(editor);
    }

    test('a pair that would take text out of its element is not written', async () => {
        assert.strictEqual(await toggle('bold', 'tag ta‸sk one'), 'tag ta‸sk one');
        assert.strictEqual(await toggle('codeInline', 'tag ta‸sk one'), 'tag ta‸sk one');
        // Text the element does not hold is toggled.
        assert.strictEqual(await toggle('bold', 'plain ta‸sk one'), 'plain **ta‸sk** one');
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
