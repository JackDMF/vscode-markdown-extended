/**
 * The rich editor's formatting toolbar, as data: one entry per thing a button
 * or a menu item does. Pure — no DOM, no ProseMirror state — so the table can
 * be checked against the parser without a page (`toolbarActions.test.ts`).
 *
 * Each action carries:
 *
 * - a **sample**, the element the parser makes from the action's syntax (`<i>`
 *   for `*text*`, `<span class="sn-ref">` for a sidenote, a whole admonition
 *   box). The toolbar draws the button *as* that element, inside the page's own
 *   `body.markdown-body`, so it takes its look from the stylesheets the page
 *   already loads — the preview's, every extension's, the user's — and changes
 *   with them. No icon, and no colour read from a stylesheet's text: the look is
 *   a fact of the cascade, so it is read from the cascade.
 * - the **syntax** the tooltip names, from where it is true: the inline markers
 *   and the admonition types from `src/syntax/markers.ts`, which the text
 *   editor's toggles and the markdown-it plugins import too.
 * - how it is **applied**: `mark` and `block` edit the document natively;
 *   `wrap-source` and `insert-source` write a construct the editor cannot yet
 *   edit as rich text, as source (stage 1, see `commands.ts`).
 * - an **example**: Markdown in which the construct renders as its sample. The
 *   test renders it through the real engine and requires the sample's elements
 *   in the HTML, so "this button makes this element" is checked, not assumed.
 */
import { ADMONITION_MARKER, ADMONITION_TYPES, INLINE_MARKERS, NOTE_SEPARATOR, NOTE_SYNTAX } from '../../../syntax/markers';

export type ToolbarGroup = 'block' | 'inline' | 'annotation' | 'insert';

/** A dropdown an action is an entry of. An action without one is a button of its own. */
export type ToolbarMenu = 'block-type' | 'admonition';

/** An element to draw: a tag, its classes, its text and its children, as the parser renders the construct. */
export interface SampleSpec {
    tag: string;
    className?: string;
    text?: string;
    attrs?: Readonly<Record<string, string>>;
    children?: readonly SampleSpec[];
}

/** The node a `block` action makes the current block into (or, for a rule, inserts). */
export type BlockTarget = 'paragraph' | 'heading' | 'blockquote' | 'bullet_list' | 'ordered_list' | 'code_block' | 'horizontal_rule';

/** The placeholder a footnote template carries for the first label the document does not use yet. */
export const FOOTNOTE_LABEL = '{n}';

export type ActionApply =
    /** A native mark; `markup` is the delimiter it is written with (`null` for a mark without one). */
    | { kind: 'mark'; mark: 'em' | 'strong' | 'code'; markup: string | null }
    | { kind: 'block'; node: BlockTarget; level?: number }
    /**
     * Stage 1: the selection's text wrapped in `open` … `close` as literal
     * source (`placeholder` when nothing is selected); the block comes back from
     * the host as a source block. `definition`, when set, is a source block of
     * its own inserted after it (a footnote's text).
     */
    | { kind: 'wrap-source'; open: string; close: string; placeholder: string; definition?: string }
    /** Stage 1: a new source block holding `template`, inserted after the current block, its source opened. */
    | { kind: 'insert-source'; template: string };

export interface ToolbarAction {
    id: string;
    group: ToolbarGroup;
    menu?: ToolbarMenu;
    label: string;
    /** The Markdown the action writes, as the tooltip names it. */
    syntax: string;
    sample: SampleSpec;
    /** Block samples are drawn scaled down (`zoom`) — a heading at full size would not fit; inline ones at their natural size. */
    zoom?: number;
    apply: ActionApply;
    /** Markdown in which the construct renders as `sample`, with any footnote label as `1`. */
    example: string;
}

/** What a source action's tooltip says about stage 1. */
export const SOURCE_FOOTNOTE = '¹ edits as source until stage 2';

/** Whether the action writes source the editor shows as a source block, not as rich text. */
export function isSourceAction(action: ToolbarAction): boolean {
    return action.apply.kind === 'wrap-source' || action.apply.kind === 'insert-source';
}

