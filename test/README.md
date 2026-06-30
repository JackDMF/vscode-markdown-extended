# Test Infrastructure

This directory contains the test suite for the vscode-markdown-extended extension.

## Structure

```text
test/
├── unit/                           # Unit tests
│   ├── index.ts                   # Unit test runner
│   └── services/                  # Service tests
│       ├── common/
│       │   ├── extensionContext.test.ts
│       │   ├── config.test.ts
│       │   └── errorHandler.test.ts
│       └── browser/
│           └── browserManager.test.ts
├── runTest.ts                     # VS Code test executor
└── index.ts                       # Legacy test index
```

## Running Tests

### From Command Line

```bash
# Run all unit tests
npm run test:unit

# Compile and watch for changes
npm run watch
```

### From VS Code

1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Run "Tasks: Run Test Task"
3. Select "npm: test:unit"

Or use the keyboard shortcut assigned to test tasks.

### End-to-end mermaid export test

`unit/services/exporter/mermaidExport.e2e.test.ts` exercises the real export
pipeline by launching headless Chromium and rendering a mermaid diagram to inline
SVG. It is **skipped by default** (and in CI) because it requires a Chrome binary.

To actually run it, point the `MTE_E2E_CHROME` env var at an existing Chrome /
Chrome for Testing executable (for example the one your normal VS Code profile
already downloaded for PDF export) — the test never downloads a browser itself:

```bash
export MTE_E2E_CHROME="/path/to/Google Chrome for Testing"
npm run test:unit
```

When the variable is unset and no browser is found, the test reports as
`pending` rather than failing.

## Writing Tests


### Unit Test Example

```typescript
import * as assert from 'assert';
import * as sinon from 'sinon';

suite('My Service Tests', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        // Reset singletons, create mocks
    });

    teardown(() => {
        sandbox.restore();
        // Clean up
    });

    test('should do something', () => {
        // Arrange
        const expected = 'result';
        
        // Act
        const actual = myFunction();
        
        // Assert
        assert.strictEqual(actual, expected);
    });
});
```

## Test Coverage

Current test coverage:

- ✅ ExtensionContext - 10 tests
- ✅ Config - 10 tests  
- ✅ ErrorHandler - 11 tests
- ✅ BrowserManager - 10 tests

**Total: 41 unit tests**

## Dependencies

- **mocha**: Test framework
- **sinon**: Mocking and stubbing library
- **@vscode/test-electron**: VS Code test utilities
- **@types/mocha**, **@types/sinon**: TypeScript definitions

## Best Practices

1. **Isolation**: Each test should be independent
2. **Mocking**: Use sinon to mock VS Code APIs and file system
3. **Cleanup**: Always restore stubs/mocks in teardown
4. **Singletons**: Reset singleton instances between tests using `_reset()` methods
5. **Naming**: Use descriptive test names starting with "should"

## Continuous Integration

Tests should be run:

- Before committing code
- In CI/CD pipeline
- Before creating pull requests

## Future Enhancements

- [ ] Add integration tests for command execution
- [ ] Add tests for markdown-it plugins
- [ ] Add tests for export functionality
- [ ] Increase code coverage to >80%
- [ ] Add performance benchmarks
