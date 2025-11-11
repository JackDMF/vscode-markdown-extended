# Markdown Extended - Test File

Test this file to verify syntax highlighting is working correctly.

## Basic Extended Syntax Tests

### Sidenotes
This has a ++reference|sidenote content++ in the middle.
Multiple ++first|note one++ and ++second|note two++ sidenotes.

### Marginal Notes
Text with !!margin|marginal note!! reference.

### Sidebars
Left sidebar: $This is left sidebar content$
Right sidebar: @This is right sidebar content@

### Highlight
This text has ==highlighted portion== in it.
Multiple ==first highlight== and ==second highlight== marks.

### Keyboard
Press [[Ctrl+S]] to save.
Use [[Alt+Tab]] to switch windows.

### Table of Contents
[[TOC]]

### Superscript and Subscript
Date: 21^st^ century
Chemistry: H~2~O and CO~2~

### Footnotes
Here is a footnote[^1] reference.

[^1]: This is the footnote content.

### Abbreviations
*[HTML]: Hyper Text Markup Language
*[CSS]: Cascading Style Sheets

The HTML and CSS specifications.

### Checkboxes
- [ ] Unchecked item
- [x] Checked item

### Attributes
**Bold text**{.important #key style="color:red"}

### Containers
::: note
This is inside a container.
:::

### Admonitions
!!! warning Important Note
    This is an admonition block.
    It can have multiple lines.

---

## If Nothing Is Highlighted

The issue is likely that Sublime Text isn't applying the syntax definition properly. Try these steps:

1. **Verify syntax is active**:
   - Bottom right corner should show "Markdown Extended"
   - If not, click it and select "Markdown Extended"

2. **Reload the window**:
   - View → Reload
   - Or close and reopen Sublime Text

3. **Check syntax file location**:
   - Should be in: `Packages/User/Markdown Extended.sublime-syntax`
   - Run: `Preferences → Browse Packages → User`

4. **Test with simple pattern**:
   - If `==test==` doesn't highlight, the syntax isn't loading
   - If it DOES highlight, complex patterns may need adjustment

5. **Check Sublime Console**:
   - `Ctrl+`` (backtick) or View → Show Console
   - Look for syntax errors

6. **Verify color scheme**:
   - Preferences → Select Color Scheme
   - Choose "Markdown Extended" or "Markdown Extended Dark"

---

## Debugging Steps

If specific patterns don't work:

### Test Pattern by Pattern

++test|sidenote++ - Should be colored
!!test|marginal!! - Should be colored
$sidebar$ - Should be colored
@sidebar@ - Should be colored
==highlight== - Should be highlighted background
[[Ctrl+C]] - Should be styled
^super^ - Should be colored
~sub~ - Should be colored
[[TOC]] - Should be bold/colored

If NONE work → Syntax file not loaded
If SOME work → Pattern regex issue

---

## Expected Visual Results

With "Markdown Extended" color scheme:

- **Sidenotes** (`++ref|note++`): Purple/pink reference, grey italic content
- **Marginal** (`!!ref|note!!`): Orange reference, grey italic content  
- **Sidebars** (`$left$`, `@right@`): Cyan and purple italic
- **Highlight** (`==text==`): Gold/yellow background
- **Keyboard** (`[[Key]]`): Grey bold with border feel
- **Superscript** (`^text^`): Green italic
- **Subscript** (`~text~`): Cyan italic
- **TOC** (`[[TOC]]`): Purple bold
- **Admonitions** (`!!! type`): Blue bold header, grey italic body
- **Footnotes** (`[^1]`): Green bold
- **Checkboxes** (`[x]`): Green bold
- **Attributes** (`{.class}`): Grey italic

If you see NONE of these colors, the color scheme isn't applied.
If you see colors but wrong ones, edit the `.sublime-color-scheme` file.
