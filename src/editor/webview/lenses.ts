/**
 * Other extensions' code lenses in the page.
 *
 * **A lens's value here is its command, placed on the element it is about**
 * (Daniel, 2026-09-28). In the text editor a lens is the substitute for a
 * rendered view — a requirement's status, priority and edge counts in grey
 * above its heading. The page renders that view: the badge, the summary table.
 * A row repeating it in identical grey tokens, facts and counts and one verb
 * alike, with no sign of what is clickable, says everything twice and nothing
 * clearly. So a lens that names its surface (`LensSurface`, carried from the
 * provider by `host/lenses.ts`) is placed there, resolved by its `artifact`
 * against the injection marks of the document:
 *
 * | Surface | Placed on | When that is not there |
 * | --- | --- | --- |
 * | `status` | the standing row of the summary table (`injected_block`, mark `artifact`): `tr[data-req-standing]` (the agreed contract, workshop 2026-09-29, NEU-UXD-009, arriving with Req Explorer 1.12.0: `authored` is a `set`, `derived`, a change's stage, a `go`), or, for every earlier build, `tr[data-req-field="status"]` (a `set`); without either row, the status badge (`inline_atom`, mark `artifact`) in its heading | a verb of the heading |
 * | `priority` | `tr[data-req-field="priority"]` of that table | a verb of the heading |
 * | `links` | `tr[data-req-relation="<relation>"]` of that table, of its side (`data-req-direction`) when the lens names one | a verb of the heading |
 * | `action` | — | a verb of the heading, in its object toolbar |
 *
 * On a table row the lens lives on one cell. A relation row's lens is on its
 * label cell (`th`): the other cell holds the relation's target links, which
 * open on a plain click (the table is a read model, `InjectedBlockView`), and
 * the label runs the group's lens. A status or priority lens is on the value
 * — the status chip, the priority cell — since it sets that value. The
 * element says which (`data-lens-kind`: `set` drawn as a dropdown, `go`
 * underlined as a link).
 *
 * The heading and the table are looked for beside the lens first — the
 * heading it stands on, the table right after — and only then anywhere in the
 * document, since two headings can carry one readable id. An element takes
 * one lens; a second for the same element is a verb, not a lens nobody can
 * reach.
 *
 * A placed element keeps the look it has in the preview, and on hover shows an
 * underline, a pointer and a tooltip naming the verb; a click, or `Enter` with
 * it focused, runs the lens. **The editor does not guess**: a lens without a
 * hint is a foreign lens and keeps the text editor's grammar, a row above its
 * block — except on a block that received a hinted lens, where the foreign ones
 * join the hinted ones' verbs in the object toolbar: one block, one grammar; a
 * row beside clickable badges and table rows would be the mixed grammar this
 * replaces. Only a block with no object toolbar (a paragraph) keeps a row for
 * the verbs that would have gone there, since a lens with nowhere to be would
 * be lost.
 *
 * **Everything follows its block, not its index.** The lenses arrive for the
 * host's parse of a text the page held; from then on the page may split, join
 * and move blocks before the next refresh arrives. On arrival each placement is
 * put on the top-level node it resolved to, and from then on it follows that
 * node through every transaction the way `fidelityPlugin` follows a node for
 * its `src` and `gap` (`descent`: the same object, else the node the mapping
 * takes its start to). A node that disappears takes its lenses with it; a node
 * that descends from none (the second half of a split) has none until the
 * refresh. A badge or a table row is found again inside its block on every
 * update, so a redrawn rendering is marked afresh.
 *
 * The rows are widgets at the start of their block: not content, never
 * serialized, not selectable, and every event inside them is theirs.
 */
import { Node } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, PluginView, Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { descent } from '../fidelity';
import type { LensDirection, LensItem, LensRow } from '../protocol';
import { objectOfNode } from './objects';

/** The row of a summary table a lens names: the status or priority field, or a relation — on one side of it when `direction` is given. */
interface RowKey {
    surface: 'status' | 'priority' | 'links';
    relation?: string;
    direction?: LensDirection;
}

/** A lens placed on a rendered element of its block: the status badge, or the label cell of a row of the table. */
type HeldTarget = { id: string; item: LensItem; artifact: string } & ({ on: 'badge' } | { on: 'row'; key: RowKey });

