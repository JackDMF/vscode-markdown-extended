import { Mark, Node } from 'prosemirror-model';
import { Plugin, PluginKey, Transaction } from 'prosemirror-state';
import type { Mapping } from 'prosemirror-transform';
import { EDITABLE_TOP_NODES } from './schema';
import { itemTakesLiteral, quoteLostLiteral } from './serialize';

export const fidelityPluginKey = new PluginKey('mepFidelity');

/**
 * Set this meta on a transaction (`tr.setMeta(PRESERVE_SOURCE_META, true)`) to
 * keep every `src` and `gap` it would otherwise clear — for a transaction that
 * restores content rather than changing it, such as re-syncing from the text
 * document. Its attributes are the host's parse and are right by construction.
 */
export const PRESERVE_SOURCE_META = 'mepPreserveSource';

/** prosemirror-history's plugin key, as it names its meta; undo and redo carry it. */
const HISTORY_META = 'history$';

/**
 * The heading attributes that name something and must not be written twice: the
 * requirement id and the anchor. `attrsSuffix` is not compared — a class-only
 * suffix (`{.unnumbered}`) may legitimately repeat, and one that carries an id
 * has it in `anchor` — but it is cleared with them, since it is where the
 * anchor is written.
 */
const IDENTITY_ATTRS = ['reqPrefix', 'anchor'] as const;
const STRIPPED_ATTRS = ['reqPrefix', 'anchor', 'attrsSuffix'] as const;

function isPreserving(tr: Transaction): boolean {
    return tr.getMeta(PRESERVE_SOURCE_META) === true;
}

function isHistory(tr: Transaction): boolean {
    return tr.getMeta(HISTORY_META) !== undefined;
}

export interface TopLevelChild {
    node: Node;
    offset: number;
}

export function topLevelChildren(doc: Node): TopLevelChild[] {
    const out: TopLevelChild[] = [];
    doc.forEach((node, offset) => {
        out.push({ node, offset });
    });
    return out;
}

/**
 * For every top-level child of `after`, the index of the top-level child of
 * `before` it descends from, or `-1` for a node that descends from none (one a
 * split, a paste or the UI created).
 *
 * Identity first: ProseMirror never mutates a node, so a child that is the same
 * object as an old one *is* that one, wherever it now stands — which is what
 * makes a move a move. A child that is a new object descends from the old child
 * whose start the transactions map onto its start: typing into a node, setting
 * its markup or changing its type keep its start where it was, while the second
 * half of a split starts at a position no old start maps to. Where two old
 * starts land on one position (a node deleted, and its follower now starting
 * there), the one that was not deleted wins. A last pass maps with the other
 * bias, for content inserted exactly at an old start that took that node's
 * place (typing `- ` wraps a paragraph in a list that starts where it did).
 */
export function descent(transactions: readonly Transaction[], before: readonly TopLevelChild[], after: readonly TopLevelChild[]): number[] {
    const result = after.map(() => -1);
    const claimed = new Set<number>();

    const byIdentity = new Map<Node, number[]>();
    before.forEach((c, i) => {
        const list = byIdentity.get(c.node) ?? [];
        list.push(i);
        byIdentity.set(c.node, list);
    });
    after.forEach((c, j) => {
        const i = byIdentity.get(c.node)?.find(k => !claimed.has(k));
        if (i !== undefined) {
            result[j] = i;
            claimed.add(i);
        }
    });

    const byStart = (assoc: 1 | -1): Map<number, { index: number; deleted: boolean }> => {
        const starts = new Map<number, { index: number; deleted: boolean }>();
        before.forEach((c, i) => {
            if (claimed.has(i)) {
                return;
            }
            let pos = c.offset;
            let deleted = false;
            for (const tr of transactions) {
                const mapped = tr.mapping.mapResult(pos, assoc);
                pos = mapped.pos;
                deleted = deleted || mapped.deleted;
            }
            const seen = starts.get(pos);
            if (!seen || (seen.deleted && !deleted)) {
                starts.set(pos, { index: i, deleted });
            }
        });
        return starts;
    };
    for (const assoc of [1, -1] as const) {
        const starts = byStart(assoc);
        after.forEach((c, j) => {
            const candidate = result[j] === -1 ? starts.get(c.offset) : undefined;
            if (candidate && !claimed.has(candidate.index)) {
                result[j] = candidate.index;
                claimed.add(candidate.index);
            }
        });
    }
    return result;
}

