/**
 * The rich editor's page: a ProseMirror view over the document the host parsed.
 *
 * It imports the schema, the fidelity plugin and the serializer directly, never
 * `../index.ts`: the barrel re-exports the parser and the engine, which would
 * bring the host's markdown-it composition into the browser for nothing.
 */
import { Node } from 'prosemirror-model';
import { EditorState, Transaction } from 'prosemirror-state';
import { EditorView, NodeViewConstructor } from 'prosemirror-view';
import type { ParsedDocumentJSON } from '../parse';
import type { HostMessage, WebviewMessage } from '../protocol';
import { editorSchema } from '../schema';
import { serializeDocument } from '../serialize';
import { EditorPort, FrontMatterView, HeadingView, InjectedBlockView, InlineAtomView, RawBlockView } from './nodeViews';
import { editorPlugins } from './plugins';
import { resyncTransaction } from './resync';

interface VsCodeApi {
    postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** How long typing is left to settle before the document is sent back. */
const EDIT_DELAY_MS = 250;

const vscodeApi = acquireVsCodeApi();
const mount = document.getElementById('mep-editor') as HTMLElement;

/** What the current document knows beyond its tree. */
interface Current {
    eol: '\n' | '\r\n';
    tail: string;
    version: number;
    defaultWrap: number;
}

let view: EditorView | undefined;
let current: Current | undefined;
/** The text the host holds for this page: the one it sent, or the last one sent to it. */
let hostText: string | undefined;
let editTimer: ReturnType<typeof setTimeout> | undefined;
let renderSeq = 0;
const pendingRenders = new Map<number, string>();

function post(message: WebviewMessage): void {
    vscodeApi.postMessage(message);
}

function serialize(doc: Node): string {
    const meta = current as Current;
    return serializeDocument({ doc, eol: meta.eol, tail: meta.tail }, { defaultWrap: meta.defaultWrap });
}

/** Send the document back now, if it differs from what the host holds. */
function flush(): void {
    if (editTimer !== undefined) {
        clearTimeout(editTimer);
        editTimer = undefined;
    }
    if (!view || !current) {
        return;
    }
    const text = serialize(view.state.doc);
    if (text === hostText) {
        return;
    }
    hostText = text;
    post({ type: 'edit', text, baseVersion: current.version });
}

function scheduleFlush(): void {
    if (editTimer !== undefined) {
        clearTimeout(editTimer);
    }
    editTimer = setTimeout(flush, EDIT_DELAY_MS);
}

/**
 * The 0-based line the top-level node holding `pos` starts on, counted in the
 * text the serializer would write for everything before it — exact while
 * those blocks are untouched, which is when a line number is worth anything.
 */
function lineAt(pos: number): number {
    if (!view || !current) {
        return 0;
    }
    const doc = view.state.doc;
    const index = doc.resolve(Math.min(pos, doc.content.size)).index(0);
    const before: Node[] = [];
    for (let i = 0; i < index; i++) {
        before.push(doc.child(i));
    }
    const prefix = serializeDocument(
        { doc: editorSchema.topNodeType.create(null, before), eol: current.eol, tail: '' },
        { defaultWrap: current.defaultWrap },
    );
    const node = index < doc.childCount ? doc.child(index) : null;
    const gap = (node?.attrs.gap as string | null | undefined) ?? (prefix === '' ? '' : '\n');
    return (prefix.match(/\n/g) ?? []).length + (gap.match(/\n/g) ?? []).length;
}

const port: EditorPort = {
    openSourceAt: pos => post({ type: 'openSource', line: lineAt(pos) }),
    openSnippet: path => post({ type: 'openSnippet', path }),
    requestRender: src => {
        const requestId = ++renderSeq;
        pendingRenders.set(requestId, src);
        post({ type: 'render', requestId, src });
    },
    eol: () => current?.eol ?? '\n',
    commitRawSource: (pos, src) => {
        if (!view) {
            return;
        }
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type !== editorSchema.nodes.raw_block) {
            return;
        }
        if (src === '') {
            view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
            return;
        }
        // The old rendering stays until the host's arrives, so the block does
        // not flash empty; `html` is not written to the file.
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src }));
        port.requestRender(src);
    },
};

