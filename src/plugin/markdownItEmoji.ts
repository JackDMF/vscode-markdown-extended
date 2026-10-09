import { full as markdownItEmoji } from 'markdown-it-emoji';
import shortcuts from 'markdown-it-emoji/lib/data/shortcuts.mjs';
import { MarkdownIt, StateBase, Token } from '../@types/markdown-it';
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
// Each emoji also carries where it stands (`meta.at`): its offset in the text
// of the inline token it was read in (`content`, the text the inline rules
// read), from the plugin's own match — the offset of its spelling in the text
// token it split, plus where that text token stands. Where a text token
// stands is noted as the inline rules make it (`mep_text_start`, the first
// rule: where the pending text a text token is made of began); one the core
// rules made after them (linkify's pieces) is found after the one before it.
// `null` where the spelling does not stand there — a note's text token the
// note's own parse joined with an escape or a reference (`\:)`), whose text
// is no longer the source. The Visual Editor pairs each atom it writes with
// the emoji read at the place it wrote it (`unreadEmoji` in `serialize.ts`).

/** The core rule markdown-it-emoji adds, which splits text tokens into text and `emoji` tokens. */
export const EMOJI_RULE = 'emoji';

/** The meta key of an emoji token's spelling: the text the plugin read it from, or `null` where that cannot be told. */
export const EMOJI_SOURCE_META = 'source';

/** The meta key of an emoji token's place: the offset of its spelling in its inline token's `content`, or `null`. */
export const EMOJI_AT_META = 'at';

/**
 * Each text token's place, as the inline rules made it: where in the inline
 * token's `content` its text begins. Kept beside the token, not in its
 * `meta`, which every other reader of a text token sees.
 */
const textStarts = new WeakMap<Token, number>();

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
    const start = textStarts.get(token);
    if (start !== undefined) {
        textStarts.set(copy, start + by);
    }
}

/** Each inline token's children as they stood before the rule, by the parse. */
const setAside = new WeakMap<StateBase, Map<Token, Token[]>>();

/** The plugin's table: each emoji name's aliases. */
const ALIASES = shortcuts as Record<string, string | string[]>;

/** Every way `name` can be spelled: its shortcode, then the table's aliases. */
function spellingsOf(name: string): string[] {
    const aliases = ALIASES[name] ?? [];
    return [`:${name}:`, ...(Array.isArray(aliases) ? aliases : [aliases])];
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

function setSource(token: Token, source: string | null, at: number | null): void {
    token.meta = { ...((token.meta as Record<string, unknown> | null) ?? {}), [EMOJI_SOURCE_META]: source, [EMOJI_AT_META]: at };
}

/**
 * Give each emoji of `run`, the pieces the plugin split a text token holding
 * `text` into, its spelling, and its place in `whole`, the inline token's
 * text, where the text token begins at `start`.
 */
function spell(text: string, run: readonly Token[], whole: string, start: number | null): void {
    let pos = 0;
    let pending: Token[] = [];
    const flush = (after: string | null) => {
        if (pending.length === 0) {
            return;
        }
        const ways = divisions(text, pos, pending.map(t => t.markup), after);
        if (ways.length === 1) {
            ways[0].forEach((spelling, i) => {
                const at = start === null ? null : start + pos;
                setSource(pending[i], spelling, at !== null && whole.startsWith(spelling, at) ? at : null);
                pos += spelling.length;
            });
        } else {
            pending.forEach(t => setSource(t, null, null));
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
 * Where the text token `token` begins in `whole`: as the inline rules noted
 * it, where its text stands there; else its first place from `cursor`, the
 * end of the text token before it (linkify's pieces); `null` where none.
 */
function startOf(token: Token, whole: string, cursor: number): number | null {
    const noted = textStarts.get(token);
    if (noted !== undefined && whole.startsWith(token.content, noted)) {
        return noted;
    }
    const found = token.content === '' ? -1 : whole.indexOf(token.content, cursor);
    return found < 0 ? null : found;
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
            textStarts.set(token, start);
        }
        return token;
    };
}

/** Whether `md` reads emoji: markdown-it-emoji's core rule is registered and enabled, as the engine was finally built. */
export function readsEmoji(md: MarkdownIt): boolean {
    return hasEnabledRule(md.core.ruler, EMOJI_RULE);
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export function MarkdownItEmoji(md: MarkdownIt, ...args: unknown[]) {
    md.use(markdownItEmoji, ...args);
    // First of the inline rules: where the pending text begins, which a text token is made of.
    md.inline.ruler.before('text', 'mep_text_start', (state: StateBase, silent: boolean) => {
        if (!silent && state.pending === '') {
            pendingStarts.set(state, state.pos as number);
        }
        notePendingStarts(state);
        return false;
    });
    md.core.ruler.before(EMOJI_RULE, 'mep_emoji_aside', (state: StateBase) => {
        const children = new Map<Token, Token[]>();
        for (const token of state.tokens) {
            if (token.type === 'inline' && token.children) {
                children.set(token, token.children);
            }
        }
        setAside.set(state, children);
    });
    md.core.ruler.after(EMOJI_RULE, 'mep_emoji_back', (state: StateBase) => {
        const children = setAside.get(state);
        setAside.delete(state);
        for (const [inline, old] of children ?? []) {
            const fresh = inline.children;
            if (fresh === old) {
                continue;
            }
            // Each token the plugin left is the same object; each text token it split is gone, its pieces in its place.
            const whole = inline.content;
            let cursor = 0;
            let k = 0;
            for (let j = 0; j < old.length; j++) {
                const start = old[j].type === 'text' ? startOf(old[j], whole, cursor) : null;
                if (start !== null) {
                    cursor = start + old[j].content.length;
                }
                if (fresh[k] === old[j]) {
                    k++;
                    continue;
                }
                const next = old[j + 1];
                const run: Token[] = [];
                while (k < fresh.length && fresh[k] !== next) {
                    run.push(fresh[k++]);
                }
                spell(old[j].content, run, whole, start);
            }
        }
    });
}
