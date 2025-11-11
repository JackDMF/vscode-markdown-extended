# Textastic Quick Reference - Markdown Extended

## File Structure (CRITICAL!)

```
#Textastic/
  ├── Markdown Extended.tmTheme              ← Theme files in ROOT
  ├── Markdown Extended Dark.tmTheme         ← Theme files in ROOT
  └── Markdown Extended/                     ← Syntax package folder
      └── Markdown Extended.sublime-syntax
```

## Key Points

1. **Theme files (`.tmTheme`)**: Place DIRECTLY in `#Textastic/` root folder
2. **Syntax file (`.sublime-syntax`)**: Place in `#Textastic/Markdown Extended/` subfolder
3. **After copying files**: Settings → Other → Reload Customizations
4. **To apply syntax**: File Properties → Syntax Definition → "Markdown Extended"
5. **To apply theme**: Settings → Code Editor → Color Scheme → Choose theme

## Common Mistake ❌

**DO NOT** put `.tmTheme` files inside the package folder. They won't be visible!

**WRONG:** `#Textastic/Markdown Extended/Markdown Extended.tmTheme` ❌
**RIGHT:** `#Textastic/Markdown Extended.tmTheme` ✅

## Files to Transfer

From `sublime/` folder, you need these 3 files:

1. `Markdown Extended.sublime-syntax` → Goes in `#Textastic/Markdown Extended/`
2. `Markdown Extended.tmTheme` → Goes in `#Textastic/`
3. `Markdown Extended Dark.tmTheme` → Goes in `#Textastic/`

## Verification

After setup, you should see:
- **Syntax Definition**: "Markdown Extended" appears in File Properties list
- **Color Schemes**: Both themes appear in Settings → Code Editor → Color Scheme

If themes don't appear: Check they are in `#Textastic/` ROOT, not in subfolder!
