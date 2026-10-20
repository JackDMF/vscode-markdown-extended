import * as assert from 'assert';
import { parseDocument, serializeDocument } from '../../../src/editor';
import {
    BACKTICK_INFO_REFUSAL, NO_FENCE_REFUSAL, OpeningLine, documentLanguages, languageCompletions, languageName, languageOf, minimumFence, openingLineOf,
    parseOpeningLine, shortFenceRefusal, withLanguage,
} from '../../../src/editor/fences';
import { hostEngine } from './helpers';

/** The first block of `text` as the editor parses it: a code block's attributes. */
function codeBlockOf(text: string): { markup: string; params: string; attrsSuffix: string | null; content: string } {
    const { doc } = parseDocument(hostEngine(), text, {});
    const node = doc.firstChild!;
    assert.strictEqual(node.type.name, 'code_block');
    return { markup: node.attrs.markup as string, params: node.attrs.params as string, attrsSuffix: node.attrs.attrsSuffix as string | null, content: node.textContent };
}

/**
 * A code block's opening line (`fences.ts`): the one composer the save, the
 * bar's field and its refusals read, against what markdown-it parses.
 */
suite('Editor code blocks: the opening line', () => {
    suite('openingLineOf ↔ parseOpeningLine: what the file reads is what the field shows', () => {
        for (const line of ['```', '```js', '```js {.numbered}', '````', '````ts title=x {#a .b}', '~~~', '~~~sh', '~~~a`b {.x}']) {
            test(line, () => {
                const block = codeBlockOf(`${line}\nx\n${line.replace(/[^`~].*$/, '')}\n`);
                assert.strictEqual(openingLineOf(block), line, 'composed from the parsed node');
                const parsed = parseOpeningLine(line, block.content) as OpeningLine;
                assert.deepStrictEqual(parsed, { markup: block.markup, params: block.params, literal: block.attrsSuffix });
                const written = serializeDocument({ doc: parseDocument(hostEngine(), `${line}\nx\n${line.replace(/[^`~].*$/, '')}\n`, {}).doc, eol: '\n', tail: '' }, { defaultWrap: 90 });
                assert.strictEqual(written.split('\n')[0], line, 'the save writes the same line');
            });
        }

        test('an indented block has no opening line', () => {
            assert.strictEqual(openingLineOf(codeBlockOf('    x\n')), '');
        });
    });

    suite('parseOpeningLine: the refusals', () => {
        test('no fence: "js"', () => {
            assert.deepStrictEqual(parseOpeningLine('js {.x}', 'x'), { refusal: NO_FENCE_REFUSAL });
        });

        test('too short to be a fence: "``"', () => {
            assert.deepStrictEqual(parseOpeningLine('``', 'x'), { refusal: NO_FENCE_REFUSAL });
        });

        test('``` on content holding a ``` run names the fence needed', () => {
            assert.deepStrictEqual(parseOpeningLine('```js', 'a\n```\nb'), { refusal: shortFenceRefusal('````') });
            assert.deepStrictEqual(parseOpeningLine('````js', 'a\n```\nb'), { markup: '````', params: 'js', literal: null });
            assert.deepStrictEqual(parseOpeningLine('~~~js', 'a\n```\nb'), { markup: '~~~', params: 'js', literal: null }, 'another character is no run');
        });

        test('a backtick after a ``` fence: "```a`b"', () => {
            assert.deepStrictEqual(parseOpeningLine('```a`b', 'x'), { refusal: BACKTICK_INFO_REFUSAL });
        });

        test('a brace pair the plugin would not take is handed on as the literal, for its own check', () => {
            assert.deepStrictEqual(parseOpeningLine('```js {.}', 'x'), { markup: '```', params: 'js', literal: '{.}' });
        });
    });

    suite('minimumFence', () => {
        test('the fence, or one past the longest run of its character a line starts with', () => {
            assert.strictEqual(minimumFence('```', 'x'), '```');
            assert.strictEqual(minimumFence('```', '   ````\n'), '`````');
            assert.strictEqual(minimumFence('~~~', '```'), '~~~');
            assert.strictEqual(minimumFence('```', 'a ```'), '```', 'a run inside a line closes nothing');
        });
    });

    suite('the language: the info string\'s first word', () => {
        test('languageOf', () => {
            assert.strictEqual(languageOf(''), '');
            assert.strictEqual(languageOf('js title=x'), 'js');
            assert.strictEqual(languageOf('  ts  '), 'ts');
        });

        const cases: [string, string, string][] = [
            ['js title=x', 'ts', 'ts title=x'],
            ['js title=x', '', 'title=x'],
            ['js', 'ts', 'ts'],
            ['', 'sh', 'sh'],
            ['', '', ''],
            ['js', '', ''],
        ];
        for (const [params, language, expected] of cases) {
            test(`withLanguage(${JSON.stringify(params)}, ${JSON.stringify(language)}) → ${JSON.stringify(expected)}`, () => {
                assert.strictEqual(withLanguage(params, language), expected);
            });
        }
    });

    suite('the completions: the document\'s languages first, then highlight.js\'s', () => {
        const doc = parseDocument(hostEngine(), '```json\n{}\n```\n\n```js\na\n```\n\n```js x\nb\n```\n\n```zzz\nc\n```\n', {}).doc;

        test('documentLanguages: most used first, then by first appearance', () => {
            assert.deepStrictEqual(documentLanguages(doc), ['js', 'json', 'zzz']);
        });

        test('"j": js and json from the document, then highlight.js\'s by prefix', () => {
            const list = languageCompletions(doc, 'j');
            assert.deepStrictEqual(list.slice(0, 2), [
                { value: 'js', label: 'js', detail: 'JavaScript · in this document' },
                { value: 'json', label: 'json', detail: 'JSON · in this document' },
            ]);
            const values = list.map(c => c.value);
            assert.ok(values.includes('javascript'), 'the id');
            assert.strictEqual(values.filter(v => v === 'json').length, 1, 'a language offered once');
            assert.ok(values.every(v => v.startsWith('j')));
        });

        test('an alias is found, and offered as typed', () => {
            const ts = languageCompletions(doc, 'ts').find(c => c.detail === 'TypeScript');
            assert.deepStrictEqual(ts, { value: 'ts', label: 'ts', detail: 'TypeScript' });
        });

        test('a word the document uses that highlight.js does not know is offered; any word is accepted — none is refused', () => {
            assert.deepStrictEqual(languageCompletions(doc, 'zz'), [{ value: 'zzz', label: 'zzz', detail: 'in this document' }]);
            assert.deepStrictEqual(languageCompletions(doc, 'qqqq'), []);
        });

        test('languageName by id and by alias', () => {
            assert.strictEqual(languageName('javascript'), 'JavaScript');
            assert.strictEqual(languageName('JS'), 'JavaScript');
            assert.strictEqual(languageName('nope'), null);
        });
    });
});
