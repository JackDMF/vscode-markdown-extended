import { NOTE_SEPARATOR, NOTE_SYNTAX } from '../syntax/markers';
import type { SourcePosition } from './positions';

/**
 * Aligning a block's text as the engine reads it with the block's source.
 *
 * Two readers ask where a character of the engine's text stands in the file:
 * the Visual Editor's position map (`positions.ts`), whose units are a
 * ProseMirror block's text, and the text editor's inline toggles
 * (`inlineSource.ts`), whose units are an inline token's. Both hand this module
 * a sequence of units and the block's source; the delimiters between them —
 * markers, prefixes, a link's URL — are what the alignment leaves unmatched.
 * `positions.ts` states how the alignment scores and where it is exact.
 */

export const NEWLINE = 10;
export const CARRIAGE_RETURN = 13;

const LINE_BREAK = /\r\n|\r|\n/g;

/** Offsets ↔ lines of one text, broken as VS Code breaks them. */
export class Lines {
    /** The offset each line starts at. */
    private readonly starts: number[] = [0];
    /** The offset each line's text ends at, before its terminator. */
    private readonly ends: number[] = [];

    constructor(private readonly text: string) {
        LINE_BREAK.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = LINE_BREAK.exec(text)) !== null) {
            this.ends.push(m.index);
            this.starts.push(m.index + m[0].length);
        }
        this.ends.push(text.length);
    }

    positionAt(offset: number): SourcePosition {
        const o = Math.max(0, Math.min(offset, this.text.length));
        let low = 0;
        let high = this.starts.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (this.starts[mid] <= o) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return { line: low, character: Math.min(o, this.ends[low]) - this.starts[low] };
    }

    /** The offset of a position, clamped into the text (and then approximate); `null` for one that is no position. */
    offsetAt(position: SourcePosition): { offset: number; approximate: boolean } | null {
        const { line, character } = position ?? ({} as SourcePosition);
        if (!Number.isInteger(line) || !Number.isInteger(character)) {
            return null;
        }
        if (line < 0) {
            return { offset: 0, approximate: true };
        }
        if (line >= this.starts.length) {
            return { offset: this.text.length, approximate: true };
        }
        const length = this.ends[line] - this.starts[line];
        const clamped = Math.max(0, Math.min(character, length));
        return { offset: this.starts[line] + clamped, approximate: clamped !== character };
    }
}

// ---------------------------------------------------------------------------
// Units: a block's page text as a sequence
// ---------------------------------------------------------------------------

/** A unit that matches no source character: an image, an inline atom (a badge). */
export const UNMATCHABLE = -1;

/**
 * One element of a block's page text: a UTF-16 code unit of a text node, an
 * inline leaf, or an anchor. `pos` is relative to the block's start, `-1` for
 * an anchor, which is no position; `code` is what it matches in the source.
 */
export interface Unit {
    pos: number;
    code: number;
}

/** The markers the notes plugin reads around a note's parts (`markdownItSidenote.ts`), as anchors. */
export const NOTE_ANCHORS: Readonly<Record<string, { open: string; between?: string; close: string }>> = {
    sidenote: { open: NOTE_SYNTAX.sidenote.marker, between: NOTE_SEPARATOR, close: NOTE_SYNTAX.sidenote.marker },
    marginal_note: { open: NOTE_SYNTAX.marginalNote.marker, between: NOTE_SEPARATOR, close: NOTE_SYNTAX.marginalNote.marker },
    left_sidebar: { open: NOTE_SYNTAX.leftSidebar.marker, close: NOTE_SYNTAX.leftSidebar.marker },
    right_sidebar: { open: NOTE_SYNTAX.rightSidebar.marker, close: NOTE_SYNTAX.rightSidebar.marker },
};

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/** A matched character is worth more than any number of gap runs a block can have. */
const MATCH = 65536;
/** The band's budget in cells; a larger block is aligned greedily. */
const MAX_CELLS = 4_000_000;
/** How far the greedy fallback looks ahead for a unit's character. */
const GREEDY_WINDOW = 256;

const H = 0;
const X = 1;
const Y = 2;

export interface Alignment {
    /** For each unit, the index of the source character it matches, or `-1`. */
    toSource: Int32Array;
    /** For each source character, the unit matching it, or `-1`. */
    toUnit: Int32Array;
    exact: boolean;
}

/**
 * Align the page units with the (normalized) source text: maximal matches,
 * then fewest gap runs, a source gap run that starts a line free, ties to the
 * earlier match. States: `H` ends in a match, `X` in a source gap (a delimiter),
 * `Y` in a page gap (a unit the source spells otherwise). Rows are units,
 * columns the diagonals `i - j` in `[lo, hi]`, which hold every path whose page
 * gaps number no more than `slack`.
 */
