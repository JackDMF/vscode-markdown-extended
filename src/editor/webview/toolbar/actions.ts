/**
 * The rich editor's formatting toolbar, as data: one entry per thing a button
 * or a menu entry does. Pure — no DOM, no ProseMirror state — so the table can
 * be checked against the parser without a page (`toolbarActions.test.ts`).
 *
 * The toolbar is split by what each surface is for:
 *
 * - **The row** is a control: one line, every control the same height, menus as
 *   a text label and a chevron. Only the five native marks sit in it directly,
 *   their glyph the real element (`<i>`, `<em>`, `<b>`, `<strong>`, `<code>`)
 *   held to the button's size.
 * - **A menu entry** is where a choice is made, so it carries the fidelity: the
 *   element the parser makes from the syntax (`sample`), drawn by the page's own
 *   cascade and normalized to one entry height, with the syntax beside it.
 * - **The preview card**, on hover or focus, shows the construct at its natural
 *   size in a short example (`preview`), again from the cascade.
 *
 * Every surface is built from the one entry below, so a button, its menu entry
 * and its card cannot describe different things. Each action carries:
 *
 * - `place`: in the row, or in which menu (and submenu);
 * - `syntax`, from where it is true: the inline markers and the admonition
 *   types from `src/syntax/markers.ts`, which the text editor's toggles and the
 *   markdown-it plugins import too;
 * - `sample` and `example`: the element and Markdown in which the construct
 *   renders as that element;
 * - `preview`: a fuller example — Markdown and the elements it renders as;
 * - `apply`: `mark`, `wrap-node`, `block`, `attr-span` and `insert-wrapper`
 *   edit natively — the extension's inline syntax (highlight, keys, notes,
 *   sidebars, …) is rich text since stage 2, attribute spans, containers and
 *   admonitions since stage 3; `wrap-source` and `insert-source` write a
 *   construct the editor cannot edit as rich text (a footnote, a table, a
 *   definition list, …), as source;
 * - `bubble`: whether the selection bubble offers it too.
 *
 * The test renders every `example` and `preview.markdown` through the real
 * engine and requires the drawn elements in the HTML, so "this entry makes this
 * element" is checked, not assumed.
 */
import { ADMONITION_MARKER, ADMONITION_TYPES, INLINE_MARKERS, KBD_MARKERS, NOTE_SEPARATOR, NOTE_SYNTAX } from '../../../syntax/markers';
import type { NoteNodeName } from '../notes';

/** The menus of the row, left to right after the marks' group. */
export type ToolbarMenu = 'block-type' | 'formatting' | 'annotation' | 'insert';

/** A menu opened from an entry of another. */
export type ToolbarSubmenu = 'admonition';

export type ActionPlace =
    | { row: true }
    | { menu: ToolbarMenu; submenu?: ToolbarSubmenu };

/** An element to draw: a tag, its classes and attributes, and its content (text or elements, in order). */
export interface SampleSpec {
    tag: string;
    className?: string;
    attrs?: Readonly<Record<string, string>>;
    children?: readonly (SampleSpec | string)[];
}

/** The node a `block` action makes the current block into (or, for a rule, inserts). */
export type BlockTarget = 'paragraph' | 'heading' | 'blockquote' | 'bullet_list' | 'ordered_list' | 'code_block' | 'horizontal_rule';

/** The placeholder a footnote template carries for the first label the document does not use yet. */
export const FOOTNOTE_LABEL = '{n}';

/**
 * The class of the preview card. `styles/markdown-extended.css` names it too,
 * to keep its margin layout out of the card (a test holds the two together).
 */
export const PREVIEW_CARD_CLASS = 'mep-preview-card';

/** The schema's marks a toolbar action toggles. */
export type MarkTarget = 'em' | 'strong' | 'code' | 'mark' | 'sup' | 'sub' | 'strike' | 'kbd';

