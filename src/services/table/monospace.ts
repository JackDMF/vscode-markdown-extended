// http://www.unicode.org/Public/10.0.0/ucd/Scripts.txt
// https://en.wikipedia.org/wiki/CJK_Symbols_and_Punctuation
// https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt (W and F)
const ranges = [
    "\\p{Script=Han}",
    "\\p{Script=Katakana}",
    "\\p{Script=Hiragana}",
    "\\p{Script=Hangul}",
    "\\p{Script=Tangut}",
    "\\p{Script=Nushu}",
    "\\p{Script=Bopomofo}",
    "\\p{Script=Yi}",
    // FULLWIDTH
    "！-｠", "￠-￦",
    // Arrows
    "←-↙",
    // BOX DRAWINGS
    "─-▶",
    // Angle brackets
    "〈〉",
    // CJK Radicals, Kangxi Radicals, Ideographic Description
    "⺀-⿿",
    // Punctuation
    "　-〿", "゛゜",
    // Japanese Punctuation
    "゙-゜", "゠", "・ー",
    // Kanbun, CJK Strokes, Enclosed CJK Letters, CJK Compatibility
    "㆐-㆟", "㇀-㇯", "㈀-㏿",
    // Vertical Forms, CJK Compatibility Forms, Small Form Variants
    "︐-︙", "︰-﹯",
    // Enclosed Ideographic Supplement
    "\u{1F200}-\u{1F2FF}",
    // Extra
    "○",
]
/** A cluster whose first character is wide or fullwidth. */
const CJKV_REG = new RegExp('^[' + ranges.join('') + ']', "u");
/** Halfwidth forms, which the scripts above hold too (ｶ, ﾡ): one column. */
const HALFWIDTH_REG = /^[｡-ￜ￨-￮]/u;

/** A cluster that takes no column: a combining mark, a variation selector, a joiner or a tag on its own. */
const ZERO_WIDTH_REG = /^[\p{M}​-‏⁠-⁤﻿\u{E0000}-\u{E007F}]/u;
/** A cluster drawn as an emoji unless it asks otherwise: 🍉, a flag's regional indicators, a skin tone. */
const EMOJI_PRESENTATION_REG = /^\p{Emoji_Presentation}/u;
/** A cluster whose first character is an emoji when the cluster asks for it: ☝, ❤, a keycap's digit. */
const EMOJI_REG = /^[\p{Emoji}\p{Extended_Pictographic}]/u;
/** What asks for an emoji: VS16, a keycap, a skin tone, a joiner. */
const EMOJI_REQUEST_REG = /[️⃣‍\p{Emoji_Modifier}]/u;
/** VS15, which asks for the text form. */
const TEXT_PRESENTATION = "︎";

/** The part of `Intl.Segmenter` read here (the project's `lib` predates its typings). */
export interface GraphemeSegmenter { segment(text: string): Iterable<{ segment: string }> }
const segmenterClass = (Intl as unknown as { Segmenter?: new () => GraphemeSegmenter }).Segmenter;
const SEGMENTER: GraphemeSegmenter | null = typeof segmenterClass === "function" ? new segmenterClass() : null;

/**
 * Where no `Intl.Segmenter` exists: a cluster is a code point (a pair of
 * regional indicators, a flag, as one) with the marks, skin tones and tags
 * after it, and a joiner with the code point it joins.
 */
const CLUSTER_REG = /(?:\p{RI}\p{RI}|[^])(?:[\p{M}\p{Emoji_Modifier}\u{E0020}-\u{E007F}]|‍[^]?)*/gu;

/**
 * The grapheme clusters of a text: what a reader sees as one character.
 * @param text text to split
 * @param segmenter what splits it; `null` splits by the rule above
 */
export function graphemeClusters(text: string, segmenter: GraphemeSegmenter | null = SEGMENTER): string[] {
    if (segmenter) {return Array.from(segmenter.segment(text), s => s.segment);}
    return text.match(CLUSTER_REG) ?? [];
}

/**
 * The monospace columns one grapheme cluster takes: 2 for a wide or fullwidth
 * character and for an emoji, 0 for a mark, joiner or selector on its own, else 1.
 */
function clusterWidth(cluster: string): number {
    if (ZERO_WIDTH_REG.test(cluster)) {return 0;}
    if (cluster.includes(TEXT_PRESENTATION)) {return isWide(cluster) ? 2 : 1;}
    if (EMOJI_PRESENTATION_REG.test(cluster)) {return 2;}
    if (EMOJI_REG.test(cluster) && EMOJI_REQUEST_REG.test(cluster)) {return 2;}
    return isWide(cluster) ? 2 : 1;
}

/** Whether a cluster's first character is wide or fullwidth. */
function isWide(cluster: string): boolean {
    return CJKV_REG.test(cluster) && !HALFWIDTH_REG.test(cluster);
}

/**
 * Calculate the Monospace Length of a string, counted by grapheme cluster: a
 * CJK, fullwidth or emoji character as length of 2, a combining mark as 0.
 * Format Table and the Visual Editor's table writer both pad a column by it.
 * @param text text to calculate
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export function MonoSpaceLength(text: string): number {
    return graphemeClusters(text).reduce((width, cluster) => width + clusterWidth(cluster), 0);
}

// console.log(
//     unicodeRangeHelper(
//         // Arrows
//         "○←-↙",
//     )
// );
// function unicodeRangeHelper(...inputs) {
//     let range=inputs.join('');
//     let points = [];
//     for (let i = 0; i < range.length; i++) {
//         let current = range[i];
//         let code = current.charCodeAt(0);
//         let next1 = i < range.length - 1 ? range[i + 1] : "";
//         let next2 = i < range.length - 2 ? range[i + 2] : "";
//         if (next1 == '-' && next2) {
//             for (let c = code; c <= next2.charCodeAt(0); c++) {
//                 points.push(c);
//             }
//             i += 2;
//         } else {
//             points.push(code);
//             continue;
//         }
//     }
//     return String.fromCharCode(...points);
// }
