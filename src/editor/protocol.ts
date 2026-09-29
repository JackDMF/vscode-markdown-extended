import type { ParsedDocumentJSON } from './parse';
import type { MappedPagePosition, MappedSourcePosition, SourcePosition } from './positions';

/**
 * The messages between the rich editor's webview and the extension host.
 *
 * Types only: the webview bundle imports this module, and a runtime import
 * would drag the parser (and markdown-it with it) into the browser.
 *
 * The division of labour is fixed by where each fact lives. The host owns the
 * `TextDocument` and the engine, so it parses and renders; the webview owns the
 * ProseMirror state, so it serializes. What crosses is the parsed document one
 * way and the finished text the other — never a diff, because a diff computed
 * against a document the other side no longer holds is how an edit lands in the
 * wrong place.
 */

/**
 * One code lens as the page draws it. `id` names the lens in the host's
 * registry, where its command stays — a command's `arguments` may hold objects
 * that do not survive `postMessage` — and is absent for a lens whose command
 * has no command id: its title is shown as text, as the text editor shows it.
 *
 * `surface`, `artifact`, `relation` and `direction` are the lens's own
 * statement of which rendered element it is about (`LensHint`, read by
 * `host/lenses.ts`); all are absent for a lens that makes none — a foreign lens.
 */
export interface LensItem {
    id?: string;
    title: string;
    tooltip?: string;
    surface?: LensSurface;
    artifact?: string;
    relation?: string;
    direction?: LensDirection;
}

/**
 * Which side of a relation a `links` lens counts: the artifact's own edges
 * (`out`) or the ones pointing at it (`in`). A symmetric relation
 * (`conflicts-with`) has a row for each under one key, and only this tells
 * them apart.
 */
export type LensDirection = 'out' | 'in';

/**
 * The rendered element a lens is about, as the extension that made it names
 * it (Req Explorer's side of the contract, 2026-09-28): the status badge on the
 * artifact's heading, the priority row or a relation row of its summary table,
 * or no element — a verb of the heading.
 */
export type LensSurface = 'status' | 'priority' | 'links' | 'action';

/**
 * What a lens carries, as the last element of `command.arguments`, to say which
 * surface it belongs to. `artifact` is the readable id the page matches against
 * the injection marks (`InjectionMark.artifact`); `relation` is the relation
 * key of a `links` lens, matched against `tr[data-req-relation]`, and
 * `direction` its side, matched against `tr[data-req-direction]` — absent from
 * a Req Explorer older than it, whose lens then takes the relation's first row.
 * The argument stays in place when the command runs: it is the provider's, not
 * the page's.
 */
export interface LensHint {
    reqExplorer: { surface: LensSurface; artifact: string; relation?: string; direction?: LensDirection };
}

/** The lenses of one top-level block, in line order, drawn as one row above it. */
export interface LensRow {
    /** The index of the top-level block, in the parse of the document version the rows are for. */
    blockIndex: number;
    items: LensItem[];
}

/**
 * One code action another extension offers for a block, as the object toolbar
 * draws it: a verb after the object's own. `id` names it in the host's
 * registry, where the action (its `WorkspaceEdit`, its command) stays; `kind`
 * is its `CodeActionKind` (`quickfix`, `refactor.rewrite`, …) or `''`;
 * `refusal` is why a disabled one cannot be chosen.
 */
export interface CodeActionItem {
    id: string;
    title: string;
    kind: string;
    refusal?: string;
}

/** Host → webview. */
export type HostMessage =
    /**
     * The document to show. `version` is the `TextDocument` version it was parsed
     * from and comes back as an edit's `baseVersion`; `defaultWrap` is
     * `markdownExtended.editor.wrapColumn` as it applies to this file.
     * `includes` says whether any installed extension offers include choices
     * (`host/includes.ts`): the page enables **Insert → Include…** and an
     * expansion's **Change snippet…** only then.
     */
    | { type: 'document'; json: ParsedDocumentJSON; version: number; defaultWrap: number; includes: boolean }
    /** The answer to a `render` request: the raw block's source rendered by the host's engine. */
    | { type: 'rendered'; requestId: number; html: string }
    /** The document cannot be shown without losing a byte; the webview offers the text editor instead. */
    | { type: 'error'; message: string }
    /**
     * Every other extension's code lenses on the document, as VS Code hands
     * them to the text editor, grouped by the top-level block each one's line
     * is in (`host/lenses.ts`). `version` is the document version they were
     * asked for and `blocks` the number of top-level blocks of its parse: the
     * page takes the rows only while it holds as many, and otherwise waits for
     * the refresh that follows its own edit. Empty `rows` clear the page's.
     */
    | { type: 'lenses'; version: number; blocks: number; rows: LensRow[] }
    /** The answer to `actionsFor`: the code actions for that block's lines, empty when there are none or the page's text is not the document's. */
    | { type: 'actions'; requestId: number; blockIndex: number; items: CodeActionItem[] }
    /**
     * Every `actions` answer the page holds may be out of date — the document's
     * diagnostics changed, an edit landed, an answer was computed against a
     * text that changed meanwhile — and is asked again when its bar shows.
     * With `refused`, a `runAction` for the action of that title was not applied
     * because the text changed since it was offered; the page says so.
     */
    | { type: 'invalidateActions'; refused?: string }
    /**
     * Bring the element a link's fragment names into view and put the caret
     * there: a link followed to this document, from another one or from
     * itself. `anchor` is the fragment; `line` is the 0-based line the host
     * resolved it to in the document's text (a `{#id}`, a heading's slug, a
     * line fragment — `host/links.ts`), `null` when it names none there. The
     * page takes a heading whose `anchor` is the fragment first, else the
     * block that line starts, so the slug rule lives only on the host.
     */
    | { type: 'revealAnchor'; anchor: string; line: number | null }
    /**
     * The answer to `pickInclude`: the line the person chose, exactly as the
     * extension offering it wrote it (`IncludeChoice.insert`, one line without
     * its terminator); absent when they dismissed the pick or nothing was offered.
     */
    | { type: 'includeChosen'; requestId: number; insert?: string }
    /**
     * Report the caret again, although the page's last report may be the same:
     * the host forgot it (another writer's change came and went without a new
     * document) and has nothing to offer until the page speaks.
     */
    | { type: 'reportCaret' }
    /**
     * Map positions with the page's own document (`positions.ts`), which owns
     * the mapping: each of `toSource` a ProseMirror position, each of `toPage`
     * a position in the text. Answered with `mapped` of the same `id`, after
     * the page's pending edit, so the answer is in the text the host holds.
     */
    | { type: 'map'; id: number; toSource?: number[]; toPage?: SourcePosition[] };

