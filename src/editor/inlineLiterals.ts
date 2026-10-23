/**
 * The inline elements that carry a `{…}` literal written right after them —
 * one registry, read by every module that needs to know which they are: the
 * host's parse (`blocks.ts`, `parse.ts`), the read-back (`attrs.ts`), the
 * serializer (`serialize.ts`), the objects and their bars (`objects.ts`,
 * `objectToolbar.ts`). markdown-it-attrs' "inline attributes" rule gives a
 * `{…}` that starts the text right after an element's closing tag (or right
 * after a nesting-0 token such as inline code) to that element; each entry
 * says what carries the literal in the editor's schema, which token the
 * plugin gives it to, which characters it follows in the source and the
 * smallest source in which the plugin reads one on it.
 *
 * Notes and sidebars are holders too (`++r|b++{.x}`, `!!r|b!!{.x}`, `$b${.x}`,
 * `@b@{.x}`): the notes plugin's outer span takes a `{…}` glued to the
 * closing marker. Each is a node carrying the literal, as an image is; a `{…}`
 * after a space or on the next line is the paragraph's, heading's or item's.
 *
 * No ProseMirror and no DOM here, so every module can read it.
 * `attrs.test.ts` holds each entry to the engine: the literal written after
 * its `source` is given to its `token`, and the cut is right after it.
 */
import { NOTE_SYNTAX } from '../syntax/markers';

/**
 * What each note is called — on its bar, in the Annotation menu, and (lowercase)
 * in a refusal. The one source of the four names: `refusal.ts` and
 * `webview/notes.ts` give them out as `NOTE_LABELS`, the registry reads them.
 */
export const NOTE_NAMES = {
    sidenote: 'Sidenote',
    marginal_note: 'Marginal note',
    left_sidebar: 'Left sidebar',
    right_sidebar: 'Right sidebar',
} as const;

export interface InlineLiteralHolder {
    /** The holder's key, what `attrsReadAt` and a `LiteralPlace` know it by: `span`, `em`, `link`, `code`, `image` … */
    holder: string;
    /** What carries `literal` in the schema: a mark, or the node for an image, a note or a sidebar. */
    carrier: { mark: string } | { node: string };
    /** The token markdown-it-attrs gives the literal to: `em_open`, `span_open`, `code_inline`, `image` … */
    token: string;
    /**
     * The characters the literal follows in the source: a fixed set, or
     * `markup` — the last character of the closing token's markup (a
     * delimiter run's, inline code's backtick run).
     */
    closing: string;
    /** The smallest source in which the plugin reads `literal` on this holder (`READ_BACK` in `attrs.ts`). */
    source: (literal: string) => string;
    /** The token's own attributes, which no literal gives: a link's `href` and `title`, an image's `src`, `alt` and `title`. */
    own: readonly string[];
    /** What it is called in a reason (`emphasis whose literal holds …`). */
    noun: string;
    /** What it is called at the start of a sentence that refuses something (`Emphasis in a note cannot hold …`). */
    subject: string;
    /** Its bar's label, and the name the menu and the field give it (`Emphasis`, `Code`). */
    label: string;
    /** A run carrying a literal is a `styled` object; a link, a span and an image have bars of their own. */
    styled: boolean;
    /**
     * The names by the delimiter it is written with, where that changes what it is called
     * (`**` Bold, `__` Strong, `*` Italic, `_` Emphasis — as the row's buttons are named);
     * `noun`, `subject` and `label` otherwise.
     */
    markups?: Readonly<Record<string, HolderNames>>;
    /** `text` written as this element with `literal` after it (`markup` its delimiter, where it has a choice): what the menu's syntax column and card show. */
    example: (text: string, literal: string, markup?: string) => string;
    /** The element the engine renders it as (`markup` its delimiter); none for an image, which has no text to show, nor a note (its card is drawn apart). */
    tag?: (markup?: string) => string;
}

/** What a holder is called: in a reason, at the start of a refusal, and on its bar, the menu and a field. */
export interface HolderNames {
    noun: string;
    subject: string;
    label: string;
}

/** What `holder` written with `markup` (a mark's `markup` attribute, a token's) is called (`markups`). */
export function namesOf(holder: InlineLiteralHolder, markup?: unknown): HolderNames {
    return (typeof markup === 'string' ? holder.markups?.[markup] : undefined) ?? holder;
}

/**
 * Every holder, in the order "the holder at the caret" is looked for
 * (`objects.ts`): a link, a span, then the styled ones innermost first —
 * by schema rank, the mark drawn inside the others first — an image, and the
 * notes and sidebars last: a note holds every mark, so a mark inside it wins.
 */
