import type { InlineEngineDefinition } from './inlineEngine';
import type { ParsedDocumentJSON } from './parse';
import type { MappedPagePosition, MappedSourcePosition, SourcePosition, SourceRange } from './positions';

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

/**
 * One completion another extension offers at the caret, as the page lists it
 * (`host/completion.ts`). `insertText` is what the source will hold — a
 * snippet's placeholders filled with their defaults — and `range` the source
 * range it replaces (VS Code's `inserting` range, the default insert mode), in
 * the text the host held when it asked. `kind` is the `CompletionItemKind`'s
 * name, lower-case (`reference`, `file`, …). The page filters by `filterText`,
 * else `label`, and never writes the item itself: accepting it is
 * `applyCompletion`, which the host applies to the source.
 */
export interface CompletionEntry {
    label: string;
    detail?: string;
    kind?: string;
    insertText: string;
    range?: SourceRange;
    sortText?: string;
    filterText?: string;
}

/** How bad a diagnostic is, as the page draws it: VS Code's four `DiagnosticSeverity` values. */
export type DiagnosticSeverityName = 'error' | 'warning' | 'info' | 'hint';

/**
 * One diagnostic VS Code holds for the document (`languages.getDiagnostics`),
 * its `range` in the text the host holds for the page. `code` is the
 * diagnostic's code as text (a `{ value, target }` code's value).
 */
export interface DiagnosticEntry {
    range: SourceRange;
    severity: DiagnosticSeverityName;
    message: string;
    code?: string;
    source?: string;
}

/** Host → webview. */
export type HostMessage =
    /**
     * The document to show. `version` is the `TextDocument` version it was parsed
     * from and comes back as an edit's `baseVersion`; `defaultWrap` is
     * `markdownExtended.editor.wrapColumn` as it applies to this file.
     * `includes` says whether any installed extension offers include choices
     * (`host/includes.ts`): the page enables **Insert → Include…** and an
     * expansion's **Change snippet…** only then. `inline` is the engine that
     * parsed it, as far as the page runs it (`inlineEngineDefinition`): its
     * `markdown.preview.linkify` and `markdown.preview.typographer`, the
     * plugins of the registry the page runs too, and whether VS Code's math read
     * `$` in it (`math`, `markdown.math.enabled` as the engine applied it). The
     * page reads each textblock an edit makes the save write again with an
     * engine built from it, so that it refuses an edit after which a sidebar
     * would not read back as it is shown — VS Code's math, when it runs, as
     * a stand-in for its tokenizer, so a left sidebar the math reads is none.
     */
    | { type: 'document'; json: ParsedDocumentJSON; version: number; defaultWrap: number; includes: boolean; inline: InlineEngineDefinition }
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
     * The answer to `linkChoices`: what a link's (or an image's) field may
     * complete its value with, best first and capped (`host/linkChoices.ts`).
     * The field shows the answer to its latest query only.
     */
    | { type: 'linkChoicesResult'; requestId: number; items: LinkChoice[] }
    /**
     * The answer to `pickImage`, `insertFiles` and `saveImage`: each file as
     * the page inserts it, its path relative to the document (`LinkedFile`) —
     * for `saveImage`, the file the host wrote. Empty when the dialog was
     * dismissed, no file could be linked, or the bitmap could not be written
     * (the host says why in its log and a message).
     */
    | { type: 'filesChosen'; requestId: number; files: LinkedFile[] }
    /**
     * The answer to `resolveImages`: for each asked `src` the host could
     * resolve to a file, the address the page loads it from
     * (`webview.asWebviewUri`). A `src` left out is shown as written — a web
     * address, a `data:` image, one that names no file. Display only: the
     * node keeps the `src` the file holds.
     */
    | { type: 'imagesResolved'; requestId: number; sources: Record<string, string> }
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
    | { type: 'map'; id: number; toSource?: number[]; toPage?: SourcePosition[] }
    /**
     * The answer to `complete`: what the completion providers VS Code runs for
     * the document offer at that position (`vscode.executeCompletionItemProvider`),
     * in their order, capped; `incomplete` when a provider said its list is
     * (the page asks again as the typed text grows). `version` is the document
     * the page showed when it asked; empty when the page's text was not the
     * document's or the document changed while the providers computed.
     */
    | { type: 'completions'; requestId: number; version: number; items: CompletionEntry[]; incomplete: boolean }
    /**
     * The answer to `applyCompletion`, after the document it produced was
     * posted: where the caret goes in that document's text (the end of the
     * inserted text, or a snippet's final tab stop), `null` when nothing was
     * applied — the text changed since the completion was offered.
     */
    | { type: 'completionApplied'; requestId: number; version: number; caret: SourcePosition | null }
    /**
     * Every diagnostic VS Code holds for the document, in the text the host
     * holds for the page of `version` (the document it last posted — the
     * page's own edits since included). Sent when the diagnostics change
     * (debounced) and after every document — not after an edit of the page's,
     * which the providers have not linted yet; never while a change the page
     * has not seen is on its way.
     */
    | { type: 'diagnostics'; version: number; items: DiagnosticEntry[] }
    /** The answer to `quickFixesFor`: the quick fixes VS Code offers for that range, run with `runAction`. */
    | { type: 'quickFixes'; requestId: number; items: CodeActionItem[] }
    /**
     * The answer to `hover`: the hover providers' Markdown for that position,
     * rendered by the host (`host/hover.ts`) — parts joined by a rule, command
     * links the hover may run carrying `data-mep-command` ids of the host's
     * registry, every other `command:` link stripped to its text — and the
     * source range the hover is about. `html` is empty when there is none.
     */
    | { type: 'hoverResult'; requestId: number; html: string; range?: SourceRange };