export type ActionApply =
    /** A mark; `markup` is the delimiter it is written with (`null` for a mark whose delimiter cannot vary). */
    | { kind: 'mark'; mark: MarkTarget; markup: string | null }
    /** A note or a sidebar made of the selection, edited in place; inside one of its kind, removed again, its text kept (`notes.ts`, `toggleNote`). */
    | { kind: 'wrap-node'; node: NoteNodeName }
    | { kind: 'block'; node: BlockTarget; level?: number }
    /**
     * An attribute span made of the selection (`[text]{…}`): the inline field
     * asks for the literal, prefilled `{.}` with the caret after the dot.
     */
    | { kind: 'attr-span' }
    /**
     * A new container or admonition after the current block, edited in place,
     * the caret in its body (an empty paragraph): `name` is the container's
     * first class, `type` and `title` the admonition's.
     */
    | { kind: 'insert-wrapper'; node: 'container'; name: string }
    | { kind: 'insert-wrapper'; node: 'admonition'; type: string; title: string }
    /**
     * The selection's text wrapped in `open` … `close` as literal source
     * (`placeholder` when nothing is selected); the block comes back from the
     * host as a source block. `definition`, when set, is a source block of its
     * own inserted after it (a footnote's text) — the one inline construct the
     * editor still writes this way, since a footnote is two blocks.
     */
    | { kind: 'wrap-source'; open: string; close: string; placeholder: string; definition?: string }
    /** A new source block holding `template`, inserted after the current block, its source opened. */
    | { kind: 'insert-source'; template: string };

/** A fuller example for the preview card: Markdown, and the top-level elements it renders as. */
export interface ActionPreview {
    markdown: string;
    nodes: readonly SampleSpec[];
}

export interface ToolbarAction {
    id: string;
    place: ActionPlace;
    label: string;
    /** The Markdown the action writes, as the tooltip and the menu entry name it. */
    syntax: string;
    sample: SampleSpec;
    apply: ActionApply;
    /** Markdown in which the construct renders as `sample`, with any footnote label as `1`. */
    example: string;
    /** What the preview card shows; every menu entry has one. */
    preview?: ActionPreview;
    /** Offered in the selection bubble too. */
    bubble?: true;
}

/** What a source action's tooltip says: the construct is edited as Markdown in a source block, not as rich text. */
export const SOURCE_FOOTNOTE = '¹ edited as source, in a source block';

/** Whether the action writes source the editor shows as a source block, not as rich text. */
export function isSourceAction(action: ToolbarAction): boolean {
    return action.apply.kind === 'wrap-source' || action.apply.kind === 'insert-source';
}

export function inRow(action: ToolbarAction): boolean {
    return 'row' in action.place;
}

/** The bubble: the row's marks, then the entries marked for it, in the table's order. */
export function inBubble(action: ToolbarAction): boolean {
    return inRow(action) || action.bubble === true;
}

export function menuOf(action: ToolbarAction): ToolbarMenu | null {
    return 'menu' in action.place ? action.place.menu : null;
}

export function submenuOf(action: ToolbarAction): ToolbarSubmenu | null {
    return 'menu' in action.place ? action.place.submenu ?? null : null;
}

/** The action's tooltip: its name, the syntax it writes, and the source footnote where it applies. */
export function tooltipOf(action: ToolbarAction): string {
    const source = isSourceAction(action);
    const renders = action.apply.kind === 'mark' ? ` — rendered as <${action.sample.tag}>` : '';
    const syntax = action.syntax.includes('\n') ? `\n${action.syntax}` : ` ${action.syntax}`;
    return `${action.label}${source ? '¹' : ''}:${syntax}${renders}${source ? `\n${SOURCE_FOOTNOTE}` : ''}`;
}

/** An element: `el('p', 'text', el('b', 'bold'), 'more')`; a class goes in the tag as `tag.class1.class2`. */
function el(tagAndClass: string, ...children: (SampleSpec | string)[]): SampleSpec {
    const [tag, ...classes] = tagAndClass.split('.');
    return { tag, ...(classes.length ? { className: classes.join(' ') } : {}), ...(children.length ? { children } : {}) };
}

function withAttrs(spec: SampleSpec, attrs: Record<string, string>): SampleSpec {
    return { ...spec, attrs };
}

function withLabel(text: string, label = '1'): string {
    return text.split(FOOTNOTE_LABEL).join(label);
}

// ---------------------------------------------------------------------------
// The row: the five native marks
// ---------------------------------------------------------------------------

function markAction(id: string, label: string, mark: 'em' | 'strong' | 'code', marker: string, markup: string | null, tag: string, glyph: string): ToolbarAction {
    return {
        id, place: { row: true }, label, syntax: `${marker}text${marker}`, sample: el(tag, glyph),
        apply: { kind: 'mark', mark, markup }, example: `${marker}${glyph}${marker}`,
    };
}

