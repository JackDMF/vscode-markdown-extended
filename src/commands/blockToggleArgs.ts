/** What `toggleFormat` takes for one block toggle: detect, on, on-replacement, off, off-replacement. */
export type ToggleArgs = [RegExp, RegExp, string, RegExp, string];

/**
 * The arguments of the block toggle commands. Kept apart from
 * `toggleFormats.ts`, which registers its commands as it loads, so a test can
 * import them.
 */
export const BLOCK_TOGGLE_ARGS: { [name in 'codeBlock' | 'uList' | 'oList' | 'blockQuote']: ToggleArgs } = {
    codeBlock: [
        /^```\r?\n[\S\s]+\r?\n```\s*$/ig,
        /((?:\S|\s)+)/ig, "```\n$1\n```",
        /^```\r?\n([\S\s]+)\r?\n```\s*$/ig, "$1",
    ],
    uList: [
        /((^|\n)-\s+(.+)\s*(?=$|\n))+/ig,
        /(^|\n)\s*(.+?)\s*(?=$|\n)/ig, "$1- $2",
        /(^|\n)-\s+(.+)\s*(?=$|\n)/ig, "$1$2",
    ],
    oList: [
        /((^|\n)(?:\d+\.)\s+(.+)\s*(?=$|\n))+/ig,
        /(^|\n)\s*(.+?)\s*(?=$|\n)/ig, "$11. $2",
        /(^|\n)(?:\d+\.)\s+(.+)\s*(?=$|\n)/ig, "$1$2",
    ],
    blockQuote: [
        /((^|\n)>[^\S\n]*(.*?)[^\S\n]*(?=$|\n))+/ig,
        /(^|\n)[^\S\n]*(.*?)[^\S\n]*(?=$|\n)/ig, "$1> $2",
        /(^|\n)>[^\S\n]+(.*?)[^\S\n]*(?=$|\n)/ig, "$1$2",
    ],
};
