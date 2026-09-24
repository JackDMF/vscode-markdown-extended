import { DOMOutputSpec, Mark, Node, Schema } from 'prosemirror-model';

/**
 * The rich editor's document model, shared by the extension host (which parses
 * and serializes) and the webview (which edits), so it must not need a DOM to
 * load.
 *
 * Two families of top-level node:
 *
 * - **Editable** (`paragraph`, `heading`, the lists, `blockquote`, `code_block`,
 *   `horizontal_rule`): the stage-1 editable core. Each top-level one carries
 *   `src`, the exact slice of the file it was parsed from, and `gap`, the text
 *   between the previous block and itself. `src` stays set while the node is
 *   untouched and the serializer emits it verbatim; `fidelityPlugin` clears it
 *   when the node changes, and the serializer then writes the node by rule. A
 *   node inserted by the UI has `src: null` and `gap: null`. Nested nodes carry
 *   `null` in both: fidelity is a property of top-level blocks.
 * - **Source** (`front_matter`, `raw_block`, `injected_block`): atoms whose
 *   `src` is emitted unconditionally. Only the UI changes it, and only by setting
 *   the attribute explicitly.
 *
 * `toDOM` renders placeholders for the atoms: their HTML comes from the host
 * and is attached by a node view, not by the schema.
 */

/** The top-level editable node types, whose `src` the fidelity plugin clears on change. */
export const EDITABLE_TOP_NODES: ReadonlySet<string> = new Set([
    'paragraph', 'heading', 'bullet_list', 'ordered_list', 'blockquote', 'code_block', 'horizontal_rule',
]);

/** The top-level node types emitted from `src` whatever happens to them. */
export const SOURCE_NODES: ReadonlySet<string> = new Set(['front_matter', 'raw_block', 'injected_block']);

/** `src` and `gap`, on every node that can stand at top level. */
const sourceAttrs = {
    src: { default: null as string | null },
    gap: { default: null as string | null },
};

function headingDOM(node: Node): DOMOutputSpec {
    const level = node.attrs.level as number;
    const anchor = node.attrs.anchor as string | null;
    const prefix = node.attrs.reqPrefix as string | null;
    const attrs: Record<string, string> = anchor ? { id: anchor } : {};
    if (prefix) {
        // The requirement id is read-only (the anchor migration owns it), so it
        // sits outside the content hole where no keystroke reaches it.
        return ['h' + level, attrs,
            ['span', { class: 'mep-req-prefix', contenteditable: 'false' }, prefix],
            ['span', { class: 'mep-heading-text' }, 0]];
    }
    return ['h' + level, attrs, 0];
}

