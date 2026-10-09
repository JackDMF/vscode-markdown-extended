import { full as markdownItEmoji } from 'markdown-it-emoji';
import shortcuts from 'markdown-it-emoji/lib/data/shortcuts.mjs';
import { MarkdownIt, StateBase, Token } from '../@types/markdown-it';
import { EMOJI_PLACES_OPTION } from '../syntax/markers';
import { hasEnabledRule } from './shared';

// markdown-it-emoji, recording where each emoji was spelled. The plugin's
// core rule splits a text token into text and `emoji` tokens and keeps no
// trace of the spelling: `:)` and `:-)` are both `smiley`, with no `map` and
// no `meta`. The Visual Editor edits an emoji the file holds as one atom and
// writes it back as written, so each token gets its spelling as
// `meta.source`, read off what the plugin did rather than by a rule of its
// own: the inline tokens' children are set aside before the rule
// (`mep_emoji_aside`) and compared after it (`mep_emoji_back`). The plugin
// replaces a split text token's children array whole, so a changed array is
// one it split, and each text token it split is replaced by a run of its
// pieces: the text pieces are the token's own text, verbatim, and the
// emoji between them are spelled by what of the token's text they cover.
// Where several emoji stand together, that text is divided among them by
// their candidate spellings — `:name:` and the aliases of the plugin's own
// shortcut table, read from the package — and only where exactly one
// division fits; otherwise, or where a spelling is none of the table's (a
// table of the caller's own), `source` is `null`. A note's parts are parsed
// with the same engine (`markdownItSidenote.ts`), so their emoji carry it too.
//
// In the Visual Editor's engine (`EMOJI_PLACES_OPTION`, set by `baseEngine`)
// each emoji also carries where it stands (`meta.at`): its offset in the text
// of the inline token it was read in (`content`, the text the inline rules
// read), from the plugin's own match — the offset of its spelling in the text
// token it split, plus where that text token begins. Where a text token begins
// is recorded as the rules that make it make it, never searched for:
//
// - the inline rules' pending text, where it began (`mep_text_start`, the
//   first inline rule, and each state's `pushPending`);
// - adjacent text tokens joined into the last of them (`fragments_join`):
//   where the first of them began (`mep_text_runs`, right before that rule);
// - the pieces linkify splits a text token into (`mep_linkify_aside`,
//   `mep_linkify_back` around its core rule): each text piece after the text
//   before it, which is a verbatim slice of the token, and after a link's text
//   where that text stands there as written.
//
// Where a beginning is not known — a link whose text linkify normalised, a
// note's text token the note's own parse joined with an escape (`\:)`), whose
// text is no longer the source — the emoji's place is `null`, never a guess.
// The Visual Editor pairs each atom it writes with the emoji read at the
// place it wrote it (`unreadEmoji` in `serialize.ts`) and refuses an edit it
// cannot place an atom in. The preview's engine records no place: the
// preview never asks.


/** The core rule markdown-it-emoji adds, which splits text tokens into text and `emoji` tokens. */
export const EMOJI_RULE = 'emoji';

/** The meta key of an emoji token's spelling: the text the plugin read it from, or `null` where that cannot be told. */
export const EMOJI_SOURCE_META = 'source';

/** The meta key of an emoji token's place: the offset of its spelling in its inline token's `content`, or `null` (`EMOJI_PLACES_OPTION`). */
export const EMOJI_AT_META = 'at';

/** markdown-it-emoji's own shortcut table, as the package ships it: each emoji name's aliases. The one reading of it (`emojiShortcuts.ts` too). */
export const EMOJI_ALIASES: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
    Object.entries(shortcuts as Record<string, string | string[]>).map(([name, aliases]) => [name, Array.isArray(aliases) ? aliases : [aliases]]),
);

/**
 * Each text token's place, as the rules that made it made it: where in the
 * inline token's `content` its text began, and that text. A later rule may cut
 * an end off it (markdown-it-attrs a `{…}`), which `startOf` reads. Kept beside
 * the token, not in its `meta`, which every other reader of a text token sees.
 */
const textStarts = new WeakMap<Token, { start: number; text: string }>();

/** Where the pending text of an inline parse began, by its state. */
const pendingStarts = new WeakMap<object, number>();

/**
 * `copy`, a copy of `token` (a token a parse of a part of the text made, a
 * note's reference or body, copied into the parse of the whole,
 * `markdownItSidenote.ts`), with the places this plugin noted on `token` moved
 * by `by` characters, where the part stands in the whole.
 */
export function shiftPlaces(copy: Token, token: Token, by: number): void {
    const meta = copy.meta as Record<string, unknown> | null | undefined;
    if (meta && typeof meta[EMOJI_AT_META] === 'number') {
        copy.meta = { ...meta, [EMOJI_AT_META]: (meta[EMOJI_AT_META] as number) + by };
    }
    const noted = textStarts.get(token);
    if (noted !== undefined) {
        textStarts.set(copy, { start: noted.start + by, text: noted.text });
    }
}

