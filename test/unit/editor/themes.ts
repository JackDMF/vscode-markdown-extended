import * as puppeteer from 'puppeteer';

/**
 * What VS Code gives every webview for its theme: the theme's colours as
 * `--vscode-*` variables and a class on the body, the body painted with them.
 * The values are VS Code 1.139's — the theme file's own colours
 * (`extensions/theme-defaults/themes/*.json`), and for a colour the theme does
 * not set, the default the workbench's colour registry gives it. A colour the
 * registry leaves unset for a theme (`null`, as most of High Contrast's
 * backgrounds are) is no variable in the page either, so a stylesheet's
 * fallback is what shows — as in the real webview.
 *
 * Only the variables the editor's page reads are listed; `editorCss.test.ts`
 * holds the stylesheet to reading workbench variables, and these are what make
 * the page tests and their screenshots render as VS Code would.
 */
export interface Theme {
    name: string;
    /** The body's class, as VS Code sets it: `vscode-light`, `vscode-dark`, `vscode-high-contrast`. */
    bodyClass: string;
    variables: Record<string, string>;
}

const FONTS: Record<string, string> = {
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif',
    'font-size': '13px',
    'editor-font-family': 'Consolas, "Courier New", monospace',
    'editor-font-size': '14px',
};

export const LIGHT_MODERN: Theme = {
    name: 'Light Modern',
    bodyClass: 'vscode-light',
    variables: {
        ...FONTS,
        'foreground': '#3b3b3b',
        'descriptionForeground': '#3b3b3b',
        'disabledForeground': 'rgba(97, 97, 97, 0.5)',
        'focusBorder': '#005fb8',
        'editor-background': '#ffffff',
        'editor-foreground': '#3b3b3b',
        'textLink-foreground': '#005fb8',
        'textLink-activeForeground': '#005fb8',
        'widget-border': '#e5e5e5',
        'widget-shadow': 'rgba(0, 0, 0, 0.16)',
        'editorWidget-background': '#f8f8f8',
        'editorWidget-foreground': '#3b3b3b',
        'editorWidget-border': '#c8c8c8',
        'editorGroupHeader-tabsBackground': '#e5e5e5',
        'editorGroupHeader-tabsBorder': '#e5e5e5',
        'editorGroup-border': '#e5e5e5',
        'toolbar-hoverBackground': 'rgba(184, 184, 184, 0.31)',
        'toolbar-activeBackground': 'rgba(166, 166, 166, 0.31)',
        'menu-background': '#ffffff',
        'menu-foreground': '#3b3b3b',
        'menu-border': '#cecece',
        'menu-selectionBackground': '#005fb8',
        'menu-selectionForeground': '#ffffff',
        'menu-separatorBackground': '#d4d4d4',
        'input-background': '#ffffff',
        'input-foreground': '#3b3b3b',
        'input-border': '#cecece',
        'input-placeholderForeground': '#767676',
        'inputOption-activeBackground': '#bed6ed',
        'inputOption-activeBorder': '#005fb8',
        'inputOption-activeForeground': '#000000',
        'button-border': 'rgba(0, 0, 0, 0.1)',
        'button-secondaryBackground': '#e5e5e5',
        'button-secondaryForeground': '#3b3b3b',
        'button-secondaryHoverBackground': '#cccccc',
        'editor-selectionBackground': '#add6ff',
        'editor-inactiveSelectionBackground': '#e5ebf1',
        'editorCodeLens-foreground': '#919191',
        'editorHoverWidget-background': '#f8f8f8',
        'editorHoverWidget-foreground': '#3b3b3b',
        'editorHoverWidget-border': '#c8c8c8',
        'editorSuggestWidget-background': '#f8f8f8',
        'editorSuggestWidget-foreground': '#3b3b3b',
        'editorSuggestWidget-border': '#c8c8c8',
        'editorSuggestWidget-selectedBackground': '#e8e8e8',
        'editorSuggestWidget-selectedForeground': '#000000',
        'list-hoverBackground': '#f2f2f2',
        'list-activeSelectionBackground': '#e8e8e8',
        'list-activeSelectionForeground': '#000000',
        'editorError-foreground': '#e51400',
        'editorWarning-foreground': '#bf8803',
        'editorInfo-foreground': '#1a85ff',
        'editorIndentGuide-background1': '#d3d3d3',
    },
};

