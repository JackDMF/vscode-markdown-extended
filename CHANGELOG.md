# Change Log

## v2.2.2 - PDF Layout Fixes

### 🖨️ Printing Improvements

- Removed the hard-coded 1000px width override applied only during Puppeteer PDF export so printed output now matches the HTML preview.
- Default Puppeteer settings now set `preferCSSPageSize: true`, allowing any `@page` rules in user stylesheets to dictate the final paper size, margins, and orientation.
- PNG/JPG exports keep their deterministic width to avoid regressions, but PDFs now faithfully honor CSS-driven layouts.

---

## v2.2.1 - Logo Updates for Marketplace

### 🎨 Visual Improvements

- Updated extension logo for better marketplace visibility
- Added optimized small logo (`logo-small.png`) for VS Code marketplace icon
- Enhanced visual branding in extension listing

---

## v2.2.0 - Performance & Architecture: Proper Plugin Bundling

### ✨ Major Improvements

- **90% package size reduction**: 1.29 MB (36 files) vs 12.63 MB (4000 files in v2.1.4)
- **Proper bundling architecture**: Converted dynamic `require()` to static imports for all markdown-it plugins
- **Faster extension activation**: Bundled plugins load more efficiently than runtime require resolution
- **Cleaner package structure**: Eliminated 4000+ node_modules files and esbuild performance warnings

### 🔧 Technical Implementation

**Root cause of v2.1.0 breakage identified and fixed:**
- Dynamic `require(name)` calls with runtime variables cannot be bundled by esbuild
- esbuild requires static imports for proper dependency analysis and bundling
- Previous versions (2.1.2-2.1.4) worked around this by externalizing plugins and including entire node_modules

**Proper solution implemented:**
- Refactored `src/plugin/plugins.ts` to use static `import` statements for all 16 external plugins
- Removed dynamic require fallback mechanism
- esbuild now properly bundles all markdown-it plugins at build time

### 📝 Changes

- Converted all external markdown-it plugin requires to static imports in `plugins.ts`
- Fixed `markdown-it-emoji` import (uses named export `full` instead of default)
- Removed plugin names from esbuild `external` array (only `vscode` remains external)
- Bundle size: 2.3 MB minified (4.38 MB unminified) - all plugins included

### 🎯 Impact

This release delivers the architectural solution v2.1.0 should have implemented. Previous workarounds (v2.1.2-2.1.4) were functional but suboptimal. Version 2.2.0 achieves:

- ✅ All markdown-it plugins fully functional (admonitions, sup/sub, etc.)
- ✅ Optimal package size (90% smaller than v2.1.4)
- ✅ Better performance (no runtime module resolution overhead)
- ✅ Future-proof bundling architecture
- ✅ Cleaner codebase with better maintainability

---

## v2.1.4 - Critical Fix: Include markdown-it plugin dependencies

### 🐛 Critical Bug Fix

- **Fixed missing markdown-it plugins in published package**: Plugins and their dependencies are now correctly included
- **Root cause**: `.vscodeignore` was excluding `node_modules`, preventing externalized plugins from being packaged
- **Solution**: Removed `node_modules/**` exclusion and externalized plugins in esbuild configuration

### 📝 Technical Details

Previous versions (2.1.2 and 2.1.3) externalized markdown-it plugins in esbuild but failed to include them in the published `.vsix` package because `.vscodeignore` excluded all `node_modules`. This version:

1. Externalizes markdown-it plugins in esbuild (not bundled into dist/extension.js)
2. Includes plugin dependencies in the published package (removed node_modules exclusion)
3. Results in proper plugin loading at runtime from node_modules

---

## v2.1.3 - Republish of v2.1.2 Fix

This version ensures the marketplace package includes the corrected `dist/extension.js` with externalized markdown-it plugins. No code changes from v2.1.2.

---

## v2.1.2 - Critical Bugfix: Markdown-it Plugins Not Loading

### 🐛 Critical Bug Fixes

