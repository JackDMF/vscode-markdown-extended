## Tables and formatting

**Paste as Table** — copy rows from Excel, Google Sheets or any web table, then
run it. Comma-separated clipboard text goes in:

```
Command,Shortcut,Notes
Format Table,Ctrl+Shift+T,tidies alignment
```

and an aligned Markdown table comes out, first row as the header:

```
| Command      | Shortcut     | Notes            |
| ------------ | ------------ | ---------------- |
| Format Table | Ctrl+Shift+T | tidies alignment |
```

**Format Table** re-aligns the table under the cursor, padding each cell to its
column width and keeping every alignment marker (`:--`, `:--:`, `--:`).

**Add / Delete / Move Columns and Rows** act on the table under the cursor and
re-align it afterwards, so it never drifts out of shape.

**Toggle formatting** — bold, italics, underline, mark, strikethrough, inline
code, code block, block quote, superscript, subscript, and ordered or unordered
lists, all from the command palette.

No keyboard shortcuts are bound by default: the old defaults clashed with other
extensions on some platforms. Search "Markdown" in the command palette, use the
bundled snippets, or bind your own in **Preferences: Open Keyboard Shortcuts**.
