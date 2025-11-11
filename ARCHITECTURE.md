# Architecture Documentation

## Table of Contents

- [Overview](#overview)
- [Design Principles](#design-principles)
- [Core Architecture](#core-architecture)
- [Service Layer](#service-layer)
- [Plugin System](#plugin-system)
- [Testing Strategy](#testing-strategy)
- [Key Design Decisions](#key-design-decisions)

---

## Overview

Markdown Extended is a VS Code extension that provides enhanced markdown syntax support and powerful export capabilities (HTML, PDF, PNG, JPG). The codebase follows modern TypeScript patterns with emphasis on:

- **Singleton Pattern** - Centralized service management
- **Dependency Injection** - Testable, decoupled components
- **Async/Await** - Non-blocking I/O operations
- **Comprehensive Error Handling** - User-friendly error recovery
- **Test Coverage** - 65+ unit tests ensuring reliability

---

## Design Principles

### 1. **Single Responsibility Principle (SRP)**

Each service has a clear, focused purpose:

- `ExtensionContext` - Extension state management
- `BrowserManager` - Browser lifecycle
- `ErrorHandler` - Error reporting and recovery
- `Config` - Configuration access

### 2. **Singleton Pattern**

Services are implemented as singletons to ensure:

- **Consistent state** across the extension
- **Resource efficiency** (one browser instance, one config reader)
- **Testability** via `_setInstance()` methods

### 3. **Async-First Design**

All I/O operations use `async/await` and `fs.promises`:

- **Non-blocking** file operations
- **Better concurrency** for multiple exports
- **Modern Node.js** best practices

### 4. **Defensive Programming**

- Input validation on all public APIs
- Null checks before accessing optional properties
- Try-catch blocks with contextual error handling
- Resource cleanup in finally blocks

---

## Core Architecture

``` text
vscode-markdown-extended/
├── src/
│   ├── extension.ts              # Entry point, activation/deactivation
│   ├── commands/                 # VS Code commands
│   │   ├── command.ts           # Base command class
│   │   ├── commands.ts          # Command registry
│   │   ├── exportCurrent.ts     # Export single file
│   │   ├── exportWorkspace.ts   # Export all files
│   │   └── ...
│   ├── services/                 # Core services layer
│   │   ├── common/              # Shared utilities
│   │   │   ├── extensionContext.ts  # State management
│   │   │   ├── errorHandler.ts      # Error handling
│   │   │   ├── config.ts             # Configuration
│   │   │   └── tools.ts              # File utilities
│   │   ├── browser/
│   │   │   └── browserManager.ts    # Browser lifecycle
│   │   ├── exporter/            # Export engines
│   │   │   ├── html.ts          # HTML exporter
│   │   │   ├── puppeteer.ts     # PDF/Image exporter
│   │   │   └── export.ts        # Export orchestration
│   │   └── contributes/
│   │       ├── contributorService.ts   # Plugin contributions
│   │       └── contributesService.ts   # Config contributions
│   └── plugin/                   # Markdown-it plugins
│       ├── markdownItTOC.ts
│       ├── markdownItContainer.ts
│       ├── markdownItAdmonition.ts
│       └── ...
└── test/
    └── unit/                     # Unit tests (65+ tests)
```

---

## Service Layer

### ExtensionContext

**Purpose:** Centralized extension state management, replacing global mutable variables.

**Pattern:** Thread-safe singleton with lazy initialization.

```typescript
// Initialize once during activation
ExtensionContext.initialize(context);

// Access anywhere in the codebase
const markdown = ExtensionContext.current.markdown;
const outputPanel = ExtensionContext.current.outputPanel;
```

**Key Features:**

- ✅ Replaces global `markdown`, `context`, `outputPanel` variables
- ✅ Explicit initialization check with helpful error messages
- ✅ Cleanup method for proper resource disposal
- ✅ Testable via `_reset()` method

---

### BrowserManager

**Purpose:** Centralized browser management for Puppeteer-based exports.

**Pattern:** Singleton with dependency injection (ExtensionContext).

```typescript
const browserManager = BrowserManager.getInstance(context);
const executablePath = await browserManager.ensureBrowser(progress);
```

**Key Features:**

- ✅ Automatic browser download and installation
- ✅ Platform detection (Windows, macOS, Linux)
- ✅ Custom executable path support
- ✅ Force reinstall option
- ✅ Progress reporting for downloads

**Eliminates:**

- ❌ Code duplication between PuppeteerExporter and CommandInstallBrowser
- ❌ Inconsistent browser installation logic

---

### ErrorHandler

**Purpose:** Consistent error reporting, logging, and recovery across the extension.

**Pattern:** Static utility class with contextual error handling.

```typescript
try {
    await riskyOperation();
} catch (error) {
    await ErrorHandler.handle(error, {
        operation: 'Export PDF',
        filePath: document.uri.fsPath,
        recoveryOptions: [{
            label: 'Retry',
            action: () => riskyOperation()
        }]
    }, ErrorSeverity.Error);
}
```

**Key Features:**

- ✅ Four severity levels: Critical, Error, Warning, Info
- ✅ Contextual information (operation, file path, details)
- ✅ User-friendly error messages
- ✅ Recovery options (Retry, Install Browser, etc.)
- ✅ Logging to output panel

---

### Config

**Purpose:** Type-safe configuration access with validation.

**Pattern:** Singleton extending ConfigReader.

```typescript
const config = Config.instance;
const disabled = config.disabledPlugins;  // string[]
const levels = config.tocLevels;          // number[]
```

**Key Features:**

- ✅ Type-safe property accessors
- ✅ Default values when not configured
- ✅ Validation (e.g., file existence checks)
- ✅ Folder-specific configuration support

---

## Plugin System

### Architecture

Markdown Extended extends VS Code's built-in markdown preview using the `extendMarkdownIt` API. Plugins are registered in `src/plugin/plugins.ts` and loaded dynamically.

### Plugin Pattern

**Correct Pattern:**

```typescript
/**
 * Markdown-it plugin that modifies the markdown-it instance directly.
 * @param md - The markdown-it instance
 */
export function MyPlugin(md: MarkdownIt): void {
    // ✅ Directly modify md's rules, renderer, etc.
    md.renderer.rules.custom = renderFunction;
    md.core.ruler.push("customRule", ruleFunction);
    
    // ✅ If wrapping another plugin, invoke it directly
    const externalPlugin = require('markdown-it-something');
    externalPlugin(md, options);
    
    // ❌ NEVER call md.use() inside a plugin
    // md.use(externalPlugin, options); // WRONG!
}
```

**Why This Matters:**

- `md.use(plugin, options)` is the **public API** for adding plugins
- Plugin functions themselves should **never** call `md.use()`
- Nested `md.use()` calls cause `TypeError: e.apply is not a function`

### Plugin Types

1. **Custom Plugins** (owned by this extension)
   - `markdownItTOC` - Table of contents with anchor links
   - `markdownItContainer` - Custom container blocks (`::: warning`)
   - `markdownItAdmonition` - GitHub-style admonitions
   - `markdownItAnchorLink` - Anchor link slugification
   - `markdownItExportHelper` - Image embedding for exports
   - `markdownItSidenote` - Sidenote and marginal note support

2. **External Plugins** (npm packages)
   - `markdown-it-footnote` - Footnote support
   - `markdown-it-abbr` - Abbreviation definitions
   - `markdown-it-kbd` - Keyboard key rendering
   - `markdown-it-emoji` - Emoji support
   - `markdown-it-multimd-table` - Advanced table features
   - And more...

### Plugin Registration

```typescript
// src/plugin/plugins.ts
export var plugins: markdownItPlugin[] = [
    $('markdown-it-table-of-contents', { includeLevel: config.tocLevels }),
    $('markdown-it-container'),
    $('markdown-it-admonition'),
    // ...
].filter(p => !!p);

// Helper function that loads plugins
function $(name: string, ...args: any[]): markdownItPlugin | undefined {
    if (config.disabledPlugins.some(d => `markdown-it-${d}` === name)) return;
    const plugin = myPlugins[name] || require(name);
    return plugin ? { plugin, args } : undefined;
}
```

### Plugin Disabling

Users can disable plugins via settings:

```json
{
    "markdownExtended.disabledPlugins": "toc, container, emoji"
}
```

---

## Testing Strategy

### Test Infrastructure

- **Framework:** Mocha + VS Code Test Runner
- **Mocking:** Sinon for spies, stubs, and mocks
- **Coverage:** 65+ unit tests across 10+ test suites
- **CI/CD Ready:** Tests run via `npm run test:unit`

### Test Structure

``` text
test/
└── unit/
    ├── services/
    │   ├── browser/
    │   │   └── browserManager.test.ts    (20 tests)
    │   ├── common/
    │   │   ├── config.test.ts            (15 tests)
    │   │   ├── errorHandler.test.ts      (10 tests)
    │   │   └── extensionContext.test.ts  (10 tests)
    │   └── contributes/
    │       ├── contributorService.test.ts (10 tests)
    │       └── contributesService.test.ts (15 tests)
```

### Testing Patterns

#### 1. Singleton Testing

```typescript
afterEach(() => {
    Config._reset();  // Clean up singleton state
});

test('singleton instance', () => {
    const instance1 = Config.instance;
    const instance2 = Config.instance;
    assert.strictEqual(instance1, instance2);
});
```

#### 2. Dependency Injection Testing

```typescript
test('BrowserManager requires context', () => {
    BrowserManager._reset();
    assert.throws(() => {
        BrowserManager.getInstance();
    }, /requires extension context/);
});
```

#### 3. Async Testing

```typescript
test('async file operations', async () => {
    await mkdirsAsync('/path/to/dir');
    const exists = fs.existsSync('/path/to/dir');
    assert.strictEqual(exists, true);
});
```

#### 4. Error Handling Testing

```typescript
test('handles missing browser gracefully', async () => {
    sinon.stub(fs, 'existsSync').returns(false);
    await ErrorHandler.handle(new Error('Browser not found'), {
        operation: 'Export PDF'
    }, ErrorSeverity.Error);
    // Verify error logged, user notified
});
```

---

## Key Design Decisions

### 1. Singleton Pattern for Services

**Decision:** Use explicit singleton pattern with `getInstance()` methods.

**Rationale:**

- ✅ Prevents multiple instances of stateful services
- ✅ Provides global access point without global variables
- ✅ Testable via `_setInstance()` and `_reset()` methods
- ✅ Clear initialization requirements

**Alternative Considered:** Dependency injection container (rejected as over-engineering for this scale).

---

### 2. Async File Operations

**Decision:** Migrate from `fs.*Sync()` to `fs.promises.*`.

**Rationale:**

- ✅ Non-blocking I/O prevents UI freezing
- ✅ Better concurrency for multiple exports
- ✅ Modern Node.js best practices
- ✅ Aligns with async/await patterns

**Implementation:**

```typescript
// Before (blocking)
mkdirsSync(path.dirname(fileName));
fs.writeFileSync(fileName, content);

// After (non-blocking)
await mkdirsAsync(path.dirname(fileName));
await fsPromises.writeFile(fileName, content);
```

**Note:** `existsSync()` retained for validation checks (synchronous by nature).

---

### 3. Error Handler Service

**Decision:** Centralized error handling with contextual information and recovery options.

**Rationale:**

- ✅ Consistent error messages across the extension
- ✅ User-friendly recovery actions
- ✅ Detailed logging for debugging
- ✅ Reduces error handling boilerplate

**Impact:**

- Before: 20+ different error handling patterns
- After: Single consistent pattern with contextual recovery

---

### 4. Plugin Direct Invocation

**Decision:** Plugins directly invoke wrapped plugins instead of calling `md.use()`.

**Rationale:**

- ✅ Prevents double-use pattern errors
- ✅ Follows markdown-it plugin architecture
- ✅ Clearer plugin ownership and responsibility

**Bug Fixed:**

```typescript
// Before (caused TypeError)
export function MarkdownItContainer(md: MarkdownIt) {
    md.use(container, "container", options); // Double-use!
}

// After (correct)
export function MarkdownItContainer(md: MarkdownIt): void {
    container(md, "container", options); // Direct invocation
}
```

---

### 5. Test Infrastructure

**Decision:** Use VS Code Test Runner with Mocha/Sinon.

**Rationale:**

- ✅ Official VS Code testing framework
- ✅ Full VS Code API access in tests
- ✅ Familiar testing patterns (Mocha/Sinon)
- ✅ CI/CD integration support

**Impact:**

- 0 → 65 unit tests
- Full service coverage
- Regression prevention

---

## Migration Guide

### For Contributors

#### Adding a New Service

1. Create service class with private constructor
2. Implement `getInstance()` static method
3. Add `_reset()` for testing
4. Document with JSDoc
5. Write unit tests
6. Update this document

Example:

```typescript
export class MyService {
    private static _instance?: MyService;
    
    private constructor() {}
    
    static getInstance(): MyService {
        if (!MyService._instance) {
            MyService._instance = new MyService();
        }
        return MyService._instance;
    }
    
    static _reset(): void {
        MyService._instance = undefined;
    }
}
```

#### Adding a New Plugin

1. Create plugin file in `src/plugin/`
2. Export plugin function with JSDoc
3. Register in `src/plugin/plugins.ts`
4. **Never call `md.use()` inside the plugin**
5. Add tests if complex logic
6. Update README with syntax examples

---

## Maintenance

### Code Quality Standards

- **TypeScript strict mode:** Gradually enabled (see `tsconfig.json`)
- **JSDoc coverage:** All public APIs documented
- **Test coverage:** Core services 100% covered
- **Error handling:** All async operations wrapped in try-catch
- **Resource cleanup:** All resources disposed in finally blocks

### Performance Considerations

1. **Singleton services** reduce initialization overhead
2. **Async file operations** prevent UI blocking
3. **Browser caching** avoids redundant downloads
4. **Lazy initialization** defers work until needed

### Security Considerations

1. **File path validation** prevents directory traversal
2. **Custom executable validation** checks file existence
3. **Browser download verification** uses official Puppeteer APIs
4. **User input sanitization** in exports

---

## Future Improvements

### Planned Enhancements

1. **P3: Refactor Large Files**
   - Split `markdownItSidenote.ts` (393 lines)
   - Extract reusable utilities

2. **Enable Strict Mode**
   - Enable `noImplicitAny` gradually
   - Enable `strictNullChecks` gradually
   - Fix type issues incrementally

3. **Expand Test Coverage**
   - Add integration tests
   - Add export end-to-end tests
   - Add plugin tests

4. **Performance Optimization**
   - Cache markdown-it instances
   - Optimize plugin loading
   - Profile export operations

---

## Conclusion

This architecture provides a solid foundation for maintainability, testability, and extensibility. The singleton pattern, async operations, and centralized error handling ensure a robust user experience while keeping the codebase clean and understandable.

For questions or suggestions, please open an issue on GitHub.

---

**Document Version:** 1.0  
**Last Updated:** November 7, 2025  
**Extension Version:** 2.0.0
