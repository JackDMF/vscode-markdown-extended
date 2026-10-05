// prosemirror-markdown brings its own markdown-it 14 for its *default* parser,
// which this module never uses: the tokens come from the editor engine, handed
// to MarkdownParser through the tokenizer wrapper below.
import { MarkdownParser } from 'prosemirror-markdown';
import { Attrs, Node } from 'prosemirror-model';
import { Environment, MarkdownIt, Options, Token } from '../@types/markdown-it';
import {
    BlockAttrs,
    InjectionMark,
    NOTE_OPEN_TOKENS,
    SourceBlock,
    detectEol,
    groupSourceBlocks,
    headingLiteral,
    injectionMarkOf,
    splitLines,
} from './blocks';
import { InlineEngineDefinition, definitionOf } from './inlineEngine';
import { NOTE_NODES, alignOfStyle, editorSchema } from './schema';
import { endLiteralOf } from './attrs';
import { withoutTextBraceEnd } from '../syntax/attrsLiteral';
import { tokenText } from '../syntax/tokenText';
import { measureLineWidth, measureWrapWidth } from './wrap';

/**
 * A document as the editor holds it: the ProseMirror tree plus the two facts
 * about the file that no node carries.
 */
export interface ParsedDocument {
    doc: Node;
    /** The line ending a changed block is written with. */
    eol: '\n' | '\r\n';
    /** The text after the last block (blank lines, the final newline), written back verbatim. */
    tail: string;
}

/** `ParsedDocument` as it crosses to the webview: the tree as ProseMirror JSON. */
export interface ParsedDocumentJSON {
    doc: Record<string, unknown>;
    eol: '\n' | '\r\n';
    tail: string;
}

export function parsedDocumentToJSON(parsed: ParsedDocument): ParsedDocumentJSON {
    return { doc: parsed.doc.toJSON() as Record<string, unknown>, eol: parsed.eol, tail: parsed.tail };
}

export function parsedDocumentFromJSON(json: ParsedDocumentJSON): ParsedDocument {
    return { doc: Node.fromJSON(editorSchema, json.doc), eol: json.eol, tail: json.tail };
}

/**
 * The source lines `[start, end)` each top-level block of `text` stands for,
 * in document order, `null` for a block that stands for none (generated
 * content): entry `i` is the document's child `i`, because `parseDocument`
 * builds its children from the same grouping and refuses a document whose
 * counts disagree. What the lens rows are placed by (`host/lenses.ts`).
 * `definition` as `parseDocument` takes it, so the two group alike.
 */
export function blockLineRanges(md: MarkdownIt, text: string, env: Environment = {}, definition: InlineEngineDefinition = definitionOf(md)): ([number, number] | null)[] {
    return groupSourceBlocks(md.parse(text, env), splitLines(text), definition).blocks.map(b => b.lineRange);
}

/**
 * What MarkdownParser reads of a token. The real markdown-it tokens satisfy it;
 * the synthetic ones this module makes for raw, injected and pre-processed
 * content are plain objects that carry their node attributes in `pmAttrs`.
 */
interface StreamToken {
    type: string;
    content: string;
    children: StreamToken[] | null;
    pmAttrs?: Attrs;
}

type EngineWithOptions = MarkdownIt & { options: Options };

function synthetic(type: string, pmAttrs: Attrs): StreamToken {
    return { type, content: '', children: null, pmAttrs };
}

function attr(token: Token, name: string): string | null {
    const found = token.attrs?.find(([n]) => n === name);
    return found === undefined ? null : String(found[1]);
}

function decodeAttribute(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/** markdown-it marks the paragraphs of a tight list hidden; the first one of the list's own items answers for it. */
function listIsTight(stream: readonly StreamToken[], index: number): boolean {
    const open = stream[index] as unknown as Token;
    for (let i = index + 1; i < stream.length; i++) {
        const t = stream[i] as unknown as Token;
        if (t.level === open.level + 2 && t.type === 'paragraph_open') {
            return t.hidden;
        }
        if (t.level === open.level && t.nesting === -1) {
            break;
        }
    }
    return false;
}

/**
 * Rewrite an editable block's inline children into the stream MarkdownParser
 * understands: Req Explorer's decoration wrapper becomes a `req_ref` mark around
 * the authored text it wraps (the wrapper itself is never content), and an
 * injected atom becomes one `inline_atom` carrying its rendered HTML.
 */
function preprocessInline(md: EngineWithOptions, env: Environment, children: readonly Token[]): StreamToken[] {
    const out: StreamToken[] = [];
    let inRef = false;
    for (const child of children) {
        const mark = injectionMarkOf(child);
        if (mark?.kind === 'decoration') {
            if (!inRef) {
                const title = /\btitle="([^"]*)"/.exec(child.content);
                out.push(synthetic('req_ref_open', { title: title ? decodeAttribute(title[1]) : null, mark }));
            } else {
                out.push(synthetic('req_ref_close', {}));
            }
            inRef = !inRef;
            continue;
        }
        if (mark !== undefined) {
            out.push(synthetic('inline_atom', { html: md.renderer.renderInline([child], md.options, env), mark }));
            continue;
        }
        out.push(child as unknown as StreamToken);
    }
    if (inRef) {
        out.push(synthetic('req_ref_close', {}));
    }
    return out;
}

