# Change Log

## Unreleased

### ✨ Features

- Emoji already in a file (`:)`, `:smile:`) no longer make their paragraph a source block; they are saved as written.
- An emoji an edit would turn back into text, like `:)Z`, becomes that text at once, with a hint.
- Click an emoji to select it; its bar offers Edit as text and Remove emoji.

### 🐛 Bug Fixes

- An `<https://…>` link starting a changed paragraph is no longer saved with a backslash before it.

### ⚠️ Limits

- An emoji inside `^sup^` or `~sub~` still keeps its paragraph a source block.
- A smiley typed in a sidenote or marginal note reads as an emoji even escaped, and opens as one.
- An emoji cannot be made code, superscript or subscript.
- Edit as text is unavailable for an emoji inside a sidenote or marginal note, which would still show it.
- A changed note writes an escaped smiley (`\:)`, `&#58;)`) without its escape; it shows the same.
- `x &#97;:) y` shows an emoji; any edit in that paragraph turns it into text.
- `<\3` is never read as an emoji, so it stays text.

## v4.1.2 — Links That Keep Their Edges

### 🐛 Bug Fixes

- A smiley typed right against a URL no longer saves as an emoji, except as listed under Limits.
- A link an edit joined to a letter keeps its address and the letter when saved.
- A smiley typed after a linked URL with a path no longer becomes part of the address.
- Edits that put a sidebar or a `/` right after a link now apply instead of being refused.
- A link whose address holds a percent code such as `%41` keeps that address when saved.

### ⚠️ Limits

- `<3` or `</3` typed right after a URL with a path still reads as an emoji.
- `</3` right after a URL with a path adds `%5C` to the address; `<3` can too, as below.
- `]`, `*`, `$` or `@` typed right after a URL with a path can still join the address.
- Any smiley inside `^sup^` or `~sub~` reads as an emoji, as before.
- A smiley inside a sidenote or marginal note reads as an emoji even escaped, as before.
- A smiley against a URL stays an emoji in a sidebar holding its own marker (`$` left, `@` right) earlier.
- In text ending in `!` before a link or span, or `+`/`!` before a note, URL smileys behave as before.
- After an earlier smiley set apart by formatting, or an image description holding one, URL smileys behave as before.
- A paragraph repeating one address more than eight times, also in code or a link, may save later ones as `[url](url)`.

## v4.1.1 — Saves That Read Back

### 🐛 Bug Fixes

- `<svg/>` and `<math/>` in a task label no longer hide later checkboxes.
- Formatting works in a definition one blank line below its term.
- `plugins.disabled` written as a list no longer breaks the extension.
- With `attrs` disabled, the Visual Editor treats `{…}` as text.
- Saving no longer merges blocks that an edit brought together (an emptied list item under a paragraph, two lists or tables).
- `==[a]{.x} b==` and similar nested marks are saved as one run.
- `5$:)` no longer saves as an emoji.

### ⚠️ Limits

- An emptied quote loses its `{.q}` when saved empty.
- `{…}` right after `*em*` inside a note is refused.
- A smiley right at a linked URL still reads as an emoji.
- An edited list is written with one space after its marker.

## v4.1.0 — Exports Embed by Rule, Toggles Rebuilt

### ✨ New Features

- New setting `markdownExtended.export.embedFiles` (`workspace`, `machine`, `none`) decides which local files an export embeds.
- The default `workspace` embeds only files inside the workspace; set `machine` to embed images from elsewhere, as before.
- `markdownExtended.export.puppeteerExecutable` is no longer read from untrusted workspaces.

### 🐛 Bug Fixes

