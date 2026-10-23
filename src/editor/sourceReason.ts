/**
 * Why a block is a source block, in the words its bar and its name use
 * ("Source · has a footnote", "Source · definition list"): the classifier's
 * reason (`blocks.ts`, `Classification.reason`) is the engine's — a token
 * type, a sentence for the developer — and is mapped here to what a person
 * calls the construct. Two shapes: what the block **is** ("definition list",
 * "footnote text"), and what it **has** inside ("has a footnote", "has a
 * table" — a paragraph or a list holding it). `null` where no word says more
 * than "source".
 */
import { INLINE_LITERAL_HOLDERS, NOTE_NAMES, namesOf } from './inlineLiterals';

/** A token type the editor does not edit, by what a person calls it: with its article where a block can hold one. */
const TOKEN_WORDS: ReadonlyMap<string, { noun: string; article: string }> = new Map([
    ['footnote_ref', { noun: 'footnote', article: 'a ' }],
    ['dl_open', { noun: 'definition list', article: 'a ' }],
    ['toc_open', { noun: 'table of contents', article: 'a ' }],
    ['abbr_open', { noun: 'abbreviation', article: 'an ' }],
    ['html_inline', { noun: 'inline HTML', article: '' }],
    ['html_block', { noun: 'HTML', article: '' }],
    ['table_open', { noun: 'table', article: 'a ' }],
    ['math_inline', { noun: 'math', article: '' }],
    ['math_block', { noun: 'math', article: '' }],
]);

/** Lines no token accounts for, by how they start: a footnote's text, an abbreviation's, a link reference. */
const UNTOKENED: readonly [RegExp, string][] = [
    [/^ {0,3}\[\^[^\]]+\]:/, 'footnote text'],
    [/^ {0,3}\*\[[^\]]+\]:/, 'abbreviation definition'],
    [/^ {0,3}\[[^\]]+\]:/, 'link reference'],
];

/** What a block holding an emoji the editor cannot keep is called (`parse.ts` gives it to one it makes source). */
export const HAS_AN_EMOJI = 'has an emoji';

/** What an admonition is called whose `!!!` line carries a literal (#8 F12: `sourceExplanation` says what it does). */
export const TITLE_ATTRIBUTES = 'title attributes';

/** What a quote is called whose paragraph carries its own literal (#8 F12). */
export const QUOTE_PARAGRAPH_ATTRIBUTES = 'paragraph attributes';

/** A note's or a sidebar's opening token type, as the classifier names it. */
const NOTE_TOKEN = `(?:${Object.keys(NOTE_NAMES).join('|')})_open`;

/**
 * What each inline holder is called in a "has …" construct, by its noun in a
 * classifier's reason (`blocks.ts`: `marginal note whose attributes no literal
 * writes`), the delimiter's names included (`bold text`): with its article
 * where its subject has one ("a marginal note", "inline code"). F9: every holder, one rule.
 */
const HOLDER_PHRASES: ReadonlyMap<string, string> = new Map(INLINE_LITERAL_HOLDERS.flatMap(h => [h, ...Object.keys(h.markups ?? {}).map(m => namesOf(h, m))]).map(names => {
    const article = /^(An?) /.exec(names.subject)?.[1].toLowerCase();
    return [names.noun, article === undefined ? names.noun : `${article} ${names.noun}`];
}));

/** The classifier's reasons about a note or an inline holder's literal, in words (#15, section 5.3). */
function noteAndHolderWords(reason: string): string | null {
    if (new RegExp(`^${NOTE_TOKEN} inside another note$`).test(reason)) {
        return 'has a note in a note';
    }
    if (new RegExp(`^${NOTE_TOKEN} in a table cell: its \\| is a cell boundary$`).test(reason)) {
        return 'has a note in a table';
    }
    if (/ in a note whose literal holds a note marker$/.test(reason)) {
        return 'has a note with attributes inside';
    }
    const literal = /^(.+) whose (?:attributes no literal writes|literal holds a quoted \})$/.exec(reason);
    const phrase = literal === null ? undefined : HOLDER_PHRASES.get(literal[1]);
    if (phrase !== undefined) {
        return `has ${phrase} with attributes`;
    }
    // Defensive: a note's literal the classifier did not keep (none is left since #15).
    const note = new RegExp(`^attributes on (${Object.keys(NOTE_NAMES).join('|')})_open$`).exec(reason);
    if (note !== null) {
        return `has ${HOLDER_PHRASES.get(NOTE_NAMES[note[1] as keyof typeof NOTE_NAMES].toLowerCase())} with attributes`;
    }
    return null;
}

/** Sentences of the classifier, by their start, in words. */
const SENTENCES: readonly [RegExp, string][] = [
    [/^attributes on admonition_title_open$/, TITLE_ATTRIBUTES],
    [/^setext heading/, 'setext heading'],
    [/^heading attributes/, 'heading attributes'],
    [/^container attributes/, 'container attributes'],
    [/^admonition with more than one class/, 'admonition'],
    [/^emoji /, HAS_AN_EMOJI],
];

/**
 * The words for the classifier's `reason` of a source block whose source is
 * `src`; `null` when none says more than "source" (lines overlapping another
 * block, an attribute literal the editor cannot keep, …).
 */
export function sourceReasonWords(reason: string, src: string): string | null {
    if (reason === 'source lines no token accounts for') {
        const first = src.replace(/^(?:[ \t]*\r?\n)+/, '');
        return UNTOKENED.find(([re]) => re.test(first))?.[1] ?? null;
    }
    if (reason === 'attributes on paragraph_open' && /^\s*>/.test(src)) {
        return QUOTE_PARAGRAPH_ATTRIBUTES;
    }
    for (const [re, words] of SENTENCES) {
        if (re.test(reason)) {
            return words;
        }
    }
    const holder = noteAndHolderWords(reason);
    if (holder !== null) {
        return holder;
    }
    // A task box makes the block a task list, wherever it stands.
    if (/checkbox_input/.test(reason)) {
        return 'task list';
    }
    // The block is the token (`dl_open`), or holds it: `inline footnote_ref`, `nested table_open`,
    // `footnote_ref inside another note`, `html_inline in an admonition title`.
    const match = /^(inline |nested )?([a-z_]+)(.*)$/.exec(reason);
    const words = match ? TOKEN_WORDS.get(match[2]) : undefined;
    if (!match || !words) {
        return null;
    }
    const holds = match[1] !== undefined || match[3] !== '' || match[2].endsWith('_inline') || match[2] === 'footnote_ref' || match[2] === 'abbr_open';
    return holds ? `has ${words.article}${words.noun}` : words.noun;
}

/** Whether `construct` says what the block has inside ("has a footnote"), not what it is. */
export function holdsConstruct(construct: string): boolean {
    return construct.startsWith('has ');
}
