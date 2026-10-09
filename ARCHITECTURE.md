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

**The one exception: wiki embeds.** The two engines differ in one option,
`WIKI_EMBED_TOKENS_OPTION` (`src/syntax/markers.ts`), which only the editor's
engines set — the host's and the page's, both built on `baseEngine`
(`inlineEngine.ts`), the page running the embed rule as one of the inline
plugins (`plugin/inlinePlugins.ts`). `markdownItWikiEmbed.ts` reads `![[name]]` into a `wiki_embed`
token on both; on the preview's it turns that token into plain text just before
`text_join`, so the text joins its neighbours and an extension that renders
embeds from text (Foam's core rule) finds it; on the editor's the token is kept,
so the editor can hold each embed as one atom carrying its source. The
difference is in token types only: the token's `content` is the text the
preview's joined text holds. What reads text from tokens reads it through
`tokenText` (`src/syntax/tokenText.ts`), which counts a `wiki_embed` as its
text — an image's alt in the editor, a heading's slug for links and fragment
completion, the table of contents' entries — and the plugin renders a kept
token as its text, in its own rule and in markdown-it's `renderInlineAsText`
(an image's alt), so a block the editor or the host renders from the editor's
engine shows what the preview shows. An extension that reads `text` tokens on
the editor's engine (Foam's core rule) does not see an embed there; the editor
draws the atom instead.

A known interplay on the preview's engine: a rule of another extension that
splits text tokens (Req Explorer's status badges, at an id it recognises) runs
on the embed's joined text like on any other and can split it, and Foam's rule
then no longer finds that embed. Not handled here; it is the order of two other
extensions' rules.

markdown-it is pinned to major 14, which is what VS Code's preview bundles, so the
two engines tokenize alike. The engine is built once per provider and rebuilt when
the set of extensions or one of those preview settings changes.

**Why the front-matter rule is on the editor engine only.** VS Code's preview
registers its own front-matter rule on the engine it hands to `extendMarkdownIt`,
and a second one from this extension conflicts with it (see the comment on
`plugins`). The editor engine is built from scratch, so nothing registers one for
it: without `markdown-it-front-matter` the YAML block would tokenize as a thematic
break and a setext heading — and front matter is the one block Req Explorer
requires to leave the editor exactly as it entered — untouched, it does; the properties panel
changes only the characters a person edits (below, *Properties*).

### The block model

`blocks.ts` groups the top-level tokens into **source blocks**, each with the exact
slice of the file it stands for (`src`) and the text between it and the previous
block (`gap`). Every block is one of four kinds:

| Kind | What | Node | Written back as |
| --- | --- | --- | --- |
| `front_matter` | The YAML block at the top | `front_matter` (atom), drawn as the properties panel | Its `src`: the slice, or what the panel set it to (below, *Properties*) |
| `editable` | The core: paragraph, heading, lists, blockquote, code, rule, container, admonition, pipe table — with the inline constructs and the attribute literals below | The matching node, with `src` and `gap` | Its `src` while untouched; serialized by rule once changed |
| `raw` | Anything else — a table using markdown-it-multimd-table's extensions, HTML, the TOC, footnotes, definition and task lists, abbreviations, reference definitions, a setext heading, a note inside a note, an attribute literal the editor cannot write back where it stands, a container or admonition nested past one level, lines no token covers | `raw_block` (atom, `html` rendered by the host) | Its `src`, which only an explicit source edit changes |
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
In any text, a note's included, `ESCAPE_EXTRA` also escapes an emoji shortcode (`\:smile:`),
and the state's `esc` every shortcut of markdown-it-emoji's own table (`emojiShortcuts.ts`)
not beside a letter, digit or mark: the plugin reads one at a token's edge without looking
further, and the escape of a neighbour makes such an edge (`5\$:)` is `5$` and a smiley), so
`5$:)` is written `5\$\:)`. Typed text needs no emoji rule for that; the page's engine runs
the registry's emoji plugin for the emoji the file holds, which are atoms (below). A bare link is another such edge, and where it starts and ends is asked of the
page's engine, reading the textblock as written, never computed (`judged`,
`readAutoLinks`): a shortcut inside a link is left, one at its edge is escaped though a
letter stands beside it, and a backslash there is kept only where the engine still reads
the same links, text and address, with it (`http://x.com\:)`; after a path linkify would
take it in, so a typed `http://x.com/p<3` stays as typed). The parser gives no offsets,
so a link is placed only where its text stands as often as such links were read, places
inside a link already placed not counted; otherwise every place its text or address stands
is taken for it. A bare link mark is written bare only where the engine reads a link of
the node's text and address where it was written; otherwise `[url](url)`, again until
every bare one reads back, and so is one beside a shortcut whose backslash linkify would
take in. So a letter an edit glues to it, a shortcut after a path, a sidebar's marker or
the node after it stays outside the link, and the delimiters of emphasis around it are
judged as written (`**http://x.com**s`). Each judgement reads a textblock a bounded number
of times: past a few links whose place is uncertain, such a link is written `[url](url)`.
A sidebar's or a note part's text is judged within the textblock that holds it. The render
takes each text's escapes from the trial by the order of the `esc` calls, checked by the
text; a text the trial does not find where it wrote it — a part whose markers the writer
spells (`&#36;`), an image's alt, a text whose last character a later writer rewrites (a
`!` before a link or span, a `+` or `!` before a note) — is escaped by the letter rule
alone, so a smiley right against a URL there still reads as an emoji. In a sidenote or
marginal note the plugin reads a smiley even escaped.
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