/** The action's tooltip: its name, the syntax it writes, and the stage-1 footnote where it applies. */
export function tooltipOf(action: ToolbarAction): string {
    const source = isSourceAction(action);
    const renders = action.apply.kind === 'mark' ? ` — rendered as <${action.sample.tag}>` : '';
    const syntax = action.syntax.includes('\n') ? `\n${action.syntax}` : ` ${action.syntax}`;
    return `${action.label}${source ? '¹' : ''}:${syntax}${renders}${source ? `\n${SOURCE_FOOTNOTE}` : ''}`;
}

function el(tag: string, text?: string, className?: string, children?: SampleSpec[], attrs?: Record<string, string>): SampleSpec {
    return { tag, ...(className ? { className } : {}), ...(text !== undefined ? { text } : {}), ...(children ? { children } : {}), ...(attrs ? { attrs } : {}) };
}

function withLabel(text: string, label = '1'): string {
    return text.split(FOOTNOTE_LABEL).join(label);
}

// ---------------------------------------------------------------------------
// Block type — one dropdown, whose face is the current block's sample
// ---------------------------------------------------------------------------

const HEADING_ZOOM = [0.42, 0.5, 0.58, 0.66, 0.72, 0.78];

const blockTypes: ToolbarAction[] = [
    {
        id: 'paragraph', group: 'block', menu: 'block-type', label: 'Paragraph', syntax: 'text, with a blank line around it',
        sample: el('p', 'Paragraph'), zoom: 0.8,
        apply: { kind: 'block', node: 'paragraph' }, example: 'Paragraph',
    },
    ...HEADING_ZOOM.map((zoom, i): ToolbarAction => {
        const level = i + 1;
        const marker = '#'.repeat(level);
        return {
            id: `heading-${level}`, group: 'block', menu: 'block-type', label: `Heading ${level}`, syntax: `${marker} text`,
            sample: el(`h${level}`, `Heading ${level}`), zoom,
            apply: { kind: 'block', node: 'heading', level }, example: `${marker} Heading ${level}`,
        };
    }),
    {
        id: 'blockquote', group: 'block', menu: 'block-type', label: 'Quote', syntax: '> text',
        sample: el('blockquote', undefined, undefined, [el('p', 'Quote')]), zoom: 0.7,
        apply: { kind: 'block', node: 'blockquote' }, example: '> Quote',
    },
    {
        id: 'bullet-list', group: 'block', menu: 'block-type', label: 'Bullet list', syntax: '- text',
        sample: el('ul', undefined, undefined, [el('li', 'Item')]), zoom: 0.7,
        apply: { kind: 'block', node: 'bullet_list' }, example: '- Item',
    },
    {
        id: 'ordered-list', group: 'block', menu: 'block-type', label: 'Numbered list', syntax: '1. text',
        sample: el('ol', undefined, undefined, [el('li', 'Item')]), zoom: 0.7,
        apply: { kind: 'block', node: 'ordered_list' }, example: '1. Item',
    },
    {
        id: 'code-block', group: 'block', menu: 'block-type', label: 'Code block', syntax: '```\ncode\n```',
        sample: el('pre', undefined, undefined, [el('code', 'code')]), zoom: 0.7,
        apply: { kind: 'block', node: 'code_block' }, example: '```\ncode\n```',
    },
];

// ---------------------------------------------------------------------------
// Inline — native marks first, then the extension's inline syntax as source
// ---------------------------------------------------------------------------

function markAction(id: string, label: string, mark: 'em' | 'strong' | 'code', marker: string, markup: string | null, sample: SampleSpec): ToolbarAction {
    return {
        id, group: 'inline', label, syntax: `${marker}text${marker}`, sample,
        apply: { kind: 'mark', mark, markup }, example: `${marker}${sample.text ?? 'text'}${marker}`,
    };
}

function wrapAction(id: string, group: ToolbarGroup, label: string, open: string, close: string, sample: SampleSpec, syntaxText = 'text'): ToolbarAction {
    const placeholder = sample.text ?? 'text';
    return {
        id, group, label, syntax: `${open}${syntaxText}${close}`, sample,
        apply: { kind: 'wrap-source', open, close, placeholder }, example: `${open}${placeholder}${close}`,
    };
}