/**
 * Whether the save writes the top-level `node` by rule after an edit whose
 * starting document's top-level children are `present`: an editable node that
 * is none of them, which `fidelityPlugin` clears `src` on. The one rule both
 * the plugin and the check of an edit (`rewrittenBlocks`) read.
 */
export function rewritesSource(node: Node, present: ReadonlySet<Node>): boolean {
    return EDITABLE_TOP_NODES.has(node.type.name) && !present.has(node);
}

/**
 * The top-level children of `after` the save writes by rule once an edit of
 * `before` into `after` is applied (`rewritesSource`): every textblock in them
 * is written again, the ones the edit did not touch included — a list item
 * beside the one typed in, the other cells of a table.
 *
 * Asked of the range the edit changed (`from`, `to` in `after`; `mapping` takes
 * it back into `before`): a step rebuilds only the nodes around its range, so
 * every top-level child outside it is the same object it was, and a child
 * moved into it came from inside the range in `before`. So only the children
 * on either side of the range are compared, and a keystroke in a long document
 * costs what the blocks it touches cost.
 */
export function rewrittenBlocks(before: Node, after: Node, from: number, to: number, mapping: Mapping): TopLevelChild[] {
    const back = mapping.invert();
    const present = new Set(topLevelBetween(before, back.map(from, -1), back.map(to, 1)).map(c => c.node));
    return topLevelBetween(after, from, to).filter(c => rewritesSource(c.node, present));
}

/**
 * The top-level children of `doc` that overlap `from`–`to`, as `nodesBetween`
 * finds them, but found from the resolved ends rather than by walking every
 * child before them.
 */
function topLevelBetween(doc: Node, from: number, to: number): TopLevelChild[] {
    const size = doc.content.size;
    const $from = doc.resolve(Math.max(0, Math.min(from, size)));
    const $to = doc.resolve(Math.max(0, Math.min(to, size)));
    const end = $to.depth > 0 ? $to.index(0) + 1 : $to.index(0);
    const out: TopLevelChild[] = [];
    let offset = $from.depth > 0 ? $from.before(1) : $from.pos;
    for (let i = $from.index(0); i < end; i++) {
        const node = doc.child(i);
        out.push({ node, offset });
        offset += node.nodeSize;
    }
    return out;
}

/** The same node apart from `src` and `gap`: same type, attributes, marks and content. */
function sameBody(a: Node, b: Node): boolean {
    if (a.type !== b.type || !a.content.eq(b.content) || !Mark.sameSet(a.marks, b.marks)) {
        return false;
    }
    return Object.keys(a.attrs).every(key => key === 'src' || key === 'gap' || a.attrs[key] === b.attrs[key]);
}

/**
 * Keeps the source-derived attributes of the top-level nodes true across edits,
 * so the serializer can go on trusting them.
 *
 * **`src`** is cleared on every top-level editable node a transaction changed,
 * so the serializer writes that node by rule and keeps emitting every other one
 * from its slice. "Changed" is judged by node identity: a top-level child of the
 * new document that was not a child of the old one is new or edited, and one
 * that was is untouched — also when it moved, because a move carries the same
 * node object and its slice is still exactly its text. `front_matter`,
 * `raw_block` and `injected_block` are never cleared: their `src` is what they
 * are, and it changes only when the UI sets it explicitly.
 *
 * **`gap`** — the text between a node and its predecessor — is a fact about the
 * pair, so it holds only while the pair does. It is cleared (the serializer then
 * writes one blank line) on a node that descends from no old node (the second
 * half of a split, a paste), on one whose type changed, and on one whose
 * predecessor is no longer the node it followed — a move, a deletion or a split
 * in front of it, or a predecessor whose type changed (see `descent` for how a
 * node is followed through an edit). Without this, `# H\nAlpha beta` split
 * after `Alpha` is written as `# H\nAlpha\nbeta`, which is one paragraph again.
 * A node whose predecessor is unchanged keeps its gap even when its own content
 * changed: typing in a paragraph does not touch the blank lines around it.
 *
 * **Attribute literals** (`attrsSuffix`) are a top-level block's own: the second
 * half of a split paragraph does not carry `{#id}` again, and a block wrapped
 * inside another loses the literal only a top-level block writes
 * (`stripCopiedSuffixes`, `nestedSuffixes`).
 *
 * **Requirement ids** must not be written twice. A top-level heading that did
 * not carry its `reqPrefix`, `anchor` and `attrsSuffix` before this transaction
 * (a split, a paste) loses all three when another top-level heading carries the
 * same non-null `reqPrefix` or `anchor` — two `## ID: … {#anchor}` lines are the
 * duplicate Req Explorer's checks refuse. The heading that had them keeps them,
 * so typing in one of two headings a file already duplicated changes nothing.
 * The UI keeps this from arising (Enter in such a heading starts a paragraph);
 * this is the guard that holds whatever produced the transaction.
 *
 * A transaction carrying `PRESERVE_SOURCE_META` is left alone entirely: it puts
 * the host's own parse in place, whose `src` and `gap` are right by definition,
 * and whose new node objects the rules above would take for edited ones.
 *
 * Undo and redo are left alone too — prosemirror-history restores `src` and
 * `gap` together with the content they restore, because every clearing this
 * plugin appends is recorded in the same history event, and clearing them again
 * would re-serialize a block the undo just returned to its exact text — with one
 * exception. An undo past a re-sync (whose attributes were never in the history)
 * can change a node's content under the `src` the host gave it; a node whose
 * content an undo changed while its `src` stayed exactly what it was has a slice
 * of text it no longer holds, and that `src` is cleared.
 */
