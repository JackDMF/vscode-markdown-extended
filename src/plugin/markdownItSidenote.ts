import { MarkdownIt } from 'markdown-it';
import { NOTE_SEPARATOR, NOTE_SYNTAX, sidebarCanClose, sidebarCanOpen } from '../syntax/markers';
import { UrlMatcher, bareUrlAt } from '../syntax/linkify';

/**
 * Markdown-it plugin for sidenotes, marginal notes, and sidebar annotations.
 * 
 * This plugin adds support for:
 * - Sidenotes: ++reference text|note content++
 * - Marginal notes: !!reference text|note content!!
 * - Left sidebar: $content$
 * - Right sidebar: @content@
 * 
 * Features:
 * - Full markdown support within notes and sidebars (bold, italic, links, code, etc.)
 * - A sidebar's end is found by the inline parser and its content tokenized
 *   in place (`findSidebarClose`); a note's end is searched in the raw source
 *   and its parts parsed on their own, with recursion depth limiting
 * - Thread-safe state management using WeakMap
 * - Graceful error handling with fallback to plain text
 * 
 * @module markdownItSidenote
 */

// Use WeakMap for thread-safe parse depth tracking per state
const parseDepthMap = new WeakMap<any, number>();

/**
 * Maximum recursion depth for nested markdown parsing.
 * Prevents stack overflow when processing deeply nested sidenotes.
 * @constant {number}
 */
const MAX_PARSE_DEPTH = 3;

/**
 * Get current parse depth for a state.
 * Uses WeakMap for thread-safe tracking without memory leaks.
 * 
 * @param state - Markdown-it parsing state
 * @returns Current nesting depth (0 if not tracked yet)
 */
function getParseDepth(state: any): number {
    return parseDepthMap.get(state) || 0;
}

/**
 * Increment parse depth for a state.
 * Called before recursively parsing markdown content.
 * 
 * @param state - Markdown-it parsing state
 */
function incrementParseDepth(state: any): void {
    parseDepthMap.set(state, getParseDepth(state) + 1);
}

/**
 * Decrement parse depth for a state.
 * Called after completing recursive markdown parsing.
 * Must always be called in a finally block to prevent depth leaks.
 * 
 * @param state - Markdown-it parsing state
 */
function decrementParseDepth(state: any): void {
    const current = getParseDepth(state);
    if (current > 0) {
        parseDepthMap.set(state, current - 1);
    }
}

// ============================================================================
// Constants
// ============================================================================

// The markers and classes are stated in `src/syntax/markers.ts`, which the
// Visual Editor's toolbar reads too, so a toolbar button writes exactly what
// this plugin parses.

/** Sidenote marker character: ++ */
const SN_TOKEN = NOTE_SYNTAX.sidenote.marker.charAt(0);
/** Sidenote marker character code */
const SN_TOKEN_CODE = SN_TOKEN.charCodeAt(0);

/** Marginal note marker character: !! */
const MN_TOKEN = NOTE_SYNTAX.marginalNote.marker.charAt(0);
/** Marginal note marker character code */
const MN_TOKEN_CODE = MN_TOKEN.charCodeAt(0);

/** Separator between reference text and note content: | */
const TOKEN_PIPE = NOTE_SEPARATOR;

/** Left sidebar marker character: $ */
const LEFT_SIDEBAR_TOKEN = NOTE_SYNTAX.leftSidebar.marker;
/** Left sidebar marker character code */
const LEFT_SIDEBAR_TOKEN_CODE = LEFT_SIDEBAR_TOKEN.charCodeAt(0);

/** Right sidebar marker character: @ */
const RIGHT_SIDEBAR_TOKEN = NOTE_SYNTAX.rightSidebar.marker;
/** Right sidebar marker character code */
const RIGHT_SIDEBAR_TOKEN_CODE = RIGHT_SIDEBAR_TOKEN.charCodeAt(0);

/**
 * Maximum character distance to search for closing markers.
 * Limits search scope to prevent performance issues with large documents.
 * @constant {number}
 */
const SEARCH_LIMIT = 1000;

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration for note types (sidenotes and marginal notes).
 * Notes have reference text and separate note content.
 */
interface NoteConfig {
  /** Type identifier for renderer rules */
  type: 'sidenote' | 'marginal_note';
  /** Opening marker string (e.g., '++') */
  openMarker: string;
  /** Character code of opening marker */
  openMarkerCode: number;
  /** Closing marker string (e.g., '++') */
  closeMarker: string;
  /** CSS class for note content */
  cssClass: string;
  /** CSS class for reference text */
  refClass: string;
}

/**
 * Configuration for sidebar types (left and right sidebars).
 * Sidebars are simpler wrappers without reference text.
 */
