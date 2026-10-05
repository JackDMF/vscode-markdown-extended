/**
 * The rich editor's page: a ProseMirror view over the document the host parsed.
 *
 * It imports the schema, the fidelity plugin and the serializer directly, never
 * `../index.ts`: the barrel re-exports the parser and the engine, which would
 * bring the host's markdown-it composition — this extension's plugins and
 * everything they import — into the browser for nothing.
 *
 * markdown-it itself is in the page, with the registry's inline plugins and
 * the block plugins whose blocks the editor writes (`../inlineEngine.ts`):
 * the check of an edit reads what the save writes as the host's engine
 * would, to refuse one after which a sidebar or an attribute literal would
 * not read back as it is shown.
 */
import { Node } from 'prosemirror-model';
import { closeHistory, redo, undo } from 'prosemirror-history';
import { EditorState, NodeSelection, Selection, TextSelection, Transaction } from 'prosemirror-state';
import { EditorView, NodeViewConstructor } from 'prosemirror-view';
import type { ParsedDocumentJSON } from '../parse';
import { PositionMap, SourcePosition, caretOf, createPositionMap } from '../positions';
import type { CodeActionItem, HostMessage, LensRow, LinkChoice, LinkedFile, WebviewMessage } from '../protocol';
import { editorSchema } from '../schema';
import type { InlineEngineDefinition } from '../inlineEngine';
import { serializeDocument, setInlineEngine, setWriteOptions } from '../serialize';
import { CaretReporter } from './caret';
import { completionDocumentShown, completionMessage, completionPlugin } from './completion';
import { diagnosticsPlugin, setDiagnosticsTransaction } from './diagnostics';
import { showHint } from './hint';
import { hoverDocumentShown, hoverMessage, hoverPlugin } from './hover';
import { FileGesture, ImageSources, ImageView, fileDropPlugin, readBase64, showImagesIn } from './images';
import { DROP_LOCK, IMAGE_LOCK, insertFilesTransaction, insertLockReason } from './objects';
import { pendingRangePlugin } from './pendingRange';
import { EditorPort, HeadingView, InjectedBlockView, InlineAtomView, RawBlockView, SourceEditor } from './nodeViews';
import { PropertiesView } from './properties';
import { lensPlugin, lensVerbsAt, setLensesTransaction } from './lenses';
import { linkClickPlugin } from './links';
import { objectToolbarPlugin } from './objectToolbar';
import { editorPlugins } from './plugins';
import { resyncTransaction } from './resync';
import { changeIncludeTransaction, insertLineTransaction } from './toolbar/commands';
import { toolbarPlugin, toolbarStatusSlot } from './toolbar/toolbar';

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

/**
 * The position map of each document the page has held (`positions.ts`), made
 * once per document and the facts it was shown with: the caret report, the
 * host's `map` requests and every serialization read the same one, so a block
 * edited since the host's parse is serialized once per state, not per question.
 */
const pageMaps = new WeakMap<Node, { meta: Current; map: PositionMap }>();

function pageMap(doc: Node): PositionMap {
    const meta = current as Current;
    const known = pageMaps.get(doc);
    if (known && known.meta === meta) {
        return known.map;
    }
    const map = createPositionMap({ doc, eol: meta.eol, tail: meta.tail }, { defaultWrap: meta.defaultWrap });
    pageMaps.set(doc, { meta, map });
    return map;
}

function serialize(doc: Node): string {
    return pageMap(doc).text;
}

/**
 * The caret, reported to the host as a source position (`caret.ts`): behind
 * the pending edit, so the host reads it against the text it holds.
 */
const caretReporter = new CaretReporter({
    version: () => current?.version,
    editPending: () => editTimer !== undefined || committingForSave,
    hostText: () => hostText,
    measure: () => {
        if (!view || !current) {
            return undefined;
        }
        const map = pageMap(view.state.doc);
        // A property's field is not a place in the text: no caret while one has the focus.
        return { text: map.text, caret: inPropertiesPanel() ? null : caretOf(view.state.selection, map) };
    },
    post,
});

/** Whether the focus is in the front matter's properties panel (`properties.ts`), whose fields are no source caret. */
function inPropertiesPanel(): boolean {
    const active = document.activeElement;
    return active !== null && active.closest('.mep-properties') !== null;
}

/** The document's uri, as the host wrote it on the page (`html.ts`): what the panel remembers its open state under. */
const documentKey = mount.dataset.documentUri ?? '';

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
    const posted = text !== hostText || save || reparse;
    if (posted) {
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
    // And the caret, which the host reads against it too.
    caretReporter.editSent(posted);
}

