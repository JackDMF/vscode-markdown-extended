/**
 * The rich editor's page: a ProseMirror view over the document the host parsed.
 *
 * It imports the schema, the fidelity plugin and the serializer directly, never
 * `../index.ts`: the barrel re-exports the parser and the engine, which would
 * bring the host's markdown-it composition — this extension's plugins and
 * everything they import — into the browser for nothing.
 *
 * That alone does not keep markdown-it itself out: the serializer comes from
 * `prosemirror-markdown`, whose entry module constructs a default parser, and
 * with it a markdown-it instance, as it loads. The bundle aliases `markdown-it`
 * to a stub for that reason (`stubs/markdown-it.ts`).
 */
import { Node } from 'prosemirror-model';
import { EditorState, Transaction } from 'prosemirror-state';
import { EditorView, NodeViewConstructor } from 'prosemirror-view';
import type { ParsedDocumentJSON } from '../parse';
import type { HostMessage, WebviewMessage } from '../protocol';
import { editorSchema } from '../schema';
import { serializeDocument } from '../serialize';
import { EditorPort, FrontMatterView, HeadingView, InjectedBlockView, InlineAtomView, RawBlockView, SourceEditor } from './nodeViews';
import { linkClickPlugin } from './links';
import { objectToolbarPlugin } from './objectToolbar';
import { editorPlugins } from './plugins';
import { resyncTransaction } from './resync';
import { toolbarPlugin } from './toolbar/toolbar';

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
/** A raw block's source was committed: the next edit asks the host to parse the document again. */
let reparseWanted = false;
/** A save is committing the open source boxes; its own edit goes right after. */
let committingForSave = false;
/** The raw blocks whose source is open in a textarea, and not yet in the document. */
const openSourceEditors = new Set<SourceEditor>();

function post(message: WebviewMessage): void {
    vscodeApi.postMessage(message);
}

function serialize(doc: Node): string {
    const meta = current as Current;
    return serializeDocument({ doc, eol: meta.eol, tail: meta.tail }, { defaultWrap: meta.defaultWrap });
}

/**
 * Send the document back now, if it differs from what the host holds — or, for
 * a save, always: the host saves once it has applied the edit, so the file on
 * disk holds the last keystroke (see `onSaveKeydown`). With `reparse` the host
 * posts the document back parsed afresh: the toolbar wrote a construct as
 * source, which only the host can classify and render.
 */
function flush(save = false, reparse = false): void {
    if (editTimer !== undefined) {
        clearTimeout(editTimer);
        editTimer = undefined;
    }
    if (!view || !current) {
        return;
    }
    reparse = reparse || reparseWanted;
    const text = serialize(view.state.doc);
    if (text === hostText && !save && !reparse) {
        return;
    }
    reparseWanted = false;
    hostText = text;
    post({
        type: 'edit',
        text,
        baseVersion: current.version,
        ...(save ? { save: true as const } : {}),
        ...(reparse ? { reparse: true as const } : {}),
    });
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
    openLink: href => {
        // A heading or footnote of this document is in the page: scrolled to, not opened.
        if (href.startsWith('#') && followFragment(href.slice(1))) {
            return;
        }
        post({ type: 'openLink', href });
    },
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
        // What the source now says may not be a source block any more — the
        // markers of a sidenote deleted, a paragraph is left — and only the
        // host's parse can tell. The edit asks for it (`reparse`), and the
        // re-sync puts in whatever the block now is. Sent at once, unless a
        // save is committing: its own edit then carries the request.
        reparseWanted = true;
        if (!committingForSave) {
            flush();
        }
    },
    trackSourceEditor: editor => {
        openSourceEditors.add(editor);
        return () => {
            openSourceEditors.delete(editor);
        };
    },
};

