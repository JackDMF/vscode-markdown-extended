# Change Log

## Unreleased

- An `@` right after a letter or digit (`a@b.de`, `Text@`) is saved as written, not as `\@`; it opens no sidebar.
- A list made in the visual editor (typing `- `, `1. ` or from the toolbar) is written tight, without blank lines between items.
- A pasted HTML list whose items hold no paragraphs comes in tight as well.
- Inside quotes, admonitions and containers, a heading, quote or list the file wrote straight under the block before it is written back so, without a new blank line.

## v4.10.0 — Says Why, Keeps Its Place

- A menu card's syntax line and reason keep the editor's font, whatever font a stylesheet gives the document.
- Refusals share one look — an amber bar, what happened, what to do — at the caret, field or control.
- A refusal goes at the next caret move, edit, click, focus or mode change, or changed reloaded text.
- The same refusal again restarts its time and is announced again; longer messages stay longer, up to ten seconds.
- A held key's repeated refusal is announced once, however long it is held.
- Refusals stand outside the page body, so user stylesheets no longer narrow them; at most 44 characters wide.
- In a narrow window a refused menu entry says why in a row right under it.
- A refusal row inside a menu stays until the menu closes or you press again; entries never jump.
- Below 600 px, focus outside the text only dims the formatting tools; pressing one says why.
- Pressing a locked tool says why under it, e.g. "Formatting is off while editing source — Ctrl+Enter applies".
- A refused bar verb or menu entry says why where it was pressed, instead of doing nothing.
- While an export runs, Export says "One export at a time"; pressing a waiting format says when to retry.
- The source box has Apply and Cancel buttons; Cancel never applies on the way out.
- Refusal messages reworded in plain language; values you typed appear in code font, buttons in quotes.
- Screen readers hear each hint through one status region, once.
- Every source block shows a muted "source" chip at its top-right, in the editor only, never copied or exported.
- Raw source and tall blocks keep the chip in sight while scrolling; beside right notes or tables it stands above.
- The chip takes the page's own text colour and leaves a stylesheet's own ::after labels alone.
- A source block's bar names why: "Source · has a footnote", "· definition list", "· footnote text" and more.
- Screen readers hear the reason as the block's name, and on selection the reason with Alt+Enter.
- Typing, pasting, dictation, IME, Ctrl+D/H or Delete over a selected source block is refused, naming why.
- Backspace or Delete beside a source block selects it first; cut still takes it.
- Replacing a selection that spans a source block says "Source block removed" with the undo key.
- PNG and JPEG export no longer hangs on macOS while the display sleeps.
- Nested blocks show a breadcrumb bar, e.g. "List › List item"; each part opens its own attributes field.
- Bar and Block type menu now name the same block: in a list, the list item.
- A block's bar shows its literal, e.g. "Quote {.warning}", and offers Remove attributes.
- Remove names the part: "Remove attributes of List", or a menu when both parts carry one.
- Block type offers the outer block too, e.g. "Attributes of List…", each with its own preview card.
- Headings inside quotes, admonitions and containers take attributes; an admonition offers "Attributes of Heading…".
- The outer part's field scrolls into view, and the scroll returns when it closes.
- A list inside a quote is refused attributes with a reason, instead of losing them on save.
- Admonition, container and quote refusals now say correctly where attributes go.
- An open attributes field stays open, with what you typed, when the file changes above it.
- In narrow windows a two-part bar keeps its verbs' names; the outer part moves into "…".
- A two-part bar never runs past the window: its "…" stays inside, the literals and a title part give way first.
- On two-part bars the current part's verbs come first, e.g. "Attributes of Heading… · Edit title… · Type".
- An admonition's bar for its heading stands at the heading's line, not under the whole box.
- A list inside a quote with attributes shows "Quote › List item"; a list item starting with a heading keeps its bar.
- Block changed elsewhere: an open attributes field refuses Enter, keeping your text; block deleted: it closes, saying so.
- A change elsewhere beside the field's item or heading keeps the field and caret; Enter sets it as asked.
- Remove ▾ says what stays for each part ("item stays"); tooltips name the part and say "Enter to set".
- Fields keep a readable width beside a user stylesheet's narrow column or margin.
- Inline fields opened from a bar stand where the bar does.
- A source block made by an admonition title's or a quote paragraph's {…} names it and says what it does.
- Sidenotes, marginal notes and sidebars keep a {…} after their closing marker, e.g. !!Tempo|…!!{.tipp}, and open as rich text.
- Note and sidebar bars show the literal, e.g. "Marginal note {.tipp}", with Attributes… and "Remove attributes, keep note".
- A note's attributes field opens at its reference, never at the text in the margin.
- Formatting's attributes entry rests as "Inline attributes…" and names a note at the caret, e.g. "Attributes of Marginal note…".
- Convert to sidenote or marginal note, and a sidebar's Move left or right, keep the attributes.
- A caret or selection in a note's text targets the note, also on marked words; a mark with its own {…} still wins.
- Bars may reach into the margin where no note sits beside them, before they shorten their words.
- Bars and fields stand below their line unless only below holds text; text on both sides keeps them below.
- A caret in a margin note keeps layers off its margin line only, not the column beside it.
- Selecting words of a note in the margin shows the bubble above that line, never over the note.
- A note or sidebar copied in the editor pastes with its attributes, as a note, not as a span.
- A copied span such as [x]{.left-sidebar} pastes back as a span, not as a sidebar or note.
- Source blocks name a holder's attributes they cannot keep, e.g. "has a marginal note with attributes".

