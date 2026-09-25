import { DOMOutputSpec, DOMParser, Fragment, Mark, Node, NodeSpec, Schema } from 'prosemirror-model';
import { ADMONITION_TYPES, NOTE_SYNTAX } from '../syntax/markers';
import { domAttrsOf } from './attrs';

/**
 * The rich editor's document model, shared by the extension host (which parses
 * and serializes) and the webview (which edits), so it must not need a DOM to
 * load.
 *
 * Two families of top-level node:
 *
 * - **Editable** (`paragraph`, `heading`, the lists, `blockquote`, `code_block`,
 *   `horizontal_rule`, `container`, `admonition`): the editable core. Each top-level one carries
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
 *
 * Inline, a textblock holds text under the marks at the end of this file —
 * CommonMark's and this extension's own (`==`, `^`, `~`, `~~`, `[[…]]`), and an
 * attribute span (`[text]{…}`) — images, hard breaks, Req Explorer's badges,
 * and the note family (sidenotes, marginal notes, sidebars), each drawn as the
 * element the engine renders.
 *
 * Two editable nodes hold blocks of their own and mirror their plugin's DOM:
 * `container` (`::: name info` … `:::`, a `div` with the info's classes) and
 * `admonition` (`!!! type "Title"`, `div.admonition.<type>`, its title drawn by
 * the page as the plugin's `p.admonition-title`, see `admonitionTitleSpec`).
 *
 * A `{…}` attribute literal is kept verbatim wherever the editor edits it — the
 * span mark's `literal`, a top-level block's `attrsSuffix` — and the element is
 * drawn with the attributes the literal gives (`domAttrsOf`), so the page's
 * stylesheets style it as they style the preview.
 */

/** The top-level editable node types, whose `src` the fidelity plugin clears on change. */
export const EDITABLE_TOP_NODES: ReadonlySet<string> = new Set([
    'paragraph', 'heading', 'bullet_list', 'ordered_list', 'blockquote', 'code_block', 'horizontal_rule',
    'container', 'admonition',
]);

/** The nodes that hold blocks and are written around them: a container and an admonition. */
export const WRAPPER_NODES: ReadonlySet<string> = new Set(['container', 'admonition']);

/** The nodes that carry a block attribute literal (`attrsSuffix`); a heading carries one too, with its anchor. */
export const SUFFIX_NODES: ReadonlySet<string> = new Set(['paragraph', 'heading', 'bullet_list', 'ordered_list', 'code_block', 'horizontal_rule']);

/**
 * A top-level block's `{…}` literal, verbatim, and where it stood
 * (`AttrsPlacement` in `blocks.ts`: `end`, `line`, `blank`). Both `null` on a
 * block that has none; a nested block never carries one (`fidelity.ts`).
 */
const suffixAttrs = {
    attrsSuffix: { default: null as string | null },
    attrsPlacement: { default: null as string | null },
};

/** The attributes the block's literal gives, merged under the ones the node draws itself. */
function withSuffix(node: Node, own: Record<string, string | null> = {}): Record<string, string | null> {
    return { ...domAttrsOf(node.attrs.attrsSuffix as string | null), ...own };
}

/** The class a container is drawn with: `markdownItContainer.ts` puts the whole info, trimmed, in its `class`. */
export function containerClass(name: string, info: string): string {
    return `${name}${info}`.trim();
}

/**
 * An admonition's title bar as `markdownItAdmonition.ts` renders it:
 * `p.admonition-title`, the first child of `div.admonition`. A content hole
 * must be the only child of its element, so the schema cannot draw it beside
 * the body; the page puts it there as a widget (`webview/wrappers.ts`) and a
 * test puts it there the same way when comparing with the engine.
 */
export function admonitionTitleSpec(title: string): DOMOutputSpec {
    return ['p', { class: 'admonition-title', contenteditable: 'false', 'data-mep-admonition-title': '' }, title];
}

