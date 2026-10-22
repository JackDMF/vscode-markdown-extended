import { DOMOutputSpec, DOMSerializer, Node } from 'prosemirror-model';
import { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view';
import type { DeclaredControl } from './focusPlace';
import { followLinksIn } from './links';
import { APPLY_BINDING, REDO_BINDINGS, UNDO_BINDING, ariaKeyshortcuts, bindingMatches } from '../keys';
import { applyKey, macKeys } from './hint';

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
    /** Replace the front matter's `src` (the properties panel wrote its YAML in place, `properties.ts`). */
    commitFrontMatter(pos: number, src: string): void;
    /** The editor's own undo or redo, for a key pressed in the properties panel; false when there was nothing to undo. */
    history(kind: 'undo' | 'redo'): boolean;
    /** Say `text` in the caret hint, under `near`. */
    hint(text: string, near: Element): void;
    /** Say `text`, which reports a change to the document, in the caret hint under `near`: it goes at the next change (`showChangeHint`). */
    changeHint(text: string, near: Element): void;
    /** What the page remembers per document under (the document's uri; `''` when the page was not told one). */
    documentKey(): string;
    /** Put the caret in the text after the front matter and give the editor the focus. */
    leaveFrontMatter(): void;
}

/** A raw block's open source editor, as the page sees it. */
export interface SourceEditor {
    /** Write what the textarea holds into the document now, leaving it open. */
    commitSource(): void;
}

type GetPos = () => number | undefined;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (className) {
        el.className = className;
    }
    if (text !== undefined) {
        el.textContent = text;
    }
    return el;
}

