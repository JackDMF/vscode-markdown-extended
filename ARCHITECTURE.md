# Architecture Documentation

## Table of Contents

- [Overview](#overview)
- [Design Principles](#design-principles)
- [Core Architecture](#core-architecture)
- [Service Layer](#service-layer)
- [Plugin System](#plugin-system)
- [WYSIWYG Editor](#wysiwyg-editor)
- [Testing Strategy](#testing-strategy)
- [Key Design Decisions](#key-design-decisions)

---

## Overview

Markdown Extended is a VS Code extension that provides enhanced markdown syntax support and powerful export capabilities (HTML, PDF, PNG, JPG). The codebase follows modern TypeScript patterns with emphasis on:

- **Singleton Pattern** - Centralized service management
- **Dependency Injection** - Testable, decoupled components
- **Async/Await** - Non-blocking I/O operations
- **Comprehensive Error Handling** - User-friendly error recovery
- **Test Coverage** - 65+ unit tests ensuring reliability

---

## Design Principles

### 1. **Single Responsibility Principle (SRP)**

Each service has a clear, focused purpose:

- `ExtensionContext` - Extension state management
- `BrowserManager` - Browser lifecycle
- `ErrorHandler` - Error reporting and recovery
- `Config` - Configuration access

### 2. **Singleton Pattern**

Services are implemented as singletons to ensure:

- **Consistent state** across the extension
- **Resource efficiency** (one browser instance, one config reader)
- **Testability** via `_setInstance()` methods

### 3. **Async-First Design**

All I/O operations use `async/await` and `fs.promises`:

- **Non-blocking** file operations
- **Better concurrency** for multiple exports
- **Modern Node.js** best practices

### 4. **Defensive Programming**

- Input validation on all public APIs
- Null checks before accessing optional properties
- Try-catch blocks with contextual error handling
- Resource cleanup in finally blocks

---

## Core Architecture

``` text
vscode-markdown-extended/
├── src/
│   ├── extension.ts              # Entry point, activation/deactivation
│   ├── commands/                 # VS Code commands
│   │   ├── command.ts           # Base command class
│   │   ├── commands.ts          # Command registry
│   │   ├── exportCurrent.ts     # Export single file
│   │   ├── exportWorkspace.ts   # Export all files
│   │   └── ...
│   ├── services/                 # Core services layer
│   │   ├── common/              # Shared utilities
│   │   │   ├── extensionContext.ts  # State management
│   │   │   ├── errorHandler.ts      # Error handling
│   │   │   ├── config.ts             # Configuration
│   │   │   └── tools.ts              # File utilities
│   │   ├── browser/
│   │   │   └── browserManager.ts    # Browser lifecycle
│   │   ├── exporter/            # Export engines
│   │   │   ├── html.ts          # HTML exporter
│   │   │   ├── puppeteer.ts     # PDF/Image exporter
│   │   │   ├── mermaidRenderer.ts      # Mermaid → inline SVG (headless Chromium)
│   │   │   ├── mermaidBrowserEntry.ts  # Browser harness exposing mermaid (bundled separately)
│   │   │   └── export.ts        # Export orchestration
│   │   └── contributes/
│   │       ├── contributorService.ts   # Plugin contributions
│   │       └── contributesService.ts   # Config contributions
│   ├── editor/                   # WYSIWYG editor (see its own section)
│   │   ├── engine.ts, blocks.ts, schema.ts, parse.ts, serialize.ts, wrap.ts, fidelity.ts  # UI-free core
│   │   ├── protocol.ts          # Host ↔ webview messages (types only)
│   │   ├── host/                # Extension host: engine, session, page, provider
│   │   └── webview/             # The ProseMirror page (bundled to dist/editor-webview.js)
│   │       └── toolbar/         # Formatting toolbar: action table, commands, DOM
│   ├── syntax/
│   │   └── markers.ts           # The extension's markers, stated once (toggles, plugins, toolbar)
│   └── plugin/                   # Markdown-it plugins
│       ├── markdownItTOC.ts
│       ├── markdownItContainer.ts
│       ├── markdownItAdmonition.ts
│       └── ...
└── test/
    └── unit/                     # Unit tests (65+ tests)
```

---

## Service Layer

### ExtensionContext

**Purpose:** Centralized extension state management, replacing global mutable variables.

**Pattern:** Thread-safe singleton with lazy initialization.

```typescript
// Initialize once during activation
ExtensionContext.initialize(context);

// Access anywhere in the codebase
const markdown = ExtensionContext.current.markdown;
const outputPanel = ExtensionContext.current.outputPanel;
```

**Key Features:**

- ✅ Replaces global `markdown`, `context`, `outputPanel` variables
- ✅ Explicit initialization check with helpful error messages
- ✅ Cleanup method for proper resource disposal
- ✅ Testable via `_reset()` method

---

### BrowserManager

**Purpose:** Centralized browser management for Puppeteer-based exports.

**Pattern:** Singleton with dependency injection (ExtensionContext).

```typescript
const browserManager = BrowserManager.getInstance(context);
const executablePath = await browserManager.ensureBrowser(progress);
```

**Key Features:**

- ✅ Automatic browser download and installation
- ✅ Platform detection (Windows, macOS, Linux)
- ✅ Custom executable path support
- ✅ Force reinstall option
- ✅ Progress reporting for downloads

**Eliminates:**

- ❌ Code duplication between PuppeteerExporter and CommandInstallBrowser
- ❌ Inconsistent browser installation logic

---

### ErrorHandler

**Purpose:** Consistent error reporting, logging, and recovery across the extension.

**Pattern:** Static utility class with contextual error handling.

```typescript
try {
    await riskyOperation();
} catch (error) {
    await ErrorHandler.handle(error, {
        operation: 'Export PDF',
        filePath: document.uri.fsPath,
        recoveryOptions: [{
            label: 'Retry',
            action: () => riskyOperation()
        }]
    }, ErrorSeverity.Error);
}
```

**Key Features:**

- ✅ Four severity levels: Critical, Error, Warning, Info
- ✅ Contextual information (operation, file path, details)
- ✅ User-friendly error messages
- ✅ Recovery options (Retry, Install Browser, etc.)
- ✅ Logging to output panel

---

### Config

**Purpose:** Type-safe configuration access with validation.

**Pattern:** Singleton extending ConfigReader.

```typescript
const config = Config.instance;
const disabled = config.disabledPlugins;  // string[]
const levels = config.tocLevels;          // number[]
```

**Key Features:**

- ✅ Type-safe property accessors
- ✅ Default values when not configured
- ✅ Validation (e.g., file existence checks)
- ✅ Folder-specific configuration support

---

## Plugin System

### Architecture

Markdown Extended extends VS Code's built-in markdown preview using the `extendMarkdownIt` API. Plugins are registered in `src/plugin/plugins.ts` and loaded dynamically.

### Plugin Pattern

**Correct Pattern:**

```typescript
/**
 * Markdown-it plugin that modifies the markdown-it instance directly.
 * @param md - The markdown-it instance
 */
export function MyPlugin(md: MarkdownIt): void {
    // ✅ Directly modify md's rules, renderer, etc.
    md.renderer.rules.custom = renderFunction;
    md.core.ruler.push("customRule", ruleFunction);
    
    // ✅ If wrapping another plugin, invoke it directly
    const externalPlugin = require('markdown-it-something');
    externalPlugin(md, options);
    
    // ❌ NEVER call md.use() inside a plugin
    // md.use(externalPlugin, options); // WRONG!
}
```

**Why This Matters:**

- `md.use(plugin, options)` is the **public API** for adding plugins
- Plugin functions themselves should **never** call `md.use()`
- Nested `md.use()` calls cause `TypeError: e.apply is not a function`

### Plugin Types

1. **Custom Plugins** (owned by this extension)
   - `markdownItTOC` - Table of contents with anchor links
   - `markdownItContainer` - Custom container blocks (`::: warning`)
   - `markdownItAdmonition` - GitHub-style admonitions
   - `markdownItAnchorLink` - Anchor link slugification
   - `markdownItExportHelper` - Image embedding for exports
   - `markdownItSidenote` - Sidenote and marginal note support

2. **External Plugins** (npm packages)
   - `markdown-it-footnote` - Footnote support
   - `markdown-it-abbr` - Abbreviation definitions
   - `markdown-it-kbd` - Keyboard key rendering
   - `markdown-it-emoji` - Emoji support
   - `markdown-it-multimd-table` - Advanced table features
   - And more...

### Plugin Registration

```typescript
// src/plugin/plugins.ts
export var plugins: markdownItPlugin[] = [
    $('markdown-it-table-of-contents', { includeLevel: Config.instance.tocLevels }),
    $('markdown-it-container'),
    $('markdown-it-admonition'),
    // ...
].filter(p => !!p);

// Helper function that loads plugins
function $(name: string, ...args: any[]): markdownItPlugin | undefined {
    if (Config.instance.disabledPlugins.some(d => `markdown-it-${d}` === name)) return;
    const plugin = myPlugins[name] || require(name);
    return plugin ? { plugin, args } : undefined;
}
```

### Plugin Disabling

Users can disable plugins via settings:

```json
{
    "markdownExtended.plugins.disabled": "toc, container, emoji"
}
```

---

## WYSIWYG Editor

`src/editor/` is an experimental rich editor for Markdown files, whose one hard
promise is that a block nobody touched is saved byte for byte. Its contract with Req Explorer is
written down in that repository
(`requirements/workshops/2026-09-21-workshop-editor-integration-contract.md`, and
`packages/core/SPEC.md` §10.2–10.3).

### One parser, two renderers

The editor does not parse Markdown itself. `createEditorEngine` (`engine.ts`)
builds a markdown-it instance composed the way VS Code composes its preview
engine — raw HTML on, linkify and typographer from `markdown.preview.*`, this
extension's registry from `src/plugin/plugins.ts`, then every other extension's
`extendMarkdownIt` — and `host/engineHost.ts` feeds it the extenders of every
installed extension whose manifest sets `markdown.markdownItPlugins`, and repeats
the two things the preview does to its engine afterwards (linkify without fuzzy
links, `breaks`). The preview renders those tokens to HTML; the editor turns the
same tokens into a ProseMirror document. Two parsers would be two answers to
"what does this file contain", and the first construct they disagreed on would be
edited as something it is not.

markdown-it is pinned to major 14, which is what VS Code's preview bundles, so the
two engines tokenize alike. The engine is built once per provider and rebuilt when
the set of extensions or one of those preview settings changes.

**Why the front-matter rule is on the editor engine only.** VS Code's preview
registers its own front-matter rule on the engine it hands to `extendMarkdownIt`,
and a second one from this extension conflicts with it (see the comment on
`plugins`). The editor engine is built from scratch, so nothing registers one for
it: without `markdown-it-front-matter` the YAML block would tokenize as a thematic
break and a setext heading — and front matter is the one block Req Explorer
requires to leave the editor exactly as it entered.

### The block model

`blocks.ts` groups the top-level tokens into **source blocks**, each with the exact
slice of the file it stands for (`src`) and the text between it and the previous
block (`gap`). Every block is one of four kinds:

| Kind | What | Node | Written back as |
| --- | --- | --- | --- |
| `front_matter` | The YAML block at the top | `front_matter` (atom) | Its `src`, always |
| `editable` | The stage-1 core: paragraph, heading, lists, blockquote, code, rule | The matching node, with `src` and `gap` | Its `src` while untouched; serialized by rule once changed |
| `raw` | Anything else — tables, HTML, this extension's syntax, lines no token covers | `raw_block` (atom, `html` rendered by the host) | Its `src`, which only an explicit source edit changes |
| `injected` | Content the file does not hold at this place | `injected_block` (atom) | An expansion's directive line, or nothing |

`parse.ts` rebuilds the text from the blocks and **throws** when it does not match,
so a document the model cannot represent is never opened for editing.

### Injected content

Req Explorer marks every token its preview plugin injects under
`token.meta.reqExplorer` (SPEC §10.2). The editor reads the mark and treats each kind
differently:

| Mark | Example | Editor treatment |
| --- | --- | --- |
| `atom` | Status badge, `table.req-summary` | A read-only block or inline atom showing the rendering; nothing is written |
| `expansion` | A snippet expanded from `<!-- include: id -->` | One read-only block; the directive line is written back. With `path`, an **Open snippet** button; a `missing` expansion has no path and offers nothing |
| `decoration` | `span.req-ref` around a bare id | Not a node: the id stays editable text, carrying a `req_ref` mark that is never serialized |

Token ranges nobody marked and no source line accounts for (the footnote list
`markdown-it-footnote` appends) become `injected_block`s of kind `generated`. A
requirement heading's `ID: ` prefix, recognised through the badge naming that id, is
lifted into `reqPrefix` and rendered non-editable; the `{#anchor}` suffix is kept
verbatim in `attrsSuffix`.

### Host and page

`host/provider.ts` registers a `CustomTextEditorProvider` (`markdownExtended.wysiwyg`,
priority `option`) over the file's own `TextDocument`, so Req Explorer's
`WorkspaceEdit`s, the text editor and the rich editor meet in one buffer and VS Code
keeps dirty state, save and undo. Each open editor is a `WysiwygSession`
(`host/session.ts`); the page is `webview/main.ts`, bundled on its own because it
must not import the parser (it imports `schema.ts`, `fidelity.ts` and `serialize.ts`
directly, never the barrel). That keeps this extension's plugins out of the page but not
markdown-it itself: `prosemirror-markdown`, which the serializer comes from, constructs a
default parser when it loads. The page's esbuild context therefore aliases `markdown-it`
to `webview/stubs/markdown-it.ts`, a callable that returns an empty object —
`MarkdownParser`'s constructor only stores it, and the page never parses. Should
`prosemirror-markdown` start using the tokenizer at load, the bundle throws as it loads
and the headless page test, which loads the real bundle, fails.

The protocol (`protocol.ts`) carries the parsed document one way and the finished
text the other — never a diff:

| Direction | Message | Meaning |
| --- | --- | --- |
| host → page | `document { json, version, defaultWrap }` | Show this parse of document `version` |
| host → page | `rendered { requestId, html }` | A raw block's new source, rendered by the host engine |
| host → page | `error { message }` | The document cannot be shown without loss; offer the text editor |
| page → host | `ready` | Loaded; send the document |
| page → host | `edit { text, baseVersion, save?, reparse? }` | The whole text as the page would save it (250 ms after the last change); with `save`, the person pressed Ctrl+S and the host saves after applying it; with `reparse`, the host posts the document back after applying it, although it is the page's own text (the toolbar wrote syntax as source) |
| page → host | `render { requestId, src }` | Render this raw block source |
| page → host | `openSnippet { path }` | Open an expansion's snippet file (only paths the document's own marks name are opened) |
| page → host | `openSource { line }` | Open the text editor beside, at this line |

The session remembers the text it believes the page holds. An `edit` is written only
when its `baseVersion` is the last posted version and the document still holds that
text — then as **one minimal replacement** (`host/minimalEdit.ts`: common prefix and
suffix, never splitting `\r\n` or a surrogate pair); otherwise the page is re-synced
and the edit dropped. A document change that leaves the text equal to the page's is
the page's own edit and is not posted back; any other change is re-parsed and posted.
In the error state nothing is written.

**Saving.** Ctrl+S anywhere in the page — the editor, a raw block's source textarea, the
page background — is kept from VS Code: a capture-phase listener on the page's window
stops the keydown before the bubble-phase listener there that forwards keys to the
workbench. It commits every open raw-source textarea (each registers with the page while
open, and stays open), then sends an `edit` with `save`, even when nothing changed; the
host applies the edit, or drops it as stale, and then saves the document. Letting VS Code
save directly would race the edit still on its way: the save participant can wait for
edits the host has received, not for one the page has yet to send, so the file would be
written without the last keystrokes and turn dirty again when they landed. Focus leaving
the editor for the page flushes the pending edit, as leaving the window does. In the
error state the key stays VS Code's. A save started elsewhere (menu, auto-save) still
waits on the edits already received, and only on those.

**A new document for a page that shows one** is taken in place, not by rebuilding the
`EditorState`: `webview/resync.ts` replaces only the run of top-level blocks that differs,
sets the attributes of the blocks kept around it with `setNodeMarkup` (the host's `src` on
a block the page had edited), and marks the transaction `addToHistory: false` and
`PRESERVE_SOURCE_META`. prosemirror-history maps its steps through it, so an edit made
before a change elsewhere — a save that trims trailing whitespace is one — stays
undoable; a whole-document replace would have deleted every position those steps name.
An edit still waiting in the page's 250 ms delay at that moment was computed against the
superseded text and is dropped.

### Where fidelity is enforced

- **`parse.ts`** — refuses a document whose blocks do not rebuild it.
- **`fidelity.ts`** — keeps the source-derived attributes true across every
  transaction, whatever produced it. It follows each top-level node through the
  transaction (by identity, else by where the mapping takes its start) and then:
  clears `src` on an editable node that is not the same object as before (so a moved
  node keeps it); clears `gap` — a fact about a node and its predecessor — on a node that
  descends from none, changed type, or no longer follows what it followed (a split, a
  deletion or a move in front of it), so a split paragraph is not written back as one;
  and strips `reqPrefix`, `anchor` and `attrsSuffix` from a heading that newly carries an
  id or anchor another heading has. `PRESERVE_SOURCE_META` (the re-sync) exempts all of
  it. Undo and redo are exempt too, because the history restores `src` and `gap` with the
  content — except that an undo changing a node's content under an unchanged `src` (one a
  re-sync set, outside the history) clears that `src`.
- **`webview/plugins.ts`** — `Enter` inside a heading with a requirement id or attribute
  suffix starts a paragraph instead of a second heading; the fidelity rule is the guard
  behind it.
- **`webview/resync.ts`** — takes the host's document in place, so the page's own
  history and the host's attributes both survive.
- **`serialize.ts`** — emits `src` where it is set, and a stable rule-based form for
  a changed block; wrapping follows the paragraph's own width, else
  `markdownExtended.editor.wrapColumn`.
- **`host/session.ts`** — writes only the differing span, and never against a
  document the page did not see.

### The toolbar

`webview/toolbar/` is the formatting toolbar at the top of the page, its menus and
preview card, and the bubble over a text selection.

**Row, menu, card: the control is uniform, the fidelity lives where a choice is made.**
A first version drew every button as its real sample in the row. It failed as a
control: samples of wildly different sizes (a sidebar's box dwarfed the row, a table
was a speck), two wrapping rows, content that did not read as a button, rare actions as
heavy as frequent ones. So the surfaces now divide the work:

- **The row** — `Block type ▾ | i em b strong code | Formatting ▾ Annotation ▾ Insert ▾`
  (`ROW_LAYOUT`) — is one line of controls of one height; menus are a text label and a
  chevron, hairlines separate the groups, and a narrow window scrolls the row rather than
  wrapping it, so no control moves. Only the five native marks are in it, their glyph the
  real element held to the button's height and minimum width, so a stylesheet can change
  how the glyph looks but not the row's geometry. The bubble carries the same five.
- **A menu entry** is where the fidelity lives: the entry is the element the parser makes
  (`sample`), styled by the cascade, beside its syntax. Every entry has one height; a block
  sample is scaled into it with `zoom`, measured when the menu opens (`fitSamples`), so the
  fit holds for whatever the stylesheets make of the element. The admonition types are a
  submenu of Insert.
- **The preview card** shows the hovered or focused entry's `preview` — a sentence or a
  two-row example — at natural size, 300 ms after the pointer or the focus rests on it,
  beside the menu, with the Markdown beneath.

Menus and the card are `position: fixed` in a layer outside the row: the row scrolls,
and a scrolling box clips whatever hangs out of it.

**Why a card needs the notes stylesheet's help.** The notes' margin layout in
`styles/markdown-extended.css` is gated by `@media screen and (min-width: 1280px)`, and a
media query reads the window, not the card: in a wide webview a 360px card's note would
float out by its full offset, and the card's clipping would make it vanish. Restating the
stacked rendering in `editor.css` would state that form twice. Instead the margin layout
excludes descendants of the card (`:where(:not(.mep-preview-card *))`: `:where` keeps a bare
class's specificity, so a reader's later `.sidenote` rule still wins), and the card keeps
the base rendering — the one statement of the stacked form. The class occurs only in the
editor's page, so the preview and exports are unaffected; `PREVIEW_CARD_CLASS` names it
once, and a test holds both stylesheets to that name. `display: flow-root; contain: layout
paint; overflow: hidden` on the card is the second line of defence. The page test runs at
1400px and requires every element of each Annotation preview to lie inside the card and
to be visibly in it; with the guard removed the sidenote floats out.

The layers:

- **`actions.ts`** — one table, pure data, no DOM. Each action has an id, a `place` (the
  row, or a menu and submenu), a label, the **syntax** its tooltip and entry name, a
  **sample** (tag, classes, attributes, content: the element the parser makes from that
  syntax), an `apply` kind, an **example** in which the construct renders as its sample,
  and a **preview** (Markdown and the elements it renders as) for the card. Row button,
  menu entry and card are built from the same entry.
- **`commands.ts`** — what each `apply` kind does to an `EditorState`, testable without
  a page. A `mark` button toggles a native mark *with its delimiter*
  (`toggleMarkup`): the mark type excludes itself, so `_` on `*` text replaces the `*`,
  and only the button of the delimiter the text has removes it. `Mod-i`/`Mod-b` toggle by
  mark *type* (`toggleMarkType`, sharing the one helper): any delimiter is removed in one
  press, and plain text gets `*`/`**`. `block` sets the textblock type, or wraps,
  lifts or converts a list or quote. `wrap-source` and `insert-source` are stage 1 for
  the constructs outside the editable core (below).
- **`toolbar.ts`** — the DOM, as a ProseMirror plugin view, so it follows every state:
  active and disabled states per action, the block-type face (the current type's name,
  locked with the reason), the menus and their keyboard (arrows, `→` into the submenu,
  `Enter`, `Esc`), the card, the bubble (placed from `coordsAtPos` inside `.mep-editor`,
  above the selection, below it when above would be under the sticky toolbar).

**The syntax is read from where it is true.** `src/syntax/markers.ts` states the
inline markers, the note and sidebar markers with their classes, and the admonition
types. It imports nothing, so the page can load it, and `toggleFormats.ts` (through
`commands/inlineToggleArgs.ts`), `markdownItSidenote.ts`, `markdownItAdmonition.ts`
and the action table all import it: the text editor's toggles, the parser and the
toolbar cannot write one construct two ways. The block markers are the serializer's.
`toolbarActions.test.ts` renders every action's example and every preview through the
real engine and requires the drawn elements and classes in the HTML, and for every mark action
the schema's element equals the engine's — "this button makes this element" is
checked against the parser, not assumed.

**The look is read from the cascade.** A mark glyph, a menu entry and the card contain
their sample elements inside `body.markdown-body`, so the page's stylesheets — the
preview's, every extension's, the user's — style them exactly as they style the construct
in the document, and any change to them reaches the toolbar. Reading a colour out of a
stylesheet's text would be a second answer to "what does a sidenote look like", and wrong
the moment another rule in the cascade won. Tools are `role="button"` elements, not
`<button>`s, whose user-agent font would stand between the cascade and the sample;
`editor.css` styles only their frame, and a sample's box (the height it must fit, its
margins), never its look.

**Stage 1: source for what the core cannot edit.** `wrap-source` wraps the selection
in its markers and replaces the top-level block by a `raw_block` whose `src` is the
block serialized by rule with the markers in place. The serializer would escape them
(`ESCAPE_EXTRA` exists to stop `==`, `++`, `$` … being read as syntax), so the block is
serialized with private-use stand-ins of the markers' length (U+E002/U+E003 — not
U+E000/U+E001, the wrapper's hold markers) that are replaced afterwards. The block keeps
its `gap` and the transaction carries `PRESERVE_SOURCE_META`, so every other byte stays;
the page then sends `edit` with `reparse`, and the host's parse comes back through the
in-place re-sync, the block rendered as the preview renders it. The wrap is one history
event and the re-sync is outside the history, so one undo returns the block exactly
(the page test undoes across the re-sync). `insert-source` inserts a `raw_block` with a
template at `insertionPoint`, asks the host to render it and opens its **Edit
source** box (`editRawSourceAt` in `nodeViews.ts`).

**Where a block is inserted** (`insertionPoint`, for the rule and every template): after
the top-level block the selection's `$to` is in, or at the top-level boundary it stands
on — after a selected atom, after the last block for Ctrl+A (`AllSelection`), where a gap
cursor is. Never before the first block: a `---` written as the file's first line opens
front matter, and with another `---` lower down the next parse folds everything between
into YAML. Only an empty document takes a block at position 0.

**When the block type is locked** (`blockLockReason`), decided per kind of selection so
the tooltip says what is the matter: text in a heading with `reqPrefix` or
`attrsSuffix` — `setBlockType` rebuilds a node's attributes, and one click would drop
the id and the anchor, the same fact `splitRequirementHeading` and the fidelity plugin
guard for Enter and for any transaction; a selected atom (source block, injected
content, front matter, badge); any other selected node (a rule, an image); a gap cursor,
which is between blocks; Ctrl+A, which selects the document rather than a block.

### Styles

The page loads the preview's cascade — the built-in `markdown.css` and
`highlight.css`, every extension's `markdown.previewStyles` (official, then
third-party), the user's `markdown.styles` — and `styles/editor.css` last, for the
editor chrome only. `<body>` is `markdown-body vscode-body`; VS Code adds the theme
class that theme-aware stylesheets such as Req Explorer's `req-status.css` key on.
The toolbar's samples are drawn inside that body for the same reason (see above).

---

## Testing Strategy

### Test Infrastructure

- **Framework:** Mocha + VS Code Test Runner
- **Mocking:** Sinon for spies, stubs, and mocks
- **Coverage:** 65+ unit tests across 10+ test suites
- **CI/CD Ready:** Tests run via `npm run test:unit`

### Test Structure

``` text
test/
└── unit/
    ├── services/
    │   ├── browser/
    │   │   └── browserManager.test.ts    (20 tests)
    │   ├── common/
    │   │   ├── config.test.ts            (15 tests)
    │   │   ├── errorHandler.test.ts      (10 tests)
    │   │   └── extensionContext.test.ts  (10 tests)
    │   └── contributes/
    │       ├── contributorService.test.ts (10 tests)
    │       └── contributesService.test.ts (15 tests)
    └── exporter/
        └── mermaidRenderer.test.ts        (mermaid detection + fallback)
```

### Testing Patterns

#### 1. Singleton Testing

```typescript
afterEach(() => {
    Config._reset();  // Clean up singleton state
});

test('singleton instance', () => {
    const instance1 = Config.instance;
    const instance2 = Config.instance;
    assert.strictEqual(instance1, instance2);
});
```

#### 2. Dependency Injection Testing

```typescript
test('BrowserManager requires context', () => {
    BrowserManager._reset();
    assert.throws(() => {
        BrowserManager.getInstance();
    }, /requires extension context/);
});
```

#### 3. Async Testing

```typescript
test('async file operations', async () => {
    await mkdirsAsync('/path/to/dir');
    const exists = fs.existsSync('/path/to/dir');
    assert.strictEqual(exists, true);
});
```

#### 4. Error Handling Testing

```typescript
test('handles missing browser gracefully', async () => {
    sinon.stub(fs, 'existsSync').returns(false);
    await ErrorHandler.handle(new Error('Browser not found'), {
        operation: 'Export PDF'
    }, ErrorSeverity.Error);
    // Verify error logged, user notified
});
```

---

## Key Design Decisions

### 1. Singleton Pattern for Services

**Decision:** Use explicit singleton pattern with `getInstance()` methods.

**Rationale:**

- ✅ Prevents multiple instances of stateful services
- ✅ Provides global access point without global variables
- ✅ Testable via `_setInstance()` and `_reset()` methods
- ✅ Clear initialization requirements

**Alternative Considered:** Dependency injection container (rejected as over-engineering for this scale).

---

### 2. Async File Operations

**Decision:** Migrate from `fs.*Sync()` to `fs.promises.*`.

**Rationale:**

- ✅ Non-blocking I/O prevents UI freezing
- ✅ Better concurrency for multiple exports
- ✅ Modern Node.js best practices
- ✅ Aligns with async/await patterns

**Implementation:**

```typescript
// Before (blocking)
mkdirsSync(path.dirname(fileName));
fs.writeFileSync(fileName, content);

// After (non-blocking)
await mkdirsAsync(path.dirname(fileName));
await fsPromises.writeFile(fileName, content);
```

**Note:** `existsSync()` retained for validation checks (synchronous by nature).

---

### 3. Error Handler Service

**Decision:** Centralized error handling with contextual information and recovery options.

**Rationale:**

- ✅ Consistent error messages across the extension
- ✅ User-friendly recovery actions
- ✅ Detailed logging for debugging
- ✅ Reduces error handling boilerplate

**Impact:**

- Before: 20+ different error handling patterns
- After: Single consistent pattern with contextual recovery

---

### 4. Plugin Direct Invocation

**Decision:** Plugins directly invoke wrapped plugins instead of calling `md.use()`.

**Rationale:**

- ✅ Prevents double-use pattern errors
- ✅ Follows markdown-it plugin architecture
- ✅ Clearer plugin ownership and responsibility

**Bug Fixed:**

```typescript
// Before (caused TypeError)
export function MarkdownItContainer(md: MarkdownIt) {
    md.use(container, "container", options); // Double-use!
}

// After (correct)
export function MarkdownItContainer(md: MarkdownIt): void {
    container(md, "container", options); // Direct invocation
}
```

---

### 5. Test Infrastructure

**Decision:** Use VS Code Test Runner with Mocha/Sinon.

**Rationale:**

- ✅ Official VS Code testing framework
- ✅ Full VS Code API access in tests
- ✅ Familiar testing patterns (Mocha/Sinon)
- ✅ CI/CD integration support

**Impact:**

- 0 → 65 unit tests
- Full service coverage
- Regression prevention

---

### 6. Mermaid Export Rendering (inline SVG)

**Decision:** Pre-render mermaid diagrams to inline `<svg>` at export time using a separately-bundled mermaid library, executed inside the bundled headless Chromium.

**Problem:** A ` ```mermaid ` block renders in the VS Code preview because the built-in `vscode.mermaid-markdown-features` extension contributes (a) a markdown-it plugin that emits `<pre class="mermaid">…</pre>` and (b) a ~25 MB client-side preview script that draws the SVG. The export reuses the shared markdown-it instance, so it produces the placeholder, but it deliberately excludes that (official) preview script — so diagrams exported as unrendered source. VS Code's bundle exposes no callable render API.

**Rationale:**

- ✅ Output stays small and self-contained — only inline SVG, **no JavaScript and no mermaid library in the exported file**.
- ✅ Uses mermaid's public `mermaid.render()` API (stable, version-controlled) instead of scraping VS Code's private webview bundle (fragile, version-pinned).
- ✅ Reuses the Chromium already required for PDF/PNG export; the browser is launched **only when a document contains a mermaid diagram**.
- ✅ Fails safe: missing browser or an unparseable diagram leaves the original `<pre class="mermaid">` source rather than aborting the export.

**Implementation:**

- `src/services/exporter/mermaidBrowserEntry.ts` is bundled by esbuild as a standalone browser IIFE (`dist/mermaid-browser.js`) exposing `globalThis.__mteMermaid`.
- `src/services/exporter/mermaidRenderer.ts` (`MermaidRenderer`) detects mermaid via `hasMermaid()`, loads the export HTML into Chromium, evals the harness to define the global, swaps each `pre.mermaid` for its rendered SVG, and serializes the DOM back. Both `HtmlExporter` and `PuppeteerExporter` call `MermaidRenderer.instance.process(html)`.

---

### 7. De-duplicated Inlined Preview Assets

**Decision:** De-duplicate contributed preview style/script files by **content**, keeping the **last** occurrence, before inlining them.

**Rationale:**

- ✅ Multiple extensions ship the same asset (e.g. `katex.min.css` from both `vscode.markdown-math` and `markdown-all-in-one`), which was inlined twice as base64 — ~370 KB of duplicated font data per export.
- ✅ `dedupeContributeFiles()` in `contributorService.ts` compares files by a hash of their bytes, so distinct files that merely share a base name (e.g. two different `markdown.css`) are **all** kept — no extension's styling is silently dropped.
- ✅ It keeps the **last** occurrence in place. Later styles win the CSS cascade, so collapsing an earlier identical copy leaves the final appearance unchanged. (v2.7.0 keyed on base name and kept the *first* copy, which dropped distinct same-named stylesheets and flipped the cascade — e.g. blockquote padding regressions in exports with a user CSS attached.)
- ✅ De-duplication is **global** across official and third-party extensions: `partitionDedupedStyleFiles()` concatenates both groups (official → third-party), de-duplicates them together, then sorts survivors back into their group. So an asset shipped by both kinds of extension (e.g. `katex.min.css`) is inlined once, in the later (third-party) position. (v2.7.0 de-duplicated each group separately, so such cross-group duplicates survived.)

---

### 8. Service Access: Composition-Root Singletons + Injected Collaborators

**Decision (v3.0):** Keep one canonical singleton accessor per service, wired at a composition root, and inject collaborators via constructors where it aids testing. Remove the deprecated parallel access shims.

**Rationale:**

- ✅ The extension is activated once; long-lived services (`ExtensionContext`, `Config`, `ContributorService`, `ContributesService`, `BrowserManager`, exporters, `MermaidRenderer`) are naturally singletons. `extension.ts` is the composition root: it initializes `ExtensionContext` and `BrowserManager` with the VS Code context and registers the commands.
- ✅ **Deprecated shims removed** — the parallel `config`, `Contributes`, `Contributors`, and `htmlExporter` exports and their barrel files are gone; call sites use the canonical `Config.instance` / `ContributesService.instance` / etc. One access path, less confusion (finishes the migration tracked in `docs/DEPRECATED_MIGRATION.md`).
- ✅ **Constructor injection where it pays off** — `ContributesService` depends on the `IContributorService` *abstraction* and accepts it via its constructor (defaulting to the shared singleton), so tests inject a fake without static seams (Dependency Inversion).
- ⚖️ **Full DI container intentionally avoided** — rewriting every runtime singleton (exporters/browser/context) into threaded constructor injection would be high-churn and high-risk for the export/preview paths, which lack integration tests, with little practical payoff. The composition-root-singleton pattern is idiomatic for VS Code extensions and is retained deliberately.

---

## Migration Guide

### For Contributors

#### Adding a New Service

1. Create service class with private constructor
2. Implement `getInstance()` static method
3. Add `_reset()` for testing
4. Document with JSDoc
5. Write unit tests
6. Update this document

Example:

```typescript
export class MyService {
    private static _instance?: MyService;
    
    private constructor() {}
    
    static getInstance(): MyService {
        if (!MyService._instance) {
            MyService._instance = new MyService();
        }
        return MyService._instance;
    }
    
    static _reset(): void {
        MyService._instance = undefined;
    }
}
```

#### Adding a New Plugin

1. Create plugin file in `src/plugin/`
2. Export plugin function with JSDoc
3. Register in `src/plugin/plugins.ts`
4. **Never call `md.use()` inside the plugin**
5. Add tests if complex logic
6. Update README with syntax examples

---

## Maintenance

### Code Quality Standards

- **TypeScript strict mode:** Gradually enabled (see `tsconfig.json`)
- **JSDoc coverage:** All public APIs documented
- **Test coverage:** Core services 100% covered
- **Error handling:** All async operations wrapped in try-catch
- **Resource cleanup:** All resources disposed in finally blocks

### Performance Considerations

1. **Singleton services** reduce initialization overhead
2. **Async file operations** prevent UI blocking
3. **Browser caching** avoids redundant downloads
4. **Lazy initialization** defers work until needed

### Security Considerations

1. **File path validation** prevents directory traversal
2. **Custom executable validation** checks file existence
3. **Browser download verification** uses official Puppeteer APIs
4. **User input sanitization** in exports

---

## Future Improvements

### Planned Enhancements

1. **P3: Refactor Large Files**
   - Split `markdownItSidenote.ts` (393 lines)
   - Extract reusable utilities

2. **Enable Strict Mode**
   - Enable `noImplicitAny` gradually
   - Enable `strictNullChecks` gradually
   - Fix type issues incrementally

3. **Expand Test Coverage**
   - Add integration tests
   - Add export end-to-end tests
   - Add plugin tests

4. **Performance Optimization**
   - Cache markdown-it instances
   - Optimize plugin loading
   - Profile export operations

---

## Conclusion

This architecture provides a solid foundation for maintainability, testability, and extensibility. The singleton pattern, async operations, and centralized error handling ensure a robust user experience while keeping the codebase clean and understandable.

For questions or suggestions, please open an issue on GitHub.

---

**Document Version:** 1.0  
**Last Updated:** November 7, 2025  
**Extension Version:** 2.0.0

## Releasing

```bash
npm run release          # checks + lint + tests + .vsix, nothing leaves the machine
npm run release:publish  # the same, then tag, push, and publish that .vsix
```

`scripts/release.mjs` checks, in this order: working tree clean · branch not behind
`origin` · the version in `package.json` is committed (not merely on disk) ·
`CHANGELOG.md` has a `## vX.Y.Z` section · that tag does not exist yet. Then lint
and the full test suite run, and the package is built **once**.

Each check comes from a mistake that actually happened. v3.0.2 was first built
from a tree two commits behind the remote, so the Puppeteer `setContent` fix
released in v3.0.1 silently vanished from the artefact; and v3.0.1's version bump
had never been committed — `package.json` said 3.0.0 while the Marketplace served
3.0.1, which is what made building from a stale base so easy.

Publishing uses `--packagePath` deliberately: `vsce publish` would otherwise
repackage and ship a different artefact than the one the tests ran against.