/**
 * The host's `map` request, answered from the page's own document: the page
 * owns the mapping, since only it holds the nodes the positions are in. The
 * pending edit goes first, so the answer is in the text the host holds by the
 * time it reads it, and carries the version the host checks it against.
 */
function answerMap(id: number, toSource: readonly number[] = [], toPage: readonly SourcePosition[] = []): void {
    if (!view || !current) {
        post({ type: 'mapped', id, baseVersion: -1, toSource: toSource.map(() => null), toPage: toPage.map(() => null) });
        return;
    }
    flush();
    const map = pageMap(view.state.doc);
    post({
        type: 'mapped',
        id,
        baseVersion: current.version,
        toSource: toSource.map(pos => map.sourcePositionOf(pos)),
        toPage: toPage.map(position => map.pagePositionOf(position)),
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

/** Where each image's `src` is loaded from, as the host resolves it (`images.ts`). */
const imageSources = new ImageSources(
    (requestId, srcs) => post({ type: 'resolveImages', requestId, srcs }),
    () => mount,
);

const port: EditorPort = {
    showImages: container => showImagesIn(container, imageSources),
    // A fragment of this document goes to the host too, which names a heading
    // by the preview's rule (`fragmentLine`) and answers with `revealAnchor`;
    // behind the pending edit, so the host reads the text the page holds.
    openLink: href => {
        flush();
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
    commitFrontMatter: (pos, src) => {
        if (!view) {
            return;
        }
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type !== editorSchema.nodes.front_matter || node.attrs.src === src) {
            return;
        }
        // One step, one undo — its own, never merged with an edit made just
        // before it (`closeHistory`), so "Removed key — Ctrl+Z" undoes exactly
        // the removal. The serializer writes `src` as it stands, so the host
        // receives exactly the lines the panel changed.
        view.dispatch(closeHistory(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src })));
    },
    history: kind => (view ? (kind === 'undo' ? undo : redo)(view.state, view.dispatch) : false),
    hint: (text, near) => {
        if (view) {
            showHint(view, text, 'neutral', near);
        }
    },
    documentKey: () => documentKey,
    leaveFrontMatter: () => {
        if (!view) {
            return;
        }
        const doc = view.state.doc;
        const first = doc.firstChild;
        const after = first && first.type === editorSchema.nodes.front_matter ? first.nodeSize : 0;
        view.focus();
        view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(Math.min(after, doc.content.size)))).scrollIntoView());
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
function runBehindEdit(message: Extract<WebviewMessage, { type: 'runLens' | 'runAction' | 'runHoverCommand' }>): void {
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

/** Whether any extension offers includes for the document shown: the `document` message's `includes`. */
let includesOffered = false;
let includeSeq = 0;
/** The include picks asked of the host: for each, the expansion whose directive the line replaces, `null` for a new one. */
const pendingIncludes = new Map<number, Node | null>();

/**
 * Ask the host for an include line: VS Code's QuickPick, filled with what the
 * extensions that resolve includes offer, takes the choice, so the page draws
 * nothing of its own. With `replaceAt`, the line is for the expansion there
 * (**Change snippet…**), remembered by its node: a document from the host
 * meanwhile keeps an untouched block's node, and one it changed is not
 * replaced by a line chosen for what it was. The pending edit goes first, as
 * before a lens runs, so the host asks the providers about the page's text.
 */
function pickInclude(replaceAt: number | null): void {
    if (!view) {
        return;
    }
    let target: Node | null = null;
    let blockIndex: number | undefined;
    if (replaceAt !== null) {
        const doc = view.state.doc;
        target = replaceAt >= 0 && replaceAt < doc.content.size ? doc.nodeAt(replaceAt) : null;
        if (target === null || target.type !== editorSchema.nodes.injected_block || doc.resolve(replaceAt).depth !== 0) {
            return;
        }
        blockIndex = doc.resolve(replaceAt).index(0);
    }
    flush();
    const requestId = ++includeSeq;
    pendingIncludes.set(requestId, target);
    post({ type: 'pickInclude', requestId, ...(blockIndex !== undefined ? { replace: { blockIndex } } : {}) });
}

/**
 * The host's answer to `pickInclude`: the chosen line inserted after the
 * block the selection is in, or put in place of the expansion's directive,
 * and sent with `reparse` — only the host's parser, which has the providing
 * extension's plugin, can tell what the line expands to. Nothing happens for
 * a dismissed pick but the focus coming back.
 */
function applyInclude(requestId: number, insert: string | undefined): void {
    if (!pendingIncludes.has(requestId)) {
        return;
    }
    const target = pendingIncludes.get(requestId) ?? null;
    pendingIncludes.delete(requestId);
    if (!view || !current) {
        return;
    }
    view.focus();
    if (insert === undefined) {
        return;
    }
    if (target === null) {
        view.dispatch(insertLineTransaction(view.state, insert, current.eol).tr);
    } else {
        let pos = -1;
        view.state.doc.forEach((child, offset) => {
            if (child === target) {
                pos = offset;
            }
        });
        const tr = pos < 0 ? null : changeIncludeTransaction(view.state, pos, insert);
        if (tr === null) {
            showHint(view, 'The snippet was not changed: the block changed while it was being chosen — choose again', 'refusal');
            return;
        }
        view.dispatch(tr);
    }
    flush(false, true);
}

// ---------------------------------------------------------------------------
// Links and images: the host completes, chooses, relativizes and saves
// ---------------------------------------------------------------------------

let linkSeq = 0;
/** The completions asked of the host, by request: an answer to none of them is dropped. */
const pendingLinkChoices = new Map<number, (items: LinkChoice[]) => void>();
let fileSeq = 0;
/** The files asked of the host (the open dialog, a drop, a pasted bitmap), by request, with what to do with the answer. */
const pendingFiles = new Map<number, (files: LinkedFile[]) => void>();

/**
 * Completions for a link's field. A `#` query names this document's headings,
 * which the host reads from its text: the pending edit goes first, so a
 * heading typed a moment ago is among them.
 */
function linkChoices(query: string, images: boolean): Promise<LinkChoice[]> {
    if (!view) {
        return Promise.resolve([]);
    }
    if (query.includes('#')) {
        flush();
    }
    const requestId = ++linkSeq;
    return new Promise(resolve => {
        pendingLinkChoices.set(requestId, resolve);
        post({ type: 'linkChoices', requestId, query, ...(images ? { images: true as const } : {}) });
    });
}

function applyLinkChoices(requestId: number, items: LinkChoice[]): void {
    const resolve = pendingLinkChoices.get(requestId);
    pendingLinkChoices.delete(requestId);
    resolve?.(items);
}

/** Ask the host for files (`pickImage`, `insertFiles`); `chosen` gets the answer while the page still shows a document. */
function askFiles(message: { type: 'pickImage' } | { type: 'insertFiles'; uris: string[] }, chosen: (files: LinkedFile[]) => void): void {
    if (!view) {
        return;
    }
    const requestId = ++fileSeq;
    pendingFiles.set(requestId, chosen);
    post({ ...message, requestId });
}

function applyFiles(requestId: number, files: LinkedFile[]): void {
    const chosen = pendingFiles.get(requestId);
    pendingFiles.delete(requestId);
    if (chosen && view) {
        chosen(files);
    }
}

/**
 * Dropped or pasted files, as the host linked or saved them, at the selection
 * as it is when the answer comes; a refusal is said in the gesture's terms.
 */
function insertLinkedFiles(files: readonly LinkedFile[], gesture: FileGesture): void {
    if (!view || files.length === 0) {
        return;
    }
    const tr = insertFilesTransaction(view.state, files);
    if (tr === null) {
        showHint(view, insertLockReason(view.state, gesture === 'drop' ? DROP_LOCK : IMAGE_LOCK) ?? 'The file cannot be inserted here.', 'refusal');
        return;
    }
    // A single image is selected by the transaction, for **Insert → Image…**'s alt field; here the caret goes after it.
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.selection.to)));
    view.focus();
}

