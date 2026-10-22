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
 *   element the parser makes from the syntax (`glyph`, else `sample`), drawn by
 *   the page's own cascade at its natural size and clipped, then its word, then
 *   its syntax (`column`, else the syntax's first line); a Block type entry draws
 *   its word as the element (`drawnLabel`).
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
 * - `apply`: `mark`, `wrap-node`, `block`, `attr-span`, `block-attrs`,
 *   `insert-wrapper` and `insert-table` edit natively — the extension's inline
 *   syntax (highlight, keys, notes, sidebars, …) is rich text since stage 2,
 *   attribute spans, containers and admonitions since stage 3, pipe tables and
 *   a block's `{…}` since; `wrap-source`
 *   and `insert-source` write a construct the editor cannot edit as rich text
 *   (a footnote, a task list, a definition list, …), as source; `insert-include` writes, as source, the
 *   include line the host hands back from another extension's choices;
 * - `bubble`: whether the selection bubble offers it too.
 *
 * The test renders every `example` and `preview.markdown` through the real
 * engine and requires the drawn elements in the HTML, so "this entry makes this
 * element" is checked, not assumed. **Include…** has no example: its syntax is
 * the offering extension's, and what it makes is whatever the snippet holds.
 */
import { ADMONITION_FAMILIES, ADMONITION_MARKER, INLINE_MARKERS, KBD_MARKERS, MARKER_NAMES, NOTE_SEPARATOR, NOTE_SYNTAX } from '../../../syntax/markers';
import { holderNamed, namesOf } from '../../inlineLiterals';
import { keyLabel } from '../../keys';
import { Said, Tip, TipPart } from '../../tips';
import { NOTE_LABELS, NoteNodeName } from '../notes';

/** The menus of the row, left to right after the marks' group. */
export type ToolbarMenu = 'block-type' | 'formatting' | 'annotation' | 'insert';

/** A menu opened from an entry of another. */
export type ToolbarSubmenu = 'admonition';

export type ActionPlace =
    | { row: true }
    | { menu: ToolbarMenu; submenu?: ToolbarSubmenu }
    /** The selection bubble only: a tool that acts on a selection and has no place in the row or a menu. */
    | { bubble: true };

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

/**
 * The class around each sample a button or a menu entry is drawn with.
 * `styles/markdown-extended.css` names it beside the card's: a sidebar's glyph
 * in the Annotation menu is a real `.left-sidebar`, and must open no margin
 * lane on the page.
 */
export const SAMPLE_CLASS = 'mep-sample';

/** The schema's marks a toolbar action toggles. */
export type MarkTarget = 'em' | 'strong' | 'code' | 'mark' | 'sup' | 'sub' | 'strike' | 'kbd';

export type ActionApply =
    /** A mark; `markup` is the delimiter it is written with (`null` for a mark whose delimiter cannot vary). */
    | { kind: 'mark'; mark: MarkTarget; markup: string | null }
    /** A note or a sidebar made of the selection, edited in place; inside one of its kind, removed again, its text kept (`notes.ts`, `toggleNote`). */
    | { kind: 'wrap-node'; node: NoteNodeName }
    | { kind: 'block'; node: BlockTarget; level?: number }
    /**
     * An attribute span made of the selection (`[text]{…}`): the attributes
     * field asks for what goes between the braces it draws, empty, `.class`
     * its placeholder (`attributesField`).
     */
    | { kind: 'attr-span' }
    /**
     * The `{…}` literal of the block at the caret (`attributesTargetAt`): the
     * attributes field asks for it — the block's literal between the braces
     * the field draws, or empty with the placeholder `.class` when it has
     * none; an emptied field removes it.
     */
    | { kind: 'block-attrs' }
    /**
     * The `{…}` literal of the inline element at the caret that carries or can
     * carry one (`attributeHolderAt`): inline code, a key, a link, emphasis,
     * superscript, subscript, a highlight, a span, a selected image. The entry
     * is named after it (**Attributes of Code…**), and the inline field asks
     * for the literal as the element's bar does (`holderAttributesStep`).
     */
    | { kind: 'inline-attrs' }
    /**
     * The bubble's `{…}`: over a selection within one inline holder's run,
     * that element's attributes (`inline-attrs`, the whole run); over any
     * other selection, an attribute span made of it (`attr-span`).
     */
    | { kind: 'attrs-bubble' }
    /**
     * A new container or admonition after the current block, edited in place,
     * the caret in its body (an empty paragraph): `name` is the container's
     * first class, `type` and `title` the admonition's.
     */
    | { kind: 'insert-wrapper'; node: 'container'; name: string }
    | { kind: 'insert-wrapper'; node: 'admonition'; type: string; title: string }
    /** A new pipe table after the current block, edited in place: a header row of `columns` cells and `rows` body rows, the first header cell's text selected. */
    | { kind: 'insert-table'; columns: number; rows: number }
    /**
     * The selection's text wrapped in `open` … `close` as literal source
     * (`placeholder` when nothing is selected); the block comes back from the
     * host as a source block. `definition`, when set, is a source block of its
     * own inserted after it (a footnote's text) — the one inline construct the
     * editor still writes this way, since a footnote is two blocks.
     */
    | { kind: 'wrap-source'; open: string; close: string; placeholder: string; definition?: string }
    /** A new source block holding `template`, inserted after the current block, its source opened. */
    | { kind: 'insert-source'; template: string }
    /**
     * `insert-source`'s variant whose line comes from the host: an include
     * directive, chosen in VS Code's QuickPick from the lines the extensions
     * that resolve includes offer (`host/includes.ts`). Inserted as a source
     * block after the current block and parsed again by the host, which turns
     * it into the expansion. The syntax is the provider's; nothing here knows it.
     */
    | { kind: 'insert-include' }
    /**
     * A link at the selection (`Ctrl+K` too): the inline field asks for the
     * address, with completion from the host (the workspace's files, the
     * headings of this document or the one typed); at a caret it asks for the
     * text first. In a link already, it changes that link's address.
     */
    | { kind: 'insert-link' }
    /**
     * An image at the caret: VS Code's open dialog chooses the file (the host,
     * `pickImage`), its path relative to the document is the `src`, and the
     * inline field asks for the alt text, the file's name prefilled.
     */
    | { kind: 'insert-image' }
    /**
     * Front matter for a document that has none: `---` twice at the top, the
     * properties panel opened at the name of a new property (`properties.ts`).
     */
    | { kind: 'insert-properties' };

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
    /**
     * Named by what the selection holds (`Attributes of Paragraph…`): its sample's text and
     * its tooltip's name follow the selection, `label` being the resting form — the one
     * shown while the row is locked, sample and tooltip alike.
     */
    named?: true;
    /**
     * The page keymap's binding for it, in ProseMirror's notation (`Mod-i`):
     * `plugins.ts` binds it, and the tooltip and `aria-keyshortcuts` name it —
     * one string, so the key a tooltip names is the key that does it.
     */
    key?: string;
    /**
     * What a menu entry draws in its swatch before the word: the element
     * (absent: `sample`), chrome text where the element draws nothing of its own
     * (`{…}`, `[ ]`), or nothing (`null`). `sample` stays what the entry makes,
     * as the fidelity test reads it.
     */
    glyph?: SampleSpec | { text: string } | null;
    /** The entry's label is its sample, drawn as the element (the Block type entries: Heading 1 in h1's style). */
    drawnLabel?: true;
    /** The first entry of a group of its menu: drawn after a separator, as the workbench divides its menus. */
    separated?: true;
    /** What the syntax column shows, where the syntax is too long for it (`[text](url)`); absent, the syntax's first line. Tooltip and card keep `syntax`. */
    column?: string;
    /** An admonition alias's canonical type (`summary` on `tldr`): the entry reads "Tldr  as Summary", under "More types…". */
    alias?: string;
}

