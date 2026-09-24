import type { ParsedDocumentJSON } from './parse';

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

/** Host → webview. */
export type HostMessage =
    /**
     * The document to show. `version` is the `TextDocument` version it was parsed
     * from and comes back as an edit's `baseVersion`; `defaultWrap` is
     * `markdownExtended.editor.wrapColumn` as it applies to this file.
     */
    | { type: 'document'; json: ParsedDocumentJSON; version: number; defaultWrap: number }
    /** The answer to a `render` request: the raw block's source rendered by the host's engine. */
    | { type: 'rendered'; requestId: number; html: string }
    /** The document cannot be shown without losing a byte; the webview offers the text editor instead. */
    | { type: 'error'; message: string };

/** Webview → host. */
export type WebviewMessage =
    /** The script has loaded and listens; the host answers with `document` (or `error`). */
    | { type: 'ready' }
    /**
     * The whole document as the webview would save it, for the `document` of
     * version `baseVersion`. With `save`, the person pressed Ctrl+S (which the
     * webview kept from VS Code): the host saves the document once the edit is
     * applied — or dropped as stale — and the text is sent even when unchanged.
     */
    | { type: 'edit'; text: string; baseVersion: number; save?: true }
    /** Render a raw block's source after the person edited it. */
    | { type: 'render'; requestId: number; src: string }
    /** Open the snippet file an include expansion was read from (`mark.path`). */
    | { type: 'openSnippet'; path: string }
    /** Open the text editor beside this one, revealing a 0-based line. */
    | { type: 'openSource'; line: number };