const marks: ToolbarAction[] = [
    // `markdown-it-ib` renders the four emphasis delimiters as four elements, so
    // the row offers all four and a stylesheet can tell them apart.
    markAction('italic', 'Italic', 'em', INLINE_MARKERS.italics, INLINE_MARKERS.italics, 'i', 'i'),
    markAction('emphasis', 'Emphasis', 'em', INLINE_MARKERS.underline, INLINE_MARKERS.underline, 'em', 'em'),
    markAction('bold', 'Bold', 'strong', INLINE_MARKERS.bold, INLINE_MARKERS.bold, 'b', 'b'),
    markAction('strong', 'Strong', 'strong', INLINE_MARKERS.strong, INLINE_MARKERS.strong, 'strong', 'strong'),
    markAction('code', 'Inline code', 'code', INLINE_MARKERS.codeInline, null, 'code', 'code'),
];

// ---------------------------------------------------------------------------
// Block type
// ---------------------------------------------------------------------------

const UNDER = 'A line of text under it.';

const blockTypes: ToolbarAction[] = [
    {
        id: 'paragraph', place: { menu: 'block-type' }, label: 'Paragraph', syntax: 'text, a blank line around it',
        sample: el('p', 'Paragraph'), apply: { kind: 'block', node: 'paragraph' }, example: 'Paragraph',
        preview: { markdown: 'A paragraph of text.\n\nAnother one below it.', nodes: [el('p', 'A paragraph of text.'), el('p', 'Another one below it.')] },
    },
    ...[1, 2, 3, 4, 5, 6].map((level): ToolbarAction => {
        const marker = '#'.repeat(level);
        const label = `Heading ${level}`;
        return {
            id: `heading-${level}`, place: { menu: 'block-type' }, label, syntax: `${marker} text`,
            sample: el(`h${level}`, label), apply: { kind: 'block', node: 'heading', level }, example: `${marker} ${label}`,
            preview: { markdown: `${marker} ${label}\n\n${UNDER}`, nodes: [el(`h${level}`, label), el('p', UNDER)] },
        };
    }),
    {
        id: 'blockquote', place: { menu: 'block-type' }, label: 'Quote', syntax: '> text',
        sample: el('blockquote', el('p', 'Quote')), apply: { kind: 'block', node: 'blockquote' }, example: '> Quote',
        preview: { markdown: '> A quoted line,\n> and the next.', nodes: [el('blockquote', el('p', 'A quoted line,\nand the next.'))] },
    },
    {
        id: 'bullet-list', place: { menu: 'block-type' }, label: 'Bullet list', syntax: '- text',
        sample: el('ul', el('li', 'Item')), apply: { kind: 'block', node: 'bullet_list' }, example: '- Item',
        preview: { markdown: '- First item\n- Second item', nodes: [el('ul', el('li', 'First item'), el('li', 'Second item'))] },
    },
    {
        id: 'ordered-list', place: { menu: 'block-type' }, label: 'Numbered list', syntax: '1. text',
        sample: el('ol', el('li', 'Item')), apply: { kind: 'block', node: 'ordered_list' }, example: '1. Item',
        preview: { markdown: '1. First item\n2. Second item', nodes: [el('ol', el('li', 'First item'), el('li', 'Second item'))] },
    },
    {
        id: 'code-block', place: { menu: 'block-type' }, label: 'Code block', syntax: '```\ncode\n```',
        sample: el('pre', el('code', 'code')), apply: { kind: 'block', node: 'code_block' }, example: '```\ncode\n```',
        preview: { markdown: '```\nconst answer = 42;\n```', nodes: [el('pre', el('code', 'const answer = 42;'))] },
    },
];

// ---------------------------------------------------------------------------
// Formatting — the extension's inline marks, toggled like the native ones
// ---------------------------------------------------------------------------

function formatAction(id: string, label: string, mark: MarkTarget, open: string, close: string, sample: SampleSpec, preview: ActionPreview): ToolbarAction {
    const glyph = typeof sample.children?.[0] === 'string' ? sample.children[0] : 'text';
    return {
        id, place: { menu: 'formatting' }, label, syntax: `${open}text${close}`, sample,
        apply: { kind: 'mark', mark, markup: null }, example: `${open}${glyph}${close}`, preview, bubble: true,
    };
}