/** What a source action's card says: the construct is edited as Markdown in a source block, not as rich text. */
export const SOURCE_NOTE = 'Edited as source, in a source block.';

/** The same as its tooltip's footnote. */
export const SOURCE_FOOTNOTE = `¹ ${SOURCE_NOTE.charAt(0).toLowerCase()}${SOURCE_NOTE.slice(1, -1)}`;

/** Whether the action writes source the editor shows as a source block, not as rich text. */
export function isSourceAction(action: ToolbarAction): boolean {
    return action.apply.kind === 'wrap-source' || action.apply.kind === 'insert-source';
}

export function inRow(action: ToolbarAction): boolean {
    return 'row' in action.place;
}

/** The bubble: the row's marks, then the entries marked for it, in the table's order, then its own. */
export function inBubble(action: ToolbarAction): boolean {
    return inRow(action) || action.bubble === true || 'bubble' in action.place;
}

export function menuOf(action: ToolbarAction): ToolbarMenu | null {
    return 'menu' in action.place ? action.place.menu : null;
}

export function submenuOf(action: ToolbarAction): ToolbarSubmenu | null {
    return 'menu' in action.place ? action.place.submenu ?? null : null;
}

/**
 * Markdown as the preview card prints it: a `data:` URI's payload elided
 * (`(data:image/png;base64,…)`), since a picture spelled out in base64 is
 * noise to read. Only the printed line: the card's rendering and the sample
 * keep the real URI, and the check renders the real Markdown.
 */
export function elideDataUris(markdown: string): string {
    return markdown.replace(/\(data:([^,)\s]*),[^)\s]*\)/g, '(data:$1,…)');
}

/** What a mark is written with, as its tooltip shows it: the delimiter (`**`), or both where they differ (`[[…]]`). */
function delimiterOf(action: ToolbarAction): string {
    const [open, close = ''] = action.syntax.split('text');
    return open === close ? open : `${open}…${close}`;
}

/** What the selection makes an action's tooltip say, and what the platform names the keys. */
export interface TipState {
    /** Its name where the selection names it (`Attributes of Paragraph…`); its own otherwise. */
    label?: string;
    /** Why it is refused here: the tip's second line. */
    reason?: Said | null;
    /** Keys named as on macOS (`macKeys`). */
    mac?: boolean;
}

