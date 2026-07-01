# Deprecated Functions Migration

## Summary

Successfully migrated **ALL** internal code from deprecated singleton exports to the canonical `.instance` pattern for consistency and clarity.

> **Update (v3.0):** the migration is complete — the deprecated compatibility exports (`config`, `Contributes`, `Contributors`, `htmlExporter`) and their barrel files were **removed**. Each service now exposes a single canonical `.instance` accessor.

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

## Removed Exports (v3.0)

These compatibility exports were **removed** in v3.0. Use the canonical accessor instead:

| Removed export | File | Replacement |
|--------|------|----------------|
| `config` | config.ts | `Config.instance` |
| `Contributes` | contributesService.ts | `ContributesService.instance` |
| `Contributors` | contributorService.ts | `ContributorService.instance` |
| `htmlExporter` | html.ts | `HtmlExporter.instance` |
| `markdown` / `context` / `outputPanel` | extension.ts | `ExtensionContext.current.*` |

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

### ❌ REMOVED in v3.0 (no longer available)

```typescript
// These deprecated exports were removed in v3.0 — do not use
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
✅ **Deprecated shims fully removed in v3.0**

## Rationale

**Why migrate `config` when it was "acceptable"?**

1. **Consistency**: All singletons now use the same pattern (`.instance`)
2. **Clarity**: `Config.instance` makes the singleton pattern explicit
3. **Honor Deprecation**: The JSDoc clearly marks `config` as `@deprecated`
4. **Technical Debt**: Contradictory guidance creates confusion and debt
5. **Best Practice**: Explicit is better than implicit

The lowercase exports (`config`, `htmlExporter`) and namespace shims (`Contributes`, `Contributors`) were removed in v3.0; use the `.instance` accessors.

## Recommendations

1. **All code**: Use the `ClassName.instance` accessor (the deprecated shims were removed in v3.0)
2. **Future development**: Follow the `.instance` pattern for new singletons; inject collaborators via constructors where it aids testing
3. **Documentation**: Keep the service-access decision in `ARCHITECTURE.md` in sync

---

**Status:** ✅ Complete — deprecated shims removed in v3.0
