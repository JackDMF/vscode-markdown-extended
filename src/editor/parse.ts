// prosemirror-markdown brings its own markdown-it 14 for its *default* parser,
// which this module never uses: the tokens come from the editor engine, handed
// to MarkdownParser through the tokenizer wrapper below.
import { MarkdownParser } from 'prosemirror-markdown';
import { Attrs, Node } from 'prosemirror-model';
import { Environment, MarkdownIt, Options, Token } from '../@types/markdown-it';
import {
    InjectionMark,
    SourceBlock,
    detectEol,
    findAttrsSuffix,
    groupSourceBlocks,
    injectionMarkOf,
    splitLines,
} from './blocks';
import { editorSchema } from './schema';
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

function textOf(tokens: readonly Token[] | null): string {
    let out = '';
    for (const t of tokens ?? []) {
        if (t.type === 'text' || t.type === 'code_inline') {
            out += t.content;
        } else if (t.children) {
            out += textOf(t.children);
        }
    }
    return out;
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
 * Lift a requirement heading's `ID: ` prefix out of its editable text.
 *
 * The id is read-only in the editor (the anchor migration owns renaming it), so
 * it moves into the heading's `reqPrefix` attribute and the text starts after
 * it. Only when the badge Req Explorer appended names that artifact and the
 * text really starts with it — a heading merely mentioning an id keeps it.
 */
function liftRequirementPrefix(children: StreamToken[], rawChildren: readonly Token[]): { children: StreamToken[]; prefix: string | null } {
    const atom = rawChildren
        .map(c => injectionMarkOf(c))
        .find((m): m is Extract<InjectionMark, { artifact: string }> => m?.kind === 'atom' && 'artifact' in m);
    const first = children[0];
    if (atom === undefined || first === undefined || first.type !== 'text') {
        return { children, prefix: null };
    }
    const prefix = `${atom.artifact}: `;
    if (!first.content.startsWith(prefix)) {
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
 * Throws when the document cannot be represented without losing a byte; the
 * caller then keeps the text editor.
 */
export function parseDocument(md: MarkdownIt, text: string, env: Environment = {}): ParsedDocument {
    const engine = md as EngineWithOptions;
    const tokens = md.parse(text, env);
    const lines = splitLines(text);
    const { blocks, tail } = groupSourceBlocks(tokens, lines);

    const rebuilt = blocks.map(b => (b.src === null ? '' : b.gap + b.src)).join('') + tail;
    if (rebuilt !== text) {
        throw new Error('Rich editor: the source blocks do not account for every line of the document.');
    }

    const render = (block: SourceBlock): string => {
        const [start, end] = block.tokenRange;
        return start < end ? md.renderer.render(tokens.slice(start, end), engine.options, env) : '';
    };

    // Attributes MarkdownParser cannot derive from a token alone: the source
    // slice of a top-level block, and a heading's lifted prefix.
    const topAttrs = new WeakMap<object, { src: string | null; gap: string | null }>();
    const headingPrefix = new WeakMap<object, string>();
    const stream: StreamToken[] = [];

    for (const block of blocks) {
        switch (block.kind) {
            case 'front_matter':
                stream.push(synthetic('front_matter', { src: block.src ?? '' }));
                break;
            case 'raw':
                stream.push(synthetic('raw_block', { src: block.src ?? '', gap: block.gap, html: render(block) }));
                break;
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
                for (let i = start; i < end; i++) {
                    const t = tokens[i];
                    if (t.type !== 'inline') {
                        stream.push(t as unknown as StreamToken);
                        continue;
                    }
                    let children = preprocessInline(engine, env, t.children ?? []);
                    const opener = tokens[i - 1];
                    if (opener?.type === 'heading_open') {
                        const lifted = liftRequirementPrefix(children, t.children ?? []);
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
    const own = (tok: StreamToken): Attrs => tok.pmAttrs ?? {};
    const real = (tok: StreamToken) => tok as unknown as Token;

    const specs: Record<string, {
        node?: string; block?: string; mark?: string; noCloseToken?: boolean;
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
                const source = map ? lines.slice(map[0], map[1]).map(l => l.text) : [];
                const content = (s[i + 1]?.type === 'inline' ? s[i + 1].content : '').split('\n');
                return {
                    ...sourceOf(tok),
                    wrapWidth: measureWrapWidth(source, content),
                    lineWidth: measureLineWidth(source),
                };
            },
        },
        heading: {
            block: 'heading',
            getAttrs: tok => {
                const t = real(tok);
                const line = t.map ? lines[t.map[0]]?.text ?? '' : '';
                return {
                    ...sourceOf(tok),
                    level: Number(t.tag.slice(1)),
                    reqPrefix: headingPrefix.get(tok) ?? null,
                    anchor: attr(t, 'id'),
                    attrsSuffix: t.attrs && t.attrs.length > 0 ? findAttrsSuffix(line) : null,
                };
            },
        },
        blockquote: { block: 'blockquote', getAttrs: tok => ({ ...sourceOf(tok) }) },
        bullet_list: {
            block: 'bullet_list',
            getAttrs: (tok, s, i) => ({ ...sourceOf(tok), bullet: real(tok).markup || '-', tight: listIsTight(s, i) }),
        },
        ordered_list: {
            block: 'ordered_list',
            getAttrs: (tok, s, i) => ({
                ...sourceOf(tok),
                order: Number(attr(real(tok), 'start') ?? 1),
                delimiter: real(tok).markup || '.',
                tight: listIsTight(s, i),
            }),
        },
        list_item: { block: 'list_item' },
        fence: {
            block: 'code_block',
            noCloseToken: true,
            getAttrs: tok => ({ ...sourceOf(tok), params: real(tok).info || '', markup: real(tok).markup || '```' }),
        },
        code_block: {
            block: 'code_block',
            noCloseToken: true,
            getAttrs: tok => ({ ...sourceOf(tok), params: '', markup: '' }),
        },
        hr: { node: 'horizontal_rule', getAttrs: tok => ({ ...sourceOf(tok), markup: real(tok).markup || '---' }) },
        image: {
            node: 'image',
            getAttrs: tok => {
                const t = real(tok);
                return { src: attr(t, 'src') ?? '', alt: textOf(t.children) || null, title: attr(t, 'title') };
            },
        },
        hardbreak: { node: 'hard_break' },
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
    return { doc, eol: detectEol(text), tail };
}
