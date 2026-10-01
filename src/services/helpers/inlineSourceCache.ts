import * as vscode from 'vscode';
import { MarkdownIt } from '../../@types/markdown-it';
import { engineEnvironment } from '../../editor/host/engineHost';
import { InlineSource, readInlineSource } from '../../editor/inlineSource';

/**
 * Each document's inline source (`inlineSource.ts`), read once per version and
 * engine: toggling again without an edit in between, or several toggles reading
 * one document, parse it once. A new version, or an engine rebuilt since
 * (another extension's plugin installed, a preview setting changed), reads it
 * again.
 */
const sources = new WeakMap<vscode.TextDocument, { version: number; md: MarkdownIt; source: InlineSource }>();

export function inlineSourceOf(document: vscode.TextDocument, md: MarkdownIt): InlineSource {
    const known = sources.get(document);
    if (known !== undefined && known.version === document.version && known.md === md) {
        return known.source;
    }
    const source = readInlineSource(md, document.getText(), engineEnvironment(document.uri));
    sources.set(document, { version: document.version, md, source });
    return source;
}
