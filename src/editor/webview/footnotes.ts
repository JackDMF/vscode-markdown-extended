import { Node } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, Transaction } from 'prosemirror-state';
import { AttrStep, ReplaceAroundStep, ReplaceStep, Step } from 'prosemirror-transform';
import { Decoration, DecorationSet, EditorView, NodeView } from 'prosemirror-view';
import { currentInlineEngine } from '../inlineEngine';
import { footnoteSpelling } from '../schema';

/**
 * Footnotes edited in place (wave 4 #5b): the numbers.
 *
 * A reference (`footnote_ref`) and an entry (`footnote_entry`) carry their
 * label, never their number: the number is what the engine gives — the order
 * of first reference, an inline footnote taking the next number in the same
 * sequence, a repeated label its first number again — and changes with every
 * reference moved. So the page counts them here, as the engine does
 * (`countFootnotes`), into a plugin state (`FootnoteIndex`) the node views and
 * a few widgets draw from; renumbering is never a change of the document, its
 * history or the file.
 *
 * Counted anew only when a transaction touches footnotes (`touchesFootnotes`):
 * a reference or an entry added, removed or changed, a source block holding
 * footnotes, or a verb that says so (`FOOTNOTES_CHANGED`). Typing in a
 * paragraph maps the positions and counts nothing. The node views draw their
 * number from the index; the plugin's view redraws them when a number or a
 * state changed (`version`), not on every keystroke.
 */

/** The meta of a transaction that changes footnotes in a way no step shows (a label renamed, the entries sorted): counted anew. */
export const FOOTNOTES_CHANGED = 'mepFootnotesChanged';

/** A reference as the engine numbers it: its place, its label (`null` for an inline footnote), its number (`null` for a label nothing defines) and which repeat of its label it is. */
export interface FootnoteRef {
    pos: number;
    label: string | null;
    number: number | null;
    sub: number;
    /** Counted from a source block's record (`raw_block.footnotes`): `pos` is the block's, and no atom stands there. */
    raw?: true;
}

/** An entry: its place, label and number — `null` unless it is its label's live definition and referenced. */
export interface FootnoteEntry {
    pos: number;
    label: string;
    number: number | null;
    /** The definition the engine keeps for its label: the last one in the document. */
    live: boolean;
    /** How many references its label has. */
    refCount: number;
    /** For an entry a later one with its label outshines: that one's number, when it has one. */
    duplicateOf: number | null;
}

/** What `countFootnotes` reads off a document. */
export interface FootnoteCount {
    /** Every reference, in document order. */
    refs: FootnoteRef[];
    /** Every entry, in document order. */
    entries: FootnoteEntry[];
    /** Every label the document defines: its entries' and those a source block defines. */
    labels: ReadonlySet<string>;
    /** Whether the numbered entries do not stand in number order, or an unnumbered one stands before a numbered one: "Sort footnotes" would move them. */
    outOfOrder: boolean;
}

/** The plugin's state: the count, with the positions mapped through each change, and what the page did with it. */
export interface FootnoteIndex extends FootnoteCount {
    /** Bumped whenever a number or a state changes: what the views redraw by. */
    version: number;
    /** The reference "Go to footnote text" left from, mapped, for "Back to reference" (step 8). */
    cameFrom: { label: string; pos: number } | null;
    /** The widgets: a `↩` per reference, the chip of an unreferenced entry, the rule before a run of entries. */
    decorations: DecorationSet;
}

export const footnoteIndexKey = new PluginKey<FootnoteIndex>('mepFootnotes');

/**
 * The footnotes of `doc` as markdown-it-footnote numbers them: in document
 * order — a note's reference before its body, an entry's text where the entry
 * stands, a source block by its record — an inline footnote takes the next
 * number, a label the first time it is referenced; a label no definition has
 * none. The last definition of a label is the one the engine keeps.
 */
