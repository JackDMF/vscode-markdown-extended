/**
 * Diagnostics on the page (ARCHITECTURE.md, *Completion, diagnostics and
 * hover*): what VS Code holds for the document — the findings the text editor
 * squiggles and the Problems view lists — drawn where they are about.
 *
 * The host sends every diagnostic with its range in the text it holds for the
 * page (`diagnostics`); the page maps each range through its own position map
 * (`pageRangeOf`, `positions.ts`), which owns the answer to where a place in
 * the text is on the page. An exact range is a squiggle on its text
 * (`Decoration.inline`, `mep-diag-<severity>`); an approximate one — a range
 * in a delimiter, a blank line, a source block, anything a mapping can only
 * place near — marks its whole top-level block, never nothing; a range across
 * blocks is split at them, a source block or other atom it covers marked
 * whole. Each block with a mark carries one marker in its left margin, of its
 * worst severity, and the toolbar's right end counts them all.
 *
 * Between two messages the marks follow the text through every transaction
 * (the decorations are mapped); the host sends afresh after every edit it
 * applies and whenever the diagnostics change.
 */
import { Node } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, PluginView, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import type { PositionMap } from '../positions';
import type { DiagnosticEntry, DiagnosticSeverityName } from '../protocol';
import { lensLabelNodes } from './lenses';

/** One drawn piece of a diagnostic: its page range, whether it stands for a whole top-level block, and which diagnostic it is. */
export interface DiagnosticMark {
    from: number;
    to: number;
    /** The index of the diagnostic in the message's items. */
    index: number;
    severity: DiagnosticSeverityName;
    /** A whole top-level block (`from`/`to` its node's bounds): an approximate mapping, or an atom inside the range. */
    whole: boolean;
    /** The top-level block the piece is in. */
    block: number;
}

const RANK: Readonly<Record<DiagnosticSeverityName, number>> = { error: 0, warning: 1, info: 2, hint: 3 };

/** The worse of two severities. */
export function worse(a: DiagnosticSeverityName, b: DiagnosticSeverityName): DiagnosticSeverityName {
    return RANK[a] <= RANK[b] ? a : b;
}

/** The index of the top-level block a position is in, or the one it stands before; the last for the document's end. */
function blockIndexAt(doc: Node, pos: number): number {
    const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    return Math.min($pos.index(0), doc.childCount - 1);
}

function blockStart(doc: Node, index: number): number {
    let start = 0;
    for (let i = 0; i < index; i++) {
        start += doc.child(i).nodeSize;
    }
    return start;
}

function hasInline(node: Node): boolean {
    if (node.inlineContent) {
        return true;
    }
    let found = false;
    node.descendants(child => {
        if (found) {
            return false;
        }
        if (child.inlineContent) {
            found = true;
        }
        return !found;
    });
    return found;
}

/**
 * An empty range (a diagnostic at a point) widened to one character, as the
 * text editor draws one: the character after it, else the one before it, in
 * its textblock; `null` in an empty textblock or at no text.
 */
function widened(doc: Node, pos: number): { from: number; to: number } | null {
    const $pos = doc.resolve(pos);
    if (!$pos.parent.inlineContent) {
        return null;
    }
    if ($pos.parentOffset < $pos.parent.content.size) {
        return { from: pos, to: pos + 1 };
    }
    if ($pos.parentOffset > 0) {
        return { from: pos - 1, to: pos };
    }
    return null;
}

/**
 * Where each diagnostic is drawn on the page, from the page's own position
 * map: an exact range as a squiggle over its text, split at the top-level
 * blocks it crosses (an atom it covers marked whole); an approximate one, or
 * one with no text to squiggle, as its whole top-level block. A range the map
 * cannot place at all (outside the text) is not drawn. Ordered by position.
 */
export function diagnosticMarks(doc: Node, map: Pick<PositionMap, 'pageRangeOf'>, items: readonly DiagnosticEntry[]): DiagnosticMark[] {
    const marks: DiagnosticMark[] = [];
    if (doc.childCount === 0) {
        return marks;
    }
    const whole = (index: number, block: number, severity: DiagnosticSeverityName) => {
        const from = blockStart(doc, block);
        marks.push({ from, to: from + doc.child(block).nodeSize, index, severity, whole: true, block });
    };
    items.forEach((item, index) => {
        const range = map.pageRangeOf(item.range);
        if (range === null) {
            return;
        }
        const first = blockIndexAt(doc, range.from);
        if (range.approximate) {
            whole(index, first, item.severity);
            return;
        }
        const last = blockIndexAt(doc, range.to);
        for (let block = first; block <= last; block++) {
            const node = doc.child(block);
            const start = blockStart(doc, block);
            const end = start + node.nodeSize;
            if (node.isAtom || !hasInline(node)) {
                whole(index, block, item.severity);
                continue;
            }
            let from = Math.max(range.from, start + 1);
            let to = Math.min(range.to, end - 1);
            if (from >= to) {
                const one = first === last ? widened(doc, Math.min(Math.max(range.from, start + 1), end - 1)) : null;
                if (one === null) {
                    if (first === last) {
                        whole(index, block, item.severity);
                    }
                    continue;
                }
                ({ from, to } = one);
            }
            marks.push({ from, to, index, severity: item.severity, whole: false, block });
        }
    });
    return marks.sort((a, b) => a.from - b.from || a.to - b.to || a.index - b.index);
}

