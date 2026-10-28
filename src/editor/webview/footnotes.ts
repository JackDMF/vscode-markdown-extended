import { Fragment, Node, Slice } from 'prosemirror-model';
import { InputRule, inputRules, undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { Command, EditorState, NodeSelection, Plugin, PluginKey, TextSelection, Transaction } from 'prosemirror-state';
import { AttrStep, ReplaceAroundStep, ReplaceStep, Step, Transform } from 'prosemirror-transform';
import { Decoration, DecorationSet, EditorView, NodeView } from 'prosemirror-view';
import { currentInlineEngine } from '../inlineEngine';
import { editorSchema, footnoteSpelling } from '../schema';
import { Said, said, value } from '../tips';
import { macKeys, showChangeHint, showHint, showRefusal, undoKey } from './hint';

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
    /** The labels whose entry the last change left without a reference, by an edit not aimed at it (a cut, a deleted sentence): the hint names them. */
    orphaned: readonly string[];
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
    return footnoteIndexKey.getState(state) ?? { refs: [], entries: [], labels: new Set(), outOfOrder: false, version: 0, cameFrom: null, decorations: DecorationSet.empty, orphaned: [] };
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
    return { ...count, version: before === null ? 0 : same ? before.version : before.version + 1, cameFrom, decorations: footnoteDecorations(doc, count), orphaned: [] };
}

/** The labels whose live entry had references in `before` and has none in `after`, its entry still there. */
function newlyOrphaned(before: FootnoteIndex, after: FootnoteIndex): string[] {
    const had = new Set(before.entries.filter(e => e.live && e.refCount > 0).map(e => e.label));
    return after.entries.filter(e => e.live && e.refCount === 0 && had.has(e.label)).map(e => e.label);
}