/** Each inline token's children as they stood before a core rule, by the parse and the rule. */
const setAside = new WeakMap<StateBase, Map<string, Map<Token, Token[]>>>();

/** Every way `name` can be spelled: its shortcode, then the table's aliases. */
function spellingsOf(name: string): string[] {
    return [`:${name}:`, ...(EMOJI_ALIASES[name] ?? [])];
}

/**
 * Every division of `text` from `pos` among the emoji `names`, in order, that
 * ends where `after` starts (the end of `text` when `after` is `null`);
 * at most two, which is enough to tell one from several.
 */
function divisions(text: string, pos: number, names: readonly string[], after: string | null): string[][] {
    if (names.length === 0) {
        return (after === null ? pos === text.length : text.startsWith(after, pos)) ? [[]] : [];
    }
    const out: string[][] = [];
    for (const spelling of spellingsOf(names[0])) {
        if (out.length < 2 && text.startsWith(spelling, pos)) {
            for (const rest of divisions(text, pos + spelling.length, names.slice(1), after)) {
                out.push([spelling, ...rest]);
            }
        }
    }
    return out;
}

function setSource(token: Token, source: string | null, at: number | null | undefined): void {
    token.meta = { ...((token.meta as Record<string, unknown> | null) ?? {}), [EMOJI_SOURCE_META]: source, ...(at === undefined ? {} : { [EMOJI_AT_META]: at }) };
}

/**
 * Give each emoji of `run`, the pieces the plugin split a text token holding
 * `text` into, its spelling, and — `whole` given, the inline token's text —
 * its place in it, where the text token begins at `start`.
 */
function spell(text: string, run: readonly Token[], whole: string | null, start: number | null): void {
    let pos = 0;
    let pending: Token[] = [];
    const placed = (at: number | null, spelling: string) => (whole === null ? undefined : at !== null && whole.startsWith(spelling, at) ? at : null);
    const flush = (after: string | null) => {
        if (pending.length === 0) {
            return;
        }
        const ways = divisions(text, pos, pending.map(t => t.markup), after);
        if (ways.length === 1) {
            ways[0].forEach((spelling, i) => {
                setSource(pending[i], spelling, placed(start === null ? null : start + pos, spelling));
                pos += spelling.length;
            });
        } else {
            pending.forEach(t => setSource(t, null, whole === null ? undefined : null));
            const next = after === null ? -1 : text.indexOf(after, pos);
            pos = next < 0 ? text.length : next;
        }
        pending = [];
    };
    for (const token of run) {
        if (token.type === EMOJI_RULE) {
            pending.push(token);
            continue;
        }
        flush(token.content);
        pos += token.content.length;
    }
    flush(null);
}

/**
 * Each text token a core rule replaced with a run of tokens, with that run:
 * `old`, an inline token's children before the rule, against `fresh`, after
 * it. A rule that splits a token replaces the children array whole and leaves
 * every other token the same object (markdown-it's `arrayReplaceAt`).
 */
function replacedRuns(old: readonly Token[], fresh: readonly Token[], each: (token: Token, run: Token[]) => void): void {
    let k = 0;
    for (let j = 0; j < old.length; j++) {
        if (fresh[k] === old[j]) {
            k++;
            continue;
        }
        const next = old[j + 1];
        const run: Token[] = [];
        while (k < fresh.length && fresh[k] !== next) {
            run.push(fresh[k++]);
        }
        each(old[j], run);
    }
}

/** Set the inline tokens' children aside under `key` for `back` (`replacedRuns`). */
function aside(state: StateBase, key: string): void {
    const children = new Map<Token, Token[]>();
    for (const token of state.tokens) {
        if (token.type === 'inline' && token.children) {
            children.set(token, token.children);
        }
    }
    const byRule = setAside.get(state) ?? new Map<string, Map<Token, Token[]>>();
    byRule.set(key, children);
    setAside.set(state, byRule);
}

/** Each inline token whose children the rule set aside under `key` replaced, with its children before and after. */
function back(state: StateBase, key: string, each: (inline: Token, old: Token[]) => void): void {
    const byRule = setAside.get(state);
    const children = byRule?.get(key);
    byRule?.delete(key);
    for (const [inline, old] of children ?? []) {
        if (inline.children !== old) {
            each(inline, old);
        }
    }
}

/**
 * The places of linkify's text pieces of `token`, which began at `start` in
 * the inline token's text: each text piece after the text before it — the
 * pieces before a link are verbatim slices of `token` — and the text of a
 * link where it stands there as written; after a link whose text linkify
 * normalised, none but a last text piece, which ends where `token` ended.
 */
