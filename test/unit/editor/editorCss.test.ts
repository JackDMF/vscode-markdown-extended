import * as assert from 'assert';
import * as path from 'path';
import { readText, repoRoot } from './helpers';

/**
 * A colour written as a value: hex, a colour function, a named or a system
 * colour. `transparent`, `currentColor` and `inherit` are not colours of a
 * theme and may stand anywhere.
 */
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|Canvas|CanvasText|Highlight|HighlightText|GrayText|ButtonFace|ButtonText|LinkText)\b/gi;

/** Properties whose colour is only an alpha channel, never shown as a colour: a mask's gradient. */
const ALPHA_ONLY = new Set(['mask-image', '-webkit-mask-image']);

/** Every declaration of `css` as `[property, value, line]`, comments left out. */
function declarations(css: string): [string, string, number][] {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
    const out: [string, string, number][] = [];
    const re = /([-a-z]+)\s*:\s*([^;{}]+)(?=;|\})/gi;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        // A selector's pseudo-class (`a:hover {`) is followed by `{`, which the lookahead excludes.
        out.push([m[1].toLowerCase(), m[2], text.slice(0, m.index).split('\n').length]);
    }
    return out;
}

/**
 * Whether the text at `at` in `value` stands as the fallback of a `var()` —
 * after the first comma of some `var(` it is nested in — and so is only what
 * a page without the workbench's variables sees.
 */
function isFallback(value: string, at: number): boolean {
    const stack: { name: string; comma: boolean }[] = [];
    let word = '';
    for (let i = 0; i < at; i++) {
        const c = value[i];
        if (c === '(') {
            stack.push({ name: word.toLowerCase(), comma: false });
            word = '';
        } else if (c === ')') {
            stack.pop();
            word = '';
        } else if (c === ',') {
            if (stack.length > 0) {
                stack[stack.length - 1].comma = true;
            }
            word = '';
        } else if (/[-\w]/.test(c)) {
            word += c;
        } else {
            word = '';
        }
    }
    return stack.some(frame => frame.name === 'var' && frame.comma);
}

/**
 * The editor's chrome reads every colour from the workbench (Daniel,
 * 2026-09-30): the row, the menus, the bars, the bubble, the cards. A colour
 * written into `editor.css` as a value would be the same in every theme — a
 * light grey on High Contrast black — so none is, except as the fallback after
 * a `--vscode-*` variable, for a page that has none. The samples are not
 * styled here at all (their look is the document's cascade), so there is no
 * sample exception to make.
 */
suite('Editor stylesheet colours', () => {
    const css = readText(path.join(repoRoot, 'styles', 'editor.css'));

    test('no literal colour in editor.css outside a var() fallback', () => {
        const offenders: string[] = [];
        const all = declarations(css);
        assert.ok(all.filter(([p]) => p === 'color' || p === 'background').length > 50, 'the whole stylesheet is read');
        for (const [property, value, line] of all) {
            if (ALPHA_ONLY.has(property)) {
                continue;
            }
            for (const m of value.matchAll(COLOUR)) {
                if (!isFallback(value, m.index ?? 0)) {
                    offenders.push(`line ${line}: ${property}: ${value.trim()}`);
                    break;
                }
            }
        }
        assert.deepStrictEqual(offenders, []);
    });

    test('the check sees a literal colour, and a fallback as one', () => {
        assert.deepStrictEqual(declarations('.a { color: #fff; }').map(([p, v]) => [p, v.trim()]), [['color', '#fff']]);
        assert.strictEqual(isFallback('#fff', 0), false);
        assert.strictEqual(isFallback('var(--vscode-x, #fff)', 'var(--vscode-x, '.length), true);
        assert.strictEqual(isFallback('var(--vscode-x, var(--vscode-y, #fff))', 'var(--vscode-x, var(--vscode-y, '.length), true);
        assert.strictEqual(isFallback('0 2px 8px rgba(0, 0, 0, 0.3)', '0 2px 8px '.length), false);
        assert.strictEqual(isFallback('color-mix(in srgb, #888 20%, transparent)', 'color-mix(in srgb, '.length), false, 'a comma of another function is no fallback');
        assert.strictEqual(isFallback('color-mix(in srgb, var(--vscode-foreground, #888) 20%, transparent)', 'color-mix(in srgb, var(--vscode-foreground, '.length), true);
    });

    test('the row, the menus and the bars read the workbench\'s chrome variables', () => {
        for (const variable of [
            '--vscode-editorGroupHeader-tabsBackground', '--vscode-editorGroupHeader-tabsBorder', '--vscode-toolbar-hoverBackground', '--vscode-toolbar-activeBackground',
            '--vscode-menu-background', '--vscode-menu-foreground', '--vscode-menu-border', '--vscode-menu-selectionBackground', '--vscode-menu-selectionForeground',
            '--vscode-menu-separatorBackground', '--vscode-widget-shadow', '--vscode-editorWidget-background', '--vscode-editorWidget-border', '--vscode-focusBorder',
        ]) {
            assert.ok(css.includes(`var(${variable}`), `editor.css reads ${variable}`);
        }
    });
});
