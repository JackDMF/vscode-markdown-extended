import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

/**
 * Tokenizes markdown with the REAL built-in grammar of the VS Code build the
 * tests run in (vscode.env.appRoot) plus this extension's two injection
 * grammars — the same setup the editor uses, minus themes.
 *
 * Why these tests exist: the host grammar's meta.paragraph region pops at
 * every line end (its `while` only continues setext/indent lines), so inline
 * rules injected into it can never span lines. Multiline emphasis therefore
 * works via `multiline_emphasis_paragraph` in the block grammar, which claims
 * the paragraph itself — but only for lines carrying an unpaired emphasis
 * opener. That takeover must stay invisible everywhere else, which is exactly
 * what the "untouched" tests below pin down.
 */

const repoRoot = path.resolve(__dirname, '../../../..');

interface Token { start: number; end: number; scopes: string[] }

let grammar: vsctm.IGrammar;

async function loadGrammar(): Promise<vsctm.IGrammar> {
    const builtinPath = path.join(
        vscode.env.appRoot, 'extensions', 'markdown-basics', 'syntaxes', 'markdown.tmLanguage.json');
    const grammarPaths: { [scope: string]: string } = {
        'text.html.markdown': builtinPath,
        'text.html.markdown.extended': path.join(repoRoot, 'syntaxes', 'markdown-extended.tmLanguage.json'),
        'text.html.markdown.extended.inline': path.join(repoRoot, 'syntaxes', 'markdown-extended.inline.tmLanguage.json'),
    };

    const wasmPath = path.join(path.dirname(require.resolve('vscode-oniguruma')), 'onig.wasm');
    const onigLib = oniguruma.loadWASM(fs.readFileSync(wasmPath).buffer as ArrayBuffer).then(() => ({
        createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
    }));

    const registry = new vsctm.Registry({
        onigLib,
        loadGrammar: async (scopeName: string) => {
            const file = grammarPaths[scopeName];
            if (!file) { return null; }
            return vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
        },
        getInjections: (scopeName: string) =>
            scopeName === 'text.html.markdown'
                ? ['text.html.markdown.extended', 'text.html.markdown.extended.inline']
                : [],
    });
    return (await registry.loadGrammar('text.html.markdown'))!;
}

function tokenize(text: string): Token[][] {
    const lines: Token[][] = [];
    let ruleStack = vsctm.INITIAL;
    for (const line of text.split('\n')) {
        const result = grammar.tokenizeLine(line, ruleStack);
        lines.push(result.tokens.map(t => ({ start: t.startIndex, end: t.endIndex, scopes: t.scopes })));
        ruleStack = result.ruleStack;
    }
    return lines;
}

/** Scopes of the token covering the first occurrence of `substr` on line `lineIdx` of `text`. */
function scopesAt(text: string, lineIdx: number, substr: string): string[] {
    const line = text.split('\n')[lineIdx];
    const pos = line.indexOf(substr);
    assert.notStrictEqual(pos, -1, `"${substr}" not found on line ${lineIdx}: "${line}"`);
    const token = tokenize(text)[lineIdx].find(t => t.start <= pos && pos < t.end);
    assert.ok(token, `no token at position ${pos} of line ${lineIdx}`);
    return token!.scopes;
}

function assertScoped(text: string, lineIdx: number, substr: string, scope: string) {
    const scopes = scopesAt(text, lineIdx, substr);
    assert.ok(scopes.includes(scope),
        `expected "${substr}" (line ${lineIdx}) to have ${scope}, got: [${scopes.join(', ')}]`);
}

function assertNotEmphasized(text: string, lineIdx: number, substr: string) {
    const scopes = scopesAt(text, lineIdx, substr);
    const emphasis = scopes.filter(s => /markup\.(bold|italic)\.markdown/.test(s));
    assert.strictEqual(emphasis.length, 0,
        `expected "${substr}" (line ${lineIdx}) to carry no emphasis, got: [${emphasis.join(', ')}]`);
}

const BOLD = 'markup.bold.markdown';
const ITALIC = 'markup.italic.markdown';