/**
 * Where a block's margin marker goes: in a paragraph or a heading, at the
 * start of its text — so it sits on the first line, below a lens row, and
 * left of the text in the page's side padding; for any other block (a list, a
 * quote, a source block) at the block's own start, on a line of no height
 * above it: inside a list item the text's left edge is the item's, and the
 * marker would stand on the bullet.
 */
function markerPosition(doc: Node, block: number): { pos: number; inText: boolean } {
    const start = blockStart(doc, block);
    const node = doc.child(block);
    return node.inlineContent ? { pos: start + 1, inText: true } : { pos: start, inText: false };
}

/** The counts the toolbar shows: errors, warnings and infos (hints are not counted, as in VS Code's status bar). */
export function diagnosticCounts(items: readonly DiagnosticEntry[]): { error: number; warning: number; info: number } {
    const counts = { error: 0, warning: 0, info: 0 };
    for (const item of items) {
        if (item.severity !== 'hint') {
            counts[item.severity]++;
        }
    }
    return counts;
}

/** What a marker says: the count of each severity on its block, worst first. */
function markerLabel(bySeverity: Map<DiagnosticSeverityName, number>): string {
    const names: Record<DiagnosticSeverityName, [string, string]> = {
        error: ['error', 'errors'], warning: ['warning', 'warnings'], info: ['info', 'infos'], hint: ['hint', 'hints'],
    };
    return (['error', 'warning', 'info', 'hint'] as const)
        .filter(s => (bySeverity.get(s) ?? 0) > 0)
        .map(s => `${bySeverity.get(s)} ${names[s][bySeverity.get(s) === 1 ? 0 : 1]}`)
        .join(', ');
}

const ICON: Readonly<Record<DiagnosticSeverityName, string>> = { error: '$(error)', warning: '$(warning)', info: '$(info)', hint: '$(info)' };

function markerElement(severity: DiagnosticSeverityName, label: string, inText: boolean): HTMLElement {
    const el = document.createElement(inText ? 'span' : 'div');
    el.className = `mep-diag-marker mep-diag-marker-${severity}${inText ? '' : ' mep-diag-marker-block'}`;
    el.contentEditable = 'false';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    el.title = label;
    const glyph = document.createElement('span');
    glyph.className = 'mep-diag-glyph';
    glyph.append(...lensLabelNodes(ICON[severity]));
    el.append(glyph);
    return el;
}

interface DiagnosticsState {
    items: readonly DiagnosticEntry[];
    decorations: DecorationSet;
}

export const diagnosticsPluginKey = new PluginKey<DiagnosticsState>('mepDiagnostics');

/** The spec a squiggle or a block mark carries, so the pointer's card can find what it stands for. */
interface MarkSpec {
    diagnostic: number;
}

function decorate(doc: Node, marks: readonly DiagnosticMark[]): DecorationSet {
    const decorations: Decoration[] = [];
    const byBlock = new Map<number, { worst: DiagnosticSeverityName; counts: Map<DiagnosticSeverityName, Set<number>> }>();
    for (const mark of marks) {
        const spec: MarkSpec = { diagnostic: mark.index };
        if (mark.whole) {
            decorations.push(Decoration.node(mark.from, mark.to, { class: `mep-diag-block mep-diag-block-${mark.severity}` }, spec));
        } else {
            decorations.push(Decoration.inline(mark.from, mark.to, { class: `mep-diag mep-diag-${mark.severity}` }, { ...spec, inclusiveStart: false, inclusiveEnd: false }));
        }
        const held = byBlock.get(mark.block) ?? { worst: mark.severity, counts: new Map() };
        held.worst = worse(held.worst, mark.severity);
        const ofSeverity = held.counts.get(mark.severity) ?? new Set<number>();
        ofSeverity.add(mark.index);
        held.counts.set(mark.severity, ofSeverity);
        byBlock.set(mark.block, held);
    }
    for (const [block, held] of byBlock) {
        const { pos, inText } = markerPosition(doc, block);
        const counts = new Map([...held.counts].map(([s, set]) => [s, set.size] as [DiagnosticSeverityName, number]));
        const label = markerLabel(counts);
        decorations.push(Decoration.widget(pos, () => markerElement(held.worst, label, inText), {
            side: -1,
            key: `mep-diag-${block}-${held.worst}-${label}`,
            ignoreSelection: true,
            stopEvent: () => true,
        }));
    }
    return DecorationSet.create(doc, decorations);
}

