/**
 * The delimiters of this extension's Markdown syntax, stated once.
 *
 * Three places write or read them: the text editor's toggle commands
 * (`src/commands/toggleFormats.ts`), the markdown-it plugins that parse them
 * (`src/plugin/`), and the Visual Editor's toolbar
 * (`src/editor/webview/toolbar/actions.ts`). Each of them imports this module,
 * so a toggle, the parser and a toolbar button cannot disagree about what a
 * construct is written as.
 *
 * It imports nothing — neither `vscode` nor markdown-it — because the
 * toolbar runs in the editor's webview, where neither exists.
 */

/**
 * The inline toggles' markers, keyed as `toggleFormats.ts` names its commands.
 * `strong` (`__`) has no toggle command; it is here because the toolbar offers
 * it, and `markdown-it-ib` renders it differently from `bold` (`**`).
 */
export const INLINE_MARKERS = {
    bold: '**',
    italics: '*',
    underline: '_',
    strong: '__',
    mark: '==',
    superscript: '^',
    subscript: '~',
    strikethrough: '~~',
    codeInline: '`',
} as const;

export type InlineMarkerName = keyof typeof INLINE_MARKERS;

/**
 * `markdown-it-kbd`'s delimiters, `[[Ctrl+S]]`. The package states them, not
 * this extension; they are written down here so the toolbar and the Visual
 * Editor's serializer take them from one place.
 */
export const KBD_MARKERS = { open: '[[', close: ']]' } as const;

/** Between a note's reference text and its content: `++reference|note++`. */
export const NOTE_SEPARATOR = '|';

/**
 * Sidenotes, marginal notes and sidebars (`markdownItSidenote.ts`): the marker
 * that opens and closes each, and the classes the rendered spans carry.
 */
export const NOTE_SYNTAX = {
    sidenote: { marker: '++', refClass: 'sn-ref', noteClass: 'sidenote' },
    marginalNote: { marker: '!!', refClass: 'mn-ref', noteClass: 'mnote' },
    leftSidebar: { marker: '$', cssClass: 'left-sidebar' },
    rightSidebar: { marker: '@', cssClass: 'right-sidebar' },
} as const;

/** A sidebar's marker character: `$` left, `@` right. */
export type SidebarMarker = '$' | '@';

/** A letter or a digit, in any script: what a sidebar marker must not touch on its outer side. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Whether a sidebar marker (`$` or `@`) with `before` and `after` around it
 * can open a sidebar: something follows it, and no letter or digit stands
 * right before it. So `a@b.c`, `user@host` and `US$5` open nothing. The side
 * inside may be a space: `$ left $` is a sidebar. `''` is the edge of the text.
 *
 * The notes plugin parses by this rule and its partner `sidebarCanClose`
 * (`markdownItSidenote.ts`), and the Visual Editor's serializer escapes by
 * them (`resolveSidebarMarkers`), so the two agree on which `$` and `@` are
 * markers.
 */
export function sidebarCanOpen(before: string, after: string): boolean {
    return after !== '' && !WORD_CHARACTER.test(before);
}

/**
 * Whether a sidebar marker with `after` right after it can close the sidebar
 * being looked for: no letter or digit follows it. So in `$5 and $10` the
 * second `$` closes nothing, and neither does the `@` of an email address.
 */
export function sidebarCanClose(after: string): boolean {
    return !WORD_CHARACTER.test(after);
}

/**
 * Stand-ins the Visual Editor's serializer writes for a sidebar marker
 * character while it writes a textblock, replaced once the whole textblock is
 * known (`resolveSidebarMarkers`): `text` for a `$` or `@` in text, `marker`
 * for a sidebar's own opening and closing marker. Private-use characters, one
 * per character, so the wrapper measures a line as it will be; not
 * U+E000–U+E003, which the wrapper's hold markers and the toolbar's stand-ins
 * are.
 */
export const SIDEBAR_STAND_INS: Readonly<Record<'text' | 'marker', Readonly<Record<SidebarMarker, string>>>> = {
    text: { '$': String.fromCharCode(0xe010), '@': String.fromCharCode(0xe011) },
    marker: { '$': String.fromCharCode(0xe012), '@': String.fromCharCode(0xe013) },
};

/** Any of the four stand-ins. */
export const SIDEBAR_STAND_IN_RE = new RegExp(`[${String.fromCharCode(0xe010)}-${String.fromCharCode(0xe013)}]`, 'g');

/** A sidebar marker character in written text, and what wrote it: text, a sidebar, or anything else (code, a URL, …). */
interface WrittenMarker {
    at: number;
    ch: SidebarMarker;
    kind: 'text' | 'marker' | 'other';
}

function standInOf(ch: string): { ch: SidebarMarker; kind: 'text' | 'marker' } | null {
    for (const kind of ['text', 'marker'] as const) {
        for (const marker of ['$', '@'] as const) {
            if (SIDEBAR_STAND_INS[kind][marker] === ch) {
                return { ch: marker, kind };
            }
        }
    }
    return null;
}

