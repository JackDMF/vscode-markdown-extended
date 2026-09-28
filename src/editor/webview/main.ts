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
import type { CodeActionItem, HostMessage, LensRow, WebviewMessage } from '../protocol';
import { editorSchema } from '../schema';
import { serializeDocument } from '../serialize';
import { showHint } from './hint';
import { EditorPort, FrontMatterView, HeadingView, InjectedBlockView, InlineAtomView, RawBlockView, SourceEditor } from './nodeViews';
import { lensPlugin, lensVerbsAt, setLensesTransaction } from './lenses';
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
    if (text !== hostText || save || reparse) {
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
    // Behind the edit, so the host looks the blocks up in this text.
    sendDeferredActions();
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

/**
 * Other extensions' code actions per top-level block, as the host last answered
 * for it. Keyed by the node: an edit to the block makes a new node, which is
 * asked about afresh. An answer is good for one `epoch` — until the next
 * document or lens refresh from the host, after which a diagnostic behind a
 * quick fix may have come or gone — and is shown while it is asked again.
 */
interface KnownActions {
    items: readonly CodeActionItem[];
    epoch: number;
    asking: boolean;
}

const knownActions = new WeakMap<Node, KnownActions>();
const pendingActions = new Map<number, { node: Node; epoch: number }>();
/** Blocks whose actions are asked once the page's pending edit has gone (`flush`). */
const deferredActions = new Set<Node>();
let actionSeq = 0;
let actionEpoch = 0;

/**
 * Ask the host for the actions of the top-level `node`, by its index now. The
 * host maps the index to lines in the text it holds, so while the page holds
 * another — an edit waiting in the delay, a change this very transaction made,
 * a save committing its source boxes — the question waits for the edit that
 * carries it. Not sent from here by flushing: this runs while the toolbar
 * redraws, inside a transaction a save may be in the middle of.
 */
function askActions(node: Node): void {
    if (!view || !current) {
        return;
    }
    if (editTimer !== undefined || committingForSave || serialize(view.state.doc) !== hostText) {
        deferredActions.add(node);
        return;
    }
    sendActionsFor(node);
}

function sendActionsFor(node: Node): void {
    if (!view) {
        return;
    }
    const doc = view.state.doc;
    let blockIndex = -1;
    doc.forEach((child, _offset, i) => {
        if (child === node) {
            blockIndex = i;
        }
    });
    if (blockIndex < 0) {
        // Edited or gone since: the node now there is asked about when its bar shows.
        return;
    }
    const requestId = ++actionSeq;
    pendingActions.set(requestId, { node, epoch: actionEpoch });
    post({ type: 'actionsFor', requestId, blockIndex, blocks: doc.childCount });
}

function sendDeferredActions(): void {
    const nodes = [...deferredActions];
    deferredActions.clear();
    nodes.forEach(sendActionsFor);
}

/** A meta that only makes the plugin views look again: the object toolbar redraws with the answer. */
const ACTIONS_ARRIVED_META = 'mepActionsArrived';

function codeActionsAt(pos: number): readonly CodeActionItem[] {
    if (!view) {
        return [];
    }
    const doc = view.state.doc;
    if (pos < 0 || pos >= doc.content.size || doc.resolve(pos).depth !== 0) {
        return [];
    }
    const node = doc.child(doc.resolve(pos).index(0));
    const known = knownActions.get(node);
    if (!known || (known.epoch !== actionEpoch && !known.asking)) {
        knownActions.set(node, { items: known?.items ?? [], epoch: actionEpoch, asking: true });
        askActions(node);
    }
    return known?.items ?? [];
}

/**
 * Run another extension's lens or code action, after the edit still waiting in
 * the delay: the host queues the run behind it. Posted at once, the run could
 * write to the document before the typed text arrived, and the host would then
 * refuse that text as computed against a document that has moved on.
 */
function runBehindEdit(message: Extract<WebviewMessage, { type: 'runLens' | 'runAction' }>): void {
    flush();
    post(message);
}

/**
 * Every answer the page holds may be out of date: asked again when its bar
 * shows, the bar shown now redrawn so it asks. With `refused`, a chosen action
 * was not applied because the text changed since it was offered.
 */
function invalidateActions(refused: string | undefined): void {
    actionEpoch++;
    if (!view) {
        return;
    }
    view.dispatch(view.state.tr.setMeta(ACTIONS_ARRIVED_META, true).setMeta('addToHistory', false));
    if (refused !== undefined) {
        showHint(view, `"${refused}" was not applied: the text changed since it was offered — choose it again`, 'refusal');
    }
}

function applyActions(requestId: number, items: CodeActionItem[]): void {
    const asked = pendingActions.get(requestId);
    pendingActions.delete(requestId);
    if (!asked || !view) {
        return;
    }
    knownActions.set(asked.node, { items, epoch: asked.epoch, asking: false });
    view.dispatch(view.state.tr.setMeta(ACTIONS_ARRIVED_META, true).setMeta('addToHistory', false));
}

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
        codeActionsAt,
        runCodeAction: id => runBehindEdit({ type: 'runAction', id }),
        lensesAt: pos => (view ? lensVerbsAt(view.state, pos) : []),
        runLens: id => runBehindEdit({ type: 'runLens', id }),
    }),
    lensPlugin(id => runBehindEdit({ type: 'runLens', id })),
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
    actionEpoch++;
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
        sendDeferredActions();
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

/**
 * Other extensions' lenses for the document of `version`, grouped by the index
 * of the top-level block in the host's parse. Taken only while the page holds
 * as many blocks as that parse had: a page that split or joined blocks since
 * is ahead of the rows, and the host refreshes after that edit lands. Rows for
 * a document older than the one shown are dropped; empty rows always clear.
 */
function showLenses(version: number, blocks: number, rows: LensRow[]): void {
    if (!view || !current || version < current.version) {
        return;
    }
    // The host has looked at the document again: the code actions are asked again too.
    actionEpoch++;
    if (rows.length > 0 && blocks !== view.state.doc.childCount) {
        return;
    }
    view.dispatch(setLensesTransaction(view.state, rows));
}

/** A lens may depend on other files, and no provider's change event reaches this extension: asked again when the page is back. */
function refreshLenses(): void {
    if (view) {
        post({ type: 'refreshLenses' });
    }
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
        case 'lenses':
            showLenses(msg.version, msg.blocks, msg.rows);
            break;
        case 'actions':
            applyActions(msg.requestId, msg.items);
            break;
        case 'invalidateActions':
            invalidateActions(msg.refused);
            break;
    }
});

window.addEventListener('keydown', onSaveKeydown, true);

// Leaving the page must not lose the last keystrokes still inside the delay.
window.addEventListener('blur', () => flush());
window.addEventListener('pagehide', () => flush());

window.addEventListener('focus', refreshLenses);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        refreshLenses();
    }
});

post({ type: 'ready' });
