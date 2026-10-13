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
 * No ProseMirror and no DOM here, so every module can read it.
 * `attrs.test.ts` holds each entry to the engine: the literal written after
 * its `source` is given to its `token`, and the cut is right after it.
 */

export interface InlineLiteralHolder {
    /** The holder's key, what `attrsReadAt` and a `LiteralPlace` know it by: `span`, `em`, `link`, `code`, `image` … */
    holder: string;
    /** What carries `literal` in the schema: a mark, or the node for an image. */
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
}

/**
 * Every holder, in the order "the holder at the caret" is looked for
 * (`objects.ts`): a link, a span, then the styled ones innermost first —
 * by schema rank, the mark drawn inside the others first — and an image last.
 */
export const INLINE_LITERAL_HOLDERS: readonly InlineLiteralHolder[] = [
    {
        holder: 'link', carrier: { mark: 'link' }, token: 'link_open', closing: ')>]', source: l => `[x](u)${l}`,
        own: ['href', 'title'], noun: 'link', subject: 'A link', label: 'Link', styled: false,
    },
    {
        holder: 'span', carrier: { mark: 'attr_span' }, token: 'span_open', closing: ']', source: l => `[x]${l}`,
        own: [], noun: 'attribute span', subject: 'An attribute span', label: 'Span', styled: false,
    },
    {
        // A nesting-0 token: the plugin gives the `{…}` after the closing backtick run to the code itself.
        holder: 'code', carrier: { mark: 'code' }, token: 'code_inline', closing: 'markup', source: l => `\`x\`${l}`,
        own: [], noun: 'inline code', subject: 'Inline code', label: 'Code', styled: true,
    },
    {
        holder: 'sub', carrier: { mark: 'sub' }, token: 'sub_open', closing: 'markup', source: l => `~x~${l}`,
        own: [], noun: 'subscript', subject: 'Subscript', label: 'Subscript', styled: true,
    },
    {
        holder: 'sup', carrier: { mark: 'sup' }, token: 'sup_open', closing: 'markup', source: l => `^x^${l}`,
        own: [], noun: 'superscript', subject: 'Superscript', label: 'Superscript', styled: true,
    },
    {
        holder: 'kbd', carrier: { mark: 'kbd' }, token: 'kbd_open', closing: ']', source: l => `[[x]]${l}`,
        own: [], noun: 'key', subject: 'A key', label: 'Key', styled: true,
    },
    {
        holder: 'mark', carrier: { mark: 'mark' }, token: 'mark_open', closing: 'markup', source: l => `==x==${l}`,
        own: [], noun: 'highlight', subject: 'A highlight', label: 'Highlight', styled: true,
    },
    {
        holder: 'strike', carrier: { mark: 'strike' }, token: 's_open', closing: 'markup', source: l => `~~x~~${l}`,
        own: [], noun: 'strikethrough', subject: 'Strikethrough', label: 'Strikethrough', styled: true,
    },
    {
        holder: 'strong', carrier: { mark: 'strong' }, token: 'strong_open', closing: 'markup', source: l => `**x**${l}`,
        own: [], noun: 'strong emphasis', subject: 'Strong emphasis', label: 'Strong', styled: true,
    },
    {
        holder: 'em', carrier: { mark: 'em' }, token: 'em_open', closing: 'markup', source: l => `*x*${l}`,
        own: [], noun: 'emphasis', subject: 'Emphasis', label: 'Emphasis', styled: true,
    },
    {
        // A node, and a nesting-0 token: `![a](s)` and `![a][r]` close with `)` or `]`. Its
        // `src`, `alt` and `title` are written in its `(…)`; the renderer takes `alt` from the text.
        holder: 'image', carrier: { node: 'image' }, token: 'image', closing: ')]', source: l => `![x](u)${l}`,
        own: ['src', 'alt', 'title'], noun: 'image', subject: 'An image', label: 'Image', styled: false,
    },
];

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
