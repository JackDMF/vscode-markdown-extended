/**
 * A fenced code block's opening line — its fence, its info string and the
 * `{…}` after them — composed, read back and refused in one place.
 *
 * The save writes the line (`serialize.ts`, `code_block`), the bar shows it and
 * edits it (Edit source, Language…), and a refusal names what is wrong with a
 * typed one: all three read this module, so none composes the line a second
 * way. markdown-it parses it (`parse.ts`, `fence`): the fence is the token's
 * `markup`, the info string its `info` once markdown-it-attrs took the literal
 * off its end (`blocks.ts`).
 *
 * One rule has two behaviours on purpose. A fence must be longer than any run
 * of its character a line inside starts with, or that line would close the
 * block (`minimumFence`). An opening line typed in the bar that is too short is
 * refused — what is typed is what is saved — while a block whose content grew
 * such a run after its fence was set is written with a longer fence, silently,
 * as it always was.
 *
 * Pure: prosemirror-model types only, no DOM — the host bundle reads it too.
 */
import type { Node } from 'prosemirror-model';
import { endLiteralOf, findLeftDelimiter } from './attrs';
import { LANGUAGES } from './languages';
import type { Completion } from './completions';

/** The fence a new code block gets, and an indented one when something fences it. */
export const DEFAULT_FENCE = '```';

/** What the empty opening-line field of an indented block says: Enter fences it with this. */
export const INDENTED_PLACEHOLDER = DEFAULT_FENCE;

/** The hint's sentence when an apply fenced an indented block (`undoHint` joins "— Ctrl+Z"). */
export const FENCED_DONE = 'Code block fenced';

/** Why an opening line without a fence is refused. */
export const NO_FENCE_REFUSAL = 'An opening line starts with its fence — ``` or ~~~, three or more — then the language and any {…}.';

/** Why a fence too short for the block's content is refused: `needed` is the shortest that keeps it open. */
export function shortFenceRefusal(needed: string): string {
    return `A line inside starts with a run as long as this fence and would close the block: write ${needed} or longer.`;
}

/** Why an info string with a backtick after a backtick fence is refused (markdown-it's own rule). */
export const BACKTICK_INFO_REFUSAL = 'A ``` fence takes no backtick after it: the block would no longer be code. A ~~~ fence takes one.';

/**
 * Why Language… is not emptied while other words of the info string follow
 * (```` ```js title=x ````): the next word would become the language.
 */
export const LANGUAGE_FOLLOWED_REFUSAL = 'Other words follow the language — Edit source changes the whole line.';

/**
 * Why Language… refuses a value with a space or a brace in it: the language is
 * one word, and a word with more would change the info string or the literal
 * behind the field's back.
 */
export const LANGUAGE_WORD_REFUSAL = 'A language is one word, without spaces or { }: Edit source changes the whole line.';

/** Whether `language` is one word the info string's first word can be: no whitespace, no braces. */
export function isLanguageWord(language: string): boolean {
    return !/[\s{}]/.test(language.trim());
}

/** A block's opening line in its parts, as the node holds them (`markup`, `params`, `attrsSuffix`). */
export interface OpeningLine {
    markup: string;
    params: string;
    literal: string | null;
}

/**
 * The fence a fenced code block is written with, before it is lengthened past
 * a run in its content: its own, unless it has none (an emptied indented
 * block) or holds an info string with a backtick, which no backtick fence
 * takes — tildes then, backticks otherwise. Where its literal is read
 * (`fenceHolder`) is decided by the same fence.
 */
export function fenceOf(node: Node): string {
    const params = String(node.attrs.params ?? '');
    const markup = String(node.attrs.markup ?? DEFAULT_FENCE);
    if (markup === '' || (markup.startsWith('`') && params.includes('`'))) {
        return params.includes('`') ? '~~~' : DEFAULT_FENCE;
    }
    return markup;
}

/**
 * The fence the save writes for `node`: `fenceOf`, lengthened past a closing
 * line inside (`minimumFence`). The closing line is this fence too, and the
 * opening line of the bar's fields starts with it (`savedOpeningLine`).
 */
export function savedFence(node: Node): string {
    return minimumFence(fenceOf(node), node.textContent);
}

/**
 * The opening line the save writes for `node` — `savedFence`, its info string
 * and its literal; fenced even for an indented block, which has no opening
 * line yet and gets this one when something fences it. `params` stands in for
 * the info string when a field is about to change it (Language…): the fence
 * is the one the block has now, so a typed word that would not survive on it
 * (a backtick after backticks) is refused, not carried to another fence.
 *
 * The one line the serializer, Edit source's prefill and Language… all build:
 * a field that composed it from the node's `markup` would show a fence the
 * save does not write, and refuse what the save would accept.
 */
export function savedOpeningLine(node: Node, params = String(node.attrs.params ?? '')): string {
    return openingLineOf({ markup: savedFence(node), params, attrsSuffix: node.attrs.attrsSuffix as string | null });
}

/**
 * The block's opening line as the file writes it: the fence, the info string,
 * a space and the literal; `''` for an indented block (`markup` empty).
 */
export function openingLineOf(attrs: { markup: string; params: string; attrsSuffix: string | null }): string {
    if (attrs.markup === '') {
        return '';
    }
    return attrs.markup + attrs.params + (attrs.attrsSuffix ? ` ${attrs.attrsSuffix}` : '');
}