/** `index` with every position mapped through `tr`, nothing counted. */
function mapped(index: FootnoteIndex, tr: Transaction): FootnoteIndex {
    const map = (pos: number) => tr.mapping.map(pos);
    return {
        ...index,
        refs: index.refs.map(r => ({ ...r, pos: map(r.pos) })),
        entries: index.entries.map(e => ({ ...e, pos: map(e.pos) })),
        decorations: index.decorations.map(tr.mapping, tr.doc),
        orphaned: [],
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
                // What the person's edit orphaned stays named through what is appended to it (the fidelity plugin's).
                const kept = tr.getMeta('appendedTransaction') !== undefined ? index.orphaned : [];
                let next = kept === index.orphaned ? index : { ...index, orphaned: kept };
                if (tr.docChanged) {
                    next = touchesFootnotes(tr) ? counted(tr.doc, index, index.cameFrom) : mapped(index, tr);
                    // A reference taken by an edit not aimed at it (a cut, a deleted sentence) leaves its text: said once.
                    const orphaned = tr.getMeta(FOOTNOTES_CHANGED) !== true && tr.getMeta('addToHistory') !== false && next.version !== index.version ? newlyOrphaned(index, next) : [];
                    next = { ...next, orphaned: orphaned.length > 0 ? orphaned : kept };
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
            // A `[^x]` pasted as text, whose label the document defines, is that reference again.
            transformPasted: (slice, view) => connectedSlice(slice, footnoteIndexOf(view.state).labels),
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
                    const index = footnoteIndexOf(updated.state);
                    if (index.version !== footnoteIndexOf(prevState).version) {
                        for (const counted of viewsOf.get(updated) ?? []) {
                            counted.draw();
                        }
                        if (index.orphaned.length > 0) {
                            showChangeHint(updated, said`Footnote ${value(index.orphaned[0])} no longer referenced — its text stays`);
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

// ---------------------------------------------------------------------------
// Deleting a reference, and the keys
// ---------------------------------------------------------------------------

/** The live entry of `label` in `state`, with its position: the one the engine keeps. */
function liveEntryOf(state: EditorState, label: string): { pos: number; node: Node } | null {
    const entry = footnoteIndexOf(state).entries.find(e => e.label === label && e.live);
    const node = entry === undefined ? null : state.doc.nodeAt(entry.pos);
    return entry === undefined || node === null ? null : { pos: entry.pos, node };
}

/** What deleting the reference at `pos` takes: the reference alone, or — the last one of its label — its entry too. */
function referenceDeletion(state: EditorState, pos: number): { label: string | null; entry: { pos: number; node: Node } | null; others: number } {
    const node = state.doc.nodeAt(pos) as Node;
    const label = node.attrs.label as string | null;
    if (label === null) {
        return { label, entry: null, others: 0 };
    }
    const others = referencesOf(footnoteIndexOf(state), label).filter(r => r.pos !== pos).length;
    return { label, entry: others === 0 ? liveEntryOf(state, label) : null, others };
}

/**
 * Delete the reference at `pos`, as a delete aimed at it does — Backspace or
 * Delete beside it, its bar's verb — in one transaction, so one undo brings
 * all back: with it the live entry of its label when no other reference to
 * the label is left. Never a source block's definition, never an entry a
 * reference still points to. With the hint that says what went.
 */
export function deleteFootnoteRefTransaction(state: EditorState, pos: number): { tr: Transaction; hint: Said } | null {
    const node = state.doc.nodeAt(pos);
    if (node === null || node.type !== editorSchema.nodes.footnote_ref) {
        return null;
    }
    const { label, entry, others } = referenceDeletion(state, pos);
    const tr = state.tr;
    if (entry !== null) {
        tr.delete(entry.pos, entry.pos + entry.node.nodeSize);
    }
    tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
    tr.setMeta(FOOTNOTES_CHANGED, true).scrollIntoView();
    let hint: Said;
    if (label === null) {
        hint = `Inline footnote deleted — ${undoKey()}`;
    } else if (entry !== null) {
        hint = said`Footnote ${value(label)} deleted with its text — ${undoKey()}`;
    } else if (others > 0) {
        hint = said`Reference deleted, footnote ${value(label)} stays (${others} more reference${others === 1 ? '' : 's'}) — ${undoKey()}`;
    } else {
        hint = `Reference deleted — ${undoKey()}`;
    }
    return { tr, hint };
}

/** What a second press beside the selected reference at `pos` will delete, as the first press says it (`key` names the key). */
function deletePreview(state: EditorState, pos: number, key: string): Said {
    const { label, entry, others } = referenceDeletion(state, pos);
    if (label === null) {
        return `${key} again deletes this inline footnote`;
    }
    if (entry !== null) {
        return said`${key} again deletes footnote ${value(label)} with its text`;
    }
    return others > 0 ? said`${key} again deletes this reference — footnote ${value(label)} keeps its text` : `${key} again deletes this reference`;
}

/**
 * Delete the entry at `pos` and every reference to it, as its bar's "Delete
 * footnote" (and Delete on a selected entry) does: one transaction, one undo.
 * An entry the engine leaves out (nothing refers to it, or a later one has its
 * label) goes alone.
 */
export function deleteFootnoteEntryTransaction(state: EditorState, pos: number): { tr: Transaction; hint: Said } | null {
    const node = state.doc.nodeAt(pos);
    if (node === null || node.type !== editorSchema.nodes.footnote_entry) {
        return null;
    }
    const label = node.attrs.label as string;
    const entry = entryAt(footnoteIndexOf(state), pos);
    const refs = entry?.live === true ? referencesOf(footnoteIndexOf(state), label) : [];
    const tr = state.tr;
    for (const ref of [...refs].reverse()) {
        tr.delete(ref.pos, ref.pos + 1);
    }
    tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
    tr.setMeta(FOOTNOTES_CHANGED, true).scrollIntoView();
    const hint = refs.length === 0
        ? said`Footnote ${value(label)} deleted — ${undoKey()}`
        : said`Footnote ${value(label)} deleted with ${refs.length === 1 ? 'its reference' : `its ${refs.length} references`} — ${undoKey()}`;
    return { tr, hint };
}

/** The reference right before (`dir` -1) or after (1) an empty caret, with its position. */
function referenceBeside(state: EditorState, dir: -1 | 1): { pos: number; node: Node } | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) {
        return null;
    }
    const node = dir < 0 ? sel.$from.nodeBefore : sel.$from.nodeAfter;
    return node?.type === editorSchema.nodes.footnote_ref ? { pos: dir < 0 ? sel.from - node.nodeSize : sel.from, node } : null;
}

/**
 * Backspace or Delete beside a reference: the first press selects it (its bar
 * shows) and says what a second would delete; with the reference selected, the
 * press deletes it, aimed (`deleteFootnoteRefTransaction`) — the rhythm a note
 * and a source block have.
 */
function deleteBeside(dir: -1 | 1, key: string): Command {
    return (state, dispatch, view) => {
        const sel = state.selection;
        if (sel instanceof NodeSelection && sel.node.type === editorSchema.nodes.footnote_ref) {
            const done = deleteFootnoteRefTransaction(state, sel.from);
            if (done === null) {
                return false;
            }
            if (dispatch) {
                dispatch(done.tr);
                if (view) {
                    showChangeHint(view, done.hint);
                }
            }
            return true;
        }
        const beside = referenceBeside(state, dir);
        if (beside === null) {
            return false;
        }
        if (dispatch) {
            dispatch(state.tr.setSelection(NodeSelection.create(state.doc, beside.pos)).scrollIntoView());
            if (view) {
                showHint(view, deletePreview(view.state, beside.pos, key), 'neutral');
            }
        }
        return true;
    };
}

/** Delete on a selected entry: its bar's "Delete footnote", aimed (F8). */
const deleteSelectedEntry: Command = (state, dispatch, view) => {
    const sel = state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type !== editorSchema.nodes.footnote_entry) {
        return false;
    }
    const done = deleteFootnoteEntryTransaction(state, sel.from);
    if (done === null) {
        return false;
    }
    if (dispatch) {
        dispatch(done.tr);
        if (view) {
            showChangeHint(view, done.hint);
        }
    }
    return true;
};

/** Why a key does not delete an entry's edge (`refuseEntryEdge`). */
export const ENTRY_EDGE_REFUSAL = 'Not deleted: a footnote goes with its references — use "Delete footnote" on its bar (Alt+Enter)';

/** The entry the textblock holding `$pos` starts, when the caret at `$pos` is at the start of an entry's first textblock. */
function atEntryStart(state: EditorState): boolean {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty || sel.$from.parentOffset !== 0 || sel.$from.depth < 2) {
        return false;
    }
    const $at = sel.$from;
    for (let d = $at.depth - 1; d >= 1; d--) {
        if ($at.index(d) !== 0) {
            return false;
        }
        if ($at.node(d).type === editorSchema.nodes.footnote_entry) {
            return true;
        }
    }
    return false;
}

/** The top-level node right after the top-level block the empty caret ends, when it is at the very end of that block's last textblock. */
function blockAfterCaret(state: EditorState): { pos: number; node: Node } | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty || sel.$from.depth < 1 || sel.$from.parentOffset !== sel.$from.parent.content.size) {
        return null;
    }
    const $at = sel.$from;
    for (let d = $at.depth - 1; d >= 1; d--) {
        if ($at.index(d) !== $at.node(d).childCount - 1) {
            return null;
        }
    }
    const after = $at.after(1);
    const node = state.doc.nodeAt(after);
    return node === null ? null : { pos: after, node };
}