interface SidebarConfig {
  /** Type identifier for renderer rules */
  type: 'left_sidebar' | 'right_sidebar';
  /** Opening marker character (e.g., '$') */
  openMarker: string;
  /** Character code of opening marker */
  openMarkerCode: number;
  /** CSS class for sidebar content */
  cssClass: string;
}

/**
 * Markdown-it inline parsing state.
 * Simplified interface for the actual markdown-it state object.
 */
interface MarkdownItState {
    /** Source markdown text */
    src: string;
    /** Current position in source */
    pos: number;
    /** Where the text being read ends (the source's length, or a construct's end while its content is read) */
    posMax: number;
    /** Markdown-it instance for recursive parsing */
    md: MarkdownIt;
    /** Push a new token to the stream */
    push: (type: string, tag: string, nesting: number) => any;
    /** The token stream, and the delimiter lists per opening token */
    tokens: unknown[];
    tokens_meta: unknown[];
    /** Text not yet pushed as a token, and its level */
    pending: string;
    pendingLevel: number;
    /** Nesting level of the next token */
    level: number;
    /** Emphasis-like delimiters of the current tag, and those of the tags around it */
    delimiters: unknown[];
    _prev_delimiters: unknown[];
    /** The environment the document is parsed in */
    env: unknown;
    /** Above 0 inside a link, where linkify does not run */
    linkLevel: number;
    /** Where `skipToken` found each construct to end, by its start */
    cache: Record<number, number>;
    /** The code-span closers the backtick rule has seen, and whether it has looked to the end */
    backticks: Record<number, number>;
    backticksScanned: boolean;
}

/**
 * Validated note content structure.
 */
interface ValidatedNote {
    /** Reference text (before the |) */
    text: string;
    /** Note content (after the |) */
    note: string;
}

// ============================================================================
// Configuration Objects
// ============================================================================

/**
 * Configuration for marginal notes (!!text|note!!).
 * Marginal notes appear in the document margin.
 */
const marginNoteConfig: NoteConfig = {
    type: 'marginal_note',
    openMarker: NOTE_SYNTAX.marginalNote.marker,
    openMarkerCode: MN_TOKEN_CODE,
    closeMarker: NOTE_SYNTAX.marginalNote.marker,
    cssClass: NOTE_SYNTAX.marginalNote.noteClass,
    refClass: NOTE_SYNTAX.marginalNote.refClass
};

/**
 * Configuration for sidenotes (++text|note++).
 * Sidenotes appear as floating annotations.
 */
const sideNoteConfig: NoteConfig = {
    type: 'sidenote',
    openMarker: NOTE_SYNTAX.sidenote.marker,
    openMarkerCode: SN_TOKEN_CODE,
    closeMarker: NOTE_SYNTAX.sidenote.marker,
    cssClass: NOTE_SYNTAX.sidenote.noteClass,
    refClass: NOTE_SYNTAX.sidenote.refClass
};

/**
 * Configuration for left sidebar annotations ($content$).
 */
const leftSidebarConfig: SidebarConfig = {
    type: 'left_sidebar',
    openMarker: LEFT_SIDEBAR_TOKEN,
    openMarkerCode: LEFT_SIDEBAR_TOKEN_CODE,
    cssClass: NOTE_SYNTAX.leftSidebar.cssClass
};

/**
 * Configuration for right sidebar annotations (@content@).
 */
const rightSidebarConfig: SidebarConfig = {
    type: 'right_sidebar',
    openMarker: RIGHT_SIDEBAR_TOKEN,
    openMarkerCode: RIGHT_SIDEBAR_TOKEN_CODE,
    cssClass: NOTE_SYNTAX.rightSidebar.cssClass
};

// ============================================================================
// Renderer Rules
// ============================================================================

/**
 * Discriminated union type for all renderer configurations.
 * Allows unified renderer registration for both notes and sidebars.
 */
type RenderConfig = NoteConfig | SidebarConfig;

/**
 * Register HTML renderer rules for any note or sidebar type.
 * 
 * **For notes (NoteConfig):**
 * - Creates nested structure with reference class and content class
 * - Reference text appears inline with refClass styling
 * - Note content appears as annotation with cssClass styling
 * 
 * **For sidebars (SidebarConfig):**
 * - Creates simple wrapper with cssClass
 * - Content appears in sidebar/margin
 * 
 * @param md - Markdown-it instance
 * @param config - Note or sidebar configuration
 */