export function countFootnotes(doc: Node): FootnoteCount {
    // Who defines each label last, in document order: an entry, or a source block holding a definition.
    const lastDefiner = new Map<string, number>();
    doc.forEach((node, offset) => {
        if (node.type.name === 'footnote_entry') {
            lastDefiner.set(node.attrs.label as string, offset);
        }
        for (const label of definesOf(node)) {
            lastDefiner.set(label, offset);
        }
    });
    const labels: ReadonlySet<string> = new Set(lastDefiner.keys());
    const seen = new Map<string, { number: number; count: number }>();
    const refs: FootnoteRef[] = [];
    let next = 1;
    const count = (pos: number, label: string | null, raw: boolean) => {
        let ref: FootnoteRef;
        if (label === null) {
            ref = { pos, label, number: next++, sub: 0 };
        } else if (!labels.has(label)) {
            ref = { pos, label, number: null, sub: 0 };
        } else {
            const known = seen.get(label);
            if (known === undefined) {
                seen.set(label, { number: next, count: 1 });
                ref = { pos, label, number: next++, sub: 0 };
            } else {
                ref = { pos, label, number: known.number, sub: known.count++ };
            }
        }
        refs.push(raw ? { ...ref, raw: true } : ref);
    };
    doc.descendants((node, pos) => {
        if (node.type.name === 'footnote_ref') {
            count(pos, node.attrs.label as string | null, false);
            return false;
        }
        if (node.type.name === 'raw_block') {
            for (const label of rawFootnotesOf(node)?.refs ?? []) {
                count(pos, label, true);
            }
            return false;
        }
        return true;
    });
    const entries: FootnoteEntry[] = [];
    doc.forEach((node, offset) => {
        if (node.type.name !== 'footnote_entry') {
            return;
        }
        const label = node.attrs.label as string;
        const live = lastDefiner.get(label) === offset;
        const numbered = seen.get(label);
        entries.push({
            pos: offset,
            label,
            number: live ? numbered?.number ?? null : null,
            live,
            refCount: numbered?.count ?? 0,
            duplicateOf: live ? null : numbered?.number ?? null,
        });
    });
    return { refs, entries, labels, outOfOrder: outOfOrder(entries) };
}

/** A source block's record of its footnotes (`raw_block.footnotes`), or `null`. */
function rawFootnotesOf(node: Node): { refs: (string | null)[]; defines: string[] } | null {
    return node.type.name === 'raw_block' ? (node.attrs.footnotes as { refs: (string | null)[]; defines: string[] } | null) : null;
}

/** The labels a top-level source block defines. */
function definesOf(node: Node): readonly string[] {
    return rawFootnotesOf(node)?.defines ?? [];
}

/** Whether the entries, in document order, are not the numbered ones ascending and then the rest. */
function outOfOrder(entries: readonly FootnoteEntry[]): boolean {
    let last = 0;
    let unnumbered = false;
    for (const entry of entries) {
        if (entry.number === null) {
            unnumbered = true;
            continue;
        }
        if (unnumbered || entry.number < last) {
            return true;
        }
        last = entry.number;
    }
    return false;
}

/** Whether a slice or a node holds a reference, an entry, or a source block with footnotes. */
function holdsFootnotes(node: Node): boolean {
    let found = false;
    node.descendants(child => {
        found ||= child.type.name === 'footnote_ref' || child.type.name === 'footnote_entry' || rawFootnotesOf(child) !== null;
        return !found;
    });
    return found;
}

/**
 * Whether `step`, applied to `before`, changes what the numbers are counted
 * from: it inserts a reference, an entry or a source block with footnotes;
 * or the range it replaces holds one, or an entry's start or end — an
 * entry that merely holds the range (typing in its text) does not count.
 */