- **Fixed broken markdown-it plugins**: Admonitions, superscript, subscript, and all other markdown-it plugins now work correctly
- **Root cause**: esbuild was bundling markdown-it plugins instead of loading them from node_modules at runtime
- **Solution**: Externalized all markdown-it plugins in esbuild configuration to prevent bundling

### 📝 Technical Details

The v2.1.0 release switched from TypeScript compilation to esbuild bundling, but markdown-it plugins were being bundled into the main extension file. These plugins need to be loaded dynamically at runtime via `require()` from node_modules. The fix adds all markdown-it plugins to the esbuild `external` array:

- `markdown-it-abbr`
- `markdown-it-attrs`
- `markdown-it-bracketed-spans`
- `markdown-it-checkbox`
- `markdown-it-container`
- `markdown-it-deflist`
- `markdown-it-emoji`
- `markdown-it-footnote`
- `markdown-it-html5-embed`
- `markdown-it-ib`
- `markdown-it-kbd`
- `markdown-it-mark`
- `markdown-it-multimd-table`
- `markdown-it-sub-alt`
- `markdown-it-sup-alt`
- `markdown-it-table-of-contents`

### ✅ What's Fixed

- ✅ Admonitions now render with proper styling (note, warning, danger, tip)
- ✅ Superscript syntax (`^text^`) works correctly
- ✅ Subscript syntax (`~text~`) works correctly
- ✅ All other markdown-it plugins function as expected

---

## v2.1.1 - Patch Release: License and Repository Updates

### 📝 Updates

- **License**: Updated copyright to acknowledge both original author (jebbs, 2018) and current maintainer (JackDMF, 2025)
- **Repository URLs**: Updated all GitHub URLs from qjebbs to JackDMF organization
  - Bug tracker URLs in package.json
  - Homepage and repository links
  - Issue reporter in error handler
  - Documentation references in README

### 🔧 Maintenance

- No functional changes to extension behavior
- Historical changelog references preserved for accuracy

---

## v2.1.0 - Feature Release: Enhanced Syntax Support

### ✨ New Features

- **Extended Markdown Syntax**: Additional syntax highlighting and parsing improvements
- **Enhanced Color Themes**: Improved color customization for sidenotes and sidebars
  - Sidenote text color: `markdown.sidenote.textColor`
  - Marginal note text color: `markdown.marginalnote.textColor`
  - Left sidebar text color: `markdown.leftsidebar.textColor`
  - Right sidebar text color: `markdown.rightsidebar.textColor`

### 🔧 Improvements

- Updated dependencies for better compatibility
- Performance optimizations

---

## v2.0.1 - Patch Release: Stability and Bug Fixes

### 🐛 Bug Fixes

- Fixed minor issues from v2.0.0 release
- Improved error handling stability
- Enhanced compatibility with latest VS Code versions

### 🔧 Maintenance

- Updated development dependencies
- Minor documentation corrections

---

## v2.0.0 - Major Release: Complete Architecture Modernization

This release represents a complete rewrite and modernization of the extension with enterprise-grade architecture, comprehensive testing, and new features.

### 🏗️ Architecture Improvements

- **Clean Architecture**: Implemented singleton services with dependency injection and separation of concerns
- **TypeScript Migration**: Full TypeScript rewrite with strict type safety throughout
- **Service Layer**: Introduced ExtensionContext, BrowserManager, ErrorHandler, and Config services
- **Resource Management**: Proper cleanup, async file operations, memory leak prevention
- **Error Handling**: Comprehensive error recovery and logging with graceful degradation
- **Test Coverage**: Added 65+ unit tests with VS Code integration
- **Documentation**: Created comprehensive ARCHITECTURE.md (500+ lines)

### ✨ New Features

- **Sidenotes & Annotations**: New markdown-it-sidenote plugin with full markdown support
  - Sidenotes: `++reference text|note content++`
  - Marginal notes: `!!reference text|note content!!`
  - Left sidebar: `$content$`
  - Right sidebar: `@content@`
  - Recursion depth limiting and error handling
  - Customizable CSS classes

### 🔧 Plugin Updates

