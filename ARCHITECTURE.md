# Architecture Documentation

## Table of Contents

- [Overview](#overview)
- [Design Principles](#design-principles)
- [Core Architecture](#core-architecture)
- [Service Layer](#service-layer)
- [Plugin System](#plugin-system)
- [Visual Editor](#visual-editor)
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
│   ├── editor/                   # Visual Editor (see its own section)
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

## Visual Editor

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
| `editable` | The core: paragraph, heading, lists, blockquote, code, rule, container, admonition — with the inline constructs and the attribute literals below | The matching node, with `src` and `gap` | Its `src` while untouched; serialized by rule once changed |
| `raw` | Anything else — tables, HTML, the TOC, footnotes, definition and task lists, abbreviations, reference definitions, a setext heading, a note inside a note, an attribute literal the editor cannot write back where it stands, a container or admonition nested past one level, lines no token covers | `raw_block` (atom, `html` rendered by the host) | Its `src`, which only an explicit source edit changes |
| `injected` | Content the file does not hold at this place | `injected_block` (atom) | An expansion's directive line, or nothing |

`parse.ts` rebuilds the text from the blocks and **throws** when it does not match,
so a document the model cannot represent is never opened for editing.

### Inline constructs and the note nodes

Inside an editable block the extension's own inline syntax is rich text (stage 2):
`==mark==`, `^sup^`, `~sub~`, `~~strike~~` and `[[kbd]]` are marks (`mark`, `sup`,
`sub`, `strike`, `kbd`, drawn as `<mark>`, `<sup>`, `<sub>`, `<s>`, `<kbd>`), and the note
family — `++ref|note++`, `!!ref|note!!`, `$body$`, `@body@` — are inline nodes with
content. `blocks.ts` lists their tokens as editable, `parse.ts` maps them, `serialize.ts`
writes them with the delimiters from `src/syntax/markers.ts`.

**A note mirrors the plugin's DOM.** `markdownItSidenote.ts` renders a sidenote as
`span.sn-ref`, holding the reference's text and then `span.sidenote` — the note nested in
its reference, which `markdown-extended.css` targets as a descendant. The schema draws
exactly that: `sidenote` is the `span.sn-ref`, its content `note_ref sidenote_body`, the
body the `span.sidenote` (`marginal_note` likewise, with `span.mn-ref` and
`marginal_note_body` as `span.mnote`); `left_sidebar` and `right_sidebar` are the one
span each. The plugin emits no element for the reference, and ProseMirror needs one to
hold content, so `note_ref` is a span with no class — only `data-mep-note-ref`, which no
stylesheet of the preview names. Mirroring the DOM is what lets every stylesheet written
for the preview style the note being edited unchanged, the margin layout included; a
page test at 1400px compares the computed style of each note in the editor with the
engine's own rendering, and `inline.test.ts` draws the schema through `DOMSerializer`
and requires the engine's HTML, the reference's span apart. The two bodies are two types
because their class is part of what they are.

**What a note holds** is decided by the plugin: it parses a reference and a body with
the full inline parser, so every mark may be inside (`note_inline*`: text, images, hard
breaks, badges). It cannot hold a note of its own kind — the first closing marker ends
the outer one — but can hold one of another kind; a content expression cannot say "any
note but my own kind, at any depth", so the editor holds notes one level deep and
`blocks.ts` leaves a paragraph that nests them raw. A mark around a note is a mark on the
note node. `parse.ts` counts the notes the tokens open against the note nodes it made
and throws on a difference: MarkdownParser drops an inline node whose content does not
fit as silently as a block.

**Writing a note.** The plugin finds a note's ends in the raw source, before any
backslash escape is read: a reference ends at the first `|`, a left sidebar at the next
`$`, a right one at the next `@`, and a body at the first `++`/`!!`. Inside each part its
terminator is written as a character reference (`&#124;`, `&#36;`, `&#64;`; `%7C`… in a
URL), which the part's own inline parse turns back; `ESCAPE_EXTRA` already breaks `++`
into `\+\+`, and a marker character that would touch a marker — last in a body, first
in a reference, last before the note — is `&#43;` or `&#33;`, since a backslash does not
stop a raw search. A reference with no text, which the plugin refuses, is `&nbsp;`.
A link's destination and title take no backslash escape either: there a run of the
marker character is `%2B%2B` or `&#43;&#43;` (`C++` in a Wikipedia URL), and a bare or
angle link holding the marker character is written inline.

**What cannot be written is not made.** A code span has no escape at all, and `^sup^`
and `~sub~` decode backslashes but no character references, so inside a note some text
has no representation: code holding the note's marker pair, code, sup or sub holding the
part's terminator, and a note node carrying one of those marks (a paste can make one; a
toggle cannot — `AddMarkStep` marks text and atoms, never an inline node with content,
so sup over a note marks the reference's and the body's text, which is written inside
the note and reads back). `unwritableInNote` in `serialize.ts` states the rule beside the
escaping it follows from. The page refuses any transaction that would leave such a note
in the range it changed (`noteRefusal`, a `filterTransaction` in `webview/notes.ts`) and
says why beside the caret; the toolbar's Code, Superscript and Subscript buttons, and a
note action whose result would break the rule, are disabled with that reason. A re-sync
and an undo are never refused. Refusing is the least bad answer: saving would write a
document the next parse restructures, silently.

**Wrapping.** The plugin reads a note across line breaks (the corpus wraps inside
them), so a note is wrapped like the prose around it. `^sup^`, `~sub~` and `[[kbd]]`
refuse a line break and are held runs, as a code span is; so is a whole inline link or
image — the corpus keeps a link on one line, and a link longer than the room is a line
of its own. `measureWrapWidth` holds the same runs, so the width read off a paragraph is
its widest line that could have been broken: the line of one long link, and the short
line an author cut before it, are no evidence (Req Explorer's `REL-RXE-135` paragraph,
whose 105-character link line had become its width, is the test).

**Editing inside a note** (`webview/notes.ts`). ProseMirror edits an inline node with
content well inside and the browser handles its edges badly: a caret right after a
note's span, or in an empty part, has no DOM position of its own, and a deletion that
empties a part lets the browser drop the span, after which the note read back from the
DOM has lost a part. So the edges are ProseMirror's: typed text next to or inside a note
is inserted by a `beforeinput` handler, a character deleted inside a part by the keymap,
any other deletion there by its `getTargetRanges` clamped to the part, a paste as text; a
caret put between a note's two parts is moved into one. The keys: `Tab`/`Enter` go from
the reference to the body and out, `Shift+Tab` back, `Esc` out, `→`/`←` across the parts'
ends and into a note from outside, `Backspace` at the start of an empty reference removes
the note (no husk), at the start of one with text selects it. The toolbar's note actions
are toggles (`toggleNote`): inside a note of their kind they unwrap it (`unwrapNote`) — the
note node replaced, in one step, by its reference's inline content or a sidebar's, the
note's own marks added to it, the caret at its end — and they show as active there. The
same `unwrapNote` is the object toolbar's **Remove note, keep text** (below): two paths to
one verb, one transaction.

### Attributes, containers and admonitions

Stage 3 makes three more of the extension's constructs rich text instead of source blocks.
Each node and mark mirrors the DOM its plugin renders, as the notes do, so the page's
stylesheets style what is edited exactly as they style the preview; `blockConstructs.test.ts`
and `attrs.test.ts` draw each through `DOMSerializer` and require the engine's HTML, the
editor's `data-mep-*` bookkeeping apart.

| Construct | Schema | Drawn as | Written back |
| --- | --- | --- | --- |
| `[text]{…}` (markdown-it-bracketed-spans + markdown-it-attrs) | mark `attr_span`, attr `literal` | `span` with the literal's attributes (`domAttrsOf`) | `[` … `]` + the literal, held so no line break falls inside |
| `{…}` on a top-level paragraph, list, fence or rule | `attrsSuffix` + `attrsPlacement` on the node | the node's element with the literal's attributes (a fence's on its `<code>`) | where it stood (below) |
| `::: name info` … `:::` (markdown-it-container) | node `container` (`block+`), attrs `name`, `info`, `markup` | `div` whose `class` is the trimmed info, as `markdownItContainer.ts` renders it | fence, name, info verbatim, body, fence |
| `!!! type "Title"` (`markdownItAdmonition.ts`) | node `admonition` (`block+`), attrs `type`, `title`, `markup`, `header` | `div.admonition.<type>`, first child `p.admonition-title` | the header as written, else `!!! type "Title"`; body indented by four |

**Reading a literal without the engine.** The page draws a span or a block from its literal
and checks a literal typed into a field, where no parser is. `attrs.ts` is a port of
markdown-it-attrs' literal reader (`getAttrs`, its delimiter search, `addAttrs`' class
joining) and nothing more — where a literal stands and what it attaches to is the host's
parse. The port is held to the plugin by rendering every literal its test lists through
the real engine. Event handlers and the three attributes that would change how an element
is edited (`contenteditable`, `draggable`, `tabindex`) are not drawn.

**The span's literal is recovered from the source.** markdown-it-attrs consumes the `{…}`
into `span_open.attrs`, and inline tokens carry no line map, so the literal as written
(`{ .a  #x }`, `{class="a b"}`) is not in the tokens. `recoverSpanLiterals` in `blocks.ts`
walks the block's slice for `]{…}` and gives each `span_open`, in order, the next
occurrence whose literal reads as exactly that token's attributes; one that reads otherwise
(a `]{.y}` inside a code span) is passed over. Recovery fails only where the source spells
the literal differently from what the token shows — in practice never, since an entity or
a backslash escape inside a literal stops the plugin reading it as one at all — and then
the span is written in a normalized form (`{#id .a .b key=v}`) that reads the same. A span
inside a note may not hold the characters the notes plugin searches the raw source for
(`|`, `+`, `!`, `$`, `@`); such a paragraph stays a source block, and the page refuses to
make one (`noteUnwritable`). Nor may a span's literal hold a quoted `}` (`{title="a}b"}`):
the plugin reads the value whole but cuts the text after the span at the first `}`, so the
rest of the literal stays in the paragraph as text and every save would write it again —
the block stays raw and the field refuses it (`hasInnerBrace`). A rule's literal has the
opposite hazard: the plugin reads it from the line's last `{`, so a quoted `{` there loses
every attribute (`readsAsRuleLiteral`). A span in an admonition's title is part of the
title's string, not a mark: recovery skips the title's lines, as the parse skips its tokens,
and the title's inline content is held to the same editability rules as any other.

**A block's literal carries where it stood** (`attrsPlacement`, `AttrsPlacement` in
`blocks.ts`): `end` — after a space at the end of the last line (a paragraph's
`text {.a}`, a fence's opening line, a rule's `--- {#id}`); `line` — a line of its own
under the block, which the plugin reads through the soft break before it (a paragraph, a
list); `blank` — under a blank line, which the plugin gives a list only. The literal must
read as the token's attributes, or the block stays raw: the plugin merges a second literal
into the same token, and hands a list's literal to a nested list when one precedes it, and
guessing which the author meant is how a save would move an id. A `blank` literal is in no
token's map — the plugin removes the paragraph it was — so `groupSourceBlocks` extends the
list's lines over it, as it extends a container's over its closing fence, which
markdown-it-container leaves out of its map. A changed block is serialized without the
literal and the literal added where it stood (`withBlockSuffix`); a list whose last item
the `line` form would no longer reach through a lazy line (a second block in that item, an
empty item — the `{…}` line would be a paragraph of its own — or a nested list anywhere
the plugin could give it to) is written in the `blank` form. The
paragraph's wrap width is measured without the literal, since the literal is not wrapped.
Only a top-level block's literal is written: the fidelity plugin drops the literal a split
copies into the second half and the one a block wrapped inside another carries, so the
page never draws a class the file will not hold; a block-type change carries it over
(`keepingLiterals`). A requirement heading keeps its existing rule — any trailing `{…}` on
its line is its `attrsSuffix`, the id its `anchor`.

**Containers and admonitions.** Both are one top-level block: untouched, their slice;
changed, the wrapper is written by rule around its blocks, which carry no `src`. A
container's `info` is the rest of its opening line after the name, verbatim; the fence is
written as it was unless something inside would close it early — markdown-it-container ends
a container at the first line of colons at least as long as its fence, whatever block
the line belongs to — so the body is written first and any such line of it (a nested
container's fence, a line of colons in code or in a paragraph) lengthens the fence
afterwards (`containerFence`, on the written text, not the node kinds). Most class
names draw nothing, so `editor.css` outlines a container — an outline, which takes no room,
so the preview's layout holds. An
admonition's `header` is its opening line as written, emitted while type and title are what
it says (`!!! note Some title` stays unquoted when only the body changed); the verbs that
change type or title clear it, and the line is then `!!! type "Title"`, the quoted form the
plugin reads for any title. The title bar is `p.admonition-title`, the first child of
`div.admonition`, which the stylesheet targets as a child (`.admonition > .admonition-title`).
A content hole must be the only child of its element, so the schema cannot draw it; the page
draws it as a raw widget at the start of the admonition's content (`webview/wrappers.ts`),
and the pinning test puts it there the same way (`fakeDom.ts`). A title is a string: one
holding Markdown renders styled in the preview and shows its markers in the editor.

**One level of nesting.** A top-level container or admonition may hold one more
(`MAX_WRAPPER_DEPTH`); a third level stays raw. So does a nested container its own fence
does not close: with equal fences the first `:::` closes the outer one, the inner is closed
by its parent, and the lines after it are no longer what they look like. An admonition with
a second class (`!!! warning big "T"`), and attributes on either wrapper or on an admonition
title, have no slot and stay raw too.

**In the page** (`webview/wrappers.ts`): `Enter` in an empty last paragraph of a wrapper
leaves it (the paragraph moves after it; a wrapper's only paragraph stays, since `block+`
cannot be empty), and in an empty paragraph elsewhere in it inserts a paragraph rather than
splitting the wrapper in two, as ProseMirror's `liftEmptyBlock` would; `Backspace` at the
start of an empty first paragraph lifts the wrapper's blocks out (`unwrapTransaction`, the
same transaction as the bars' *Remove …, keep content*). The toolbar inserts both natively
(`insertWrapperTransaction`, `insert-wrapper`), and **Span with class** (`attr-span`) asks
for the literal in the inline field, prefilled `{.}` with the caret after the dot.

### Injected content

Req Explorer marks every token its preview plugin injects under
`token.meta.reqExplorer` (SPEC §10.2). The editor reads the mark and treats each kind
differently:

| Mark | Example | Editor treatment |
| --- | --- | --- |
| `atom` | Status badge, `table.req-summary` | A read-only block or inline atom showing the rendering; nothing is written |
| `expansion` | A snippet expanded from `<!-- include: id -->` | One read-only block; the directive line is written back. Its object toolbar offers **Open snippet** only with `path` — a `missing` expansion has none — and **Show in text editor** and **Delete directive** always |
| `decoration` | `span.req-ref` around a bare id | Not a node: the id stays editable text, carrying a `req_ref` mark that is never serialized |

Token ranges nobody marked and no source line accounts for (the footnote list
`markdown-it-footnote` appends) become `injected_block`s of kind `generated`. A
requirement heading's `ID: ` prefix, recognised through the badge naming that id, is
lifted into `reqPrefix` and rendered non-editable; the `{#anchor}` suffix is kept
verbatim in `attrsSuffix`.

### Host and page

`host/provider.ts` registers a `CustomTextEditorProvider` (`markdownExtended.visualEditor`,
priority `option`) over the file's own `TextDocument`, so Req Explorer's
`WorkspaceEdit`s, the text editor and the rich editor meet in one buffer and VS Code
keeps dirty state, save and undo. Each open editor is a `VisualEditorSession`
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
| host → page | `lenses { version, blocks, rows }` | Other extensions' code lenses, one row of `{ id?, title, tooltip?, surface?, artifact?, relation? }` per top-level block index (below) |
| host → page | `actions { requestId, blockIndex, items }` | The code actions for one block, `{ id, title, kind, refusal? }` each (below) |
| host → page | `invalidateActions { refused? }` | Every answer the page holds may be stale; ask again. With `refused`, that action was not applied (below) |
| page → host | `ready` | Loaded; send the document |
| page → host | `edit { text, baseVersion, save?, reparse? }` | The whole text as the page would save it (250 ms after the last change); with `save`, the person pressed Ctrl+S and the host saves after applying it; with `reparse`, the host posts the document back after applying it, although it is the page's own text (the toolbar wrote syntax as source) |
| page → host | `render { requestId, src }` | Render this raw block source |
| page → host | `openSnippet { path }` | Open an expansion's snippet file (only paths the document's own marks name are opened) |
| page → host | `openSource { line }` | Open the text editor beside, at this line |
| page → host | `openLink { href }` | Follow a Ctrl/Cmd+clicked link; the host resolves it against the document (`host/links.ts`) |
| page → host | `refreshLenses` | Ask VS Code for the lenses again (the page took the focus or came back into view) |
| page → host | `runLens { id }` | Run the command of a lens from the last `lenses` |
| page → host | `actionsFor { requestId, blockIndex, blocks }` | The object toolbar opened for this top-level block of a page holding `blocks` |
| page → host | `runAction { id }` | Apply a code action from an `actions` answer: its edit, then its command |

A raw block's source commit sends its `edit` with `reparse` too, at once (or inside the
save's own edit when Ctrl+S commits it): what the source now says may no longer be a
source block — inline HTML deleted leaves a paragraph — and only the host's
parse can say. The re-sync then puts in whatever the block is; a block still raw is kept
in place with its node view, so a source box left open by a save stays open, focused,
with its text.

**The source box and the mouse.** The textarea lives in a `contenteditable=false` node
view inside ProseMirror's root. `RawBlockView.stopEvent` gives it every event of any type,
and `ignoreMutation` keeps selection changes inside it from ProseMirror. What the event
path did not cover was paint: a click on a block makes a node selection, ProseMirror
hides its own selection with `ProseMirror-hideselection` on the root (transparent caret,
transparent `::selection`) and removes the class only when a later `selectionchange`
moves the DOM selection's anchor. Until then the textarea inherited both, so its caret
and selection were there but invisible. `editor.css` exempts the textarea from both
rules; the real-mouse page test (`rawBlock.e2e.test.ts`) checks the caret colour and
the `::selection` rules with the class in place.

**Links: a plain click does not follow one, a Ctrl/Cmd+click does.** Two paths hold the
one rule (`webview/links.ts`). In rich text a plain click is ProseMirror's and places the
caret; in a rendered block it selects the block. A modified click is taken by the page in
both, and in both the click stops there: VS Code's webview follows every clicked `<a>`
from a listener on its window, with the href resolved against the page's own origin, so a
relative link would lead nowhere. The page posts `openLink` with the href as the element
carries it — a same-document `#fragment` it scrolls to itself — and the host resolves it
against the document and the workspace folder (`resolveLinkTarget`): `http(s)`/`mailto`
to `env.openExternal`, a file to `vscode.open` with its fragment kept, any other scheme
(`command:`, `vscode:`, `javascript:`) refused. A link's `title` shows its href; the
link's own title travels in `data-mep-title`, so copy and paste inside the editor keep it.

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
  id or anchor another heading has, and any other block's `attrsSuffix` from a top-level
  block that descends from none (a split's second half) or from a block nested in a
  changed one (only a top-level block's literal is written). `PRESERVE_SOURCE_META` (the re-sync) exempts all of
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
  how the glyph looks but not the row's geometry. The bubble carries the same five, the
  extension's five marks and the two notes (`inBubble`).
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
  press, and plain text gets `*`/`**`. The extension's marks toggle the same way, with
  their one delimiter. `wrap-node` makes a note or sidebar of the selection in place
  (`wrapInNote` in `notes.ts`: the selection is the reference, the body a selected
  placeholder). `block` sets the textblock type, or wraps, lifts or converts a list or
  quote. `insert-wrapper` inserts a container or an admonition, `attr-span` makes an
  attribute span (both above, "Attributes, containers and admonitions"). `wrap-source` and
  `insert-source` are for what the core does not edit — the footnote, tables and the other
  block constructs (below).
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
real engine and requires the drawn elements and classes in the HTML; for every mark action
the schema's element equals the engine's, and for every note action the node's element
and class are the sample's and the example parses into that node — "this button makes
this element" is checked against the parser, not assumed.

**The look is read from the cascade.** A mark glyph, a menu entry and the card contain
their sample elements inside `body.markdown-body`, so the page's stylesheets — the
preview's, every extension's, the user's — style them exactly as they style the construct
in the document, and any change to them reaches the toolbar. Reading a colour out of a
stylesheet's text would be a second answer to "what does a sidenote look like", and wrong
the moment another rule in the cascade won. Tools are `role="button"` elements, not
`<button>`s, whose user-agent font would stand between the cascade and the sample;
`editor.css` styles only their frame, and a sample's box (the height it must fit, its
margins), never its look.

**Source for what the core cannot edit.** `wrap-source` (the footnote) wraps the selection
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

### The object toolbar

Every object carries its verbs visibly, and every object does it the same way (Daniel,
2026-09-25). Before, a source block showed a hover toolbar with its verbs, an expansion an
**Open snippet** button, and a note or a link nothing: removing a note was knowledge in the
head — two `Backspace`s at one spot. Now one component, `webview/objectToolbar.ts`, draws
one bar for every object, and the source block's hover toolbar and the snippet button are
migrated into it rather than kept beside it; `editor.css` has one `.mep-object-toolbar`
family.

**The object model** (`webview/objects.ts`, no DOM). An object is a range of the document
that has verbs of its own — removed, converted, opened or edited as source as a whole —
as opposed to text, which is typed:

| Object | Counts as one | Its range |
| --- | --- | --- |
| `note` | a `sidenote`, `marginal_note`, `left_sidebar` or `right_sidebar` node | the node |
| `link` | a run of text under one `link` mark (equal attributes) | the run in its textblock, found from the caret by `markRunAt` |
| `span` | a run of text under one `attr_span` mark (equal literal) | the run, as for a link |
| `image` | an `image` node | the node |
| `badge` | an `inline_atom` | the node |
| `container`, `admonition` | the node | the node |
| `block_attrs` | a block carrying `attrsSuffix` — not a requirement heading, whose anchor is Req Explorer's | the node |
| `heading` | a top-level heading that is no `block_attrs` (a requirement heading is one) | the node |
| `raw_block`, `injected_block`, `front_matter` | the node | the node |

`objectAtSelection` finds the selection's object: a node selected as a whole, else,
innermost first, the link the selection is in (a caret inside its text or at either end),
the attribute span, the note both ends of the selection are in, the innermost container or
admonition holding both ends, the top-level block with an attribute literal, and last the
top-level heading. A link
in a note's body is the link; text beside a span in an admonition is the admonition. A verb never acts on the object it was drawn for: it looks it
up again (`currentObject` — the same kind at the same position, still there), so an edit
arriving from the host between drawing and clicking cannot make a verb act on something
else.

**The triggers.** The last three objects are *block* objects and show their bar while the
pointer is on them or they are selected, at once — as the source block's toolbar did. The
others are *caret* objects and show it once the caret or the selection has rested in
them for `INLINE_DELAY_MS` (400 ms), hiding it the moment the caret leaves — a container,
an admonition, a block with attributes and a heading too, which hold the text being typed and whose bar
would otherwise flash on every click into them; their bar is placed like a block's
(`isBlockPlaced`); the pointer does
not show them, because an inline bar that followed the pointer across a paragraph would
jump from word to word. There are two bar instances, one following the selection and one
the pointer, so the two triggers never fight over one element: typing in a note with the
pointer resting on a table shows both, and the pointer's bar hides while it would show
what the selection's already shows. The selection's bar shows only while the focus is in
the editor or in a bar. `Alt+Enter` (a `handleKeyDown` prop, which no other keymap
binds) skips the delay and focuses the first verb; the arrow keys move between verbs
(wrapping), `Enter` chooses, `Esc` returns the focus to the text.

**Where it sits** (`place`). Above the object's first line: an inline object's start, found
from its element's own line boxes (`getClientRects` of the note's `span.sn-ref` — a body
floated into the margin is no line box of the reference, so the bar keeps to the reference)
or, for a link, from `coordsAtPos` of its range; a block's right edge, where the source
block's toolbar always sat — blocks are mostly left-aligned, and a bar hanging over the
block above at its left sat on exactly what the next click there was aimed at (the real-mouse
test caught it: a click on a table landed on the task list's bar). When the room above is
under the sticky formatting row, below the object's last line. Then the caret's line is
checked: a bar that would cover it goes to the other side, so the line being typed is never
under it. While text is selected the bar prefers below, the selection bubble having the
room above. The bar is `position: absolute` inside `.mep-editor`, as the bubble is, so it
scrolls with the text; it is placed again on scroll and resize.

**The verbs** say what remains (*Remove note, keep text*), and are each one transaction in
`objects.ts` (or `notes.ts`), one history event:

- note — *Remove note, keep text* (`unwrapNote`); *Convert to marginal note* / *Convert to
  sidenote*, *Move to right* / *Move to left* (`convertNoteTransaction`: the counterpart
  node built from the same reference, body content and marks; the two have the same
  structure, so the selection is put back at the same positions); *Edit source*. A
  conversion whose result the serializer could not write back (`noteRefusal` — code in a
  left sidebar holding `@`, moved right) is disabled with the reason, as the notes
  plugin's filter would refuse it anyway;
- link — *Open* (`openLink`, the Ctrl+click path), *Change URL* (the mark replaced over
  its run with the new `href`, the title kept, `markup` cleared: a bare URL's text is the
  old address, which the bare form would write as the link), *Remove link* (the mark
  removed, the text kept);
- image — *Change source* (`setNodeMarkup`, alt and title kept), *Remove image*;
- span — *Edit attributes* (the mark replaced over its run with the new literal),
  *Remove attributes, keep text*;
- container — *Change name/info* (first word the name, the rest the info, verbatim; a
  trailing `{…}` refused, since markdown-it-attrs would take it off the info),
  *Remove container, keep content* (`unwrapTransaction`: the blocks lifted, the caret kept);
- admonition — *Change type* (the inline choice, a `<select>` of `ADMONITION_TYPES`),
  *Edit title* (empty: no title bar), *Remove admonition, keep content*; both changes clear
  `header`;
- block with attributes — *Edit block attributes* (the literal replaced in place, its
  placement kept; empty removes it; a heading's anchor follows the literal's id);
- source block — *Edit source* (`editRawSourceAt`), *Show in text editor*, *Delete block*;
- expansion — *Open snippet* (only with `mark.path`), *Show in text editor*, *Delete
  directive* (the node deleted, and with it the one line it writes);
- badge, other injected content, front matter — the label alone;
- heading — the label alone (*Requirement FRS-…* for a requirement heading), and so no bar
  at all unless another extension offers code actions for it (below).

Every object that is a whole top-level block (`isTopLevelBlock`) carries, after its own
verbs and a separator, the code actions other extensions offer for its lines — see the next
section.

A verb whose result is a disappearance — a removal, a deletion — announces it in the caret
hint (`webview/hint.ts`: *Note removed — Ctrl+Z*, `Cmd+Z` on macOS), in a neutral tone, for
3 s. The hint is the one the notes plugin shows a refusal in; one element, two tones
(`data-tone`), so the page has one place beside the caret where it speaks.

**The inline field** (`webview/inlineField.ts`) is one reusable component for every place a
value is asked for where it is used — the verbs' fields, and the toolbar's **Span with
class**, which opens it prefilled `{.}` with the caret after the dot (`caret`) in a bar of
the same kind under the selection. `InlineChoice` is its counterpart for a value out of a
list (an admonition's type): a `<select>` with the same contract, picking a value commits
it. The field is a one-line `<input>` opened prefilled with the value selected; `Enter` commits, `Esc`
cancels, the focus moving elsewhere in the page cancels — a click elsewhere never applies a
half-typed value — and exactly one of `onCommit` and `onCancel` is called, once. A blur
while `document.hasFocus()` is false is the window going away (Alt+Tab to copy a URL), not
a move in the page: the field stays, and takes the focus back on the window's `focus`.
A verb's commit puts the focus back in the text *before* it dispatches: the input is
already gone, and a refresh seeing the focus on the body would hide the bar and restart the
inline delay. The bar redraws whenever anything it shows or would prefill changed — an
image's `src` is in no label, and after an undo a stale bar would offer the undone value. Its keys are its own (`Ctrl+Z`
undoes the typing, not the document); `Ctrl+S` stays the page's save, which saves the
document without the field's value. The bar shows it in place of its verbs, beside the
label. *Change URL* and *Change source* set the mark's or the node's attribute: nothing
needs parsing.

**A note's source goes through the host.** A note's *Edit source* field holds the note as
the serializer writes it for that node alone (`serializeInline`, the note's own marks left
out: they stay on the text around it). On commit the note node is replaced by the literal
text — the top-level block becomes a source block whose text is the block serialized with
a stand-in run where the note was, then the run replaced by the typed text, unescaped
(`inlineSourceTransaction`, the stand-in technique of `wrap-source`) — and the edit is
posted with `reparse`. The host's parser, the preview's engine, decides what the text is:
a note again, of whichever kind the markers now say, or literal text if it is malformed.
The page has no parser; recognising the typed Markdown there would be a second parser, and
the first construct the two disagreed on would be shown as something the preview does not
render. A note holding a hard break has no *Edit source* (a one-line field cannot show
it); the text editor is the way.

### Other extensions' lenses and actions

Extensions attach code lenses, code actions, hovers and completions to the text editor
through `languages.register*Provider`, and a custom editor gets none of them. Req Explorer
puts eight kinds of lens on a requirement heading and quick fixes on what its checks find;
with the Visual Editor as a corpus's default, all of it was gone. The decision (Daniel,
2026-09-25): the editor shows other extensions' lenses where the text editor shows them,
**with no new API between the extensions** — it asks VS Code, which runs every registered
provider — and code actions become object verbs the same way. Hovers and completions are
not carried over.

**Lenses** (`host/lenses.ts`). `LensController` calls
`vscode.executeCodeLensProvider(uri, 500)` — resolved, since the page has no viewport VS
Code knows of to resolve lazily in — 300 ms after every document the session posts and every
edit it applies, and on the page's `refreshLenses`: the page sends it on window focus and
when it becomes visible, because a lens can depend on other files (Req Explorer's coverage
counts) and no provider's `onDidChangeCodeLenses` reaches another extension. A refresh is
dropped when the page does not hold the document's text (a re-sync is on its way, and posts
its own), when the document changed while VS Code computed, or when a newer refresh began.
`markdownExtended.editor.codeLenses` and VS Code's `editor.codeLens` (for markdown) turn
it off; the page is then sent empty rows once.

**The mapping rule, line → block.** A lens's `range.start.line` is placed by
`blockIndexForLine` over `blockLineRanges(md, text)` — the `lineRange` of every top-level
source block, from `groupSourceBlocks`, the same grouping `parseDocument` builds the
document from (it refuses a document whose block and node counts differ, so index *i* is
child *i*). The block is the first whose lines end after the line: the block covering it, a
front-matter line the front matter's; a line no block covers — a blank line between blocks,
one before the first — the next block; a line after the last block (the tail's blank lines)
the last block with lines. A block standing for no lines (generated content, a range
overlapping an earlier block) is never chosen. Lenses are ordered by line and column, a
provider's own order among equals, and all of a block's lenses form one row — a list with a
lens on each item shows them in one row above the list. A lens VS Code could not resolve has
no command and shows nothing, as in the text editor; one whose command has no command id is
a title, drawn as text.

**The registry.** The resolved `Command`s stay in the host, in a map from a fresh id per
refresh (`<refresh>.<n>`) replaced on every refresh: `arguments` may hold a `Uri` or any
object the provider made, which `postMessage` would flatten or refuse. The page gets titles,
tooltips and ids; `runLens` runs `executeCommand(command, ...arguments)` with the originals,
and an id of an earlier refresh is refused and logged. The same holds for code actions below.

**Rows follow nodes** (`webview/lenses.ts`). `lenses` carries `blocks`, the parse's block
count; the page takes the rows only while it holds as many top-level nodes (a page that split
or joined blocks since is ahead, and the refresh after its edit lands is the one to take),
and drops rows for a version older than its document; empty rows always clear. On arrival
each row is put on the node at its index. From then on the plugin state is an array parallel
to the top-level children, carried through each transaction by `descent` — the rule
`fidelityPlugin` follows a node by for `src` and `gap`, exported for this: the same object,
else the old node whose start the mapping takes to the new one's. So typing in a heading
keeps its row, a paragraph inserted above does not shift rows onto the wrong heading, the
second half of a split has no row until the refresh, and a node that disappears takes its
row with it. The rows are `Decoration.widget`s at their block's start (`side: -1`,
`ignoreSelection`, `stopEvent` → every event inside is theirs), a `contenteditable=false`
`div` of buttons: `Tab` reaches them in DOM order, `Enter` or a click posts `runLens`, and
`mousedown` is prevented so no caret moves. The row stands in the block's top margin
(`editor.css`: the block after a row has none), in the editor font at 90 %,
`--vscode-editorCodeLens-foreground`, as the text editor draws lenses. `$(icon)` references
in titles are left out: the page cannot reach the workbench's icon font, and the stand-in
characters it once drew for the common codicons read as broken icons.

The object toolbar keeps off the rows: `place` treats every row's rectangle as occupied and
moves a bar that would cover one past it — above it going up, below it going down — so a
block's bar sits above the block's row. The pointer on a row counts as on the block below it,
so crossing the row towards the bar does not hide the bar.

**Lenses that name their surface.** A row is the text editor's substitute for a rendered
view: above a requirement heading it says the status, the priority and the edge counts,
which the page already renders as the badge and the summary table. The row repeated them in
identical grey tokens — facts, counts and one verb alike, nothing saying which could be
clicked. The decision (Daniel, 2026-09-28): **a lens's value here is its command, placed on
the element it is about**; the row stays only where no rendered view exists; and **the
editor does not guess from titles** — the extension that made the lens says which surface it
belongs to. Guessing would be a second reading of Req Explorer's model (which title is the
status, which count is which relation) that goes wrong the day a title is reworded or
translated; the hint is read from the one place it is true.

*The contract.* A lens that names its surface carries, as the **last element of
`command.arguments`**, `{ reqExplorer: { surface, artifact, relation? } }` (`LensHint`):
`surface` one of `status`, `priority`, `links`, `action`; `artifact` the readable id, as the
injection marks carry it; `relation` the relation key of a `links` lens. `lensHintOf`
(`host/lenses.ts`) checks the shape — an unknown surface, a missing artifact, a hint that is
not the last argument make a foreign lens — and `LensItem` carries the three fields to the
page. The argument stays in the command: `runLens` runs the provider's command exactly as
it was given. On Req Explorer's side, the summary table (`injected_block`, mark
`{ kind: 'atom', artifact }`) marks its rows `tr[data-req-field="<field>"]` and
`tr[data-req-relation="<relation key>"]`, and the badge is the `inline_atom` with the same
mark inside the heading.

*Resolution by artifact* (`place` in `webview/lenses.ts`), against the document the page
holds when the `lenses` message arrives: an index of each artifact's badge (the top-level
heading holding an `inline_atom` whose mark names it) and summary table (the top-level
`injected_block` whose mark names it). For every row the host sent:

- a row with no hinted lens stays a row, on its block;
- in a row with a hinted lens, each lens is placed: `status` on the artifact's badge;
  `priority` and `links` on its table, when the table's HTML (parsed inert, in a
  `template`) has `tr[data-req-field="priority"]`, or the `tr[data-req-relation]` of that
  key; a lens so placed without a command is dropped, since the element already shows what
  it says. Everything else — an `action`, a lens whose element is not there (no badge on
  the page, a relation the table hides, a `links` lens without a relation), and the foreign
  lenses of that row — becomes a verb of the artifact's heading, or of the lens's own block
  when the page has no badge for the artifact. **One block, one grammar**: a row beside a
  clickable badge and clickable table rows would be the mixed grammar this replaces.
- A verb whose block has no object toolbar (`objectOfNode` is `null` — a paragraph) goes
  into a row on that block instead: a lens with nowhere to be would be lost.

Verbs are ordered `action` lenses first, then the rest in line order. The placements are
held per top-level block, as the rows were, and follow their nodes through every
transaction by `descent`; the next `lenses` message places everything afresh.

*Placed elements.* A plugin view (`LensTargets`) marks the elements after every update:
the badge's node-view element (found by the artifact inside its heading node) and the table
row (found in the `injected_block`'s node-view element) get `mep-lens-target`,
`data-lens`, the lens title — the verb — as `title`, `tabindex=0`, and the badge
`role=button`; an element whose lens went is given back its own title. A redrawn rendering
(an `InjectedBlockView` resets its HTML on update) is marked again on the same pass. Its
listeners are on the editor's element in the capture phase, before ProseMirror and before
a rendering's own link handling: a plain click (not with Ctrl/Cmd, not on a `<summary>`)
runs the lens and selects nothing, `mousedown` is prevented so no caret moves, and
`Enter` or `Space` on the focused element runs it. A link inside a relation row runs the
row's lens too — the underline says the row is what is clicked; Ctrl+click still follows the
link. `editor.css` draws nothing at rest; `:hover` underlines the element and its
descendants (a badge drawn as an inline block and a row's cells take no decoration from
their parent) with a pointer, and `:focus-visible` outlines it. The preview's stylesheets
are not touched.

*Verbs in the toolbar.* `ObjectToolbarHost.lensesAt(pos)` answers `lensVerbsAt` for the
top-level block; `present` draws them after the object's own verbs and before the code
actions, each group after a separator, a lens without a command refused. More than
`LENS_VERBS_INLINE` (4) lens verbs: the first three stay and the rest are one **Actions ▾**
verb, an inline choice of them, so the bar keeps to four slots. A heading's bar is a caret
object's: it shows once the caret rests in the heading.

**Code actions as object verbs** (`host/codeActions.ts`). When the object toolbar presents
an object that is a whole top-level block, the page's `codeActionsAt` answers from what it
knows and asks once per node and epoch: `actionsFor { requestId, blockIndex, blocks }`.
The request waits for the page's pending edit (`askActions` defers it while an edit is in
the delay, the doc differs from what the host holds, or a save is committing, and `flush`
sends it after the edit) — it is not sent by flushing from the toolbar's redraw, which can
run inside a save's commit and sent the save's text twice. The session answers from its
queue, behind that edit, so the host maps the index through its own parse of the page's text
(`blockLineRanges`; a count that differs, or a text the page does not hold, is answered with
nothing). It calls `vscode.executeCodeActionProvider(uri, range, undefined, 50)` with the
range from the block's first line's start to its last line's end — what the light bulb
would offer with those lines selected, quick fixes for the diagnostics on them included —
and leaves out what does not belong on a block (`belongsOnBlock`): source actions, which act
on the file and which the light bulb leaves out too; VS Code's *Surround With* snippet
actions (`refactor.surround`), which core offers for every range from every extension's
snippets, around a text selection; and actions whose command works on the active text
editor (`editor.action.*`, `inlineChat.*` — *Modify* with inline chat), of which there is
none. The answer's actions are registered under the document version they were computed
for, checked **after** the provider's await: an edit that landed while VS Code computed has
moved the text their offsets point into, and such an answer is empty and followed by
`invalidateActions`.