function stepTouchesFootnotes(step: Step, before: Node): boolean {
    if (step instanceof AttrStep) {
        const node = before.nodeAt((step as unknown as { pos: number }).pos);
        return node !== null && (node.type.name === 'footnote_entry' || node.type.name === 'footnote_ref' || rawFootnotesOf(node) !== null);
    }
    if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) {
        return false;
    }
    const { from, to, slice } = step as unknown as { from: number; to: number; slice: { content: { forEach(f: (node: Node) => void): void } } };
    let found = false;
    slice.content.forEach(node => {
        found ||= node.type.name === 'footnote_ref' || node.type.name === 'footnote_entry' || rawFootnotesOf(node) !== null || holdsFootnotes(node);
    });
    if (found || from === to) {
        return found;
    }
    before.nodesBetween(from, to, (node, pos) => {
        if (found) {
            return false;
        }
        if (node.type.name === 'footnote_ref' || rawFootnotesOf(node) !== null) {
            found = true;
        } else if (node.type.name === 'footnote_entry' && (pos >= from || pos + node.nodeSize <= to)) {
            found = true;
        }
        return !found;
    });
    return found;
}

/** Whether `tr` changes what the footnotes are counted from (`stepTouchesFootnotes`), or says it does (`FOOTNOTES_CHANGED`). */
export function touchesFootnotes(tr: Transaction): boolean {
    return tr.getMeta(FOOTNOTES_CHANGED) === true || tr.steps.some((step, i) => stepTouchesFootnotes(step, tr.docs[i]));
}

/** What a number or a state of the count is, for telling whether a recount changed anything the page shows. */
function signature(count: FootnoteCount): string {
    return JSON.stringify([
        count.refs.map(r => [r.label, r.number, r.sub, r.raw === true]),
        count.entries.map(e => [e.label, e.number, e.live, e.refCount, e.duplicateOf]),
        count.outOfOrder,
    ]);
}

/** The count of `state` (`footnoteIndexPlugin`); an empty one in a state without the plugin. */
export function footnoteIndexOf(state: EditorState): FootnoteIndex {
    return footnoteIndexKey.getState(state) ?? { refs: [], entries: [], labels: new Set(), outOfOrder: false, version: 0, cameFrom: null, decorations: DecorationSet.empty };
}

/** The reference at `pos` in the count, or `undefined`. */
export function refAt(index: FootnoteIndex, pos: number): FootnoteRef | undefined {
    // Refs are in document order: a binary search by position.
    let low = 0;
    let high = index.refs.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const at = index.refs[mid].pos;
        if (at === pos && index.refs[mid].raw !== true) {
            return index.refs[mid];
        }
        if (at < pos || (at === pos && index.refs[mid].raw === true)) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return undefined;
}

/** The entry at `pos` in the count, or `undefined`. */
export function entryAt(index: FootnoteIndex, pos: number): FootnoteEntry | undefined {
    return index.entries.find(e => e.pos === pos);
}

