/**
 * The rich editor's UI-free core: engine composition, the source-block model,
 * the ProseMirror schema, parsing and serialization, and the fidelity plugin.
 * Nothing here needs `vscode` or a DOM, so the extension host and the webview
 * load the same modules. Types are re-exported with `export type` so a
 * per-file transpiler (esbuild) does not emit re-exports for them.
 */
export { createEditorEngine } from './engine';
export type { EditorEngineOptions, MarkdownItExtender, MarkdownItPlugin } from './engine';
export {
    EDITABLE_BLOCK_TOKENS,
    EDITABLE_INLINE_TOKENS,
    EDITABLE_TOP_LEVEL_TOKENS,
    INJECTION_META_KEY,
    MAX_WRAPPER_DEPTH,
    detectEol,
    findAttrsSuffix,
    findEndLiteral,
    groupSourceBlocks,
    injectionMarkOf,
    isBlankLine,
    sliceLines,
    splitLines,
} from './blocks';
export type { AttrsPlacement, BlockAttrs, BlockKind, GroupedBlocks, InjectedKind, InjectionMark, SourceBlock, SourceLine } from './blocks';
export { EDITABLE_TOP_NODES, SOURCE_NODES, SUFFIX_NODES, WRAPPER_NODES, editorSchema } from './schema';
export { domAttrsOf, normalizedLiteral, parseAttrsLiteral } from './attrs';
export type { EditorSchema } from './schema';
export { blockLineRanges, parseDocument, parsedDocumentFromJSON, parsedDocumentToJSON } from './parse';
export type { ParsedDocument, ParsedDocumentJSON } from './parse';
export { serializeDocument, serializeNode } from './serialize';
export { hasBreakOpportunity, measureLineWidth, measureWrapWidth, wrapInline } from './wrap';
export type { SerializeOptions } from './serialize';
export { PRESERVE_SOURCE_META, fidelityPlugin, fidelityPluginKey } from './fidelity';
