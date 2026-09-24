import * as fs from 'fs';
import * as path from 'path';
import { Node } from 'prosemirror-model';
import { MarkdownIt } from '../../../src/@types/markdown-it';
import { MarkdownItExtender, createEditorEngine } from '../../../src/editor';
import { plugins } from '../../../src/plugin/plugins';

/** The repository root, from `out/test/unit/editor/`. */
export const repoRoot = path.resolve(__dirname, '../../../..');

export const constructsFixture = path.join(repoRoot, 'test', 'fixtures', 'editor', 'constructs.md');

/** Req Explorer's checkout, beside this one unless `REQ_EXPLORER_ROOT` says otherwise. */
export const reqExplorerRoot = process.env.REQ_EXPLORER_ROOT
    ? path.resolve(process.env.REQ_EXPLORER_ROOT)
    : path.resolve(repoRoot, '..', 'req-explorer');

/** One of Req Explorer's conformance documents (`FR-CON.md`, `FR-CON.de.md`), and whether this machine has it. */
export function conformanceDocument(name: string): { file: string; present: boolean } {
    const file = path.join(reqExplorerRoot, 'packages', 'extension', 'testFixture', 'requirements', 'functional', name);
    return { file, present: fs.existsSync(file) };
}

export function readText(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

/** The engine exactly as the host builds it. */
export function hostEngine(extend: MarkdownItExtender[] = []): MarkdownIt {
    return createEditorEngine({ linkify: true, typographer: false, plugins, extend });
}

export function toCrlf(text: string): string {
    return text.replace(/\r?\n/g, '\r\n');
}

export function topChildren(doc: Node): Node[] {
    const out: Node[] = [];
    doc.forEach(child => {
        out.push(child);
    });
    return out;
}

/** The document with its top-level child `index` replaced, as an edit would leave it. */
export function replaceChild(doc: Node, index: number, replacement: Node): Node {
    const children = topChildren(doc);
    children[index] = replacement;
    return doc.type.create(doc.attrs, children);
}

/** A copy of `node` with `src` cleared: what the fidelity plugin leaves after an edit. */
export function touched(node: Node, content = node.content): Node {
    return node.type.create({ ...node.attrs, src: null }, content, node.marks);
}