function placeLinkifyPieces(token: Token, run: readonly Token[], start: number): void {
    let pos: number | null = 0;
    const text = token.content;
    run.forEach((piece, i) => {
        if (piece.type !== 'text') {
            return;
        }
        if (pos !== null && text.startsWith(piece.content, pos)) {
            textStarts.set(piece, { start: start + pos, text: piece.content });
            pos += piece.content.length;
        } else if (i === run.length - 1 && text.endsWith(piece.content)) {
            textStarts.set(piece, { start: start + text.length - piece.content.length, text: piece.content });
        } else {
            pos = null;
        }
    });
}

/**
 * Where the text token `token` begins in `whole`: as the rules that made it
 * recorded it — or, where a later rule cut its ends off (markdown-it-attrs a
 * `{…}` at either end), where what is left stands in what was recorded, if it
 * stands there once — where its text stands there; `null` where it is not
 * known (no record, or what is left stands in it more than once).
 */
function startOf(token: Token, whole: string): number | null {
    const noted = textStarts.get(token);
    if (noted === undefined) {
        return null;
    }
    const text = token.content;
    const first = noted.text.indexOf(text);
    const once = first >= 0 && (text === noted.text || noted.text.indexOf(text, first + 1) < 0);
    const start = once ? noted.start + first : null;
    return start !== null && whole.startsWith(text, start) ? start : null;
}

/** Make `state`'s text tokens note where their text began (`textStarts`), once per state. */
function notePendingStarts(state: StateBase): void {
    const inline = state as StateBase & { pushPending(): Token; mepNotesStarts?: true };
    if (inline.mepNotesStarts) {
        return;
    }
    inline.mepNotesStarts = true;
    const push = inline.pushPending;
    inline.pushPending = function (this: StateBase): Token {
        const start = pendingStarts.get(this);
        const token = push.call(this) as Token;
        if (start !== undefined) {
            textStarts.set(token, { start, text: token.content });
        }
        return token;
    };
}

/**
 * Before `fragments_join` joins each run of adjacent text tokens into the last
 * of them: that last token's place is where the first began — the place of
 * one of them less the text before it in the run, where the run's text stands
 * there; none where no place in the run is known.
 */
function placeTextRuns(state: StateBase): void {
    const tokens = state.tokens;
    const src = state.src;
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== 'text' || tokens[i + 1]?.type !== 'text') {
            continue;
        }
        let end = i;
        while (tokens[end + 1]?.type === 'text') {
            end++;
        }
        let before = 0;
        let start: number | null = null;
        for (let k = i; k <= end && start === null; k++) {
            const noted = startOf(tokens[k], src);
            if (noted !== null) {
                start = noted - before;
            }
            before += tokens[k].content.length;
        }
        const joined = tokens.slice(i, end + 1).map(t => t.content).join('');
        if (start !== null && start >= 0 && src.startsWith(joined, start)) {
            textStarts.set(tokens[end], { start, text: joined });
        } else {
            textStarts.delete(tokens[end]);
        }
        i = end;
    }
}

/** Whether `md` reads emoji: markdown-it-emoji's core rule is registered and enabled, as the engine was finally built. */
export function readsEmoji(md: MarkdownIt): boolean {
    return hasEnabledRule(md.core.ruler, EMOJI_RULE);
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItEmoji(md: MarkdownIt, ...args: unknown[]) {
    md.use(markdownItEmoji, ...args);
    // Places only in the Visual Editor's engine: they cost every render, and only the editor asks.
    const places = (md as unknown as { options: Record<string, unknown> }).options[EMOJI_PLACES_OPTION] === true;
    if (places) {
        // First of the inline rules: where the pending text begins, which a text token is made of.
        md.inline.ruler.before('text', 'mep_text_start', (state: StateBase, silent: boolean) => {
            if (!silent && state.pending === '') {
                pendingStarts.set(state, state.pos as number);
            }
            notePendingStarts(state);
            return false;
        });
        md.inline.ruler2.before('fragments_join', 'mep_text_runs', (state: StateBase) => {
            placeTextRuns(state);
            return false;
        });
        md.core.ruler.before('linkify', 'mep_linkify_aside', (state: StateBase) => aside(state, 'linkify'));
        md.core.ruler.after('linkify', 'mep_linkify_back', (state: StateBase) => {
            back(state, 'linkify', (inline, old) => replacedRuns(old, inline.children, (token, run) => {
                const start = token.type === 'text' ? startOf(token, inline.content) : null;
                if (start !== null) {
                    placeLinkifyPieces(token, run, start);
                }
            }));
        });
    }
    md.core.ruler.before(EMOJI_RULE, 'mep_emoji_aside', (state: StateBase) => aside(state, EMOJI_RULE));
    md.core.ruler.after(EMOJI_RULE, 'mep_emoji_back', (state: StateBase) => {
        back(state, EMOJI_RULE, (inline, old) => replacedRuns(old, inline.children, (token, run) => {
            spell(token.content, run, places ? inline.content : null, places && token.type === 'text' ? startOf(token, inline.content) : null);
        }));
    });
}