/** Draw `items` — a `diagnostics` message's — on the document, placed by `map`, replacing every mark before. */
export function setDiagnosticsTransaction(state: EditorState, map: Pick<PositionMap, 'pageRangeOf'>, items: readonly DiagnosticEntry[]): Transaction {
    const marks = diagnosticMarks(state.doc, map, items);
    return state.tr.setMeta(diagnosticsPluginKey, { items, marks }).setMeta('addToHistory', false);
}

/** The diagnostics the state holds (the last message's), for the toolbar's count and the card. */
export function heldDiagnostics(state: EditorState): readonly DiagnosticEntry[] {
    return diagnosticsPluginKey.getState(state)?.items ?? [];
}

/** The diagnostics drawn at `pos` — squiggles over it, a block mark around it — with where each is drawn, worst first. */
export function diagnosticsAt(state: EditorState, pos: number): { entry: DiagnosticEntry; from: number; to: number }[] {
    const held = diagnosticsPluginKey.getState(state);
    if (!held) {
        return [];
    }
    const seen = new Map<number, { entry: DiagnosticEntry; from: number; to: number }>();
    for (const d of held.decorations.find(pos, pos)) {
        const index = (d.spec as Partial<MarkSpec>).diagnostic;
        const entry = index === undefined ? undefined : held.items[index];
        if (entry === undefined || index === undefined) {
            continue;
        }
        const known = seen.get(index);
        seen.set(index, known ? { entry, from: Math.min(known.from, d.from), to: Math.max(known.to, d.to) } : { entry, from: d.from, to: d.to });
    }
    return [...seen.values()].sort((a, b) => RANK[a.entry.severity] - RANK[b.entry.severity] || a.from - b.from);
}

/** What the count's view needs from the page. */
export interface DiagnosticsPort {
    /** The toolbar row's status slot, at its right end; `null` without a toolbar. */
    statusSlot(view: EditorView): HTMLElement | null;
    /** The count was clicked: VS Code's Problems view. */
    showProblems(): void;
}

/** The count at the toolbar's right end: `⨯ 1  ⚠ 2`, VS Code's codicons; nothing when there is nothing to say. */
class DiagnosticsCount implements PluginView {
    private readonly el: HTMLElement;
    private shown = '';

    constructor(private readonly view: EditorView, private readonly port: DiagnosticsPort) {
        this.el = document.createElement('div');
        this.el.className = 'mep-diag-count';
        this.el.setAttribute('role', 'button');
        this.el.tabIndex = 0;
        this.el.hidden = true;
        this.el.addEventListener('mousedown', e => e.preventDefault());
        this.el.addEventListener('click', e => {
            e.preventDefault();
            this.port.showProblems();
        });
        this.el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.port.showProblems();
            }
        });
        this.update(view);
    }

    update(view: EditorView): void {
        if (!this.el.isConnected) {
            this.port.statusSlot(this.view)?.append(this.el);
        }
        const counts = diagnosticCounts(heldDiagnostics(view.state));
        const parts = (['error', 'warning', 'info'] as const).filter(s => counts[s] > 0);
        const key = parts.map(s => `${s}:${counts[s]}`).join(' ');
        if (key === this.shown) {
            return;
        }
        this.shown = key;
        this.el.hidden = parts.length === 0;
        const nodes: globalThis.Node[] = [];
        for (const s of parts) {
            const part = document.createElement('span');
            part.className = `mep-diag-count-part mep-diag-count-${s}`;
            part.append(...lensLabelNodes(`${ICON[s]} ${counts[s]}`));
            nodes.push(part);
        }
        this.el.replaceChildren(...nodes);
        const words: Record<'error' | 'warning' | 'info', [string, string]> = { error: ['error', 'errors'], warning: ['warning', 'warnings'], info: ['info', 'infos'] };
        const said = parts.map(s => `${counts[s]} ${words[s][counts[s] === 1 ? 0 : 1]}`).join(', ');
        this.el.title = said === '' ? '' : `${said} — show the Problems view`;
        this.el.setAttribute('aria-label', this.el.title);
    }

    destroy(): void {
        this.el.remove();
    }
}

/** The diagnostics: squiggles, block marks and margin markers as decorations, and the toolbar's count. */
export function diagnosticsPlugin(port: DiagnosticsPort): Plugin<DiagnosticsState> {
    return new Plugin<DiagnosticsState>({
        key: diagnosticsPluginKey,
        state: {
            init: () => ({ items: [], decorations: DecorationSet.empty }),
            apply(tr, value, _old, newState): DiagnosticsState {
                const incoming = tr.getMeta(diagnosticsPluginKey) as { items: readonly DiagnosticEntry[]; marks: readonly DiagnosticMark[] } | undefined;
                if (incoming !== undefined) {
                    return { items: incoming.items, decorations: decorate(newState.doc, incoming.marks) };
                }
                return tr.docChanged ? { items: value.items, decorations: value.decorations.map(tr.mapping, tr.doc) } : value;
            },
        },
        view: view => new DiagnosticsCount(view, port),
        props: {
            decorations: state => diagnosticsPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
    });
}
