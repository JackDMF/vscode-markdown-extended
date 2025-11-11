# Installing Markdown Extended in Textastic for iOS

This guide explains how to install the Markdown Extended syntax highlighting and color schemes in Textastic for iOS.

## What You'll Get

- **Extended Markdown syntax highlighting** with support for:
  - Sidenotes: `++reference|note++`
  - Marginal notes: `!!reference|note!!`
  - Sidebars: `$left sidebar$` and `@right sidebar@`
  - Highlight: `==highlighted text==`
  - Enhanced emphasis via markdown-it-ib:
    - `*italic*` (gold) vs `_underline_` (green)
    - `**bold**` (purple) vs `__strong__` (cyan)
    - `~~strikethrough~~` (pink)
  - Keyboard keys: `[[Ctrl+C]]`
  - Admonitions: `!!! note "Title"`
  - Table of contents: `[[TOC]]`
  - Superscript: `^text^` and subscript: `~text~`
  - Checkboxes, footnotes, abbreviations, and more

- **Two color schemes**:
  - **Markdown Extended** (light theme)
  - **Markdown Extended Dark** (dark theme)

## Files Required

From this `sublime/` folder, you need:

### For Syntax Highlighting:
- `Markdown Extended.sublime-syntax`

### For Color Schemes:
- `Markdown Extended.tmTheme` (light theme)
- `Markdown Extended Dark.tmTheme` (dark theme)

## Installation Steps

### Step 1: Create the Special #Textastic Folder

1. Open **Textastic** on your iOS device
2. Navigate to **Local Files** (tap "Local Files" at the bottom)
3. Tap the **+** button in the bottom toolbar
4. Choose **Folder**
5. Enter exactly: `#Textastic` (case-sensitive, with the hash symbol)
6. Tap **Create**
7. **Verify** the folder has a special icon (different from regular folders)

⚠️ **Important**: The folder name MUST be exactly `#Textastic` with the hash symbol, and it must show a special icon.

### Step 2: Create the Correct Folder Structure

Inside the `#Textastic` folder, create the following structure:

```
#Textastic/
  ├── Markdown Extended.tmTheme              ← Theme files go DIRECTLY in #Textastic
  ├── Markdown Extended Dark.tmTheme         ← Theme files go DIRECTLY in #Textastic
  └── Markdown Extended/                     ← Syntax package folder
      └── Markdown Extended.sublime-syntax
```

⚠️ **Critical**: Theme files (`.tmTheme`) must be placed **directly in the `#Textastic` folder**, NOT inside the package folder!

**How to create:**

1. **For theme files**: Transfer the two `.tmTheme` files directly into `#Textastic/`
2. **For syntax file**: 
   - Inside `#Textastic`, tap **+** → **Folder**
   - Name it: `Markdown Extended`
   - Transfer `Markdown Extended.sublime-syntax` into this folder

### Step 3: Transfer Files to iOS

You have several options:

#### Option A: AirDrop (Mac to iOS)
1. Select the three files on your Mac
2. Right-click → Share → AirDrop
3. Send to your iOS device
4. Choose "Save to Files"
5. Place files according to structure:
   - `.tmTheme` files → On My iPad/iPhone → Textastic → #Textastic
   - `.sublime-syntax` file → On My iPad/iPhone → Textastic → #Textastic → Markdown Extended

#### Option B: iCloud Drive
1. Copy the three files to iCloud Drive on your Mac
2. On iOS, use the Files app to move them:
   - `.tmTheme` files → Textastic → #Textastic (root)
   - `.sublime-syntax` file → Textastic → #Textastic → Markdown Extended

#### Option C: Textastic WebDAV Server
1. In Textastic, tap **≡** (menu) → **WebDAV Server**
2. Start the server (note the URL shown)
3. On your Mac, open Finder
4. Press **⌘+K** (Connect to Server)
5. Enter the URL shown in Textastic
6. Copy files to correct locations:
   - `.tmTheme` files → `#Textastic/` (root)
   - `.sublime-syntax` file → `#Textastic/Markdown Extended/`

#### Option D: iTunes File Sharing (older iOS/iTunes)
1. Connect iOS device to computer
2. Open iTunes/Finder
3. Select your device
4. Go to "File Sharing" → Textastic
5. Drag files to the Documents folder

### Step 4: Reload Customizations

After transferring the files:

1. In Textastic, tap the **Settings** button (⚙️ gear icon) in the bottom toolbar
2. Tap **Other**
3. Tap **Reload Customizations**
   - Or press **⌘+Shift+R** if using an external keyboard

All open files in `#Textastic` will be saved automatically before reloading.

### Step 5: Apply to Markdown Files