/** A pasted or dropped bitmap: the host saves a copy beside the document and answers with it as the page inserts it. */
function saveBitmap(file: File, gesture: FileGesture): void {
    if (!view) {
        return;
    }
    const requestId = ++fileSeq;
    pendingFiles.set(requestId, files => insertLinkedFiles(files, gesture));
    readBase64(file).then(bytes => {
        if (pendingFiles.has(requestId)) {
            post({ type: 'saveImage', requestId, bytes, suggestedName: file.name || 'image.png' });
        }
    }, () => {
        pendingFiles.delete(requestId);
        if (view) {
            showHint(view, 'The image could not be read.', 'refusal');
        }
    });
}

/** Put the caret where a file was dropped, so the answer goes in there. */
function placeDrop(target: EditorView, event: DragEvent): void {
    const at = target.posAtCoords({ left: event.clientX, top: event.clientY });
    if (at) {
        target.dispatch(target.state.tr.setSelection(Selection.near(target.state.doc.resolve(at.pos))).setMeta('addToHistory', false));
    }
}

/** The element of the document, or of `within`, with the id `id` — decoded already, as the host sends it. */
function elementWithId(id: string, within: Element = mount): HTMLElement | null {
    const target = id === '' ? null : within.querySelector(`[id="${CSS.escape(id)}"]`);
    return target instanceof HTMLElement ? target : null;
}