/** Scroll to the element of the document with this id; false when the page has none. */
function followFragment(fragment: string): boolean {
    let id = fragment;
    try {
        id = decodeURIComponent(fragment);
    } catch {
        // As written.
    }
    const target = id === '' ? null : document.getElementById(id);
    if (!target || !mount.contains(target)) {
        return false;
    }
    target.scrollIntoView({ block: 'start' });
    return true;
}

/** Put every open raw-source textarea's text into the document, so the next flush carries it. */
function commitOpenSources(): void {
    for (const editor of [...openSourceEditors]) {
        editor.commitSource();
    }
}

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
    inline_atom: node => new InlineAtomView(node, port),
    front_matter: node => new FrontMatterView(node),
    heading: node => new HeadingView(node),
};
/* eslint-enable @typescript-eslint/naming-convention */

const sourceContext = () => ({
    eol: current?.eol ?? '\n',
    defaultWrap: current?.defaultWrap ?? 90,
    documentText: view ? serialize(view.state.doc) : '',
});

const plugins = [
    ...editorPlugins(),
    linkClickPlugin(href => port.openLink(href)),
    toolbarPlugin({
        sourceContext,
        flushReparse: () => flush(false, true),
        requestRender: src => port.requestRender(src),
    }),
    objectToolbarPlugin({
        openSourceAt: pos => post({ type: 'openSource', line: lineAt(pos) }),
        openSnippet: path => post({ type: 'openSnippet', path }),
        openLink: href => port.openLink(href),
        sourceContext,
        flushReparse: () => flush(false, true),
    }),
];

/** Room above the caret for the sticky toolbar when ProseMirror scrolls the selection into view. */
const SCROLL_MARGIN = { top: 64, bottom: 8, left: 8, right: 8 };

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
    // A parse is what a pending reparse asked for, and this is one.
    reparseWanted = false;
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
    view = new EditorView(mount, { state, nodeViews, dispatchTransaction, scrollMargin: SCROLL_MARGIN });
    view.dom.addEventListener('keydown', onEditorKeydown);
    // Focus leaving the editor for the page around it (a click on the
    // background) does not blur the window; the pending edit goes now, not
    // after the delay.
    view.dom.addEventListener('focusout', () => flush());
}

/**
 * Runs after ProseMirror's own key handling. An undo or redo it performed is
 * kept from VS Code, whose undo would revert the document as well; one it had
 * nothing for goes through, so undoing past the editor's history reaches the
 * document's.
 */
function onEditorKeydown(e: KeyboardEvent): void {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y') && e.defaultPrevented) {
        e.stopPropagation();
    }
}

/**
 * A save is kept from VS Code altogether and sent as an edit that asks the host
 * to save after applying it. Letting VS Code save while the edit is still on its
 * way would write the file without the last keystrokes (its save participant
 * cannot wait for a message that has not arrived yet), and the document would
 * turn dirty again the moment the edit landed.
 *
 * Bound on the window in the capture phase, so it holds wherever the focus is
 * in the page — the editor, a raw block's textarea, the page background — and
 * runs before anything below it sees the key. Stopping propagation is what keeps
 * the key from VS Code: a webview forwards a keydown to the workbench from a
 * bubble-phase listener on its window, which a stopped event never reaches.
 *
 * An open raw-source textarea is committed first; its text is otherwise not in
 * the document the edit is serialized from. Without an editor (the error
 * state, or before the first document) the key stays VS Code's.
 */
function onSaveKeydown(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's' || !view) {
        return;
    }
    committingForSave = true;
    try {
        commitOpenSources();
    } finally {
        committingForSave = false;
    }
    if (e.altKey || e.shiftKey) {
        // Save As and the like stay VS Code's; the pending edit is sent first.
        flush();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    flush(true);
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
    open.className = 'mep-error-button';
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

window.addEventListener('keydown', onSaveKeydown, true);

// Leaving the page must not lose the last keystrokes still inside the delay.
window.addEventListener('blur', () => flush());
window.addEventListener('pagehide', () => flush());

post({ type: 'ready' });