export const DARK_MODERN: Theme = {
    name: 'Dark Modern',
    bodyClass: 'vscode-dark',
    variables: {
        ...FONTS,
        'foreground': '#cccccc',
        'descriptionForeground': '#9d9d9d',
        'disabledForeground': 'rgba(204, 204, 204, 0.5)',
        'focusBorder': '#0078d4',
        'editor-background': '#1f1f1f',
        'editor-foreground': '#cccccc',
        'textLink-foreground': '#4daafc',
        'textLink-activeForeground': '#4daafc',
        'widget-border': '#313131',
        'widget-shadow': 'rgba(0, 0, 0, 0.36)',
        'editorWidget-background': '#202020',
        'editorWidget-foreground': '#cccccc',
        'editorWidget-border': '#454545',
        'editorGroupHeader-tabsBackground': '#2b2b2b',
        'editorGroupHeader-tabsBorder': '#2b2b2b',
        'editorGroup-border': 'rgba(255, 255, 255, 0.09)',
        'toolbar-hoverBackground': 'rgba(90, 93, 94, 0.31)',
        'toolbar-activeBackground': 'rgba(99, 102, 103, 0.31)',
        'menu-background': '#1f1f1f',
        'menu-foreground': '#cccccc',
        'menu-selectionBackground': '#0078d4',
        'menu-selectionForeground': '#ffffff',
        'menu-separatorBackground': '#606060',
        'input-background': '#313131',
        'input-foreground': '#cccccc',
        'input-border': '#3c3c3c',
        'input-placeholderForeground': '#989898',
        'inputOption-activeBackground': 'rgba(36, 137, 219, 0.51)',
        'inputOption-activeBorder': '#2488db',
        'inputOption-activeForeground': '#ffffff',
        'button-border': 'rgba(255, 255, 255, 0.1)',
        'button-secondaryBackground': 'rgba(0, 0, 0, 0)',
        'button-secondaryForeground': '#cccccc',
        'button-secondaryHoverBackground': '#2b2b2b',
        'editor-selectionBackground': '#264f78',
        'editor-inactiveSelectionBackground': '#3a3d41',
        'editorCodeLens-foreground': '#999999',
        'editorHoverWidget-background': '#202020',
        'editorHoverWidget-foreground': '#cccccc',
        'editorHoverWidget-border': '#454545',
        'editorSuggestWidget-background': '#202020',
        'editorSuggestWidget-foreground': '#cccccc',
        'editorSuggestWidget-border': '#454545',
        'editorSuggestWidget-selectedBackground': '#04395e',
        'editorSuggestWidget-selectedForeground': '#ffffff',
        'list-hoverBackground': '#2a2d2e',
        'list-activeSelectionBackground': '#04395e',
        'list-activeSelectionForeground': '#ffffff',
        'editorError-foreground': '#f85149',
        'editorWarning-foreground': '#cca700',
        'editorInfo-foreground': '#3794ff',
        'editorIndentGuide-background1': '#404040',
    },
};

/** Dark High Contrast: borders where the other themes have surfaces; most backgrounds are unset. */
export const HC_DARK: Theme = {
    name: 'Dark High Contrast',
    bodyClass: 'vscode-high-contrast',
    variables: {
        ...FONTS,
        'contrastBorder': '#6fc3df',
        'contrastActiveBorder': '#f38518',
        'foreground': '#ffffff',
        'descriptionForeground': 'rgba(255, 255, 255, 0.7)',
        'disabledForeground': '#a5a5a5',
        'focusBorder': '#f38518',
        'editor-background': '#000000',
        'editor-foreground': '#ffffff',
        'textLink-foreground': '#21a6ff',
        'textLink-activeForeground': '#21a6ff',
        'widget-border': '#6fc3df',
        'editorWidget-background': '#0c141f',
        'editorWidget-foreground': '#ffffff',
        'editorWidget-border': '#6fc3df',
        'editorGroupHeader-border': '#6fc3df',
        'editorGroup-border': '#6fc3df',
        'toolbar-hoverOutline': '#f38518',
        'menu-background': '#000000',
        'menu-foreground': '#ffffff',
        'menu-border': '#6fc3df',
        'menu-selectionBorder': '#f38518',
        'menu-separatorBackground': '#6fc3df',
        'input-background': '#000000',
        'input-foreground': '#ffffff',
        'input-border': '#6fc3df',
        'input-placeholderForeground': 'rgba(255, 255, 255, 0.7)',
        'inputOption-activeBorder': '#6fc3df',
        'button-border': '#6fc3df',
        'button-secondaryForeground': '#ffffff',
        'editor-selectionBackground': '#ffffff',
        'editorCodeLens-foreground': '#999999',
        'editorHoverWidget-background': '#0c141f',
        'editorHoverWidget-foreground': '#ffffff',
        'editorHoverWidget-border': '#6fc3df',
        'editorSuggestWidget-background': '#0c141f',
        'editorSuggestWidget-foreground': '#ffffff',
        'editorSuggestWidget-border': '#6fc3df',
        'editorError-foreground': '#f48771',
        'editorWarning-foreground': '#ffd370',
        'editorInfo-foreground': '#3794ff',
        'editorIndentGuide-background1': '#ffffff',
    },
};

/** The theme as a stylesheet: its variables on `:root`, and the body painted with them, as a webview's is. */
export function themeCss(theme: Theme): string {
    const vars = Object.entries(theme.variables).map(([name, value]) => `    --vscode-${name}: ${value};`).join('\n');
    return `:root {\n${vars}\n}\nbody {\n    background-color: var(--vscode-editor-background);\n    color: var(--vscode-editor-foreground);\n    font-family: var(--vscode-font-family);\n    font-size: var(--vscode-font-size);\n}`;
}

/** Put `theme` on the page, replacing the one it had: the variables and the body's theme class. */
export async function applyTheme(page: puppeteer.Page, theme: Theme): Promise<void> {
    await page.evaluate((css, bodyClass) => {
        let style = document.getElementById('mep-test-theme');
        if (!style) {
            style = document.createElement('style');
            style.id = 'mep-test-theme';
            document.head.append(style);
        }
        style.textContent = css;
        document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
        document.body.classList.add(bodyClass);
    }, themeCss(theme), theme.bodyClass);
}
