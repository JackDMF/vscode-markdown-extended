/**
 * Why a block is a source block, in the words its bar and its name use
 * ("Source · footnote", "Source block: definition list"): the classifier's
 * reason (`blocks.ts`, `Classification.reason`) is the engine's — a token
 * type, a sentence for the developer — and is mapped here to what a person
 * calls the construct. `null` where no word says more than "source".
 */

/** A token type the editor does not edit, by what a person calls it. */
const TOKEN_WORDS: ReadonlyMap<string, string> = new Map([
    ['footnote_ref', 'footnote'],
    ['dl_open', 'definition list'],
    ['toc_open', 'table of contents'],
    ['abbr_open', 'abbreviation'],
    ['checkbox_input', 'task list'],
    ['html_inline', 'inline HTML'],
    ['html_block', 'HTML'],
    ['table_open', 'table'],
    ['math_inline', 'math'],
    ['math_block', 'math'],
]);

/** Lines no token accounts for, by how they start: a footnote's text, an abbreviation's, a link reference. */
const UNTOKENED: readonly [RegExp, string][] = [
    [/^ {0,3}\[\^[^\]]+\]:/, 'footnote text'],
    [/^ {0,3}\*\[[^\]]+\]:/, 'abbreviation'],
    [/^ {0,3}\[[^\]]+\]:/, 'link reference'],
];

/** Sentences of the classifier, by their start, in words. */
const SENTENCES: readonly [RegExp, string][] = [
    [/^setext heading/, 'setext heading'],
    [/^heading attributes/, 'heading attributes'],
    [/^container attributes/, 'container attributes'],
    [/^admonition with more than one class/, 'admonition'],
    [/^emoji /, 'emoji'],
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
    for (const [re, words] of SENTENCES) {
        if (re.test(reason)) {
            return words;
        }
    }
    // `dl_open`, `inline footnote_ref`, `nested html_block`, `footnote_ref inside another note`: the token is the reason.
    const token = /^(?:inline |nested )?([a-z_]+)/.exec(reason)?.[1];
    return token !== undefined ? TOKEN_WORDS.get(token) ?? null : null;
}
