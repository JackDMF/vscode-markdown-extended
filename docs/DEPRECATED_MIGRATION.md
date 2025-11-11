# Deprecated Functions Migration

## Summary

Successfully migrated **ALL** internal code from deprecated singleton exports to the new `.instance` pattern for consistency and clarity.

## Changes Made

### 1. Exported Private Classes

Made the following singleton classes public for proper usage:

- ✅ `export class Config` in `src/services/common/config.ts`
- ✅ `export class HtmlExporter` in `src/services/exporter/html.ts`
- ✅ `export class PuppeteerExporter` in `src/services/exporter/puppeteer.ts`

### 2. Complete Migration to .instance Pattern

**All internal code** has been migrated from deprecated exports to explicit `.instance` pattern:

**Before (Deprecated):**

```typescript
import { config } from '../common/config';
import { htmlExporter } from './html';
import { puppeteerExporter } from './puppeteer';

const executable = config.puppeteerExecutable;
if (htmlExporter.FormatAvailable(format)) { ... }
if (puppeteerExporter.FormatAvailable(format)) { ... }
```

**After (Current):**

```typescript
import { Config } from '../common/config';
import { HtmlExporter } from './html';
import { PuppeteerExporter } from './puppeteer';

const executable = Config.instance.puppeteerExecutable;
if (HtmlExporter.instance.FormatAvailable(format)) { ... }
if (PuppeteerExporter.instance.FormatAvailable(format)) { ... }
```

## Deprecated Exports Status

These exports remain for **backward compatibility ONLY** but are **NO LONGER used internally**:

| Export | File | Status | Migration Path |
|--------|------|--------|----------------|
| `export const config` | config.ts | @deprecated | Use `Config.instance` |
| `export const htmlExporter` | html.ts | @deprecated | Use `HtmlExporter.instance` |
| `export const puppeteerExporter` | puppeteer.ts | @deprecated | Use `PuppeteerExporter.instance` |
| `export var markdown` | extension.ts | @deprecated | Use `ExtensionContext.current.markdown` |
| `export var context` | extension.ts | @deprecated | Use `ExtensionContext.current.vsContext` |
| `export var outputPanel` | extension.ts | @deprecated | Use `ExtensionContext.current.outputPanel` |

## Current Usage Pattern (Consistent Across Codebase)

### ✅ CORRECT (Used Throughout Internal Codebase)

```typescript
// Explicit class import with .instance accessor - CONSISTENT pattern
import { Config } from '../common/config';
import { HtmlExporter } from './html';
import { PuppeteerExporter } from './puppeteer';

const executable = Config.instance.puppeteerExecutable;
const tocLevels = Config.instance.tocLevels;
const html = HtmlExporter.instance;
const puppeteer = PuppeteerExporter.instance;
```

### ❌ DEPRECATED (Only for External Backward Compatibility)

```typescript
// Old pattern - deprecated but kept for external code compatibility
import { config } from '../common/config';
import { htmlExporter } from './html';
import { puppeteerExporter } from './puppeteer';
```

## Migration Scope

All internal code has been migrated to use the `.instance` pattern:

| File | Changes |
|------|---------|
| `src/services/common/config.ts` | Exported `Config` class |
| `src/services/exporter/html.ts` | Exported `HtmlExporter` class |
| `src/services/exporter/puppeteer.ts` | Exported `PuppeteerExporter` class, migrated to `Config.instance` |
| `src/services/exporter/exporters.ts` | Migrated to `.instance` pattern |
| `src/plugin/plugins.ts` | Migrated to `Config.instance` |
| `src/plugin/markdownItTOC.ts` | Migrated to `Config.instance` |
| `src/services/common/tools.ts` | Migrated to `Config.instance` |
| `src/services/browser/browserManager.ts` | Migrated to `Config.instance` |
| `src/extension.ts` | Migrated to `Config.instance` |

## Validation

✅ **All 40 unit tests passing**
✅ **Zero compilation errors**
✅ **Zero TypeScript warnings**
✅ **100% internal migration to .instance pattern**
✅ **Backward compatibility maintained for external code**

## Rationale

**Why migrate `config` when it was "acceptable"?**

1. **Consistency**: All singletons now use the same pattern (`.instance`)
2. **Clarity**: `Config.instance` makes the singleton pattern explicit
3. **Honor Deprecation**: The JSDoc clearly marks `config` as `@deprecated`
4. **Technical Debt**: Contradictory guidance creates confusion and debt
5. **Best Practice**: Explicit is better than implicit

The lowercase exports (`config`, `htmlExporter`, `puppeteerExporter`) are retained solely for backward compatibility with external code that may depend on them.

## Recommendations

1. **Internal code**: Always use `ClassName.instance` pattern
2. **External consumers**: Can continue using deprecated exports (backward compatible)
3. **Future development**: Follow `.instance` pattern for new singletons
4. **Documentation**: Clearly mark deprecated exports in JSDoc

---

**Date:** November 11, 2025  
**Status:** ✅ Complete - Full Migration  
**Test Coverage:** 40/40 passing