#### To use the syntax highlighting:
1. Open a `.md` file (or create a new one)
2. Tap the **filename** at the top
3. Tap **File Properties**
4. Under **Syntax Definition**, scroll and select **"Markdown Extended"**

#### To use the color scheme:
1. Tap **Settings** (⚙️) → **Code Editor**
2. Tap **Color Scheme**
3. Scroll to find:
   - **Markdown Extended** (light)
   - **Markdown Extended Dark** (dark)
4. Select your preferred theme

## Verification

To verify everything is working:

1. Create a new file with some extended markdown:
   ```markdown
   # Test Heading
   
   *italic* vs _underline_
   **bold** vs __strong__
   ~~strikethrough~~
   ==highlight==
   
   ++sidenote ref|This is a note++
   
   !!! note "Important"
       This is an admonition
   ```

2. Apply the **Markdown Extended** syntax definition
3. Apply the **Markdown Extended** or **Markdown Extended Dark** color scheme
4. You should see different colors for each element

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **Themes not appearing** | **MOST COMMON**: `.tmTheme` files must be in `#Textastic/` root, NOT in the package subfolder! |
| Syntax not available | Verify `#Textastic` folder has special icon and syntax file is in `Markdown Extended/` subfolder |
| No highlighting | Make sure "Markdown Extended" is selected under File Properties → Syntax Definition |
| Wrong colors | Select "Markdown Extended" (light) or "Markdown Extended Dark" color scheme in Settings |
| Changes not appearing | Tap Settings → Other → Reload Customizations |
| Files not showing | Check file names exactly match (case-sensitive) |

### Common Mistake: Theme File Location ⚠️

**WRONG:**
```
#Textastic/
  └── Markdown Extended/
      ├── Markdown Extended.sublime-syntax
      ├── Markdown Extended.tmTheme           ← ❌ WRONG LOCATION
      └── Markdown Extended Dark.tmTheme      ← ❌ WRONG LOCATION
```

**CORRECT:**
```
#Textastic/
  ├── Markdown Extended.tmTheme              ← ✅ Themes in root
  ├── Markdown Extended Dark.tmTheme         ← ✅ Themes in root
  └── Markdown Extended/
      └── Markdown Extended.sublime-syntax   ← ✅ Syntax in subfolder
```

## Color Scheme Details

### Light Theme Colors:
- Background: `#fffaf9` (soft white/pink)
- Text: `#1b1220` (dark purple-black)
- Emphasis colors:
  - Italic `*text*`: Gold (#ffb400)
  - Underline `_text_`: Green (#00c76a)
  - Bold `**text**`: Purple (#6f4dff)
  - Strong `__text__`: Cyan (#00aee8)
  - Strikethrough `~~text~~`: Pink (#ff0f6e)

### Dark Theme Colors:
- Background: `#1a1620` (dark purple-black)
- Text: `#ffffff` (white)
- Emphasis colors:
  - Italic `*text*`: Gold (#ffd700)
  - Underline `_text_`: Green (#21e968)
  - Bold `**text**`: Purple (#9b7bff)
  - Strong `__text__`: Cyan (#00d9ff)
  - Strikethrough `~~text~~`: Pink (#ff2d8a)

## File Format Notes

- **Syntax file**: `.sublime-syntax` (YAML-based, Sublime Text 3 format)
  - Textastic supports Sublime Text 3 packages natively
  - Contains all the pattern matching rules for extended markdown

- **Color scheme files**: `.tmTheme` (XML plist format)
  - Legacy TextMate format (required by Textastic)
  - Converted from `.sublime-color-scheme` for compatibility
  - All color variables have been resolved to actual hex values

## Advanced: Auto-Apply Syntax

To automatically use Markdown Extended for all `.md` files:

Currently, Textastic doesn't support automatic syntax association. You must manually select "Markdown Extended" for each file or set it as default in File Properties.

## Known Limitations

1. **No dynamic theming**: Unlike VS Code, you cannot switch between light/dark automatically based on system settings. You must manually change the color scheme.

2. **Variable-less themes**: The `.tmTheme` format doesn't support variables, so all colors are hardcoded. If you want to customize colors, you'll need to edit the XML files directly.

3. **Nesting complexity**: Some advanced nesting features from the Sublime syntax v4 may not work perfectly due to TextMate grammar engine differences.

## Support

For issues with:
- **Syntax highlighting patterns**: Check the Sublime syntax file
- **Color schemes**: Check the `.tmTheme` XML files
- **Textastic app**: Visit https://www.textasticapp.com/

## Credits

Based on the VS Code Markdown Extended extension, with syntax definitions and color schemes adapted for Sublime Text and Textastic compatibility.

---

**Version**: Compatible with Textastic 10.x (iOS)  
**Last Updated**: November 2025