/**
 * Bring the element a followed link's fragment names into view and put the
 * caret there (`revealAnchor`): the top-level block the host's line starts
 * in. The host resolved the fragment against the document's text by the
 * preview's rule (`fragmentLine`), the one place that rule lives, so the page
 * does not look for a heading's `anchor` of its own: the first heading the
 * browser finds may be one that carries a slug. Without a line (a fragment no
 * heading carries) the page's element with that id, such as a footnote's, is
 * scrolled to. Blocks' start lines only grow, so the block is found by
 * bisection over `lineAt`, which serializes what stands before a block.
 *
 * A heading inside a block (a blockquote, an admonition, a `:::` container)
 * comes with its own line, but the page knows the lines of top-level blocks
 * only, so that line names the block. The host sends the heading's explicit
 * id as `anchor`, so the element with that id inside the block is brought
 * into view and the caret put in it; a nested heading without one lands on
 * the block's start.
 */
function revealAnchor(anchor: string, line: number | null): void {
    if (!view) {
        return;
    }
    if (line === null) {
        elementWithId(anchor)?.scrollIntoView({ block: 'start' });
        return;
    }
    const doc = view.state.doc;
    const offsets: number[] = [];
    doc.forEach((_child, offset) => offsets.push(offset));
    let index = -1;
    if (offsets.length > 0) {
        let low = 0;
        let high = offsets.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (lineAt(offsets[mid]) <= line) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        index = low;
    }
    if (index < 0) {
        return;
    }
    const node = doc.child(index);
    const offset = offsets[index];
    const dom = view.nodeDOM(offset);
    const nested = dom instanceof HTMLElement && !node.isTextblock ? elementWithId(anchor, dom) : null;
    let selection = node.isTextblock
        ? TextSelection.create(doc, offset + 1)
        : node.isAtom ? NodeSelection.create(doc, offset) : Selection.near(doc.resolve(offset + 1));
    if (nested && !node.isAtom) {
        // A rendered block is one atom; inside an editable one the caret goes into the heading.
        selection = Selection.near(doc.resolve(view.posAtDOM(nested, 0)));
    }
    view.focus();
    view.dispatch(view.state.tr.setSelection(selection).setMeta('addToHistory', false));
    const target = nested ?? dom;
    if (target instanceof HTMLElement) {
        target.scrollIntoView({ block: 'start' });
    }
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
    front_matter: (node, _view, getPos) => new PropertiesView(node, getPos, port),
    heading: node => new HeadingView(node),
    image: node => new ImageView(node, imageSources),
};
/* eslint-enable @typescript-eslint/naming-convention */

const sourceContext = () => ({
    eol: current?.eol ?? '\n',
    defaultWrap: current?.defaultWrap ?? 90,
    documentText: view ? serialize(view.state.doc) : '',
});

/**
 * What completion and the pointer's card need from the page: the version of
 * the document shown, the pending edit sent first — every question they ask is
 * in the text the host holds — and the one position map of the state.
 */
const languagePort = {
    version: () => current?.version,
    flush: () => flush(),
    map: () => (view && current ? pageMap(view.state.doc) : undefined),
    post,
};

/**
 * The document's diagnostics, drawn while the page holds the text the host
 * read them against: its own text, no edit waiting. A page ahead of the host
 * keeps its marks, mapped through its edits; the host sends afresh once the
 * edit has landed.
 */
function showDiagnostics(version: number, items: Extract<HostMessage, { type: 'diagnostics' }>['items']): void {
    if (!view || !current || version !== current.version) {
        return;
    }
    if (editTimer !== undefined || committingForSave || serialize(view.state.doc) !== hostText) {
        return;
    }
    view.dispatch(setDiagnosticsTransaction(view.state, pageMap(view.state.doc), items));
}

