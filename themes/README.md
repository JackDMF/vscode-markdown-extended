# Markdown Extended Themes

VS Code color themes for Markdown Extended syntax highlighting.

## Themes

### Markdown Extended Light
- Based on Styles.css light mode colors
- Clean, readable color scheme for extended markdown features
- Matches Sublime Text "Markdown Extended" color scheme

### Markdown Extended Dark
- Based on Styles.css dark mode colors
- Eye-friendly dark theme for extended markdown
- Matches Sublime Text "Markdown Extended Dark" color scheme

## Color Mapping

All colors extracted from `Styles.css`:

| Feature | Light Mode | Dark Mode |
|---------|------------|-----------|
| Italic (*) | #ffb400 gold | #ffd700 gold |
| Underline (_) | #00c76a green | #21e968 green |
| Bold (**) | #6f4dff purple | #9b7bff purple |
| Strong (__) | #00aee8 cyan | #00d9ff cyan |
| Strikethrough (~~) | #ff0f6e pink | #ff2d8a pink |
| Highlight (==) | #ff5a1b orange | #ff7a24 orange |
| Sidenote ref | #6f4dff purple | #9b7bff purple |
| Sidenote note | #ff5a1b orange | #ff7a24 orange |
| Marginal ref | #ff5a1b orange | #ff7a24 orange |
| Marginal note | #6f4dff purple | #9b7bff purple |
| Left sidebar | #00c76a green | #21e968 green |
| Right sidebar | #6f4dff purple | #9b7bff purple |
| TOC | #6f4dff purple | #9b7bff purple |
| Footnote | #00c76a green | #21e968 green |
| Checkbox | #00c76a green | #21e968 green |

## Usage

1. **Install the extension** (themes included automatically)
2. **Open Command Palette**: `Ctrl+K Ctrl+T` (or `Cmd+K Cmd+T` on Mac)
3. **Select theme**:
   - "Markdown Extended Light" for light mode
   - "Markdown Extended Dark" for dark mode

## Features

- ✅ All markdown-it-ib emphasis patterns (italic, bold, underline, strong, strikethrough)
- ✅ Extended patterns (sidenotes, marginal notes, sidebars, highlight, kbd)
- ✅ Block elements (admonitions, TOC, footnotes, checkboxes)
- ✅ Colors match Sublime Text themes exactly
- ✅ Based on official Styles.css color variables

## Customization

To customize colors, add to your `settings.json`:

```json
{
  "editor.tokenColorCustomizations": {
    "[Markdown Extended Light]": {
      "textMateRules": [
        {
          "scope": "markup.italic.markdown",
          "settings": {
            "foreground": "#your-color-here"
          }
        }
      ]
    }
  }
}
```

## Files

- `markdown-extended-light.json` - Light theme definition
- `markdown-extended-dark.json` - Dark theme definition

Both themes are registered in `package.json` and activated automatically with the extension.