- **Fixed**: Plugin loading errors (`e.apply is not a function`)
- **Fixed**: CommonJS import patterns for markdown-it plugins
- **Updated**: `markdown-it-sup` → `markdown-it-sup-alt`
- **Updated**: `markdown-it-sub` → `markdown-it-sub-alt`
- **Updated**: `markdown-it-underline` → `markdown-it-ib` (italic-bold)
- **Added**: `markdown-it-bracketed-spans` support
- **Enhanced**: All plugins now properly integrated with type safety

### 📚 Documentation

- **Comprehensive README**: Completely rewritten with accurate feature documentation
- **Architecture Guide**: Detailed ARCHITECTURE.md covering design principles and patterns
- **JSDoc Coverage**: 70+ JSDoc comments across services and plugins
- **Code Examples**: Inline documentation with usage examples
- **Maintenance Guide**: Guidelines for contributors and maintainers

### 🐛 Bug Fixes

- Fixed plugin double-use pattern causing initialization errors
- Fixed CommonJS module import issues with markdown-it plugins
- Resolved memory leaks in resource management
- Fixed async operation handling throughout extension
- Corrected deprecated function usage

### 🔄 Breaking Changes

- Minimum VS Code version: 1.80.0
- Plugin names updated in configuration (see README for new names)
- Some internal APIs changed (extension API remains stable)

### 🎯 Code Quality

- Reduced technical debt across all modules
- Implemented SOLID principles throughout
- Extracted helper functions for better testability
- Unified renderer patterns with discriminated unions
- Comprehensive inline comments for complex logic

### 📦 Dependencies

- Updated all markdown-it plugins to latest versions
- Updated puppeteer and development dependencies
- Removed deprecated packages

### 🙏 Credits

- Original extension by **qjebbs**
- v2.0.0 refactoring and modernization
- Community contributions and feedback

**Migration Notes**: This is a major version update. While the user-facing API remains compatible, some configuration setting names have been updated. See README.md for current plugin names and settings.

---

## v1.1.4