/** Backspace at the start of an entry's text, or Delete at the end of the block before one: refused, with the verb that does it. */
function refuseEntryEdge(dir: -1 | 1): Command {
    return (state, _dispatch, view) => {
        const edge = dir < 0 ? atEntryStart(state) : blockAfterCaret(state)?.node.type === editorSchema.nodes.footnote_entry;
        if (!edge) {
            return false;
        }
        if (view) {
            showRefusal(view, ENTRY_EDGE_REFUSAL);
        }
        return true;
    };
}

/** Backspace at the start of the paragraph after an entry: the caret goes to the end of the entry's text, as after a note; nothing is deleted (F7). */
const backIntoEntry: Command = (state, dispatch) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty || sel.$from.depth !== 1 || sel.$from.parentOffset !== 0) {
        return false;
    }
    const before = sel.$from.index(0) > 0 ? state.doc.child(sel.$from.index(0) - 1) : null;
    if (before?.type !== editorSchema.nodes.footnote_entry) {
        return false;
    }
    if (dispatch) {
        const end = TextSelection.near(state.doc.resolve(sel.$from.before(1) - 1), -1);
        dispatch(state.tr.setSelection(end).scrollIntoView());
    }
    return true;
};

/** The entry the caret's textblock stands in, directly, with the textblock's depth. */
function entryParagraph(state: EditorState): { depth: number; entry: Node } | null {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || sel.$from.depth < 2) {
        return null;
    }
    const entry = sel.$from.node(-1);
    return entry.type === editorSchema.nodes.footnote_entry && sel.$from.parent.type === editorSchema.nodes.paragraph ? { depth: sel.$from.depth, entry } : null;
}