## v4.9.0 — Layers That Keep Their Place

- The floating layers — bars, bubble, fields, menus, cards, hints — follow one rule: below, else above.
- The completion list at the caret keeps its own placement for now.
- With text on both sides, an inline object's bar goes above; block bars and the bubble stay below.
- A layer never covers the caret's line, the formatting row or another open layer.
- A layer stands at its object's start and stops at the editor's edge, 4 px short of the margin lane.
- One floating layer at a time: selection shows the bubble, a caret rest the bar, a field replaces its bar.
- The bar hides while you type and returns on a rest; Esc hides it until the caret leaves the object.
- The bubble appears once the selection rests or on mouse-up, not while a keyboard selection grows.
- A layer that just appeared or moved ignores the pointer for 250 ms.
- The preview card stands beside its menu, else below or above it, never over the menu or its entry.
- A bar on a block or selection taller than the window sticks to the window's edge.
- The caret hint keeps clear of open layers and the margin lane, flipping above the caret's line when needed.
- A hovered block shows a cue while another layer is up; its bar shows once the slot is free.
- Menus open below their opener, else above, like every layer; a submenu stands against its entry.
- The formatting row never scrolls: controls that do not fit move into a "…" menu; Export and the count stay.
- Controls leave the row by priority — Annotation, Formatting, Insert, then marks from the right; Block type never.
- A mark in "…" keeps glyph, word, syntax and key; on, a check and a dot on "…" show it.
- Menus moved into "…" open as submenus; "…" names its contents for a screen reader.
- The row's lock note stands in the row: beside the tools, else in the refused tools' place, else short.
- The page no longer moves when the row locks or unlocks.
- A lock nobody ran into says "Outside the text"; the tools give way into "…" for it, else only dim.
- Export busy names the format: "Exporting PDF…", or "PDF…" in a narrow row; the tooltip says it whole.
- The Export face spins while an export runs; a still glyph under reduced motion.
- In the Export menu the running format carries the spinner; the others say which export they wait for.
- A narrow object bar moves verbs into "…": Delete or Remove first, then other extensions' actions, then from the right.
- The verb Alt+Enter focuses never leaves its bar; in "…" every verb has its full label, the destroying one last.
- A bar whose title is hidden still names its object on hover and to a screen reader.
- Admonition bars read "Warning admonition", shortened to "Warning" before the title truncates.
- The selection's bubble never spills past the window: what does not fit moves into its own "…".
- The bubble's "…" shows its controls' own glyphs and closes on a second press, keyboard included.
- Menus in a bar's "…" are named and have no hover; their extra text is their description.
- In a row too narrow for its name, Export shows its icon alone; Block type then cuts its label.
- Export busy shows the format the host runs, even when another was asked for.
- A fenced or indented code block has a bar: Language…, Attributes…, Edit source, Delete code block.
- Language… is a field with completions: this document's languages first, then every language the preview highlights.
- Language… changes only the first word of the fence's info string; the rest and the {…} stay.
- Emptying Language… while other words follow it is refused: Edit source changes the whole line.
- Edit source on a code block edits its opening line — fence, info string, attributes — in the bar.
- An opening line without a fence, or with one shorter than a run inside, is refused with the reason.
- Language… and Attributes… fence an indented block on apply: "Code block fenced — Ctrl+Z".
- Edit source on an indented block opens empty with a ``` placeholder; Enter fences it.
- A code block in a list, quote or container has the bar too; Attributes… there says why not.
- A fenced block shows its language as a muted tag in its top-right corner, in the editor only.
- Alt+Enter with nothing to act on says so in a hint, and the caret stays.
- The caret's table cell carries a ring; its row or column tints only while Row, Column or Align is active.
- A block's field (Language…, Edit source, Attributes) opens under the block at its left edge; a run's at the run.
- Language… takes one word: a space or a brace is refused, and the reason points to Edit source.
- Edit source shows the opening line the file will hold, with the longer fence a ``` line inside needs.
- Only a closing-shaped line inside a fence needs a longer fence; a ```python line does not.
- A language the document names by one word is offered once, not again under its aliases.
- A table verb inside "…" tints its row or column while its entry is focused or its menu open.
- Alt+Enter on an object whose bar cannot show names the object, not "nothing to act on".
- Lenses from other extensions on a code block show in its bar after a caret rest, like on every object.
- Enter on an unchanged opening line, or on a Language… that did not change, rewrites nothing.
- Braces in a fence's info string that were text stay text: only a {…} you type is read as attributes.
- A first word opening with a brace ({r, echo = FALSE}) is no language: no corner tag, none in Language….
- Language… keeps the info string's spacing around the word it replaces; the document's languages count by lowercase.
- Copying a code block no longer carries the editor's language tag.
- The "No actions here" hint fits one line; the fence in an indented block's tooltip is in the code font.
- The Row and Column menus set Delete apart after a divider; the cell's ring no longer matches the focus outline.
- The attributes field draws its braces as a fixed frame; you type only what goes between them.
- A pasted or typed {…} loses its outer braces; a stray brace is dropped on Enter.
- Every attributes field is titled by the element it edits: "Bold · Attributes", "Quote · Attributes", "Span · Attributes".
- A screen reader names the attributes field by that title, from whichever bar opened it.
- The keys line says when Enter removes: "↵ removes .x #y · Esc keeps them".
- A refused value keeps the keys line and shows its reason under the field, in amber; an edit clears it.
- A field with no literal yet shows the placeholder ".class"; an emptied one shows none.
- The Block type menu offers "Attributes of Paragraph…" after a divider, as Formatting does.
- The bubble's {…} tooltip says what it does over plain text: Span with class….
- A refusal names the value as the field shows it: no braces, values in code font, within about 80 characters.
- In a narrow editor a field's keys line moves under the field instead of being cut.
- A field's title never truncates; alone on its row it loses its divider.
- Enter in an unchanged attributes field changes nothing: no rewrite of `{ .a }`, no undo step, no hint.
- In a table cell the Block type menu still opens; only Attributes applies, the types dimmed with the reason.
- The bubble's note and the verbs' tooltips speak the field's terms: `.class #id key=value`, empty removes.