/** The references of `label`, atoms only, in document order. */
export function referencesOf(index: FootnoteIndex, label: string): FootnoteRef[] {
    return index.refs.filter(r => r.label === label && r.raw !== true);
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** What the chip of an entry the preview leaves out says, and its tooltip. */
export function orphanChip(entry: FootnoteEntry): { text: string; title: string } {
    return entry.duplicateOf !== null
        ? { text: `same label as footnote ${entry.duplicateOf}`, title: `Preview and export show footnote ${entry.duplicateOf}, which has the same label, and leave this one out` }
        : { text: 'not referenced', title: 'No reference in the text — preview and export leave this out' };
}

/** Where an entry's chip stands: after its first word, or after its first run of formatted text when it starts with one (`*Senfkorn*`). */
function chipPos(entry: Node, pos: number): number | null {
    let found: number | null = null;
    entry.descendants((node, rel) => {
        if (found !== null) {
            return false;
        }
        if (!node.isTextblock) {
            return true;
        }
        const start = pos + 1 + rel + 1;
        const first = node.firstChild;
        if (first === null || !first.isText) {
            found = start;
            return false;
        }
        if (first.marks.length > 0) {
            let end = start;
            for (let i = 0; i < node.childCount && node.child(i).isText && node.child(i).marks.length > 0 && node.child(i).sameMarkup(first); i++) {
                end += node.child(i).nodeSize;
            }
            found = end;
            return false;
        }
        const word = /^\s*\S+/.exec(first.text ?? '');
        found = start + (word?.[0].length ?? 0);
        return false;
    });
    return found;
}

/** The end of the last textblock in the entry at `pos`: where its `↩`s stand. */
function backPos(entry: Node, pos: number): number | null {
    let found: number | null = null;
    entry.descendants((node, rel) => {
        if (node.isTextblock) {
            found = pos + 1 + rel + node.nodeSize - 1;
            return false;
        }
        return true;
    });
    return found;
}

function widget(tag: 'span' | 'hr', className: string, text: string, attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    el.contentEditable = 'false';
    for (const [name, value] of Object.entries(attrs)) {
        el.setAttribute(name, value);
    }
    return el;
}

/** The widgets of `count` in `doc`: a `↩` per reference of each numbered entry, an unreferenced entry's chip, a rule before each run of entries. */
function footnoteDecorations(doc: Node, count: FootnoteCount): DecorationSet {
    const decorations: Decoration[] = [];
    let previousEnd = -1;
    for (const entry of count.entries) {
        const node = doc.nodeAt(entry.pos);
        if (node === null) {
            continue;
        }
        if (entry.pos !== previousEnd) {
            // The preview's `hr.footnotes-sep`, before the first entry of a run: drawn by the page, not text.
            decorations.push(Decoration.widget(entry.pos, () => widget('hr', 'footnotes-sep mep-fn-sep', '', { 'aria-hidden': 'true' }), { side: -1, ignoreSelection: true, key: 'fn-sep' }));
        }
        previousEnd = entry.pos + node.nodeSize;
        if (entry.number !== null) {
            const at = backPos(node, entry.pos);
            const total = entry.refCount;
            for (let k = 1; at !== null && k <= total; k++) {
                const label = `Back to reference ${entry.number}${total > 1 ? ` (${k} of ${total})` : ''}`;
                decorations.push(Decoration.widget(at, () => widget('span', 'mep-fn-back', '↩︎', { role: 'link', 'aria-label': label, title: label, 'data-label': entry.label, 'data-k': String(k) }), {
                    side: 1 + k,
                    ignoreSelection: true,
                    key: `fn-back-${entry.label}-${entry.number}-${k}-${total}`,
                }));
            }
        } else {
            const at = chipPos(node, entry.pos);
            const chip = orphanChip(entry);
            if (at !== null) {
                decorations.push(Decoration.widget(at, () => widget('span', 'mep-fn-chip', chip.text, { title: chip.title }), { side: 1, ignoreSelection: true, key: `fn-chip-${chip.text}` }));
            }
        }
    }
    return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// Node views
// ---------------------------------------------------------------------------

/** What a node view of the count redraws by. */
interface CountedView {
    draw(): void;
}

/** The live views of each editor, which the plugin's view redraws when a number changed. */
const viewsOf = new WeakMap<EditorView, Set<CountedView>>();

function register(view: EditorView, counted: CountedView): void {
    let set = viewsOf.get(view);
    if (set === undefined) {
        set = new Set();
        viewsOf.set(view, set);
    }
    set.add(counted);
}

/** An inline footnote's text as a person reads it: rendered by the page's engine, its markup gone. */
function plainText(source: string): string {
    // A template's content is inert: nothing in it loads or runs.
    const template = document.createElement('template');
    template.innerHTML = currentInlineEngine().renderInline(source);
    return (template.content.textContent ?? source).replace(/\s+/g, ' ').trim();
}

/**
 * A reference: the engine's number in brackets, as the preview draws
 * `sup.footnote-ref` — `[1]`, a repeat `[1]` too — with the preview's id
 * (`fnref1`, `fnref1:1`), so an in-document `#fnref1` lands. A label nothing
 * defines is drawn as its text, dotted (`mep-fn-missing`), as the preview
 * leaves it text. Its name says the number, its label the description.
 */
export class FootnoteRefView implements NodeView {
    readonly dom: HTMLElement;

    constructor(private node: Node, private readonly view: EditorView, private readonly getPos: () => number | undefined) {
        this.dom = document.createElement('sup');
        this.dom.contentEditable = 'false';
        register(view, this);
        this.draw();
    }

    update(node: Node): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        this.node = node;
        this.draw();
        return true;
    }

    draw(): void {
        const pos = this.getPos();
        const ref = pos === undefined ? undefined : refAt(footnoteIndexOf(this.view.state), pos);
        const label = this.node.attrs.label as string | null;
        const missing = ref === undefined || ref.number === null;
        this.dom.className = `footnote-ref mep-fn-ref mep-atom${missing ? ' mep-fn-missing' : ''}${this.dom.classList.contains('ProseMirror-selectednode') ? ' ProseMirror-selectednode' : ''}`;
        this.dom.setAttribute('data-mep-fn', '');
        this.dom.setAttribute('role', 'link');
        if (missing) {
            this.dom.removeAttribute('id');
            this.dom.textContent = footnoteSpelling(this.node);
            this.dom.setAttribute('aria-label', `Footnote ${label ?? ''}, no text`);
            this.dom.removeAttribute('aria-description');
            return;
        }
        this.dom.id = `fnref${ref.number}${ref.sub > 0 ? `:${ref.sub}` : ''}`;
        this.dom.textContent = `[${ref.number}]`;
        if (label === null) {
            this.dom.setAttribute('aria-label', `Footnote ${ref.number}: ${plainText(this.node.attrs.source as string)}`);
            this.dom.removeAttribute('aria-description');
        } else {
            this.dom.setAttribute('aria-label', `Footnote ${ref.number}`);
            this.dom.setAttribute('aria-description', label);
        }
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

    destroy(): void {
        viewsOf.get(this.view)?.delete(this);
    }
}

/**
 * An entry, drawn as an item of the preview's list: its number (not text),
 * then its blocks. A numbered one has the preview's id (`fn1`), so `#fn1`
 * lands; one the preview leaves out is marked (`mep-fn-orphan`) and named so.
 */
export class FootnoteEntryView implements NodeView {
    readonly dom: HTMLElement;
    readonly contentDOM: HTMLElement;
    private readonly num: HTMLElement;

    constructor(private node: Node, private readonly view: EditorView, private readonly getPos: () => number | undefined) {
        this.dom = document.createElement('div');
        this.dom.setAttribute('data-mep-fn-entry', node.attrs.label as string);
        this.dom.setAttribute('role', 'group');
        this.dom.setAttribute('aria-roledescription', 'footnote');
        this.num = document.createElement('span');
        this.num.className = 'mep-fn-num';
        this.num.contentEditable = 'false';
        this.num.setAttribute('aria-hidden', 'true');
        this.contentDOM = document.createElement('div');
        this.contentDOM.className = 'mep-fn-body';
        this.dom.append(this.num, this.contentDOM);
        register(view, this);
        this.draw();
    }

    update(node: Node): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        this.node = node;
        this.dom.setAttribute('data-mep-fn-entry', node.attrs.label as string);
        this.draw();
        return true;
    }

    draw(): void {
        const pos = this.getPos();
        const entry = pos === undefined ? undefined : entryAt(footnoteIndexOf(this.view.state), pos);
        const label = this.node.attrs.label as string;
        const number = entry?.number ?? null;
        const current = this.dom.classList.contains('mep-fn-current');
        this.dom.className = `mep-fn-entry${number === null ? ' mep-fn-orphan' : ''}${current ? ' mep-fn-current' : ''}`;
        this.num.textContent = number === null ? '' : `${number}.`;
        if (number === null) {
            this.dom.removeAttribute('id');
        } else {
            this.dom.id = `fn${number}`;
        }
        this.dom.setAttribute('aria-label', number !== null
            ? `Footnote ${number}, ${label}`
            : entry !== undefined && entry.duplicateOf !== null ? `Footnote ${label}, same label as footnote ${entry.duplicateOf}` : `Footnote ${label}, not referenced`);
    }

    ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: globalThis.Node }): boolean {
        // The number is the view's own; the body is ProseMirror's.
        return mutation.type !== 'selection' && !this.contentDOM.contains(mutation.target);
    }

    destroy(): void {
        viewsOf.get(this.view)?.delete(this);
    }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/** The count of `doc` as the plugin's state, its version one past `before`'s when anything it shows changed. */