/** Whether the key event is one the page's keymap undoes or redoes with (`keys.ts`): a source box keeps those for its own text. */
export function isUndoRedo(e: KeyboardEvent): boolean {
    return [UNDO_BINDING, ...REDO_BINDINGS].some(binding => bindingMatches(binding, e, macKeys()));
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
    /** Apply and Cancel under the open box (`sourceActions`), gone with it. */
    private actions: HTMLElement | null = null;
    private untrack: (() => void) | null = null;
    private readonly sizes: ResizeObserver | null;
    private measuring = 0;

    constructor(node: Node, private readonly getPos: GetPos, private readonly port: EditorPort) {
        super(node, 'div', 'mep-raw-block');
        this.content = element('div', 'mep-atom-content');
        this.dom.append(sourceChip(), this.content);
        // A tall rendering gets a gutter for its chip, which then stays in sight (`mep-raw-tall`).
        // Measured after the layout pass, not inside the observer's, so it never loops.
        this.sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
            cancelAnimationFrame(this.measuring);
            this.measuring = requestAnimationFrame(() => this.measure());
        });
        this.sizes?.observe(this.dom);
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
        nameSourceBlock(this.dom, this.node.attrs.construct as string | null);
        // Where the "source" chip stands (`editor.css`): inside the box of source shown as source;
        // above the block's top-left when a note floats at the right (a chip floating there would push it
        // down) or the rendering starts with a box of its own (a table, an admonition: it would be
        // narrowed or pushed below the chip); floated top-right, the first line around it, otherwise.
        const first = Array.from(this.content.children).find(el => el.getAttribute('aria-hidden') !== 'true');
        this.dom.classList.toggle('mep-raw-boxed', !html);
        this.dom.classList.toggle('mep-raw-above', html !== '' && (this.content.querySelector(RIGHT_FLOATS) !== null || first === undefined || !TEXT_LIKE.has(first.tagName)));
    }

    /**
     * Whether the rendering is tall enough that its top may scroll away (`mep-raw-tall`): only a
     * chip floated top-right, which a gutter then holds, sticky, with no line under it. Boxes and
     * chips above a block stay as they are. Hysteresis, as the gutter narrows the lines and
     * makes the block taller. Run on a size change (the observer), not on every render.
     */
    private measure(): void {
        const cl = this.dom.classList;
        const height = this.dom.offsetHeight;
        const floats = !cl.contains('mep-raw-boxed') && !cl.contains('mep-raw-above') && !cl.contains('mep-editing');
        cl.toggle('mep-raw-tall', floats && height > (cl.contains('mep-raw-tall') ? TALL_BLOCK * 0.8 : TALL_BLOCK));
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
        // Apply and Cancel under the box are the box's too: ProseMirror's mousedown would select the block.
        return target !== null && (this.holdsFocusOf(target) || (this.actions?.contains(target) ?? false));
    }

    /** Whether `el` is in the open source box: the block's one control (`rawBlockControl`). */
    holdsFocusOf(el: globalThis.Node): boolean {
        return this.editor?.contains(el) ?? false;
    }

    position(): number | undefined {
        return this.getPos();
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
            } else if (bindingMatches(APPLY_BINDING, e, macKeys())) {
                e.preventDefault();
                e.stopPropagation();
                this.stopEditing(true);
            }
        });
        area.addEventListener('blur', () => this.stopEditing(true));
        this.dom.classList.remove('ProseMirror-selectednode');
        this.editor = area;
        this.actions = sourceActions(apply => this.stopEditing(apply));
        this.untrack = this.port.trackSourceEditor(this);
        this.dom.classList.add('mep-editing');
        this.content.replaceChildren(area, this.actions);
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
        this.sizes?.disconnect();
        cancelAnimationFrame(this.measuring);
    }

    private stopEditing(commit: boolean): void {
        const area = this.editor;
        if (!area) {
            return;
        }
        this.editor = null;
        this.actions = null;
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
 * What a stylesheet may float at a block's right, each with `clear: right` — the notes and
 * sidebars (`markdown-extended.css`), images in a person's own: a chip floating there first
 * would push them below it.
 */
const RIGHT_FLOATS = '.sidenote, .mnote, .right-sidebar, img';

/** The height in px from which a rendered source block counts as tall: its chip stays in sight (`mep-raw-tall`). */
const TALL_BLOCK = 400;

/** A rendering's first element whose lines a floated chip can wrap: no box of its own beside a float. */
const TEXT_LIKE: ReadonlySet<string> = new Set(['P', 'UL', 'OL', 'DL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * The "source" chip: editor chrome, made once with the view (no decoration, nothing per
 * keystroke), never in the document — the clipboard and the file take the node, not its view.
 * Hidden from a screen reader: the block names itself (`nameSourceBlock`). The word is the
 * stylesheet's (`editor.css`, `.mep-raw-chip::before`), so it is no text of the page either.
 * A rail holds it: the block's height, so the chip can stay in sight (sticky) while a tall
 * block's top is scrolled away.
 */
function sourceChip(): HTMLElement {
    const rail = element('span', 'mep-raw-rail');
    rail.setAttribute('aria-hidden', 'true');
    rail.append(element('span', 'mep-raw-chip'));
    return rail;
}

/**
 * A source block's name for a screen reader: a group that says what it is on entry
 * (`aria-roledescription`, "source block") and, as its label, only why (`construct`, the
 * classifier's reason in words: "Has a footnote") — no label when no word says why.
 */
export function nameSourceBlock(dom: HTMLElement, reason: string | null): void {
    dom.setAttribute('role', 'group');
    dom.setAttribute('aria-roledescription', 'source block');
    if (reason) {
        dom.setAttribute('aria-label', reason[0].toUpperCase() + reason.slice(1));
    } else {
        dom.removeAttribute('aria-label');
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

/**
 * Apply and Cancel under an open source box, at its right end (#10, Daniel
 * 2026-10-22), each naming its key. A press never takes the focus from the
 * textarea — whose blur applies — so Cancel cannot apply on the way out:
 * pointerdown and mousedown are prevented, and the buttons are out of the
 * Tab order (Tab onto one would blur the box and apply it).
 */
function sourceActions(stop: (apply: boolean) => void): HTMLElement {
    const actions = element('div', 'mep-raw-actions');
    const button = (cls: string, label: string, key: string, shortcut: string, apply: boolean) => {
        const b = element('button', cls, label);
        b.type = 'button';
        b.tabIndex = -1;
        b.setAttribute('aria-keyshortcuts', shortcut);
        const k = element('span', 'mep-raw-key', key);
        k.setAttribute('aria-hidden', 'true');
        b.append(k);
        b.addEventListener('click', e => {
            e.preventDefault();
            stop(apply);
        });
        return b;
    };
    const keep = (e: Event) => e.preventDefault();
    actions.addEventListener('pointerdown', keep);
    actions.addEventListener('mousedown', keep);
    actions.append(
        button('mep-raw-apply', 'Apply', applyKey(), ariaKeyshortcuts(APPLY_BINDING, macKeys()), true),
        button('mep-raw-cancel', 'Cancel', 'Esc', 'Escape', false),
    );
    return actions;
}

/** Each raw block's view by its DOM, so the page can reach the view ProseMirror made for a block. */
const rawBlockViews = new WeakMap<globalThis.Node, RawBlockView>();

/**
 * The control a raw block declares for `el` (`focusPlace.ts`): its open
 * source box, when `el` is in it; `null` for anything else — a link or a
 * `<summary>` in its rendering is not its control.
 */
export function rawBlockControl(el: Element): DeclaredControl | null {
    const atom = el.closest('.mep-raw-block');
    const rawView = atom ? rawBlockViews.get(atom) : undefined;
    return rawView?.holdsFocusOf(el) ? { pos: rawView.position(), role: 'source' } : null;
}

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