## v4.8.0 — Bars, Labels and Notes That Fit

### ✨ Changes

- Every object bar orders its verbs alike: Open, Edit…, type verbs, Attributes…, Edit source, other extensions' actions, then Remove/Delete.
- Delete destroys, Remove keeps: "Delete image", "Delete emoji", "Delete embed", "Delete note"; "Remove link, keep text".
- The destroying verb stands last on every bar, after a divider.
- Emoji and wiki-embed bars say "Convert to text"; the tooltip names the text it becomes.
- "Delete image", "Delete embed" and "Delete directive" say in their tooltip that the file stays.
- Container bar: "Edit classes…"; admonition bar: "Edit title…" and "Type" with a chevron.
- An image's bar starts with "Open file"; a source block's with "Show in text editor".
- Alt+Enter focuses the first verb that opens in place — never Open, never Delete or Remove.
- A bar with no such verb takes the focus itself; Enter or ↓ moves into its first verb.
- A bar's accessible name says the object, how many actions can be chosen, and "arrow keys to choose".
- Every object bar's undo hint reads alike: "Image deleted — Ctrl+Z", "Link removed — Ctrl+Z", "Emoji converted to text — Ctrl+Z".
- In a narrow editor a verb drops its noun ("Delete", "Edit…"), then the bar's title truncates, down to hidden; verbs never truncate.
- A bar too wide for the text column may stand past it, up to the editor's right edge.
- A removed property's hint reads "lang removed — Ctrl+Z", as the bars' do.
- Req Explorer's front-matter lens is not drawn in the Visual Editor, whose Properties block already shows and folds the front matter.
- Notes move into the margin by available width: from 960 px (one side) or 1200 px (both), inline below.
- The margin lane is reserved beside the column, so a note never leaves the window or scrolls sideways.
- Below the threshold a note reads inline in its sentence: tinted, with a left bar; print keeps the bar.
- A note's reference is wrapped in `.sn-anchor` / `.mn-anchor` with a dotted underline, in both layouts.
- Hovering a reference or its note tints both, so a displaced note finds its reference.
- Stylesheet authors: `:root { --mep-note-lane: 0 }` keeps your own margin layout; `.sn-anchor` carries the underline.
- Stylesheet authors: set `--md-note-width` and gaps on `:root`, not `body`; the margin lane reads them there.
- Note colours derive from the text colour; `--md-note-opacity` mutes by colour, not transparency.
- Stylesheet authors: override note colours, `--md-note-text` and the bar width on `body`, not `:root`.
- In the Visual Editor, adding the first note or removing the last keeps the reference line in place.
- In High Contrast a note is untinted page text; its bar and underline take the contrast border.
- A bar grown past the text column stops short of the notes' margin lane.
- The row's marks say their name, delimiter, element and shortcut in an editor hover, not a native tooltip.
- The row's, bubble's and bars' tooltips are the editor's hover: after a pause, at once on keyboard focus.
- Screen readers hear "Italic, asterisk" and the shortcut; no control of the row, bubble or bars carries a title.
- Menu entries read glyph · word · syntax; the glyph is the real element at its size, never zoomed.
- Block type keeps its drawn labels, without the heading rules; the code block sample stays readable.
- The syntax column truncates first; a word label and a field's title never do.
- Menus divide their groups as the workbench does.
- Insert › Admonition lists the eleven canonical types; "More types…" expands the sixteen aliases in place.
- A menu that scrolls shows it: a shadow at the edge the entries continue under.
- On is fill and border; hover a tint; keyboard focus a ring outside the control; disabled the whole control dimmed.
- The bubble's {…} is never drawn as on; its name says what it targets.
- A bar's title is a small muted label with a divider after it, not a button.
- Properties: "+ Add" on every list and for a new property, named for screen readers.