/** The type an admonition's classes name: the first known one, else `note`, as the plugin decides. */
function admonitionTypeOf(dom: HTMLElement): string {
    return Array.from(dom.classList).find(c => c !== 'admonition' && ADMONITION_TYPES.includes(c)) ?? 'note';
}

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
    // Everything the suffix gives (`{#id .unnumbered}`), the anchor as the id.
    const attrs: Record<string, string> = domAttrsOf(node.attrs.attrsSuffix as string | null);
    if (anchor) {
        attrs.id = anchor;
    }
    if (prefix) {
        // The requirement id is read-only (the anchor migration owns it), so it
        // sits outside the content hole where no keystroke reaches it.
        return ['h' + level, attrs,
            ['span', { class: 'mep-req-prefix', contenteditable: 'false' }, prefix],
            ['span', { class: 'mep-heading-text' }, 0]];
    }
    return ['h' + level, attrs, 0];
}

/**
 * The element each emphasis delimiter renders as in the preview. `markdown-it-ib`,
 * in this extension's registry, turns `*` into `<i>` and `**` into `<b>`; `_` and
 * `__` keep CommonMark's `<em>` and `<strong>`. A stylesheet can style the four
 * apart, so the editor draws each as the preview does — drawing all of them as
 * `<em>`/`<strong>` showed `*x*` differently from the preview. The engine is the
 * authority; `test/unit/editor/emphasis.test.ts` holds this table to it.
 */
export const EMPHASIS_TAGS: Readonly<Record<string, string>> = { '*': 'i', '_': 'em', '**': 'b', '__': 'strong' };

function emphasisDOM(mark: Mark): DOMOutputSpec {
    return [EMPHASIS_TAGS[mark.attrs.markup as string] ?? (mark.type.name === 'em' ? 'i' : 'b')];
}

/** Each delimiter's element read back as that delimiter, so a copied `<em>` pastes as `_`, not `*`. */
function emphasisParseRules(markups: readonly string[]): { tag: string; attrs: { markup: string } }[] {
    return markups.map(markup => ({ tag: EMPHASIS_TAGS[markup], attrs: { markup } }));
}

// ---------------------------------------------------------------------------
// The note family: sidenotes, marginal notes, sidebars
// ---------------------------------------------------------------------------

/*
 * `markdownItSidenote.ts` renders a note as its reference with the note nested
 * inside it — `<span class="sn-ref">reference<span class="sidenote">note</span></span>`
 * — and a sidebar as one span. The editor draws exactly that DOM, so every
 * stylesheet written for the preview (the margin layout, a reader's own
 * `.sidenote` rules) applies to the note being edited, unchanged:
 *
 * - `sidenote` is the `span.sn-ref`, holding two inline nodes: `note_ref`, the
 *   reference, and `sidenote_body`, the `span.sidenote`. The plugin emits no
 *   element for the reference; ProseMirror needs one to hold its content, so
 *   it is a span with no class (only `data-mep-note-ref`, which no stylesheet
 *   of the preview names) and the reference's text sits where the plugin puts
 *   it — first inside the `.sn-ref`, before the note.
 * - `marginal_note` likewise: `span.mn-ref` > `note_ref` + `marginal_note_body`
 *   (`span.mnote`). The two bodies are two types because their class is part
 *   of what they are; the reference is drawn the same in both and is one type.
 * - `left_sidebar` and `right_sidebar` are one span each with the content in it.
 *
 * What a note may hold is the plugin's answer. It parses a reference and a
 * body with the full inline parser, so every mark may be inside. It cannot
 * hold a note of its own kind — the first closing marker ends the outer one —
 * but it can hold one of another kind (`++a|see !!b|c!!++`), and a sidebar the
 * other sidebar. The editor keeps the family out of note content altogether
 * (`note_inline` has no note in it): one level is what the corpus writes, and
 * a content expression cannot say "any note but my own kind, at any depth".
 * A paragraph whose file nests notes stays a source block (`blocks.ts`).
 */

/** The note and sidebar nodes, the ones the toolbar wraps a selection in. */
export const NOTE_NODES: ReadonlySet<string> = new Set(['sidenote', 'marginal_note', 'left_sidebar', 'right_sidebar']);

