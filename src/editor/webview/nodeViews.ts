import { DOMOutputSpec, DOMSerializer, Node } from 'prosemirror-model';
import { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import { followLinksIn } from './links';

/** What the node views need from the page around them. */
export interface EditorPort {
    /** Follow a Ctrl/Cmd+clicked link, its href as the element carries it (`links.ts`). */
    openLink(href: string): void;
    /** Ask the host to render a raw block's new source; the page puts the HTML on every block that still has that source. */
    requestRender(src: string): void;
    /** The document's line ending, which an edited raw block's source is written with. */
    eol(): '\n' | '\r\n';
    /** Replace the source of the raw block at `pos`; `''` removes the block. */
    commitRawSource(pos: number, src: string): void;
    /**
     * A raw block's source editor has opened; the returned function is called
     * when it closes. The page asks every open one to commit before it saves.
     */
    trackSourceEditor(editor: SourceEditor): () => void;
    /**
     * A rendering's images drawn from where the host says they are
     * (`images.ts`): the rendered HTML's `src` is the file's, which the page
     * cannot load as it stands.
     */
    showImages(container: HTMLElement): void;
}

/** A raw block's open source editor, as the page sees it. */
export interface SourceEditor {
    /** Write what the textarea holds into the document now, leaving it open. */
    commitSource(): void;
}

type GetPos = () => number | undefined;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (className) {
        el.className = className;
    }
    if (text !== undefined) {
        el.textContent = text;
    }
    return el;
}

/** Whether the key event is the platform's undo or redo chord. */
function isUndoRedo(e: KeyboardEvent): boolean {
    return (e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y');
}

/**
 * Shared behaviour of the atoms: not editable as rich text, selected as a whole,
 * and every DOM mutation inside is the view's own (innerHTML, a toggled
 * `<details>`), never content ProseMirror should read back.
 */
abstract class AtomView implements NodeView {
    readonly dom: HTMLElement;

    constructor(protected node: Node, tag: 'div' | 'span' | 'details', className: string) {
        this.dom = element(tag, `mep-atom ${className}`);
        this.dom.contentEditable = 'false';
    }

    update(node: Node): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        this.node = node;
        this.render();
        return true;
    }

    selectNode(): void {
        this.dom.classList.add('ProseMirror-selectednode');
    }

    deselectNode(): void {
        this.dom.classList.remove('ProseMirror-selectednode');
    }

    ignoreMutation(): boolean {
        return true;
    }

    protected abstract render(): void;
}

/**
 * A block the editor does not edit as rich text — a table, raw HTML, a
 * definition list, anything outside the editable core. It shows the host's rendering
 * (or the source itself, for lines no token covers), and its source can be
 * edited in place: **Edit source** in its object toolbar (`objectToolbar.ts`),
 * or a double click, opens a textarea; `Ctrl+Enter` or leaving it commits,
 * `Esc` cancels.
 *
 * What the textarea holds is not in the document until it commits, so a save
 * would miss it. The view registers itself with the page while it is open, and
 * the page commits it (`commitSource`) before any save; the textarea stays open,
 * and `Esc` afterwards returns to the source that save wrote.
 */
export class RawBlockView extends AtomView implements SourceEditor {
    private readonly content: HTMLElement;
    private editor: HTMLTextAreaElement | null = null;
    private untrack: (() => void) | null = null;

    constructor(node: Node, private readonly getPos: GetPos, private readonly port: EditorPort) {
        super(node, 'div', 'mep-raw-block');
        this.content = element('div', 'mep-atom-content');
        this.dom.append(this.content);
        inertControls(this.content);
        followLinksIn(this.content, href => this.port.openLink(href));
        // A double click on the rendering opens the source, as a double click on
        // text would start editing it.
        this.content.addEventListener('dblclick', e => {
            if (!this.editor) {
                e.preventDefault();
                this.editSource();
            }
        });
        rawBlockViews.set(this.dom, this);
        this.render();
    }

    /** The node's selection outline is not redrawn under an open source box; the box is the edit. */
    selectNode(): void {
        if (!this.editor) {
            super.selectNode();
        }
    }

    deselectNode(): void {
        if (!this.editor) {
            super.deselectNode();
        }
    }

    protected render(): void {
        if (this.editor) {
            return;
        }
        const html = this.node.attrs.html as string;
        if (html) {
            this.content.innerHTML = html;
            this.port.showImages(this.content);
        } else {
            this.content.replaceChildren(element('pre', 'mep-raw-source', this.node.attrs.src as string));
        }
    }