**Marks that open together.** The editor's model is a set of marks per text node; it does
not remember which of two marks encloses the other, and the parser reads both nestings
(`==[a]{.x} b==` and `[==a== b]{.x}`, `[*a* b](u)` and `*[a](u) b*`). prosemirror-markdown
opens the marks of a node in schema order, a rank, so where two begin on one node and the
one ranked first ends sooner, the other was closed with it and opened again:
`==[a]{.x} b==` was written `[==a==]{.x} ==b==`, two highlights. The serializer now opens
them in the order their runs end, the longer one outside, ties in schema order
(`openingOrder` in `serialize.ts`, inserted into a copy of the library's `renderInline`
on `OrderedInlineState`; `serialize.test.ts` guards the copy against the library). The
parser judges each textblock where the two orders write different text: the order of the
runs only where its text reads back as the textblock, else the library's — in
`~~*==a==*b~~` the `*` between `=` and `b` cannot close, while `*~~==a==~~*~~b~~` reads
as written — so a textblock is never written worse than the library writes it. A
delimiter's flanking is asked of the parser, never modelled. One
nesting the parser cannot read stays split: a key beginning with a span or a link, since
markdown-it-kbd reads the `[[` of `[[[` as a nested key; it is written as two keys
(`[[[a]]]{.x}[[ b]]`), which is also what the page draws (`CANNOT_LEAD`). `assertStable`
does not see a split run — it is written the same way twice — so `inline.test.ts` judges
every ordered pair of mixable marks in six positions, glued to what follows or not, by an
element count of the rendered text (`assertOneElementPerRun`), and every triple by whether
it reads back wherever the library's order does. Two limits remain. The page's `DOMSerializer` draws by
rank, so it shows `<i><mark>a</mark></i><mark> b</mark>` where the file holds
`<mark><i>a</i> b</mark>`; the same to the eye unless a stylesheet styles a run's edges.
And a mark already open that ends inside one opened later is still split
(`em(x link(a)) link(b)` is written `*x [a](u)*[ b](u)`, two links, the model kept): only
closing and reopening the outer mark could write it as one link, a different mechanism.

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
| `{…}` on a top-level paragraph, list, quote, table, fence or rule | `attrsSuffix` + `attrsPlacement` on the node | the node's element with the literal's attributes (a fence's on its `<code>`) | where it stood (below) |
| `{…}` at the end of a list item's first paragraph, at any depth | attr `literal` on `list_item` | `li` with the literal's attributes | after a space at the end of that paragraph's last line |
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

**A quote, a table and a list item** carry theirs too, each where markdown-it-attrs reads
it (checked against the plugin's `patterns.js` and the engine, not guessed). A quote's is
`line` inside it — `> {.a}` under its last paragraph, or a lazy `{.a}` there — which the
plugin takes through that paragraph's soft break and gives to the outermost block the
closing tokens after it end: the quote, but only while its last block is a paragraph;
after a list, code or a nested quote the same line belongs to that block. `serialize.ts`
states that rule once, in two predicates over one helper (`quoteLiteralHost`: the last
block that is not an empty paragraph, since an empty one writes a bare `>` line that
reads back as nothing). `quoteTakesLiteral` — that block is a paragraph with text — is
when the serializer writes the line, before any trailing `>` lines, and when the page
gives a quote a literal. `quoteLostLiteral` — that block is not a paragraph — is when the
fidelity plugin takes the literal off: a quote whose paragraphs are only empty for now
(`Enter` at the end of the last one, its text deleted to be typed again) keeps it, and it
is written again as soon as there is text. A table's is under it, in no token's map like
a list's `blank` one: `line` (right under the last row) or `blank`, read and written as
it stood; a new one is `blank`, the form the plugin's README gives. Whether the next
block's first line may follow a `{…}` line of its own — a table's, a list's, a quote's
`> {…}`, a paragraph's `line` one — straight is the parser's to say, as for every seam a
changed block makes (*Where fidelity is enforced*): `{.wide}` + `After.` is one paragraph
of text and gets a blank line between them, while `{.wide}` + `# After` under a table is
the table's literal and a heading, and stays tight. A list item's is not a top-level block's `attrsSuffix` but the item's
own `literal`, at any depth, at the end of its first paragraph (`- text {.a}`, the
plugin's "list item end" rule; `recoverItemLiterals`), where the serializer writes it back
after the paragraph is wrapped. The item must start with a paragraph (`itemTakesLiteral`),
empty or not: `- {.a}` is the plugin's empty item with the literal, and after a hard break
at the end of the text (`Shift+Enter`) the literal follows on the continuation line, the
item's still. Only when the file is read is a literal after a trailing hard break left a
source block, since the serializer writes no trailing hard break and the text would change.
A lone `{…}` line closing the first paragraph is the list's (`- a` + `{.b}`), so the item's
literal is read from the line before it, and both are kept. The fidelity plugin drops an
item's literal when the item descends from no old item — the second half of a split,
which copies the attributes, a pasted item — judged by where the old items' starts map
to (split at the start of its text, the empty first half keeps it), and when the item no
longer starts with a paragraph.

**Braces that are text.** A textblock whose text ends in what reads as a literal (`Set
notation \{x\}` in the file, `{x}` in the node) has the braces of that end written
escaped (`escapeTrailingLiteral` in `serialize.ts`) — with a literal after it and without
one — so removing a block's literal never turns the text before it into attributes.

**Attributes…** (`webview/attributes.ts`, Daniel, 2026-09-30 from a sketch) sets the
literal of the block at the caret: **Formatting → Attributes…**, right after *Span with
class*, and the verb of the same name on the bars of a table, a container and an
admonition (refused there), any block already carrying a literal (*Paragraph attributes*,
*Quote attributes*, …) and a heading whose bar shows for other verbs. A bar whose one verb
would be *Attributes…* on a block with no literal yet — every plain heading — is not drawn
(`barless`): that would be chrome on every such block (Daniel, 2026-09-30). A paragraph, a
quote and a list item without a literal, and a plain heading with no lenses or actions,
reach it through the menu only. Both surfaces open the same field step (`attributesStep`) and commit through the same
rule (`commitAttributes` in `objects.ts`), so they cannot prefill, refuse or announce
differently. The field is labelled with the block's name (*Paragraph · Attributes*),
placed at the block by the bars' ladder, prefilled with the literal — or `{.}` with the
caret after the dot when there is none — and takes the whole literal (`.class`, `#id`,
`key=value`, `key="a value"`); at its right the bar says so, `↵ set · Esc cancel ·
{.class #id key=value}` (`FieldStep.keys`), and **Span with class**'s field says the same. `Enter` sets it in one transaction, so one undo step, and
the hint says *Attributes set — Ctrl+Z*; `{}` or an empty field removes it (*Attributes
removed — Ctrl+Z*); `Esc` changes nothing. A literal markdown-it-attrs would not read
back whole is refused beside the caret with the reason (`literalRefusal`, the stage-3
reader). The block is the innermost list item holding the selection, else the top-level
block: a nested paragraph's literal is not written, so the caret in a paragraph in a quote
gives the quote its attributes, and the field's label says which block it is.

| Block | Written | The plugin gives it to |
| --- | --- | --- |
| Paragraph (an image alone in one too) | after a space at the end of its last line: `text {.x}` | the `<p>` |
| Heading | at the end of its line: `## Title {.x}`; its `#id` is the heading's anchor | the `<hN>` |
| List item | at the end of its first paragraph, at any depth: `- text {.x}` | the `<li>` |
| Quote | a line of its own under its last paragraph, inside it: `> {.x}` | the `<blockquote>` |
| Table | a line of its own under a blank line after it: `{.x}` (one right under it stays there) | the `<table>` |
| Fenced code | after the opening fence's info string: ```` ```js {.x} ```` | the `<code>` |
| Rule (selected) | after the rule: `--- {.x}` | the `<hr>` |
| List (one it has already) | where it stood: under its last line, or under a blank line | the `<ul>`/`<ol>` |

Where no literal can go the entry is disabled and says why — in its tooltip, and on its
preview card, where the eye already is — rather than writing one the file would not keep:
a container (the preview draws a literal on its `:::` line, but the container node has no
slot for one, so a container written with one is a source block; its classes are its name
and info), an admonition (the plugin gives a
literal on the `!!!` line to the title bar), a quote ending in another block, a list item
not starting with a paragraph that ends in text, a requirement heading (its anchor is Req
Explorer's), an indented code block (no opening line), a source block, the front matter,
injected content. A block that already has a literal stays a native block with the literal
edited in place; a literal the reader refuses when the file is opened leaves its block a
source block, as above.

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
for the literal in the inline field, prefilled `{.}` with the caret after the dot;
**Attributes…** (`block-attrs`) does the same for the block at the caret (above).

### Tables

**Pipe tables are native; multimd's extensions stay raw** (Daniel, 2026-09-29). The engine's
table rule is markdown-it-multimd-table's, which reads GFM's pipe table and a good deal more.
The editor edits the GFM subset as a table — a header row, the delimiter row with optional `:`
alignment, body rows, one line each, inline content in the cells — and leaves every table
that uses anything else a source block, edited as Markdown exactly as before.

**What stays raw, and how it is told** (`pipeTableNotEditableBecause` in `blocks.ts`). From the
tokens wherever they show it: a colspan (`||`) or rowspan (`^^`) cell carries a `colspan` or
`rowspan` attribute, a `+` in the delimiter row a `class`; a caption (`[…]` above or below) is
`caption_open`; a headerless table has no `thead`, a second header row is a second `tr` in
it, a second body after a blank line a second `tbody` — the plugin joins tables a blank line
apart into one; a multi-line row (`\` at a line's end) is a `tr` whose map spans lines, its
cells holding paragraphs. From the delimiter row's slice where only the source tells: a `=`
(`|===|`), which the tokens do not show. And a table whose cells hold what a cell cannot
hold here: a row of another width than the header (the plugin renders it ragged), a
sidenote or marginal note (below), code holding a `|`, anything that already makes a
paragraph raw (inline HTML, a footnote reference). A source block that is a table says so
in its bar — *Source · multimd table*, or *Source · table* for one of the last kind
(`construct` on `raw_block`) — so the table with no Row and Column menus explains itself
beside the one that has them. A table inside a container, a quote or a list leaves that
block a source block, as before: `table` is in its own schema group, top level only.

**The model** (`schema.ts`, *Tables*). `prosemirror-tables`' four nodes, made by its
`tableNodes`; a cell is a textblock whose content is the paragraph's inline set without a
hard break (a row is one line — `\` at its end would continue the row, `<br>` is raw HTML)
and without the two notes with a reference, whose `|` is a cell boundary: escaped as `\|`,
the notes plugin still ends the reference there, backslash and all. A column's alignment is
an `align` attribute of every cell of it, drawn as `style="text-align:…"`, as the plugin
draws it. The library draws every row inside one `<tbody>` (one node has one content hole),
the header row's cells `<th>`: a stylesheet rule keyed on `thead` does not reach the header
here, and `tr:nth-child(2n)` counts the header row. Spans and column widths are not Markdown:
a pasted `colspan` reads as 1, and `columnResizing` is not installed.

**The tidy form** (`serialize.ts`). A changed table is written as the extension's own **Format
Table** writes one — `tableLines` hands the cells' Markdown to `MDTable` in
`src/services/table`, so the editor and the text editor's command cannot disagree on what a
tidy table is: `| cell | cell |`, every cell padded to its column's widest (monospace
columns, a CJK character two), the column at least as wide as its delimiter needs, the
delimiter row carrying the colons (`---`, `:--`, `:-:`, `--:`). A cell is its inline Markdown on
one line, trimmed: `|` in text is `\|`, escaped where the text is escaped (`ESCAPE_IN_CELL`,
beside `ESCAPE_EXTRA`) — in text, alt text, a sidebar's text and a link title — never by a pass
over the finished cell, which would escape a literal's own `\|` a second time; an empty cell is its padding, never `||` (a colspan);
a cell reading as a delimiter cell (`---`) has its first character escaped; `^^` is escaped as
every `^` is. The row scan finds boundaries before any inline parse, so a link's destination
in a cell has `|` and a backtick percent-encoded, a backtick in its title is escaped, a bare
link holding either is written inline, and a text's `\` right before a code span is `&#92;`
(the scan reads `\\` as escaping the backtick after it). Code holding a `|` has no spelling —
the scan splits a row at it inside a longer fence and not inside a single-backtick one — nor
has an attribute span's literal holding a `|` or a backtick; the page refuses to make either
(`unwritableInTable`, a `filterTransaction` in `webview/tables.ts`, as the notes' refusal
works), and a table the file holds either in is a source block (`blocks.ts`), so no table is
drawn editable that the page could not write back. Wrapping never touches a table: its serializer writes whole rows, and `wrap.ts` only
wraps paragraphs. An untouched table is its slice, in whatever form it was written, and the
tidy form is a fixed point: parsed and written again it is the same text. Found on the way:
`MDTable` computed a column's width floor before its alignment was known, so Format Table wrote
a narrow aligned column's delimiter as a bare `:`; setting the alignments now recomputes it.

**The keys** (`webview/tables.ts`, ahead of the Markdown keys). `Tab` moves to the next cell,
its text selected, and in the last cell adds a row and goes into it; `Shift+Tab` moves back
and stays in the first cell. `Enter` moves to the cell below — never a line break, since a
cell holds one line and ProseMirror's split would split the cell into two cells — and in the
last row adds one; a caret in an empty last row (a caret, not cells selected down into it)
takes the row away again and leaves the table for a new paragraph after it, as `Enter` in an
empty last item leaves a list. `Shift+Enter`, a hard break, is refused with the reason beside
the caret (`CELL_BREAK_REFUSAL`, the one sentence any refused break says). Arrows, a drag across cells (a
`CellSelection`, drawn in the selection colour) and pasting cells are `tableEditing`'s; a cell
has no block type, so the block-type control is locked there (`TABLE_LOCK`, on `isInTable`).

**What the page adds to a table's look**, each an affordance or feedback, not decoration
(Daniel, 2026-09-29, after the screenshots): a hairline around the table the caret is in, the
focus colour at 40 %, 1px, no offset — the table looks editable before its bar arrives; every
cell of an edited table at least a line high and 1.5em wide with a faint inner line, since VS
Code's `markdown.css` draws no cell border and a new table of empty rows showed as two
hairlines; the cells a verb just made highlighted and faded over 600 ms (`FLASH_MS`, held
without the fade under `prefers-reduced-motion`; only the verb's transaction arms the timer,
and any other change — typing, an undo — ends the flash rather than carrying it onto cells it
may no longer mean); and after a delete the caret in the cell now
standing where the deleted one stood, so the edit shows where it left the person. None of it
reaches a table another extension renders (a summary table): the rules are on the editor's
own `table` nodes.

**The invariants the library does not keep** (`normalizeTables`, run by every verb and
appended to every other transaction): exactly one header row, the first — a row added above
the header is the new header, a deleted header row hands the role to the next — and one
alignment per column, the header cell's. The verbs that add a row copy the alignment of the
row beside it, so a row added above the header keeps the columns aligned. There is no
*Toggle header row*: GFM has no table without a header, and multimd's headerless one is raw.

**The bar** (`objectToolbar.ts`, Daniel, 2026-09-29): five slots — `Row` (*Insert above*,
*Insert below* with `Tab at end` as its keyboard route, *Delete row*), `Column` (*Insert
left*, *Insert right*, *Delete column*), `Align` (*Left*, *Center*, *Right*, each with its
delimiter, the current one marked with a ✓ — state apart from the focus ring; the marked one
chosen again is the default, `---`), a gap,
then *Edit source* and *Delete table*. The three are set-verbs: a menu opens under the verb on
a click, `Enter` or `Space`, in the formatting toolbar's menu chrome (`.mep-menu`), the arrows
move, `Enter` chooses, `Esc` closes back to the verb. They act on the rows and columns the
selection is in, and while the bar shows the caret's column is tinted — a node decoration on
its cells — so *left* and *right* have something to be left and right of. Deleting the last row
or the last column is refused with *Delete table* named instead. *Edit source* replaces the
table by a source block holding its text (its slice untouched, else the tidy form) and opens
its box; the commit is parsed by the host again, a table once more if it still is one.
**Insert → Table** makes a table natively after the current block (`insert-table`): a header
row `Column 1` … `Column 3` and two empty rows, the first header cell's text selected.

**Positions** (`positions.ts`). A cell is a textblock but not a line: its text starts after a
`|`. The anchors of a table are a line break before every row but the first, a `|` before
every cell and after the last, and after the header — whether a body follows or not — the
delimiter row's `|`s, one per boundary of the header's cells, after a line break; the padding
and the dashes are delimiter runs. So a position after a cell's text
maps before its padding, and back. A code lens on any of a table's lines goes on the table
block, as on any block (`blockIndexForLine`).

### Properties

**The front matter is a properties panel, edited in place** (Daniel, 2026-09-29, sketch 8:
collapsed by default, `uid` read-only, a nested key one row that opens the source; a
generic panel for Markdown Extended Pro, never a Req Explorer form). The node is still the
`front_matter` atom its slice made, and its `src` is still what the serializer writes; what
changed is that the page can now set that `src` — from a row of the panel, in one
transaction (`commitFrontMatter` in `webview/main.ts`, a `setNodeMarkup` under
`closeHistory`), so every edit is one undo step of its own — never merged with the one made a
moment before, which is what makes *Removed `key` — Ctrl+Z* true after two quick edits — and
is posted like any block edit. `fidelity.ts` never clears a source node's
`src`, so nothing else is needed for "no longer untouched": the new `src` *is* the
serialization of the model.

**The model** (`frontMatter.ts`, pure, loaded by the page and the tests alike).
`splitFrontMatter` cuts the `src` into its opening line, the YAML and its closing line
(`---` or `...`; none for a front matter the end of the file closed), each with its
terminator, and `joinFrontMatter` puts them back exactly. `readProperties` reads the YAML
with the `yaml` package's `parseDocument` (`uniqueKeys`) — the parser of the family VS
Code's own YAML tooling is built on — and gives one `Property` per top-level key. The kinds,
as the module states them:

- a scalar that is `true` or `false` (any case YAML reads as a boolean) — `boolean`, a checkbox;
- `uid`, or a key ending in `uid` or `id` whose value is a UUID — `id`, read-only;
- a string that is a date, `YYYY-MM-DD` — `date`;
- `lang` — `choice`, a text field offering the values `lang` has anywhere in the file;
- any other one-line scalar (a string, a number, an empty value) — `text`;
- a sequence whose items are all one-line scalars — `list`, chips, in its own style: a
  flow sequence (`[a, b]`) stays flow, a block one (`- a`) block;
- anything else — a map, a sequence holding a map or a list, a multi-line string, an
  alias — `source`: one row saying what it holds, whose value is edited as YAML in the
  block's source.

No enumeration is guessed from values beyond `lang` (`ENUMERATED_KEYS`), and no schema is
read. A YAML the parser refuses (a syntax error, a duplicate key) or whose top level is not
a map is one row saying why, beside *edit as source*.

**In place, not round-tripped.** An edit is a text splice at the offsets `parseDocument`
reports for the node it changes (with `keepSourceTokens`, for the indicators the nodes do not
carry) — `setText` and `setBoolean` replace a scalar's value characters (an anchor before it,
a comment after it stay; an empty value is written right after its colon, so `key:   # note`
becomes `key: x   # note`, not `x# note`); `addItem` inserts `, x` after a flow list's last
item, or a line of the last item's indentation and `- ` (not its anchor or tag) after a block
list's; `removeItem` cuts a flow item's own text with one comma, or a block item's line;
`removeProperty` deletes a pair's lines; `addProperty` appends `key: value`, only to a block
mapping or an empty YAML (a flow map or a list would not take the line as a key) and with a key
quoted where plain would not read back as itself — and the document is
never written back through `yaml`'s stringifier, which would normalize indentation, spacing
and the blank lines between keys. Key order, comments, quoting, anchors, block scalars,
blank lines and line endings of every key not edited are therefore the file's bytes; a new
line is terminated with the front matter's own line ending (`eolOf`). A value keeps its
scalar's quoting: a double- or single-quoted one stays so; a plain one stays plain where
plain text reads back as the same kind of value (`readsAsPlainString`: a number as a
number, a string as that exact string), and is single-quoted otherwise, so `true`, `42`,
`a # b` or `a: b` typed into a text row stay text. A new key's value is written as typed
where it reads as one plain scalar or a flow list of scalars (`2026-10-01`, `true`,
`[a, b]`) — typed from its value, as every other row — else quoted. An edit whose key is not
there, or not of its kind, returns `null` rather than guess, and so does one whose result would
not parse or would leave an alias naming no anchor (`checked`: removing `&x a` while `*x` stands
elsewhere). A key is named for an edit by where it stands as well as by its name (`KeyRef`,
`{ offset, key }`): `1:` and `'1':` are two keys that read as one name. `frontMatter.test.ts` holds a
YAML with comments, an anchor and its alias, a block scalar, both list styles and a nested
list of maps to "one scalar changed, one line changed", every other kind of edit to the same,
LF and CRLF, and Req Explorer's conformance documents (`FR-CON.md`, `FR-CON.de.md`) to one
line changed and a parse with the same blocks.

*Its limits, as built:* removing a key leaves a comment line above it, which may have been
about it; a new key goes at the end, never beside a related one; the last item of a block list
removed leaves `key: []`, since a block list cannot be empty.

**The panel** (`webview/properties.ts`, `PropertiesView`, the `front_matter` node view).
A header `▸ Properties  <n>` — the count of top-level keys — and **Edit as source** at its
right, collapsed by default; the state is remembered per document in `localStorage` under
the document's uri, which the host writes on the page's mount element
(`data-document-uri`, `host/html.ts`) — a page without storage opens collapsed. Expanded,
one row per key: the key in the editor's monospace, since it *is* the key, and the control
of its kind — a text field (the inline field's colours, as wide as its value — `field-sizing:
content`, `size` as the fallback — with a 1px border at 20 % of the foreground at rest, stronger
on hover, the focus colour on focus: an editable value must look editable before the pointer
finds it, and the read-only uid, borderless and dimmed, is told apart by that difference); a date as its text as the file writes it, with a calendar
button that opens the browser's picker from a date input kept out of sight (`showPicker`,
`Alt+↓` in the field too) — `<input type="date">` itself shows the system locale's
`09/29/2026` beside the file's `2026-09-29`, a second spelling of one value — and a text that
is no date refused with the reason; `lang` a text field whose values are listed under it in
the editor's one completion list (`CompletionListView`, `webview/completionList.ts`, as the
link field's and the language completions are), opened on focus, narrowed to the values holding
what is typed, `↓`/`↑` and `Enter` to set one, `Esc` closing it before it reverts the row — a
native `datalist` would have been the browser's chrome beside the editor's; a checkbox; chips with `×` and a dashed **+ add**; a uid in mono, dimmed, copied on a
click (`navigator.clipboard`, else `execCommand('copy')`); a source row *`<n>` items, nested ·
edit as source*. The last row is **+ Add property**: the name, then the value. A row's `×`
stands right after its value — at the row's far end it was 900 px from the key it removes — shows
on hover or while the row has the focus, keeps its place so nothing moves, is a Tab stop named
*Remove `key`*, and removes the key; so does `Shift+Delete` on any of the row's controls — *Removed `key` — Ctrl+Z*, in the caret hint, which `showHint` can now place under
an element (`near`) since the caret is not where the panel is. A uid row has no `×`:
read-only is read-only.

*The keys.* `Enter` commits a row, `Esc` reverts it, a second `Esc` puts the caret in the text
after the front matter (`leaveFrontMatter`). `Tab` goes through the rows in the browser's
order (each row's control, a list's **+ add**, the row's `×`, then **+ Add property**). A row is committed when the focus leaves it too — a deliberate difference from the
inline field, which is gone once it loses the focus: a row stays and shows its value, and a
value that showed typed and then silently reverted would say something the file does not
hold. `Ctrl+Z` in a field with typing of its own undoes the typing; anywhere else in the
panel it runs the editor's `undo` (`history` on the port), and is kept from VS Code either
way; a field with no committed value of its own (a new property's name and value) is all
typing. Rows with typing not yet committed register with the page as a `SourceEditor`, so
`Ctrl+S` commits them before it saves, as it commits an open source box.

*A click during typing is not lost.* The commit on leaving redraws the rows, and a redraw
between a press and its release leaves the click nowhere — a `×`, a checkbox, a chip's `×`,
**+ add**, the calendar. So while a field holds uncommitted typing, a press on anything in the
panel but a text field is kept from moving the focus (`preventDefault` on `mousedown`, in the
capture phase), and each action commits the typing itself first (`flushDirty`) and then looks
its key up in the model as it now is (`ref`: the row's index and name), since the commit may
have moved every offset after it.

*A redraw keeps the focus.* Every commit sets the node's `src`, ProseMirror calls `update`,
and the panel draws its rows again (only when `src` changed). The focused control is found
again by its slot (`data-slot`: `value:<row>`, `remove:<row>`, `add-item:<row>`, `add:name`, …,
by row index, since two keys can share a name) and focused, with
typing that had not been committed restored where the value under it did not change — so
`Tab` after typing lands on the next row although the commit redrew the panel under it (the
commit runs on a zero-delay timer after the blur, once the focus has moved), and a re-sync
from the host while a field is being typed in does not wipe it.

*The source box.* **Edit as source** and a source row's link open the YAML between the fences
in the raw block's textarea chrome (`mep-raw-editor`), `Ctrl+Enter` or leaving applies, `Esc`
cancels, as a source block's box; from a row it opens with the caret at that key and the page
scrolled so the key's line is in view. The fences are not in the box: they are what makes the
block front matter, and a box that could delete one would turn the YAML into a rule and a
setext heading on the next parse. An emptied box leaves `---` twice.

*The caret, positions and the bar.* The node is still an atom for `positions.ts`: the
position before it is its slice's start, one inside it maps before it. A field is not a place
in the text, so while one has the focus the page reports the caret as none (`inPropertiesPanel`
in `main.ts`, and a `focusin`/`focusout` listener that reports again) and
`visualEditor.active()` answers `caret: undefined`. The object toolbar draws no bar for the
front matter's label alone (`barless`, which a heading shares): its verbs are the panel's
header, and the bar carries only other extensions' code actions, when there are some.

**Insert → Properties** (`insert-properties`, `insertPropertiesTransaction`) inserts a
`front_matter` node holding `---` twice, in the document's line ending, as the first node,
and opens the panel at the name of a new property (`addPropertyAt`). The block after it now
follows something else, so the fidelity plugin clears its gap and it is written a blank line
below. The entry is disabled, saying why, in a document that has front matter; the toolbar's
test holds the entry's syntax to parse as front matter and render nothing.

**Req Explorer.** Nothing in the contract changes. Its marks and lenses read line numbers
from the text the host holds, and an edit to the front matter shifts the lines below it
exactly as typing a line into a paragraph does: the host maps a lens by the block's lines in
its own parse of the page's text, and the re-sync takes any document it posts back in place.
The conformance suite (`REQ_EXPLORER_ROOT=… npm test`) runs `FR-CON.md` and `FR-CON.de.md`
through the panel's edit — the model's `setText` on `lang`, set as the node's `src` — to one line
changed, LF and CRLF, and a parse of the result with the same blocks.

*Left for later: a schema.* The typing reads the value alone. The hook for more is
`ENUMERATED_KEYS` and `propertyOf` in `frontMatter.ts`: a later step lets an extension say
what a key is — a closed set of values, a date, an id minted elsewhere — through the same
kind of exported function the includes use, and the panel would type a row from that before
its value. Not built: which extension may type which keys, and what the panel does when two
disagree, are questions of their own.

### Injected content

Req Explorer marks every token its preview plugin injects under
`token.meta.reqExplorer` (SPEC §10.2). The editor reads the mark and treats each kind
differently:

| Mark | Example | Editor treatment |
| --- | --- | --- |
| `atom` | Status badge, `table.req-summary` | A read-only block or inline atom showing the rendering; nothing is written |
| `expansion` | A snippet expanded from `<!-- include: id -->` | One read-only block; the directive line is written back. Its object toolbar offers **Open snippet** only with `path` — a `missing` expansion has none — and **Change snippet…** (below, *Includes from other extensions*), **Show in text editor** and **Delete directive** always |
| `decoration` | `span.req-ref` around a bare id | Not a node: the id stays editable text, carrying a `req_ref` mark that is never serialized |

Token ranges nobody marked and no source line accounts for (the footnote list
`markdown-it-footnote` appends) become `injected_block`s of kind `generated`. A
requirement heading's `ID: ` prefix is lifted into `reqPrefix` and rendered
non-editable; the `{#anchor}` suffix is kept verbatim in `attrsSuffix`. A heading is
recognised as the artifact's by **either of two signals** in the token stream
(`liftRequirementPrefix`): the badge atom in it naming the id, or — for a heading that is
itself the top-level block — the summary table (`injected_block`, mark `{ kind: 'atom',
artifact }`) that is the next top-level block, blank lines aside, naming it; the text
must start with `ID: ` either way. Two, because Req Explorer injects either or both: since
`CR-RXE-129` the summary is the one status surface and a heading whose table shows the
status gets no badge, while a heading with no table keeps its badge. Reading one signal
alone would leave the other kind of heading with an editable id.

### Host and page

`host/provider.ts` registers a `CustomTextEditorProvider` (`markdownExtended.visualEditor`,
priority `option`) over the file's own `TextDocument`, so Req Explorer's
`WorkspaceEdit`s, the text editor and the rich editor meet in one buffer and VS Code
keeps dirty state, save and undo. Each open editor is a `VisualEditorSession`
(`host/session.ts`); the page is `webview/main.ts`, bundled on its own because it
must not import the parser (it imports `schema.ts`, `fidelity.ts` and `serialize.ts`
directly, never the barrel). That keeps the document parser and the block plugins out of
the page. markdown-it itself is in it, with the registry's plugins that add an inline rule
(`plugin/inlinePlugins.ts`): after an edit the page writes each textblock it touched as the
save will and parses it (`inlineEngine.ts`), and refuses the edit when a sidebar would not
read back where it stands, or text would read as one it does not show (`unwritableInNote`
in `serialize.ts`). The engine is built from the host's definition — its linkify and
typographer settings and which of those plugins its registry runs, in its order
(`inlineEngineDefinition`) — posted with each document; other extensions' plugins are not
in the page and not asked.

The protocol (`protocol.ts`) carries the parsed document one way and the finished
text the other — never a diff:

| Direction | Message | Meaning |
| --- | --- | --- |
| host → page | `document { json, version, defaultWrap, includes, inline }` | Show this parse of document `version`; `includes`: whether any extension offers include choices (below); `inline`: the engine the page checks an edit's textblocks with |
| host → page | `rendered { requestId, html }` | A raw block's new source, rendered by the host engine |
| host → page | `error { message }` | The document cannot be shown without loss; offer the text editor |
| host → page | `lenses { version, blocks, rows }` | Other extensions' code lenses, one row of `{ id?, title, tooltip?, surface?, artifact?, relation? }` per top-level block index (below) |
| host → page | `actions { requestId, blockIndex, items }` | The code actions for one block, `{ id, title, kind, refusal? }` each (below) |
| host → page | `invalidateActions { refused? }` | Every answer the page holds may be stale; ask again. With `refused`, that action was not applied (below) |
| host → page | `revealAnchor { anchor, line }` | Bring a followed link's fragment into view and put the caret there: the block `line` starts, and in it the element with the id `anchor` (a nested heading's explicit id); else (no line) the page's element with that id (below) |
| host → page | `includeChosen { requestId, insert? }` | The include line chosen in the QuickPick, as its provider offered it; none when dismissed or nothing was offered (below) |
| host → page | `linkChoicesResult { requestId, items }` | Completions for a link's field, `{ value, label, detail?, kind }` each, best first, capped (below, *Links and images*) |
| host → page | `filesChosen { requestId, files }` | The answer to `pickImage`, `insertFiles` and `saveImage`: the files to insert, `{ src, alt, image }` each — `src` relative to the document, POSIX, percent-encoded; for `saveImage` the copy the host wrote; empty when the dialog was dismissed or nothing could be written (below) |
| host → page | `imagesResolved { requestId, sources }` | For each asked `src` that names a file, the webview uri to load it from; a `src` left out is shown as written (below) |
| host → page | `reportCaret` | Report the caret again, the same one included: the host forgot it and no document is on its way (below, *Source positions*) |
| host → page | `map { id, toSource?, toPage? }` | Map these page positions to source positions and these source positions to page positions, with the page's own document (below) |
| host → page | `completions { requestId, version, items, incomplete }` | The completions at the caret, `{ label, detail?, kind?, insertText, range?, sortText?, filterText? }` each, VS Code's order, capped; empty when stale (below, *Completion, diagnostics and hover*) |
| host → page | `completionApplied { requestId, version, caret }` | After the document the applied completion produced: where the caret goes in it, `null` when nothing was applied |
| host → page | `diagnostics { version, items }` | Every diagnostic VS Code holds for the document, `{ range, severity, message, code?, source? }` each, in the text the host holds for the page |
| host → page | `quickFixes { requestId, items }` | The quick fixes for a diagnostic's range, `CodeActionItem`s run with `runAction` |
| host → page | `hoverResult { requestId, html, range? }` | The hover providers' Markdown, rendered by the host with only trusted command links kept (as `data-mep-command` ids), and its source range |
| page → host | `ready` | Loaded; send the document |
| page → host | `edit { text, baseVersion, save?, reparse? }` | The whole text as the page would save it (250 ms after the last change); with `save`, the person pressed Ctrl+S and the host saves after applying it; with `reparse`, the host posts the document back after applying it, although it is the page's own text (the toolbar wrote syntax as source) |
| page → host | `render { requestId, src }` | Render this raw block source |
| page → host | `openSnippet { path }` | Open an expansion's snippet file (only paths the document's own marks name are opened) |
| page → host | `openSource { line }` | Open the text editor beside, at this line |
| page → host | `openLink { href }` | Follow a Ctrl/Cmd+clicked link (a plain-clicked one in a read model); the host resolves it against the document (`host/links.ts`) |
| page → host | `refreshLenses` | Ask VS Code for the lenses again (the page took the focus or came back into view) |
| page → host | `runLens { id }` | Run the command of a lens from the last `lenses` |
| page → host | `actionsFor { requestId, blockIndex, blocks }` | The object toolbar opened for this top-level block of a page holding `blocks` |
| page → host | `runAction { id }` | Apply a code action from an `actions` answer: its edit, then its command |
| page → host | `pickInclude { requestId, replace? }` | Show the include choices other extensions offer; with `replace: { blockIndex }`, for that expansion's directive (below) |
| page → host | `linkChoices { requestId, query, images? }` | Complete a link's field holding `query`; with `images`, an image's path (below) |
| page → host | `pickImage { requestId }` | **Insert → Image…**: VS Code's open dialog, images, in the document's folder (below) |
| page → host | `insertFiles { requestId, uris }` | Files dropped from VS Code's Explorer view, as uris, to be made relative to the document (below) |
| page → host | `saveImage { requestId, bytes, suggestedName }` | Write a copy of a bitmap (base64) beside the document: a pasted screenshot, an image dropped from the system (below) |
| page → host | `resolveImages { requestId, srcs }` | Where the page may load these images from (below) |
| page → host | `caret { baseVersion, position }` | Where the caret is in the text the host holds — 0-based line and UTF-16 character, `null` for none — 100 ms after the selection settles, behind the pending edit (below, *Source positions*) |
| page → host | `mapped { id, baseVersion, toSource, toPage }` | The answer to `map`, one entry per position asked (`null` for none), behind the pending edit (below) |
| page → host | `complete { requestId, baseVersion, position, triggerCharacter? }` | Ask the completion providers at the caret: a non-word character was typed, or `Ctrl+Space` (none); behind the pending edit |
| page → host | `applyCompletion { requestId, index, baseVersion, position }` | Accept item `index`: the host applies its edit to the source and posts the document |
| page → host | `quickFixesFor { requestId, baseVersion, range }` | The quick fixes for a diagnostic the card shows |
| page → host | `hover { requestId, baseVersion, position }` | Ask the hover providers where the pointer rested |
| page → host | `runHoverCommand { id }` | Run a command link of the last `hoverResult` |
| page → host | `showHoverInEditor { requestId }` | **Show more**: VS Code's hover in the text editor, at that hover's position |
| page → host | `showProblems` | The toolbar's count was clicked: the Problems view |

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

**The exception: a read model** (Daniel, 2026-09-28, from the acceptance test). In an
`injected_block` whose mark's kind is `atom` — Req Explorer's summary table — a plain
click on a link opens it too, through the same `openLink` (a relative href resolved on the
host, a `#fragment` scrolled to); `Ctrl+click` does the same. The Ctrl+click rule exists so
a click in text can place the caret; a read model has no text anybody edits here, and a
list of links whose click does not follow the link reads as broken. `followLinksIn` takes
the predicate (`plainFollows`), evaluated per event against the node the view shows now;
an include expansion (mark kind `expansion`) is a snippet's text and keeps the rule, as do
raw blocks and the rest of the page. A press on such a link is prevented, so it does not
select the table.

**A link lands on the element its fragment names** (Daniel, 2026-09-28: in the text
editor the built-in link handling lands on the heading; here the file opened at its
top). `openAt` in `host/session.ts` resolves the fragment against the target file's text
before opening it (`fragmentLine`, `host/links.ts`), as the browser finds it in the
preview: the first heading in document order that carries the fragment — as the one id it
has by `headingIds` (`src/syntax/headingSlug.ts`: its explicit `{#id}`, else its slug, the
slug counted either way), or as the slug a heading with a `{#id}` keeps as a second anchor;
else the first one of whose slugs equals it without case, as the built-in compares (a slug is
a plain heading's id, an explicit id that is the heading's own slug, `## Setup {#setup}`, or
a second anchor; any other explicit id is compared as written) — further than the browser, which finds no element for `#Setup`, so the editor lands where the preview
lands nowhere; else a line fragment (`L12`, `L12,5`). A heading without a source line that is
the first to carry the fragment names no line (`null`), never a later heading. See *Explicit
heading ids* below. The slug is the built-in's, read from where it is true: no public
command of `vscode.markdown-language-features` opens a document at a fragment for another
extension (its `openDocumentLink` is internal), so its rule is ported — trimmed, lower-cased,
`githubSlugReplaceRegex` removed, each white-space character a hyphen, a repeated slug
`-1`, `-2`, … — and the regex is generated from the language server's bundle into
`src/syntax/githubSlugRegex.ts` (the rule itself is `src/syntax/headingSlug.ts`, which the preview's table of contents
links with too). It is github-slugger's table, a snapshot of one Unicode version
(it strips `²` and letters newer than that version), so no `\p{…}` property escape
reproduces it; `host.test.ts` compares it with the regex the test host's VS Code ships, in
the language server's bundle and in the preview's (`extension.js`), and fails when they part. Headings are read with the editor's engine, so `markdown-it-attrs`
has read a `{#id}` (kept under the token's `meta`, `explicitHeadingId`) and taken it out of
the slugged text.

The file then opens with `vscode.open` and `{ selection }`, in whichever editor VS Code
picks for it. In a text editor the line is also revealed `AtTop`. In the Visual Editor
(the active tab is its custom editor for that uri) the file's session is sent the reveal —
at once when its page has the document, else right after the first `document`; sessions are
kept by uri for this, and a reveal for a page whose session does not exist yet waits for it.
A link to the document itself opens nothing and reveals in its own page: the page posts
every fragment it follows, its own document's too, as `openLink`, since its DOM carries only
the headings' explicit ids and the first heading the browser finds may be one that carries a
slug (`# Title` before `## Other {#title}`). It flushes its pending edit first, and the host
resolves the link in its queue, behind that edit, so a fragment is looked up in the text the
page holds (a heading pasted a moment before); the opening itself is started there, not
waited for. A fragment another file does not have opens it at the top and logs an `[INFO]`
line: the link may be older than the heading it named. A heading there that carries it but
has no source line opens the file at the top unlogged, since its preview has the element; a
fragment of this document that names no heading and no element its render carries is
logged too. The page (`revealAnchor` in `webview/main.ts`) takes the top-level block the
host's line starts in — found by bisection over `lineAt`, since block start lines only grow
— so the slug rule lives only on the host; it puts the caret at the block's start and
scrolls it to the top, where `scroll-margin-top` keeps it clear of the formatting row fixed
at the top. The page knows the lines of top-level blocks only, so a heading nested in a
blockquote, an admonition or a `:::` container names its block; the host therefore sends
the heading's explicit id as `anchor`, and the page brings the element with that id inside
the block into view, the caret in it when the block is editable (a rendered block is one
atom and keeps its selection). A nested heading without an explicit id lands on its block's
start. Without a line — a fragment no heading carries, such as a footnote's — the page
scrolls to its element with that id, if there is one.

**Explicit heading ids** (Daniel, 2026-10-01: Req Explorer's `{#fr-1}` anchors landed
nowhere outside the Visual Editor). VS Code's engine installs its heading rule after every
extension's `extendMarkdownIt`, wrapping the rule it finds: it slugs the heading
(`env.slugifier.add`, else a stateless slugifier), `attrSet('id', slug)` over the id
`markdown-it-attrs` put there, then calls the wrapped rule. So `## FR-1: Name {#fr-1}` was
`id="fr-1-name"` in the preview, `markdown.api.render` and the exports. `MarkdownItAttrs`
now keeps a heading's id under `meta.mepExplicitId` (a string, written into the `meta`
object already there: the token stream stays JSON for the language server, and a plugin
holding that object keeps its data) in a core rule after `curly_attributes`, and installs
the `heading_open` rule VS Code's wraps. That rule sets the id back and keeps the slug
VS Code set as an empty `<a id="fr-1-name"></a>` at the start of the heading's content, so a
link written to the slug still lands. VS Code's preview follows a fragment from another
document only to an element of its source map (`.code-line`), so the anchor carries the
heading's `data-line` and the `code-line` class. That puts the anchor into the preview's
scroll sync (VS Code 1.140's `media/index.js`). Editor → preview and the active-line marker
take the last element at or before a line, so a line between the heading and the next block
marks the anchor (a bar one text line high) and a fractional line inside the heading scrolls
to the heading's top. Preview → editor skips the anchor, which has no size, and measures the
heading only down to it (one pixel): with a block after the heading it interpolates to that
block as before; with none it divides by that pixel and runs past the document's end. So
the anchor joins the source map only when a source-mapped block follows the heading; a last
heading's anchor is a plain `<a id>`, which a link inside the preview finds and a link from
another document's preview does not. No second anchor is written when some heading's explicit id
is that slug (`## Setup {#install}`, `## Configuration {#setup}`: `#setup` is the author's),
nor when the id VS Code set is not the slug `headingIds` counts (another rule's id, or a
render without `env.slugifier`, which slugs repeats its own way). The heading has taken its
slug from the builder, so the repeats after it are counted as before. One function states the rule for every surface
that names a heading — `headingIds`: the explicit id, else the slug, the slug counted for
every `heading_open`, and each heading's second anchor — and the table of contents (which
escapes the id into its `href`), the second anchors, `headingAnchors`, the link completion
(which offers an id once, for the first heading that carries it) and `fragmentLine` read it.

An explicit id is not checked against the other headings' slugs: `## Setup {#setup-1}`,
`## Setup`, `## Setup` are `setup-1`, `setup-1`, `setup-2`. Nothing is renamed — the author's
id is the contract — and the first element in document order is the one a fragment names, in
the browser and, by `fragmentLine`, in the Visual Editor.

VS Code's Markdown language server slugs the tokens it receives on its own and reads no
explicit id. Its completion offers `#fr-1-name`, and its Go to Definition follows it; both
now land on the second anchor. With `markdown.validate.enabled` it reports `#fr-1` as a
missing heading: a false report MEP cannot take back, since it does not own that server.

Two limits lie outside what MEP's rules can see. A core rule of another plugin that sets a
heading's id before `curly_attributes` is read as the author's `{#id}`. A `heading_open` rule
another extension installs after MEP runs between VS Code's and MEP's, and reads the slug
as the heading's id.

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
  `markdownExtended.editor.wrapColumn`. A seam a transaction made new — the follower's
  `gap` is `null`, or either side is written by rule — is read back in `serializeLayout`
  by the page's attrs engine (`seamHolds`, the engine `readUnit` reads with) on the pair it
  wrote, and holds when no top-level token's `map` crosses the follower's first line;
  where it does not, the separator is the first of one blank line, two blank lines, or —
  for a list after a list of its type — the follower with the other bullet or delimiter
  that the parser reads as two blocks. Two lists of one marker are one list at any number
  of blank lines, and two pipe tables one blank line apart are one table. A seam the file
  holds is never read, no attribute changes by the answer, and `positions.ts` and
  `lineAt` read the same layout. Known limit: where no rung holds (an indented code block
  under a list), the seam is written as before and the file reads the two as one.
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
  how the glyph looks but not the row's geometry. The height is the glyph's *border box*,
  and the button clips at its own edge: what a stylesheet draws around the text — a note
  reference's underline (a border), a code chip's padding and background, a key's frame —
  is drawn whole. Held by its content box, such a glyph stood taller than the button and
  was cut, and whether a 1.5px underline survived depended on the sub-pixel offset the bar
  stood at: the same bubble showed a user's note style above one line and not above the
  next (2026-09-30). The bubble carries the same five, the
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

**The chrome is the workbench's, and every colour a workbench variable** (Daniel,
2026-09-30, from a sketch). The row used to be a floating card with greys, a radius and a
shadow of its own inside the document's margin: the vocabulary of a web widget, read as
content the page owns rather than a control the editor owns. Now each surface is drawn as
the workbench draws its counterpart, and reads its colours from the `--vscode-*` variables
every webview receives, each with a fallback after it:

- **The row** is a chrome row under the tabs: `position: fixed` at the editor's top, full
  width — the page's padding does not inset it; `.mep-editor` keeps its height and an 8px
  gap free, so a document that begins with a table does not sit against its edge —
  26px and a 1px edge, `editorGroupHeader-tabsBackground` with the tabs' border
  (`editorGroupHeader-tabsBorder`, else `-border`, else `widget-border`), no radius, no
  shadow; the workbench font at its size less one; 22px controls with
  `toolbar-hoverBackground` (and `toolbar-hoverOutline`, High Contrast's) on hover,
  `toolbar-activeBackground` on a face whose menu is open, `focusBorder` for the keyboard's
  focus; separators in `menu-separatorBackground`, because the tabs' border is the tabs'
  own colour in both Modern themes and a separator in it would not be seen. A dropdown's
  affordance is the codicon `chevron-down` (`chevronNode` in `lenses.ts`, the one element
  for the row's faces, a submenu's `chevron-right` and an object bar's set-verbs), dim in
  `descriptionForeground`, right after the label (the block-type face keeps the longest
  type's width after it, so nothing after it moves). A narrow row scrolls sideways with no
  scrollbar — one would be laid out inside its 26px and clip the controls — by the wheel
  (`toolbar.ts` turns a vertical wheel sideways) and by the focus.
- **A menu** — the row's four, a submenu, the table bar's Row, Column and Align — is the
  context menu: `menu-background`, `-foreground`, `-border`, the entry under the pointer or
  the focus in `menu-selectionBackground` / `-Foreground` (outlined in
  `menu-selectionBorder` in High Contrast, which sets no selection background), 5px
  corners and `widget-shadow`. The sample column and the syntax column stay. In a menu
  that holds the focus (opened from the keyboard, or a set-verb's), the entry under the
  pointer takes it (`followPointer`), as in the workbench's menus: the two were drawn
  alike, and `Enter` ran the entry the reader was not looking at.
- **An object bar and the bubble** are editor widgets: `editorWidget-background`,
  `-foreground`, `-border`, `widget-shadow`, the row's 22px controls — a verb is a toolbar
  control, no surface at rest — and the inline field in `input-*`. The preview card keeps
  the document's ground inside an editor widget's frame, since what it shows is the
  document's rendering.

So a light, dark or High Contrast theme needs no rule of its own — provided a variable some
theme leaves unset falls back to no colour: High Contrast has no `toolbar-hoverBackground`,
`toolbar-activeBackground`, `inputOption-activeBackground` or `menu-selectionBackground`, and
a grey fallback there painted a surface where VS Code draws only the outline
(`toolbar-hoverOutline`, `inputOption-activeBorder`, `menu-selectionBorder`), so their
fallback is `transparent`. `editorCss.test.ts` holds `editor.css` to it: in a colour
declaration, no colour and no word but `transparent`, `currentColor`, `inherit` and the
shorthands' keywords outside a `var()`; a fallback is a colour; the unset ones fall back to
`transparent` (a mask's alpha gradient aside) — the samples are not styled there at all. The page tests apply the
variables VS Code supplies for Light Modern, Dark Modern and Dark High Contrast
(`test/unit/editor/themes.ts`, taken from the theme files and the colour registry's
defaults), and `chrome.e2e.test.ts` checks the row, a menu, the bars and the bubble in them.

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
  attribute span (both above, "Attributes, containers and admonitions"), `insert-table` a
  pipe table (above, "Tables"). `wrap-source` and `insert-source` are for what the core does
  not edit — the footnote and the other block constructs (below).
- **`toolbar.ts`** — the DOM, as a ProseMirror plugin view, so it follows every state:
  active and disabled states per action, the block-type face (the current type's name,
  locked with the reason), the menus and their keyboard (arrows, `→` into the submenu,
  `Enter`, `Esc`), the card, the bubble (placed from `coordsAtPos` inside `.mep-editor`,
  above the selection where that covers no content and is clear of the fixed row, else
  beside the block — just right of its box, on the selection's line, where the block is
  narrower than the column (a table): close to what it acts on, since the mapping between a
  control and its object weakens with distance — else below it where that is free, else at the
  column's right edge on its line, else below — never over the row above, which is read
  while choosing; "covers content" is `firstFree` in `webview/clearance.ts`, the one answer
  the object toolbar asks too).

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
| `table` | a pipe table the caret is in, or whose cells are selected across | the node |
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
an admonition, a table, a block with attributes and a heading too, which hold the text being typed and whose bar
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

**Where it sits** (`place`). *A block's bar covers no text where it can help it, and never moves
layout* (Daniel, 2026-09-29, after the table screenshots showed a bar over the paragraph above its
table; 2026-09-30, after a full-width table's bar made the layout jump). For every block-placed
object — a table, a container, an admonition, a heading, a block with attributes, a source
block, injected content, the front matter — `placeBlock` takes the first of these places that
holds no text: beside the block's first line, outside it, top-aligned with it, where the block
ends short of the column's right edge (a table, a short heading; a heading or a block with
attributes is measured by its text, whose lines in the bar's band must all end before it, a
block that draws a box by its box); above the block, right-aligned to the column; inside the
block's own box at its top right (a source block, a container, an admonition whose first line
is short); below it, right-aligned. Where none is free, the bar goes above the block,
right-aligned to the column, regardless — over whatever stands there, usually the empty tail of
the line above, as a heading's bar always stood. It is never given room in the document: an
earlier version made a widget of the bar's height before the block and scrolled to compensate,
and the block jumped down under the reader every time its bar appeared — the layout moving is
worse than a bar over the end of a line, which the bar leaves again with the caret. A bar is
floating chrome and nothing else; the page test holds the block's top, the caret's line and the
scroll to where they were before the bar showed. The last resort must also be seen: where
above the block is under the formatting row (the block's top scrolled up to it), it could be
neither seen nor clicked, so the bar goes below the block, and where that is past the window's
bottom too, at the row's edge (`lastResortY`) — a position, never a layout change. **One ladder, one notion of free**
(`firstFree` in `webview/clearance.ts`): every bar — an object's, a block's, the selection
bubble, the toolbar's field bar — gives only its candidate places in order, and `firstFree`
refuses, the same way for all, a place under the formatting row (`rowCeiling`) or past the window's bottom, over
the selection bubble (for any bar but the bubble) or an open language card (a hover, a
diagnostic, the completion list — read, not a bar), and over content: the page's text probed
with `posAtCoords` at points across the band — a floated note body is no part of its line —
and, wherever the probe lands, a cell of an editable table (an empty one too — the cell is the
table's content, drawn to be seen), an image, an atom, or another extension's lens row
(`OCCUPIED`); a place inside a rendered block probes that block's own text, images and cells.
The floating chrome is looked through while probing, by one class on the mount around the
whole search; bars are placed again on scroll and resize once per animation frame. Three
ladders with three notions of free had drifted apart (a bar pinned over its block under the
row, a place blind to images, a bubble over a lens row), which is why it is one now.
**An inline object's bar follows the same rule with the
same helper**: above the object's first line at its start where that holds no content, else
beside that line — just right of its textblock's text on it — else below its last line; the
start is found from its element's own line boxes (`getClientRects` of the note's
`span.sn-ref` — a body floated into the margin is no line box of the reference, so the bar keeps
to the reference) or, for a link, from `coordsAtPos` of its range. Above and below are never
the caret's line, and an inline bar keeps out of the selection bubble as out of text. **No
block's bar shows while the bubble does** (`selectionBubbleShown` from `toolbar.ts`): one thing
at a time. The bar is `position: absolute` inside `.mep-editor`, as the bubble is, so it
scrolls with the text; it is placed again on scroll and resize.

*Left for later:* a native table's bar shows for the caret and sits beside the table, a raw
(multimd) table's shows for the pointer and sits at the column's right edge above it — one kind
of thing, two triggers and two places.

**The verbs** say what remains (*Remove note, keep text*), and are each one transaction in
`objects.ts` (or `notes.ts`), one history event:

- note — *Remove note, keep text* (`unwrapNote`); *Convert to marginal note* / *Convert to
  sidenote*, *Move to right* / *Move to left* (`convertNoteTransaction`: the counterpart
  node built from the same reference, body content and marks; the two have the same
  structure, so the selection is put back at the same positions); *Edit source*. A
  conversion whose result the serializer could not write back (`noteRefusal` — code in a
  left sidebar holding `@`, moved right) is disabled with the reason, as the notes
  plugin's filter would refuse it anyway;
- link — *Open* (`openLink`, the Ctrl+click path), *Edit link…* (the address in the field,
  prefilled, completing as `Ctrl+K`'s does — below, *Links and images*; the mark replaced
  over its run with the new `href`, the title kept, `markup` cleared: a bare URL's text is
  the old address, which the bare form would write as the link), *Remove link* (the mark
  removed, the text kept);
- image — *Edit image…* (two fields in turn, the alt text and then the path, which completes
  with image files; `setNodeMarkup`, the title kept), *Open file* (`openLink` with the
  `src`, resolved on the host as a followed link is), *Remove image*;
- span — *Edit attributes* (the mark replaced over its run with the new literal),
  *Remove attributes, keep text*;
- container — *Change name/info* (first word the name, the rest the info, verbatim; a
  trailing `{…}` refused, since markdown-it-attrs would take it off the info),
  *Attributes…* (refused, with the reason: the container's renderer drops a literal),
  *Remove container, keep content* (`unwrapTransaction`: the blocks lifted, the caret kept);
- admonition — *Change type* (the inline choice, a `<select>` of `ADMONITION_TYPES`),
  *Edit title* (empty: no title bar), *Attributes…* (refused: the plugin gives a literal on
  the `!!!` line to the title bar), *Remove admonition, keep content*; both changes clear
  `header`;
- block with attributes — *Attributes…* (the literal replaced in place, its placement
  kept; `{}` or empty removes it; a heading's anchor follows the literal's id), the field
  the Formatting menu's entry opens (above, *Attributes…*);
- heading that is no requirement heading — *Attributes…*, then other extensions' lenses and
  actions, the bar shown only when there are some or the heading has a literal; a
  requirement heading has no verb of its own, only theirs;
- table — `Row`, `Column`, `Align`, *Attributes…*, *Edit source*, *Delete table* (above, "Tables"): a
  verb may be a **set-verb**, a menu of related actions that opens under it (`Verb.menu`),
  in the formatting toolbar's menu chrome, keyboard-navigable, the current value of a
  choice marked;
- source block — *Edit source* (`editRawSourceAt`), *Show in text editor*, *Delete block*;
  labelled *Source · multimd table* or *Source · table* when it is a table the editor
  leaves as source;
- expansion — *Open snippet* (only with `mark.path`), *Show in text editor*, *Delete
  directive* (the node deleted, and with it the one line it writes);
- badge, other injected content — the label alone; the front matter no bar of its own (its verbs are the
  properties panel's header), only other extensions' actions when there are some;
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
label, which then names the value too (*Link · Address*, *Image · Alt text* —
`fieldHeading`): a prefilled field shows no placeholder. *Edit link…* and *Edit image…* set
the mark's or the node's attributes: nothing needs parsing.

**Steps and completion.** A field's commit may name a next step (`FieldStep`): the bar shows
that field in the same place, and redraws only once the last one is in — *Edit image…* asks
for the alt text, then the path; a new link at a caret for its text, then its address. A field
given a `complete` function (`Completer`) is a combobox: it asks as it opens and 80 ms after
each change, and shows the answer to its latest question only, in a list under it
(`.mep-completions`, the suggest widget's colours). `↓`/`↑` choose, `Tab` or a click takes the
choice into the field and asks again (a file, then its headings once `#` follows), `Enter` on
a chosen entry takes it and commits, `Enter` with none chosen commits what is typed — and
typing clears the choice at once, so an `Enter` before the next answer commits the typed text,
not a choice made for the text before — `Esc` closes the list before it cancels the field. The
list ends in one dim line of its keys (`COMPLETION_KEYS`: *↹ complete · ↵ set · Esc close*),
since nothing else says that `Tab` goes on and `Enter` sets. A press on an entry is prevented,
so the field keeps the focus.

**What a field acts on stays drawn** (`webview/pendingRange.ts`, Daniel, 2026-09-29, from the
screenshots). While a field has the focus the text does not, and the browser draws no
selection there: the words a link was about to be made of vanished exactly while the person
decided what to type. So from the moment a field opens until it closes, its range is a
`Decoration.inline` with the class `mep-pending-range`, in `--vscode-editor-selectionBackground`
(an image an outline), mapped through every transaction meanwhile — the host's re-sync
included. The toolbar's fields draw the selection they were opened on (**Span with class**,
**Link…**, `Ctrl+K`, an inserted image's alt text) or the link `Ctrl+K` edits; the object
toolbar's draw their object when it is inline (`PENDING_OBJECTS`: a link, a span, a note, an
image) — a block's field is beside its block. A bar hidden with its field open clears the
drawing after the update that hid it. A selected image carries a 2px outline in the focus
colour, which takes no room, so two images side by side say which one a bar is about.

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
provider — and code actions become object verbs the same way. Hovers, completions and
diagnostics came later the same way (*Completion, diagnostics and hover*, below).

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
in titles are drawn as icons: the page links `@vscode/codicons`' stylesheet (`html.ts`; the
build copies `codicon.css` and `codicon.ttf` into `dist/codicons`, which the package keeps
where it leaves `node_modules` out), and `lensLabelNodes` turns each reference into a
`<span class="codicon codicon-name">` beside the text, ignoring a `~spin` modifier, not
checking the name (an unknown one is an empty icon slot) and keeping an escaped `\$(name)` as text. Wherever a title is drawn as elements — a lens row, an object toolbar's
verb — the verb keeps the provider's title and the nodes are made at draw time;
tooltips, accessible names and the `<option>`s of the **Actions** choice, which holds no
elements, take `lensLabel`'s plain text.

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
`command.arguments`**, `{ reqExplorer: { surface, artifact, relation?, direction? } }`
(`LensHint`): `surface` one of `status`, `priority`, `links`, `action`; `artifact` the
readable id, as the injection marks carry it; `relation` the relation key of a `links` lens;
`direction` its side, `out` or `in` — a symmetric relation (`conflicts-with`) has a row for
each side under one key, and only the side tells them apart. `lensHintOf` (`host/lenses.ts`)
checks the shape — an unknown surface, a missing artifact, a hint that is not the last
argument make a foreign lens; an unknown direction is left out — and `LensItem` carries the
fields to the page. The argument stays in the command: `runLens` runs the provider's command exactly as
it was given. On Req Explorer's side, the summary table (`injected_block`, mark
`{ kind: 'atom', artifact }`) marks its rows `tr[data-req-field="<field>"]` and
`tr[data-req-relation="<relation key>"]` with `data-req-direction="out"|"in"`, and the
badge is the `inline_atom` with the same mark inside the heading. A lens without `direction`
(a Req Explorer older than it) takes the relation's first row. The standing row also carries
`data-req-standing="authored"|"derived"`: that is the **agreed contract** (workshop 2026-09-29,
NEU-UXD-009), arriving with Req Explorer 1.12.0; no earlier build emits it, and every earlier build
exercises the `tr[data-req-field="status"]` path.

*Resolution by artifact* (`place` in `webview/lenses.ts`), against the document the page
holds when the `lenses` message arrives. The artifact's heading (the top-level heading
holding an `inline_atom` whose mark names it) and summary table (the top-level
`injected_block` whose mark names it) are looked for **beside the lens first** — the heading
the lens stands on and the table right after it — and only when the lens's block is neither
in the whole document, the first of each. A readable id is not unique: two headings can carry
the same one (a collision the corpus's checks report), and each heading's lenses belong to
its own badge and table. For every row the host sent:

- a row with no hinted lens stays a row, on its block;
- in a row with a hinted lens, each lens is placed on its table, when the table's HTML
  (parsed inert, in a `template`) has the row: `status` on the standing row
  `tr[data-req-standing]` (any field states it — a change's derived Stage, a release's lifecycle; an `authored` row's lens sets, a `derived` one's goes — underlined, no dropdown; `tr[data-req-field="status"]`
  when no row carries the attribute, an older Req Explorer), `priority` on `tr[data-req-field="priority"]`, `links` on the `tr[data-req-relation]` of its
  key — and of that `data-req-direction`, when the lens names one. **The status row comes
  first**: Req Explorer shows the status in the table and draws a badge beside the heading
  only where no table repeats it (2026-09-28), so `status` goes to the artifact's badge only
  when the table has no status row. A heading is the artifact's when it carries that badge
  or its `reqPrefix` names the id. A lens so placed without a
  command is dropped, since the element already shows what it says. **An element takes one
  lens**: a second for the same badge or row (two lenses of a relation from a Req Explorer
  that names no side) would be marked on an element that shows only the first, and could
  never be reached; it becomes a verb. Everything else — an `action`, a lens whose element is not there (no badge on
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
the badge's node-view element (found by the artifact inside its heading node) and, for a
relation row, **its label cell** — the `th`, the row itself only where it has none — or,
for a status or priority row, its value (found in the `injected_block`'s node-view
element) — get `mep-lens-target`, `data-lens`, the lens
title — the verb — as `title`, `tabindex=0`, and the badge `role=button` (a cell keeps its
table role). The lens is on the label only because the value cell beside it holds links to
the relation's targets, which a plain click opens (above): the label runs the group's lens
(the picker), the targets are plain links; an element whose lens went is given back its own title. A redrawn rendering
(an `InjectedBlockView` resets its HTML on update) is marked again on the same pass. Its
listeners are on the editor's element in the capture phase, before ProseMirror and before
a rendering's own link handling: a plain click (not with Ctrl/Cmd, not on a `<summary>`,
not on a link) runs the lens and selects nothing, `mousedown` is prevented so no caret
moves, and `Enter` or `Space` on the focused element runs it. `editor.css` draws nothing at
rest. **Two verbs, two signifiers** (Daniel, 2026-09-28: an underline says "link", not
"set"): the element carries `data-lens-kind`. A `set` lens — an authored standing or `priority`, a verb
that changes the artifact — is marked on the value it sets (the status chip in the status
row, else the value cell; the badge where one is drawn) and on hover or keyboard focus is
drawn as a dropdown: a subtle rounded button surface (`--vscode-button-secondaryBackground`,
as a ring around a chip so the chip keeps its colour, as the background of a plain cell) and
a `▾` after the value, no underline. A `go` lens — a relation's label, which opens its
picker — is underlined with its descendants (a badge drawn as an inline block and a row's
cells take no decoration from their parent), as the target links beside it are. Both show a
pointer, and `:focus-visible` outlines them. A `<summary>` inside a row
(a collapsed list's "12 tests") is not the lens's — a click on it opens the list — so it
promises nothing: while the pointer is on it the row shows no underline and no pointer
(`:has(summary:hover)`), on the rest of the row only the cells without it and the list it
opens are underlined (a decoration given to the row, the cell or the `<details>` would reach
the summary, and no descendant can take it back), and an empty `title` on it keeps the
row's tooltip off. The preview's stylesheets are not touched.

*Verbs in the toolbar.* `ObjectToolbarHost.lensesAt(pos)` answers `lensVerbsAt` for the
top-level block; `present` draws them after the object's own verbs and before the code
actions, each group after a separator, a lens without a command refused. More than
`LENS_VERBS_INLINE` (4) lens verbs: the first three stay and the rest are one **Actions**
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
empty transaction, and the toolbar redraws with the verbs. A requirement heading is an object for this
and for its lens verbs alone: its presentation has no verbs of its own, and the selection's
bar is hidden while it has none. Any other heading has one, *Attributes…*, which alone
does not make a bar either: it joins one the lenses, the actions or a literal make. Inline objects carry no actions yet: the host knew no range for a note or a
link, and computing one beside the parse would have been a second answer to where the page's text is in the
file. *Source positions* (below) is now the one answer, and what they would be built on.

### Completion, diagnostics and hover

The decision (Daniel, 2026-09-29, sketches 5–7): the completion, diagnostics and hover
providers other extensions register for Markdown reach the page as lenses and code actions
do — **VS Code is asked, no API between the extensions** — and every place they cross
between the page and the text goes through the page-owned position map (*Source
positions*, below). The host's half is `LanguageFeatures` (`host/language.ts`), a listener
on the page's messages beside the session's own, as links and images are, with
`CompletionController` (`host/completion.ts`), `HoverController` (`host/hover.ts`) and
`DiagnosticsController` (`host/diagnostics.ts`); the quick fixes are the code-action
registry's (`CodeActionController.quickFixes`). The page's half is `webview/completion.ts`,
`webview/diagnostics.ts`, `webview/hover.ts` and the card, `webview/languageCard.ts`.
`SessionHost.executeCommand` and `diagnostics`/`onDidChangeDiagnostics` default to VS
Code's, so a test answers for VS Code.

**One rule for every question.** A request names the version of the document the page
shows (`baseVersion`) and is sent after the page's pending edit, as the caret report is
(`flush` first); the host answers it from the session's queue, behind that edit, and only
while `baseVersion` is the document it last posted and the document holds the page's text
— anything else is answered with nothing. The providers are not awaited in the queue, and
their answer is checked **after** the await: a document that changed while they computed
gets an empty answer. The page takes an answer only for its latest question.

**Completion** (sketch 5). A provider's trigger characters are in its registration, and no
API hands them to another extension, so the page asks with every **non-word character**
typed (`beforeinput`, so a note's own input handler is covered) — 80 ms after it
(`COMPLETION_ASK_DELAY_MS`), one question in flight, a question asked meanwhile waiting
behind it and the older answer then dropped — and on `Ctrl+Space`, kept from VS Code, with
none: `complete { requestId, baseVersion, position, triggerCharacter? }`, the position being
`caretOf` the selection (an approximate caret asks nothing). The host calls
`vscode.executeCompletionItemProvider(uri, position, trigger, 20)` — VS Code calls every
provider with the trigger in its context; those that do not trigger on it answer nothing —
and answers `completions { requestId, version, items, incomplete }`, the items in VS Code's
order for an empty word (`sortText`, else the label), capped at 100, each
`{ label, detail?, kind?, insertText, range?, sortText?, filterText? }`: the `inserting`
range (VS Code's default insert mode; an item without a range takes the word before the
position), a snippet as the text it inserts (`snippetText`: stops empty, placeholders their
defaults, a choice its first option). An empty answer closes the list. The list stands under
the caret, left-aligned with the items' range start (`anchor`, mapped through every
transaction in plugin state), and filters as the person types: the text between the anchor
and the caret, by prefix of `filterText`, else the label, ignoring case (`filterCompletions`);
a letter asks again only when the answer was `incomplete`. It is the link field's list
(`webview/completionList.ts`, one component for both): label, detail dimmed, eight rows before
it scrolls, the first chosen, one dim line of keys (`↹ ↵ accept · Esc close`); the keys are
`listKeyAction`'s, taken by a plugin placed before the editor's keymaps. The footer does not
name the provider: `executeCompletionItemProvider` hands items without the extension they
came from.

**Accepting applies the provider's edit to the source, not to the page.** The page posts
`applyCompletion { requestId, index, baseVersion, position }` (after its pending edit) and
writes nothing. The host kept the newest answer's items (an older question resolving later
does not replace them) with the text they were computed on; it applies an item only to that
text, or to one the page changed only by typing at its caret inside the item's range while
the list filtered — the text before the range and after its end as it was, the range then
running to the caret the page sent, as the text editor's replace range grows as you type.
The caret anchors it, not a common prefix and suffix of the two texts: a typed character
equal to the one after the range would put such a diff after the range. VS Code resolves
only the first 20 items of an answer; an item further down is asked for again at accept
time, resolving up to it, and found by its label and what it inserts, for its
`additionalTextEdits` and command. The item's range and its additional edits (one
overlapping the range refuses the item) go into one `WorkspaceEdit`, line breaks in the
document's own ending; then the session posts the document (`repost`, from inside the
queue) and answers `completionApplied { requestId, version, caret }` — the insertion's end,
or the snippet's `$0` — which the page, holding that document by then, maps back and puts the
caret at. The block comes back as another writer's change does, in place (`resync.ts`). An
item's command is started unless it works on a text editor (`editor.*`, re-triggering
suggest). A refused item answers `caret: null`, and the hint says the text changed.

**A known limit: a space at a paragraph's end.** The serializer drops trailing white space,
so a space typed last in a paragraph is not in the text the host holds, and the caret after
it maps only approximately: no question is asked until something follows it. Req Explorer's
space trigger answers mid-line only.

**Diagnostics** (sketch 6). The host reads `languages.getDiagnostics(uri)` — what the text
editor squiggles and the Problems view lists — when `onDidChangeDiagnostics` names the
document (150 ms, `DIAGNOSTICS_DELAY_MS`) and after every document it posts — **never after
an edit of the page's it applied**: the providers have not linted the new text yet, and the
ranges read then are the old text's, which would overwrite the page's marks (mapped
correctly through the edit) and make a squiggle jump. It sends `diagnostics { version,
items }`, each `{ range, severity, message, code?, source? }` in range order, only while the
page holds the text. `version` is the document the host last posted: the page's own edits
since do not change it. The page draws them only while it holds that text with no edit
waiting; ahead of the host it keeps its marks, mapped through its edits, until the providers
publish again.
`diagnosticMarks` maps each range with `pageRangeOf` — pure, and tested without a page: an
exact range is a squiggle (`Decoration.inline`, `mep-diag-<severity>`, a wavy underline in
`--vscode-editorError-foreground`, `…Warning…`, `…Info…`, a hint dotted); a range across
top-level blocks is split at them, an atom inside it (a table, any source block) marked
whole; an approximate range — inside a delimiter, on a blank line, in a source block — marks
its whole top-level block (`Decoration.node`, `mep-diag-block-<severity>`: a 3px bar in the
severity's colour at the block's left edge, drawn as a shadow in the gutter so it takes no
room — an outline around a whole table spoke louder than the problem), never nothing; an empty range is widened to the character after it (at
a textblock's end the one before), as the text editor draws one. Between messages the
decorations are mapped through every transaction. Each marked block carries one marker, of
its worst severity, `aria-label` its counts (*1 error, 2 warnings*): in a paragraph or a
heading a widget at its text's start, absolutely placed in the body's left padding on its
first line; in any other block a widget at the block's start on a line of no height —
inside a list item the text's left edge is the item's, and the marker would stand on the
bullet. The count is at the right end of the formatting row (`.mep-row-status`, the row's
slot for what the page says about the document as a whole): `$(error) 1 $(warning) 2`, via
`lensLabelNodes`, infos too, hints not (as VS Code's status bar). VS Code's own tab strip is
not reachable from a webview, so the toolbar's end is the place. It is a button and says so:
`title="Open Problems"`, a pointer, its numbers underlined on hover; a click posts
`showProblems`, and the host runs `workbench.actions.view.problems`.

**Hover and the card** (sketch 7). After the pointer rests `HOVER_DELAY_MS` (500 ms) on a
character of text (within 12 px of a character boundary; not a lens row, a marker, a bar),
the card shows the diagnostics drawn there at once — message with its severity's icon and
code, the source dimmed — and asks, after the pending edit, `quickFixesFor { requestId,
baseVersion, range }` for each (at most three) — the diagnostic's own range while the page's
document is the one the marks were placed on, else where its squiggle now is, read back
through the position map after the flush (a whole block's mark has no such place, and is not
asked about; the host runs
`vscode.executeCodeActionProvider(uri, range, 'quickfix', 50)`, keeps the quick fixes alone
— no source actions, no command acting on a text editor — in the code-action registry, and
answers `quickFixes`; the fixes follow one *Quick fix(es)* label line, each a link that runs
with `runAction`, behind the pending edit) and `hover { requestId, baseVersion, position }`. The host calls
`vscode.executeHoverProvider(uri, position)` and answers `hoverResult { requestId, html,
range? }`: **the host renders**, because the trust a command link needs is known only there
and the page parses only to check an edit. It renders with a plain markdown-it, not the preview's engine —
a hover is VS Code's Markdown, which the workbench renders, and the preview's plugins would
read `++…++` in it as a sidenote — with raw HTML only for a part that allows it
(`supportHtml`), `file:` links kept as links. Such a part's whole rendering is then sanitized
on the host (`host/hoverHtml.ts`) to the allowlist VS Code's own hover applies
(`renderMarkdown`'s tags and attributes): allowed tags rebuilt from their allowed attributes,
`href`/`src` only with `http`, `https`, `mailto`, `file` or a `data:` image, `script`,
`style`, `form`, `iframe` and the like dropped with their content, every `on*`, `style`,
`id` and `data-*` attribute dropped — so raw HTML cannot forge the `data-mep-command` or
`data-mep-action` a card link runs by. The link rule's own command links pass because it
marks them with a per-render nonce (`data-mep-nonce`), which raw HTML cannot know and which
never reaches the page. Images from `https:` stay, as VS Code's hover shows them. Each `MarkdownString` is one
`div.mep-hover-part` (`data-icons` for `supportThemeIcons`, whose `$(icon)`s the page then
draws with `lensLabelNodes`). A command link (`command:id?args`, the args
`JSON.parse(decodeURIComponent(query))`, a non-array the one argument) is kept only when the
part may run it (`commandLinkAllowed`: `isTrusted: true`, or `{ enabledCommands }` naming it;
false, absent or a plain `MarkedString` — none); a kept one is registered under an id and
carries it as `data-mep-command`, and `runHoverCommand { id }` runs the registered command
with its own arguments, queued behind the pending edit and not awaited. The registry is
replaced with the newest answer (an older question resolving later does not replace it), so
an id of an earlier one runs nothing. Every other `command:` link is its text alone. On the
page, as a second line, a `command:` target left in a hover loses it, and each kind of link
is taken only where the page puts it: `data-mep-command` in the hover section,
`data-mep-action` in a diagnostic's. The hover's range, when it has one, is what the card is about.

The card is one component with two contents, diagnostics first as in the text editor's
hover; one card at a time. It is placed under the range's first character (above it when
below has no room), in `.mep-editor` so it scrolls with the text, in the hover widget's
colours. It never scrolls: taller than 280 px it is clipped with a fade and **Show more**
(`showHoverInEditor { requestId }`: the text editor opens beside at the hover's position and
`editor.action.showHover` runs there). It closes when the pointer is neither on its range nor
on the card for 300 ms, on any key (`Esc` stops there), on scroll, on an edit under it, and
with every document from the host. Every link in it is the page's: a command link, a quick
fix, anything else followed as a Ctrl+clicked link is (`openLink`).

### Includes from other extensions

The editor showed an include as one atom and could open its snippet, but nobody could
insert one: the snippet ids and the directive's syntax belong to the extension that
resolves them. The decision (Daniel, 2026-09-28): **that extension exports the choices;
the editor asks and inserts what it is given.** There is no second implementation of the
directive here — not its syntax, not its ids, not a guess at which raw line is one.

**The provider contract.** An extension that contributes `markdown.markdownItPlugins` may
export, beside `extendMarkdownIt`:

```ts
listIncludeChoices(documentUri: vscode.Uri): Promise<IncludeChoice[]>
interface IncludeChoice { label: string; description?: string; detail?: string; insert: string }
```

`insert` is the complete line to put into the document; `label`, `description` and
`detail` are a QuickPick item's. Req Explorer is the first provider: a corpus's snippets by
id, with their first heading and path.

**Collection** (`host/includes.ts`). `collectIncludeProviders` reads the same list the
engine's extenders come from — `markdownItExtensions` in `host/engineHost.ts`, every
activated extension contributing a markdown-it plugin, this one and the built-in Markdown
extension aside — and keeps those whose exports have a `listIncludeChoices` function; an
extension offering includes is by construction the one whose plugin will expand the line.
A provider without the function is skipped silently (most plugins offer no includes). On
`pickInclude`, `IncludeController` asks every provider for the session's document at once;
one that throws, rejects or answers something that is not a list is logged and skipped, and
so is a choice without a label or whose `insert` is not one non-empty line (a terminator at
its end is dropped: the page writes the document's own). The choices are concatenated in
the providers' order, each provider's under a `QuickPickItemKind.Separator` with its display
name, and shown with `showQuickPick` (`matchOnDescription`, `matchOnDetail`, placeholder
*Include…*, or *Change snippet…* with `replace`). Nothing to offer is an information message
— *No extension offers includes for this document* — and an answer without a line. The
answer is `includeChosen { requestId, insert? }`, `insert` the chosen item's own, so the page
can only ever write a line a provider offered. The session takes `includeProviders()` and
`includePicker` from its `SessionHost`, the real collection and VS Code's UI by default: no
provider is installed under `--disable-extensions`, so the tests inject both.

**Ordering.** `pickInclude` runs in the session's queue like `actionsFor`: the page flushes
its pending edit before asking, and a provider that reads the document reads the page's
text. The pick is started there, not awaited — the person choosing would otherwise hold up
every edit behind it.

**Whether to offer it.** Each `document` carries `includes`, whether any provider exists
(asked before the text is read, so nothing is awaited between reading the text and posting
its parse). **Insert → Include…** (`apply: { kind: 'insert-include' }`, the variant of
`insert-source` whose line comes from the host) and an expansion's **Change snippet…** are
disabled without one, the reason in their tooltips.

**Writing the line.** The page remembers what each request is for: nothing (a new include)
or the expansion's node (**Change snippet…**). A new line goes in as a `raw_block` at
`insertionPoint` of the selection as it is when the answer comes (the QuickPick has the
focus meanwhile; a re-sync maps the selection), written exactly as given
(`insertLineTransaction` substitutes nothing, unlike a template's footnote label). A
replacement sets the expansion's `src` to the line, keeping its terminator and gap, and its
old rendering until the new parse arrives (`changeIncludeTransaction`); the node is found by
identity, so a block changed meanwhile is not replaced, and the page says so. Either edit is
sent with `reparse`: only the host's parser, which has the provider's plugin, turns the line
into the expansion with its mark, its rendering and **Open snippet**. A dismissed pick
writes nothing.

**Not offered: Change snippet… on a raw block.** A raw block that is exactly one directive
line the provider would produce — an include whose snippet the plugin could not resolve at
all — would deserve the verb too, but telling it from any other one-line raw block takes
the directive's syntax, which is the provider's. It is left out; a `missing` expansion,
which the plugin does mark, has it.

### Links and images

A link could be followed and its address changed, an image's source typed in, but nothing
made either, and an image with a relative path showed nothing at all. The decisions (Daniel,
2026-09-29): links and images are made where the text is, in the inline field; **the host
knows the files, the page asks** — completion, the open dialog, a relative path, a pasted
bitmap's file, the address an image loads from are all answered by the host, with the rule a
followed link already uses (`resolveLinkTarget`), so an inserted link, a shown image and a
Ctrl+click cannot read one path three ways. The host's half is `LinksAndImages`
(`host/linksImages.ts`), a listener on the page's messages beside the session's own, which
hands it the session's port and queue. What both halves read of a destination — whether it
has a scheme (`schemeOf`: a drive letter is none), its escapes decoded, a file's stem — is
`src/editor/paths.ts`, pure, so the page and the host load the same lines.

**Making a link** (`askLink` in `toolbar/toolbar.ts`, `insertLinkTransaction` in
`objects.ts`). `Ctrl+K` (`Cmd+K`) and **Insert → Link…** (`apply: { kind: 'insert-link' }`) do
the same: over selected text, the field asks for the address and the text is linked as it is;
at a caret, it asks for the text first and then the address, and an empty text is the address
itself; in a link already, it is that link's *Edit link…*. The key is kept from VS Code — its
`Ctrl+K` starts a chord — by the toolbar plugin's `handleKeyDown`, which stops it on the
editor's element. A link needs a caret or a selection within one textblock that is not code
(`insertLockReason` — one rule for a link, an image and a drop, said as `LINK_LOCK`,
`IMAGE_LOCK` or `DROP_LOCK` by the gesture that asked); a note around it must be able to
hold it (`noteRefusal`). The field sits in a bar of the object toolbar's kind under the
selection, as **Span with class**'s does (`openFieldBar`), placed before the field takes the
focus so the focus does not scroll the page to where the bar was built.

**Completion** (`host/linkChoices.ts`, `LinkChoiceController`). The address field asks the
host with `linkChoices { requestId, query }`, in the session's queue behind the page's pending
edit — the page flushes before a query holding `#`, so a heading typed a moment ago is among
the anchors — and not waited for there. The answer is read from where each fact is true:

- `#…` — the current document's headings, read with the editor's engine (`headingAnchors`):
  an explicit `{#id}` as written, else the heading's GitHub slug, the rule a followed link lands
  by; filtered by the anchor or the heading's text, which the list shows beside it;
- `path#…` — that file's headings, when the path (resolved by `resolveLinkTarget`) names a
  Markdown file. Once `#` is typed the path is fixed, so a row's label is `#anchor` alone, the
  heading's text beside it; the value it writes is still the whole `path#anchor`;
- a scheme (`https:`, `mailto:`) — nothing;
- anything else — the workspace's files (`findFiles('**/*')` with `files.exclude` and
  `search.exclude` as one exclude glob, `FILE_SCAN_CAP` = 5000; outside any workspace, the
  document's own folder), the document itself left out, each as its path relative to the
  document (`relativeDestination`: POSIX, `..` where needed, none across drives or file
  systems) whose text holds the query (percent escapes decoded): Markdown first, then a name
  starting with the query, a name holding it, a path holding it, then the nearer file. The file
  list is read once per 10 s, and what every query reads of a file — its encoded relative path,
  the path decoded and lower-cased, its name, its distance — is derived then, once per read
  (`candidateOf`), not per keystroke over thousands of files; every answer is capped at
  `LINK_CHOICES_CAP` = 50.

A value is written as a destination is (`encodeDestination`: `%`, white space, `#`, `?`,
parentheses and angle brackets percent-encoded — `a b.md` is `a%20b.md`), which markdown-it
reads back and `resolveLinkTarget` decodes to the file on disk. With `images`, image files only
(an image's *Edit image…* path).

**Inserting an image** (`pickImage`, `host/images.ts`). **Insert → Image…**
(`apply: { kind: 'insert-image' }`) posts `pickImage`; the host shows `showOpenDialog` in the
document's folder, one file, filtered to `IMAGE_EXTENSIONS`, and answers `filesChosen` with the
file as the page inserts it (`linkedFiles`: `src` relative and encoded, `alt` the file's name
without its extension). The page puts it at the selection as it is when the answer comes
(`insertFilesTransaction`), selects it, and asks for the alt text in the field, the name
prefilled and selected — `Esc` keeps it. A dismissed dialog answers with no file and writes
nothing.

**Dropping and pasting files** (`fileDropPlugin`, `webview/images.ts`). The Visual Editor
links what VS Code names and copies what it does not:

- **From the Explorer view** a drop names its files by VS Code's `resourceurls`, else the
  `file:` lines of a `text/uri-list` (`namedFiles`). The page puts the caret at the drop point
  and posts `insertFiles`; the host answers `filesChosen` — an image as an image, any other file
  as a link named by its file name, each by its path relative to the document. Nothing is
  copied. A web address in a uri list is not a file and stays the browser's.
- **From the system** (the OS file manager) a drop carries `File`s with their bytes and names
  and no path: a sandboxed webview has no `File.path` (Electron 32, VS Code 1.95 and later).
  An image among them is therefore a **copy**, posted as `saveImage` with its own name and
  written beside the document; any other file cannot be linked and is not inserted — the hint
  says *Drop a file from the Explorer view to link it.*
- **A pasted bitmap** — a screenshot, an image copied from a browser — is a copy too; a paste
  counts as one only while the clipboard holds no text, since an office program puts a picture
  of the copied text beside the text.

Before anything is asked of the host the page checks that something can go in at the place
(`insertLockReason` after the caret was put at the drop point): a drop onto code is refused as
*Drop onto text (not code) to insert an image there.*, a paste there with the caret wording,
and no file is written that could not be inserted. The host writes a copy (`savePastedImage`)
where VS Code's own `markdown.copyFiles.destination` says — the first glob the document
matches, matched as the built-in matches them (`/` anchored to each workspace folder, a glob
without `**` matched anywhere, `vscode.languages.match`), its value filled in as the built-in
fills it (`fillDestination`: `${documentBaseName}`, `${fileName}`, `${name/regex/replacement/}`,
a leading `/` the workspace folder, a trailing `/` the file's name) — else beside the document:
`images/<file name>` for a file with a name of its own, `images/<document stem>-<yyyymmdd-hhmmss>.<ext>`
for a screenshot (the browser calls a clipboard bitmap `image.png`, `isClipboardName`). A name
already taken gets `-1`, `-2`, … unless `markdown.copyFiles.overwriteBehavior` is `overwrite`.
Saves run one after another (`LinksAndImages.saves`): a free name is looked for before it is
written, and two at once would find the same one. The answer is `filesChosen` with the copy as
a `LinkedFile` — relative, encoded, its file's stem the alt text — and a failure is a warning
message and an answer with no file. The built-in's own paste and drop (a
`DocumentPasteEditProvider`) serve the text editor only — a custom editor's webview has no edit
to apply them to — so this repeats its choice of place and name, read from its settings.

**A relative image is shown** (`ImageSources`, `webview/images.ts`; `resolveImages` in
`host/linksImages.ts`). The webview cannot load a `file:` path, and a relative `src` resolves
against the page's own origin, so `images/x.png` showed nothing. The node keeps the `src` the
file holds — the serializer writes it, copy and paste carry it (the schema's `toDOM` is
unchanged) — and the page draws an image through a node view (`ImageView`) whose `<img>`
carries it in `data-mep-src` and loads from the address the host resolved. A `src` with a
scheme other than `file:` — `http(s):`, a `data:` image of any size — names no file the host
could resolve and is shown as written at once, neither posted nor kept. The page asks for every
other `src` it has not seen, once, batched (`resolveImages { requestId, srcs }`); the host
resolves each as a followed link (`displaySources`: relative to the document, a leading `/`
to its workspace folder, escapes decoded) and answers the ones that name a file with
`webview.asWebviewUri`. A `src` it leaves out, naming no file, is shown as written. Until the answer the element has no `src`, so nothing is requested from the
page's origin. A rendered block's HTML (a source block, injected content, a badge) is treated
the same way on every render (`showImagesIn`); that HTML is display only. An answer the page
did not ask for is dropped, and the error state forgets the questions in flight. The webview
may load from the document's folder and every workspace folder (`localResourceRoots`, with
the document's uri; the document's folder compared to a root with drive letters
lower-cased), and the CSP's `img-src` stays `${webview.cspSource} https: data:`. A folder
added to or removed from the workspace changes the roots: the provider sets `webview.options`
again when they differ, which makes VS Code rebuild the page — it asks for the document again,
and its undo history starts afresh. A document that is renamed opens as a new editor, with a
new session and new roots, so its images are resolved again against where it now is.
### Source positions

Completion, diagnostics, hover and "which requirement is the caret in" all cross between a
ProseMirror position in the page and a position in the text VS Code holds, and nothing did:
the host knew each top-level block's lines at parse time only, and an edited block's text has
moved relative to its slice. `positions.ts` is the one answer — pure, no `vscode`, no DOM — so
the page — which reports its caret with it and answers the host's questions — and the tests
ask the same code.
`createPositionMap(parsed, options)` gives, for one document, `sourcePositionOf(pos)`,
`pagePositionOf({ line, character })` and `pageRangeOf(range)`; `caretOf(selection, map)` is
the caret rule below.

**The text is the one the page would write.** `serializeLayout` (`serialize.ts`) is the loop
`serializeDocument` is, returning with the text where every top-level node's body stands in it
— an untouched block's `src`, an edited block's fresh serialization, wrapped by `wrap.ts` at
its width in the document's line ending — which is what the host holds once the page's edit
has landed. The offsets are read from where they are made, never counted a second time.

**Coordinates** are `vscode.Position`'s: 0-based line, 0-based character in UTF-16 code units
(ProseMirror counts text the same way). Lines break at `\r\n`, `\n` and a lone `\r`, as VS Code
and markdown-it both break them; a character past a line's end is its end, and a position
never falls between `\r` and `\n`. A CRLF file maps to exactly the lines and characters of its
LF twin: each body is aligned with its line breaks read as one `\n`, markdown-it's own
normalization, and the offsets are mapped back to the body as written.

**Inside a block, the page's text is aligned with the source's**, not counted. The source
holds delimiters the page does not (`*`, `**`, `` ` ``, `[…](…)`, `{…}`, `++`, `|`, a heading's
`# ` and `ID: `, bullets, indentation, an admonition's header); the page holds characters the
source spells otherwise (`&#124;` in a note's reference, a soft break that is a space in the
page and a line break in the file). Counting delimiters by hand would be a second serializer,
and wrong for every `src` block written by a person. So the block's page text — one unit per
UTF-16 code unit and per inline leaf, a hard break matching a line break, an image or a badge
matching nothing — and its source are aligned as two sequences: an affine-gap alignment
(Gotoh) that first maximizes the characters matched, then minimizes the gap runs, where a run
that starts a source line (a line's prefix) is free and ties go to the earlier match. Four
kinds of anchor without a page position steer it: a line break before every textblock but the
first, a note's markers and separator read from `src/syntax/markers.ts`, so a reference's
text cannot be matched into the body, and a table's line breaks and `|`s (a cell is a
textblock that starts after a `|`, not on a line; above, "Tables"). It runs in a band around the diagonal, since the source
is the page's text plus delimiters; a block over the band's budget (a paragraph holding a
6000-character URL) is aligned greedily and every answer in it is approximate. A block's
alignment is kept per node and body (`WeakMap`) with positions relative to the block, so a
caret report re-aligns only the block typed in.

**Between two characters** a position maps to just after the one before it when that one is
matched — the caret after typed text is after that text, before any closing delimiter — else to
just before the one after it; after a matched line break, before the next character, so a
wrapped list item's second line starts after its indentation. From the source back, the same
two rules in the same order: for every text position the directions agree (the property test
walks every one, LF and CRLF, untouched and re-serialized), except where the page has more
positions than the source has characters — two spaces the serializer writes as one. *After* a
character is after its whole spelling: an escape (`\*`) ends with the character, an entity whose
first character it is (`&amp;` for `&`) at its `;`. A source position strictly inside a
delimiter is found by the same rules and answered as approximate: inside a line's prefix across
a line break — a wrapped item's indentation, a quote's `> `, where the soft break's space may
have matched one of the prefix's spaces — or inside an entity's tail.

**A known limit: ties.** Where a run of the page's text also occurs inside a delimiter beside it
at equal cost — a link's text repeated in its URL, for one — the alignment cannot tell the
copies apart and takes the earlier match; a position there can land in the delimiter's copy and
is answered as exact. The free line prefix settles the common cases (a numbered item whose text
starts with its digit, a heading's `ID: ` prefix); the rest is left.

**Atoms map to their whole slice.** The position before a source block, an injected block,
the front matter or a rule is its slice's start, the position after it the end of its last
line; a source position inside it maps before it, approximately.

**Nothing throws.** A position that is none (outside the document, not an integer) answers
`null`. One that can only be placed near answers the nearest place with `approximate: true`:
an empty paragraph, the end of a heading after a badge, a position between a list's items, a
source position inside a delimiter, on a blank line between blocks, in the tail, past a line's
end or the text's, or inside an atom, and anything in a greedily aligned block.

**The page owns the map; the host asks it.** A ProseMirror position means something only in
the document it was taken from, and the page holds that document; a map built on the host's own
parse of the page's text would be a second answer, equal to the page's only where the text
reads back as the page's nodes (a first version did that, and was only conditionally right).
So `VisualEditorSession.toSource(pos)` and `toPage(position)` post `map { id, toSource?,
toPage? }`, and the page answers `mapped` from its map (`pageMap` in `webview/main.ts`: one
`PositionMap` per document state, which `flush`, the caret report and the answers share, so an
edited block is serialized once per state, not per question). The page flushes its pending
edit first, so the answer is in the text the host will hold; the host takes the answer in its
queue, behind that edit, and only when its `baseVersion` is the document it last posted and the
document holds the page's text. Otherwise — an answer for an older document, a change on its
way to the page, the error state, no page, no answer within `MAP_TIMEOUT_MS` (2 s) — the promise
resolves `undefined`, as it does for a position that is none. Completion, diagnostics and
hover (above) map with the same `pageMap` on the page, their requests carrying the positions.

**The caret** (`webview/caret.ts`). `caretOf` answers for a text selection whose head is in
text, `null` for a node selection (an atom, an image, a badge), a gap cursor, Ctrl+A, and a
mapping that is only approximate: a caret that may be wrong is not reported as right. The page
reports it 100 ms after the selection or the document last changed, and only while the host
holds the page's text: while an edit waits in its delay or a save commits, the report waits
and goes right after the edit that carries it (`flush`, as the code-action question does), so
the host reads it against the text it holds. The host takes it in its queue, behind that
edit, only for the document it last posted and while the document holds the page's text. It
forgets it when it applies an edit of the page's — before applying it, so a listener to that
change is never handed the caret of the text before it —, when another writer's change
arrives, when it posts a document, and in the error state. The page reports only a caret that
changed, except where the host forgot it: after every edit it sent, after every `document`, and
on `reportCaret`, which the host sends when another writer's change came and went before the
re-sync — the text is the page's again, no document is posted, and the page's caret, which did
not move, would otherwise never be reported.

### The active editor and its caret

A command Req Explorer runs from the palette without arguments takes the active document, and
the requirement at the caret, from `vscode.window.activeTextEditor` — which a custom editor is
not, and VS Code has no API saying a custom editor is active or where its caret is. The editor
that owns the caret says it: `activate` returns, beside `extendMarkdownIt`,

```ts
visualEditor: {
    /** The Visual Editor that has focus, if one does: its document uri and the caret's source position. */
    active(): { uri: vscode.Uri; caret: vscode.Position | undefined } | undefined;
    onDidChangeActive: vscode.Event<{ uri: vscode.Uri; caret: vscode.Position | undefined } | undefined>;
}
```

`caret` is a position in the document's text: 0-based line and UTF-16 character, as every
`vscode.Position`, so it can be handed to `document.offsetAt` or compared with a symbol's range
unchanged. It is `undefined` when the selection is in an atom (a source block, an injected
block, the front matter, a badge) or is no caret (Ctrl+A, a gap cursor), while a field of the
properties panel has the focus, when the mapping is
only approximate, and while a change the page has not seen is on its way to it (above).
`active()` is `undefined` when no Visual Editor has the focus — a text editor has it, or
nothing does — and `onDidChangeActive` fires when another Visual Editor or none takes the focus,
and when the active one's caret changes. The web build exports the same shape; there no editor
is ever active.

`host/activeEditor.ts` (`ActiveVisualEditorTracker`) follows every editor's `WebviewPanel`:
the one whose panel is `active` — VS Code's own flag, updated through `onDidChangeViewState` —
is the active editor, until its panel stops being active or is closed; the provider tells it of
each panel as it resolves one. What is exported is the two members, not the tracker. A reader
takes it from `vscode.extensions.getExtension('jackdmf.markdown-extended-pro')` — `exports`,
or what `activate()` resolves with. The extension activates on any Markdown file and on the
Visual Editor itself (`onLanguage:markdown`, `onCustomEditor:…`), so it is active whenever a
Visual Editor can be; a reader that finds it inactive has no Visual Editor to ask about.

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