export function fidelityPlugin(): Plugin {
    return new Plugin({
        key: fidelityPluginKey,
        appendTransaction(transactions, oldState, newState) {
            if (!transactions.some(tr => tr.docChanged) || transactions.some(isPreserving)) {
                return null;
            }
            const before = topLevelChildren(oldState.doc);
            const after = topLevelChildren(newState.doc);
            const from = descent(transactions, before, after);
            const ancestor = (j: number): Node | null => (from[j] < 0 ? null : before[from[j]].node);
            const undo = transactions.some(isHistory);
            const present = new Set(before.map(c => c.node));

            const updates = after.map(c => ({ ...c.node.attrs }));
            const changed = after.map(() => false);
            const set = (j: number, key: string, value: unknown) => {
                if (updates[j][key] !== value) {
                    updates[j][key] = value;
                    changed[j] = true;
                }
            };

            /** Whether node `j` still follows what it followed, as the same kind of node. */
            const keepsGap = (j: number): boolean => {
                const old = ancestor(j);
                if (!old || old.type !== after[j].node.type) {
                    return false;
                }
                const oldPrev = from[j] > 0 ? before[from[j] - 1].node : null;
                const prev = j > 0 ? after[j - 1].node : null;
                if (oldPrev === null || prev === null) {
                    // "No predecessor" is an identity too: first stays first.
                    return oldPrev === prev;
                }
                return ancestor(j - 1) === oldPrev && prev.type === oldPrev.type;
            };

            after.forEach((c, j) => {
                const node = c.node;
                const old = ancestor(j);
                if (undo) {
                    if (EDITABLE_TOP_NODES.has(node.type.name) && old && !present.has(node)
                        && node.attrs.src !== null && node.attrs.src === old.attrs.src && !sameBody(node, old)) {
                        set(j, 'src', null);
                    }
                    return;
                }
                if (rewritesSource(node, present)) {
                    set(j, 'src', null);
                }
                if ('gap' in node.attrs && node.attrs.gap !== null && !keepsGap(j)) {
                    set(j, 'gap', null);
                }
            });

            if (!undo) {
                stripDuplicatedIds(after, ancestor, set);
                stripCopiedSuffixes(after, from, set);
                after.forEach((c, j) => {
                    // A quote an edit left ending in another block than a paragraph has no `> {…}` line left;
                    // one whose paragraphs are only empty for now (Enter, text deleted to be retyped) keeps it.
                    if (!present.has(c.node) && c.node.type.name === 'blockquote' && (c.node.attrs.attrsSuffix ?? null) !== null
                        && quoteLostLiteral(c.node)) {
                        set(j, 'attrsSuffix', null);
                        set(j, 'attrsPlacement', null);
                    }
                });
            }

            let tr: Transaction | null = null;
            after.forEach((c, j) => {
                if (changed[j]) {
                    tr = tr ?? newState.tr;
                    tr.setNodeMarkup(c.offset, undefined, updates[j]);
                }
            });
            if (!undo) {
                // Positions inside a top-level node are unchanged by setNodeMarkup on it.
                for (const pos of nestedSuffixes(after, present)) {
                    tr = tr ?? newState.tr;
                    const node = tr.doc.nodeAt(pos) as Node;
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, attrsSuffix: null, attrsPlacement: null });
                }
                for (const pos of strayItemLiterals(transactions, oldState.doc, after, present)) {
                    tr = tr ?? newState.tr;
                    const node = tr.doc.nodeAt(pos) as Node;
                    tr.setNodeMarkup(pos, undefined, { ...node.attrs, literal: null });
                }
            }
            return tr;
        },
    });
}