export const editorSchema = new Schema({
    nodes: {
        doc: {
            // No `block+`: a document holding only front matter must stay one,
            // and a filler paragraph would be written into the file.
            content: 'front_matter? (block | source)*',
        },
        // Listed first among block nodes so it is the one ProseMirror uses to fill.
        paragraph: {
            content: 'inline*',
            group: 'block',
            attrs: {
                ...sourceAttrs,
                /** The column a changed paragraph is wrapped at, read off its original lines (`measureWrapWidth`); `null` when they gave none. */
                wrapWidth: { default: null as number | null },
                /** For a paragraph that was one line: that line's width. Wrapped at the larger of it and the default (`measureLineWidth`). */
                lineWidth: { default: null as number | null },
            },
            parseDOM: [{ tag: 'p' }],
            toDOM(): DOMOutputSpec { return ['p', 0]; },
        },
        heading: {
            content: '(text | image | inline_atom)*',
            group: 'block',
            defining: true,
            attrs: {
                level: { default: 1 },
                ...sourceAttrs,
                /** A requirement heading's `ID: ` prefix, lifted out of the editable text and written back verbatim. */
                reqPrefix: { default: null as string | null },
                /** The `id` attribute `markdown-it-attrs` read from the suffix. */
                anchor: { default: null as string | null },
                /** The literal `{…}` suffix of the source line, written back verbatim after the text. */
                attrsSuffix: { default: null as string | null },
            },
            parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: 'h' + level, attrs: { level } })),
            toDOM: headingDOM,
        },
        blockquote: {
            content: 'block+',
            group: 'block',
            defining: true,
            attrs: { ...sourceAttrs },
            parseDOM: [{ tag: 'blockquote' }],
            toDOM(): DOMOutputSpec { return ['blockquote', 0]; },
        },
        bullet_list: {
            content: 'list_item+',
            group: 'block',
            attrs: {
                ...sourceAttrs,
                /** The bullet character the list was written with. */
                bullet: { default: '-' },
                tight: { default: false },
            },
            parseDOM: [{ tag: 'ul', getAttrs: (dom: HTMLElement) => ({ tight: dom.hasAttribute('data-tight') }) }],
            toDOM(node): DOMOutputSpec { return ['ul', { 'data-tight': node.attrs.tight ? 'true' : null }, 0]; },
        },
        ordered_list: {
            content: 'list_item+',
            group: 'block',
            attrs: {
                ...sourceAttrs,
                order: { default: 1 },
                /** `.` or `)`, as written. */
                delimiter: { default: '.' },
                tight: { default: false },
            },
            parseDOM: [{
                tag: 'ol',
                getAttrs: (dom: HTMLElement) => ({
                    order: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) : 1,
                    tight: dom.hasAttribute('data-tight'),
                }),
            }],
            toDOM(node): DOMOutputSpec {
                return ['ol', {
                    start: node.attrs.order === 1 ? null : String(node.attrs.order),
                    'data-tight': node.attrs.tight ? 'true' : null,
                }, 0];
            },
        },
        list_item: {
            content: 'block+',
            defining: true,
            parseDOM: [{ tag: 'li' }],
            toDOM(): DOMOutputSpec { return ['li', 0]; },
        },
        code_block: {
            content: 'text*',
            group: 'block',
            code: true,
            defining: true,
            marks: '',
            attrs: {
                ...sourceAttrs,
                /** The fence's info string. */
                params: { default: '' },
                /** The fence as written (```` ``` ````, `~~~~`, …), or `''` for an indented code block. */
                markup: { default: '```' },
            },
            parseDOM: [{
                tag: 'pre',
                preserveWhitespace: 'full' as const,
                getAttrs: (dom: HTMLElement) => ({ params: dom.getAttribute('data-params') || '' }),
            }],
            toDOM(node): DOMOutputSpec {
                return ['pre', node.attrs.params ? { 'data-params': node.attrs.params as string } : {}, ['code', 0]];
            },
        },
        horizontal_rule: {
            group: 'block',
            attrs: {
                ...sourceAttrs,
                /** The rule as markdown-it normalized it (`---`, `***`, `___`). */
                markup: { default: '---' },
            },
            parseDOM: [{ tag: 'hr' }],
            toDOM(): DOMOutputSpec { return ['div', ['hr']]; },
        },
        front_matter: {
            atom: true,
            selectable: true,
            attrs: { src: { default: '' } },
            toDOM(node): DOMOutputSpec {
                return ['pre', { class: 'mep-front-matter', 'data-mep-front-matter': '' }, node.attrs.src as string];
            },
        },
        raw_block: {
            group: 'source',
            atom: true,
            selectable: true,
            attrs: {
                src: { default: '' },
                gap: { default: null as string | null },
                /** The block rendered by the host's engine, for the node view to show. */
                html: { default: '' },
            },
            parseDOM: [{
                tag: 'div[data-mep-raw]',
                getAttrs: (dom: HTMLElement) => ({ src: dom.getAttribute('data-src') ?? '', gap: null, html: '' }),
            }],
            toDOM(node): DOMOutputSpec {
                return ['div', { class: 'mep-raw-block', 'data-mep-raw': '', 'data-src': node.attrs.src as string }];
            },
        },
        injected_block: {
            group: 'source',
            atom: true,
            selectable: true,
            attrs: {
                /** `atom`, `expansion` or `generated` (see `InjectedKind`). */
                kind: { default: 'atom' },
                /** Req Explorer's injection mark (`token.meta.reqExplorer`), or `null` for generated content. */
                mark: { default: null as unknown },
                html: { default: '' },
                /** An expansion's directive line; `null` for content that stands for no line and writes nothing. */
                src: { default: null as string | null },
                gap: { default: null as string | null },
            },
            parseDOM: [{
                tag: 'div[data-mep-injected]',
                getAttrs: (dom: HTMLElement) => {
                    const src = dom.getAttribute('data-src');
                    return { kind: dom.getAttribute('data-mep-injected') || 'atom', src: src === null ? null : src, gap: null };
                },
            }],
            toDOM(node): DOMOutputSpec {
                const attrs: Record<string, string> = {
                    class: 'mep-injected-block',
                    'data-mep-injected': node.attrs.kind as string,
                };
                if (node.attrs.src !== null) {
                    attrs['data-src'] = node.attrs.src as string;
                }
                return ['div', attrs];
            },
        },
        text: {
            group: 'inline',
        },
        image: {
            inline: true,
            group: 'inline',
            draggable: true,
            attrs: {
                src: {},
                alt: { default: null as string | null },
                title: { default: null as string | null },
            },
            parseDOM: [{
                tag: 'img[src]',
                getAttrs: (dom: HTMLElement) => ({
                    src: dom.getAttribute('src'),
                    title: dom.getAttribute('title'),
                    alt: dom.getAttribute('alt'),
                }),
            }],
            toDOM(node): DOMOutputSpec {
                const { src, alt, title } = node.attrs as { src: string; alt: string | null; title: string | null };
                return ['img', { src, alt, title }];
            },
        },
        hard_break: {
            inline: true,
            group: 'inline',
            selectable: false,
            parseDOM: [{ tag: 'br' }],
            toDOM(): DOMOutputSpec { return ['br']; },
        },
        inline_atom: {
            inline: true,
            group: 'inline',
            atom: true,
            selectable: true,
            attrs: {
                /** The injected inline HTML (the status badge), for the node view to show. */
                html: { default: '' },
                mark: { default: null as unknown },
            },
            toDOM(): DOMOutputSpec {
                return ['span', { class: 'mep-inline-atom', 'data-mep-inline-atom': '' }];
            },
        },
    },
    marks: {
        // Req Explorer's decoration: outermost, so it never splits the marks
        // written inside it, and not inclusive, so typing after an id is prose.
        req_ref: {
            inclusive: false,
            attrs: {
                /** The tooltip the injected wrapper carries. */
                title: { default: null as string | null },
                mark: { default: null as unknown },
            },
            toDOM(mark: Mark): DOMOutputSpec {
                const title = mark.attrs.title as string | null;
                return ['span', title ? { class: 'req-ref', title } : { class: 'req-ref' }, ['code', 0]];
            },
        },
        em: {
            attrs: {
                /** `*` or `_`, as written. `markdown-it-ib` renders `*` as `<i>` and `_` as `<em>`, so the choice is visible. */
                markup: { default: '*' },
            },
            parseDOM: [{ tag: 'i' }, { tag: 'em' }],
            toDOM(): DOMOutputSpec { return ['em']; },
        },
        strong: {
            attrs: {
                /** `**` or `__`, as written; `markdown-it-ib` renders them as `<b>` and `<strong>`. */
                markup: { default: '**' },
            },
            parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
            toDOM(): DOMOutputSpec { return ['strong']; },
        },
        link: {
            inclusive: false,
            attrs: {
                href: {},
                title: { default: null as string | null },
                /** `linkify` for a bare URL, `autolink` for `<…>`, `null` for `[text](href)`. */
                markup: { default: null as string | null },
            },
            parseDOM: [{
                tag: 'a[href]',
                getAttrs: (dom: HTMLElement) => ({ href: dom.getAttribute('href'), title: dom.getAttribute('title') }),
            }],
            toDOM(mark: Mark): DOMOutputSpec {
                return ['a', { href: mark.attrs.href as string, title: mark.attrs.title as string | null }];
            },
        },
        // Last, so it is the innermost mark: the serializer writes code spans unescaped.
        code: {
            code: true,
            parseDOM: [{ tag: 'code' }],
            toDOM(): DOMOutputSpec { return ['code']; },
        },
    },
});

export type EditorSchema = typeof editorSchema;