/**
 * The fence the file needs for `content`: `markup`, or one longer when a line
 * inside would close the block — a closing line is a run of the fence's
 * character, after up to three spaces, followed by nothing but spaces or
 * tabs, and as long as the fence. A line with words after the run
 * (```` ```python ````) closes nothing: it is an opening line, text here.
 */
export function minimumFence(markup: string, content: string): string {
    const ch = markup[0];
    let longest = 0;
    for (const line of content.match(new RegExp(`^ {0,3}\\${ch}+[ \\t]*$`, 'gm')) ?? []) {
        longest = Math.max(longest, line.trim().length);
    }
    return longest >= markup.length ? ch.repeat(longest + 1) : markup;
}

/**
 * An opening line typed for a block holding `content`, read back into its
 * parts — or why it is refused: no fence (`NO_FENCE_REFUSAL`), a fence
 * shorter than `minimumFence` (`shortFenceRefusal`), a backtick after a
 * backtick fence (`BACKTICK_INFO_REFUSAL`). The literal is the `{…}` the line
 * ends with as markdown-it-attrs finds it (`endLiteralOf`) — or, when the line
 * ends with a brace pair the plugin would not take, that pair, so the
 * literal's own check (`literalRefusal`) says why rather than the pair
 * silently staying text in the info string.
 */
export function parseOpeningLine(line: string, content: string): OpeningLine | { refusal: string } {
    const match = /^(`{3,}|~{3,})(.*)$/.exec(line.trim());
    if (!match) {
        return { refusal: NO_FENCE_REFUSAL };
    }
    const [, markup, rest] = match;
    const needed = minimumFence(markup, content);
    if (needed.length > markup.length) {
        return { refusal: shortFenceRefusal(needed) };
    }
    if (markup.startsWith('`') && rest.includes('`')) {
        return { refusal: BACKTICK_INFO_REFUSAL };
    }
    const info = rest.trim();
    let literal = endLiteralOf(info);
    if (literal === null && info.endsWith('}')) {
        const start = findLeftDelimiter(info);
        literal = start >= 0 ? info.slice(start) : null;
    }
    const params = literal === null ? info : info.slice(0, info.length - literal.length).trim();
    return { markup, params, literal };
}

/** The language a fence's info string names: its first word, `''` for none. */
export function languageOf(params: string): string {
    return params.trim().split(/\s+/)[0] ?? '';
}

/**
 * `params` with its first word replaced by `language`, added when it has none,
 * or removed when `language` is `''`; the rest of the info string as it was.
 */
export function withLanguage(params: string, language: string): string {
    const trimmed = params.trim();
    const rest = trimmed === '' ? '' : trimmed.slice(languageOf(trimmed).length).trim();
    const word = language.trim();
    return word === '' ? rest : rest === '' ? word : `${word} ${rest}`;
}

/** The display name highlight.js gives `word`, by id or alias, case aside; `null` for a word it does not know. */
export function languageName(word: string): string | null {
    const lower = word.toLowerCase();
    return LANGUAGES.find(l => l.id === lower || l.aliases.includes(lower))?.name ?? null;
}

/** The languages the document's fences name, most used first, then in the order they first appear. */
export function documentLanguages(doc: Node): string[] {
    const counts = new Map<string, number>();
    doc.descendants(node => {
        if (node.type.name === 'code_block') {
            const language = languageOf(String(node.attrs.params ?? ''));
            if (language !== '') {
                counts.set(language, (counts.get(language) ?? 0) + 1);
            }
            return false;
        }
        return true;
    });
    // A stable sort keeps the first appearance among equal counts.
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([language]) => language);
}

/**
 * What Language… offers for a query, the document's languages read once
 * (`documentLanguages`) — the completer a field asks on each key: the
 * languages the document's fences name first (detail "JavaScript · in this
 * document"), then every language highlight.js highlights whose id or an
 * alias starts with the query, case aside — the word that matched, the id
 * before an alias, its name as the detail. A language the document already
 * offers under one of its words is not offered again under another
 * (`javascript` in the document: no `js` below it). The list offers; the
 * field takes any word.
 */
export function languageCompleter(doc: Node): (query: string) => Completion[] {
    const inDocument = documentLanguages(doc);
    return query => {
        const q = query.trim().toLowerCase();
        const starts = (word: string) => word.toLowerCase().startsWith(q);
        const own = inDocument.filter(starts);
        const offered = new Set(own.map(l => l.toLowerCase()));
        const completions: Completion[] = own.map(language => {
            const name = languageName(language);
            return { value: language, label: language, detail: name === null ? 'in this document' : `${name} · in this document` };
        });
        for (const language of LANGUAGES) {
            const words = [language.id, ...language.aliases];
            if (words.some(w => offered.has(w))) {
                continue;
            }
            const word = words.find(starts);
            if (word !== undefined) {
                offered.add(word);
                completions.push({ value: word, label: word, detail: language.name });
            }
        }
        return completions;
    };
}

/** `languageCompleter` asked once: what Language… offers for `query` in `doc`. */
export function languageCompletions(doc: Node, query: string): Completion[] {
    return languageCompleter(doc)(query);
}
