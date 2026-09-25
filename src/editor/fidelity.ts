import { Mark, Node } from 'prosemirror-model';
import { Plugin, PluginKey, Transaction } from 'prosemirror-state';
import { EDITABLE_TOP_NODES } from './schema';

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

interface Child {
    node: Node;
    offset: number;
}

function children(doc: Node): Child[] {
    const out: Child[] = [];
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
function descent(transactions: readonly Transaction[], before: Child[], after: Child[]): number[] {
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
            const before = children(oldState.doc);
            const after = children(newState.doc);
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
                if (EDITABLE_TOP_NODES.has(node.type.name) && !present.has(node)) {
                    set(j, 'src', null);
                }
                if ('gap' in node.attrs && node.attrs.gap !== null && !keepsGap(j)) {
                    set(j, 'gap', null);
                }
            });

            if (!undo) {
                stripDuplicatedIds(after, ancestor, set);
                stripCopiedSuffixes(after, from, set);
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
function stripCopiedSuffixes(after: Child[], from: number[], set: (j: number, key: string, value: unknown) => void): void {
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
function nestedSuffixes(after: Child[], present: ReadonlySet<Node>): number[] {
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

/** The heading rule of `fidelityPlugin`: a heading that newly carries a duplicated id loses it. */
function stripDuplicatedIds(
    after: Child[],
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