const inline: ToolbarAction[] = [
    // `markdown-it-ib` renders the four emphasis delimiters as four elements, so
    // the toolbar offers all four and a stylesheet can tell them apart.
    markAction('italic', 'Italic', 'em', INLINE_MARKERS.italics, INLINE_MARKERS.italics, el('i', 'i')),
    markAction('emphasis', 'Emphasis', 'em', INLINE_MARKERS.underline, INLINE_MARKERS.underline, el('em', 'em')),
    markAction('bold', 'Bold', 'strong', INLINE_MARKERS.bold, INLINE_MARKERS.bold, el('b', 'b')),
    markAction('strong', 'Strong', 'strong', INLINE_MARKERS.strong, INLINE_MARKERS.strong, el('strong', 'strong')),
    markAction('code', 'Inline code', 'code', INLINE_MARKERS.codeInline, null, el('code', 'code')),
    wrapAction('mark', 'inline', 'Highlight', INLINE_MARKERS.mark, INLINE_MARKERS.mark, el('mark', 'mark')),
    wrapAction('superscript', 'inline', 'Superscript', INLINE_MARKERS.superscript, INLINE_MARKERS.superscript, el('sup', 'sup')),
    wrapAction('subscript', 'inline', 'Subscript', INLINE_MARKERS.subscript, INLINE_MARKERS.subscript, el('sub', 'sub')),
    wrapAction('strikethrough', 'inline', 'Strikethrough', INLINE_MARKERS.strikethrough, INLINE_MARKERS.strikethrough, el('s', 'strike')),
    // `markdown-it-kbd`'s own delimiters; the package states them, not this extension.
    wrapAction('kbd', 'inline', 'Key', '[[', ']]', el('kbd', 'Ctrl')),
];

// ---------------------------------------------------------------------------
// Annotations — sidenotes, marginal notes, sidebars, footnotes
// ---------------------------------------------------------------------------

const SN = NOTE_SYNTAX.sidenote;
const MN = NOTE_SYNTAX.marginalNote;
const LS = NOTE_SYNTAX.leftSidebar;
const RS = NOTE_SYNTAX.rightSidebar;

const FOOTNOTE_TEXT = 'Footnote text';

const annotations: ToolbarAction[] = [
    wrapAction('sidenote', 'annotation', 'Sidenote', SN.marker, `${NOTE_SEPARATOR}note${SN.marker}`,
        el('span', 'sidenote', SN.refClass), 'reference'),
    wrapAction('marginal-note', 'annotation', 'Marginal note', MN.marker, `${NOTE_SEPARATOR}note${MN.marker}`,
        el('span', 'marginal', MN.refClass), 'reference'),
    wrapAction('left-sidebar', 'annotation', 'Left sidebar', LS.marker, LS.marker, el('span', 'left', LS.cssClass)),
    wrapAction('right-sidebar', 'annotation', 'Right sidebar', RS.marker, RS.marker, el('span', 'right', RS.cssClass)),
    {
        // A footnote label cannot hold the selected prose (no spaces), and a
        // reference without a definition renders as its literal text; so the
        // reference goes after the selection with the first free number, and
        // its definition is a source block of its own below the paragraph.
        id: 'footnote-reference', group: 'annotation', label: 'Footnote', syntax: `text[^1] … [^1]: ${FOOTNOTE_TEXT}`,
        sample: el('sup', undefined, 'footnote-ref', [el('a', '[1]')]),
        apply: { kind: 'wrap-source', open: '', close: `[^${FOOTNOTE_LABEL}]`, placeholder: '', definition: `[^${FOOTNOTE_LABEL}]: ${FOOTNOTE_TEXT}` },
        example: withLabel(`text[^${FOOTNOTE_LABEL}]\n\n[^${FOOTNOTE_LABEL}]: ${FOOTNOTE_TEXT}`),
    },
];

// ---------------------------------------------------------------------------
// Insert — new blocks, as source except the rule
// ---------------------------------------------------------------------------

function insertAction(id: string, label: string, template: string, sample: SampleSpec, zoom: number, example = template): ToolbarAction {
    return { id, group: 'insert', label, syntax: template, sample, zoom, apply: { kind: 'insert-source', template }, example };
}

function titleOf(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
}

// Templates follow `snippets/markdown.code-snippets` where it has one, with
// its tab stops filled in.
const TABLE_TEMPLATE = [
    '| Column1  | Column2   | Column3   |',
    '|-------------- | -------------- | -------------- |',
    '| Item1    | Item1     | Item1     |',
].join('\n');