/** Webview → host. */
export type WebviewMessage =
    /** The script has loaded and listens; the host answers with `document` (or `error`). */
    | { type: 'ready' }
    /**
     * The whole document as the webview would save it, for the `document` of
     * version `baseVersion`. With `save`, the person pressed Ctrl+S (which the
     * webview kept from VS Code): the host saves the document once the edit is
     * applied — or dropped as stale — and the text is sent even when unchanged.
     * With `reparse`, the page wrote syntax it cannot show as rich text (a
     * toolbar construct outside the editable core, inserted as source): the host
     * applies the edit and then posts the document parsed afresh, although its
     * text is the page's own — the one case the page asks to see its edit again.
     */
    | { type: 'edit'; text: string; baseVersion: number; save?: true; reparse?: true }
    /** Render a raw block's source after the person edited it. */
    | { type: 'render'; requestId: number; src: string }
    /** Open the snippet file an include expansion was read from (`mark.path`). */
    | { type: 'openSnippet'; path: string }
    /**
     * Follow a link the person Ctrl/Cmd+clicked — in rich text or in a rendered
     * block — or plain-clicked in a read model (Req Explorer's summary table),
     * with its `href` exactly as the element carries it. The host
     * resolves a relative one against the document (`host/links.ts`); a link
     * to a heading of this very document never comes here, the page scrolls.
     */
    | { type: 'openLink'; href: string }
    /** Open the text editor beside this one, revealing a 0-based line. */
    | { type: 'openSource'; line: number }
    /**
     * Ask VS Code for the lenses again. The host refreshes by itself after
     * every document it posts and every edit it applies; the page asks when
     * it comes back into view or takes the focus, since a lens can depend on
     * other files (Req Explorer's coverage counts do) and no provider's
     * change event reaches another extension.
     */
    | { type: 'refreshLenses' }
    /** Run the command of the lens `id` from the last `lenses` message. */
    | { type: 'runLens'; id: string }
    /**
     * The object toolbar opened for the top-level block `blockIndex` of a page
     * holding `blocks` of them: ask VS Code for the code actions on its lines.
     * Sent after any pending edit, so the host answers for the page's text.
     */
    | { type: 'actionsFor'; requestId: number; blockIndex: number; blocks: number }
    /** Apply the code action `id` from an `actions` answer: its edit, then its command. */
    | { type: 'runAction'; id: string }
    /**
     * Ask for an include line: the host collects the choices other extensions
     * offer for this document and shows them in VS Code's own QuickPick; the
     * answer is `includeChosen`. With `replace`, the line is to take the place
     * of the directive of the top-level block `blockIndex` (an expansion's
     * **Change snippet…**). Sent after any pending edit, so a provider that
     * reads the document reads the page's text.
     */
    | { type: 'pickInclude'; requestId: number; replace?: { blockIndex: number } }
    /**
     * Where the caret is, in the text of the document of version `baseVersion`
     * as the host holds it: a 0-based line and UTF-16 character
     * (`positions.ts`), `null` when there is none to report — a selected atom,
     * a gap cursor, a mapping that is only approximate. Sent 100 ms after the
     * selection settles, and only while the host holds the page's text (after
     * the pending edit, never before it); the host drops one whose
     * `baseVersion` is not the document it last posted, or that arrives while
     * the document holds another text.
     */
    | { type: 'caret'; baseVersion: number; position: SourcePosition | null }
    /**
     * The answer to `map`: one entry per position asked, in order, `null` for
     * one that is none. `baseVersion` is the document the page shows, `-1`
     * without one; sent after the page's pending edit. The host takes it in
     * its queue, behind that edit, and only for the document it last posted
     * while the document holds the page's text — any other answer is dropped.
     */
    | {
        type: 'mapped';
        id: number;
        baseVersion: number;
        toSource: (MappedSourcePosition | null)[];
        toPage: (MappedPagePosition | null)[];
    };

/**
 * What an extension offering includes exports beside `extendMarkdownIt`
 * (`listIncludeChoices(documentUri): Promise<IncludeChoice[]>`), one per
 * snippet it can include in that document. `label`, `description` and `detail`
 * are shown as a QuickPick item's; `insert` is the complete line to put into
 * the document — the directive in the provider's own syntax, which the editor
 * never writes or reads itself.
 */
export interface IncludeChoice {
    label: string;
    description?: string;
    detail?: string;
    insert: string;
}