function counted(doc: Node, before: FootnoteIndex | null, cameFrom: FootnoteIndex['cameFrom']): FootnoteIndex {
    const count = countFootnotes(doc);
    const same = before !== null && signature(before) === signature(count);
    return { ...count, version: before === null ? 0 : same ? before.version : before.version + 1, cameFrom, decorations: footnoteDecorations(doc, count) };
}

/** `index` with every position mapped through `tr`, nothing counted. */
function mapped(index: FootnoteIndex, tr: Transaction): FootnoteIndex {
    const map = (pos: number) => tr.mapping.map(pos);
    return {
        ...index,
        refs: index.refs.map(r => ({ ...r, pos: map(r.pos) })),
        entries: index.entries.map(e => ({ ...e, pos: map(e.pos) })),
        decorations: index.decorations.map(tr.mapping, tr.doc),
    };
}

/**
 * The footnote count (`FootnoteIndex`), its widgets, and the node views that
 * draw the numbers. The tint of the entry the caret is in (`mep-fn-current`)
 * follows the selection.
 */
export function footnoteIndexPlugin(): Plugin<FootnoteIndex> {
    return new Plugin<FootnoteIndex>({
        key: footnoteIndexKey,
        state: {
            init: (_config, state) => counted(state.doc, null, null),
            apply(tr, index) {
                let next = index;
                if (tr.docChanged) {
                    next = touchesFootnotes(tr) ? counted(tr.doc, index, index.cameFrom) : mapped(index, tr);
                    if (next.cameFrom !== null) {
                        const pos = tr.mapping.mapResult(next.cameFrom.pos);
                        next = { ...next, cameFrom: pos.deleted ? null : { ...next.cameFrom, pos: pos.pos } };
                    }
                }
                return next;
            },
        },
        props: {
            decorations: state => footnoteIndexOf(state).decorations,
            nodeViews: {
                // eslint-disable-next-line @typescript-eslint/naming-convention -- the schema's node names
                footnote_ref: (node, view, getPos) => new FootnoteRefView(node, view, getPos),
                // eslint-disable-next-line @typescript-eslint/naming-convention -- the schema's node names
                footnote_entry: (node, view, getPos) => new FootnoteEntryView(node, view, getPos),
            },
        },
        view(view) {
            let tinted: HTMLElement | null = null;
            const tint = () => {
                const { $head } = view.state.selection;
                const top = $head.depth > 0 ? $head.node(1) : null;
                const dom = top?.type.name === 'footnote_entry' ? view.nodeDOM($head.before(1)) : null;
                const next = dom instanceof HTMLElement ? dom : null;
                if (next !== tinted) {
                    tinted?.classList.remove('mep-fn-current');
                    next?.classList.add('mep-fn-current');
                    tinted = next;
                }
            };
            tint();
            return {
                update(updated, prevState) {
                    if (footnoteIndexOf(updated.state).version !== footnoteIndexOf(prevState).version) {
                        for (const counted of viewsOf.get(updated) ?? []) {
                            counted.draw();
                        }
                    }
                    if (updated.state.selection !== prevState.selection || updated.state.doc !== prevState.doc) {
                        tint();
                    }
                },
                destroy() {
                    tinted?.classList.remove('mep-fn-current');
                },
            };
        },
    });
}

