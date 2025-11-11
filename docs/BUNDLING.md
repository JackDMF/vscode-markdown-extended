# Extension Bundling Setup

## Overview

This VS Code extension is now bundled using **esbuild** to significantly improve installation and activation performance.

### Performance Impact

- **Before**: ~4,064 files in the extension package
- **After**: 2 files (extension.js + source map)
- **Reduction**: 99.95% fewer files

### Benefits

1. **Faster Installation**: Fewer files to extract and write to disk
2. **Faster Activation**: Single bundled file loads much faster than thousands of individual modules
3. **Smaller Package Size**: Reduced overhead from file metadata
4. **Better Startup Performance**: Less file I/O operations during extension loading

## Build System

### Configuration Files

- **`esbuild.js`**: Main build configuration script
  - Bundles TypeScript sources into a single JavaScript file
  - Handles production/development builds with appropriate optimizations
  - Provides watch mode for development
  - Includes VS Code-compatible problem matcher for build errors

### Package.json Scripts

```json
{
  "scripts": {
    "compile": "node esbuild.js",              // Development build
    "watch": "node esbuild.js --watch",         // Watch mode for development
    "package": "node esbuild.js --production",  // Production build (minified)
    "analyze": "node esbuild.js --analyze",     // Bundle analysis with visualization
    "vscode:prepublish": "npm run package",     // Auto-runs before publishing
    "compile-tests": "tsc -p ./",               // Compile tests separately
    "test:unit": "npm run compile-tests && node ./out/test/runTest.js",
    "lint": "eslint src --ext ts",              // Lint source code
    "lint:fix": "eslint src --ext ts --fix"     // Auto-fix linting issues
  }
}
```

### Build Output

- **Development**: `dist/extension.js` + `dist/extension.js.map` (~6 MB total)
- **Production**: `dist/extension.js` (minified, ~4 MB, no source map)

## Development Workflow

### Running in Development

1. **Start watch mode**: `npm run watch`
2. Press `F5` in VS Code to launch Extension Development Host
3. Changes are automatically rebuilt

### Bundle Analysis

Analyze your bundle composition to identify large dependencies:

```powershell
npm run analyze
```

This generates:
- **Interactive treemap visualization**: `dist/bundle-stats.html` (open in browser)
- **Console summary**: Top 10 largest modules, total size, module count

Use this to:
- Identify unexpectedly large dependencies
- Find opportunities for code splitting or lazy loading
- Track bundle size growth over time

### Code Quality

Lint your TypeScript code:

```powershell
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
```

ESLint is configured with TypeScript support and VS Code extension best practices.

### Building for Production

```powershell
npm run package
```

This creates an optimized, minified bundle ready for publishing.

### Publishing

The `vscode:prepublish` script automatically runs before publishing:

```powershell
vsce package
# or
vsce publish
```

## Technical Details

### Bundling Strategy

- **Entry Point**: `src/extension.ts`
- **Output Format**: CommonJS (required for VS Code extensions)
- **Platform**: Node.js
- **External Dependencies**: `vscode` API is marked as external
- **Source Maps**: Generated in development, excluded in production

### What Gets Bundled

✅ All TypeScript source code from `src/**`
✅ All npm dependencies (except `vscode`)
✅ Type definitions and custom types

### What Stays Separate

❌ VS Code API (`vscode` module)
❌ Test files (`test/**`)
❌ Native node modules (handled by esbuild automatically)
❌ Static assets (themes, snippets, syntaxes, styles)

### .vscodeignore Updates

The `.vscodeignore` file has been updated to:
- Exclude `src/**` and `out/**` source directories
- Exclude `node_modules/**` (dependencies are bundled)
- Include only `dist/**` for the bundled output
- Keep static assets (themes, snippets, syntaxes, styles)

## Testing

Tests are compiled separately using TypeScript (`tsc`) to avoid bundling test infrastructure:

```powershell
npm run test:unit
```

This approach:
1. Compiles tests with TypeScript compiler
2. Keeps test files in `out/test/**`
3. Allows tests to import from the source code directly

## Troubleshooting

### "Cannot find module" errors

If you see module resolution errors:
1. Ensure all dependencies are in `package.json`
2. Check that native modules aren't being bundled
3. Verify `vscode` is marked as external in `esbuild.js`

### Large bundle size

If the bundle becomes too large:
1. Check for accidentally bundled dev dependencies
2. Use `--analyze` flag to inspect bundle composition
3. Consider lazy-loading heavy dependencies

### Watch mode not working

If changes aren't being picked up:
1. Stop watch mode and restart
2. Check for TypeScript compilation errors
3. Ensure file paths are correct in `esbuild.js`

## Migration Notes

### Changes from Previous Build System

1. **Main entry point**: Changed from `./out/src/extension` to `./dist/extension.js`
2. **Build command**: `tsc` → `node esbuild.js`
3. **Output directory**: `out/` → `dist/`
4. **Tests**: Still use `tsc` for compilation (in `out/`)

### Backward Compatibility

The extension functionality remains unchanged. Only the build process and packaging have been optimized.

## Future Enhancements

### Potential Improvements

- [ ] Set up CI/CD to automatically verify bundle size doesn't exceed thresholds
- [ ] Add pre-commit hooks for linting
- [ ] Implement code splitting for large features
- [ ] Add compression for production builds
- [ ] Create bundle size badges for README

### Monitoring Bundle Size

Track bundle size over time to catch regressions:

```powershell
# Check current bundle size
Get-Item dist\extension.js | Select-Object Name, Length

# With bundle analysis
npm run analyze
```

**Current metrics (as of setup):**
- Bundle size: ~4.5 MB (before minification)
- Modules: 563
- Largest dependency: @tootallnate/quickjs-emscripten (~618 KB)

Recommended threshold: Keep bundled size under 5 MB for optimal performance.

## Code Quality Tools

### ESLint Configuration

The project uses ESLint v9 with the new flat config format (`eslint.config.js`):

- **Parser**: @typescript-eslint/parser
- **Plugins**: @typescript-eslint/eslint-plugin
- **Rules**: Balanced for gradual adoption
  - Warnings for `any` types (not errors)
  - Required `const` for non-reassigned variables
  - Enforced `===` instead of `==`
  - Naming conventions for TypeScript
  - Curly braces for all control structures

### ESLint Status

Current linting status shows **160 issues** (52 errors, 108 warnings):
- Most common: `==` vs `===` (easy auto-fix)
- `var` declarations (should use `const`/`let`)
- `any` type usage (can be gradually typed)
- Naming conventions (PascalCase for types)

These can be addressed incrementally without blocking development.

### Running Linter

```powershell
# Check for issues
npm run lint

# Auto-fix what's possible
npm run lint:fix

# Lint specific file
npx eslint src/services/browser/browserManager.ts
```

## References

- [esbuild Documentation](https://esbuild.github.io/)
- [VS Code Extension Bundling Guide](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [VS Code Extension Best Practices](https://code.visualstudio.com/api/references/extension-guidelines)
