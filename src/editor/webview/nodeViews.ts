import { DOMOutputSpec, DOMSerializer, Node } from 'prosemirror-model';
import { NodeView, ViewMutationRecord } from 'prosemirror-view';

/** What the node views need from the page around them. */
export interface EditorPort {
    /** Open the text editor beside, at the line the top-level node at `pos` starts on. */
    openSourceAt(pos: number): void;
    openSnippet(path: string): void;
    /** Ask the host to render a raw block's new source; the page puts the HTML on every block that still has that source. */
    requestRender(src: string): void;
    /** The document's line ending, which an edited raw block's source is written with. */
    eol(): '\n' | '\r\n';
    /** Replace the source of the raw block at `pos`; `''` removes the block. */
    commitRawSource(pos: number, src: string): void;
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

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const el = element('button', 'mep-atom-button', label);
    el.type = 'button';
    el.title = title;
    // mousedown, not only click: ProseMirror would otherwise take the press as
    // the start of a node selection and move the focus away first.
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', e => {
        e.preventDefault();
        onClick();
    });
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
 * container, anything outside the editable core. It shows the host's rendering
 * (or the source itself, for lines no token covers), and its source can be
 * edited in place: **Edit source** opens a textarea, `Ctrl+Enter` or leaving it
 * commits, `Esc` cancels.
 */
export class RawBlockView extends AtomView {
    private readonly content: HTMLElement;
    private editor: HTMLTextAreaElement | null = null;
    private readonly toolbar: HTMLElement;

    constructor(node: Node, private readonly getPos: GetPos, private readonly port: EditorPort) {
        super(node, 'div', 'mep-raw-block');
        this.toolbar = element('div', 'mep-atom-toolbar');
        this.toolbar.append(
            element('span', 'mep-atom-label', 'Source block'),
            button('Edit source', 'Edit this block as Markdown (Ctrl+Enter to apply, Esc to cancel)', () => this.startEditing()),
            button('Show in text editor', 'Open the text editor beside, at this block', () => {
                const pos = this.getPos();
                if (pos !== undefined) {
                    this.port.openSourceAt(pos);
                }
            }),
        );
        this.content = element('div', 'mep-atom-content');
        this.dom.append(this.toolbar, this.content);
        this.render();
    }

    protected render(): void {
        if (this.editor) {
            return;
        }
        const html = this.node.attrs.html as string;
        if (html) {
            this.content.innerHTML = html;
        } else {
            this.content.replaceChildren(element('pre', 'mep-raw-source', this.node.attrs.src as string));
        }
    }

    stopEvent(event: Event): boolean {
        const target = event.target as globalThis.Node | null;
        return target !== null && (this.toolbar.contains(target) || (this.editor?.contains(target) ?? false));
    }

    private startEditing(): void {
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
        this.editor = area;
        this.dom.classList.add('mep-editing');
        this.content.replaceChildren(area);
        area.focus();
    }

    private stopEditing(commit: boolean): void {
        const area = this.editor;
        if (!area) {
            return;
        }
        this.editor = null;
        this.dom.classList.remove('mep-editing');
        const value = area.value;
        this.render();
        if (!commit) {
            return;
        }
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
 * shown, never edited. An include expansion that resolved names its snippet
 * file and offers to open it; a `missing` one carries no path and offers
 * nothing, and an atom (a summary table, generated footnotes) is its rendering
 * alone.
 */
export class InjectedBlockView extends AtomView {
    private readonly toolbar: HTMLElement;
    private readonly content: HTMLElement;

    constructor(node: Node, private readonly port: EditorPort) {
        super(node, 'div', 'mep-injected-block');
        this.toolbar = element('div', 'mep-atom-toolbar');
        this.content = element('div', 'mep-atom-content');
        this.dom.append(this.toolbar, this.content);
        this.render();
    }

    protected render(): void {
        const kind = this.node.attrs.kind as string;
        const mark = this.node.attrs.mark as { snippet?: unknown; path?: unknown; missing?: unknown } | null;
        this.dom.dataset.kind = kind;
        this.toolbar.replaceChildren();
        if (kind === 'expansion') {
            const snippet = typeof mark?.snippet === 'string' ? mark.snippet : '';
            this.toolbar.append(element('span', 'mep-atom-label', mark?.missing ? `Snippet ${snippet} (not found)` : `Included snippet ${snippet}`));
            const path = mark?.path;
            if (typeof path === 'string' && !mark?.missing) {
                this.toolbar.append(button('Open snippet', path, () => this.port.openSnippet(path)));
            }
        }
        this.toolbar.hidden = this.toolbar.childElementCount === 0;
        this.content.innerHTML = this.node.attrs.html as string;
    }

    stopEvent(event: Event): boolean {
        const target = event.target as globalThis.Node | null;
        return target !== null && this.toolbar.contains(target);
    }
}

/** An inline injected atom — Req Explorer's status badge on a heading. */
export class InlineAtomView extends AtomView {
    constructor(node: Node) {
        super(node, 'span', 'mep-inline-atom');
        this.render();
    }

    protected render(): void {
        this.dom.innerHTML = this.node.attrs.html as string;
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
            || node.attrs.anchor !== this.node.attrs.anchor) {
            return false;
        }
        this.node = node;
        return true;
    }

    ignoreMutation(mutation: ViewMutationRecord): boolean {
        return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target);
    }
}