/** The nodes that hold a note's text: a reference, a body, or a sidebar (which is its own body). */
export const NOTE_PART_NODES: ReadonlySet<string> = new Set(['note_ref', 'sidenote_body', 'marginal_note_body', 'left_sidebar', 'right_sidebar']);

const NOTE_REF_ATTR = 'data-mep-note-ref';

/** Where a link's own title is kept in the editor's DOM, its `title` showing the href instead. */
const LINK_TITLE_ATTR = 'data-mep-title';

/**
 * A pasted note (the preview's HTML, or the editor's own copy): its `.sidenote`
 * or `.mnote` child is the body, everything else the reference — unwrapped
 * from the editor's own reference span when the copy came from here.
 */
function noteContent(bodyType: string, bodyClass: string) {
    return (dom: globalThis.Node, schema: Schema): Fragment => {
        const element = dom as HTMLElement;
        const doc = element.ownerDocument;
        const refHolder = doc.createElement('span');
        const bodyHolder = doc.createElement('span');
        for (const child of Array.from(element.childNodes)) {
            const el = child.nodeType === 1 ? child as HTMLElement : null;
            if (el?.classList.contains(bodyClass)) {
                bodyHolder.append(...Array.from(el.cloneNode(true).childNodes));
            } else if (el?.hasAttribute(NOTE_REF_ATTR)) {
                refHolder.append(...Array.from(el.cloneNode(true).childNodes));
            } else {
                refHolder.append(child.cloneNode(true));
            }
        }
        const parser = DOMParser.fromSchema(schema);
        return Fragment.from([
            parser.parse(refHolder, { topNode: schema.nodes.note_ref.create() }),
            parser.parse(bodyHolder, { topNode: schema.nodes[bodyType].create() }),
        ]);
    };
}

/** Inline nodes that hold inline content and must not be crossed by joining or lifting. */
function notePart(className: string | null, extra: Partial<NodeSpec> = {}): NodeSpec {
    return {
        inline: true,
        content: 'note_inline*',
        isolating: true,
        ...extra,
        toDOM(): DOMOutputSpec {
            return ['span', className === null ? { [NOTE_REF_ATTR]: '' } : { class: className }, 0];
        },
    };
}

function noteNode(refClass: string, bodyType: string, bodyClass: string): NodeSpec {
    return {
        inline: true,
        group: 'inline',
        content: `note_ref ${bodyType}`,
        isolating: true,
        parseDOM: [{ tag: `span.${refClass}`, getContent: noteContent(bodyType, bodyClass) }],
        toDOM(): DOMOutputSpec { return ['span', { class: refClass }, 0]; },
    };
}