/**
 * One completion of a link's field: `value` is what the field then holds — a
 * path relative to the document, percent-encoded as a destination is written,
 * or `#anchor` after one — `label` what the list shows, `detail` a heading's
 * text. `kind` says what it names.
 */
export interface LinkChoice {
    value: string;
    label: string;
    detail?: string;
    kind: 'file' | 'heading';
}

/**
 * A file the page links to: `src` its path relative to the document (POSIX
 * separators, percent-encoded as a destination is written), `alt` its name
 * without the extension, `image` whether it is inserted as an image — any
 * other file becomes a link named by its file name.
 */
export interface LinkedFile {
    src: string;
    alt: string;
    image: boolean;
}

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
     * Completions for a link's field holding `query`: workspace files relative
     * to the document (Markdown first), the current document's headings for a
     * `#…`, a target file's headings for `path#…`. With `images`, image files
     * only (an image's path). Answered with `linkChoicesResult`.
     */
    | { type: 'linkChoices'; requestId: number; query: string; images?: true }
    /** Ask for an image file in VS Code's open dialog (**Insert → Image…**); answered with `filesChosen`. */
    | { type: 'pickImage'; requestId: number }
    /**
     * Files dropped into the page from VS Code's Explorer view — its
     * `resourceurls`, or the `file:` lines of a `text/uri-list` — as uris; the
     * host makes each relative to the document. Answered with `filesChosen`.
     */
    | { type: 'insertFiles'; requestId: number; uris: string[] }
    /**
     * A bitmap with no file behind it, `bytes` base64: a screenshot pasted from
     * the clipboard, or an image dropped from the system (the webview is given
     * its bytes and name, never its path, so it is copied). The host writes it
     * beside the document — where `markdown.copyFiles.destination` says, else
     * `images/<suggestedName>` for a dropped file and
     * `images/<document>-<yyyymmdd-hhmmss>.<ext>` for a screenshot — and answers
     * with `filesChosen`.
     */
    | { type: 'saveImage'; requestId: number; bytes: string; suggestedName: string }
    /** Where the page may load these images' `src` from; answered with `imagesResolved`. */
    | { type: 'resolveImages'; requestId: number; srcs: string[] }
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
    }
    /**
     * Ask the completion providers at `position` — the caret, in the text of
     * the document of `baseVersion` as the host holds it: sent after the
     * page's pending edit, as `map` is answered. `triggerCharacter` is the
     * non-word character just typed (`Ctrl+Space` sends none). Answered with
     * `completions`.
     */
    | { type: 'complete'; requestId: number; baseVersion: number; position: SourcePosition; triggerCharacter?: string }
    /**
     * Accept item `index` of the `completions` answer `requestId`: the host
     * applies its edit to the source — the item's range, extended over what
     * the page typed since the answer, and its additional edits — and posts
     * the document; `position` is the caret now, where a range the page typed
     * into since the answer ends. Sent after the pending edit.
     */
    | { type: 'applyCompletion'; requestId: number; index: number; baseVersion: number; position: SourcePosition }
    /** The quick fixes for a diagnostic's source `range`, in the text of `baseVersion`; answered with `quickFixes`. */
    | { type: 'quickFixesFor'; requestId: number; baseVersion: number; range: SourceRange }
    /** Ask the hover providers at `position` (the pointer, rested), in the text of `baseVersion`; answered with `hoverResult`. */
    | { type: 'hover'; requestId: number; baseVersion: number; position: SourcePosition }
    /** Run the command link `id` of the last `hoverResult` — one the hover was trusted to run. */
    | { type: 'runHoverCommand'; id: string }
    /** **Show more** on a clipped hover: open the text editor at the hover's position and show VS Code's own hover there. */
    | { type: 'showHoverInEditor'; requestId: number }
    /** The diagnostics count in the toolbar was clicked: show VS Code's Problems view. */
    | { type: 'showProblems' };

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