### 🐛 Fixes

- A click at the top of a narrow editor no longer misses: the lock's reason line appears after the click.
- The Quote and Code block samples in the Block type menu now fit their entries instead of being cut off.

### ⚠️ Limits

- In the Visual Editor, a paragraph opening with a `$left$` sidebar in the margin starts one space in.

## v4.7.0 — Saves That Read Back as Shown

### 🐛 Fixes

- A link address, image path or title holding `\`, `<`, `&` or a line break now saves as shown.
- Text an edit would turn into a code block, a heading or a second paragraph is refused instead of saved.
- A tab or blank line typed at a paragraph's start no longer turns it into a code block.
- A file starting with a `-` list or a rule is no longer saved as front matter.
- A rule as a list item no longer saves as a rule that ends the list.
- Bold given to `foo` in `foo__abc__`, or typing `__init__` or `größe__x__ü`, now saves as shown.
- An edit that would leave the file starting with text read as front matter is refused.
- Span with class refused over emphasis gives the editor's real reason, not a `$` pairing.

### ⚠️ Limits

- A tab or blank line at a paragraph's start is not saved.
- A list or rule at a file's start may be saved with `*`, `+` or `***` instead of `-`/`---`.

## v4.6.0 — Attributes on Every Inline Element

### ✨ Features

- Attributes after inline code, an image, superscript, subscript or a key no longer make their block a source block.
- The editor draws those attributes on the element; an image shows at its `{width=…}` while you edit.
- An image's bar offers **Attributes…**; code, superscript, subscript or a key with attributes gets a bar like emphasis.
- **Formatting → Attributes of Code…** gives the element at the caret attributes: code, a key, a link, bold, an image.
- The entry, the bubble and the bars name an element as the row does: Bold, Italic, Strong, Emphasis.
- A bar of an element with attributes shows them beside its name: **Code {.k}**.
- The block entry is named by its block: **Attributes of Paragraph…**, **Attributes of List item…**, **Attributes of Table…**.
- `Alt+Enter` in code or bold without attributes opens a bar with **Attributes…**; a table's bar adds **Attributes of Bold…**.
- The selection bubble has a `{…}` button: attributes of the element selected, else a span with class.
- A refused attributes field stays open with what you typed and the reason beside it.
- Every bar verb that opens the attributes field is called **Attributes…**.
- Nested marks over the same text now offer the innermost one first; 4.4.0 offered emphasis first.
- Bold, code or another mark applied right beside the same mark with attributes joins it and keeps them.
- An edit the save would write so it reads otherwise — italic or bold swallowed by its neighbour — is refused, not saved.

### ⚠️ Limits

- `{src=…}`, `{alt=…}` and `{title=…}` on an image are its own: written into `(…)`, `alt` dropped.
- A wiki embed's `{…}` (`![[x.png]]{.c}`) stays text.
- A video's `{…}` is kept and drawn in the editor; the preview's video ignores it.
- Two `{…}` after one element are written as one; copying an element with `{#id}` writes the id twice.
- Over exactly the same text (``*`x`*``) only the innermost element's attributes are offered.
- The bar for an element without attributes shows only on `Alt+Enter`, never on its own.

## v4.5.0 — Export From the Editor

### ✨ Features

- The Visual Editor's toolbar has an Export menu: HTML, PDF, PNG or JPEG of the page, unsaved changes included.
- Export works while a source box is open; the box's text is applied first, as before a save.
- The command palette's export names its formats as the menu does: HTML, PDF, PNG image, JPEG image.

### ⚠️ Limits

- One export at a time; a hung Chromium launch keeps the menu on "Exporting…" until the editor is reopened.
- An export at the moment the file changes outside the editor can miss the last edit, as the palette's export does.
- A property still being added with **+ Add property** is not exported until Enter.

## v4.4.0 — Attributes on Links and Emphasis

### ✨ Features

- A link or emphasis with attributes after it (`[Source](…){.source}`, `_✓_{.colorize}`, also `**`, `__`, `~~`, `==`) no longer makes its block a source block; the `{…}` is saved as written.
- The editor draws those attributes on the element, so a stylesheet rule for `a.source` or `em.colorize` applies while you edit.
- A link's bar offers **Attributes…**; emphasis with attributes has a bar with **Edit attributes** and **Remove attributes, keep formatting**.
- Switching `*` for `_`, or extending the emphasis over more text, keeps its attributes.

### ⚠️ Limits

- Attributes on inline code, an image, superscript, subscript or a key still keep their block a source block.
- New attributes on emphasis are added in the text editor; the bar edits only ones it has.
- A `{…}` typed as text right after a link or emphasis is saved escaped (`\{…\}`).
- Splitting or copying a mark with `{#id}` writes the id twice, as for a span.

## v4.3.1 — Boxes That Hold the Bars

### 🐛 Bug Fixes

- While a source box or the properties panel has the focus, the row is off and says why.
- Bold and the other row buttons no longer change hidden text behind an open source box.
- An open box shows no bar for the text selected behind it, nor for blocks under the pointer.
- A source block's bar offers only Show in text editor and Delete block while its own box is open.
- Delete block after emptying a source box no longer deletes the block after it too.
- Edit source tooltips name Cmd+Enter on macOS.

### ⚠️ Limits

- After Esc from the YAML box, the row says "Focus is outside the text" until a second Esc or a click.

## v4.3.0 — Notes That Know Their Letter

### ✨ Features

- Every sidenote (`++text|note++`) carries `data-sn`, its position in its section (1 = a, 27 = aa), so a stylesheet can colour a note by its letter across paragraphs.

## v4.2.0 — Emoji You Can Edit Around

### ✨ Features

- Emoji already in a file (`:)`, `:smile:`) no longer make their paragraph a source block; they are saved as written.
- An emoji an edit would turn back into text, like `:)Z`, becomes that text at once, with a hint offering undo.
- That hint stays while you keep editing the paragraph, until you leave it or undo.
- Click an emoji to select it; its bar offers Edit as text and Remove emoji.
- Arrow keys step over an emoji like a character; Alt+Enter beside one opens its bar.
- A notice such as "Embed is text" or "Removed lang" goes away once you type or undo.
- A refused edit beside an emoji names the emoji and the verbs that can unblock it.
- A refusal already shown is not shown again while it stays.

### 🐛 Bug Fixes

- An `<https://…>` link starting a changed paragraph is no longer saved with a backslash before it.

### ⚠️ Limits

- An emoji inside `^sup^` or `~sub~` still keeps its paragraph a source block.
- A smiley typed in a sidenote or marginal note reads as an emoji even escaped, and opens as one.
- An emoji cannot be made code, superscript or subscript.
- An edit is refused where the editor cannot tell whether an emoji there still reads, as beside a smiley in `^sup^`.
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