/** Put a rendering on every raw block that still has the source it was made from. */
function applyRendered(requestId: number, html: string): void {
    const src = pendingRenders.get(requestId);
    pendingRenders.delete(requestId);
    if (src === undefined || !view) {
        return;
    }
    const tr = view.state.tr;
    view.state.doc.forEach((child, offset) => {
        if (child.type === editorSchema.nodes.raw_block && child.attrs.src === src && child.attrs.html !== html) {
            tr.setNodeMarkup(offset, undefined, { ...child.attrs, html });
        }
    });
    if (tr.docChanged) {
        // A rendering is not a step the person took, so undo skips it.
        view.dispatch(tr.setMeta('addToHistory', false));
    }
}

/* eslint-disable @typescript-eslint/naming-convention -- keyed by the schema's node names, which ProseMirror spells in snake_case */
const nodeViews: Record<string, NodeViewConstructor> = {
    raw_block: (node, _view, getPos) => new RawBlockView(node, getPos, port),
    injected_block: node => new InjectedBlockView(node, port),
    inline_atom: node => new InlineAtomView(node),
    front_matter: node => new FrontMatterView(node),
    heading: node => new HeadingView(node),
};
/* eslint-enable @typescript-eslint/naming-convention */

const plugins = editorPlugins();

function dispatchTransaction(this: EditorView, tr: Transaction): void {
    this.updateState(this.state.apply(tr));
    if (tr.docChanged) {
        scheduleFlush();
    }
}

function showDocument(json: ParsedDocumentJSON, version: number, defaultWrap: number): void {
    // An edit still waiting in the delay is dropped: it was computed against
    // the document this one supersedes, and the host would refuse it for its
    // stale base. The keystrokes it carried vanish with it — the price of never
    // merging (README, "Limits").
    if (editTimer !== undefined) {
        clearTimeout(editTimer);
        editTimer = undefined;
    }
    hideError();
    const doc = Node.fromJSON(editorSchema, json.doc);
    current = { eol: json.eol, tail: json.tail, version, defaultWrap };
    hostText = serialize(doc);
    if (view) {
        // Changed in place rather than rebuilt, so the undo history survives a
        // change made elsewhere (a save that trims whitespace is one). Applied
        // past `dispatchTransaction`: it is not an edit to send back. The
        // selection is mapped through the change, so a caret outside the
        // replaced blocks stays where it was.
        view.updateState(view.state.apply(resyncTransaction(view.state, doc)));
        return;
    }
    const state = EditorState.create({ doc, plugins });
    view = new EditorView(mount, { state, nodeViews, dispatchTransaction });
    view.dom.addEventListener('keydown', onEditorKeydown);
}

/**
 * Runs after ProseMirror's own key handling. An undo or redo it performed is
 * kept from VS Code, whose undo would revert the document as well; one it had
 * nothing for goes through, so undoing past the editor's history reaches the
 * document's. A save sends the pending edit first.
 */
function onEditorKeydown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) {
        return;
    }
    const key = e.key.toLowerCase();
    if ((key === 'z' || key === 'y') && e.defaultPrevented) {
        e.stopPropagation();
    } else if (key === 's') {
        flush();
    }
}

// ---------------------------------------------------------------------------
// The error state: the document cannot be shown without losing a byte.
// ---------------------------------------------------------------------------

let banner: HTMLElement | undefined;

function showError(message: string): void {
    if (editTimer !== undefined) {
        clearTimeout(editTimer);
        editTimer = undefined;
    }
    view?.destroy();
    view = undefined;
    current = undefined;
    hostText = undefined;
    mount.replaceChildren();
    banner?.remove();
    banner = document.createElement('div');
    banner.className = 'mep-error';
    const text = document.createElement('p');
    text.textContent = `This document cannot be edited here without changing it: ${message}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'mep-atom-button';
    open.textContent = 'Open in text editor';
    open.addEventListener('click', () => post({ type: 'openSource', line: 0 }));
    banner.append(text, open);
    document.body.prepend(banner);
}

function hideError(): void {
    banner?.remove();
    banner = undefined;
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.type) {
        case 'document':
            showDocument(msg.json, msg.version, msg.defaultWrap);
            break;
        case 'rendered':
            applyRendered(msg.requestId, msg.html);
            break;
        case 'error':
            showError(msg.message);
            break;
    }
});

// Leaving the page must not lose the last keystrokes still inside the delay.
window.addEventListener('blur', flush);
window.addEventListener('pagehide', flush);

post({ type: 'ready' });
