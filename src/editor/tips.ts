/**
 * A tooltip as data: its parts — words, a piece in the code font (a
 * delimiter, an element), a key chord — and a note on a line of its own (why
 * the control is refused). The hover (`webview/tooltip.ts`) draws the parts
 * apart; `tipText` is the same tip as one string, which the control's
 * `aria-description` carries and the tests read. One structure, two
 * projections, so what is seen and what is heard cannot differ.
 *
 * No ProseMirror and no DOM here, so every module can read it.
 */

/** A part of a tip: words; `code`, in the editor's code font; `keys`, a chord already named for the platform (`Ctrl+I`). */
export type TipPart = string | { code: string } | { keys: string };

export interface Tip {
    parts: readonly TipPart[];
    /** The reason or refusal, on a second line. */
    note?: string | null;
}

/** The tip as one string: `Italic (*, <i>) — Ctrl+I`, the note after a newline. A `keys` part is set off by an em dash. */
export function tipText(tip: Tip): string {
    const line = tip.parts.map(p => typeof p === 'string' ? p : 'code' in p ? p.code : ` — ${p.keys}`).join('');
    return tip.note ? `${line}\n${tip.note}` : line;
}

/** A tip of plain words, with its note. */
export function plainTip(text: string, note?: string | null): Tip {
    return { parts: [text], note: note ?? null };
}
