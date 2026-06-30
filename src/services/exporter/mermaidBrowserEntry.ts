// Browser harness bundled by esbuild (the `mermaid-browser` target) into
// `dist/mermaid-browser.js`. It is injected into the bundled headless Chromium at
// export time to expose the mermaid library on a stable, extension-owned global.
//
// This file is NEVER part of the Node extension bundle and is NEVER written into
// exported documents — only its rendered SVG output is kept.
import mermaid from 'mermaid';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__mteMermaid = mermaid;