/** What one top-level block holds of the last `lenses` message. */
interface HeldBlock {
    /** Fresh per `lenses` message, so a row widget is redrawn only when it was replaced. */
    key: string;
    /** Drawn as a row above the block, as the text editor draws lenses. */
    row: readonly LensItem[];
    /** Verbs of the block's object toolbar (`lensVerbsAt`). */
    verbs: readonly LensItem[];
    /** Elements of the block's rendering that run a lens. */
    targets: readonly HeldTarget[];
}

interface LensState {
    /** Parallel to the document's top-level children: what child `i` holds, or `null`. */
    blocks: readonly (HeldBlock | null)[];
    decorations: DecorationSet;
}

export const lensPluginKey = new PluginKey<LensState>('mepLenses');

let received = 0;

/**
 * `$(name)` and `$(name~modifier)`: VS Code's codicon syntax in a title, with the
 * workbench's own escape — `\$(name)` is the literal text `$(name)`.
 */
const ICON_REFERENCE = /(\\)?\$\(([a-z0-9-]+)(?:~[a-z0-9-]*)?\)/gi;

/**
 * A lens or code-action title as plain text: its `$(icon)` references — VS
 * Code's codicon syntax — left out, an escaped one (`\$(name)`) kept as the
 * literal `$(name)`. For a tooltip, an accessible name, a `<option>` (which
 * holds no elements) and every comparison of text; where a title is drawn,
 * `lensLabelNodes` renders the icons.
 */
