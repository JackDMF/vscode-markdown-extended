import { INLINE_MARKERS, InlineMarkerName } from '../syntax/markers';
import { escapeRegExp } from '../syntax/regExp';

/** What `toggleFormat` takes for one toggle: detect, multi-line, on, on-replacement, off, off-replacement. */
export type ToggleArgs = [RegExp, boolean, RegExp, string, RegExp, string];

/**
 * The arguments of an inline toggle command, built from its marker in the
 * shared table (`src/syntax/markers.ts`) — the table the Visual Editor's
 * toolbar reads too, so the text editor's toggles and the toolbar cannot write
 * a construct differently.
 *
 * `guarded` adds the look-ahead the single-character markers `*` and `~` have
 * always carried, so the expressions are exactly the ones written out by hand
 * before the table existed (`test/unit/commands/inlineToggleArgs.test.ts`
 * holds them to that). Kept apart from `toggleFormats.ts`, which registers its
 * commands as it loads, so a test can import it.
 */
export function inlineToggleArgs(name: InlineMarkerName, guarded = false): ToggleArgs {
    const marker = INLINE_MARKERS[name];
    const m = escapeRegExp(marker);
    const guard = guarded ? `(?!=${m})` : '';
    const detect = () => new RegExp(`${m}(\\S.*?\\S)${m}${guard}`, 'ig');
    return [detect(), false, /(.+)/ig, `${marker}$1${marker}`, detect(), '$1'];
}
