import { INLINE_MARKERS, InlineMarkerName } from '../syntax/markers';

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What `toggleFormat` takes for one toggle: detect, multi-line, on, on-replacement, off, off-replacement. */
export type ToggleArgs = [RegExp, boolean, RegExp, string, RegExp, string];

/**
 * The arguments of an inline toggle command, built from its marker in the
 * shared table (`src/syntax/markers.ts`) — the table the Visual Editor's
 * toolbar reads too, so the text editor's toggles and the toolbar cannot write
 * a construct differently.
 *
 * `detect` finds a span the toggle wrote: one character or more, with no
 * space inside either marker, the shortest first, so `**a****b**` is two spans.
 * `guarded` is for the single-character markers `*` and `~`, which are also
 * half of `**` and `~~`: neither of its markers may stand next to another, so
 * italics does not take a bold span's markers for its own. Underline's `_`
 * is guarded the same way and, as in Markdown, is no marker inside a word.
 * Kept apart from
 * `toggleFormats.ts`, which registers its commands as it loads, so a test can
 * import it (`test/unit/commands/inlineToggleArgs.test.ts`).
 */
export function inlineToggleArgs(name: InlineMarkerName, guarded = false): ToggleArgs {
    const marker = INLINE_MARKERS[name];
    const m = escapeRegExp(marker);
    let open = guarded ? `(?<!${m})${m}(?!${m})` : m;
    let close = open;
    if (marker === '_') {
        // `_` does not open or close inside a word: `_snake_case_` is one span.
        open = `(?<!\\w)_(?!_)`;
        close = `(?<!_)_(?!\\w)`;
    }
    const detect = () => new RegExp(`${open}(\\S(?:.*?\\S)??)${close}`, 'ig');
    return [detect(), false, /(.+)/ig, `${marker}$1${marker}`, detect(), '$1'];
}