- A heading's explicit `{#id}` is its id in the preview and exports; its slug still works as a second anchor.
- `[[TOC]]` entries link to the ids the preview gives its headings ([qjebbs/vscode-markdown-extended#70](https://github.com/qjebbs/vscode-markdown-extended/issues/70)).
- `@[toc]` makes a table of contents again ([qjebbs/vscode-markdown-extended#174](https://github.com/qjebbs/vscode-markdown-extended/issues/174)).
- The Visual Editor's table of contents lists the document's headings.
- A table with two rowspan columns keeps every row ([#3](https://github.com/JackDMF/vscode-markdown-extended/issues/3)).
- Format toggles act on exactly the selection (CJK text too), at every cursor, and skip markers in code and escapes ([qjebbs/vscode-markdown-extended#113](https://github.com/qjebbs/vscode-markdown-extended/issues/113), [#173](https://github.com/qjebbs/vscode-markdown-extended/issues/173), [#180](https://github.com/qjebbs/vscode-markdown-extended/issues/180)).
- A missing or unsupported image no longer fails the export; `.webp` and `.avif` images are embedded ([qjebbs/vscode-markdown-extended#157](https://github.com/qjebbs/vscode-markdown-extended/issues/157)).
- A stylesheet linked with `<link>` now applies to PDF, PNG and JPG exports ([qjebbs/vscode-markdown-extended#162](https://github.com/qjebbs/vscode-markdown-extended/issues/162)).
- An embedded stylesheet's unreadable `url()` is kept as written instead of `url("null")`.
- Headings of the same text get distinct ids (`setup`, `setup-1`) in exports.
- A link to a media file no longer blanks the preview ([qjebbs/vscode-markdown-extended#154](https://github.com/qjebbs/vscode-markdown-extended/issues/154)).
- A link to a `.ts` file is a link, not a video ([qjebbs/vscode-markdown-extended#177](https://github.com/qjebbs/vscode-markdown-extended/issues/177)).
- A checkbox keeps the text before it; a task's label covers its whole text, formatting included.
- Admonition titles may contain quotes, and `{…}` after a quoted title styles the title bar ([qjebbs/vscode-markdown-extended#131](https://github.com/qjebbs/vscode-markdown-extended/issues/131)).
- A tab-indented admonition no longer cuts the start of a table inside it ([qjebbs/vscode-markdown-extended#110](https://github.com/qjebbs/vscode-markdown-extended/issues/110)).
- `@{height = 65}` and other braces with a spaced `=` are shown as text ([qjebbs/vscode-markdown-extended#146](https://github.com/qjebbs/vscode-markdown-extended/issues/146)).
- A container's `{…}` attributes reach its `div`, and its info is escaped once ([qjebbs/vscode-markdown-extended#126](https://github.com/qjebbs/vscode-markdown-extended/issues/126)).
- **Format Table** and **Paste as Table** line up columns holding emoji and other wide characters ([qjebbs/vscode-markdown-extended#149](https://github.com/qjebbs/vscode-markdown-extended/issues/149)).
- Email addresses, prices such as `$5` and markers inside code no longer create sidebars.
- In the Visual Editor, a copied or split block keeps its classes and drops only its id.
- A wiki embed `![[…]]` is no longer rendered as a key, and the Visual Editor keeps it intact ([qjebbs/vscode-markdown-extended#168](https://github.com/qjebbs/vscode-markdown-extended/issues/168)).
- The Visual Editor keeps escapes in image alt text and no longer turns a link after `\\!` into an image.

### ⚠️ Limits

- With `markdown.validate.enabled`, VS Code reports links to an explicit `{#id}` as missing headings.
- The Visual Editor's table of contents updates only after reopening or a change in the text editor.
- A copied block inside a quote, a container or an image still keeps its id.
- With `markdown.math.enabled` on (the default), the Visual Editor cannot make left sidebars.

## v4.0.0 — The Visual Editor

*2026-09-30*

### ✨ New Features

- **Markdown: Open in Visual Editor** edits a `.md` file as rich text and saves untouched blocks byte for byte.
- Changed paragraphs keep their wrap width, or use `markdownExtended.editor.wrapColumn` (default `90`).
- Undo, dirty state and saving stay VS Code's; changes from the text editor appear live.
- Renders like the preview, other extensions' plugins included; blocks it cannot edit richly are edited as source.
- A toolbar and a selection bubble for marks, block types, notes, admonitions, containers and tables.
- Highlight, super- and subscript, strikethrough, keys, sidenotes, marginal notes and sidebars are edited in place.
- Each note, link, image and block has a small bar with its actions; `Alt+Enter` opens it.
- Admonitions, containers and `{…}` attributes are edited in place; **Formatting → Attributes…** sets a block's `{…}`.
- Pipe tables are edited as tables, with row, column and alignment commands.
- Front matter is an editable **Properties** panel that keeps the YAML's formatting.
- `Ctrl+K`, **Insert → Link…** and **Insert → Image…** complete paths and headings; pasted and dropped images are saved beside the document.
- `Ctrl+click` follows a link, to a heading in another document too.
- Other extensions' code lenses, code actions, completion, problems and hovers appear in the Visual Editor; `markdownExtended.editor.codeLenses` turns lenses off.
- **Insert → Include…** and **Change snippet…** insert snippets offered by other extensions such as Req Explorer.
- Other extensions can ask for the focused Visual Editor and its caret (`visualEditor.active()`).
- The toolbar, menus and bars follow the VS Code theme.

### 🐛 Fixes

- The PDF's print date follows VS Code's display language; `markdownExtended.pdf.locale` overrides it.
- **Format Table** no longer breaks the delimiter of a narrow aligned column.
- Images keep their alt text in the preview and exports.
- **Export to File** exports the active document, also from the Visual Editor.

### ⚠️ Limits

- multimd tables, raw HTML, footnotes, definition and task lists, and nested tables are edited as source.
- Containers and admonitions nest one level deep in the Visual Editor.
- With `markdown.math.enabled` on (the default), `$…$` is math, not a left sidebar.
- Images outside the document's folder and the workspace do not show in the Visual Editor.
- The Visual Editor is desktop only.
- A lens or action that works on the active text editor may do nothing in the Visual Editor.

## v3.1.3 — Customisable Notes, Leaner Package

### 🐛 Fixes

- `--md-note-surface` and `--md-note-border` now take effect and can be overridden; `--md-note-border-width` and `--md-note-padding` added.

### 📦 Packaging

- Smaller package: files for other editors and contributor documents are no longer shipped.

### 📖 Documentation

- README: admonitions without a title, and what a custom stylesheet inherits from the built-in one.

## v3.1.2 — Sidenote Styles Actually Ship

### 🐛 Fixes

- Sidenote and sidebar styles now load in the preview and exports.
- Notes are readable in dark-theme PDF exports.
- Floated notes no longer overflow the page in HTML exports.

### 🧹 Internal

- Notes float in the margin from 1280px wide and stack below; note custom properties renamed (`--md-note-font-size`, `--md-note-opacity`).

### 📖 Documentation

- README screenshots are generated from its own examples; new note and syntax screenshots; container example fixed for Bootstrap 5.

## v3.1.1 — Multiline Bold & Italic

### ✨ New Features

- Bold and italic spanning soft line breaks are highlighted in the editor.

### ⚠️ Limits

- An unpaired `**` or `_` highlights to the end of its paragraph.
- Multiline emphasis is not highlighted inside quotes, lists and tables.

### 🧹 Internal

- Internal: grammar tests and test fixes for Windows.

## v3.1.0 — Syntax Highlighting Rebuilt

### 🐛 Fixes

- Single-character marks such as `^4^` and `==M==` are highlighted.
- Superscript highlighting no longer swallows the rest of the line.
- An inline mark at the start of a paragraph no longer breaks that line's highlighting.
- Admonition bodies are fully highlighted.
- `==mark==` is highlighted by the renderer's rules; `a == b == c` stays plain.
- `[[toc]]` is recognised in any case and not highlighted as a key.

### ✨ New Features

- Highlighting for `{.class #id}` attributes, `:::` containers, footnote and abbreviation definitions and definition lists.

### 🧹 Internal

- Extension marks are no longer highlighted inside code, math or front matter.

## v3.0.3 — Folder Settings in Multi-Root Workspaces

### 🐛 Fixes

- Export settings can be set per folder in a multi-root workspace.

## v3.0.2 — Export Location

### ✨ New Features

- `markdownExtended.export.outDirName` accepts an absolute path.

### 🧹 Internal

- Internal: test runner update and release tooling.

## v3.0.1 — Maintenance

### 🐛 Fixes

- Exports no longer stall on slow remote resources.

### 🧹 Internal

- Internal: dependency updates and test runner fixes.

## v3.0.0 — Onboarding, Accessible Exports & Settings Overhaul

### ✨ New Features

- A **Getting Started** walkthrough for the extended syntax and exports.
- An accessible built-in export stylesheet (light and dark); `markdownExtended.export.defaultStyles` turns it off.
- Settings regrouped under `pdf.*`, `image.*`, `export.*`, `plugins.*` and `toc.*`.
- PDF size and margins accept CSS lengths only; image quality is 0–100.

### ⚠️ Breaking Changes

- Old flat setting keys are deprecated but still read, e.g. `pdfFormat` → `pdf.format`, `disabledPlugins` → `plugins.disabled`.
- Exports without `markdown.styles` use the built-in stylesheet instead of unstyled output.

### 🧹 Internal

- Internal: exporter and service refactoring.

## v2.9.0 - Friendlier Exports

### ✨ New Features / Improvements

- After an export, **Open** and **Reveal in Finder / File Explorer** are offered.
- The first PDF/PNG/JPG export asks before downloading Chromium (~170 MB).

### 🧹 Internal / Code Quality

- Internal: code cleanup; a cancelled action is no longer reported as an error.

## v2.8.0 - Dark Exports & Global Asset De-duplication

### ✨ New Features

- `markdownExtended.exportTheme` exports in `light`, `dark` or `auto` theme.

### 🐛 Bug Fixes / Improvements

- Assets shared by several extensions (e.g. `katex.min.css`) are embedded only once.

## v2.7.2 - Export Style Regression Fix

### 🐛 Bug Fixes

- Styles from other extensions are no longer dropped from exports when they share a file name.

## v2.7.1 - Maintenance

### 🐛 Bug Fixes / Improvements

- README marketplace badges fixed.

## v2.7.0 - Mermaid Diagrams in Exports & Smaller HTML

### ✨ New Features

- Mermaid diagrams render in HTML, PDF and PNG exports.

### 🐛 Bug Fixes / Improvements

- Smaller exports: assets several extensions contribute are embedded once.

## v2.6.0 - Attributes on Sidebars & Notes

### ✨ New Features

- `{.class #id}` attributes work on sidenotes, marginal notes and sidebars, e.g. `++ref|note++{.my-class}`.

## v2.5.1 - Front Matter Preview Fix

### 🐛 Bug Fixes

- Fixed "Failed to parse frontmatter" in the preview; `markdown.preview.frontMatter` controls its display.

## v2.5.0 - CJK-Friendly Emphasis

### ✨ New Features

- `**bold**` and `*italic*` work next to Chinese, Japanese and Korean text ([PR #1](https://github.com/JackDMF/vscode-markdown-extended/pull/1)).

## v2.4.0 - YAML Front Matter Support

### ✨ New Features

- YAML front matter is no longer rendered in the preview or exports.

## v2.3.0 - Web Extension Support (vscode.dev)

### ✨ New Features

- Works in vscode.dev and github.dev: preview and editing commands; export stays desktop only.

## v2.2.4 - Fix PDF Export on macOS

### 🐛 Bug Fixes

- Fixed a PDF export crash on macOS caused by other extensions' contributed styles.
- An image with an empty source is no longer embedded (PR #2 by @GhostOps77).

## v2.2.3 - Critical Bug Fix: Extension Host Crash

### 🐛 Bug Fixes

- Fixed an extension host crash on note and sidebar syntax such as `@(3 Min.)@`.

## v2.2.2 - PDF Layout Fixes

### 🖨️ Printing Improvements

- PDF exports match the preview's width and honour `@page` rules in your stylesheets.

## v2.2.1 - Logo Updates for Marketplace

### 🎨 Visual Improvements

- New extension logo.

## v2.2.0 - Performance & Architecture: Proper Plugin Bundling

### ✨ Major Improvements

- Package 90% smaller, and the extension activates faster.

## v2.1.4 - Critical Fix: Include markdown-it plugin dependencies

### 🐛 Critical Bug Fix

- The markdown-it plugins are included in the package again.

## v2.1.3 - Republish of v2.1.2 Fix

- Republish of v2.1.2; no changes.

## v2.1.2 - Critical Bugfix: Markdown-it Plugins Not Loading

### 🐛 Critical Bug Fixes

- Admonitions, superscript, subscript and the other plugins work again.

## v2.1.1 - Patch Release: License and Repository Updates

### 📝 Updates

- License and repository links updated for the new maintainer.

## v2.1.0 - Feature Release: Enhanced Syntax Support

### ✨ New Features

- Syntax highlighting improvements and theme colours for notes and sidebars (`markdown.sidenote.textColor` and siblings).

### 🔧 Improvements

- Dependency updates and performance improvements.

## v2.0.1 - Patch Release: Stability and Bug Fixes

### 🐛 Bug Fixes

- Stability and compatibility fixes.

## v2.0.0 - Major Release: Complete Architecture Modernization

### 🏗️ Architecture Improvements

- Internal: full TypeScript rewrite with unit tests.

### ✨ New Features

- Sidenotes `++ref|note++`, marginal notes `!!ref|note!!`, left sidebars `$…$` and right sidebars `@…@`.

### 🔧 Plugin Updates

- Superscript, subscript and underline plugins replaced (`markdown-it-sup-alt`, `markdown-it-sub-alt`, `markdown-it-ib`); bracketed spans added.

### 📚 Documentation

- README rewritten.

### 🐛 Bug Fixes

- Fixed plugin loading errors (`e.apply is not a function`).

### 🔄 Breaking Changes

- Requires VS Code 1.80.0 or later.
- Some plugin names in settings changed; see the README.

### 🙏 Credits

- Original extension by **qjebbs**.

## v1.1.4

- Add `markdown-it-bracketed-spans`, **@zeedif**, [#160](https://github.com/qjebbs/vscode-markdown-extended/pull/160)

## v1.1.3

- Fix: Get chromium revision for puppeteer downloading

## v1.1.2

- Improvement: Tables formatting preserves table indentation and handle code spans, **@rbolsius**, [#139](https://github.com/qjebbs/vscode-markdown-extended/pull/139)
- Fix: Remove workaround introduced for [#98](https://github.com/qjebbs/vscode-markdown-extended/issues/98)

## v1.1.1

- Apply python markdown spec for admonitions, [#123](https://github.com/qjebbs/vscode-markdown-extended/pull/123)
- Fix [#125](https://github.com/qjebbs/vscode-markdown-extended/pull/125)

## v1.1.0

- Add snippets ([#116](https://github.com/qjebbs/vscode-markdown-extended/pull/116)), thanks to [heartacker](https://github.com/heartacker)
- Fix admonitions ([#122](https://github.com/qjebbs/vscode-markdown-extended/pull/122)), thanks to [Juan Cruz](https://github.com/IJuanI)
- Remove default key bindings; use the command palette, snippets or your own bindings. [#111](https://github.com/qjebbs/vscode-markdown-extended/pull/111)[#112](https://github.com/qjebbs/vscode-markdown-extended/pull/112)[#118](https://github.com/qjebbs/vscode-markdown-extended/pull/118)

## v1.0.19

- Add workaround for markdown export crashing. [#98](https://github.com/qjebbs/vscode-markdown-extended/issues/98)

## v1.0.18

- Improvement: Top margin inside admonition

## v1.0.17

- Fix: Export files not in workspace

## v1.0.16

- Improvement: Add ability to disable integrated plugin. [#72](https://github.com/qjebbs/vscode-markdown-extended/issues/72)

## v1.0.15

- Fix: Cannot embed img not in workspace folder, [#71](https://github.com/qjebbs/vscode-markdown-extended/issues/71)

## v1.0.14

- Improvement: Change `Move Columns` key bindings to `ctrl+shift+t ctrl+shift+left/right`, [#68](https://github.com/qjebbs/vscode-markdown-extended/issues/68)

## v1.0.13

- Improvement: Change `Move Columns` key bindings to `ctrl+shift+left/right`, [#57](https://github.com/qjebbs/vscode-markdown-extended/issues/57), [#59](https://github.com/qjebbs/vscode-markdown-extended/issues/57)

## v1.0.12

- Improvement: No 'open preview first' prompt
- Fix: Update package markdown-it-attrs, [#58](https://github.com/qjebbs/vscode-markdown-extended/issues/58)

## v1.0.11

- Add support for `markdown-it-html5-embed`, [#49](https://github.com/qjebbs/vscode-markdown-extended/issues/49)
- Fix: Rowspan of `markdown-it-multimd-table` doesn't work, [#50](https://github.com/qjebbs/vscode-markdown-extended/issues/50)
- Improved CJK table format.
- Admonition style optimize

## v1.0.10

- Fix: Format with Japanese Hiragana characters [#51](https://github.com/qjebbs/vscode-markdown-extended/issues/51). Thanks to [TadaoYamaoka](https://github.com/TadaoYamaoka).

## v1.0.9

- Fix: Embeds files referred by url() in css, fix [#48](https://github.com/qjebbs/vscode-markdown-extended/issues/48).

## v1.0.8

- Add plugin markdown-it-emoji, solve [#39](https://github.com/qjebbs/vscode-markdown-extended/issues/39).
- Add plugin markdown-it-multimd-table, with table formatting, solve [#42](https://github.com/qjebbs/vscode-markdown-extended/issues/42).

## v1.0.7

- Fix: Cannot embed images if folder or path has special character, solve [#40](https://github.com/qjebbs/vscode-markdown-extended/issues/40).

## v1.0.6

- Add plugin markdown-it-mark and command `Toggle Mark`

## v1.0.5

- Fix: Cannot export workspace, solve [#34](https://github.com/qjebbs/vscode-markdown-extended/issues/34).

## v1.0.4

- Fix: Wrong column width when format table with Fullwidth Comma & CJK Comma. Thanks to [FourLeafTec](https://github.com/qjebbs/vscode-markdown-extended/pull/31)
- Fix: Update package `markdown-it-kbd`, solve [#32](https://github.com/qjebbs/vscode-markdown-extended/issues/32).

## v1.0.3

- Improvement: Copy stripped HTML, solve [#27](https://github.com/qjebbs/vscode-markdown-extended/issues/27).

## v1.0.2

- Improvement: Many optimizations to export feature
- Improvement: Keep blank lines when doing toggleBlockQuote, fix [#24](https://github.com/qjebbs/vscode-markdown-extended/issues/24).

## v1.0.1 (v1.0.0)

- New Feature: export with contribute scripts embedded (e.g. mermaid), solve [#23](https://github.com/qjebbs/vscode-markdown-extended/issues/23).

## v0.9.6

- Improvement: Improve format table with CJK characters, solve [#22](https://github.com/qjebbs/vscode-markdown-extended/issues/22)

## v0.9.5

- Fix: Correct title spelling of markdown

## v0.9.4

- Fix: export non-workfolder file, solve [#19](https://github.com/qjebbs/vscode-markdown-extended/issues/19)

## v0.9.3

- Improvement: Add export report.
- Improvement: Message & titles optimize.

## v0.9.2

- Improvement: configurable toc level, solve [#18](https://github.com/qjebbs/vscode-markdown-extended/issues/18)

## v0.9.1

- Improvement: new admonition implement, support nesting and more qualifiers.
- Improvement: better padding and align of table formatting
- Fix: paste as table problem if "-" in the second row
- Improvement: update exportWorkspace command title

## v0.8.1

- Fix: Wait for external resources before export to pdf/png/jpg, resolve [#14](https://github.com/qjebbs/vscode-markdown-extended/issues/14)

## v0.8.0

- New Feature: markdown-it-admonition support

## v0.7.1

- New Feature: Workspace export support
- New Setting: Customize puppeteer executable

## v0.6.1

- Fix: copy html issue.

## v0.6.0

- Improvement: Switch to puppeteer as PDF/PNG/JPG exporter
- Improvement: Remove some helper menus

## v0.5.6

- Fix: Active document detect in export command, fix [#10](https://github.com/qjebbs/vscode-markdown-extended/issues/10)

## v0.5.5

- Improvement: add `markdown-it-deflist`, resolve [#9](https://github.com/qjebbs/vscode-markdown-extended/issues/9)
- Improvement: add styles for `<kbd>`.

## v0.5.4

- Improvement: Export html as self contained file.

## v0.5.3

- Fix: Small bug fixes.

## v0.5.2

- Improvement: Keep selections after table editing and after toggling format.

## v0.5.1

- New Feature: Add move table columns commands.

## v0.5.0

- New Feature: Add many format and table editing helpers.

## v0.4.4

- Improvement: Many export optimizations.

## v0.4.3

- Fix: Wrong anchor element.
- Improvement: Precisely customize phantom pdf border, 1cm by default.

## v0.4.2

- Fix: Parsing meta data
- Fix: Resources not fully processed

## v0.4.1

- Fix: Run phantomjs with no meta config

## v0.4.0

- New Feature: Exporters & Exporter Configurations support, [#8](https://github.com/qjebbs/vscode-markdown-extended/issues/8).
- Fix: missing resources in exported filed, [#7](https://github.com/qjebbs/vscode-markdown-extended/issues/7).

## v0.3.0

- New Feature: Writing anchor links consistent to heading texts.
- Fix: TOC anchor.
- Fix: Read config for unsaved file.

## v0.2.2

- Fix: User styles config logic.

## v0.2.1

- Improvement: Support user styles (`markdown.styles`) when export.

## v0.2.0

- New Feature: Paste as Markdown Table.
- New Feature: Format Table.
- Fix: Copy HTML failed if content contains non-English characters.

## v0.1.4

- Catch command errors to panel
- Prompt open preview before copy or export, avoiding undefined render
- Validate phantomPath
- Fix read previewStyles of undefined, solve [#2](https://github.com/qjebbs/vscode-markdown-extended/issues/2)

## v0.1.3

- Add plugin markdown-it-container

## v0.1.2

- Configurable phantom path

## v0.1.1

- New Feature: Export to PNG / JPEG

## v0.1.0

- New Feature: Export to PDF

## v0.0.3

- Improvement: Copy HTML of selection if there was.
- Fix: replace `markdown-it-toc` with `markdown-it-table-of-contents`, since the former breaks the header anchor.

## v0.0.2

- Fix extension loading problem

## v0.0.1

- Initial release