const M = INLINE_MARKERS;

/** The literal the span action's example is written with. */
const SPAN_LITERAL_EXAMPLE = '{.class}';

/** What the span action's field starts with, and where its caret goes: after the dot, to type the class. */
export const SPAN_FIELD_PREFILL = { value: '{.}', caret: 2 } as const;

const formatting: ToolbarAction[] = [
    formatAction('mark', 'Highlight', 'mark', M.mark, M.mark, el('mark', 'mark'),
        { markdown: `Highlight ${M.mark}the point${M.mark} of a sentence.`, nodes: [el('p', 'Highlight ', el('mark', 'the point'), ' of a sentence.')] }),
    formatAction('superscript', 'Superscript', 'sup', M.superscript, M.superscript, el('sup', 'sup'),
        { markdown: `2${M.superscript}10${M.superscript} is 1024.`, nodes: [el('p', '2', el('sup', '10'), ' is 1024.')] }),
    formatAction('subscript', 'Subscript', 'sub', M.subscript, M.subscript, el('sub', 'sub'),
        { markdown: `Water is H${M.subscript}2${M.subscript}O.`, nodes: [el('p', 'Water is H', el('sub', '2'), 'O.')] }),
    formatAction('strikethrough', 'Strikethrough', 'strike', M.strikethrough, M.strikethrough, el('s', 'strike'),
        { markdown: `The ${M.strikethrough}old${M.strikethrough} new wording.`, nodes: [el('p', 'The ', el('s', 'old'), ' new wording.')] }),
    formatAction('kbd', 'Key', 'kbd', KBD_MARKERS.open, KBD_MARKERS.close, el('kbd', 'Ctrl'),
        { markdown: `Press ${KBD_MARKERS.open}Ctrl+S${KBD_MARKERS.close} to save.`, nodes: [el('p', 'Press ', el('kbd', 'Ctrl+S'), ' to save.')] }),
    {
        // markdown-it-bracketed-spans with markdown-it-attrs: the class a stylesheet names.
        id: 'span-class', place: { menu: 'formatting' }, label: 'Span with class', syntax: `[text]${SPAN_LITERAL_EXAMPLE}`,
        sample: el('span.class', 'span'), apply: { kind: 'attr-span' }, example: `[span]${SPAN_LITERAL_EXAMPLE}`,
        preview: { markdown: 'A [styled phrase]{.lead} in a sentence.', nodes: [el('p', 'A ', el('span.lead', 'styled phrase'), ' in a sentence.')] },
    },
];

// ---------------------------------------------------------------------------
// Annotations — notes and sidebars, edited in place; the footnote as source
// ---------------------------------------------------------------------------

function noteAction(id: string, label: string, node: NoteNodeName, open: string, close: string, sample: SampleSpec, preview: ActionPreview, syntaxText: string, bubble: boolean): ToolbarAction {
    const glyph = typeof sample.children?.[0] === 'string' ? sample.children[0] : 'text';
    return {
        id, place: { menu: 'annotation' }, label, syntax: `${open}${syntaxText}${close}`, sample,
        apply: { kind: 'wrap-node', node }, example: `${open}${glyph}${close}`, preview, ...(bubble ? { bubble: true as const } : {}),
    };
}

const SN = NOTE_SYNTAX.sidenote;
const MN = NOTE_SYNTAX.marginalNote;
const LS = NOTE_SYNTAX.leftSidebar;
const RS = NOTE_SYNTAX.rightSidebar;

const FOOTNOTE_TEXT = 'Footnote text';

/** A note inside a sentence, as `markdownItSidenote.ts` renders it: the note nested in its reference. */
function notePreview(marker: string, refClass: string, noteClass: string): ActionPreview {
    return {
        markdown: `Main text with ${marker}a reference${NOTE_SEPARATOR}The note that goes with it.${marker} that carries on.`,
        nodes: [el('p', 'Main text with ', el(`span.${refClass}`, 'a reference', el(`span.${noteClass}`, 'The note that goes with it.')), ' that carries on.')],
    };
}

function sidebarPreview(marker: string, cssClass: string): ActionPreview {
    return {
        markdown: `${marker}Context that runs alongside.${marker} The main text carries on.`,
        nodes: [el('p', el(`span.${cssClass}`, 'Context that runs alongside.'), ' The main text carries on.')],
    };
}