/** Shift+Enter in an entry's paragraph: a line break, written as the entry writes one. */
const breakInEntry: Command = (state, dispatch) => {
    if (entryParagraph(state) === null) {
        return false;
    }
    dispatch?.(state.tr.replaceSelectionWith(editorSchema.nodes.hard_break.create()).scrollIntoView());
    return true;
};

/**
 * Enter in an entry's empty last paragraph — or its only one, empty — leaves
 * the entry: a paragraph after it takes the caret, the empty one goes unless
 * it is the entry's only block (as a container's, `leaveWrapper`).
 */
const leaveEntry: Command = (state, dispatch) => {
    const found = entryParagraph(state);
    const $cursor = state.selection.$from;
    if (found === null || !state.selection.empty || $cursor.parent.content.size !== 0 || $cursor.index(-1) !== found.entry.childCount - 1) {
        return false;
    }
    if (dispatch) {
        const tr = state.tr;
        let after = $cursor.after(-1);
        if (found.entry.childCount > 1) {
            tr.delete($cursor.before(), $cursor.after());
            after -= $cursor.parent.nodeSize;
        }
        tr.insert(after, editorSchema.nodes.paragraph.create());
        tr.setSelection(TextSelection.create(tr.doc, after + 1));
        dispatch(tr.scrollIntoView());
    }
    return true;
};

function chain(...commands: Command[]): Command {
    return (state, dispatch, view) => commands.some(command => command(state, dispatch, view));
}

/**
 * The footnote keys, before the notes' (`plugins.ts`): Backspace and Delete
 * beside a reference select it, then delete it aimed; an entry's edge refuses
 * them; Shift+Enter breaks a line in an entry, Enter in its empty last
 * paragraph leaves it. Right after a typed `]` made a reference, Backspace
 * gives the text back.
 */
export function footnoteKeymap(): Plugin {
    const back = FOOTNOTE_KEYS.backspace;
    const forward = FOOTNOTE_KEYS.delete;
    // The keys that delete without being Backspace or Delete, macOS's Emacs-style ones too: as `sourceBlockKeymap`.
    const keys: Record<string, Command> = {
        'Backspace': chain(undoInputRule, back),
        'Mod-Backspace': back,
        'Shift-Backspace': back,
        'Delete': forward,
        'Mod-Delete': forward,
        'Shift-Enter': FOOTNOTE_KEYS.shiftEnter,
        'Enter': FOOTNOTE_KEYS.enter,
    };
    if (macKeys()) {
        Object.assign(keys, { 'Ctrl-h': back, 'Alt-Backspace': back, 'Ctrl-d': forward, 'Alt-Delete': forward, 'Alt-d': forward, 'Ctrl-Alt-Backspace': forward });
    }
    return keymap(keys);
}

/** The commands of `footnoteKeymap`, by the key that runs them. Named as the page's other hints name the keys ("Backspace right after typing"). */
export const FOOTNOTE_KEYS = {
    backspace: chain(deleteBeside(-1, 'Backspace'), refuseEntryEdge(-1), backIntoEntry),
    delete: chain(deleteSelectedEntry, deleteBeside(1, 'Delete'), refuseEntryEdge(1)),
    shiftEnter: breakInEntry,
    enter: leaveEntry,
};