/**
 * `written`, one textblock's inline Markdown holding the stand-ins of
 * `SIDEBAR_STAND_INS`, with each replaced, so that the sidebar rule reads the
 * sidebars' own markers as markers and no `$` or `@` of the text as one.
 * Characters in `transparent` (the wrapper's hold markers) are skipped when a
 * marker's neighbours are read.
 *
 * - A sidebar's marker touching a letter or digit outside it would not be
 *   read as a marker, so that letter is written as a character reference.
 * - A `$` or `@` in text is escaped (`\$`) where it could close the sidebar of
 *   its character it stands in, or where it could open a sidebar and a later
 *   one of the same character, not escaped itself, could close it — within
 *   the sidebar's text when it stands in a sidebar of its character, since
 *   that text is read on its own.
 * - Otherwise it is written as it is: an email address, a lone `$5` or `@{…}`
 *   gains no backslash.
 *
 * A `$` or `@` no stand-in wrote (in code, a URL, an attribute literal) is
 * never changed, and counts as a partner that might pair with the text's: an
 * escape too many is harmless there, one too few would make a sidebar.
 */
export function resolveSidebarMarkers(written: string, transparent = ''): string {
    const chars = Array.from(written);
    const step = (from: number, by: 1 | -1): number => {
        let i = from + by;
        while (i >= 0 && i < chars.length && transparent.includes(chars[i])) {
            i += by;
        }
        return i;
    };
    // The character the plugin reads on that side; one written as a character reference reads as its `&` or `;`.
    const plainAt = (i: number, side: 'before' | 'after'): string => {
        if (i < 0 || i >= chars.length) {
            return '';
        }
        const spelled = Array.from(standInOf(chars[i])?.ch ?? chars[i]);
        return side === 'before' ? spelled[spelled.length - 1] : spelled[0];
    };

    // A sidebar's own markers first: what touches one outside becomes a character reference.
    const openAt: Record<SidebarMarker, boolean> = { '$': false, '@': false };
    chars.forEach((ch, i) => {
        const standIn = standInOf(ch);
        if (standIn === null || standIn.kind !== 'marker') {
            return;
        }
        const outside = openAt[standIn.ch] ? step(i, 1) : step(i, -1);
        if (outside >= 0 && outside < chars.length && WORD_CHARACTER.test(chars[outside])) {
            chars[outside] = `&#${chars[outside].codePointAt(0)};`;
        }
        openAt[standIn.ch] = !openAt[standIn.ch];
    });

    const markers: WrittenMarker[] = [];
    chars.forEach((ch, i) => {
        const standIn = standInOf(ch);
        if (standIn !== null) {
            markers.push({ at: i, ...standIn });
        } else if (ch === '$' || ch === '@') {
            markers.push({ at: i, ch, kind: 'other' });
        }
    });
    const canOpen = (m: WrittenMarker) => sidebarCanOpen(plainAt(step(m.at, -1), 'before'), plainAt(step(m.at, 1), 'after'));
    const canClose = (m: WrittenMarker) => sidebarCanClose(plainAt(step(m.at, 1), 'after'));

    // For each marker, the index in `markers` of the closing marker of the
    // sidebar of its character it stands in, or null outside one.
    const insideUntil: (number | null)[] = [];
    const open: Record<SidebarMarker, number | null> = { '$': null, '@': null };
    markers.forEach((m, index) => {
        insideUntil.push(m.kind === 'marker' ? null : open[m.ch]);
        if (m.kind === 'marker') {
            const end = markers.findIndex((n, k) => k > index && n.kind === 'marker' && n.ch === m.ch);
            open[m.ch] = open[m.ch] === null ? (end === -1 ? markers.length : end) : null;
        }
    });

    // From the end, so a later marker that is escaped is known to close nothing.
    const escaped = new Set<number>();
    for (let index = markers.length - 1; index >= 0; index--) {
        const m = markers[index];
        if (m.kind !== 'text') {
            continue;
        }
        // Inside a sidebar of its character the text is read on its own, up to the sidebar's end.
        const scopeEnd = insideUntil[index] ?? markers.length;
        const opens = canOpen(m) && markers.slice(index + 1, scopeEnd)
            .some((n, k) => n.ch === m.ch && !escaped.has(index + 1 + k) && canClose(n));
        const closes = canClose(m) && (insideUntil[index] !== null
            || markers.slice(0, index).some(n => n.kind === 'other' && n.ch === m.ch && canOpen(n)));
        if (opens || closes) {
            escaped.add(index);
        }
    }
    const escapedAt = new Set([...escaped].map(index => markers[index].at));

    return chars.map((ch, i) => {
        const standIn = standInOf(ch);
        if (standIn === null) {
            return ch;
        }
        return escapedAt.has(i) ? `\\${standIn.ch}` : standIn.ch;
    }).join('');
}

/** What opens an admonition block (`markdownItAdmonition.ts`): at least this many `!`. */
export const ADMONITION_MARKER = '!!!';

/**
 * Every admonition type the plugin recognises, in its order; a name outside
 * the list is read as a title of a `note`. Aliases share a look in
 * `styles/markdown-it-admonition.css` (`summary`, `abstract`, `tldr`, …).
 */
export const ADMONITION_TYPES: readonly string[] = [
    'note',
    'summary', 'abstract', 'tldr',
    'info', 'todo',
    'tip', 'hint',
    'success', 'check', 'done',
    'question', 'help', 'faq',
    'warning', 'attention', 'caution',
    'failure', 'fail', 'missing',
    'danger', 'error', 'bug',
    'example', 'snippet',
    'quote', 'cite',
];
