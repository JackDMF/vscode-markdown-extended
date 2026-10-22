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
    /** The reason or refusal, on a second line: words, or parts where it names syntax (`Over plain text: … — [text]{.class}`). */
    note?: string | readonly TipPart[] | null;
}

/** Parts as one string: a `keys` part is set off by an em dash. */
function partsText(parts: readonly TipPart[]): string {
    return parts.map(p => typeof p === 'string' ? p : 'code' in p ? p.code : ` — ${p.keys}`).join('');
}

/** The tip as one string: `Italic (*, <i>) — Ctrl+I`, the note after a newline. */
export function tipText(tip: Tip): string {
    const line = partsText(tip.parts);
    const note = typeof tip.note === 'string' ? tip.note : tip.note ? partsText(tip.note) : '';
    return note ? `${line}\n${note}` : line;
}

/** The tip without its key chord: what a control whose `aria-keyshortcuts` names the key describes itself with. */
export function withoutKeys(tip: Tip): Tip {
    return { ...tip, parts: tip.parts.filter(p => typeof p === 'string' || !('keys' in p)) };
}

/** A tip of plain words, with its note. */
export function plainTip(text: string, note?: string | null): Tip {
    return { parts: [text], note: note ?? null };
}