`runAction` runs in the session's queue, behind every edit the page sent before the click —
the page flushes its pending edit before posting `runAction` or `runLens`, since a run
arriving first would write to the document before the typed text, which the host would then
drop as based on a superseded text. An action is applied only while the document is at the
version it was registered for and the page holds that text: otherwise nothing is written, the
entry is dropped and the page gets `invalidateActions { refused }` — its hint says the text
changed since the action was offered, and the bar asks again. Clicking an action within the
typing delay therefore refuses it; a second click applies the fresh one. Then the
`WorkspaceEdit` is applied with `workspace.applyEdit`, which reaches the page as another
writer's change, and the command is **started, not awaited**: a command that saves would wait
for the session's queue through the will-save listener while the queue waited for it. A
`Command` returned in place of an action is started as it is. A lens's command runs the same
way, queued behind the edit and not awaited.

On the page the answer is kept per node (a `WeakMap`: an edit to the block makes a new node,
asked about afresh) and per epoch. The epoch moves on with every `document`, every `lenses`
and every `invalidateActions` message — the host sends that one, debounced, after every edit
it applies for the page and whenever `languages.onDidChangeDiagnostics` names the document,
so a quick fix for a diagnostic an edit elsewhere removed is not offered on an untouched
block, lenses on or off. An answer kept past its epoch is shown while it is asked again, so
the bar does not blink; running it is guarded by the host's version check. Every post of an
answer or an invalidation is guarded: a webview disposed meanwhile is a logged warning. The answer's arrival dispatches an
empty transaction, and the toolbar redraws with the verbs. A heading is an object for this
and for its lens verbs alone: its presentation has no verbs of its own, and the selection's
bar is hidden while it has none. Inline objects carry no actions — the host knows no range for a note or a link,
and computing one would be a second answer to where the page's text is in the file.

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