// ---------------------------------------------------------------------------
// Literals connected: a typed `[^x]`, a pasted one
// ---------------------------------------------------------------------------

/** A reference written as text: `[^label]`, each one (`matchAll`), and whether a text holds one. */
const LITERAL = /\[\^([^\]\s]+)\]/g;
const HOLDS_LITERAL = /\[\^[^\]\s]+\]/;

/** Whether a text node is one a literal there is text of its own: code, or a superscript's or a subscript's raw text. */
function rawText(node: Node): boolean {
    return node.marks.some(m => m.type.spec.code === true || m.type.name === 'sup' || m.type.name === 'sub');
}

/**
 * `[^x]` written as text between `from` and `to` in `tr`'s document, where the
 * document defines `x` (`labels`), made the reference it is: an atom with the
 * text's marks. The step a typed `]` (`footnoteInputRules`), a pasted text and
 * a label given to an orphan (Label…) share.
 */
export function connectLiterals(tr: Transform, labels: ReadonlySet<string>, from = 0, to = tr.doc.content.size): void {
    const found: { from: number; to: number; label: string; node: Node }[] = [];
    tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isText && !rawText(node)) {
            for (const m of (node.text ?? '').matchAll(LITERAL)) {
                if (labels.has(m[1])) {
                    found.push({ from: pos + (m.index ?? 0), to: pos + (m.index ?? 0) + m[0].length, label: m[1], node });
                }
            }
        }
        return !node.isTextblock || node.type.spec.code !== true;
    });
    for (const f of found.reverse()) {
        tr.replaceWith(f.from, f.to, editorSchema.nodes.footnote_ref.create({ label: f.label }, null, f.node.marks));
    }
}

/** `slice` with its `[^x]` texts the references they are, where the document defines `x` (a plain-text paste). */
function connectedSlice(slice: Slice, labels: ReadonlySet<string>): Slice {
    if (labels.size === 0) {
        return slice;
    }
    const map = (fragment: Fragment): Fragment => {
        const out: Node[] = [];
        fragment.forEach(node => {
            if (node.isText && !rawText(node) && HOLDS_LITERAL.test(node.text ?? '')) {
                const text = node.text ?? '';
                let last = 0;
                for (const m of text.matchAll(LITERAL)) {
                    if (!labels.has(m[1])) {
                        continue;
                    }
                    const at = m.index ?? 0;
                    if (at > last) {
                        out.push(node.type.schema.text(text.slice(last, at), node.marks));
                    }
                    out.push(editorSchema.nodes.footnote_ref.create({ label: m[1] }, null, node.marks));
                    last = at + m[0].length;
                }
                if (last < text.length) {
                    out.push(node.type.schema.text(text.slice(last), node.marks));
                }
                return;
            }
            out.push(node.isLeaf || node.type.spec.code === true ? node : node.copy(map(node.content)));
        });
        return Fragment.from(out);
    };
    // A text that holds no footnote stays the very slice.
    let holds = false;
    slice.content.descendants(node => {
        holds ||= node.isText && HOLDS_LITERAL.test(node.text ?? '');
        return !holds;
    });
    return holds ? new Slice(map(slice.content), slice.openStart, slice.openEnd) : slice;
}

/** A typed `]` that completes `[^x]`, with `x` a label the document defines: the reference. Backspace right after gives the text back. */
export function footnoteInputRules(): Plugin {
    return inputRules({
        rules: [new InputRule(/\[\^([^\]\s]+)\]$/, (state, match, start, end) => {
            const $start = state.doc.resolve(start);
            if (!footnoteIndexOf(state).labels.has(match[1]) || $start.parent.type.spec.code === true || $start.marks().some(m => m.type.spec.code === true || m.type.name === 'sup' || m.type.name === 'sub')) {
                return null;
            }
            // `end` is before the `]` being typed, which the rule replaces with the rest.
            return state.tr.replaceWith(start, end, editorSchema.nodes.footnote_ref.create({ label: match[1] }, null, $start.marks())).setMeta(FOOTNOTES_CHANGED, true);
        })],
    });
}
