## Extended syntax cheat-sheet

| Write | Result |
|---|---|
| `==highlight==` | highlighted / marked text |
| `_underline_` | underlined text |
| `H~2~O` · `x^2^` | subscript / superscript |
| `<kbd>Ctrl</kbd>` | a keyboard key |
| `[[toc]]` | a table of contents |
| `[^1]` … `[^1]: note` | a footnote |
| `*[HTML]: HyperText…` | an abbreviation tooltip |
| `**text**{style="color:red"}` | inline attributes, also `{.class #id}` |

**Admonitions** — `!!! type` (types include note, tip, info, success, question, warning, danger, example, quote):

```
!!! warning
    Watch your step.
```

**Containers** — fenced blocks with a class:

```
::: tip
Boxed, styled content.
:::
```

**Definition lists**:

```
Term
: Definition of the term
```

Type `admonition`, `container`, `kbd`, `footnote`, `abbr`, `table`, or `attr` and press <kbd>Tab</kbd> to expand a snippet. Prefer to disable a plugin? See `markdownExtended.plugins.disabled`.
