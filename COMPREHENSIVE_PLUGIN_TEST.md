# Comprehensive Plugin Test

This file tests ALL markdown-it plugins that were broken.

## 1. Admonitions (markdown-it-admonition)

!!! note "Note Admonition"
    This should have a **blue** background with an icon.
    It should be styled properly.

!!! warning "Warning Admonition"
    This should have an **orange/yellow** background.

!!! danger "Danger Admonition"
    This should have a **red** background.

!!! tip "Tip Admonition"
    This should have a **green** background.

## 2. Superscript (markdown-it-sup-alt)

- E = mc^2^
- x^2^ + y^2^ = z^2^
- 10^th^ of January
- a^b+c^

## 3. Subscript (markdown-it-sub-alt)

- H~2~O is water
- CO~2~ is carbon dioxide
- CH~4~ is methane
- x~1~ + x~2~ = x~3~

## 4. Abbreviations (markdown-it-abbr)

*[HTML]: Hyper Text Markup Language
*[CSS]: Cascading Style Sheets
*[JS]: JavaScript

HTML, CSS, and JS are web technologies.

## 5. Mark/Highlight (markdown-it-mark)

This is ==highlighted text== in the sentence.
Multiple ==highlights== should ==work==.

## 6. Footnotes (markdown-it-footnote)

Here's a sentence with a footnote[^1].
Another footnote[^2].

[^1]: This is the first footnote content.
[^2]: This is the second footnote content.

## 7. Checkboxes (markdown-it-checkbox)

- [x] Task completed
- [ ] Task pending
- [x] Another done task
- [ ] Another pending task

## 8. Emoji (markdown-it-emoji)

:smile: :heart: :thumbsup: :rocket: :fire: :star:

## 9. Definition List (markdown-it-deflist)

Term 1
:   Definition 1

Term 2
:   Definition 2a
:   Definition 2b

## 10. Container (markdown-it-container)

::: warning
This is a warning container
:::

## 11. Table of Contents (markdown-it-table-of-contents)

[[toc]]

## 12. Attributes (markdown-it-attrs)

This is **bold**{.red}

## 13. Keyboard (markdown-it-kbd)

Press [[Ctrl]]+[[Alt]]+[[Delete]]

---

## Expected Results

All of the above should render correctly:
- ✅ Colored admonition boxes
- ✅ Superscripts rendered small and raised
- ✅ Subscripts rendered small and lowered
- ✅ Abbreviations expandable on hover
- ✅ Highlighted text with background
- ✅ Footnotes with links
- ✅ Checkboxes rendered
- ✅ Emojis displayed
- ✅ Definition lists formatted
- ✅ Containers styled
- ✅ TOC generated
- ✅ Keyboard keys styled