/**
 * The attribute-literal rule of `fidelityPlugin`, for every block but a heading
 * (whose literal is its anchor, `stripDuplicatedIds`): a top-level block that
 * descends from none loses the literal it carries. Splitting a paragraph copies
 * its attributes into the second half, and `{#id}` written twice is two elements
 * with one id; the half that stands where the paragraph stood keeps it.
 */
function stripCopiedSuffixes(after: TopLevelChild[], from: number[], set: (j: number, key: string, value: unknown) => void): void {
    after.forEach((c, j) => {
        if (from[j] < 0 && c.node.type.name !== 'heading' && (c.node.attrs.attrsSuffix ?? null) !== null) {
            set(j, 'attrsSuffix', null);
            set(j, 'attrsPlacement', null);
        }
    });
}

/**
 * Nested blocks of a changed top-level node that carry an attribute literal,
 * by position. Only a top-level block's literal is written (`serialize.ts`): a
 * paragraph wrapped into a quote or a list would keep drawing a class the file
 * no longer holds, so it loses it — the page shows what will be saved.
 */
function nestedSuffixes(after: TopLevelChild[], present: ReadonlySet<Node>): number[] {
    const out: number[] = [];
    for (const c of after) {
        if (present.has(c.node) || c.node.isTextblock || c.node.isAtom) {
            continue;
        }
        c.node.descendants((node, pos) => {
            if ((node.attrs.attrsSuffix ?? null) !== null && node.type.name !== 'heading') {
                out.push(c.offset + 1 + pos);
            }
            return !node.isTextblock;
        });
    }
    return out;
}

/**
 * List items of a changed top-level node whose literal the file will not hold
 * as it stands, by position: one on an item that descends from no old item —
 * the second half of a split item copies its attributes, and `{#id}` written
 * twice is two elements with one id; the half that starts where the item
 * started keeps it (at the start of its text, the empty first half), as a
 * pasted item does not — and one on an item that no longer starts with a
 * paragraph (`itemTakesLiteral`), where it cannot be written; an empty one
 * keeps it (`- {.a}`), so deleting the text to retype it loses nothing. An item descends from an old one when an old item started
 * at the position its start maps to; setting a literal keeps the item's start.
 */
function strayItemLiterals(transactions: readonly Transaction[], before: Node, after: TopLevelChild[], present: ReadonlySet<Node>): number[] {
    const starts = new Set<number>();
    before.descendants((node, pos) => {
        if (node.type.name === 'list_item') {
            // Where the item starts now. Not asked whether it was deleted: setting
            // its markup replaces its opening token, which maps as a deletion.
            starts.add(transactions.reduce((at, tr) => tr.mapping.map(at, 1), pos));
        }
        return !node.isTextblock;
    });
    const out: number[] = [];
    for (const c of after) {
        if (present.has(c.node) || c.node.isTextblock || c.node.isAtom) {
            continue;
        }
        c.node.descendants((node, pos) => {
            const literal = node.type.name === 'list_item' ? (node.attrs.literal as string | null) : null;
            const at = c.offset + 1 + pos;
            if (literal !== null && (!starts.has(at) || !itemTakesLiteral(node))) {
                out.push(at);
            }
            return !node.isTextblock;
        });
    }
    return out;
}

/** The heading rule of `fidelityPlugin`: a heading that newly carries a duplicated id loses it. */
function stripDuplicatedIds(
    after: TopLevelChild[],
    ancestor: (j: number) => Node | null,
    set: (j: number, key: string, value: unknown) => void,
): void {
    const headings = after
        .map((c, j) => ({ node: c.node, j }))
        .filter(h => h.node.type.name === 'heading');
    for (const h of headings) {
        const duplicated = IDENTITY_ATTRS.some(key => {
            const value = h.node.attrs[key] as unknown;
            return value !== null && headings.some(other => other.j !== h.j && other.node.attrs[key] === value);
        });
        if (!duplicated) {
            continue;
        }
        const old = ancestor(h.j);
        const hadThem = old !== null && old.type === h.node.type
            && STRIPPED_ATTRS.every(key => old.attrs[key] === h.node.attrs[key]);
        if (hadThem) {
            continue;
        }
        for (const key of STRIPPED_ATTRS) {
            set(h.j, key, null);
        }
        // The slice held the id; whatever carried it along is not this node's text.
        set(h.j, 'src', null);
    }
}