    /**
     * Every event inside the open source box is its own, of any type — pointer,
     * keyboard, input, clipboard, focus, selection, drag. ProseMirror taking a
     * mousedown in the textarea would make a node selection of the block and
     * move the caret out of the box. (Selection changes inside the view are not
     * ProseMirror's either: `ignoreMutation` answers true.) The block's verbs
     * are in the object toolbar, outside the editor's DOM.
     */
    stopEvent(event: Event): boolean {
        const target = event.target as globalThis.Node | null;
        return target !== null && (this.editor?.contains(target) ?? false);
    }

    /** Open the block's source in a textarea; the object toolbar's **Edit source** calls it, and the formatting toolbar for a block it inserted. */
    editSource(): void {
        if (this.editor) {
            return;
        }
        const src = this.node.attrs.src as string;
        const area = element('textarea', 'mep-raw-editor');
        // The textarea shows `\n`; the terminator of the last line is not text
        // anybody edits, and is put back on commit.
        area.value = src.replace(/\r\n?/g, '\n').replace(/\n$/, '');
        area.rows = Math.max(3, area.value.split('\n').length + 1);
        area.spellcheck = false;
        area.addEventListener('keydown', e => {
            if (isUndoRedo(e)) {
                // The textarea's own undo; kept from VS Code, whose undo would
                // revert the document instead.
                e.stopPropagation();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.stopEditing(false);
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                this.stopEditing(true);
            }
        });
        area.addEventListener('blur', () => this.stopEditing(true));
        this.dom.classList.remove('ProseMirror-selectednode');
        this.editor = area;
        this.untrack = this.port.trackSourceEditor(this);
        this.dom.classList.add('mep-editing');
        this.content.replaceChildren(area);
        area.focus();
        // At the end, where a person adding to the block starts; the source
        // lines do not map to points of the rendering, so a double click cannot
        // say where in the source it meant.
        area.setSelectionRange(area.value.length, area.value.length);
    }

    commitSource(): void {
        const area = this.editor;
        if (!area) {
            return;
        }
        if (area.value.trim() === '') {
            // Committing an emptied block removes it, textarea and all.
            this.stopEditing(true);
            return;
        }
        // The node's new `src` comes back through `update`, which leaves an
        // open textarea alone (`render`).
        this.commit(area.value);
    }

    destroy(): void {
        this.untrack?.();
        this.untrack = null;
    }

    private stopEditing(commit: boolean): void {
        const area = this.editor;
        if (!area) {
            return;
        }
        this.editor = null;
        this.untrack?.();
        this.untrack = null;
        this.dom.classList.remove('mep-editing');
        const value = area.value;
        this.render();
        if (commit) {
            this.commit(value);
        }
    }

    private commit(value: string): void {
        const pos = this.getPos();
        const src = this.node.attrs.src as string;
        const next = withSourceTerminators(value, src, this.port.eol());
        if (pos === undefined || next === src) {
            return;
        }
        this.port.commitRawSource(pos, next);
    }
}

/**
 * Form controls in a rendering are shown, not used: a task list's checkbox
 * would toggle on a click while the file kept `[ ]`. Only the controls the
 * rendering holds — an open source textarea is never a checkbox or a select.
 */
function inertControls(content: HTMLElement): void {
    content.addEventListener('click', e => {
        const target = e.target as Element | null;
        if (target && target.closest('input[type="checkbox"], input[type="radio"], select, option')) {
            e.preventDefault();
        }
    });
}

/** Each raw block's view by its DOM, so the page can reach the view ProseMirror made for a block. */
const rawBlockViews = new WeakMap<globalThis.Node, RawBlockView>();

/** Open the **Edit source** box of the raw block at `pos`. False when there is no raw block there. */
export function editRawSourceAt(view: EditorView, pos: number): boolean {
    const dom = view.nodeDOM(pos);
    const rawView = dom ? rawBlockViews.get(dom) : undefined;
    if (!rawView) {
        return false;
    }
    rawView.editSource();
    return true;
}

/**
 * The textarea's value as source text: its `\n`s as the document's line ending,
 * and the last line terminated as the original was. An emptied block is `''`,
 * which the caller turns into a deletion.
 */