const annotations: ToolbarAction[] = [
    noteAction('sidenote', 'Sidenote', 'sidenote', SN.marker, `${NOTE_SEPARATOR}note${SN.marker}`,
        el(`span.${SN.refClass}`, 'sidenote'), notePreview(SN.marker, SN.refClass, SN.noteClass), 'reference', true),
    noteAction('marginal-note', 'Marginal note', 'marginal_note', MN.marker, `${NOTE_SEPARATOR}note${MN.marker}`,
        el(`span.${MN.refClass}`, 'marginal'), notePreview(MN.marker, MN.refClass, MN.noteClass), 'reference', true),
    noteAction('left-sidebar', 'Left sidebar', 'left_sidebar', LS.marker, LS.marker, el(`span.${LS.cssClass}`, 'left'), sidebarPreview(LS.marker, LS.cssClass), 'text', false),
    noteAction('right-sidebar', 'Right sidebar', 'right_sidebar', RS.marker, RS.marker, el(`span.${RS.cssClass}`, 'right'), sidebarPreview(RS.marker, RS.cssClass), 'text', false),
    {
        // A footnote label cannot hold the selected prose (no spaces), and a
        // reference without a definition renders as its literal text; so the
        // reference goes after the selection with the first free number, and
        // its definition is a source block of its own below the paragraph.
        id: 'footnote-reference', place: { menu: 'annotation' }, label: 'Footnote', syntax: `text[^1] … [^1]: ${FOOTNOTE_TEXT}`,
        sample: el('sup.footnote-ref', el('a', '[1]')),
        apply: { kind: 'wrap-source', open: '', close: `[^${FOOTNOTE_LABEL}]`, placeholder: '', definition: `[^${FOOTNOTE_LABEL}]: ${FOOTNOTE_TEXT}` },
        example: withLabel(`text[^${FOOTNOTE_LABEL}]\n\n[^${FOOTNOTE_LABEL}]: ${FOOTNOTE_TEXT}`),
        preview: {
            markdown: 'A claim that needs a source.[^1]\n\n[^1]: The source it rests on.',
            nodes: [
                el('p', 'A claim that needs a source.', el('sup.footnote-ref', el('a', '[1]'))),
                el('section.footnotes', el('ol.footnotes-list', el('li.footnote-item', el('p', 'The source it rests on.')))),
            ],
        },
    },
];

// ---------------------------------------------------------------------------
// Insert — new blocks, as source except the rule
// ---------------------------------------------------------------------------