/**
 * The action's tooltip, as parts (`tips.ts`). A mark names itself, its
 * delimiter and its element, then its key where the page binds one —
 * `Italic (*, <i>) — Ctrl+I`; any other action its name, the syntax it writes
 * and the source footnote where it applies. The reason it is refused, if any,
 * is the second line.
 */
export function tipOf(action: ToolbarAction, state: TipState = {}): Tip {
    const label = state.label ?? action.label;
    const note = state.reason ?? null;
    if (action.apply.kind === 'mark') {
        const parts: TipPart[] = [`${label} (`, { code: delimiterOf(action) }, ', ', { code: `<${action.sample.tag}>` }, ')'];
        if (action.key !== undefined) {
            parts.push({ keys: keyLabel(action.key, state.mac ?? false) });
        }
        return { parts, note };
    }
    const source = isSourceAction(action);
    const syntax = action.syntax.includes('\n') ? `\n${action.syntax}` : ` ${action.syntax}`;
    return { parts: [`${label}${source ? '¹' : ''}:${syntax}${source ? `\n${SOURCE_FOOTNOTE}` : ''}`], note };
}

/** The control's accessible name: a mark's word and its delimiter spoken (`Italic, asterisk`); else its label. */
export function ariaLabelOf(action: ToolbarAction): string {
    const spoken = action.apply.kind === 'mark' ? MARKER_NAMES[delimiterOf(action)] : undefined;
    return spoken === undefined ? action.label : `${action.label}, ${spoken}`;
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

/**
 * A row mark, named and tagged by its inline holder (`inlineLiterals.ts`) as
 * its bar, its field and "Attributes of Bold…" name it — one name per
 * delimiter and element, read, not written again. Its glyph is its tag.
 */
function markAction(id: string, mark: 'em' | 'strong' | 'code', marker: string, markup: string | null, key?: string): ToolbarAction {
    const holder = holderNamed(mark);
    if (holder === undefined || holder.tag === undefined) {
        throw new Error(`no inline holder for ${mark}`);
    }
    const tag = holder.tag(marker);
    return {
        id, place: { row: true }, label: namesOf(holder, marker).label, syntax: `${marker}text${marker}`, sample: el(tag, tag),
        apply: { kind: 'mark', mark, markup }, example: `${marker}${tag}${marker}`, ...(key === undefined ? {} : { key }),
    };
}

const marks: ToolbarAction[] = [
    // `markdown-it-ib` renders the four emphasis delimiters as four elements, so
    // the row offers all four and a stylesheet can tell them apart.
    markAction('italic', 'em', INLINE_MARKERS.italics, INLINE_MARKERS.italics, 'Mod-i'),
    markAction('emphasis', 'em', INLINE_MARKERS.underline, INLINE_MARKERS.underline),
    markAction('bold', 'strong', INLINE_MARKERS.bold, INLINE_MARKERS.bold, 'Mod-b'),
    markAction('strong', 'strong', INLINE_MARKERS.strong, INLINE_MARKERS.strong),
    markAction('code', 'code', INLINE_MARKERS.codeInline, null, 'Mod-`'),
];

// ---------------------------------------------------------------------------
// Block type
// ---------------------------------------------------------------------------

const UNDER = 'A line of text under it.';

const blockTypes: ToolbarAction[] = [
    {
        id: 'paragraph', place: { menu: 'block-type' }, label: 'Paragraph', syntax: 'text, a blank line around it', column: 'text', drawnLabel: true,
        sample: el('p', 'Paragraph'), apply: { kind: 'block', node: 'paragraph' }, example: 'Paragraph',
        preview: { markdown: 'A paragraph of text.\n\nAnother one below it.', nodes: [el('p', 'A paragraph of text.'), el('p', 'Another one below it.')] },
    },
    ...[1, 2, 3, 4, 5, 6].map((level): ToolbarAction => {
        const marker = '#'.repeat(level);
        const label = `Heading ${level}`;
        return {
            id: `heading-${level}`, place: { menu: 'block-type' }, label, syntax: `${marker} text`, drawnLabel: true,
            sample: el(`h${level}`, label), apply: { kind: 'block', node: 'heading', level }, example: `${marker} ${label}`,
            preview: { markdown: `${marker} ${label}\n\n${UNDER}`, nodes: [el(`h${level}`, label), el('p', UNDER)] },
        };
    }),
    {
        id: 'blockquote', place: { menu: 'block-type' }, label: 'Quote', syntax: '> text', drawnLabel: true,
        sample: el('blockquote', el('p', 'Quote')), apply: { kind: 'block', node: 'blockquote' }, example: '> Quote',
        preview: { markdown: '> A quoted line,\n> and the next.', nodes: [el('blockquote', el('p', 'A quoted line,\nand the next.'))] },
    },
    {
        id: 'bullet-list', place: { menu: 'block-type' }, label: 'Bullet list', syntax: '- text', drawnLabel: true,
        sample: el('ul', el('li', 'Bullet list')), apply: { kind: 'block', node: 'bullet_list' }, example: '- Bullet list',
        preview: { markdown: '- First item\n- Second item', nodes: [el('ul', el('li', 'First item'), el('li', 'Second item'))] },
    },
    {
        id: 'ordered-list', place: { menu: 'block-type' }, label: 'Numbered list', syntax: '1. text', drawnLabel: true,
        sample: el('ol', el('li', 'Numbered list')), apply: { kind: 'block', node: 'ordered_list' }, example: '1. Numbered list',
        preview: { markdown: '1. First item\n2. Second item', nodes: [el('ol', el('li', 'First item'), el('li', 'Second item'))] },
    },
    {
        id: 'code-block', place: { menu: 'block-type' }, label: 'Code block', syntax: '```\ncode\n```', drawnLabel: true,
        sample: el('pre', el('code', 'Code block')), apply: { kind: 'block', node: 'code_block' }, example: '```\nCode block\n```',
        preview: { markdown: '```\nconst answer = 42;\n```', nodes: [el('pre', el('code', 'const answer = 42;'))] },
    },
];

// ---------------------------------------------------------------------------
// Formatting — the extension's inline marks, toggled like the native ones
// ---------------------------------------------------------------------------

/** A Formatting entry, named by its inline holder (`inlineLiterals.ts`) as its bar and "Attributes of …" name it. */
function formatAction(id: string, mark: MarkTarget, open: string, close: string, sample: SampleSpec, glyph: SampleSpec, preview: ActionPreview): ToolbarAction {
    const text = typeof sample.children?.[0] === 'string' ? sample.children[0] : 'text';
    const label = holderNamed(mark)?.label;
    if (label === undefined) {
        throw new Error(`no inline holder for ${mark}`);
    }
    return {
        id, place: { menu: 'formatting' }, label, syntax: `${open}text${close}`, sample, glyph,
        apply: { kind: 'mark', mark, markup: null }, example: `${open}${text}${close}`, preview, bubble: true,
    };
}

const M = INLINE_MARKERS;

/** The literal the attribute entries, the bubble's `{…}` and their tooltips write a class with. */
export const CLASS_LITERAL = '{.class}';

/** The literal the block-attributes entry's example is written with. */
const BLOCK_LITERAL_EXAMPLE = '{.x}';

/**
 * **Attributes of Block…** as both menus offer it — Formatting and Block type:
 * named by the block (`Attributes of Paragraph…`); refused, `Attributes of
 * Block…`; one syntax, sample, example and card.
 */
const BLOCK_ATTRIBUTES = {
    named: true, label: 'Attributes of Block…', syntax: `text ${CLASS_LITERAL}`, glyph: { text: '{…}' },
    sample: el('p.x', 'Attributes…'), apply: { kind: 'block-attrs' }, example: `Attributes… ${BLOCK_LITERAL_EXAMPLE}`,
    preview: {
        markdown: 'A paragraph with a class of its own. {.lead}',
        nodes: [el('p.lead', 'A paragraph with a class of its own.')],
    },
} satisfies Omit<ToolbarAction, 'id' | 'place'>;


/** Why Attributes of Code… is disabled: nothing inline at the caret carries a {…}. */
export const INLINE_ATTRS_LOCK = 'Put the caret in code, a key, a link, emphasis, superscript, subscript, a highlight or a span, or select an image. Alt+Enter opens its bar.';

const formatting: ToolbarAction[] = [
    formatAction('mark', 'mark', M.mark, M.mark, el('mark', 'mark'), el('mark', 'ab'),
        { markdown: `Highlight ${M.mark}the point${M.mark} of a sentence.`, nodes: [el('p', 'Highlight ', el('mark', 'the point'), ' of a sentence.')] }),
    formatAction('superscript', 'sup', M.superscript, M.superscript, el('sup', 'sup'), el('span', 'x', el('sup', '2')),
        { markdown: `2${M.superscript}10${M.superscript} is 1024.`, nodes: [el('p', '2', el('sup', '10'), ' is 1024.')] }),
    formatAction('subscript', 'sub', M.subscript, M.subscript, el('sub', 'sub'), el('span', 'H', el('sub', '2')),
        { markdown: `Water is H${M.subscript}2${M.subscript}O.`, nodes: [el('p', 'Water is H', el('sub', '2'), 'O.')] }),
    formatAction('strikethrough', 'strike', M.strikethrough, M.strikethrough, el('s', 'strike'), el('s', 'ab'),
        { markdown: `The ${M.strikethrough}old${M.strikethrough} new wording.`, nodes: [el('p', 'The ', el('s', 'old'), ' new wording.')] }),
    formatAction('kbd', 'kbd', KBD_MARKERS.open, KBD_MARKERS.close, el('kbd', 'Ctrl'), el('kbd', 'Ctrl'),
        { markdown: `Press ${KBD_MARKERS.open}Ctrl+S${KBD_MARKERS.close} to save.`, nodes: [el('p', 'Press ', el('kbd', 'Ctrl+S'), ' to save.')] }),
    {
        // markdown-it-bracketed-spans with markdown-it-attrs: the class a stylesheet names.
        // It opens a field, as Link… and Image… do; its glyph the brackets it writes.
        id: 'span-class', place: { menu: 'formatting' }, label: 'Span with class…', syntax: `[text]${CLASS_LITERAL}`, glyph: { text: '[ ]' }, separated: true,
        sample: el('span.class', 'span'), apply: { kind: 'attr-span' }, example: `[span]${CLASS_LITERAL}`,
        preview: { markdown: 'A [styled phrase]{.lead} in a sentence.', nodes: [el('p', 'A ', el('span.lead', 'styled phrase'), ' in a sentence.')] },
    },
    {
        // markdown-it-attrs on the inline element at the caret: written right after it. Named
        // by the element (`Attributes of Link…`); the label here is its resting form.
        id: 'inline-attributes', place: { menu: 'formatting' }, named: true, label: 'Attributes of Element…', syntax: `…${CLASS_LITERAL}`, glyph: { text: '{…}' },
        sample: el('code.x', 'Attributes…'), apply: { kind: 'inline-attrs' }, example: `\`Attributes…\`${BLOCK_LITERAL_EXAMPLE}`,
        preview: {
            markdown: 'Run `--flag`{.k} to skip the cache.',
            nodes: [el('p', 'Run ', el('code.k', '--flag'), ' to skip the cache.')],
        },
    },
    // markdown-it-attrs on the block at the caret: written where the plugin reads it for that block.
    { id: 'block-attributes', place: { menu: 'formatting' }, ...BLOCK_ATTRIBUTES },
];

/**
 * The Block type menu's way to the same field, last, after a divider (Daniel,
 * wave 2 #13): one entry in two menus, so its label, its state and its card
 * are Formatting's (`BLOCK_ATTRIBUTES`, `stateOf`'s `block-attrs`). A plain
 * entry, not one of the menu's block types: it is never the current one.
 */
const blockTypeAttributes: ToolbarAction = { id: 'block-type-attributes', place: { menu: 'block-type' }, separated: true, ...BLOCK_ATTRIBUTES };

// ---------------------------------------------------------------------------
// Annotations — notes and sidebars, edited in place; the footnote as source
// ---------------------------------------------------------------------------

/** A note or sidebar entry, named as its bar names it (`NOTE_LABELS`); its glyph the reference's element on two letters (a note's inside its anchor), its column the syntax with `text` for the reference. */
function noteAction(id: string, node: NoteNodeName, open: string, close: string, sample: SampleSpec, preview: ActionPreview, syntaxText: string, bubble: boolean, glyph: SampleSpec = { ...sample, children: ['ab'] }): ToolbarAction {
    // The sample's text, a note's inside its anchor.
    const textOf = (spec: SampleSpec): string | undefined => {
        const first = spec.children?.[0];
        return typeof first === 'string' ? first : first ? textOf(first) : undefined;
    };
    const text = textOf(sample) ?? 'text';
    return {
        id, place: { menu: 'annotation' }, label: NOTE_LABELS[node], syntax: `${open}${syntaxText}${close}`, sample,
        glyph, ...(syntaxText === 'text' ? {} : { column: `${open}text${close}` }),
        apply: { kind: 'wrap-node', node }, example: `${open}${text}${close}`, preview, ...(bubble ? { bubble: true as const } : {}),
    };
}

const SN = NOTE_SYNTAX.sidenote;
const MN = NOTE_SYNTAX.marginalNote;
const LS = NOTE_SYNTAX.leftSidebar;
const RS = NOTE_SYNTAX.rightSidebar;

const FOOTNOTE_TEXT = 'Footnote text';

/** A note inside a sentence, as `markdownItSidenote.ts` renders it: the reference's anchor, then the note, nested in the reference span. */
function notePreview({ marker, refClass, anchorClass, noteClass }: typeof SN | typeof MN): ActionPreview {
    return {
        markdown: `Main text with ${marker}a reference${NOTE_SEPARATOR}The note that goes with it.${marker} that carries on.`,
        nodes: [el('p', 'Main text with ', el(`span.${refClass}`, el(`span.${anchorClass}`, 'a reference'), el(`span.${noteClass}`, 'The note that goes with it.')), ' that carries on.')],
    };
}

/** A note's glyph in its menu: the reference as the document draws it, anchor and all. */
function noteGlyph({ refClass, anchorClass }: typeof SN | typeof MN, label: string): SampleSpec {
    return el(`span.${refClass}`, el(`span.${anchorClass}`, label));
}

function sidebarPreview(marker: string, cssClass: string): ActionPreview {
    return {
        markdown: `${marker}Context that runs alongside.${marker} The main text carries on.`,
        nodes: [el('p', el(`span.${cssClass}`, 'Context that runs alongside.'), ' The main text carries on.')],
    };
}

const annotations: ToolbarAction[] = [
    noteAction('sidenote', 'sidenote', SN.marker, `${NOTE_SEPARATOR}note${SN.marker}`,
        noteGlyph(SN, 'sidenote'), notePreview(SN), 'reference', true, noteGlyph(SN, 'ab')),
    noteAction('marginal-note', 'marginal_note', MN.marker, `${NOTE_SEPARATOR}note${MN.marker}`,
        noteGlyph(MN, 'marginal'), notePreview(MN), 'reference', true, noteGlyph(MN, 'ab')),
    noteAction('left-sidebar', 'left_sidebar', LS.marker, LS.marker, el(`span.${LS.cssClass}`, 'left'), sidebarPreview(LS.marker, LS.cssClass), 'text', false),
    noteAction('right-sidebar', 'right_sidebar', RS.marker, RS.marker, el(`span.${RS.cssClass}`, 'right'), sidebarPreview(RS.marker, RS.cssClass), 'text', false),
    {
        // A footnote label cannot hold the selected prose (no spaces), and a
        // reference without a definition renders as its literal text; so the
        // reference goes after the selection with the first free number, and
        // its definition is a source block of its own below the paragraph.
        id: 'footnote-reference', place: { menu: 'annotation' }, label: 'Footnote', syntax: `text[^1] … [^1]: ${FOOTNOTE_TEXT}`, column: 'text[^1]', separated: true,
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
// Insert — new blocks: the rule, admonitions and the container in place, the rest as source
// ---------------------------------------------------------------------------

/** How a menu entry is drawn beside what it does (`glyph`, `separated`, `column`). */
type EntryLook = Pick<ToolbarAction, 'glyph' | 'separated' | 'column'>;

function insertAction(id: string, label: string, template: string, sample: SampleSpec, preview: ActionPreview, example = template, look: EntryLook = {}): ToolbarAction {
    return { id, place: { menu: 'insert' }, label, syntax: template, sample, apply: { kind: 'insert-source', template }, example, preview, ...look };
}

/** An admonition type as the Insert menu and the bars spell it: `warning` → `Warning`. */
export function titleOf(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
}

// Templates follow `snippets/markdown.code-snippets` where it has one, with
// its tab stops filled in.
/** What **Insert → Table** makes: three columns, a header row and two empty rows, in the tidy form a changed table is written in. */
const NEW_TABLE = { columns: 3, rows: 2 };
const NEW_TABLE_MARKDOWN = [
    '| Column 1 | Column 2 | Column 3 |',
    '| -------- | -------- | -------- |',
    '|          |          |          |',
    '|          |          |          |',
].join('\n');

/** What **Include…** names as its syntax: the line is the offering extension's, not this one's. */
export const INCLUDE_SYNTAX = 'a snippet line, as its extension offers it';

/** Why **Include…** and **Change snippet…** are disabled; the host's message says the same. */
export const NO_INCLUDES_REFUSAL = 'No extension offers includes for this document.';

/** Why **Insert → Properties** is off: a document has one front matter, and it is the panel at the top. */
export const PROPERTIES_PRESENT_REFUSAL = 'The document has properties already: the panel at its top.';

/** What **Insert → Properties** names: the front matter's fences, written at the top of the file. */
export const PROPERTIES_SYNTAX = '---\nkey: value\n---';

/** The address the link entry's syntax, sample and preview name. */
const LINK_EXAMPLE_HREF = 'chapter.md#overview';

/** The path the image entry's syntax names. */
const IMAGE_EXAMPLE_SRC = 'images/overview.png';

/** The image entry's sample: a 24×16 landscape, sky, hill and sun, as a PNG. */
const SAMPLE_PICTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAASUlEQVR42mOooBJgAOJ5x99RiAbUoG9HXCCIIoPgpqCZNQwMoloYDcroJ2xQ2IIYXIgEg/CYQoxZUIMImkLQLNIMwmMc1CCqAADnhP+yQhhAvwAAAABJRU5ErkJggg==';

/** The class a new container is given; its object toolbar's Edit classes… renames it. */
export const NEW_CONTAINER_NAME = 'container';

const checkbox = (checked: boolean): SampleSpec => withAttrs(el('input'), checked ? { type: 'checkbox', checked: 'true' } : { type: 'checkbox' });

const insert: ToolbarAction[] = [
    {
        // A mark on text, made native; the address is asked for in the inline field.
        // The sample carries no href: VS Code's webview follows a clicked <a href> from
        // its window, whatever the menu entry does with the click.
        id: 'link', place: { menu: 'insert' }, label: 'Link…', syntax: `[text](${LINK_EXAMPLE_HREF})`, column: '[text](url)',
        sample: el('a', 'link'), apply: { kind: 'insert-link' },
        example: `[link](${LINK_EXAMPLE_HREF})`,
        preview: {
            markdown: `See [the other chapter](${LINK_EXAMPLE_HREF}) for more.`,
            nodes: [el('p', 'See ', el('a', 'the other chapter'), ' for more.')],
        },
    },
    {
        // A real <img> showing a real picture: a small one inline, as `data:`
        // (which the CSP admits and markdown-it passes for PNG), so the entry's
        // example renders the very element the entry draws.
        id: 'image', place: { menu: 'insert' }, label: 'Image…', syntax: `![alt](${IMAGE_EXAMPLE_SRC})`, column: '![alt](path)',
        sample: withAttrs(el('img'), { src: SAMPLE_PICTURE }), apply: { kind: 'insert-image' },
        example: `![image](${SAMPLE_PICTURE})`,
        preview: {
            markdown: `A figure: ![A landscape](${SAMPLE_PICTURE})`,
            nodes: [el('p', 'A figure: ', withAttrs(el('img'), { src: SAMPLE_PICTURE }))],
        },
    },
    {
        id: 'horizontal-rule', place: { menu: 'insert' }, label: 'Horizontal rule', syntax: '---', separated: true,
        sample: el('hr'),
        // Not first in the example: `---` opening a document is front matter.
        // The toolbar puts a rule after the current block, never first.
        apply: { kind: 'block', node: 'horizontal_rule' }, example: 'Text\n\n---',
        preview: { markdown: 'Above the rule.\n\n---\n\nBelow it.', nodes: [el('p', 'Above the rule.'), el('hr'), el('p', 'Below it.')] },
    },
    // Native since stage 3: an admonition node, its title the type's name, the caret in its body.
    // The canonical type of each look first, then the aliases (`ADMONITION_FAMILIES`), which the
    // submenu keeps under "More types…": the first of them opens that group.
    ...[
        ...ADMONITION_FAMILIES.map(f => ({ type: f.type, alias: undefined as string | undefined })),
        ...ADMONITION_FAMILIES.flatMap(f => f.aliases.map(type => ({ type, alias: f.type as string | undefined }))),
    ].map(({ type, alias }, i): ToolbarAction => ({
        id: `admonition-${type}`,
        place: { menu: 'insert', submenu: 'admonition' },
        label: titleOf(type),
        ...(alias === undefined ? {} : { alias }),
        ...(i === ADMONITION_FAMILIES.length ? { separated: true as const } : {}),
        syntax: `${ADMONITION_MARKER} ${type} "${titleOf(type)}"`,
        column: `${ADMONITION_MARKER} ${type}`,
        glyph: el(`div.admonition.${type}`, el('p.admonition-title')),
        sample: el(`div.admonition.${type}`, el('p.admonition-title', titleOf(type))),
        apply: { kind: 'insert-wrapper', node: 'admonition', type, title: titleOf(type) },
        example: `${ADMONITION_MARKER} ${type} "${titleOf(type)}"\n    Text`,
        preview: {
            markdown: `${ADMONITION_MARKER} ${type} "${titleOf(type)}"\n    One line of body text.`,
            nodes: [el(`div.admonition.${type}`, el('p.admonition-title', titleOf(type)), el('p', 'One line of body text.'))],
        },
    })),
    {
        // Native: a pipe table edited in place, the first header cell's text selected.
        id: 'table', place: { menu: 'insert' }, label: 'Table', syntax: NEW_TABLE_MARKDOWN, column: '| A | B |',
        sample: el('table', el('tr', el('th', 'A'), el('th', 'B')), el('tr', el('td', '1'), el('td', '2'))),
        apply: { kind: 'insert-table', ...NEW_TABLE }, example: NEW_TABLE_MARKDOWN,
        preview: {
            markdown: '| Name  | Value |\n| ----- | ----: |\n| Alpha |     1 |\n| Beta  |     2 |',
            nodes: [el('table',
                el('thead', el('tr', el('th', 'Name'), el('th', 'Value'))),
                el('tbody', el('tr', el('td', 'Alpha'), el('td', '1')), el('tr', el('td', 'Beta'), el('td', '2'))))],
        },
    },
    {
        // Native since stage 3: a container node, the caret in its body.
        // No glyph: a div draws nothing of its own.
        id: 'container', place: { menu: 'insert' }, label: 'Container', syntax: `::: ${NEW_CONTAINER_NAME}\n…\n:::`, column: '::: name', glyph: null,
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
        { markdown: '- [ ] An open task\n- [x] A done one', nodes: [el('ul', el('li', checkbox(false), el('label', 'An open task')), el('li', checkbox(true), el('label', 'A done one')))] },
        undefined, { separated: true, column: '- [ ] text', glyph: el('ul', el('li', checkbox(false))) }),
    insertAction('definition-list', 'Definition list', 'Term\n:   Definition',
        el('dl', el('dt', 'Term'), el('dd', 'Definition')),
        { markdown: 'Apple\n:   A pomaceous fruit.', nodes: [el('dl', el('dt', 'Apple'), el('dd', 'A pomaceous fruit.'))] },
        undefined, { column: 'Term ↵ : text', glyph: el('dl', el('dt', 'Term')) }),
    insertAction('abbreviation', 'Abbreviation', '*[HTML]: HyperText Markup Language',
        withAttrs(el('abbr', 'HTML'), { title: 'HyperText Markup Language' }),
        {
            markdown: '*[HTML]: HyperText Markup Language\n\nThe HTML specification.',
            nodes: [el('p', 'The ', withAttrs(el('abbr', 'HTML'), { title: 'HyperText Markup Language' }), ' specification.')],
        },
        // The definition renders nothing; the abbreviation shows where it is used.
        '*[HTML]: HyperText Markup Language\n\nHTML', { column: '*[HTML]: …' }),
    insertAction('table-of-contents', 'Table of contents', '[[TOC]]',
        el('div.table-of-contents', el('ul', el('li', 'Contents'))),
        {
            markdown: '[[TOC]]\n\n## First section\n\n## Second section',
            nodes: [el('div.table-of-contents', el('ul', el('li', el('a', 'First section')), el('li', el('a', 'Second section'))))],
        },
        // A table of contents lists the headings after it. No glyph: a list of links is no picture of it.
        '[[TOC]]\n\n# Contents', { glyph: null }),
    {
        // The directive's syntax belongs to the extension that resolves it:
        // there is no example to render here, only the line it will offer.
        // No glyph and no column: what it makes is the snippet's, its line the provider's.
        id: 'include', place: { menu: 'insert' }, label: 'Include…', syntax: INCLUDE_SYNTAX, glyph: null, column: '', separated: true,
        sample: el('p', 'Snippet'), apply: { kind: 'insert-include' }, example: '',
        preview: {
            markdown: 'The text of a snippet, shown where its directive line stands.',
            nodes: [el('p', 'The text of a snippet, shown where its directive line stands.')],
        },
    },
    {
        // Front matter renders nothing in the preview: the entry claims no
        // example, and the panel it opens is the editor's own chrome.
        id: 'properties', place: { menu: 'insert' }, label: 'Properties', syntax: PROPERTIES_SYNTAX, glyph: null, column: '--- key: value ---',
        sample: el('p', 'Properties'), apply: { kind: 'insert-properties' }, example: '',
        preview: {
            markdown: 'Keys and values at the top of the file, as YAML front matter, edited in the properties panel.',
            nodes: [el('p', 'Keys and values at the top of the file, as YAML front matter, edited in the properties panel.')],
        },
    },
];

/** Every action: the row's marks, then each menu's entries in their order. */
/**
 * The bubble's own tools, after the marks and the notes: `{…}`, one button for
 * every element's attributes, always there so the bubble keeps its width. Its
 * glyph is text, not an element's sample: it stands for every holder.
 */
const bubbleOnly: ToolbarAction[] = [
    {
        id: 'attrs-bubble', place: { bubble: true }, label: 'Attributes', syntax: `[text]${CLASS_LITERAL}`,
        sample: el('span.x', '{…}'), apply: { kind: 'attrs-bubble' }, example: `[span]${BLOCK_LITERAL_EXAMPLE}`,
    },
];

export const TOOLBAR_ACTIONS: readonly ToolbarAction[] = [...marks, ...blockTypes, blockTypeAttributes, ...formatting, ...annotations, ...insert, ...bubbleOnly];

/** The row, left to right; hairlines between the groups. */
export const ROW_LAYOUT: readonly (readonly ('marks' | ToolbarMenu)[])[] = [['block-type'], ['marks'], ['formatting', 'annotation', 'insert']];

/** A control of the row: a mark action's id, or a menu. */
export type RowControl = ToolbarMenu | string;

const ROW_MENUS = ROW_LAYOUT.flat().filter((g): g is ToolbarMenu => g !== 'marks');
const ROW_MARKS = TOOLBAR_ACTIONS.filter(inRow).map(a => a.id);

/**
 * The order controls leave the row for "…" when it is too narrow (Daniel,
 * 2026-10-19): the three menus — Annotation, Formatting, Insert — then the
 * marks one at a time from the right. Block type never leaves. The mark order
 * is `ROW_LAYOUT`'s, reversed — not written twice.
 */
export const ROW_OVERFLOW: readonly RowControl[] = ['annotation', 'formatting', 'insert', ...[...ROW_MARKS].reverse()];

/** The order "…" lists what it holds: the marks in row order, then (after a divider) the menus in row order. */
export function moreOrder(moved: readonly RowControl[]): { marks: string[]; menus: ToolbarMenu[] } {
    return {
        marks: ROW_MARKS.filter(id => moved.includes(id)),
        menus: ROW_MENUS.filter(id => moved.includes(id)),
    };
}

const BUBBLE_ITEMS = TOOLBAR_ACTIONS.filter(inBubble).map(a => a.id);

/**
 * The order the bubble's controls leave it for its "…" where it is too
 * narrow (Daniel, 2026-10-20: the bubble gets the row's overflow), derived as
 * the row's is: what the bubble adds to the row's marks leaves first — the
 * extension's marks, the notes and Attributes — from the right, as the row's
 * menus leave before its marks; then the row's own marks, from the right, in
 * `ROW_OVERFLOW`'s order. The marks with keys stay longest.
 */
export const BUBBLE_OVERFLOW: readonly string[] = [
    ...BUBBLE_ITEMS.filter(id => !ROW_MARKS.includes(id)).reverse(),
    ...ROW_OVERFLOW.filter(id => ROW_MARKS.includes(id)),
];

/** Whether a bubble control is one of the row's marks: "…" lists those first, the rest after a divider. */
export function isRowMark(id: string): boolean {
    return ROW_MARKS.includes(id);
}

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

/** What the submenu's entry in its parent draws in its swatch: an admonition's bar and icon, without a title. */
export const SUBMENU_GLYPH: Readonly<Record<ToolbarSubmenu, SampleSpec>> = {
    admonition: el('div.admonition.note', el('p.admonition-title')),
};

/** What an alias's entry says after its word: the type it is drawn as (`as Summary`); `null` for any other entry. */
export function aliasNote(action: ToolbarAction): string | null {
    return action.alias === undefined ? null : `as ${titleOf(action.alias)}`;
}

/** The entry that shows the admonition aliases (`alias`) in place, and what it says while they show. */
export const MORE_TYPES = (count: number): string => `More types… (${count})`;
export const FEWER_TYPES = 'Fewer types';