export function align(src: string, units: readonly Unit[]): Alignment {
    const n = src.length;
    const m = units.length;
    const toSource = new Int32Array(m).fill(-1);
    const toUnit = new Int32Array(n).fill(-1);
    if (n === 0 || m === 0) {
        return { toSource, toUnit, exact: true };
    }
    let slack = 32;
    for (const unit of units) {
        slack += unit.code === UNMATCHABLE ? 1 : 0;
    }
    const lo = Math.min(0, n - m) - slack;
    const hi = Math.max(0, n - m) + slack;
    const width = hi - lo + 1;
    if ((m + 1) * width > MAX_CELLS) {
        alignGreedily(src, units, toSource, toUnit);
        return { toSource, toUnit, exact: false };
    }
    // Per cell: bits 0–1 the state before an H, 2–3 before an X, 4–5 before a Y.
    const trace = new Uint8Array((m + 1) * width);
    let pH = new Float64Array(width).fill(-Infinity);
    let pX = new Float64Array(width).fill(-Infinity);
    let pY = new Float64Array(width).fill(-Infinity);
    let cH = new Float64Array(width);
    let cX = new Float64Array(width);
    let cY = new Float64Array(width);
    for (let j = 0; j <= m; j++) {
        cH.fill(-Infinity);
        cX.fill(-Infinity);
        cY.fill(-Infinity);
        const code = j > 0 ? units[j - 1].code : UNMATCHABLE;
        for (let k = 0; k < width; k++) {
            const i = j + lo + k;
            if (i < 0 || i > n) {
                continue;
            }
            if (i === 0 && j === 0) {
                cH[k] = 0;
                continue;
            }
            let bits = 0;
            if (i > 0 && j > 0 && code !== UNMATCHABLE && src.charCodeAt(i - 1) === code) {
                let best = pX[k];
                let from = X;
                if (pH[k] > best) {
                    best = pH[k];
                    from = H;
                }
                if (pY[k] > best) {
                    best = pY[k];
                    from = Y;
                }
                if (best > -Infinity) {
                    cH[k] = best + MATCH;
                    bits |= from;
                }
            }
            if (i > 0 && k > 0) {
                // A delimiter run costs one, unless it starts a line.
                const open = i === 1 || src.charCodeAt(i - 2) === NEWLINE ? 0 : 1;
                let best = cX[k - 1];
                let from = X;
                if (cY[k - 1] - open > best) {
                    best = cY[k - 1] - open;
                    from = Y;
                }
                if (cH[k - 1] - open > best) {
                    best = cH[k - 1] - open;
                    from = H;
                }
                cX[k] = best;
                bits |= from << 2;
            }
            if (j > 0 && k + 1 < width) {
                let best = pY[k + 1];
                let from = Y;
                if (pH[k + 1] - 1 > best) {
                    best = pH[k + 1] - 1;
                    from = H;
                }
                if (pX[k + 1] - 1 > best) {
                    best = pX[k + 1] - 1;
                    from = X;
                }
                cY[k] = best;
                bits |= from << 4;
            }
            trace[j * width + k] = bits;
        }
        [pH, cH] = [cH, pH];
        [pX, cX] = [cX, pX];
        [pY, cY] = [cY, pY];
    }
    // The last row is in `p*` now. Ends in a delimiter first: matches as early as they can be.
    const end = n - m - lo;
    let state = X;
    let best = pX[end];
    if (pH[end] > best) {
        best = pH[end];
        state = H;
    }
    if (pY[end] > best) {
        best = pY[end];
        state = Y;
    }
    if (best === -Infinity) {
        alignGreedily(src, units, toSource, toUnit);
        return { toSource, toUnit, exact: false };
    }
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const bits = trace[j * width + (i - j - lo)];
        if (state === H) {
            toSource[j - 1] = i - 1;
            toUnit[i - 1] = j - 1;
            state = bits & 3;
            i--;
            j--;
        } else if (state === X) {
            state = (bits >> 2) & 3;
            i--;
        } else {
            state = (bits >> 4) & 3;
            j--;
        }
    }
    return { toSource, toUnit, exact: true };
}

/** Each unit matched to the next occurrence of its character, a little way ahead at most. */
function alignGreedily(src: string, units: readonly Unit[], toSource: Int32Array, toUnit: Int32Array): void {
    let cursor = 0;
    units.forEach((unit, j) => {
        if (unit.code === UNMATCHABLE) {
            return;
        }
        const limit = Math.min(src.length, cursor + GREEDY_WINDOW);
        for (let i = cursor; i < limit; i++) {
            if (src.charCodeAt(i) === unit.code) {
                toSource[j] = i;
                toUnit[i] = j;
                cursor = i + 1;
                return;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Line breaks
// ---------------------------------------------------------------------------

/** A block's body with every line break one `\n`, and the way back to the body as written. */
export interface Normalized {
    src: string;
    /** For each normalized index, and one past the end, the offset in the body. */
    toBody: Int32Array;
    /** For each body offset, and one past the end, the normalized index. */
    fromBody: Int32Array;
}

export function normalize(body: string): Normalized {
    const toBody = new Int32Array(body.length + 1);
    const fromBody = new Int32Array(body.length + 1);
    let src = '';
    for (let i = 0; i < body.length; i++) {
        fromBody[i] = src.length;
        toBody[src.length] = i;
        if (body.charCodeAt(i) === CARRIAGE_RETURN) {
            // `\r\n` or a lone `\r`: one break, standing where the `\r` is.
            if (body.charCodeAt(i + 1) === NEWLINE) {
                fromBody[i + 1] = src.length;
                i++;
            }
            src += '\n';
            continue;
        }
        src += body[i];
    }
    fromBody[body.length] = src.length;
    toBody[src.length] = body.length;
    return { src, toBody: toBody.subarray(0, src.length + 1), fromBody };
}
