![Logo](./images/logo.png)

# Markdown Extended Pro

[![version](https://vsmarketplacebadges.dev/version-short/jackdmf.markdown-extended-pro.svg?style=flat-square&label=vscode%20marketplace)](https://marketplace.visualstudio.com/items?itemName=jackdmf.markdown-extended-pro)
[![installs](https://vsmarketplacebadges.dev/installs-short/jackdmf.markdown-extended-pro.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=jackdmf.markdown-extended-pro)
[![rating](https://vsmarketplacebadges.dev/rating-star/jackdmf.markdown-extended-pro.svg?style=flat-square)](https://marketplace.visualstudio.com/items?itemName=jackdmf.markdown-extended-pro&ssr=false#review-details)

Markdown Extended Pro is a comprehensive extension that extends syntaxes and abilities to VSCode's built-in markdown functionality.

**Key Features:**

- 🎨 **Extended Syntax Support** - 17 integrated markdown-it plugins plus built-in syntaxes
- 📝 **Advanced Note Types** - Sidenotes, marginal notes, and sidebar annotations
- 📤 **WYSIWYG Exporter** - Export to HTML, PDF, PNG, JPEG matching the preview
- 🌗 **Theme-Aware & Accessible Exports** - Light / dark / auto export theme with a built-in, accessible base stylesheet (overridable by your own CSS)
- 🧜 **Mermaid in Exports** - Diagrams shown in VS Code's preview are rendered to inline SVG in exported files
- ✏️ **Editing Helpers** - Table formatting, text formatting toggles, and more
- 🖋️ **WYSIWYG Editor (experimental)** - Edit as rendered text; untouched blocks are saved byte for byte ([details](#wysiwyg-editor-experimental))
- 🌐 **Web Extension** - Works in [vscode.dev](https://vscode.dev) and [github.dev](https://github.dev) (preview & editing; export requires desktop)
- 🏗️ **TypeScript Codebase** - Built with TypeScript, unit tests, and error recovery

Export files aim to match the markdown preview, including syntaxes and styles contributed by other plugins.

> **Note:** Export to file (PDF, PNG, HTML) requires the desktop version of VS Code. In [vscode.dev](https://vscode.dev), all syntax highlighting, preview plugins, and editing helpers are available — only file export is unavailable.

> **New here?** Run **Welcome: Open Walkthrough…** from the command palette and pick **Get Started with Markdown Extended** for a guided tour of the syntax and export.

## Features

### Exporter

Export to Self Contained HTML / PDF / PNG / JPEG with perfect preview fidelity:

- Export current document / workspace
- Copy exported HTML to clipboard
- WYSIWYG export matches preview exactly
- Mermaid diagrams are rendered to inline SVG in the exported file (the Mermaid library is never embedded in the output)

Find commands in the command palette or right-click on an editor / workspace folder:

- `Markdown: Export to File`
- `Markdown: Export Markdown to File`

Export files are organized in the `out` directory in the workspace root by default.

### Editing Helpers

Command palette or right-click shortcuts for markdown editing:

- **Table Operations**: Paste as table, format table, add/delete/move columns & rows
- **Text Formatting**: Toggle bold, italic, underline, strikethrough, mark, code, block quote
- **Lists**: Toggle ordered/unordered lists, superscript, subscript
- **Smart Editing**: Auto-format tables, CSV to table conversion

See [Editing Helpers and Keys](#editing-helpers-and-keys) for details.

### Color Themes

Two included color themes for enhanced markdown syntax highlighting:

- **Markdown Extended Light** - Clean, readable colors matching Styles.css light mode
- **Markdown Extended Dark** - Eye-friendly dark theme matching Styles.css dark mode

**To activate**: Press `Ctrl+K Ctrl+T` and select "Markdown Extended Light" or "Markdown Extended Dark"

All colors extracted from the official Styles.css:

- Italic (*): Gold - Underline (_): Green - Bold (**): Purple - Strong (__): Cyan
- Strikethrough (~~): Pink/Red - Highlight (==): Orange
- Sidenotes, marginal notes, sidebars, TOC, footnotes with distinct colors

See [themes/README.md](./themes/README.md) for color mapping details.

### Extended Syntaxes

Built-in syntax extensions:

- **Sidenotes & Annotations** (built-in) - [View Document](#sidenotes-and-annotations)
  - Sidenotes: `++reference text|note content++`
  - Marginal notes: `!!reference text|note content!!`
  - Sidebars: `$left sidebar$` and `@right sidebar@`
- **Admonition** (built-in) - [View Document](#admonition)
- **Enhanced Anchor Link** (built-in) - Auto-slugify heading links

Integrated markdown-it plugins:

- [markdown-it-table-of-contents](https://www.npmjs.com/package/markdown-it-table-of-contents) - `[[TOC]]`
- [markdown-it-footnote](https://www.npmjs.com/package/markdown-it-footnote) - Footnote syntax
- [markdown-it-abbr](https://www.npmjs.com/package/markdown-it-abbr) - Abbreviations
- [markdown-it-deflist](https://www.npmjs.com/package/markdown-it-deflist) - Definition lists
- [markdown-it-sup-alt](https://www.npmjs.com/package/markdown-it-sup-alt) - Superscript `^text^`
- [markdown-it-sub-alt](https://www.npmjs.com/package/markdown-it-sub-alt) - Subscript `~text~`
- [markdown-it-checkbox](https://www.npmjs.com/package/markdown-it-checkbox) - Task lists
- [markdown-it-attrs](https://www.npmjs.com/package/markdown-it-attrs) - Add attributes `{.class #id}`
- [markdown-it-kbd](https://www.npmjs.com/package/markdown-it-kbd) - Keyboard keys `[[Ctrl+S]]`
- [markdown-it-ib](https://www.npmjs.com/package/markdown-it-ib) - Italic-bold support
- [markdown-it-mark](https://www.npmjs.com/package/markdown-it-mark) - Mark/highlight `==text==`
- [markdown-it-multimd-table](https://www.npmjs.com/package/markdown-it-multimd-table) - Advanced tables
- [markdown-it-emoji](https://www.npmjs.com/package/markdown-it-emoji) - Emoji support :smile:
- [markdown-it-html5-embed](https://www.npmjs.com/package/markdown-it-html5-embed) - Embed media
- [markdown-it-container](https://www.npmjs.com/package/markdown-it-container) - Custom containers
- [markdown-it-bracketed-spans](https://www.npmjs.com/package/markdown-it-bracketed-spans) - Span syntax
- [markdown-it-cjk-friendly](https://www.npmjs.com/package/markdown-it-cjk-friendly) - Fixes `**bold**`/`*italic*` next to CJK (Chinese/Japanese/Korean) text

> Post an issue on [GitHub][issues] if you want other plugins.

### Disable Plugins

To disable integrated plugins, add their names (comma-separated, without `markdown-it-` prefix) to settings:

```json
"markdownExtended.plugins.disabled": "ib, emoji, bracketed-spans"
```

> The pre-3.0 key `markdownExtended.disabledPlugins` still works but is deprecated.

**Available plugin names:** `table-of-contents`, `container`, `admonition`, `footnote`, `abbr`, `sup-alt`, `sub-alt`, `checkbox`, `attrs`, `kbd`, `ib`, `mark`, `deflist`, `emoji`, `multimd-table`, `html5-embed`, `sidenote`, `bracketed-spans`, `cjk-friendly`, `helper`

## Architecture & Development

This extension is built with:

- **Service-based structure**: Singleton services and separation of concerns
- **TypeScript**: Strongly typed source
- **Error Handling**: Error recovery and logging
- **Resource Management**: Cleanup, async operations, disposal of resources
- **Tests**: Unit tests with VS Code integration

For detailed architecture documentation, see
[ARCHITECTURE.md](https://github.com/JackDMF/vscode-markdown-extended/blob/master/ARCHITECTURE.md)
in the repository.

## Works Well With Other Extensions

The extension works seamlessly with other markdown plugins that contribute to the built-in Markdown engine - **both in Preview and Export**:

- [Markdown Preview Github Styling](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-preview-github-styles)
- [Markdown+Math](https://marketplace.visualstudio.com/items?itemName=goessner.mdmath)
- [Markdown Preview Mermaid Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)

The extension doesn't aim to do everything - use specialized plugins for deep features!

## Exporter

Find in command palette, or right click on an editor / workspace folder, and execute:

- `Markdown: Export to File`
- `Markdown: Export Markdown to File`

The export files are organized in `out` directory in the root of workspace folder by default.

### Export Configurations

Configure exports in **Settings** (search "Markdown Extended"). Settings are grouped under **pdf**, **image**, **export**, **plugins**, and **toc**. Highlights:

- `markdownExtended.export.theme` — `light`, `dark`, or `auto` (follows your VS Code theme; default)
- `markdownExtended.export.defaultStyles` — apply a built-in accessible base stylesheet to exports (on by default; **skipped when you set your own `markdown.styles`**)
- `markdownExtended.pdf.*` / `markdownExtended.image.*` — page format, margins, image quality, and more
- `markdownExtended.export.outDirName` — where exports go. A plain name (`out`, the default) is a directory under the workspace root; an **absolute path** writes outside the workspace entirely, which is handy when the workspace lives in a repository but the files should end up in a synced folder you can open on a tablet. Either way the document's position inside the workspace is mirrored beneath it.

> **v3.0:** settings were regrouped. Old flat keys (e.g. `markdownExtended.pdfFormat`) still work but are deprecated — please migrate to the grouped names.

After an export, use **Open** or **Reveal** in the notification to jump to the file. The first PDF/PNG/JPG export downloads a bundled Chromium once, with your consent.

You can also add per-file settings inside markdown front matter to override user settings (highest priority):

```markdown
---
puppeteer:
    pdf:
        format: A4
        displayHeaderFooter: true
        margin:
            top: 1cm
            right: 1cm
            bottom: 1cm
            left: 1cm
    image:
        quality: 90
        fullPage: true
---
contents goes here...
```

See all available settings for
[puppeteer.pdf](https://github.com/GoogleChrome/puppeteer/blob/v1.4.0/docs/api.md#pagepdfoptions), and
[puppeteer.image](https://github.com/GoogleChrome/puppeteer/blob/v1.4.0/docs/api.md#pagescreenshotoptions)

## Editing Helpers

### Editing Helpers and Keys

> Inspired by
[joshbax.mdhelper](https://marketplace.visualstudio.com/items?itemName=joshbax.mdhelper),
but totally new implements.

Default Keyboard Shortcut bindings are removed due to conflict issues on platforms, please consider:

- Switch to use command palette
- Switch to use [Snippets](#snippets)
- Setup key bindings on your own

| Command                       | Keyboard Shortcut                 |
| ----------------------------- | --------------------------------- |
| Format: Toggle Bold           | ~~Ctrl+B~~                        |
| Format: Toggle Italics        | ~~Ctrl+I~~                        |
| Format: Toggle Underline      | ~~Ctrl+U~~                        |
| Format: Toggle Mark           | ~~Ctrl+M~~                        |
| Format: Toggle Strikethrough  | ~~Alt+S~~                         |
| Format: Toggle Code Inline    | ~~Alt+`~~                         |
| Format: Toggle Code Block     | ~~Alt+Shift+`~~                   |
| Format: Toggle Block Quote    | ~~Ctrl+Shift+Q~~                  |
| Format: Toggle Superscript    | ~~Ctrl+Shift+U~~                  |
| Format: Toggle Subscript      | ~~Ctrl+Shift+L~~                  |
| Format: Toggle Unordered List | ~~Ctrl+L, Ctrl+U~~                |
| Format: Toggle Ordered List   | ~~Ctrl+L, Ctrl+O~~                |
| Table: Paste as Table         | ~~Ctrl+Shift+T, Ctrl+Shift+P~~    |
| Table: Format Table           | ~~Ctrl+Shift+T, Ctrl+Shift+F~~    |
| Table: Add Columns to Left    | ~~Ctrl+Shift+T, Ctrl+Shift+L~~    |
| Table: Add Columns to Right   | ~~Ctrl+Shift+T, Ctrl+Shift+R~~    |
| Table: Add Rows Above         | ~~Ctrl+Shift+T, Ctrl+Shift+A~~    |
| Table: Add Row Below          | ~~Ctrl+Shift+T, Ctrl+Shift+B~~    |
| Table: Move Columns Left      | ~~Ctrl+Shift+T Ctrl+Shift+Left~~  |
| Table: Move Columns Right     | ~~Ctrl+Shift+T Ctrl+Shift+Right~~ |
| Table: Delete Rows            | ~~Ctrl+Shift+D, Ctrl+Shift+R~~    |
| Table: Delete Columns         | ~~Ctrl+Shift+D, Ctrl+Shift+C~~    |

> Looking for `Move Rows Up / Down`?  
> You can use vscode built-in `Move Line Up / Down`, shortcuts are `alt+↑` and `alt+↓`

### Snippets

| Index | Prefix                | Context                          | View                                      |
| ----- | --------------------- | -------------------------------- | ----------------------------------------- |
| 0     | `underline`           | `_under_ line`                   | _under_ line                              |
| 1     | `mark`                | `==mark==`                       | ==mark==                                  |
| 2     | `subscript`           | `~sub~script`                    | ~sub~script                               |
| 3     | `superscript`         | `^super^script`                  | ^super^script                             |
| 4     | `checkbox`            | `[] checkbox`                    | [ ] checkbox                              |
| 5     | `tasklist`            | `- [] task`                      | - [ ] task                                |
| 6     | `table`               | Markdown table                   | See [Paste as Table](#table-editing)      |
| 7     | `kbd`                 | Keyboard tag                     | Keyboard shortcut                         |
| 8     | `admonition` / `note` | Admonition block                 | [Admonition](#admonition)                 |
| 9     | `sidenote`            | `++ref\|note++`                  | [Sidenote](#sidenotes-and-annotations)    |
| 10    | `marginnote`          | `!!ref\|note!!`                  | [Marginal](#sidenotes-and-annotations)    |
| 11    | `footnote`            | `[^abc]` and `[^abc]: ABC`       | [Footnote](#markdown-it-footnote)         |
| 12    | `container`           | Custom container                 | [Container](#markdown-it-container)       |
| 13    | `abbr`                | `*[ABBR]: Abbreviation`          | [Abbr](#markdown-it-abbr)                 |
| 14    | `attr`                | `**attr**{style="color:red"}`    | Styled text                               |
| 15    | `color`               | Text with color                  | Colored text                              |

### Table Editing

**Format Table** rewrites a table so the pipes line up, padding every cell to the
width of its column and preserving each column's alignment marker:

```markdown
| Command | Shortcut | Notes |
|---|:--:|--:|
| Format Table | Ctrl+Shift+T | tidies alignment |
| Move Columns | Ctrl+Shift+Left | keeps the header |
```

becomes

```markdown
| Command      |    Shortcut     |            Notes |
| ------------ | :-------------: | ---------------: |
| Format Table |  Ctrl+Shift+T   | tidies alignment |
| Move Columns | Ctrl+Shift+Left | keeps the header |
```

The remaining table commands act on the table under the cursor, and reformat it
afterwards so it stays aligned:

| Command                     | Effect                                              |
| --------------------------- | --------------------------------------------------- |
| Add Columns to Left / Right | Inserts a column beside the one holding the cursor  |
| Add Rows Above / Below      | Inserts a row next to the current one               |
| Move Columns Left / Right   | Swaps a whole column, header and alignment included |
| Delete Rows / Delete Columns | Removes the current row or column                  |

Every one is on the command palette. No keyboard shortcuts are bound by default -
see [Editing Helpers and Keys](#editing-helpers-and-keys) for why, and for the
bindings to copy if you want them back.

> For `Move Rows Up / Down`, use VS Code's built-in `Move Line Up / Down`
> (`alt+up` / `alt+down`).

### Paste as Markdown Table

Copy a table from Excel, a web page, or anything else that puts Comma-Separated
Values on the clipboard, then run **Paste as Table**. This clipboard content:

```text
Command,Shortcut,Notes
Format Table,Ctrl+Shift+T,tidies alignment
Move Columns,Ctrl+Shift+Left,keeps the header
```

is inserted as:

```markdown
| Command      | Shortcut        | Notes            |
| ------------ | --------------- | ---------------- |
| Format Table | Ctrl+Shift+T    | tidies alignment |
| Move Columns | Ctrl+Shift+Left | keeps the header |
```

The first row becomes the header, and the table is aligned on insert.

### Export & Copy

| Command                            | What it does                                                     |
| ---------------------------------- | ---------------------------------------------------------------- |
| Export to File                     | Exports the current document to HTML, PDF, PNG or JPG            |
| Export Markdown to File            | Exports every Markdown file in the workspace                     |
| Copy HTML                          | Puts the rendered HTML on the clipboard                          |
| Copy HTML & Styles                 | The same, with the stylesheets inlined so it survives pasting    |
| Install Chromium Browser for Export | Downloads the Chromium that PDF and image export need            |

Search "Markdown" in the command palette (`Ctrl+Shift+P`) to reach them; export is
also on the editor title menu and the explorer context menu.

## WYSIWYG Editor (experimental)

Edit a Markdown file as rendered text — headings, paragraphs, lists, quotes and code
typed in place — and save a file that differs from the original **only where you
changed it**. The text editor stays the default; the WYSIWYG editor is chosen per file.

### Opening it

- **Command palette:** `Markdown: Open in WYSIWYG Editor` on the active Markdown file.
- **Context menu:** right-click a `.md` file in the explorer, or inside a Markdown
  editor, and choose **Open in WYSIWYG Editor**.
- **Open With…:** on any `.md` or `.markdown` tab or file, **Open With…** →
  **Markdown WYSIWYG Editor**. The same menu can make it the default for `*.md` if you
  want that.

It edits the same document as the text editor: dirty state, save and the file's undo
history are VS Code's, and the text editor and the WYSIWYG editor can be open side by
side on one file, each following the other's changes.

### What is edited in place

Paragraphs, headings, bullet and ordered lists, block quotes, fenced and indented code
blocks and horizontal rules, with bold, italic, inline code, links and images inside
them. Format them from the toolbar (below) or with the keys a Markdown author already
knows:

| Keys | Does |
| ---- | ---- |
| `Ctrl+B` / `Ctrl+I` / ``Ctrl+` `` | Bold / italic / inline code |
| `Enter`, `Tab`, `Shift+Tab` in a list | New item / indent / outdent |
| `Ctrl+Z`, `Ctrl+Y` or `Ctrl+Shift+Z` | Undo / redo |
| `# ` … `###### ` at the start of a line | Heading of that level |
| `- ` or `* `, `1. `, `> ` at the start of a line | Bullet list, ordered list, quote |
| ` ``` ` at the start of a line | Code block |

`Ctrl+I` writes `*italic*` and `Ctrl+B` `**bold**`, the CommonMark defaults, and one press
removes emphasis or bold whichever delimiter it was written with. Blocks the toolbar
inserts go after the block you are in — after the last one when the whole document is
selected — and never above the first.

### Toolbar

A toolbar stays at the top of the page, one line of controls:

`Block type ▾` | `i` `em` `b` `strong` `code` | `Formatting ▾` `Annotation ▾` `Insert ▾`

Every control has the same height, and nothing wraps: in a narrow window the row scrolls
sideways, so each control stays where you learned it. The five marks show their real
element (the italic, emphasis, bold, strong and code your stylesheets draw) as their
glyph; everything else is in a menu. Above any text you select, a small bubble offers the
same five marks.

In a menu, each entry **is** the construct it makes — the very element the preview renders
from that syntax, drawn by the same stylesheets and scaled to one entry height — with its
Markdown on the right. Rest the pointer on an entry, or move to it with the arrow keys, and
a card beside the menu shows the construct at full size in a short example, with the
Markdown beneath. Menus open with `↓`, `Enter` or a click, move with the arrow keys (`→`
opens a submenu), choose with `Enter` and close with `Esc`.

- **Block type** — paragraph, heading 1–6, quote, bullet list, numbered list, code block.
  The face names the block you are in. Choosing the list or quote you are already in takes
  the block out of it again.
- **Italic, emphasis, bold, strong, code** — in the row. A button is marked while the
  selection carries what it writes.
- **Formatting** — highlight (`==mark==`), superscript (`^sup^`), subscript (`~sub~`),
  strikethrough (`~~del~~`) and key (`[[Ctrl]]`).
- **Annotation** — sidenote (`++reference|note++`), marginal note (`!!reference|note!!`),
  left and right sidebar (`$left$`, `@right@`) and footnote. A footnote is written after
  the selection with the first free number (`[^2]`), and its definition goes below the
  paragraph with its source open for the text.
- **Insert** — horizontal rule; admonition, a submenu of every type the admonition plugin
  knows, each drawn as its box; table, container, task list, definition list, abbreviation
  and table of contents, from the same templates as this extension's snippets where one
  exists.

In the card, notes and sidebars are shown stacked, as they render below the margin
layout's 1280px breakpoint, however wide the window: a card is too narrow for a margin,
so the notes stylesheet leaves its margin layout out of it.

**Why emphasis is four buttons.** This extension renders `*a*` as `<i>`, `_b_` as `<em>`,
`**c**` as `<b>` and `__d__` as `<strong>` (`markdown-it-ib`), so a stylesheet can give
each its own look — underlining `_b_`, say, while `*a*` stays italic. The editor keeps the
delimiter you wrote and draws it as the preview does; choosing emphasis on italic text
swaps `*` for `_` rather than nesting one inside the other.

**Stage 1: the extended syntax goes in as source.** Highlight, super- and subscript,
strikethrough, keys, the annotations and every insert except the rule are not yet edited as
rich text. An inline one wraps the selected text in its markers and the paragraph becomes
a source block, rendered as the preview renders it; a block one is inserted after the
current block as a source block with its **Edit source** box open. The tooltip of each such
button says *edits as source until stage 2*. One `Ctrl+Z` takes the wrap back.

**A requirement heading keeps its type.** On a heading written `## ID: Title {#anchor}`
the block-type menu is disabled, and its tooltip says why: changing the type would rebuild
the heading and lose the id and the anchor. Its title can still be formatted.

### What is shown, not edited as rich text

Some blocks appear as they do in the preview, outlined, and are not edited as text in
place — each for a reason:

- **Front matter** is a collapsed, read-only panel with the YAML exactly as written. It
  is written back byte for byte, line endings included: tools such as Req Explorer own
  it and edit it with their own commands, and a rich editor that re-wrote the YAML
  would reorder keys and lose comments.
- **Content another extension injects** — Req Explorer's status badges and summary
  tables, a snippet expanded from `<!-- include: … -->` — is not in the file at that
  place, so it cannot be edited there. An expanded snippet shows an **Open snippet**
  button that opens the file it came from; the file itself keeps the one directive line.
- **Tables, raw HTML and this extension's extended syntax** (admonitions, containers,
  the table of contents, footnotes, definition lists, …) are *source blocks*. Hover or
  select one and choose **Edit source** — or double-click it — to edit its Markdown in
  place: `Ctrl+Enter` or clicking away applies it, `Esc` cancels. Or choose **Show in text
  editor** to jump to it. A source block that you edit back into plain Markdown (the
  markers of a sidenote removed, say) becomes an ordinary paragraph again once applied.
  Checkboxes and other controls in a rendered block are shown, not clicked: the file is
  what changes them.

A requirement heading written as `## ID: Title {#anchor}` keeps the id and the anchor
read-only; only the title is editable. `Enter` inside its title starts a paragraph below
rather than a second heading, so the id and the anchor are never written twice.

### The fidelity promise

- A block you did not touch is written back **byte for byte** — its wrapping, its
  markers, its escapes, the blank lines around it. The one exception is the separator
  above it when the block it followed is no longer there (you moved, deleted or split
  it): the blank lines it had belonged to that neighbour, and one blank line is written.
- A paragraph you changed is re-wrapped at the width it was written at. A paragraph
  that gives no width of its own (a new one, or one that was a single line) is wrapped
  at `markdownExtended.editor.wrapColumn` (default `90`).
- If a document cannot be shown without changing it, the editor says so and offers the
  text editor instead; it never writes to such a document.

### Limits

- **Experimental.** Try it on files under version control.
- **Tables are edited as source**, not cell by cell, and so is the rest of the extended
  syntax the toolbar inserts (stage 1).
- **Links and images have no toolbar button yet.** Existing ones are kept and edited as
  text; a new one is written in the text editor.
- **Relative images are not resolved** in the editor yet; they show as broken images.
  The file is unaffected.
- **Desktop only.** In vscode.dev the command and menu entries are hidden; **Open With…**
  still lists the editor there, and choosing it fails.
- There is no merge. The editor sends what you typed a quarter of a second after the
  last keystroke; an edit typed in the quarter second before an external change (the text
  editor beside it, another extension, a save that trims whitespace) is dropped, and the
  editor shows the file as the change left it. Everything sent before stays, and so does
  its undo history.
- `Ctrl+S` in the editor sends the last keystrokes and saves once they are written — also
  from a source block's open **Edit source** box, which stays open; a save started
  elsewhere (the File menu, auto-save) saves what has been sent.

## Syntax Documentation

### Sidenotes and Annotations

This extension provides powerful annotation features with full markdown support:

```markdown
Sidenotes sit in the margin instead of breaking the line.++[1]|Notes carry
**full markdown**: links, `code` and emphasis.++ On a narrow page they fall
back to a readable block, so nothing is pushed off the edge.

Marginal notes behave the same way but render bold.!![*]|Good for short asides.!!

$A left sidebar, for context that runs alongside the text.$

@A right sidebar, with `code` and [links](https://example.com).@
```

![sidenote-demo](./images/sidenote-demo.png)

#### Sidenotes

Sidenotes appear as floating annotations next to your text:

```markdown
This is main text with ++reference text|This is the sidenote content with **markdown** support++.
```

#### Marginal Notes

Marginal notes appear in the document margin:

```markdown
This is main text with !!reference text|This is the marginal note with *italic* text!!.
```

#### Sidebars

Left and right sidebar annotations for additional context:

```markdown
$This appears in the left sidebar with [links](url) and other markdown$

@This appears in the right sidebar with `code` and formatting@
```

**Features:**

- Full markdown support within notes (bold, italic, links, code, etc.)
- Recursion depth limiting for safety
- Graceful error handling

**CSS Classes:**

- Sidenotes: `.sn-ref` (reference), `.sidenote` (content)
- Marginal notes: `.mn-ref` (reference), `.mnote` (content)
- Sidebars: `.left-sidebar`, `.right-sidebar`

**Layout:**

Notes render as blocks in the text flow by default, and move into the margin only
when the window is at least 1280px wide — the content column plus a full note on
either side. Below that, and in PDF and image export, the block rendering is used,
which keeps the notes readable instead of pushing them off the page.

**Customizing Styles:**

Add your own CSS file to VS Code settings:

```json
"markdown.styles": ["./path/to/your-custom-styles.css"]
```

Your styles load after the extension's and take precedence. Note that setting
`markdown.styles` also switches off the built-in export theme (see
`markdownExtended.export.defaultStyles`), so your file then owns the whole export
appearance.

Custom properties you can override. Declare them on `body`, **not** `:root` -
custom properties inherit from the nearest ancestor that sets them, and the note
colors below are set on `body`, so a `:root` rule in your stylesheet can never
reach them however specific it is. A single `body` block reaches all of them:

```css
body {
  --md-note-width: 260px;
  --md-note-surface: transparent;
}
```

| Property | Default | Purpose |
| --- | --- | --- |
| `--md-note-width` | `200px` | Width of sidenotes and marginal notes in the margin |
| `--md-note-gap` | `24px` | Space between the content column and the note |
| `--md-sidebar-width` | `200px` | Width of `$left$` / `@right@` sidebars |
| `--md-sidebar-gap` | `24px` | Space between the content column and the sidebar |
| `--md-note-font-size` | `0.9em` | Font size for all notes and sidebars |
| `--md-note-opacity` | `0.85` | Opacity in the margin layout |
| `--md-note-surface` | `#f6f8fa` / `#161b22` | Background of the block rendering (light / dark) |
| `--md-note-border` | `#d0d7de` / `#30363d` | Left border color of the block rendering |
| `--md-note-border-width` | `3px` | Left border width; set to `0` to drop the rule |
| `--md-note-padding` | `0.5em 1em` | Padding inside the block rendering |

Widths are absolute rather than percentages on purpose: a percentage offset grows
with the content column, so the note can never fit the gutter and exported HTML
ends up with a horizontal scrollbar. If you widen `--md-note-width`, raise the
`min-width: 1280px` breakpoint in your own CSS to match.

**If you already style these classes yourself**, note what the built-in
stylesheet contributes that it did not before 3.1.2 - it ships in
`markdown.previewStyles` now, where previously nothing loaded it. Anything you
declare still wins, because your styles load after the extension's. What reaches
you is only what you never declared, and only *below* the 1280px breakpoint: the
block rendering's background, left border and padding. Above it the margin layout
already sets all three to nothing. To get the pre-3.1.2 blank slate back:

```css
body {
  --md-note-surface: transparent;
  --md-note-border-width: 0;
  --md-note-padding: 0;
}
```

That leaves the layout behaviour - block below 1280px, margin above - and removes
every visual decoration. If you would rather keep your own layout too, set the
properties directly instead:

```css
.sidenote, .mnote, .left-sidebar, .right-sidebar {
  background: none;
  border-left: 0;
  padding: 0;
  margin: 0;
}
```

For advanced features (CSS counters, color cycling, `:has()` selectors), build on
these classes and properties — see `styles/markdown-extended.css`.

### Extended Inline Syntax

Everything the extension adds to a line of text, in one place. Each mark has its
own section further down; this is what they look like together.

```markdown
*[HTML]: HyperText Markup Language

Highlight with ==mark==, strike through ~~del~~, mix *italic* and **bold**.
Water is H~2~O and the answer is 2^10^ = 1024. Press [[Ctrl+S]] to save.
An HTML abbreviation shows its meaning on hover, and emoji work too :rocket:

- [x] checkbox lists render as real checkboxes
- [ ] unchecked items too

Term
:   A definition list entry, for glossaries and option tables.
```

![inline-syntax-demo](./images/inline-syntax-demo.png)

### Admonition

> Inspired by [MkDocs](https://squidfunk.github.io/mkdocs-material/extensions/admonition/)

Nesting supported (by indent) admonition, the following shows a danger admonition nested by a note admonition.

```markdown
!!! note

    This is the **note** admonition body

    !!! danger Danger Title
        This is the **danger** admonition body
```

![admonition-demo](images/admonition-demo1.png)

#### Admonition Without a Title

A bare `!!! type` renders just the box, with no title bar. This is the default -
nothing needs removing:

```markdown
!!! danger
    This is the danger admonition body
```

![admonition-demo](images/admonition-demo2.png)

A title bar appears only when you write one after the type, either bare
(`!!! danger Danger Title`) or quoted (`!!! danger "Danger Title"`). An explicit
empty title, `!!! danger ""`, is accepted and behaves exactly like leaving it
out - both produce the same markup.

#### Supported Qualifiers

`note` | `summary, abstract, tldr` | `info, todo` | `tip, hint` | `success, check, done` | `question, help, faq` | `warning, attention, caution` | `failure, fail, missing` | `danger, error, bug` | `example, snippet` | `quote, cite`

See also: [Python-Markdown Documentation for Admonitions](https://python-markdown.github.io/extensions/admonition/)

### markdown-it-table-of-contents

```markdown
[[TOC]]
```

Generates a table of contents from document headings.

### markdown-it-footnote

```markdown
Here is a footnote reference,[^1] and another.[^longnote]

[^1]: Here is the footnote.
[^longnote]: Here's one with multiple blocks.

    Indented paragraphs belong to the same footnote.
```

![footnote-demo](./images/footnote-demo.png)

### markdown-it-abbr

```markdown
*[HTML]: Hyper Text Markup Language
*[W3C]:  World Wide Web Consortium
The HTML specification
is maintained by the W3C.
```

The HTML specification is maintained by the W3C (with abbreviation tooltips).

### markdown-it-deflist

```markdown
Apple
:   Pomaceous fruit of plants of the genus Malus in the family Rosaceae.
```

Creates definition lists with terms and definitions.

### markdown-it-sup markdown-it-sub

```markdown
29^th^, H~2~O
```

Example: 29<sup>th</sup>, H<sub>2</sub>O

### markdown-it-checkbox

```markdown
[ ] unchecked
[x] checked
```

Creates interactive checkboxes in preview.

### markdown-it-attrs

```markdown
item **bold red**{style="color:red"}
```

Example: item **bold red** (styled with inline CSS)

Attributes also apply to the built-in sidenotes, marginal notes, and sidebars. Add `{.class #id key=val}` right after the closing marker:

```markdown
++ref|note++{.my-class}
!!ref|note!!{.my-class}
$left sidebar${.my-class}
@right sidebar@{.my-class}
```

### markdown-it-kbd

```markdown
[[Ctrl+Esc]]
```

Renders keyboard shortcuts with proper styling.

### markdown-it-ib

```markdown
_underline_
```

Provides italic-bold support with underline rendering.

### markdown-it-container

A `:::` fence becomes a `<div>` whose `class` attribute is the fence's info string,
copied verbatim. The class names therefore come from whatever CSS framework you
load — the extension supplies none of them. Nest by giving the outer fence *more*
colons than the inner one; three is the minimum, so the four-level example below
(container › row › column › panel) starts at six.

```markdown
:::::: container
::::: row g-3
:::: col-md-6
::: alert alert-success h-100 mb-0
**Markdown still works inside a container:**

- `inline code`, **bold**, *italic*
- [links](https://example.com) and lists
:::
::::
:::: col-md-6
::: alert alert-warning h-100 mb-0
**The class names are yours.** The fence text is copied into
`class` verbatim — the extension adds nothing of its own.
:::
::::
:::::
::::::
```

![container-demo.png](./images/container-demo.png)

_Rendered with Bootstrap 5._ To reproduce it:

```json
"markdown.styles": [
    "https://cdn.jsdelivr.net/npm/bootstrap@5.3.8/dist/css/bootstrap.min.css"
]
```

The panels sit side by side down to 768px and stack below it. `g-3` supplies the
gutter between them, and `h-100 mb-0` keeps them equal height and flush with the
row — put the grid class and the panel class on *separate* nested fences, because
a single `::: col-md-6 alert alert-success` makes the alert fill the column's
gutter and the two panels end up touching.

<details>
<summary>The same layout in Bulma</summary>

```markdown
:::::: container px-4
::::: columns
:::: column
::: notification is-success
success text
:::
::::
:::: column
::: notification is-warning
warning text
:::
::::
:::::
::::::
```

```json
"markdown.styles": [
    "https://cdn.jsdelivr.net/npm/bulma@1.0.4/css/bulma.min.css"
]
```

Bulma stacks at its own breakpoint, 769px. The `px-4` is not decoration: Bulma's
`.columns` uses negative margins, and without horizontal padding on the container
the row overhangs the page and adds a horizontal scrollbar on narrow screens.

</details>

Utility-first frameworks that ship as a script rather than a stylesheet — the
Tailwind Play CDN, for instance — cannot be loaded this way, because
`markdown.styles` only takes CSS.

Two things to know before you set `markdown.styles`:

- **Class names are version-specific.** `col-md-6` is Bootstrap 4/5 syntax;
  Bootstrap 3 spells it `col-sm-6`/`col-xs-6`, and Bootstrap 4 removed the `-xs`
  infix altogether. A snippet copied from the wrong major version silently
  produces full-width rows instead of columns.
- **Setting `markdown.styles` switches off the built-in export theme.**
  `markdownExtended.export.defaultStyles` applies only when you have *not* set
  your own styles, so your CSS then owns the entire export appearance — including
  the base typography and light/dark colors the built-in sheet would otherwise
  provide.

A URL and a local file are also not equivalent in export: a local path is read and
inlined into the exported HTML, while a URL is emitted as a `<link rel="stylesheet">`.
Exporting with a CDN URL therefore needs network access at export time, and the
exported HTML keeps depending on that CDN. Use a local `.css` file if the export
has to stand on its own.

## Known Issues & Feedback

Please post and view issues on [GitHub][issues]

**Enjoy!**

[issues]: https://github.com/JackDMF/vscode-markdown-extended/issues "Post issues"
