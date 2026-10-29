import { Environment, MarkdownIt, Token } from '../@types/markdown-it';

/**
 * Footnotes where they are written (wave 4 #5b): the one place the editor's
 * parse reads footnotes otherwise than the preview does.
 *
 * markdown-it-footnote takes every definition (`[^x]: …`) out of the token
 * stream and appends the referenced ones, in number order, as a generated list
 * after the document's blocks (`footnote_tail`); a definition nothing refers to
 * is dropped. The editor edits each definition where the file has it, so a
 * parse whose environment carries `FOOTNOTES_IN_PLACE` keeps them in place:
 * each definition is a top-level group of its own with the lines it stands for
 * (`footnote_def` stamps its `map`), orphans and repeated labels included, and
 * the tail appends nothing. Numbers are not the parse's business: the page
 * counts them as the engine does (`webview/footnotes.ts`).
 *
 * Without the flag — the preview, an export, the text editor's toggles, a render
 * that looks for `id="fn1"` — the engine is the plugin's, unchanged.
 */

/** The environment key under which a parse keeps footnote definitions in place. */
export const FOOTNOTES_IN_PLACE = 'mepFootnotesInPlace';

/** What markdown-it-footnote keeps in the environment. */
interface FootnoteEnv {
    footnotes?: {
        refs?: Record<string, number>;
        list?: ({ label?: string; count?: number; content?: string; tokens?: Token[] } | undefined)[];
    };
}

/** What `annotate` adds to an inline footnote's token, for a reader with no environment. */
interface InlineNoteMeta {
    id: number;
    /** Its text, verbatim between `^[` and `]`. */
    source?: string;
    /** Whether that text holds a footnote reference or an inline footnote of its own. */
    nested?: boolean;
    /** The engine listed no such footnote: an inline footnote it does not number (one in a note's text, before the sidenote fix). */
    broken?: boolean;
}

/** The rules the adapter reads off a ruler, as `rulesOf` (`engine.ts`) does. */
interface RuleList {
    __rules__?: { name: string; fn: unknown }[];
}

function ruleOf(ruler: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
    return (ruler as RuleList).__rules__?.find(rule => rule.name === name)?.fn as ((...args: unknown[]) => unknown) | undefined;
}

/** Whether `env` asks for footnotes in place. */
function inPlace(env: unknown): boolean {
    return (env as Record<string, unknown> | undefined)?.[FOOTNOTES_IN_PLACE] === true;
}

/**
 * Teach `md`'s markdown-it-footnote to keep definitions in place under
 * `FOOTNOTES_IN_PLACE`; nothing for an engine without the plugin. Installed
 * after the plugins, by `createEditorEngine` and `createInlineEngine`, so the
 * host's parse and the page's read-back group a file alike.
 */
export function useFootnotesInPlace(md: MarkdownIt): void {
    const def = ruleOf(md.block.ruler, 'footnote_def');
    const tail = ruleOf(md.core.ruler, 'footnote_tail');
    if (def === undefined || tail === undefined) {
        return;
    }
    // The plugin's open and close tokens carry no map; stamped, the definition is a group with its lines.
    const stamped = (state: { tokens: Token[]; line: number; env: Environment }, startLine: number, endLine: number, silent: boolean): boolean => {
        const first = state.tokens.length;
        const found = def(state, startLine, endLine, silent) === true;
        if (found && !silent && inPlace(state.env)) {
            const map = [startLine, state.line];
            state.tokens[first].map = [...map];
            state.tokens[state.tokens.length - 1].map = [...map];
        }
        return found;
    };
    // `at` resets `alt` when none is given: a definition must still interrupt a paragraph and a reference definition.
    md.block.ruler.at('footnote_def', stamped as never, { alt: ['paragraph', 'reference'] });
    md.core.ruler.at('footnote_tail', ((state: { env: Environment; tokens: Token[] }) => {
        if (inPlace(state.env)) {
            annotate(state);
        } else {
            tail(state);
        }
    }) as never);
    // Reached only in place, where a source block holds a definition inside another block.
    md.renderer.rules.footnote_reference_open = (tokens: Token[], idx: number) =>
        `<div class="footnote-item mep-fn-raw" data-label="${md.utils.escapeHtml(String((tokens[idx].meta as { label?: unknown } | null)?.label ?? ''))}">\n`;
    md.renderer.rules.footnote_reference_close = () => '</div>\n';
}

/**
 * Copy what the environment knows of each inline footnote (`^[…]`) onto its
 * token: its text, whether that text holds a footnote, and whether the engine
 * listed it at all. The classifier and the parse then read a token alone.
 */
function annotate(state: { env: Environment; tokens: Token[] }): void {
    const list = (state.env as FootnoteEnv).footnotes?.list ?? [];
    for (const token of state.tokens) {
        for (const child of token.type === 'inline' ? token.children ?? [] : []) {
            const meta = child.meta as InlineNoteMeta & { label?: string } | null;
            if (child.type !== 'footnote_ref' || meta === null || typeof meta.label === 'string') {
                continue;
            }
            const entry = list[meta.id];
            if (entry === undefined || typeof entry.content !== 'string') {
                meta.broken = true;
                continue;
            }
            meta.source = entry.content;
            meta.nested = (entry.tokens ?? []).some(t => t.type === 'footnote_ref');
        }
    }
}

/**
 * A fresh environment for a parse in place: `base`'s entries, the flag, and —
 * for a part read on its own, as the page reads back what it writes — the
 * labels the document defines (`labels`), so `[^x]` reads as the reference it
 * is in the document. Fresh, as markdown-it-footnote keeps its state there.
 */
export function inPlaceEnv(base?: Environment, labels?: Iterable<string>): Environment {
    const env: Environment = { ...(base ?? {}), [FOOTNOTES_IN_PLACE]: true };
    delete env.footnotes;
    if (labels !== undefined) {
        const refs: Record<string, number> = {};
        for (const label of labels) {
            refs[`:${label}`] = -1;
        }
        env.footnotes = { refs };
    }
    return env;
}

/**
 * What a footnote token says: a reference's label (`[^x]`), an inline
 * footnote's text (`^[…]`) with whether it holds a footnote of its own and
 * whether the engine numbered it, a definition's label
 * (`footnote_reference_open`); `null` for any other token.
 */
export function footnoteMeta(t: Token): { label: string } | { source: string; nested: boolean } | { broken: true } | null {
    if (t.type !== 'footnote_ref' && t.type !== 'footnote_reference_open') {
        return null;
    }
    const meta = t.meta as InlineNoteMeta & { label?: string } | null;
    if (typeof meta?.label === 'string') {
        return { label: meta.label };
    }
    if (typeof meta?.source === 'string') {
        return { source: meta.source, nested: meta.nested === true };
    }
    return { broken: true };
}