const CONTAINER_TEMPLATE = [
    '::::: container',
    ':::: row',
    '::: col-xs-6 alert alert-success',
    'success text',
    ':::',
    '::: col-xs-6 alert alert-warning',
    'warning text',
    ':::',
    '::::',
    ':::::',
].join('\n');

const insert: ToolbarAction[] = [
    {
        id: 'horizontal-rule', group: 'insert', label: 'Horizontal rule', syntax: '---',
        sample: el('hr'), zoom: 1,
        // Not first in the example: `---` opening a document is front matter.
        // The toolbar puts a rule after the current block, never first.
        apply: { kind: 'block', node: 'horizontal_rule' }, example: 'Text\n\n---',
    },
    ...ADMONITION_TYPES.map(type => insertAction(`admonition-${type}`, `Admonition: ${type}`,
        `${ADMONITION_MARKER} ${type} ${titleOf(type)}\n    Text`,
        el('div', undefined, `admonition ${type}`, [el('p', titleOf(type), 'admonition-title')]), 0.6))
        .map((action): ToolbarAction => ({ ...action, menu: 'admonition' })),
    insertAction('table', 'Table', TABLE_TEMPLATE,
        el('table', undefined, undefined, [
            el('tr', undefined, undefined, [el('th', 'A'), el('th', 'B')]),
            el('tr', undefined, undefined, [el('td', '1'), el('td', '2')]),
        ]), 0.6),
    insertAction('container', 'Container', CONTAINER_TEMPLATE, el('div', 'container', 'container'), 0.8),
    insertAction('task-list', 'Task list', '- [ ] Task',
        el('ul', undefined, undefined, [el('li', undefined, undefined, [el('input', undefined, undefined, undefined, { type: 'checkbox' }), el('label', 'Task')])]), 0.8),
    insertAction('footnote-definition', 'Footnote definition', `[^${FOOTNOTE_LABEL}]: ${FOOTNOTE_TEXT}`,
        el('section', undefined, 'footnotes', [el('ol', undefined, 'footnotes-list', [el('li', FOOTNOTE_TEXT, 'footnote-item')])]), 0.7,
        // A definition renders only once something refers to it.
        withLabel(`text[^${FOOTNOTE_LABEL}]\n\n[^${FOOTNOTE_LABEL}]: ${FOOTNOTE_TEXT}`)),
    insertAction('definition-list', 'Definition list', 'Term\n:   Definition',
        el('dl', undefined, undefined, [el('dt', 'Term'), el('dd', 'Definition')]), 0.8),
    insertAction('abbreviation', 'Abbreviation', '*[HTML]: HyperText Markup Language',
        el('abbr', 'HTML', undefined, undefined, { title: 'HyperText Markup Language' }), 1,
        // The definition renders nothing; the abbreviation shows where it is used.
        '*[HTML]: HyperText Markup Language\n\nHTML'),
    insertAction('table-of-contents', 'Table of contents', '[[TOC]]',
        el('div', undefined, 'table-of-contents', [el('ul', undefined, undefined, [el('li', 'Contents')])]), 0.8,
        // A table of contents lists the headings after it.
        '[[TOC]]\n\n# Contents'),
];

/** Every action, in the order the toolbar shows them. */
export const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [...blockTypes, ...inline, ...annotations, ...insert];

/** The groups the toolbar shows, in order; the bubble shows the two inline ones. */
export const TOOLBAR_GROUPS: readonly ToolbarGroup[] = ['block', 'inline', 'annotation', 'insert'];
export const BUBBLE_GROUPS: readonly ToolbarGroup[] = ['inline', 'annotation'];

/** The label for the whole menu, shown on its face's tooltip. */
export const MENU_LABELS: Readonly<Record<ToolbarMenu, string>> = {
    'block-type': 'Block type',
    admonition: 'Admonition',
};

/** The action whose sample stands for a menu as its face when nothing else does. */
export const MENU_FACES: Readonly<Record<ToolbarMenu, string>> = {
    'block-type': 'paragraph',
    admonition: `admonition-${ADMONITION_TYPES.includes('warning') ? 'warning' : ADMONITION_TYPES[0]}`,
};
