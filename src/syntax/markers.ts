/**
 * The delimiters of this extension's Markdown syntax, stated once.
 *
 * Three places write or read them: the text editor's toggle commands
 * (`src/commands/toggleFormats.ts`), the markdown-it plugins that parse them
 * (`src/plugin/`), and the WYSIWYG editor's toolbar
 * (`src/editor/webview/toolbar/actions.ts`). Each of them imports this module,
 * so a toggle, the parser and a toolbar button cannot disagree about what a
 * construct is written as.
 *
 * It imports nothing — neither `vscode` nor markdown-it — because the
 * toolbar runs in the editor's webview, where neither exists.
 */

/**
 * The inline toggles' markers, keyed as `toggleFormats.ts` names its commands.
 * `strong` (`__`) has no toggle command; it is here because the toolbar offers
 * it, and `markdown-it-ib` renders it differently from `bold` (`**`).
 */
export const INLINE_MARKERS = {
    bold: '**',
    italics: '*',
    underline: '_',
    strong: '__',
    mark: '==',
    superscript: '^',
    subscript: '~',
    strikethrough: '~~',
    codeInline: '`',
} as const;

export type InlineMarkerName = keyof typeof INLINE_MARKERS;

/**
 * `markdown-it-kbd`'s delimiters, `[[Ctrl+S]]`. The package states them, not
 * this extension; they are written down here so the toolbar and the WYSIWYG
 * editor's serializer take them from one place.
 */
export const KBD_MARKERS = { open: '[[', close: ']]' } as const;

/** Between a note's reference text and its content: `++reference|note++`. */
export const NOTE_SEPARATOR = '|';

/**
 * Sidenotes, marginal notes and sidebars (`markdownItSidenote.ts`): the marker
 * that opens and closes each, and the classes the rendered spans carry.
 */
export const NOTE_SYNTAX = {
    sidenote: { marker: '++', refClass: 'sn-ref', noteClass: 'sidenote' },
    marginalNote: { marker: '!!', refClass: 'mn-ref', noteClass: 'mnote' },
    leftSidebar: { marker: '$', cssClass: 'left-sidebar' },
    rightSidebar: { marker: '@', cssClass: 'right-sidebar' },
} as const;

/** What opens an admonition block (`markdownItAdmonition.ts`): at least this many `!`. */
export const ADMONITION_MARKER = '!!!';

/**
 * Every admonition type the plugin recognises, in its order; a name outside
 * the list is read as a title of a `note`. Aliases share a look in
 * `styles/markdown-it-admonition.css` (`summary`, `abstract`, `tldr`, …).
 */
export const ADMONITION_TYPES: readonly string[] = [
    'note',
    'summary', 'abstract', 'tldr',
    'info', 'todo',
    'tip', 'hint',
    'success', 'check', 'done',
    'question', 'help', 'faq',
    'warning', 'attention', 'caution',
    'failure', 'fail', 'missing',
    'danger', 'error', 'bug',
    'example', 'snippet',
    'quote', 'cite',
];