const SN = NOTE_SYNTAX.sidenote;
const MN = NOTE_SYNTAX.marginalNote;
const LS = NOTE_SYNTAX.leftSidebar;
const RS = NOTE_SYNTAX.rightSidebar;

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
                ...suffixAttrs,
            },
            // An admonition's title bar is its node's attribute, never a paragraph of its body.
            parseDOM: [{ tag: 'p.admonition-title', ignore: true }, { tag: 'p' }],
            toDOM(node): DOMOutputSpec { return ['p', withSuffix(node), 0]; },
        },
        heading: {
            // A note is written inside the heading's one line; a hard break is not.
            content: '(text | image | inline_atom | sidenote | marginal_note | left_sidebar | right_sidebar)*',
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
        container: {
            content: 'block+',
            group: 'block',
            defining: true,
            attrs: {
                ...sourceAttrs,
                /** The first word of the opening line's info: `warning` in `::: warning big`. */
                name: { default: '' },
                /** The rest of the info after the name, verbatim (` big`, its leading space included). */
                info: { default: '' },
                /** The fence as written, `:::` or longer; the serializer lengthens it around a nested one. */
                markup: { default: ':::' },
            },
            parseDOM: [{
                tag: 'div[data-mep-container]',
                getAttrs: (dom: HTMLElement) => ({ name: dom.getAttribute('data-mep-container') ?? '', info: dom.getAttribute('data-mep-info') ?? '' }),
            }],
            toDOM(node): DOMOutputSpec {
                const name = node.attrs.name as string;
                const info = node.attrs.info as string;
                return ['div', { class: containerClass(name, info), 'data-mep-container': name, 'data-mep-info': info }, 0];
            },
        },
        admonition: {
            content: 'block+',
            group: 'block',
            defining: true,
            attrs: {
                ...sourceAttrs,
                /** One of `ADMONITION_TYPES`: the second class of `div.admonition`. */
                type: { default: 'note' },
                /** The title bar's text, as written between the quotes; `''` for none (no title bar). */
                title: { default: '' },
                /** The marker as written, `!!!` or longer. */
                markup: { default: '!!!' },
                /**
                 * The opening line as written, while type and title are what it says:
                 * a changed body keeps `!!! note Some title` instead of rewriting it
                 * as `!!! note "Some title"`. The verbs that change either clear it.
                 */
                header: { default: null as string | null },
            },
            parseDOM: [{
                tag: 'div.admonition',
                getAttrs: (dom: HTMLElement) => ({
                    type: admonitionTypeOf(dom),
                    title: dom.getAttribute('data-mep-title') ?? dom.querySelector(':scope > .admonition-title')?.textContent?.trim() ?? '',
                }),
            }],
            toDOM(node): DOMOutputSpec {
                return ['div', { class: `admonition ${node.attrs.type as string}`, 'data-mep-title': node.attrs.title as string }, 0];
            },
        },
        bullet_list: {
            content: 'list_item+',
            group: 'block',
            attrs: {
                ...sourceAttrs,
                /** The bullet character the list was written with. */
                bullet: { default: '-' },
                tight: { default: false },
                ...suffixAttrs,
            },
            parseDOM: [{ tag: 'ul', getAttrs: (dom: HTMLElement) => ({ tight: dom.hasAttribute('data-tight') }) }],
            toDOM(node): DOMOutputSpec { return ['ul', withSuffix(node, { 'data-tight': node.attrs.tight ? 'true' : null }), 0]; },
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
                ...suffixAttrs,
            },
            parseDOM: [{
                tag: 'ol',
                getAttrs: (dom: HTMLElement) => ({
                    order: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) : 1,
                    tight: dom.hasAttribute('data-tight'),
                }),
            }],
            toDOM(node): DOMOutputSpec {
                return ['ol', withSuffix(node, {
                    start: node.attrs.order === 1 ? null : String(node.attrs.order),
                    'data-tight': node.attrs.tight ? 'true' : null,
                }), 0];
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
                ...suffixAttrs,
            },
            parseDOM: [{
                tag: 'pre',
                preserveWhitespace: 'full' as const,
                getAttrs: (dom: HTMLElement) => ({ params: dom.getAttribute('data-params') || '' }),
            }],
            toDOM(node): DOMOutputSpec {
                // The fence's attributes are on its `<code>`, as the engine renders them.
                return ['pre', node.attrs.params ? { 'data-params': node.attrs.params as string } : {}, ['code', withSuffix(node), 0]];
            },
        },
        horizontal_rule: {
            group: 'block',
            attrs: {
                ...sourceAttrs,
                /** The rule as markdown-it normalized it (`---`, `***`, `___`), without an attribute suffix. */
                markup: { default: '---' },
                ...suffixAttrs,
            },
            parseDOM: [{ tag: 'hr' }],
            toDOM(node): DOMOutputSpec { return ['div', ['hr', withSuffix(node)]]; },
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
            group: 'inline note_inline',
        },
        image: {
            inline: true,
            group: 'inline note_inline',
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
            group: 'inline note_inline',
            selectable: false,
            parseDOM: [{ tag: 'br' }],
            toDOM(): DOMOutputSpec { return ['br']; },
        },
        inline_atom: {
            inline: true,
            group: 'inline note_inline',
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
        sidenote: noteNode(SN.refClass, 'sidenote_body', SN.noteClass),
        marginal_note: noteNode(MN.refClass, 'marginal_note_body', MN.noteClass),
        note_ref: notePart(null),
        sidenote_body: notePart(SN.noteClass),
        marginal_note_body: notePart(MN.noteClass),
        left_sidebar: notePart(LS.cssClass, { group: 'inline', parseDOM: [{ tag: `span.${LS.cssClass}` }] }),
        right_sidebar: notePart(RS.cssClass, { group: 'inline', parseDOM: [{ tag: `span.${RS.cssClass}` }] }),
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
        // `[text]{…}` (markdown-it-bracketed-spans with markdown-it-attrs): a
        // `<span>` with exactly the attributes the engine renders from the
        // literal, which is kept verbatim and written back as it was. Outside
        // the other marks, as its brackets are around them; not inclusive, so
        // typing after a span is prose.
        attr_span: {
            inclusive: false,
            attrs: {
                /** The `{…}` as written (`{.a}`, `{class="a b"}`, `{#x .a style="color:red"}`). */
                literal: {},
            },
            parseDOM: [{ tag: 'span[data-mep-attrs]', getAttrs: (dom: HTMLElement) => ({ literal: dom.getAttribute('data-mep-attrs') }) }],
            toDOM(mark: Mark): DOMOutputSpec {
                const literal = mark.attrs.literal as string;
                return ['span', { ...domAttrsOf(literal), 'data-mep-attrs': literal }, 0];
            },
        },
        em: {
            attrs: {
                /** `*` or `_`, as written. `markdown-it-ib` renders `*` as `<i>` and `_` as `<em>`, so the choice is visible. */
                markup: { default: '*' },
            },
            parseDOM: emphasisParseRules(['*', '_']),
            toDOM: emphasisDOM,
        },
        strong: {
            attrs: {
                /** `**` or `__`, as written; `markdown-it-ib` renders them as `<b>` and `<strong>`. */
                markup: { default: '**' },
            },
            parseDOM: emphasisParseRules(['**', '__']),
            toDOM: emphasisDOM,
        },
        // `~~x~~` and `==x==` are delimiter runs like emphasis: any mark may be
        // inside them, and they may span a line break.
        strike: {
            parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }],
            toDOM(): DOMOutputSpec { return ['s']; },
        },
        mark: {
            parseDOM: [{ tag: 'mark' }],
            toDOM(): DOMOutputSpec { return ['mark']; },
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
                // The editor's own `title` shows the href (see `toDOM`); the
                // link's title, if it has one, travels in `data-mep-title`.
                getAttrs: (dom: HTMLElement) => ({
                    href: dom.getAttribute('href'),
                    title: dom.hasAttribute(LINK_TITLE_ATTR) ? dom.getAttribute(LINK_TITLE_ATTR) || null : dom.getAttribute('title'),
                }),
            }],
            toDOM(mark: Mark): DOMOutputSpec {
                const href = mark.attrs.href as string;
                const title = mark.attrs.title as string | null;
                // Hovering says where a Ctrl+click goes (README, "Links").
                return ['a', { href, title: title ? `${title}\n${href}` : href, [LINK_TITLE_ATTR]: title ?? '' }];
            },
        },
        // Inside a link, not around one: `[[[x]]](url)` is a link holding a
        // key, while a key holding a link does not parse. No line break inside.
        kbd: {
            parseDOM: [{ tag: 'kbd' }],
            toDOM(): DOMOutputSpec { return ['kbd']; },
        },
        // `markdown-it-sup-alt` and `-sub-alt` read their content as plain text,
        // so they sit innermost but for code, and exclude code and each other:
        // `^`x`^` is the text `` `x` `` raised, not code.
        sup: {
            excludes: 'sup sub code',
            parseDOM: [{ tag: 'sup' }],
            toDOM(): DOMOutputSpec { return ['sup']; },
        },
        sub: {
            excludes: 'sub sup code',
            parseDOM: [{ tag: 'sub' }],
            toDOM(): DOMOutputSpec { return ['sub']; },
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
