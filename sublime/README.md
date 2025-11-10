# Markdown Extended for Sublime Text & Textastic

Syntax highlighting for Markdown Extended - brings extended markdown features from the VS Code extension to Sublime Text with **full nesting support**.

**Also compatible with Textastic for iOS!** See [TEXTASTIC_INSTALL.md](TEXTASTIC_INSTALL.md) for installation instructions.

## Features

### **Emphasis (markdown-it-ib)**
- `*italic*` → Gold (#ffb400)
- `_underline_` → Green (#00c76a)
- `**bold**` → Purple (#6f4dff)
- `__strong__` → Cyan (#00aee8)
- `~~strikethrough~~` → Pink/Red (#ff0f6e)

### **Annotations**
- `++reference|note++` - Sidenotes (purple/orange)
- `!!reference|note!!` - Marginal notes (orange/purple)
- `$sidebar$` - Left sidebar (green)
- `@sidebar@` - Right sidebar (purple)

### **Formatting**
- `==highlight==` - Highlighted text (orange)
- `[[Key]]` - Keyboard shortcuts
- `^super^` - Superscript
- `~sub~` - Subscript

### **Block Elements**
- `!!! note "Title"` - Admonitions (note, warning, danger, success, info, tip, etc.)
- `[[TOC]]` - Table of contents
- `[^1]` - Footnote references
- `- [x]` - Checkboxes

### **Nesting Support (v4)**
All emphasis patterns support nesting, except same-pattern recursion:

✅ `*italic with ++sidenote|note with *italic* inside++*`  
✅ `++reference|note with *italic* and _underline_++`  
✅ `**bold with ==highlight== and ~~strike~~**`  
❌ `*italic with *nested italic**` (prevented by design)

## Installation

### Automated (Recommended)

```powershell
cd sublime
.\Install.ps1
```

Then:
1. **Restart Sublime Text** (completely close and reopen)
2. Open a `.md` file
3. **Select syntax**: View → Syntax → Markdown Extended
4. **Select color scheme**: Preferences → Select Color Scheme → Markdown Extended (or Dark)

### Manual

1. Copy these files to `%APPDATA%\Sublime Text\Packages\User`:
   - `Markdown Extended.sublime-syntax`
   - `Markdown Extended.sublime-color-scheme`
   - `Markdown Extended Dark.sublime-color-scheme`

2. Restart Sublime Text and select the syntax/color scheme as above.

## Usage

Open `TEST.md` or `TESTS.md` to see all patterns in action.

### Examples

```markdown
*italic with ++sidenote|note with *nested italic*++*

++reference|note with _underline_ and **bold**++

**bold with ==highlight== and ~~strikethrough~~**

!!! note "Admonition Title"
    Content with *emphasis* inside.

[[TOC]]
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No highlighting | Check syntax is "Markdown Extended" (bottom-right corner) |
| Wrong colors | Select "Markdown Extended" color scheme |
| Nesting doesn't work | Verify file header shows `version: 4` |
| Patterns incomplete | Restart Sublime Text |

## Technical Details

- **Version**: 4 (context-based nesting)
- **Syntax Engine**: Push/pop contexts for nested patterns
- **Color Source**: Styles.css from original extension
- **Recursion Prevention**: Each pattern excludes itself from nested contexts

## Files

- `Markdown Extended.sublime-syntax` - Main syntax definition (359 lines)
- `Markdown Extended.sublime-color-scheme` - Light theme
- `Markdown Extended Dark.sublime-color-scheme` - Dark theme
- `Install.ps1` - Automated installer
- `TEST.md` - Basic test file
- `TESTS.md` - Comprehensive nesting test suite
- `README.md` - This file

## License

Based on VS Code Markdown Extended extension.

## Credits

- **Original Extension**: JackDMF
- **Repository**: https://github.com/JackDMF/vscode-markdown-extended

---

**Enjoy extended markdown in Sublime Text!** 🎨