function registerRendererRules(md: MarkdownIt, config: RenderConfig): void {
    const type = config.type;
    
    // Type guard: Check if this is a NoteConfig (has refClass)
    if ('refClass' in config) {
        // Note type (sidenote or marginal_note)
        // Structure: <span class="ref"><ref text><span class="note"><note content></span></span>
        // The note span is nested INSIDE the reference span, not a sibling of it — CSS should
        // target it as a descendant (e.g. `.sn-ref .sidenote`), never as `.sn-ref + .sidenote`.
        // The reference (outer) span carries any markdown-it-attrs attributes added via {.class}
        md.renderer.rules[`${type}_open`] = (tokens, idx) => `<span${renderOpenTagAttrs(tokens[idx], config.refClass)}>`;
        md.renderer.rules[`${type}_ref_open`] = () => ''; // No additional wrapper
        md.renderer.rules[`${type}_ref_close`] = () => ''; // No additional wrapper
        md.renderer.rules[`${type}_content_open`] = () => `<span class="${config.cssClass}">`;
        md.renderer.rules[`${type}_content_close`] = () => '</span>';
        md.renderer.rules[`${type}_close`] = () => '</span>';
    } else {
        // Sidebar type (left_sidebar or right_sidebar)
        // Structure: <span class="sidebar"><content></span>
        md.renderer.rules[`${type}_open`] = (tokens, idx) => `<span${renderOpenTagAttrs(tokens[idx], config.cssClass)}>`;
        md.renderer.rules[`${type}_close`] = () => '</span>';
    }
}

/**
 * Build the attribute string for an opening span, merging the plugin's built-in
 * CSS class with any attributes added through markdown-it-attrs ({.class #id key=val}).
 *
 * The built-in class is always preserved; user classes from {.class} are appended,
 * and any other attributes (id, custom data-* etc.) are rendered as-is.
 *
 * @param token - The opening token (may carry attrs set by markdown-it-attrs)
 * @param baseClass - The plugin's default CSS class for this element
 * @returns Attribute string beginning with a leading space (e.g. ` class="x y" id="z"`)
 */
function renderOpenTagAttrs(token: any, baseClass: string): string {
    const classes = [baseClass];
    const others: string[] = [];

    const attrs: [string, string][] = token && token.attrs ? token.attrs : [];
    for (const [name, value] of attrs) {
        if (name === 'class') {
            if (value) {classes.push(value);}
        } else {
            others.push(`${name}="${md_escape(value)}"`);
        }
    }

    let result = ` class="${md_escape(classes.join(' '))}"`;
    if (others.length) {result += ' ' + others.join(' ');}
    return result;
}

/** Minimal HTML attribute escaping for rendered attribute values. */
function md_escape(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}

/**
 * Main plugin initialization function.
 * Registers tokenizers and renderer rules for all note and sidebar types.
 * 
 * @param md - Markdown-it instance
 * 
 * @example
 * ```typescript
 * import sidenote from './markdownItSidenote';
 * md.use(sidenote);
 * ```
 */