export function withSourceTerminators(value: string, original: string, eol: '\n' | '\r\n'): string {
    if (value.trim() === '') {
        return '';
    }
    const terminated = /(\r\n|\r|\n)$/.exec(original);
    const body = value.replace(/\r\n?/g, '\n').replace(/\n/g, eol);
    return terminated ? body + terminated[1] : body;
}

/**
 * Content the file does not hold at this place (Req Explorer SPEC §10.2):
 * shown, never edited. Its verbs — an expansion's **Open snippet** when its
 * mark names the file, **Show in text editor**, **Delete directive** — are in
 * the object toolbar (`objectToolbar.ts`); an atom (a summary table,
 * generated footnotes) is its rendering alone.
 */
export class InjectedBlockView extends AtomView {
    private readonly content: HTMLElement;

    constructor(node: Node, private readonly port: EditorPort) {
        super(node, 'div', 'mep-injected-block');
        this.content = element('div', 'mep-atom-content');
        this.dom.append(this.content);
        inertControls(this.content);
        // An atom Req Explorer injected (mark kind `atom`: the summary table)
        // is a read model — nothing in it is edited here — so a plain click on
        // one of its links opens it. An expansion is a snippet's text, and
        // keeps the Ctrl+click rule of text.
        followLinksIn(this.content, href => port.openLink(href), () => isReadModel(this.node));
        this.render();
    }

    protected render(): void {
        this.dom.dataset.kind = this.node.attrs.kind as string;
        this.content.innerHTML = this.node.attrs.html as string;
        this.port.showImages(this.content);
    }
}

/** Whether an injected block is a read model: an atom Req Explorer injected (its mark's kind is `atom`), whose links a plain click opens. */
function isReadModel(node: Node): boolean {
    const mark = node.attrs.mark as { kind?: unknown } | null;
    return mark !== null && typeof mark === 'object' && mark.kind === 'atom';
}

/** An inline injected atom — Req Explorer's status badge on a heading. */
export class InlineAtomView extends AtomView {
    constructor(node: Node, private readonly port: EditorPort) {
        super(node, 'span', 'mep-inline-atom');
        followLinksIn(this.dom, href => port.openLink(href));
        this.render();
    }

    protected render(): void {
        this.dom.innerHTML = this.node.attrs.html as string;
        this.port.showImages(this.dom);
    }
}

/**
 * The front matter: collapsed, read-only, the raw YAML. It is written back
 * byte for byte, and only Req Explorer's mutation engine may change it.
 */
export class FrontMatterView extends AtomView {
    private readonly body: HTMLElement;

    constructor(node: Node) {
        super(node, 'details', 'mep-front-matter');
        this.dom.append(element('summary', undefined, 'Front matter'));
        this.body = element('pre', 'mep-front-matter-source');
        this.dom.append(this.body);
        this.render();
    }

    protected render(): void {
        this.body.textContent = this.node.attrs.src as string;
    }

    /** The browser toggles `<details>` and selects the YAML; ProseMirror stays out of both. */
    stopEvent(event: Event): boolean {
        return event.type !== 'dragstart';
    }
}

/**
 * A heading as the schema draws it. For a requirement heading that is the id
 * prefix in a non-editable span and the title as the content hole, so no
 * keystroke reaches the id; the anchor is only the element's `id`. A change of
 * level, prefix or anchor redraws the heading.
 */
export class HeadingView implements NodeView {
    readonly dom: HTMLElement;
    readonly contentDOM: HTMLElement;

    constructor(private node: Node) {
        const spec = node.type.spec.toDOM?.(node) as DOMOutputSpec;
        const rendered = DOMSerializer.renderSpec(document, spec);
        this.dom = rendered.dom as HTMLElement;
        this.contentDOM = (rendered.contentDOM ?? rendered.dom) as HTMLElement;
    }

    update(node: Node): boolean {
        if (node.type !== this.node.type
            || node.attrs.level !== this.node.attrs.level
            || node.attrs.reqPrefix !== this.node.attrs.reqPrefix
            || node.attrs.anchor !== this.node.attrs.anchor
            // The suffix's classes and attributes are on the element (`headingDOM`).
            || node.attrs.attrsSuffix !== this.node.attrs.attrsSuffix) {
            return false;
        }
        this.node = node;
        return true;
    }

    ignoreMutation(mutation: ViewMutationRecord): boolean {
        return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target);
    }
}