suite('Markdown Grammar: multiline emphasis', () => {

    suiteSetup(async function () {
        this.timeout(15000);
        grammar = await loadGrammar();
    });

    suite('emphasis spanning soft line breaks', () => {
        test('** bold spans two lines', () => {
            const text = 'some **bold\ntext continues** here';
            assertScoped(text, 0, 'bold', BOLD);
            assertScoped(text, 1, 'text continues', BOLD);
            assertNotEmphasized(text, 1, ' here');
        });

        test('** bold spans three lines', () => {
            const text = 'some **bold\nmiddle line\nends** here';
            assertScoped(text, 1, 'middle line', BOLD);
            assertScoped(text, 2, 'ends', BOLD);
            assertNotEmphasized(text, 2, ' here');
        });

        test('__ bold spans lines', () => {
            const text = 'some __bold\ntext continues__ here';
            assertScoped(text, 1, 'text continues', BOLD);
            assertNotEmphasized(text, 1, ' here');
        });

        test('* italic spans lines', () => {
            const text = 'some *italic\ntext continues* here';
            assertScoped(text, 0, 'italic', ITALIC);
            assertScoped(text, 1, 'text continues', ITALIC);
            assertNotEmphasized(text, 1, ' here');
        });

        test('_ italic spans lines', () => {
            const text = 'some _italic\ntext continues_ here';
            assertScoped(text, 1, 'text continues', ITALIC);
            assertNotEmphasized(text, 1, ' here');
        });

        test('closed pair on the same line, then a multiline span', () => {
            const text = '**a** and **multi\nline** rest';
            assertScoped(text, 0, 'a', BOLD);
            assertNotEmphasized(text, 0, ' and ');
            assertScoped(text, 0, 'multi', BOLD);
            assertScoped(text, 1, 'line', BOLD);
            assertNotEmphasized(text, 1, ' rest');
        });

        test('italic nests inside multiline bold', () => {
            const text = '**bold *ital\nic* bold** x';
            const scopes = scopesAt(text, 1, 'ic');
            assert.ok(scopes.includes(BOLD) && scopes.includes(ITALIC),
                `expected nested bold+italic, got: [${scopes.join(', ')}]`);
            assertScoped(text, 1, ' bold', BOLD);
            assertNotEmphasized(text, 1, ' x');
        });

        test('inline link works inside a multiline bold', () => {
            const text = '**see [link](http://x.y)\nend** t';
            assertScoped(text, 0, 'link', BOLD);
            assertScoped(text, 1, 'end', BOLD);
        });

        test('taken-over paragraph keeps the host paragraph scope', () => {
            const text = 'some **bold\ntext continues** here';
            assertScoped(text, 0, 'some', 'meta.paragraph.markdown');
            assertScoped(text, 1, 'text continues', 'meta.paragraph.markdown');
        });

        test('multiline bold inside an admonition body', () => {
            const text = '!!! note\n    body **bold\n    spans** lines';
            assertScoped(text, 1, 'bold', BOLD);
            assertScoped(text, 2, 'spans', BOLD);
            assertNotEmphasized(text, 2, ' lines');
        });
    });

    suite('single-line emphasis is unchanged', () => {
        test('single-line bold and italic still highlight', () => {
            assertScoped('**bold text** normal', 0, 'bold text', BOLD);
            assertNotEmphasized('**bold text** normal', 0, ' normal');
            assertScoped('*italic text* normal', 0, 'italic text', ITALIC);
            assertNotEmphasized('*italic text* normal', 0, ' normal');
        });

        test('*** bold italic on one line still highlights both', () => {
            const scopes = scopesAt('x ***both*** y', 0, 'both');
            assert.ok(scopes.includes(BOLD), `expected bold, got: [${scopes.join(', ')}]`);
            assert.ok(scopes.includes(ITALIC), `expected italic, got: [${scopes.join(', ')}]`);
        });
    });

    suite('an unpaired opener stops at the paragraph boundary', () => {
        test('blank line ends it', () => {
            const text = 'text **stray opener\nstill same para\n\nnext paragraph';
            assertScoped(text, 1, 'still same para', BOLD);
            assertNotEmphasized(text, 3, 'next paragraph');
        });

        test('fence ends it', () => {
            const text = 'text **stray\n```\ncode here\n```';
            assertNotEmphasized(text, 2, 'code here');
        });

        test('heading ends it', () => {
            const text = 'text **stray\n# heading';
            assertNotEmphasized(text, 1, 'heading');
        });

        test('list ends it', () => {
            const text = 'text **stray\n- list item';
            assertNotEmphasized(text, 1, 'list item');
        });
    });

    suite('no false positives', () => {
        test('math and globs stay plain', () => {
            assertNotEmphasized('calc 5*3 = 15 and 2 ** 8', 0, '5*3');
            assertNotEmphasized('open *.md files and *.txt too', 0, '*.md');
            assertNotEmphasized('use snake_case_names here', 0, 'snake_case');
        });

        test('** inside a code span stays plain', () => {
            const text = 'use `**kwargs` here\nand more text';
            assertNotEmphasized(text, 0, 'kwargs');
            assertNotEmphasized(text, 1, 'and more text');
        });
    });

    suite('block constructs are not taken over', () => {
        test('heading line with a stray opener stays a heading', () => {
            const text = '# head **stray\nnext line';
            assertScoped(text, 0, 'head', 'markup.heading.markdown');
            assertNotEmphasized(text, 1, 'next line');
        });

        test('blockquote line with a stray opener stays a quote', () => {
            const text = '> quote **stray\n> more quote';
            assertScoped(text, 0, 'quote', 'markup.quote.markdown');
            assertNotEmphasized(text, 1, 'more quote');
        });

        test('table row with a stray opener stays a table', () => {
            const text = '| a **b | c |\n| --- | --- |';
            assertScoped(text, 0, 'a', 'markup.table.markdown');
        });
    });

    suite('extension marks still work after a multiline paragraph', () => {
        test('==mark== highlights in the following paragraph', () => {
            const text = 'a **multi\nline** b\n\nplain para ==mark== end';
            assertScoped(text, 3, 'mark', 'markup.highlight.markdown');
            assertNotEmphasized(text, 3, ' end');
        });
    });
});