export function lensLabel(title: string): string {
    return title
        .replace(ICON_REFERENCE, (match, escape: string | undefined) => escape ? match.slice(1) : '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * What names a title where its text is empty — an icon-only `$(refresh)`: the
 * plain text, or else the first icon's name. For `title` and `aria-label`, so a
 * button of only an icon still has an accessible name and a tooltip.
 */
export function lensName(title: string): string {
    const text = lensLabel(title);
    if (text !== '') {
        return text;
    }
    for (const match of title.matchAll(ICON_REFERENCE)) {
        if (!match[1]) {
            return match[2].toLowerCase();
        }
    }
    return '';
}

/**
 * A title as the page draws it: each `$(name)` a `<span class="codicon
 * codicon-name">` — the font is `codicon.css`, linked by the host's page — and
 * the text between them as text nodes; an escaped `\$(name)` is the text
 * `$(name)`. A `~modifier` (`~spin`) is ignored: an icon does not animate here.
 * The name is not checked against the font; an unknown one is an empty icon
 * slot. Whitespace beside an icon is dropped (the stylesheet spaces it); a title
 * with no icon is one text node, `lensLabel`'s.
 */
export function lensLabelNodes(title: string): globalThis.Node[] {
    const nodes: globalThis.Node[] = [];
    let pending = '';
    let last = 0;
    const flush = () => {
        const piece = pending.replace(/\s+/g, ' ').trim();
        if (piece !== '') {
            nodes.push(document.createTextNode(piece));
        }
        pending = '';
    };
    for (const match of title.matchAll(ICON_REFERENCE)) {
        const at = match.index ?? 0;
        pending += title.slice(last, at);
        last = at + match[0].length;
        if (match[1]) {
            // Escaped: the literal stays part of the surrounding text.
            pending += match[0].slice(1);
            continue;
        }
        flush();
        const icon = document.createElement('span');
        icon.className = `codicon codicon-${match[2].toLowerCase()}`;
        icon.setAttribute('aria-hidden', 'true');
        nodes.push(icon);
    }
    pending += title.slice(last);
    flush();
    return nodes.length > 0 ? nodes : [document.createTextNode('')];
}

/**
 * The dropdown affordance of every control that opens a list — a toolbar
 * menu's face, a submenu's entry (`right`), an object bar's set-verb: the
 * workbench's own codicon chevron, as its menus and dropdowns draw it, in a
 * `.mep-menu-caret` the stylesheet dims. One element for all of them, so the
 * row, the menus and the bars cannot draw it three ways.
 */
export function chevronNode(direction: 'down' | 'right' = 'down'): HTMLElement {
    const holder = document.createElement('span');
    holder.className = 'mep-menu-caret';
    holder.setAttribute('aria-hidden', 'true');
    holder.append(...lensLabelNodes(`$(chevron-${direction})`));
    return holder;
}

/** What a placed element's tooltip says: the verb, then the provider's own tooltip where it says more. */
function targetTitle(item: LensItem): string {
    const label = lensName(item.title);
    return item.tooltip && item.tooltip !== item.title && item.tooltip !== label ? `${label}\n${item.tooltip}` : label;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The artifact an injection mark names, for an atom (the badge, the summary table). */
function artifactOf(mark: unknown): string | null {
    const m = mark as { kind?: unknown; artifact?: unknown } | null;
    return m !== null && typeof m === 'object' && m.kind === 'atom' && typeof m.artifact === 'string' ? m.artifact : null;
}

/**
 * The row of a summary table a lens names, in `root` (the table's rendering,
 * live or parsed). A `links` lens with a `direction` takes the row of that
 * side only — a symmetric relation has one per side under one key; one
 * without (a Req Explorer older than the field) takes the relation's first.
 */
function tableRowIn(root: ParentNode, key: RowKey): HTMLElement | null {
    if (key.surface === 'status') {
        // The standing row, whatever field states it (a Status, a release's lifecycle, a change's derived Stage);
        // a Req Explorer older than `data-req-standing` marks only the field named `status`.
        return root.querySelector<HTMLElement>('tr[data-req-standing]') ?? root.querySelector<HTMLElement>('tr[data-req-field="status"]');
    }
    if (key.surface !== 'links') {
        return root.querySelector<HTMLElement>(`tr[data-req-field="${key.surface}"]`);
    }
    // Compared, not put into a selector: the key is the provider's text.
    return Array.from(root.querySelectorAll<HTMLElement>('tr[data-req-relation]'))
        .find(tr => tr.dataset.reqRelation === key.relation && (key.direction === undefined || tr.dataset.reqDirection === key.direction)) ?? null;
}

/** The position of the status badge naming `artifact` inside `heading` at `offset`, or `null`. */
function badgePos(heading: Node, offset: number, artifact: string): number | null {
    let found: number | null = null;
    heading.descendants((node, pos) => {
        if (found !== null) {
            return false;
        }
        if (node.type.name === 'inline_atom' && artifactOf(node.attrs.mark) === artifact) {
            found = offset + 1 + pos;
        }
        return true;
    });
    return found;
}

/**
 * The label cell of a table row: where a relation row's lens lives. The row's
 * other cells hold links to the relation's targets, which a plain click opens
 * (`nodeViews.ts`, `InjectedBlockView`); the label runs the lens (the group's
 * picker). A row without a `th` is its own label.
 */
function labelCellOf(row: HTMLElement): HTMLElement {
    return Array.from(row.children).find((c): c is HTMLElement => c.tagName === 'TH') ?? row;
}

/**
 * The value of a field row: where a lens that sets the field lives — the
 * status chip in the status row where Req Explorer draws one, else the value
 * cell. It is what the verb changes, and what the dropdown grammar goes on.
 */
function valueOf(row: HTMLElement): HTMLElement {
    const cell = Array.from(row.children).find((c): c is HTMLElement => c.tagName === 'TD');
    return cell?.querySelector<HTMLElement>('.req-badge') ?? cell ?? row;
}

/**
 * What a lens's click does, as its element shows it (`data-lens-kind`):
 * `set` changes the artifact — its status, its priority — and is drawn as a
 * dropdown; `go` goes somewhere — a relation's picker — and is underlined, as
 * the links beside it are. Two verbs, two signifiers (Daniel, 2026-09-28).
 * A standing row marked `data-req-standing="derived"` (a change's stage) has
 * nothing to set: its lens goes to the view that explains it, so it is a `go`.
 */
function lensKind(target: HeldTarget, el: HTMLElement): 'set' | 'go' {
    return (target.on === 'badge' || target.key.surface !== 'links') && el.closest('tr')?.dataset.reqStanding !== 'derived' ? 'set' : 'go';
}

/**
 * Whether the top-level `child` is the heading of `artifact`: it carries the
 * badge that names it, or — where Req Explorer draws no badge because the
 * summary table shows the status — its requirement id is `artifact`.
 */
function headingOf(child: Node, artifact: string): boolean {
    if (child.type.name !== 'heading') {
        return false;
    }
    const prefix = child.attrs.reqPrefix as string | null;
    return badgePos(child, 0, artifact) !== null || prefix?.replace(/:\s*$/, '') === artifact;
}

/** Whether the top-level `child` is the summary table injected for `artifact`. */
function tableOf(child: Node, artifact: string): boolean {
    return child.type.name === 'injected_block' && artifactOf(child.attrs.mark) === artifact;
}

/**
 * Where an artifact's heading (with its badge) and summary table stand, for a
 * lens on block `b`: **its own block first** — the heading the lens sits on,
 * the table directly after it (or the table itself) — and only then the first
 * of each in the document. A readable id is not unique: two headings can
 * carry the same one (a collision the corpus's checks report), and each
 * heading's lenses belong to its own badge and table, not the first pair
 * with that id.
 */
function artifactPlaces(doc: Node): (b: number, artifact: string) => { heading?: number; table?: number } {
    const first = (test: (child: Node, artifact: string) => boolean) => {
        const found = new Map<string, number | undefined>();
        return (artifact: string): number | undefined => {
            if (!found.has(artifact)) {
                let at: number | undefined;
                for (let i = 0; i < doc.childCount && at === undefined; i++) {
                    if (test(doc.child(i), artifact)) {
                        at = i;
                    }
                }
                found.set(artifact, at);
            }
            return found.get(artifact);
        };
    };
    const firstHeading = first(headingOf);
    const firstTable = first(tableOf);
    const at = (i: number) => (i >= 0 && i < doc.childCount ? doc.child(i) : null);
    return (b, artifact) => {
        const own = at(b);
        const next = at(b + 1);
        const prev = at(b - 1);
        const heading = own !== null && headingOf(own, artifact) ? b
            : own !== null && tableOf(own, artifact) && prev !== null && headingOf(prev, artifact) ? b - 1
                : undefined;
        const table = own !== null && tableOf(own, artifact) ? b
            : heading !== undefined && next !== null && tableOf(next, artifact) ? b + 1
                : undefined;
        // A table only beside its own heading: the lens's heading has none, or another's.
        const local = heading !== undefined || table !== undefined;
        return {
            heading: heading ?? (local ? undefined : firstHeading(artifact)),
            table: table ?? (local ? undefined : firstTable(artifact)),
        };
    };
}

/** The row a lens names in the table rendering of block `index`, or `null`; each block's rendering parsed once per placement. */
function rowFinder(doc: Node): (index: number, key: RowKey) => HTMLElement | null {
    const parsed = new Map<number, DocumentFragment>();
    return (index, key) => {
        let content = parsed.get(index);
        if (content === undefined) {
            // Inert: a template's content runs no script and loads nothing.
            const template = document.createElement('template');
            template.innerHTML = doc.child(index).attrs.html as string;
            content = template.content;
            parsed.set(index, content);
        }
        return tableRowIn(content, key);
    };
}

/** An `action` lens comes before the fallbacks among a block's verbs: it is a verb by its provider's word. */
function verbOrder(items: LensItem[]): LensItem[] {
    return [...items.filter(i => i.surface === 'action'), ...items.filter(i => i.surface !== 'action')];
}

/**
 * Where each lens of a `lenses` message goes in `doc`, the document the page
 * holds as it arrives (parallel to its top-level children). `rows` are indexed
 * by the host's parse of that same text.
 */
function place(doc: Node, rows: readonly LensRow[], tag: string): (HeldBlock | null)[] {
    const placesFor = artifactPlaces(doc);
    const rowOf = rowFinder(doc);
    /**
     * The elements already given a lens — a heading's badge by its index, a
     * table row by the element the parsed rendering has for it: a second lens
     * for the same element (two status lenses, two lenses of one relation from
     * a Req Explorer that names no side) would be marked on an element that
     * shows only the first, and could never be reached. It is a verb instead.
     */
    const claimed = new Set<unknown>();
    const claim = (element: unknown): boolean => {
        if (claimed.has(element)) {
            return false;
        }
        claimed.add(element);
        return true;
    };
    const parts = Array.from({ length: doc.childCount }, () => ({ row: [] as LensItem[], verbs: [] as LensItem[], targets: [] as HeldTarget[] }));
    const offsets: number[] = [];
    doc.forEach((_child, offset) => offsets.push(offset));
    const hasToolbar = (i: number) => objectOfNode(doc.child(i), offsets[i]) !== null;
    // A verb goes to the block's object toolbar; a block without one keeps it in a row.
    const verb = (i: number, item: LensItem) => (hasToolbar(i) ? parts[i].verbs : parts[i].row).push(item);

    for (const { blockIndex: b, items } of rows) {
        if (b < 0 || b >= parts.length || items.length === 0) {
            continue;
        }
        if (!items.some(i => i.surface !== undefined)) {
            parts[b].row.push(...items);
            continue;
        }
        for (const item of items) {
            if (item.surface === undefined || item.artifact === undefined) {
                verb(b, item);
                continue;
            }
            const artifact = item.artifact;
            const { heading, table } = placesFor(b, artifact);
            const surface = item.surface;
            // A row of the summary table first: the status too, which Req
            // Explorer shows in the table and — only where no table repeats it —
            // as a badge beside the heading.
            const key: RowKey | null = surface === 'action' ? null : {
                surface,
                ...(item.relation !== undefined ? { relation: item.relation } : {}),
                ...(item.direction !== undefined ? { direction: item.direction } : {}),
            };
            const row = key !== null && table !== undefined && (surface !== 'links' || key.relation !== undefined) ? rowOf(table, key) : null;
            if (key !== null && table !== undefined && row !== null) {
                // Without a command the lens only repeats what the row says.
                if (item.id === undefined) {
                    continue;
                }
                if (claim(row)) {
                    parts[table].targets.push({ id: item.id, item, artifact, on: 'row', key });
                    continue;
                }
            } else if (surface === 'status' && heading !== undefined && badgePos(doc.child(heading), 0, artifact) !== null) {
                if (item.id === undefined) {
                    continue;
                }
                if (claim(`badge ${heading}`)) {
                    parts[heading].targets.push({ id: item.id, item, artifact, on: 'badge' });
                    continue;
                }
            }
            // An action, or a lens whose element the page does not show: a verb of the artifact's heading.
            verb(heading ?? b, item);
        }
    }
    return parts.map((p, i) => (p.row.length + p.verbs.length + p.targets.length === 0
        ? null
        : { key: `${tag}-${i}`, row: p.row, verbs: verbOrder(p.verbs), targets: p.targets }));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function rowDOM(items: readonly LensItem[], run: (id: string) => void): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mep-lens-row';
    el.contentEditable = 'false';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Code lenses');
    // The pointer is the row's: no caret placed, no focus taken from the text.
    el.addEventListener('mousedown', e => e.preventDefault());
    items.forEach((item, k) => {
        if (k > 0) {
            const sep = document.createElement('span');
            sep.className = 'mep-lens-separator';
            sep.setAttribute('aria-hidden', 'true');
            sep.textContent = ' | ';
            el.append(sep);
        }
        const label = lensName(item.title);
        const id = item.id;
        if (id === undefined) {
            const text = document.createElement('span');
            text.className = 'mep-lens-text';
            text.replaceChildren(...lensLabelNodes(item.title));
            text.title = item.tooltip || label;
            el.append(text);
            return;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mep-lens';
        button.dataset.lens = id;
        button.replaceChildren(...lensLabelNodes(item.title));
        button.title = item.tooltip ?? label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', e => {
            e.preventDefault();
            run(id);
        });
        el.append(button);
    });
    return el;
}

function decorate(doc: Node, blocks: readonly (HeldBlock | null)[], run: (id: string) => void): DecorationSet {
    const widgets: Decoration[] = [];
    doc.forEach((_child, offset, index) => {
        const block = blocks[index];
        if (block && block.row.length > 0) {
            const { key, row } = block;
            widgets.push(Decoration.widget(offset, () => rowDOM(row, run), {
                side: -1,
                key,
                ignoreSelection: true,
                stopEvent: () => true,
            }));
        }
    });
    return DecorationSet.create(doc, widgets);
}

function nothingHeld(doc: Node): (HeldBlock | null)[] {
    return Array.from({ length: doc.childCount }, () => null);
}

// ---------------------------------------------------------------------------
// Placed elements
// ---------------------------------------------------------------------------

/** The element of the block at `offset` that `target` is placed on, in the view as it is drawn now. */
function targetElement(view: EditorView, child: Node, offset: number, target: HeldTarget): HTMLElement | null {
    if (target.on === 'badge') {
        const pos = child.type.name === 'heading' ? badgePos(child, offset, target.artifact) : null;
        const dom = pos === null ? null : view.nodeDOM(pos);
        return dom instanceof HTMLElement ? dom : null;
    }
    if (!tableOf(child, target.artifact)) {
        return null;
    }
    const dom = view.nodeDOM(offset);
    const row = dom instanceof HTMLElement ? tableRowIn(dom, target.key) : null;
    return row === null ? null : target.key.surface === 'links' ? labelCellOf(row) : valueOf(row);
}

/** Whether `el` is part of a table, whose semantics a lens on it keeps: no `role=button` on a cell. */
function inTable(el: HTMLElement): boolean {
    return el.tagName === 'TR' || el.tagName === 'TH' || el.tagName === 'TD';
}

/** The title an element had before a lens was placed on it, to give back when the lens goes. */
const titleBefore = new WeakMap<HTMLElement, string | null>();

function markTarget(el: HTMLElement, target: HeldTarget): void {
    if (!titleBefore.has(el)) {
        titleBefore.set(el, el.getAttribute('title'));
    }
    el.classList.add('mep-lens-target');
    el.dataset.lens = target.id;
    el.dataset.lensKind = lensKind(target, el);
    const title = targetTitle(target.item);
    if (el.title !== title) {
        el.title = title;
    }
    if (el.tabIndex !== 0) {
        // Reachable with Tab, and `Enter` runs it (`LensTargets`).
        el.tabIndex = 0;
    }
    if (!inTable(el) && el.getAttribute('role') !== 'button') {
        // A cell keeps its table semantics; the badge is a button while it runs a lens.
        el.setAttribute('role', 'button');
    }
    // A `<summary>` inside is not the lens's: a click on it opens its list
    // (`LensTargets`), so it must not promise the verb either. An empty title
    // stops the target's from showing over it; the underline is kept off it in
    // `editor.css`. A label cell holds none; a row without one (its own label)
    // may.
    for (const summary of Array.from(el.querySelectorAll<HTMLElement>('summary:not([title])'))) {
        summary.setAttribute('title', '');
        summary.dataset.mepLensUntitled = '';
    }
}

function unmarkTarget(el: HTMLElement): void {
    for (const summary of Array.from(el.querySelectorAll<HTMLElement>('summary[data-mep-lens-untitled]'))) {
        summary.removeAttribute('title');
        delete summary.dataset.mepLensUntitled;
    }
    el.classList.remove('mep-lens-target');
    delete el.dataset.lens;
    delete el.dataset.lensKind;
    el.removeAttribute('tabindex');
    if (!inTable(el)) {
        el.removeAttribute('role');
    }
    const title = titleBefore.get(el);
    titleBefore.delete(el);
    if (title === null || title === undefined) {
        el.removeAttribute('title');
    } else {
        el.title = title;
    }
}

/**
 * The badges and label cells that run a lens: marked after every update — a
 * rendering the view redrew is marked afresh, one whose lens went is given
 * back its own look — and their pointer and keys taken before anything under
 * them sees them. A link is never the lens's, even inside a target: in the
 * summary table a click opens it (`InjectedBlockView`). A Ctrl/Cmd+click is
 * not the lens's either, and a click on a `<summary>` opens the list it
 * collapses.
 */
class LensTargets implements PluginView {
    private marked = new Set<HTMLElement>();
    private readonly listeners: [string, EventListener][] = [];

    constructor(private readonly view: EditorView, private readonly run: (id: string) => void) {
        const own = (e: Event): HTMLElement | null => {
            const target = e.target as Element | null;
            const el = typeof target?.closest === 'function' ? target.closest<HTMLElement>('.mep-lens-target') : null;
            return el !== null && this.marked.has(el) && view.dom.contains(el) ? el : null;
        };
        const plain = (e: MouseEvent, el: HTMLElement): boolean => {
            const target = e.target as Element;
            const own = (selector: string) => {
                const found = target.closest(selector);
                return found !== null && el.contains(found);
            };
            return e.button === 0 && !e.ctrlKey && !e.metaKey && !own('summary') && !own('a[href]');
        };
        this.listen('mousedown', e => {
            const el = own(e);
            if (el !== null && plain(e as MouseEvent, el)) {
                // No node selection, no caret moved, no focus taken from the text.
                e.preventDefault();
                e.stopPropagation();
            }
        });
        this.listen('click', e => {
            const el = own(e);
            if (el !== null && plain(e as MouseEvent, el) && el.dataset.lens) {
                e.preventDefault();
                e.stopPropagation();
                this.run(el.dataset.lens);
            }
        });
        this.listen('keydown', e => {
            const key = (e as KeyboardEvent).key;
            const el = own(e);
            if (el !== null && e.target === el && (key === 'Enter' || key === ' ') && el.dataset.lens) {
                e.preventDefault();
                e.stopPropagation();
                this.run(el.dataset.lens);
            }
        });
        this.update();
    }

    update(): void {
        const view = this.view;
        const blocks = lensPluginKey.getState(view.state)?.blocks ?? [];
        const next = new Map<HTMLElement, HeldTarget>();
        view.state.doc.forEach((child, offset, index) => {
            for (const target of blocks[index]?.targets ?? []) {
                const el = targetElement(view, child, offset, target);
                if (el !== null && !next.has(el)) {
                    next.set(el, target);
                }
            }
        });
        for (const el of this.marked) {
            if (!next.has(el)) {
                unmarkTarget(el);
            }
        }
        for (const [el, target] of next) {
            markTarget(el, target);
        }
        this.marked = new Set(next.keys());
    }

    destroy(): void {
        for (const [type, listener] of this.listeners) {
            this.view.dom.removeEventListener(type, listener, true);
        }
        this.marked.forEach(unmarkTarget);
        this.marked.clear();
    }

    /** In the capture phase on the editor: before ProseMirror, and before a rendering's own link handling. */
    private listen(type: string, listener: EventListener): void {
        this.view.dom.addEventListener(type, listener, true);
        this.listeners.push([type, listener]);
    }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/** Place `rows` — from a `lenses` message, indexed by the host's parse — on the document, replacing every placement before. */
export function setLensesTransaction(state: EditorState, rows: readonly LensRow[]): Transaction {
    return state.tr.setMeta(lensPluginKey, rows).setMeta('addToHistory', false);
}

/** The rows the state holds, as block index and titles: for tests. */
export function lensRowsOf(state: EditorState): { blockIndex: number; titles: string[] }[] {
    const held = lensPluginKey.getState(state)?.blocks ?? [];
    return held.flatMap((block, blockIndex) => (block && block.row.length > 0 ? [{ blockIndex, titles: block.row.map(i => i.title) }] : []));
}

/**
 * The lenses the object toolbar of the top-level block at `pos` carries as
 * verbs: its `action` lenses first, then the hinted lenses whose element is
 * not shown and the foreign lenses beside them, in line order.
 */
export function lensVerbsAt(state: EditorState, pos: number): readonly LensItem[] {
    const doc = state.doc;
    if (pos < 0 || pos >= doc.content.size) {
        return [];
    }
    const $pos = doc.resolve(pos);
    return $pos.depth === 0 ? lensPluginKey.getState(state)?.blocks[$pos.index(0)]?.verbs ?? [] : [];
}

/** The lenses; `run` is called with a lens's id when it is clicked or chosen with the keyboard. */
export function lensPlugin(run: (id: string) => void): Plugin<LensState> {
    return new Plugin<LensState>({
        key: lensPluginKey,
        state: {
            init: (_config, state) => ({ blocks: nothingHeld(state.doc), decorations: DecorationSet.empty }),
            apply(tr, value, oldState, newState): LensState {
                const incoming = tr.getMeta(lensPluginKey) as readonly LensRow[] | undefined;
                if (incoming !== undefined) {
                    const blocks = place(newState.doc, incoming, `mep-lens-${++received}`);
                    return { blocks, decorations: decorate(newState.doc, blocks, run) };
                }
                if (!tr.docChanged) {
                    return value;
                }
                const from = descent([tr], oldState.doc, newState.doc);
                const blocks = from.map(i => (i < 0 ? null : value.blocks[i] ?? null));
                return { blocks, decorations: decorate(newState.doc, blocks, run) };
            },
        },
        view: view => new LensTargets(view, run),
        props: {
            decorations: state => lensPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
    });
}
