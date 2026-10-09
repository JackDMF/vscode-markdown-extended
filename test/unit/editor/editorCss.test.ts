import * as assert from 'assert';
import * as path from 'path';
import { readText, repoRoot } from './helpers';

/** The properties whose value is, or holds, a colour. A custom property counts when its name says it is one. */
const COLOUR_PROPERTY = /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|box-shadow|text-decoration(?:-color)?|accent-color|caret-color|column-rule(?:-color)?|fill|stroke|--mep-[-a-z]*(?:border|separator|edge|bar|colou?r))$/;

/** Properties whose colour is only an alpha channel, never shown as a colour: a mask's gradient. */
const ALPHA_ONLY = new Set(['mask-image', '-webkit-mask-image']);

/**
 * The words a colour value may hold outside a fallback: no colour, the
 * inherited one, and the keywords of the shorthands that carry a colour
 * (a border's style, a shadow's `inset`, a decoration's line, `color-mix`'s
 * colour space). Any other word — `red`, `rebeccapurple`, `Canvas` — is a
 * colour written into the stylesheet, the same in every theme.
 */
const KEYWORDS = new Set([
    'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'none', 'auto',
    'solid', 'dashed', 'dotted', 'double', 'inset', 'underline', 'wavy', 'line-through', 'in', 'srgb', 'oklab',
]);

/** What a fallback, the colour of a page without the workbench's variables, may be: a literal colour, a system colour, or no colour. */
const FALLBACK = /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([^()]*\)|transparent|inherit|currentcolor|Canvas|CanvasText|Highlight|HighlightText|GrayText|LinkText)$/i;

/**
 * Variables the colour registry leaves unset in some theme — High Contrast's
 * toolbar and option surfaces, its menu selection, inline code's surface — so a webview in that theme
 * has no such variable and the fallback is what shows. The fallback must be
 * `transparent` (directly or at the end of a chain), or a grey or blue surface
 * is painted where VS Code draws only an outline.
 */
const UNSET_IN_SOME_THEME = [
    '--vscode-toolbar-hoverBackground', '--vscode-toolbar-activeBackground', '--vscode-inputOption-activeBackground', '--vscode-menu-selectionBackground', '--vscode-textPreformat-background',
];

/** Every declaration of `css` as `[property, value, line]`, comments left out. */
function declarations(css: string): [string, string, number][] {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
    const out: [string, string, number][] = [];
    const re = /([-a-z]+)\s*:\s*([^;{}]+)(?=;|\})/gi;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        // A selector's pseudo-class (`a:hover {`) is followed by `{`, which the lookahead excludes.
        out.push([m[1].toLowerCase(), m[2].replace(/!\s*important\s*$/i, '').trim(), text.slice(0, m.index).split('\n').length]);
    }
    return out;
}

/** The index of the parenthesis closing the one opened at `open` in `s`. */
function closing(s: string, open: number): number {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
        if (s[i] === '(') {
            depth++;
        } else if (s[i] === ')' && --depth === 0) {
            return i;
        }
    }
    throw new Error(`unbalanced: ${s}`);
}

interface VarUse {
    name: string;
    /** The fallback as written, `null` when there is none. */
    fallback: string | null;
    start: number;
    end: number;
}

