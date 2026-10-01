import { eastAsianWidth } from 'get-east-asian-width';

/** A text of printable ASCII only, one column per character: most cells, measured without segmenting. */
const PRINTABLE_ASCII_REG = /^[\x20-\x7E]*$/;

/** Whether a text is printable ASCII only, so its monospace length is its length. */
export function isPrintableAscii(text: string): boolean {
    return PRINTABLE_ASCII_REG.test(text);
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
 * sequence (❤ VS16 ZWJ 🔥). A
 * text-default emoji without one (❤, ☀, ⚠) counts as text: whether it is
 * drawn one or two columns wide depends on the font, and most monospace
 * fonts draw it as one.
 */
const EMOJI_SEQUENCE_REG = /^(?:\p{Emoji}[\uFE0F\u20E3]|\p{Extended_Pictographic}[^]*\u200D)/u;

const SEGMENTER = new Intl.Segmenter();

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
 * Calculate the Monospace Length of a string, counted by grapheme cluster: a
 * wide, fullwidth or emoji character as length of 2, a combining mark as 0.
 * Format Table and the Visual Editor's table writer both pad a column by it.
 * @param text text to calculate
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function MonoSpaceLength(text: string): number {
    if (isPrintableAscii(text)) {return text.length;}
    let width = 0;
    for (const { segment } of SEGMENTER.segment(text)) {
        width += clusterWidth(segment);
    }
    return width;
}