export const INLINE_LITERAL_HOLDERS: readonly InlineLiteralHolder[] = [
    {
        holder: 'link', carrier: { mark: 'link' }, token: 'link_open', closing: ')>]', source: l => `[x](u)${l}`,
        own: ['href', 'title'], noun: 'link', subject: 'A link', label: 'Link', styled: false,
        example: (t, l) => `[${t}](u)${l}`, tag: () => 'a',
    },
    {
        holder: 'span', carrier: { mark: 'attr_span' }, token: 'span_open', closing: ']', source: l => `[x]${l}`,
        own: [], noun: 'attribute span', subject: 'An attribute span', label: 'Span', styled: false,
        example: (t, l) => `[${t}]${l}`, tag: () => 'span',
    },
    {
        // A nesting-0 token: the plugin gives the `{…}` after the closing backtick run to the code itself.
        holder: 'code', carrier: { mark: 'code' }, token: 'code_inline', closing: 'markup', source: l => `\`x\`${l}`,
        own: [], noun: 'inline code', subject: 'Inline code', label: 'Code', styled: true,
        example: (t, l) => `\`${t}\`${l}`, tag: () => 'code',
    },
    {
        holder: 'sub', carrier: { mark: 'sub' }, token: 'sub_open', closing: 'markup', source: l => `~x~${l}`,
        own: [], noun: 'subscript', subject: 'Subscript', label: 'Subscript', styled: true,
        example: (t, l) => `~${t}~${l}`, tag: () => 'sub',
    },
    {
        holder: 'sup', carrier: { mark: 'sup' }, token: 'sup_open', closing: 'markup', source: l => `^x^${l}`,
        own: [], noun: 'superscript', subject: 'Superscript', label: 'Superscript', styled: true,
        example: (t, l) => `^${t}^${l}`, tag: () => 'sup',
    },
    {
        holder: 'kbd', carrier: { mark: 'kbd' }, token: 'kbd_open', closing: ']', source: l => `[[x]]${l}`,
        own: [], noun: 'key', subject: 'A key', label: 'Key', styled: true,
        example: (t, l) => `[[${t}]]${l}`, tag: () => 'kbd',
    },
    {
        holder: 'mark', carrier: { mark: 'mark' }, token: 'mark_open', closing: 'markup', source: l => `==x==${l}`,
        own: [], noun: 'highlight', subject: 'A highlight', label: 'Highlight', styled: true,
        example: (t, l) => `==${t}==${l}`, tag: () => 'mark',
    },
    {
        holder: 'strike', carrier: { mark: 'strike' }, token: 's_open', closing: 'markup', source: l => `~~x~~${l}`,
        own: [], noun: 'strikethrough', subject: 'Strikethrough', label: 'Strikethrough', styled: true,
        example: (t, l) => `~~${t}~~${l}`, tag: () => 's',
    },
    {
        holder: 'strong', carrier: { mark: 'strong' }, token: 'strong_open', closing: 'markup', source: l => `**x**${l}`,
        own: [], noun: 'strong emphasis', subject: 'Strong emphasis', label: 'Strong', styled: true,
        example: (t, l, m = '**') => `${m}${t}${m}${l}`, tag: m => (m === '__' ? 'strong' : 'b'),
        markups: { '**': { noun: 'bold text', subject: 'Bold text', label: 'Bold' }, '__': { noun: 'strong emphasis', subject: 'Strong emphasis', label: 'Strong' } },
    },
    {
        holder: 'em', carrier: { mark: 'em' }, token: 'em_open', closing: 'markup', source: l => `*x*${l}`,
        own: [], noun: 'emphasis', subject: 'Emphasis', label: 'Emphasis', styled: true,
        example: (t, l, m = '*') => `${m}${t}${m}${l}`, tag: m => (m === '_' ? 'em' : 'i'),
        markups: { '*': { noun: 'italic text', subject: 'Italic text', label: 'Italic' }, '_': { noun: 'emphasis', subject: 'Emphasis', label: 'Emphasis' } },
    },
    {
        // A node, and a nesting-0 token: `![a](s)` and `![a][r]` close with `)` or `]`. Its
        // `src`, `alt` and `title` are written in its `(…)`; the renderer takes `alt` from the text.
        holder: 'image', carrier: { node: 'image' }, token: 'image', closing: ')]', source: l => `![x](u)${l}`,
        own: ['src', 'alt', 'title'], noun: 'image', subject: 'An image', label: 'Image', styled: false,
        example: (t, l) => `![${t}](u)${l}`,
    },
    // Nodes, whose closing token carries no markup: the literal follows the
    // marker's character. The `{…}` glued to it is the note's; after a space it is the block's.
    noteHolder('sidenote', NOTE_SYNTAX.sidenote.marker, true),
    noteHolder('marginal_note', NOTE_SYNTAX.marginalNote.marker, true),
    noteHolder('left_sidebar', NOTE_SYNTAX.leftSidebar.marker, false),
    noteHolder('right_sidebar', NOTE_SYNTAX.rightSidebar.marker, false),
];

/** A note's or a sidebar's entry: `marker` written around it, a reference and a body for a note, one body for a sidebar. */
function noteHolder(node: keyof typeof NOTE_NAMES, marker: string, note: boolean): InlineLiteralHolder {
    const label = NOTE_NAMES[node];
    const noun = label.toLowerCase();
    const written = (text: string) => `${marker}${note ? `${text}|note` : text}${marker}`;
    return {
        holder: node, carrier: { node }, token: `${node}_open`, closing: marker.charAt(0),
        source: l => `x ${marker}${note ? 'x|y' : 'y'}${marker}${l}`,
        own: [], noun, subject: `A ${noun}`, label, styled: false,
        example: (t, l) => `${written(t)}${l}`,
    };
}

/** The name of what carries the holder's literal: its mark's or its node's. */
export function carrierName(holder: InlineLiteralHolder): string {
    return 'mark' in holder.carrier ? holder.carrier.mark : holder.carrier.node;
}

const BY_TOKEN = new Map(INLINE_LITERAL_HOLDERS.map(h => [h.token, h]));
const BY_CARRIER = new Map(INLINE_LITERAL_HOLDERS.map(h => [carrierName(h), h]));
const BY_NAME = new Map(INLINE_LITERAL_HOLDERS.map(h => [h.holder, h]));

/** The holder whose literal markdown-it-attrs gives to a token of `type`, if any. */
export function holderOfToken(type: string): InlineLiteralHolder | undefined {
    return BY_TOKEN.get(type);
}

/** The holder whose literal a mark or a node named `name` carries, if any. */
export function holderOfCarrier(name: string): InlineLiteralHolder | undefined {
    return BY_CARRIER.get(name);
}

/** The holder by its key (`em`, `span`, `code` …), if any. */
export function holderNamed(holder: string): InlineLiteralHolder | undefined {
    return BY_NAME.get(holder);
}