Add `markdown-it-bracketed-spans` and update dependencies, **@zeedif**, [#160](https://github.com/qjebbs/vscode-markdown-extended/pull/160)

## v1.1.3

Fix: Get chromium revision for puppeteer downloading

## v1.1.2

- Improvement: Tables formatting preserves table indentation and handle code spans, **@rbolsius**, [#139](https://github.com/qjebbs/vscode-markdown-extended/pull/139)
- Fix: Remove workaround introduced for [#98](https://github.com/qjebbs/vscode-markdown-extended/issues/98)
- Update dependencies

## v1.1.1

- Apply python markdown spec for admonitions, [#123](https://github.com/qjebbs/vscode-markdown-extended/pull/123)
- Fix [#125](https://github.com/qjebbs/vscode-markdown-extended/pull/125)

## v1.1.0

- Add snippets ([#116](https://github.com/qjebbs/vscode-markdown-extended/pull/116)), thanks to [heartacker ](https://github.com/heartacker)
- Fix admonitions ([#122](https://github.com/qjebbs/vscode-markdown-extended/pull/122)), thanks to [Juan Cruz](https://github.com/IJuanI)
- Remove default key bindings. [#111](https://github.com/qjebbs/vscode-markdown-extended/pull/111)[#112](https://github.com/qjebbs/vscode-markdown-extended/pull/112)[#118](https://github.com/qjebbs/vscode-markdown-extended/pull/118), please consider:

    - Switch to use command palette
    - Switch to use snippets
    - Setup key bindings on your own


## v1.0.19

- Add workaround for markdown export crashing. [#98](https://github.com/qjebbs/vscode-markdown-extended/issues/98)

## v1.0.18

- Improvement: Top margin inside admonition

## v1.0.17

- Fix: Export files not in workspace

## v1.0.16

- Improvement: Add ability to disable integrated plugin. [#72](https://github.com/qjebbs/vscode-markdown-extended/issues/72)

## v1.0.15

Fix: Cannot embed img not in workspace folder, [#71](https://github.com/qjebbs/vscode-markdown-extended/issues/71)

## v1.0.14

- Improvement: Chane `Move Columns` key bindings to `ctrl+shift+t ctrl+shift+left/right`, [#68](https://github.com/qjebbs/vscode-markdown-extended/issues/68)

## v1.0.13

- Improvement: Chane `Move Columns` key bindings to `ctrl+shift+left/right`, [#57](https://github.com/qjebbs/vscode-markdown-extended/issues/57), [#59](https://github.com/qjebbs/vscode-markdown-extended/issues/57)

## v1.0.12

- Improvement: No 'open preview first' prompt
- Fix: Update package markdown-it-attrs, [#58](https://github.com/qjebbs/vscode-markdown-extended/issues/58)
- Code optimization. 

## v1.0.11

- Add support for `markdown-it-html5-embed`, [#49](https://github.com/qjebbs/vscode-markdown-extended/issues/49)
- Fix: Rowspan of `markdown-it-multimd-table` doesn't work, [#50](https://github.com/qjebbs/vscode-markdown-extended/issues/50)
- Improved CJK table format.
- Admonition style optimize

## v1.0.10

- Fix: Format with Japanese Hiragana characters [#51](https://github.com/qjebbs/vscode-markdown-extended/issues/51). Thanks to [TadaoYamaoka](https://github.com/TadaoYamaoka).
- Update dependencies.
- Code optimization. 

## v1.0.9

- Fix: Embeds files referred by url() in css, fix [#48](https://github.com/qjebbs/vscode-markdown-extended/issues/48).

## v1.0.8

- Add plugin markdown-it-emoji, solve [#39](https://github.com/qjebbs/vscode-markdown-extended/issues/39).
- Add plugin markdown-it-multimd-table, solve [#42](https://github.com/qjebbs/vscode-markdown-extended/issues/42).
- Add capability to format format multimd table

## v1.0.7

- Fix: Cannot embed images if folder or path has special character, solve [#40](https://github.com/qjebbs/vscode-markdown-extended/issues/40).

## v1.0.6

- Add plugin markdown-it-mark
- Add command `Toggle Mark`

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

- New Feature: export with contribute scripts embedded, solve [#23](https://github.com/qjebbs/vscode-markdown-extended/issues/23).

Export files with content which requires extra scripts (e.g. mermaid), now works as expected.

## v0.9.6

- Improvement: Improve format table with CJK characters, solve [#22](https://github.com/qjebbs/vscode-markdown-extended/issues/22)

## v0.9.5

- Fix: Correct title spelling of markdown

## v0.9.4

- Fix: export non-workfolder file, solve [#19](https://github.com/qjebbs/vscode-markdown-extended/issues/19)

## v0.9.3

- Improvement: Add export report.
- Improvement: Message & titles optimize.
- Improvement: Code optimize.

## v0.9.2

- Improvement: configurable toc level, solve [#18](https://github.com/qjebbs/vscode-markdown-extended/issues/18)

## v0.9.1

- Improvement: new admonition implement, support nesting and more qualifiers.
- Improvement: better padding and align of table fomatting
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

- Improvement: Keep selections after table editing.
- Improvement: Optimize selection after toggle format.

> With these two improvements, you can smoothly toggling format and editing tables.

## v0.5.1

- New Feature: Add move table columns commands.

## v0.5.0

- New Feature: Add many format and table editing helpers.
- Small improvements
- Some Fixes and Code Optimization.

## v0.4.4

- Improvement: Many export optimizations.

## v0.4.3

- Fix: Wrong anchor element.
- Improvement: Precisely customize phantom pdf border.
- Improvement: Set default border of phantom pdf to 1cm.

## v0.4.2

- Fix: Parsing meta data
- Fix: Resources not fully processed

## v0.4.1

- Fix: Run phantomjs with no meta config
- Improvement: Async error catch optimize

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
- New Feature: Formate Table.
- Fix: Copy HTML failed if content contains non-English characters.

## v0.1.4

- Catch command errors to panel
- Prompt open preview before copy or export, avoiding undefinded render
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