/**
 * The artifact an injected atom names (`{ kind: 'atom', artifact }`): Req
 * Explorer's status badge in a heading, its summary table after one.
 */
function atomArtifact(mark: InjectionMark | null | undefined): string | null {
    return mark?.kind === 'atom' && 'artifact' in mark ? mark.artifact : null;
}

/**
 * Lift a requirement heading's `ID: ` prefix out of its editable text.
 *
 * The id is read-only in the editor (the anchor migration owns renaming it), so
 * it moves into the heading's `reqPrefix` attribute and the text starts after
 * it. Only when Req Explorer says the heading is that artifact's and the text
 * really starts with it — a heading merely mentioning an id keeps it.
 *
 * **Two signals say so, because Req Explorer injects either or both.** The
 * status badge it appends to the heading names the artifact; so does the
 * summary table it injects as the next top-level block. Since `CR-RXE-129` the
 * summary is the one status surface, and a heading whose table shows the
 * status gets no badge — the badge stays only where no table repeats it. Read
 * from the badge alone, every requirement heading with a summary would lose
 * its read-only id; read from the table alone, a heading with a badge and no
 * table would. The badge is asked first, then `following`, the artifact of the
 * table right after the heading (`null` when the next block is none).
 */
function liftRequirementPrefix(
    children: StreamToken[], rawChildren: readonly Token[], following: string | null,
): { children: StreamToken[]; prefix: string | null } {
    const badge = rawChildren.map(c => atomArtifact(injectionMarkOf(c))).find((a): a is string => a !== null);
    const first = children[0];
    if (first === undefined || first.type !== 'text') {
        return { children, prefix: null };
    }
    const prefix = [badge, following]
        .filter((a): a is string => typeof a === 'string')
        .map(a => `${a}: `)
        .find(p => first.content.startsWith(p));
    if (prefix === undefined) {
        return { children, prefix: null };
    }
    const rest: StreamToken = { type: 'text', content: first.content.slice(prefix.length), children: null };
    return { children: [rest, ...children.slice(1)], prefix };
}

/**
 * Parse the file into the editor's document.
 *
 * `md` is the engine from `createEditorEngine` — the same composition the
 * preview uses, other extensions' rules included, which is why parsing runs in
 * the extension host. `env` is handed to markdown-it and to every render of a
 * raw or injected block, so rules that keep per-document state there (footnotes,
 * Req Explorer's index lookups) see one document.
 *
 * `definition` is what the page's engine is built from for `md`
 * (`inlineEngineDefinition`), by default read off `md` (`definitionOf`): the
 * literals the parse finds are judged with it (`groupSourceBlocks`), as the
 * page judges the literals it writes, so both answer alike under any setting.
 *
 * Throws when the document cannot be represented without losing a byte; the
 * caller then keeps the text editor.
 */
