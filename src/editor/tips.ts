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
    note?: Said | null;
}

/**
 * What a message says: plain words, or parts where it names a value the person
 * typed or should type (`Not set: ` + `{code: 'width = 300'}` + ` has spaces
 * around …`). A refusal is one: drawn with the values in muted mono, heard and
 * tested as one string (`saidText`).
 */
export type Said = string | readonly TipPart[];

/** Parts as one string: a `keys` part is set off by an em dash. */
function partsText(parts: readonly TipPart[]): string {
    return parts.map(p => typeof p === 'string' ? p : 'code' in p ? p.code : ` — ${p.keys}`).join('');
}

/** What `s` says as one string: what is announced, what a tooltip's `aria-description` carries and the tests read. */
export function saidText(s: Said): string {
    return typeof s === 'string' ? s : partsText(s);
}

/** `s` as parts: a string is one part. */
export function saidParts(s: Said): readonly TipPart[] {
    return typeof s === 'string' ? [s] : s;
}

/**
 * A value named in a message: in the code font; a single character also
 * quoted in plain quotes, so a lone `|` or `=` does not read as punctuation of
 * the sentence (ux-critic #10 (b)).
 */
export function value(v: string): TipPart[] {
    return [...v].length === 1 ? ['"', { code: v }, '"'] : [{ code: v }];
}

/**
 * A message written as a sentence with its values in it:
 * ``said`Not set: ${value(v)} isn't closed.` `` — an interpolated part or list of
 * parts stays parts, a number is words. Adjacent words are joined, so the
 * result has as few parts as it can.
 */
export function said(strings: TemplateStringsArray, ...values: readonly (TipPart | readonly TipPart[] | number)[]): TipPart[] {
    const out: TipPart[] = [];
    const push = (p: TipPart) => {
        if (typeof p === 'string') {
            if (p === '') {
                return;
            }
            const last = out[out.length - 1];
            if (typeof last === 'string') {
                out[out.length - 1] = last + p;
                return;
            }
        }
        out.push(p);
    };
    strings.forEach((s, i) => {
        push(s);
        if (i < values.length) {
            const v = values[i];
            if (Array.isArray(v)) {
                (v as readonly TipPart[]).forEach(push);
            } else {
                push(typeof v === 'number' ? String(v) : (v as TipPart));
            }
        }
    });
    return out;
}

/** The tip as one string: `Italic (*, <i>) — Ctrl+I`, the note after a newline. */
export function tipText(tip: Tip): string {
    const line = partsText(tip.parts);
    const note = tip.note ? saidText(tip.note) : '';
    return note ? `${line}\n${note}` : line;
}

/** The tip without its key chord: what a control whose `aria-keyshortcuts` names the key describes itself with. */
export function withoutKeys(tip: Tip): Tip {
    return { ...tip, parts: tip.parts.filter(p => typeof p === 'string' || !('keys' in p)) };
}

/** A tip of plain words, with its note. */
export function plainTip(text: string, note?: Said | null): Tip {
    return { parts: [text], note: note ?? null };
}