function insertAction(id: string, label: string, template: string, sample: SampleSpec, preview: ActionPreview, example = template): ToolbarAction {
    return { id, place: { menu: 'insert' }, label, syntax: template, sample, apply: { kind: 'insert-source', template }, example, preview };
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

/** The class a new container is given; its object toolbar's Change name/info renames it. */
export const NEW_CONTAINER_NAME = 'container';

const checkbox = (checked: boolean): SampleSpec => withAttrs(el('input'), checked ? { type: 'checkbox', checked: 'true' } : { type: 'checkbox' });

const insert: ToolbarAction[] = [
    {
        id: 'horizontal-rule', place: { menu: 'insert' }, label: 'Horizontal rule', syntax: '---',
        sample: el('hr'),
        // Not first in the example: `---` opening a document is front matter.
        // The toolbar puts a rule after the current block, never first.
        apply: { kind: 'block', node: 'horizontal_rule' }, example: 'Text\n\n---',
        preview: { markdown: 'Above the rule.\n\n---\n\nBelow it.', nodes: [el('p', 'Above the rule.'), el('hr'), el('p', 'Below it.')] },
    },
    // Native since stage 3: an admonition node, its title the type's name, the caret in its body.
    ...ADMONITION_TYPES.map((type): ToolbarAction => ({
        id: `admonition-${type}`,
        place: { menu: 'insert', submenu: 'admonition' },
        label: titleOf(type),
        syntax: `${ADMONITION_MARKER} ${type} "${titleOf(type)}"`,
        sample: el(`div.admonition.${type}`, el('p.admonition-title', titleOf(type))),
        apply: { kind: 'insert-wrapper', node: 'admonition', type, title: titleOf(type) },
        example: `${ADMONITION_MARKER} ${type} "${titleOf(type)}"\n    Text`,
        preview: {
            markdown: `${ADMONITION_MARKER} ${type} "${titleOf(type)}"\n    One line of body text.`,
            nodes: [el(`div.admonition.${type}`, el('p.admonition-title', titleOf(type)), el('p', 'One line of body text.'))],
        },
    })),
    insertAction('table', 'Table', TABLE_TEMPLATE,
        el('table', el('tr', el('th', 'A'), el('th', 'B')), el('tr', el('td', '1'), el('td', '2'))),
        {
            markdown: '| Name | Value |\n| ---- | ----- |\n| Alpha | 1 |\n| Beta | 2 |',
            nodes: [el('table',
                el('thead', el('tr', el('th', 'Name'), el('th', 'Value'))),
                el('tbody', el('tr', el('td', 'Alpha'), el('td', '1')), el('tr', el('td', 'Beta'), el('td', '2'))))],
        }),
    {
        // Native since stage 3: a container node, the caret in its body.
        id: 'container', place: { menu: 'insert' }, label: 'Container', syntax: `::: ${NEW_CONTAINER_NAME}\n…\n:::`,
        sample: el(`div.${NEW_CONTAINER_NAME}`, 'container'),
        apply: { kind: 'insert-wrapper', node: 'container', name: NEW_CONTAINER_NAME },
        example: `::: ${NEW_CONTAINER_NAME}\nText\n:::`,
        preview: {
            markdown: `::: ${NEW_CONTAINER_NAME}\nA block with the class ${NEW_CONTAINER_NAME}.\n:::`,
            nodes: [el(`div.${NEW_CONTAINER_NAME}`, el('p', `A block with the class ${NEW_CONTAINER_NAME}.`))],
        },
    },
    insertAction('task-list', 'Task list', '- [ ] Task',
        el('ul', el('li', checkbox(false), el('label', 'Task'))),
        { markdown: '- [ ] An open task\n- [x] A done one', nodes: [el('ul', el('li', checkbox(false), el('label', 'An open task')), el('li', checkbox(true), el('label', 'A done one')))] }),
    insertAction('definition-list', 'Definition list', 'Term\n:   Definition',
        el('dl', el('dt', 'Term'), el('dd', 'Definition')),
        { markdown: 'Apple\n:   A pomaceous fruit.', nodes: [el('dl', el('dt', 'Apple'), el('dd', 'A pomaceous fruit.'))] }),
    insertAction('abbreviation', 'Abbreviation', '*[HTML]: HyperText Markup Language',
        withAttrs(el('abbr', 'HTML'), { title: 'HyperText Markup Language' }),
        {
            markdown: '*[HTML]: HyperText Markup Language\n\nThe HTML specification.',
            nodes: [el('p', 'The ', withAttrs(el('abbr', 'HTML'), { title: 'HyperText Markup Language' }), ' specification.')],
        },
        // The definition renders nothing; the abbreviation shows where it is used.
        '*[HTML]: HyperText Markup Language\n\nHTML'),
    insertAction('table-of-contents', 'Table of contents', '[[TOC]]',
        el('div.table-of-contents', el('ul', el('li', 'Contents'))),
        {
            markdown: '[[TOC]]\n\n## First section\n\n## Second section',
            nodes: [el('div.table-of-contents', el('ul', el('li', el('a', 'First section')), el('li', el('a', 'Second section'))))],
        },
        // A table of contents lists the headings after it.
        '[[TOC]]\n\n# Contents'),
];

/** Every action: the row's marks, then each menu's entries in their order. */
export const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [...marks, ...blockTypes, ...formatting, ...annotations, ...insert];

/** The row, left to right; hairlines between the groups. */
export const ROW_LAYOUT: readonly (readonly ('marks' | ToolbarMenu)[])[] = [['block-type'], ['marks'], ['formatting', 'annotation', 'insert']];

/** What a menu's face says (the block-type face says the current type instead, when there is one). */
export const MENU_LABELS: Readonly<Record<ToolbarMenu | ToolbarSubmenu, string>> = {
    'block-type': 'Block type',
    formatting: 'Formatting',
    annotation: 'Annotation',
    insert: 'Insert',
    admonition: 'Admonition',
};

/** How the submenu's entry in its parent names the syntax. */
export const SUBMENU_SYNTAX: Readonly<Record<ToolbarSubmenu, string>> = {
    admonition: `${ADMONITION_MARKER} type`,
};