export function parseDocument(md: MarkdownIt, text: string, env: Environment = {}, definition: InlineEngineDefinition = definitionOf(md)): ParsedDocument {
    const engine = md as EngineWithOptions;
    const tokens = md.parse(text, env);
    const lines = splitLines(text);
    const { blocks, tail } = groupSourceBlocks(tokens, lines, definition);

    const rebuilt = blocks.map(b => (b.src === null ? '' : b.gap + b.src)).join('') + tail;
    if (rebuilt !== text) {
        throw new Error('Rich editor: the source blocks do not account for every line of the document.');
    }

    const render = (block: SourceBlock): string => {
        const [start, end] = block.tokenRange;
        return start < end ? md.renderer.render(tokens.slice(start, end), engine.options, env) : '';
    };

    // Attributes MarkdownParser cannot derive from a token alone: the source
    // slice of a top-level block and its attribute literal, a heading's lifted
    // prefix, an admonition's title (its tokens are not in the stream), and the
    // literal each attribute span was written with.
    const topAttrs = new WeakMap<object, { src: string | null; gap: string | null }>();
    const blockAttrs = new WeakMap<object, BlockAttrs>();
    const headingPrefix = new WeakMap<object, string>();
    const admonitionTitle = new WeakMap<object, string>();
    const spanLiteral = new WeakMap<object, string>();
    const itemLiteral = new WeakMap<object, string>();
    // A heading's inline token as the engine made it, whose text markdown-it-attrs took the literal off (`headingLiteral`).
    const headingInline = new WeakMap<object, Token>();
    // A nested paragraph whose lines hold a literal that is not its own — a list
    // item's at its end, a quote's under it — measured without it, as a
    // paragraph's own is: the literal is not wrapped.
    const foreignLiteral = new WeakMap<object, BlockAttrs>();
    const stream: StreamToken[] = [];

    for (const [k, block] of blocks.entries()) {
        switch (block.kind) {
            case 'front_matter':
                stream.push(synthetic('front_matter', { src: block.src ?? '' }));
                break;
            case 'raw': {
                // A table the editor leaves as source says why in its bar: multimd's extensions, or a cell it cannot hold.
                const [start, end] = block.tokenRange;
                const table = start < end && tokens[start].type === 'table_open';
                const construct = table ? (block.reason.includes('(multimd)') ? 'multimd table' : 'table') : null;
                stream.push(synthetic('raw_block', { src: block.src ?? '', gap: block.gap, html: render(block), construct }));
                break;
            }
            case 'injected':
                stream.push(synthetic('injected_block', {
                    kind: block.injectedKind ?? 'generated',
                    mark: block.mark,
                    html: render(block),
                    src: block.src,
                    gap: block.gap,
                }));
                break;
            case 'editable': {
                const [start, end] = block.tokenRange;
                topAttrs.set(tokens[start], { src: block.src, gap: block.gap });
                if (block.attrs !== null) {
                    blockAttrs.set(tokens[start], block.attrs);
                    if (tokens[start].type === 'blockquote_open' && tokens[end - 2]?.type === 'paragraph_close') {
                        let p = end - 2;
                        while (p > start && tokens[p].type !== 'paragraph_open') {
                            p--;
                        }
                        foreignLiteral.set(tokens[p], block.attrs);
                    }
                }
                let span = 0;
                let item = 0;
                for (let i = start; i < end; i++) {
                    const t = tokens[i];
                    if (t.type === 'list_item_open' && (t.attrs ?? []).length > 0 && item < block.itemLiterals.length) {
                        const literal = block.itemLiterals[item++];
                        itemLiteral.set(t, literal);
                        foreignLiteral.set(tokens[i + 1], { suffix: literal, placement: 'end' });
                    }
                    if (t.type === 'admonition_title_open') {
                        // The title is the admonition's attribute, not a block of its body;
                        // as the plugin read it, so a quoted title's spaces are written back.
                        admonitionTitle.set(tokens[i - 1], tokens[i + 1]?.content ?? '');
                        i += 2;
                        continue;
                    }
                    if (t.type !== 'inline') {
                        stream.push(t as unknown as StreamToken);
                        continue;
                    }
                    for (const child of t.children ?? []) {
                        if (child.type === 'span_open') {
                            spanLiteral.set(child, block.spanLiterals[span++]);
                        }
                    }
                    let children = preprocessInline(engine, env, t.children ?? []);
                    const opener = tokens[i - 1];
                    if (opener?.type === 'heading_open') {
                        headingInline.set(opener, t);
                        // The summary table right after counts only for a heading that
                        // is the top-level block itself, not one inside a container.
                        const next = blocks[k + 1];
                        const following = i - 1 === start && next?.kind === 'injected' ? atomArtifact(next.mark) : null;
                        const lifted = liftRequirementPrefix(children, t.children ?? [], following);
                        children = lifted.children;
                        if (lifted.prefix !== null) {
                            headingPrefix.set(opener, lifted.prefix);
                        }
                    }
                    stream.push({ type: 'inline', content: t.content, children });
                }
                break;
            }
        }
    }

    const sourceOf = (tok: StreamToken) => topAttrs.get(tok) ?? { src: null, gap: null };
    const suffixOf = (tok: StreamToken) => {
        const found = blockAttrs.get(tok);
        return { attrsSuffix: found?.suffix ?? null, attrsPlacement: found?.placement ?? null };
    };
    const own = (tok: StreamToken): Attrs => tok.pmAttrs ?? {};
    const real = (tok: StreamToken) => tok as unknown as Token;

    const specs: Record<string, {
        node?: string; block?: string; mark?: string; noCloseToken?: boolean; ignore?: boolean;
        getAttrs?: (tok: StreamToken, stream: StreamToken[], i: number) => Attrs | null;
    }> = {
        front_matter: { node: 'front_matter', getAttrs: own },
        raw_block: { node: 'raw_block', getAttrs: own },
        injected_block: { node: 'injected_block', getAttrs: own },
        inline_atom: { node: 'inline_atom', getAttrs: own },
        req_ref: { mark: 'req_ref', getAttrs: own },
        paragraph: {
            block: 'paragraph',
            getAttrs: (tok, s, i) => {
                const map = real(tok).map;
                let source = map ? lines.slice(map[0], map[1]).map(l => l.text) : [];
                let content = (s[i + 1]?.type === 'inline' ? s[i + 1].content : '').split('\n');
                // The width is the text's: the attribute literal is written after
                // it is wrapped (`serialize.ts`), so it is no evidence of the width.
                const literal = blockAttrs.get(tok) ?? foreignLiteral.get(tok);
                if (literal?.placement === 'line') {
                    source = source.slice(0, -1);
                    content = content.slice(0, -1);
                } else if (literal?.placement === 'end') {
                    const strip = (all: string[]) => all.map((l, k) => (k === all.length - 1 && l.trimEnd().endsWith(literal.suffix)
                        ? l.trimEnd().slice(0, -literal.suffix.length).trimEnd() : l));
                    source = strip(source);
                    content = strip(content);
                }
                return {
                    ...sourceOf(tok),
                    wrapWidth: measureWrapWidth(source, content),
                    lineWidth: measureLineWidth(source),
                    ...suffixOf(tok),
                };
            },
        },
        heading: {
            block: 'heading',
            getAttrs: tok => {
                const t = real(tok);
                return {
                    ...sourceOf(tok),
                    level: Number(t.tag.slice(1)),
                    reqPrefix: headingPrefix.get(tok) ?? null,
                    anchor: attr(t, 'id'),
                    attrsSuffix: t.attrs && t.attrs.length > 0 ? headingLiteral(headingInline.get(t), t, definition) : null,
                };
            },
        },
        blockquote: { block: 'blockquote', getAttrs: tok => ({ ...sourceOf(tok), ...suffixOf(tok) }) },
        container_container: {
            block: 'container',
            getAttrs: tok => {
                // `info` is the opening line after the fence (` warning big`).
                const [, name, info] = /^\s*(\S*)([\s\S]*)$/.exec(real(tok).info) ?? ['', '', ''];
                return { ...sourceOf(tok), name, info, markup: real(tok).markup || ':::' };
            },
        },
        admonition: {
            block: 'admonition',
            getAttrs: tok => {
                const t = real(tok);
                const line = t.map ? lines[t.map[0]]?.text ?? '' : '';
                const marker = line.indexOf(t.markup);
                return {
                    ...sourceOf(tok),
                    // Its class as the renderer draws it: a brace of the text's own is none.
                    type: withoutTextBraceEnd(t.info) || 'note',
                    title: admonitionTitle.get(tok) ?? '',
                    markup: t.markup || '!!!',
                    // From the marker on: a quote's `> ` or a list's indentation is not the header's.
                    header: marker < 0 ? null : line.slice(marker),
                };
            },
        },
        bullet_list: {
            block: 'bullet_list',
            getAttrs: (tok, s, i) => ({ ...sourceOf(tok), bullet: real(tok).markup || '-', tight: listIsTight(s, i), ...suffixOf(tok) }),
        },
        ordered_list: {
            block: 'ordered_list',
            getAttrs: (tok, s, i) => ({
                ...sourceOf(tok),
                order: Number(attr(real(tok), 'start') ?? 1),
                delimiter: real(tok).markup || '.',
                tight: listIsTight(s, i),
                ...suffixOf(tok),
            }),
        },
        list_item: { block: 'list_item', getAttrs: tok => ({ literal: itemLiteral.get(tok) ?? null }) },
        // A pipe table (`blocks.ts` let only the GFM form through): the rows
        // are the table's children, `thead` and `tbody` no node of their own;
        // a cell's alignment is the `style` the plugin set from the delimiter row.
        table: { block: 'table', getAttrs: tok => ({ ...sourceOf(tok), ...suffixOf(tok) }) },
        thead: { ignore: true },
        tbody: { ignore: true },
        tr: { block: 'table_row' },
        th: { block: 'table_header', getAttrs: tok => ({ align: alignOfStyle(attr(real(tok), 'style')) }) },
        td: { block: 'table_cell', getAttrs: tok => ({ align: alignOfStyle(attr(real(tok), 'style')) }) },
        fence: {
            block: 'code_block',
            noCloseToken: true,
            getAttrs: tok => ({ ...sourceOf(tok), params: real(tok).info || '', markup: real(tok).markup || '```', ...suffixOf(tok) }),
        },
        code_block: {
            block: 'code_block',
            noCloseToken: true,
            getAttrs: tok => ({ ...sourceOf(tok), params: '', markup: '' }),
        },
        hr: {
            node: 'horizontal_rule',
            getAttrs: tok => {
                // markdown-it-attrs turns `--- {#id}` into a rule whose markup is
                // the whole line; the literal is `attrsSuffix`, the rule the rest.
                const suffix = suffixOf(tok);
                let markup = real(tok).markup || '---';
                const literal = suffix.attrsSuffix === null ? null : endLiteralOf(markup);
                if (literal !== null && markup.trimEnd().endsWith(literal)) {
                    markup = markup.trimEnd().slice(0, -literal.length).trimEnd();
                }
                return { ...sourceOf(tok), markup, ...suffix };
            },
        },
        // `[text]{…}`: the literal as the block's source spells it (`recoverSpanLiterals`).
        span: { mark: 'attr_span', getAttrs: tok => ({ literal: spanLiteral.get(tok) ?? '{}' }) },
        image: {
            node: 'image',
            getAttrs: tok => {
                const t = real(tok);
                return { src: attr(t, 'src') ?? '', alt: tokenText(t.children) || null, title: attr(t, 'title') };
            },
        },
        hardbreak: { node: 'hard_break' },
        // `![[…]]`: one atom carrying its source as written (`markdownItWikiEmbed.ts`).
        wiki_embed: {
            node: 'wiki_embed',
            getAttrs: tok => ({ source: ((real(tok).meta as { source?: string } | null)?.source) ?? real(tok).content }),
        },
        em: { mark: 'em', getAttrs: tok => ({ markup: real(tok).markup || '*' }) },
        strong: { mark: 'strong', getAttrs: tok => ({ markup: real(tok).markup || '**' }) },
        link: {
            mark: 'link',
            getAttrs: tok => {
                const t = real(tok);
                return {
                    href: attr(t, 'href') ?? '',
                    title: attr(t, 'title'),
                    markup: t.markup === 'linkify' || t.markup === 'autolink' ? t.markup : null,
                };
            },
        },
        code_inline: { mark: 'code', noCloseToken: true },
        // The extension's inline syntax, each delimiter pair a mark.
        mark: { mark: 'mark' },
        s: { mark: 'strike' },
        sup: { mark: 'sup' },
        sub: { mark: 'sub' },
        kbd: { mark: 'kbd' },
        // A note's `_ref_` and `_content_` pairs are its two child nodes.
        sidenote: { block: 'sidenote' },
        sidenote_ref: { block: 'note_ref' },
        sidenote_content: { block: 'sidenote_body' },
        marginal_note: { block: 'marginal_note' },
        marginal_note_ref: { block: 'note_ref' },
        marginal_note_content: { block: 'marginal_note_body' },
        left_sidebar: { block: 'left_sidebar' },
        right_sidebar: { block: 'right_sidebar' },
    };

    // The tokenizer MarkdownParser is given is a stand-in returning the
    // pre-processed stream; its types are written against @types/markdown-it,
    // which this project does not compile against, hence the casts.
    type ParserArgs = ConstructorParameters<typeof MarkdownParser>;
    const tokenizer = { parse: () => stream } as unknown as ParserArgs[1];
    const parser = new MarkdownParser(editorSchema, tokenizer, specs as unknown as ParserArgs[2]);
    const doc = parser.parse(text);

    // MarkdownParser falls back to an empty document when content does not fit
    // the schema; that would be every byte of the file, silently.
    if (doc.childCount !== blocks.length) {
        throw new Error(`Rich editor: ${blocks.length} source blocks became ${doc.childCount} document nodes.`);
    }
    // An inline node whose content does not fit the schema is dropped by
    // MarkdownParser just as silently; the notes are the inline nodes that
    // have content, so each one the stream opened must be in the document.
    const opened = stream.reduce((n, t) => n + (t.children ?? []).filter(c => NOTE_OPEN_TOKENS.has(c.type)).length, 0);
    let made = 0;
    doc.descendants(node => {
        made += NOTE_NODES.has(node.type.name) ? 1 : 0;
    });
    if (opened !== made) {
        throw new Error(`Rich editor: ${opened} notes became ${made} note nodes.`);
    }
    return { doc, eol: detectEol(text), tail };
}