const plugins = [
    // First, before the editor's keymaps: while its list is open, Enter, Tab and the arrows are the list's.
    completionPlugin(languagePort),
    ...editorPlugins(),
    pendingRangePlugin(),
    linkClickPlugin(href => port.openLink(href)),
    toolbarPlugin({
        sourceContext,
        flushReparse: () => flush(false, true),
        requestRender: src => port.requestRender(src),
        includesOffered: () => includesOffered,
        pickInclude: () => pickInclude(null),
        linkChoices,
        pickImage: chosen => askFiles({ type: 'pickImage' }, chosen),
    }),
    objectToolbarPlugin({
        openSourceAt: pos => post({ type: 'openSource', line: lineAt(pos) }),
        openSnippet: path => post({ type: 'openSnippet', path }),
        openLink: href => port.openLink(href),
        sourceContext,
        flushReparse: () => flush(false, true),
        requestRender: src => port.requestRender(src),
        codeActionsAt,
        runCodeAction: id => runBehindEdit({ type: 'runAction', id }),
        lensesAt: pos => (view ? lensVerbsAt(view.state, pos) : []),
        runLens: id => runBehindEdit({ type: 'runLens', id }),
        includesOffered: () => includesOffered,
        pickInclude: pos => pickInclude(pos),
        linkChoices,
    }),
    lensPlugin(id => runBehindEdit({ type: 'runLens', id })),
    // After the toolbar, whose row holds the count.
    diagnosticsPlugin({
        statusSlot: toolbarStatusSlot,
        showProblems: () => post({ type: 'showProblems' }),
    }),
    hoverPlugin({
        ...languagePort,
        openLink: href => port.openLink(href),
        runAction: id => runBehindEdit({ type: 'runAction', id }),
        runCommand: id => runBehindEdit({ type: 'runHoverCommand', id }),
    }),
    fileDropPlugin({
        insertFiles: (uris, gesture) => askFiles({ type: 'insertFiles', uris }, files => insertLinkedFiles(files, gesture)),
        saveImage: saveBitmap,
    }, placeDrop),
];

/** Room above the caret for the formatting row fixed at the top when ProseMirror scrolls the selection into view. */
const SCROLL_MARGIN = { top: 64, bottom: 8, left: 8, right: 8 };

function dispatchTransaction(this: EditorView, tr: Transaction): void {
    this.updateState(this.state.apply(tr));
    if (tr.docChanged) {
        scheduleFlush();
    }
    if (tr.docChanged || tr.selectionSet) {
        caretReporter.selectionMoved();
    }
}

function showDocument(json: ParsedDocumentJSON, version: number, defaultWrap: number, includes: boolean, inline: InlineEngineDefinition): void {
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
    // Read by the toolbars as they redraw for the state below.
    includesOffered = includes;
    // Before the state below: the refusals read a block as the engine that parsed it does, written as the save writes it.
    setInlineEngine(inline);
    setWriteOptions({ defaultWrap });
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
        caretReporter.documentShown();
        // An open list and a card were about the text before.
        completionDocumentShown(view);
        hoverDocumentShown(view);
        return;
    }
    const state = EditorState.create({ doc, plugins });
    view = new EditorView(mount, { state, nodeViews, dispatchTransaction, scrollMargin: SCROLL_MARGIN });
    caretReporter.documentShown();
    view.dom.addEventListener('keydown', onEditorKeydown);
    // Focus leaving the editor for the page around it (a click on the
    // background) does not blur the window; the pending edit goes now, not
    // after the delay.
    view.dom.addEventListener('focusout', () => flush());
    // A property's field taking or giving back the focus changes what the caret is (none while in one).
    view.dom.addEventListener('focusin', () => caretReporter.selectionMoved());
    view.dom.addEventListener('focusout', () => caretReporter.selectionMoved());
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
    caretReporter.dispose();
    view?.destroy();
    view = undefined;
    current = undefined;
    hostText = undefined;
    // An answer for the document this page no longer shows is dropped.
    pendingFiles.clear();
    pendingLinkChoices.forEach(resolve => resolve([]));
    pendingLinkChoices.clear();
    imageSources.reset();
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
            showDocument(msg.json, msg.version, msg.defaultWrap, msg.includes, msg.inline);
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
        case 'revealAnchor':
            revealAnchor(msg.anchor, msg.line);
            break;
        case 'includeChosen':
            applyInclude(msg.requestId, msg.insert);
            break;
        case 'linkChoicesResult':
            applyLinkChoices(msg.requestId, msg.items);
            break;
        case 'filesChosen':
            applyFiles(msg.requestId, msg.files);
            break;
        case 'imagesResolved':
            imageSources.resolved(msg.requestId, msg.sources);
            break;
        case 'reportCaret':
            caretReporter.reportAgain();
            break;
        case 'map':
            answerMap(msg.id, msg.toSource, msg.toPage);
            break;
        case 'completions':
        case 'completionApplied':
            if (view) {
                completionMessage(view, msg);
            }
            break;
        case 'diagnostics':
            showDiagnostics(msg.version, msg.items);
            break;
        case 'quickFixes':
        case 'hoverResult':
            if (view) {
                hoverMessage(view, msg);
            }
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
