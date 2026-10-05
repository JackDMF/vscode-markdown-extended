/**
 * The delimiters of this extension's Markdown syntax, stated once.
 *
 * Three places write or read them: the text editor's toggle commands
 * (`src/commands/toggleFormats.ts`), the markdown-it plugins that parse them
 * (`src/plugin/`), and the Visual Editor's toolbar
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
 * this extension; they are written down here so the toolbar and the Visual
 * Editor's serializer take them from one place.
 */
export const KBD_MARKERS = { open: '[[', close: ']]' } as const;

/**
 * A wiki embed, Foam's, Obsidian's and Markdown Notes' `![[note]]` or
 * `![[path/to/image.png]]` (qjebbs/vscode-markdown-extended#168): `open`, a
 * name with no bracket and no line break, `close` — the shape Foam's own
 * embed rule matches. `src/plugin/markdownItWikiEmbed.ts` reads it as one run
 * of literal text, so no key, image or other inline rule starts inside it. A
 * plain `[[note]]` stays a key: it is this extension's syntax as much as a
 * wiki link, and nothing in it tells the two apart.
 */
export const WIKI_EMBED_MARKERS = { open: '![[', close: ']]' } as const;

/**
 * The engine option that keeps a wiki embed a token of its own to the end of
 * the parse. Without it the embed plugin makes it plain text, joined with the
 * text around it, so an extension that renders embeds from text (Foam) finds
 * it; the Visual Editor's engine sets it (`src/editor/engine.ts`) and edits each
 * embed as one atom carrying its source.
 */
export const WIKI_EMBED_TOKENS_OPTION = 'mepWikiEmbedTokens';

/**
 * The spellings the Visual Editor writes a character of an embed's name in
 * where the place would read the bare character as its own syntax (a table
 * cell's `|` and backtick, a note's terminator and marker), each read back by
 * the embed plugin as the character itself.
 */
const WIKI_EMBED_ENCODINGS: Readonly<Record<string, string>> = {
    '&#124;': '|', '&#36;': '$', '&#64;': '@', '&#43;': '+', '&#33;': '!', '&#96;': '`', '\\|': '|',
};
const WIKI_EMBED_ENCODED = /\\.|&#(?:124|36|64|43|33|96);/g;

/**
 * An embed's source with exactly those spellings read back, other escapes
 * kept: the form written where nothing needs encoding, and the one the
 * editor shows. `![[a&#124;b]]` and `![[a\|b]]` are `![[a|b]]`; `![[a\\|b]]`
 * keeps its escaped backslash.
 */
export function plainWikiEmbed(source: string): string {
    return source.replace(WIKI_EMBED_ENCODED, found => WIKI_EMBED_ENCODINGS[found] ?? found);
}

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

const ASCII_LETTER_OR_DIGIT = /^[A-Za-z0-9]$/;
const ASCII_DIGIT = /^[0-9]$/;

/**
 * Whether a sidebar marker (`$` or `@`) with `before` and `after` around it
 * opens a sidebar (`''` is the edge of the text): something follows it, and
 * no ASCII letter or digit stands right before it, so `a@b.c`, `user@host`
 * and `US$5` open nothing. Only ASCII counts: a sidebar right after CJK or
 * other non-ASCII text opens as it always did (`这是$侧边栏内容$的例子`), one
 * glued to an ASCII word (`Text$x$`) is text. The side inside may be a
 * space: `$ left $` is a sidebar.
 *
 * `before` and `after` are the characters the source reads as there: a
 * character reference counts as what it decodes to, so `REQ-&#49;$x$` is text
 * as `REQ-1$x$` is, and `$x$&#53;` closes nothing (`sidebarCanClose`).
 *
 * The notes plugin parses by this and `sidebarCanClose`
 * (`markdownItSidenote.ts`, which decodes a reference beside a marker); the
 * Visual Editor refuses an edit after which either would not hold, and never
 * writes a reference beside a marker (`serialize.ts`); the grammar follows
 * them as far as a regex can.
 */
export function sidebarCanOpen(before: string, after: string): boolean {
    return after !== '' && !ASCII_LETTER_OR_DIGIT.test(before);
}

/**
 * Whether a sidebar marker of `marker`, with `after` right after it, closes
 * the sidebar being read: a `$` followed by an ASCII digit closes nothing, so
 * `$5 and $10` is text. An `@` closes wherever it stands.
 */
export function sidebarCanClose(marker: string, after: string): boolean {
    return !(marker === '$' && ASCII_DIGIT.test(after));
}

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