/** The `var()` calls at the top level of `value`, each with its fallback (which may hold others). */
function varsIn(value: string): VarUse[] {
    const out: VarUse[] = [];
    const re = /var\(/g;
    for (let m = re.exec(value); m !== null; m = re.exec(value)) {
        const open = m.index + 3;
        const end = closing(value, open);
        const inner = value.slice(open + 1, end);
        const comma = inner.indexOf(',');
        out.push({ name: (comma < 0 ? inner : inner.slice(0, comma)).trim(), fallback: comma < 0 ? null : inner.slice(comma + 1).trim(), start: m.index, end: end + 1 });
        re.lastIndex = end + 1;
    }
    return out;
}

/** The colour a fallback ends in: itself, or — for a chain `var(--x, var(--y, z))` — the last one's. */
function terminal(fallback: string): string {
    const nested = varsIn(fallback);
    if (nested.length === 1 && nested[0].start === 0 && nested[0].end === fallback.length) {
        return nested[0].fallback === null ? '' : terminal(nested[0].fallback);
    }
    return fallback;
}

/** What is wrong with a colour value: a literal colour or a word outside a fallback, a fallback that is no colour, an unset variable's fallback that is not transparent. */
function problems(value: string): string[] {
    const found: string[] = [];
    const check = (v: string): void => {
        const uses = varsIn(v);
        let rest = '';
        let at = 0;
        for (const use of uses) {
            rest += `${v.slice(at, use.start)} `;
            at = use.end;
            if (use.fallback === null) {
                continue;
            }
            if (UNSET_IN_SOME_THEME.includes(use.name) && terminal(use.fallback).toLowerCase() !== 'transparent') {
                found.push(`${use.name} falls back to ${terminal(use.fallback)}, not transparent`);
            }
            if (varsIn(use.fallback).length > 0) {
                check(use.fallback);
            } else if (!FALLBACK.test(use.fallback)) {
                found.push(`fallback ${use.fallback} is no colour`);
            }
        }
        rest += v.slice(at);
        for (const m of rest.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
            found.push(`literal ${m[0]}`);
        }
        // Words: a function's name is followed by `(`; a unit is part of a number.
        for (const m of rest.matchAll(/(?<![-\w.#])([a-z][-a-z]*)(\(?)/gi)) {
            const word = m[1].toLowerCase();
            if (m[2] === '(') {
                if (/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/.test(word)) {
                    found.push(`literal ${word}()`);
                }
                continue;
            }
            if (!KEYWORDS.has(word)) {
                found.push(`word ${m[1]}`);
            }
        }
    };
    check(value);
    return found;
}

/**
 * The editor's chrome reads every colour from the workbench (Daniel,
 * 2026-09-30): the row, the menus, the bars, the bubble, the cards. A colour
 * written into `editor.css` as a value would be the same in every theme — a
 * light grey on High Contrast black — so none is, except as the fallback after
 * a `--vscode-*` variable, for a page that has none; and a variable some theme
 * leaves unset falls back to no colour at all. The samples are not styled here
 * (their look is the document's cascade), so there is no sample exception.
 */
suite('Editor stylesheet colours', () => {
    const css = readText(path.join(repoRoot, 'styles', 'editor.css'));

    test('no colour in editor.css but a workbench variable, a fallback after it, and transparent for a variable some theme leaves unset', () => {
        const all = declarations(css).filter(([p]) => COLOUR_PROPERTY.test(p) && !ALPHA_ONLY.has(p));
        assert.ok(all.length > 150, `the whole stylesheet is read: ${all.length} colour declarations`);
        const offenders = all.flatMap(([property, value, line]) => problems(value).map(p => `line ${line}: ${property}: ${value} — ${p}`));
        assert.deepStrictEqual(offenders, []);
    });

    test('the check sees what it is for', () => {
        assert.deepStrictEqual(declarations('.a { color: #fff; } .b:hover { top: 0 }').map(([p, v]) => [p, v]), [['color', '#fff'], ['top', '0']]);
        assert.deepStrictEqual(problems('#fff'), ['literal #fff']);
        assert.deepStrictEqual(problems('red'), ['word red']);
        assert.deepStrictEqual(problems('rebeccapurple'), ['word rebeccapurple'], 'any name, not a list of them');
        assert.deepStrictEqual(problems('0 2px 8px rgba(0, 0, 0, 0.3)'), ['literal rgba()']);
        assert.deepStrictEqual(problems('1px solid var(--vscode-x, #fff)'), []);
        assert.deepStrictEqual(problems('var(--vscode-x, var(--vscode-y, Canvas))'), []);
        assert.deepStrictEqual(problems('var(--vscode-x, sans-serif)'), ['fallback sans-serif is no colour']);
        assert.deepStrictEqual(problems('color-mix(in srgb, var(--vscode-foreground, #888) 20%, transparent)'), []);
        assert.deepStrictEqual(problems('color-mix(in srgb, #888 20%, transparent)'), ['literal #888']);
        assert.deepStrictEqual(problems('var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2))'),
            ['--vscode-toolbar-hoverBackground falls back to rgba(128, 128, 128, 0.2), not transparent']);
        assert.deepStrictEqual(problems('var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground, transparent))'), []);
        assert.deepStrictEqual(problems('var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground, Highlight))'),
            ['--vscode-menu-selectionBackground falls back to Highlight, not transparent']);
    });

    test('an emoji atom is drawn as the text around it, no chip, with the arrow, and selected the focus outline set off from it', () => {
        const rule = (selector: string) => {
            const at = css.indexOf(`${selector} {`);
            assert.ok(at >= 0, `editor.css has ${selector}`);
            return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)).trim().split(/\s*;\s*/).filter(d => d !== '');
        };
        assert.deepStrictEqual(rule('.mep-emoji'), ['font: inherit', 'color: inherit', 'cursor: default']);
        assert.deepStrictEqual(rule('.mep-emoji.ProseMirror-selectednode'), [...rule('.mep-wiki-embed.ProseMirror-selectednode'), 'outline-offset: 1px', 'border-radius: 2px']);
        // An atom is no text to place a caret in: the arrow, as over the embed.
        assert.ok(rule('.mep-wiki-embed').includes('cursor: default'));
        // Its spelling in the bar's label: the code font, no chip.
        assert.deepStrictEqual(rule('.mep-object-label-code'), ['font-family: var(--vscode-editor-font-family, monospace)']);
    });

    test('the row, the menus and the bars read the workbench\'s chrome variables', () => {
        for (const variable of [
            '--vscode-editorGroupHeader-tabsBackground', '--vscode-editorGroupHeader-tabsBorder', '--vscode-toolbar-hoverBackground', '--vscode-toolbar-activeBackground',
            '--vscode-toolbar-hoverOutline', '--vscode-menu-background', '--vscode-menu-foreground', '--vscode-menu-border', '--vscode-menu-selectionBackground',
            '--vscode-menu-selectionForeground', '--vscode-menu-selectionBorder', '--vscode-menu-separatorBackground', '--vscode-widget-shadow',
            '--vscode-editorWidget-background', '--vscode-editorWidget-border', '--vscode-focusBorder',
        ]) {
            assert.ok(css.includes(`var(${variable}`), `editor.css reads ${variable}`);
        }
    });
});