export default function (md: MarkdownIt) {
    // Register notes tokenizer (handles both ++ and !!)
    md.inline.ruler.before('link', 'notes', notesTokenizer as any);
    registerRendererRules(md, sideNoteConfig);
    registerRendererRules(md, marginNoteConfig);
    
    // Register sidebar tokenizer (handles both $ and @)
    md.inline.ruler.before('link', 'sidebars', sidebarTokenizer as any);
    registerRendererRules(md, leftSidebarConfig);
    registerRendererRules(md, rightSidebarConfig);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Tokenizer for sidebar annotations ($...$ and @...@).
 * 
 * Sidebars are simple wrappers that support markdown content.
 * Unlike notes, they don't have separate reference text.
 *
 * A marker opens only where `sidebarCanOpen` allows it (no ASCII letter or
 * digit before it, so `a@b.c` opens nothing); the closing marker is the first
 * that `sidebarCanClose` allows outside code, links and the like
 * (`findSidebarClose`). Both rules live in `src/syntax/markers.ts`; the
 * character beside a marker is the one the source reads as there, a
 * character reference decoded (`readBefore`, `readAfter`).
 *
 * @param state - Markdown-it inline parsing state
 * @param silent - If true, only check syntax without creating tokens
 * @returns true if a sidebar was found and processed
 * 
 * @example
 * ```markdown
 * This is $left sidebar content$ and @right sidebar content@.
 * ```
 */
function sidebarTokenizer(state: MarkdownItState, silent: boolean): boolean {
    const start = state.pos;
    const char = state.src.charCodeAt(start);
    
    // Early exit if not a potential sidebar marker
    if (char !== LEFT_SIDEBAR_TOKEN_CODE && char !== RIGHT_SIDEBAR_TOKEN_CODE) {
        return false;
    }

    // Detect sidebar type based on opening marker
    let config: SidebarConfig;
    if (char === LEFT_SIDEBAR_TOKEN_CODE) {
        config = leftSidebarConfig;
    } else if (char === RIGHT_SIDEBAR_TOKEN_CODE) {
        config = rightSidebarConfig;
    } else {
        return false;
    }

    const src = state.src;
    const max = state.posMax;
    const after = start + 1 < max ? src.charAt(start + 1) : '';
    if (!sidebarCanOpen(readBefore(state, start), after)) {
        return false;
    }

    const endPos = findSidebarClose(state, start, char);
    if (endPos === -1) {return false;}

    // In silent mode, we must still update state.pos before returning true
    // (markdown-it contract: returning true means we consumed input)
    if (silent) {
        state.pos = endPos + 1;
        return true;
    }

    // The content is tokenized in place, as the link rule tokenizes a label —
    // the same state and environment — but bounded: the source ends at the
    // closing marker while it is read, so no rule reads past it (linkify and
    // a code span's closer look beyond `posMax`), and a URL in a sidebar ends
    // at the sidebar's end, as the closing marker was found.
    const saved = saveInline(state);
    const backticks = state.backticks;
    const backticksScanned = state.backticksScanned;
    const cache = state.cache;
    try {
        const tokenOpen = state.push(`${config.type}_open`, 'span', 1);
        tokenOpen.markup = config.openMarker;
        markSpan(tokenOpen, start, endPos);
        // An empty text first, at the content's level: markdown-it-bracketed-
        // spans tells a look-ahead from a real parse by the last token's
        // level, and an opening token right before would make it push its
        // tokens while another rule only looks ahead. text_join drops it.
        state.push('text', '', 0).content = '';
        state.src = src.slice(0, endPos);
        state.pos = start + 1;
        state.posMax = endPos;
        state.backticks = {};
        state.backticksScanned = false;
        state.cache = {};
        inlineParser(state).tokenize(state);
        state.src = src;
        state.posMax = max;
        state.push(`${config.type}_close`, 'span', -1);
    } catch {
        // As the content parse always did: a rule that throws leaves the sidebar's text as plain text.
        restoreInline(state, saved);
        state.src = src;
        state.posMax = max;
        const tokenOpen = state.push(`${config.type}_open`, 'span', 1);
        tokenOpen.markup = config.openMarker;
        markSpan(tokenOpen, start, endPos);
        state.push('text', '', 0).content = src.slice(start + 1, endPos);
        state.push(`${config.type}_close`, 'span', -1);
    } finally {
        state.src = src;
        state.posMax = max;
        state.backticks = backticks;
        state.backticksScanned = backticksScanned;
        state.cache = cache;
    }

    state.pos = endPos + 1;
    return true;
}

/**
 * The key under a sidebar's opening token's `meta` that says where its
 * opening and its closing marker stand in the source the rule read
 * (`[open, close]`). The Visual Editor's page reads it to match each sidebar
 * it wrote to the one the parser reads back (`readSidebars` in
 * `src/editor/inlineEngine.ts`); nothing renders it.
 */
export const SIDEBAR_SPAN_META = 'sidebarSpan';

function markSpan(token: { meta: unknown }, open: number, close: number): void {
    token.meta = { ...((token.meta as Record<string, unknown> | null) ?? {}), [SIDEBAR_SPAN_META]: [open, close] };
}

/** The two parts of markdown-it's inline parser the sidebar rule drives, which its declarations leave out. */
interface InlineParser {
    tokenize(state: MarkdownItState): void;
    skipToken(state: MarkdownItState): void;
}

function inlineParser(state: MarkdownItState): InlineParser {
    return state.md.inline as unknown as InlineParser;
}

/** A character reference as markdown-it's entity rule reads one (`&#120;`, `&#x78;`, `&amp;`). */
export const CHARACTER_REFERENCE = /&(?:#(?:[xX][0-9a-fA-F]{1,6}|[0-9]{1,7})|[A-Za-z][A-Za-z0-9]{1,31});/;
/** One at the end of the text before a marker. */
const REFERENCE_BEFORE = new RegExp(`${CHARACTER_REFERENCE.source}$`);
/** One at the start of the text after a marker. */
const REFERENCE_AFTER = new RegExp(`^${CHARACTER_REFERENCE.source}`);
/** The longest text `REFERENCE_BEFORE` can match: `&`, 32 characters of a name, `;`. */
const REFERENCE_MAX = 34;

/** What a character reference reads as, or the reference itself where it decodes to nothing (`&nosuch;`). */
function decodeReference(state: MarkdownItState, reference: string): string {
    return (state.md as unknown as { utils: { unescapeAll(text: string): string } }).utils.unescapeAll(reference);
}

/**
 * The character the source reads as right before `pos`, for `sidebarCanOpen`:
 * the one written there, or — where a character reference ends there that no
 * backslash escapes — the last character it decodes to, so `REQ-&#49;$x$`
 * opens nothing, as `REQ-1$x$` does not.
 */
function readBefore(state: MarkdownItState, pos: number): string {
    const src = state.src;
    const written = pos > 0 ? src.charAt(pos - 1) : '';
    if (written !== ';') {
        return written;
    }
    const reference = REFERENCE_BEFORE.exec(src.slice(Math.max(0, pos - REFERENCE_MAX), pos));
    if (reference === null) {
        return written;
    }
    let backslashes = 0;
    const amp = pos - reference[0].length;
    while (amp - 1 - backslashes >= 0 && src.charCodeAt(amp - 1 - backslashes) === 0x5c) {
        backslashes++;
    }
    const decoded = backslashes % 2 === 0 ? decodeReference(state, reference[0]) : reference[0];
    return decoded === reference[0] ? written : decoded.slice(-1);
}

/**
 * The character the source reads as at `pos`, before `max`, for
 * `sidebarCanClose`: the one written there, or the first character a
 * character reference starting there decodes to, so `$x$&#53;` closes
 * nothing, as `$x$5` does not.
 */
function readAfter(state: MarkdownItState, pos: number, max: number): string {
    const src = state.src;
    const written = pos < max ? src.charAt(pos) : '';
    if (written !== '&') {
        return written;
    }
    const reference = REFERENCE_AFTER.exec(src.slice(pos, max));
    const decoded = reference === null ? '' : decodeReference(state, reference[0]);
    return reference === null || decoded === reference[0] ? written : decoded.charAt(0);
}

/** What markdown-it-footnote keeps in the environment. */
interface FootnoteEnv {
    footnotes?: { refs?: Record<string, number>; list?: { label?: string; count?: number }[] };
}

/** What a rule may leave in the inline state or the environment, to be put back after a look-ahead. */
interface SavedInline {
    pos: number;
    tokens: number;
    tokensMeta: number;
    pending: string;
    pendingLevel: number;
    level: number;
    linkLevel: number;
    delimiters: unknown[];
    delimitersLength: number;
    prevDelimiters: number;
    backticks: Record<number, number>;
    backticksScanned: boolean;
    footnotes: FootnoteEnv['footnotes'];
    hadRefs: boolean;
    /** How many footnotes were listed, and their counts; -1 when there was no list. */
    footnoteListLength: number;
    footnoteCounts: (number | undefined)[];
}

function saveInline(state: MarkdownItState): SavedInline {
    const footnotes = (state.env as FootnoteEnv | undefined)?.footnotes;
    return {
        pos: state.pos,
        tokens: state.tokens.length,
        tokensMeta: state.tokens_meta.length,
        pending: state.pending,
        pendingLevel: state.pendingLevel,
        level: state.level,
        linkLevel: state.linkLevel,
        delimiters: state.delimiters,
        delimitersLength: state.delimiters.length,
        prevDelimiters: state._prev_delimiters.length,
        backticks: { ...state.backticks },
        backticksScanned: state.backticksScanned,
        footnotes,
        hadRefs: footnotes?.refs !== undefined,
        // Not the definitions: a look-ahead only lists footnotes and counts references.
        footnoteListLength: footnotes?.list ? footnotes.list.length : -1,
        footnoteCounts: footnotes?.list ? footnotes.list.map(item => item?.count) : [],
    };
}

function restoreInline(state: MarkdownItState, saved: SavedInline): void {
    state.pos = saved.pos;
    state.tokens.length = saved.tokens;
    state.tokens_meta.length = saved.tokensMeta;
    state.pending = saved.pending;
    state.pendingLevel = saved.pendingLevel;
    state.level = saved.level;
    state.linkLevel = saved.linkLevel;
    state.delimiters = saved.delimiters;
    state.delimiters.length = saved.delimitersLength;
    state._prev_delimiters.length = saved.prevDelimiters;
    // The backtick rule remembers which closers it has seen as if the text were read once, forwards.
    state.backticks = saved.backticks;
    state.backticksScanned = saved.backticksScanned;
    const env = state.env as FootnoteEnv | undefined;
    if (env === undefined || env === null) {
        return;
    }
    if (saved.footnotes === undefined) {
        delete env.footnotes;
        return;
    }
    const footnotes = saved.footnotes;
    env.footnotes = footnotes;
    const list = footnotes.list ?? [];
    // A footnote listed since: a reference to a definition made it the definition's id, which was -1 before.
    for (let i = Math.max(saved.footnoteListLength, 0); i < list.length; i++) {
        const label = list[i]?.label;
        if (label !== undefined && footnotes.refs !== undefined && footnotes.refs[`:${label}`] === i) {
            footnotes.refs[`:${label}`] = -1;
        }
    }
    if (!saved.hadRefs) {
        delete footnotes.refs;
    }
    if (saved.footnoteListLength === -1) {
        delete footnotes.list;
        return;
    }
    list.length = saved.footnoteListLength;
    saved.footnoteCounts.forEach((count, i) => {
        if (list[i]) {
            list[i].count = count;
        }
    });
}

/** The caches the look-ahead keeps per state and per end of text, apart from the inline parser's own. */
const scanCaches = new WeakMap<object, Map<number, Record<number, number>>>();

function scanCache(state: MarkdownItState): Record<number, number> {
    let byEnd = scanCaches.get(state);
    if (byEnd === undefined) {
        byEnd = new Map();
        scanCaches.set(state, byEnd);
    }
    let cache = byEnd.get(state.posMax);
    if (cache === undefined) {
        cache = {};
        byEnd.set(state.posMax, cache);
    }
    return cache;
}

/**
 * Where the bare URL that markdown-it's linkify rule would read at `pos` (its
 * `://`) ends, or -1 — asked (`bareUrlAt`) of the engine's own linkify-it,
 * the text starting at
 * `textStart` and ending at `max`, a link markdown-it would not follow
 * refused.
 */
function bareUrlEnd(state: MarkdownItState, textStart: number, pos: number, max: number): number {
    const md = state.md as unknown as { linkify: UrlMatcher; normalizeLink(url: string): string; validateLink(url: string): boolean };
    const url = bareUrlAt(md.linkify, state.src, pos, textStart, max, link => md.validateLink(md.normalizeLink(link)));
    return url === null ? -1 : url[1];
}

/**
 * The position of the marker that closes the sidebar opened at `start`, or -1.
 *
 * Found the way markdown-it's link rule finds a label's end
 * (`parseLinkLabel`): one construct at a time with `skipToken`, so a marker
 * inside a code span, an autolink, inline HTML, a link, a backslash escape or
 * a character reference closes nothing. A marker of the sidebar's own kind
 * that does not close is passed over, so the first one that closes
 * (`sidebarCanClose`) is the end; a sidebar of the other kind is skipped
 * whole. A bare URL is read as linkify will read it in the content
 * (`bareUrlEnd`, with linkify itself off while looking): up to the first
 * closing marker in it, so a URL in a sidebar ends at the sidebar's end, and
 * a marker of the other kind in it opens nothing.
 *
 * The look-ahead keeps its own cache per end of text (`scanCache`): what it
 * learns with linkify off and at this `posMax` is not what the inline parser
 * would learn elsewhere. A rule that ignores `silent` (markdown-it-bracketed-
 * spans tokenizes while it is asked only to skip) leaves nothing behind: the
 * tokens, the pending text, the levels, the delimiters and the footnotes in
 * the environment are put back as they were.
 */
function findSidebarClose(state: MarkdownItState, start: number, code: number): number {
    const src = state.src;
    const max = state.posMax;
    const marker = src.charAt(start);
    const closesAt = (pos: number) => src.charCodeAt(pos) === code
        && sidebarCanClose(marker, readAfter(state, pos + 1, max));

    // Nothing to look for when no marker in the rest of the text could close.
    let candidate = src.indexOf(marker, start + 1);
    while (candidate !== -1 && candidate < max && !closesAt(candidate)) {
        candidate = src.indexOf(marker, candidate + 1);
    }
    if (candidate === -1 || candidate >= max) {
        return -1;
    }

    const saved = saveInline(state);
    // As before the content (see `sidebarTokenizer`): a last token at this
    // level keeps markdown-it-bracketed-spans from tokenizing during each
    // look-ahead. The rollback removes it.
    state.push('text', '', 0).content = '';
    const cache = state.cache;
    // Linkify does not run while looking (as inside a link): its URL is read here, bounded (`bareUrlEnd`).
    const urlAware = Boolean((state.md as unknown as { options: { linkify?: boolean } }).options.linkify) && state.linkLevel === 0;
    state.cache = scanCache(state);
    state.linkLevel++;
    let found = -1;
    state.pos = start + 1;
    try {
        while (state.pos < max) {
            if (closesAt(state.pos)) {
                found = state.pos;
                break;
            }
            if (src.charCodeAt(state.pos) === code) {
                state.pos++;
                continue;
            }
            // A bare URL is skipped as linkify will read it in the content —
            // up to the first closing marker in it, where the content ends.
            const urlEnd = urlAware ? bareUrlEnd(state, start + 1, state.pos, max) : -1;
            if (urlEnd !== -1) {
                for (let at = state.pos; at < urlEnd && found === -1; at++) {
                    found = closesAt(at) ? at : -1;
                }
                if (found !== -1) {
                    break;
                }
                state.pos = urlEnd;
                continue;
            }
            inlineParser(state).skipToken(state);
        }
    } finally {
        restoreInline(state, saved);
        state.cache = cache;
    }
    return found;
}

/**
 * Tokenizer for sidenotes (++) and marginal notes (!!).
 * 
 * Detects note markers and delegates to processNote for parsing.
 * Notes have the structure: marker + text|note + marker
 * 
 * @param state - Markdown-it inline parsing state
 * @param silent - If true, only check syntax without creating tokens
 * @returns true if a note was found and processed
 * 
 * @example
 * ```markdown
 * This is ++reference|sidenote content++ and !!ref|marginal note!!.
 * ```
 */
function notesTokenizer(state: MarkdownItState, silent: boolean): boolean {
    const start = state.pos;
    const char = state.src.charCodeAt(start);
    
    // Early exit if not a potential note marker
    if (char !== sideNoteConfig.openMarkerCode && char !== marginNoteConfig.openMarkerCode) {
        return false;
    }

    // Detect note type based on opening marker
    let noteConfig: NoteConfig;
    if (char === sideNoteConfig.openMarkerCode && state.src.charCodeAt(start + 1) === sideNoteConfig.openMarkerCode) {
        noteConfig = sideNoteConfig;
    } else if (char === marginNoteConfig.openMarkerCode && state.src.charCodeAt(start + 1) === marginNoteConfig.openMarkerCode) {
        noteConfig = marginNoteConfig;
    } else {
        return false;
    }

    return processNote(state, silent, start, noteConfig);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validates note content structure (text|note).
 * 
 * @param content - Raw note content
 * @returns Validated structure with text and note, or null if invalid
 */
function validateNoteContent(content: string): ValidatedNote | null {
    const pipePos = content.indexOf(TOKEN_PIPE);
    if (pipePos === -1) {return null;}
    
    const text = content.slice(0, pipePos);
    const note = content.slice(pipePos + 1);
    
    // Reference text cannot be empty
    if (text.trim().length === 0) {return null;}
    
    return { text, note };
}

/**
 * Finds closing marker within reasonable search bounds.
 * 
 * @param src - Source text to search
 * @param startPos - Position to start searching from
 * @param marker - Marker string to find
 * @param maxSearch - Maximum characters to search (default: SEARCH_LIMIT)
 * @returns Position of closing marker, or null if not found
 */
function findClosingMarker(
    src: string, 
    startPos: number, 
    marker: string, 
    maxSearch: number = SEARCH_LIMIT
): number | null {
    const searchEndBound = Math.min(src.length, startPos + maxSearch);
    const searchRegion = src.slice(startPos, searchEndBound);
    const relativePos = searchRegion.indexOf(marker);
    
    return relativePos === -1 ? null : startPos + relativePos;
}

/**
 * Process content with markdown support, falling back to plain text on error.
 * Errors are silently handled to prevent plugin failures.
 * 
 * @param state - Markdown-it parsing state
 * @param content - Content to process
 * @param contextName - Description for error messages (unused - kept for future debugging)
 */
function processContentSafely(state: MarkdownItState, content: string, _contextName: string): void {
    try {
        processTextWithMarkdown(state, content);
    } catch {
        // Fallback to plain text on error - silently handle to prevent plugin failures
        const fallback = state.push('text', '', 0);
        fallback.content = content;
    }
}

/**
 * Process a note (either sidenote or marginal note).
 * Validates structure, extracts content, and creates tokens.
 * 
 * @param state - Markdown-it parsing state
 * @param silent - If true, only validate without creating tokens
 * @param start - Starting position in source
 * @param config - Note configuration (sidenote or marginal note)
 * @returns true if note was successfully processed
 */
function processNote(state: MarkdownItState, silent: boolean, start: number, config: NoteConfig): boolean {
    const max = state.posMax;
    
    // Validate we have enough characters for a note
    if (start + 2 >= max) {
        return false;
    }

    // Find closing marker within reasonable search bounds
    const endPos = findClosingMarker(state.src, start + 2, config.closeMarker);
    if (endPos === null) {return false;}

    // Extract and validate content structure (text|note)
    const content = state.src.slice(start + 2, endPos);
    const validated = validateNoteContent(content);
    
    if (!validated) {
        // Invalid note structure - silently fail in validation mode
        return false;
    }

    // In silent mode, we must still update state.pos before returning true
    // (markdown-it contract: returning true means we consumed input)
    if (silent) {
        state.pos = endPos + 2;
        return true;
    }

    // Create token structure for the note
    createNoteTokens(state, validated.text, validated.note, config);

    // Update position past the closing marker
    state.pos = endPos + 2;
    return true;
}

/**
 * Create the token structure for a note.
 * 
 * Notes have a complex nested structure:
 * - Outer span with reference class
 * - Inner reference section (rendered inline)
 * - Inner content section with note class (rendered as popup/margin)
 * 
 * @param state - Markdown-it parsing state
 * @param text - Reference text (shown inline)
 * @param note - Note content (shown as annotation)
 * @param config - Note configuration
 */
function createNoteTokens(state: MarkdownItState, text: string, note: string, config: NoteConfig): void {
    const type = config.type;
    
    try {
        // Create opening token for entire note
        const tokenOpen = state.push(`${type}_open`, 'span', 1);
        tokenOpen.markup = config.openMarker;
        
        // Create reference section (inline text)
        state.push(`${type}_ref_open`, '', 1);
        processContentSafely(state, text, `${type} reference`);
        state.push(`${type}_ref_close`, '', -1);
        
        // Create note content section (annotation)
        state.push(`${type}_content_open`, 'span', 1);
        processContentSafely(state, note, `${type} note`);
        state.push(`${type}_content_close`, 'span', -1);
        
        // Create closing token
        state.push(`${type}_close`, 'span', -1);
        
    } catch {
        // Emergency recovery - add simple text token as fallback
        // Critical errors are silently handled to prevent plugin failures
        const emergencyText = state.push('text', '', 0);
        emergencyText.content = `${text}|${note}`;
    }
}

// ============================================================================
// Markdown Processing
// ============================================================================

/**
 * Process text with inline markdown support.
 * 
 * This function recursively parses markdown within a note's reference and
 * body (a sidebar's content is tokenized in place instead, see
 * `sidebarTokenizer`), enabling features like **bold**, *italic*, `code`,
 * [links](url), etc.
 * 
 * **Recursion Protection:**
 * - Uses WeakMap-based depth tracking (thread-safe, no memory leaks)
 * - Limited to MAX_PARSE_DEPTH (3 levels) to prevent stack overflow
 * - Falls back to plain text when depth limit exceeded
 * 
 * **Error Handling:**
 * - Always decrements depth counter in finally block
 * - Falls back to plain text if parsing fails
 * - Logs warnings for depth limit or parsing errors
 * 
 * @param state - Markdown-it parsing state
 * @param content - Text content to process with markdown
 * 
 * @example
 * ```typescript
 * // Input: "This is **bold** and *italic*"
 * // Output: Tokens for text, strong_open, text("bold"), strong_close, text(" and "), em_open, text("italic"), em_close
 * processTextWithMarkdown(state, content);
 * ```
 */
function processTextWithMarkdown(state: MarkdownItState, content: string): void {
    // Handle empty content edge case
    if (!content || content.length === 0) {
        const emptyText = state.push('text', '', 0);
        emptyText.content = '';
        return;
    }
    
    // Check recursion depth using WeakMap-based tracking
    // Prevents stack overflow in pathological cases like: ++ref|++nested|++deep|text+++++
    if (getParseDepth(state) >= MAX_PARSE_DEPTH) {
        // Exceeded maximum nesting level, treat as plain text
        // This is a normal protective measure, not an error condition
        const plainText = state.push('text', '', 0);
        plainText.content = content;
        return;
    }
    
    // Increment parse depth counter before recursive parsing
    incrementParseDepth(state);
    
    try {
        // Use parseInline for proper inline markdown processing
        // This creates a temporary environment and parses the content,
        // producing inline tokens (text, strong, em, code, link, etc.)
        const tempEnv = {};
        const tokens = state.md.parseInline(content, tempEnv);
        
        if (tokens && tokens[0] && tokens[0].children) {
            // Transfer the resulting inline tokens to our token stream
            // This preserves all markdown formatting within notes/sidebars
            tokens[0].children.forEach((token) => {
                const newToken = state.push(token.type, token.tag, token.nesting);
                
                // Copy all token properties (content, markup, attrs, meta, etc.)
                // Preserve everything except type/tag/nesting which are set by push()
                Object.keys(token).forEach(key => {
                    if (key !== 'type' && key !== 'tag' && key !== 'nesting') {
                        newToken[key] = token[key];
                    }
                });
            });
        } else {
            // Fallback if parsing fails unexpectedly
            const plainText = state.push('text', '', 0);
            plainText.content = content;
        }
    } finally {
        // CRITICAL: Always decrement counter to prevent depth leaks
        // This ensures the counter is accurate even if parsing throws an exception
        decrementParseDepth(state);
    }
}