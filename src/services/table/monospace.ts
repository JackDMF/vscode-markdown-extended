import { eastAsianWidth } from 'get-east-asian-width';

/**
 * Text measured as its length, without segmenting: printable ASCII, the
 * Latin-1 and Latin Extended-A and -B letters (U+00A0–U+024F) and the
 * punctuation U+2010–U+2027 (dashes, quotes, the ellipsis). Each of them takes
 * one column by the rules below and none joins a cluster with its neighbour —
 * checked over every code point in the ranges. Most cells are such text.
 */
const PLAIN_TEXT_REG = /^[\x20-\x7E\u00A0-\u024F\u2010-\u2027]*$/;

/** Whether a text is plain (above), so its monospace length is its length. */
export function isPlainText(text: string): boolean {
    return PLAIN_TEXT_REG.test(text);
}

/**
 * Takes no column: a nonspacing or enclosing mark (a combining accent, Thai
 * tone marks, a keycap's U+20E3), a variation selector, a zero-width space,
 * a joiner or a direction mark, the BOM, a tag.
 */
const ZERO_WIDTH_REG = /^[\p{Mn}\p{Me}\u200B-\u200F\u2060-\u2064\uFEFF\u{E0000}-\u{E007F}]$/u;

/**
 * A cluster drawn as an emoji although its first character defaults to text:
 * a character with VS16 or a keycap (❤ VS16, 1 VS16 U+20E3), a ZWJ
 * sequence (❤ VS16 ZWJ 🔥). A text-default emoji without one (❤, ☀, ⚠)
 * counts as text, 1, as Unicode's width gives it: how wide it is drawn
 * depends on the font — where the font has no glyph for it, a colour-emoji
 * font draws it, at whatever width that font has (Consolas: ❤ 1.77 columns,
 * ☝ 2.5) — so no whole number is right everywhere.
 */
const EMOJI_SEQUENCE_REG = /^(?:\p{Emoji}[\uFE0F\u20E3]|\p{Extended_Pictographic}[^]*\u200D)/u;

/** What splits a text into grapheme clusters, where the runtime has one (not Firefox before 125, Safari before 14.1). */
const SEGMENTER: Intl.Segmenter | null = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter() : null;

/**
 * The monospace columns one grapheme cluster takes, from its whole content:
 * the East Asian Width of each character it holds — 2 for wide and fullwidth
 * (CJK, kana, the emoji Unicode makes wide), 1 for the rest, ambiguous
 * included, 0 for the characters above — capped at 2, since a cluster is
 * drawn in one or two columns: Thai น้ำ is 2 (its ำ is spacing), a + 🏽 is 2,
 * 🍉 with VS15 is still 2. An emoji sequence is 2.
 */
function clusterWidth(cluster: string): number {
    if (EMOJI_SEQUENCE_REG.test(cluster)) {return 2;}
    let width = 0;
    for (const character of cluster) {
        if (!ZERO_WIDTH_REG.test(character)) {
            width += eastAsianWidth(character.codePointAt(0));
        }
    }
    return Math.min(width, 2);
}

/**
 * The monospace width of a text, by grapheme cluster, without the plain-text
 * shortcut. With no segmenter each code point is measured as a cluster by the
 * same rules, so an emoji sequence counts as the sum of its parts.
 * @param text text to calculate
 * @param segmenter what splits it; `null` measures by code point
 */
export function clustersWidth(text: string, segmenter: Intl.Segmenter | null = SEGMENTER): number {
    let width = 0;
    if (segmenter) {
        for (const { segment } of segmenter.segment(text)) {
            width += clusterWidth(segment);
        }
    } else {
        for (const character of text) {
            width += clusterWidth(character);
        }
    }
    return width;
}

/**
 * Calculate the Monospace Length of a string, counted by grapheme cluster: a
 * wide, fullwidth or emoji character as length of 2, a combining mark as 0.
 * Format Table and the Visual Editor's table writer both pad a column by it.
 * @param text text to calculate
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function MonoSpaceLength(text: string): number {
    return isPlainText(text) ? text.length : clustersWidth(text);
}
