import { Attrs, Mark, Node, Slice } from 'prosemirror-model';
import { Plugin, PluginKey, Transaction } from 'prosemirror-state';
import { Transform } from 'prosemirror-transform';
import { withoutId } from './attrs';
import { EDITABLE_TOP_NODES } from './schema';
import { itemTakesLiteral, literalHolder, literalsReadBack, quoteLostLiteral } from './serialize';

export const fidelityPluginKey = new PluginKey('mepFidelity');

/**
 * Set this meta on a transaction (`tr.setMeta(PRESERVE_SOURCE_META, true)`) to
 * keep every `src` and `gap` it would otherwise clear — for a transaction that
 * restores content rather than changing it, such as re-syncing from the text
 * document. Its attributes are the host's parse and are right by construction.
 */
export const PRESERVE_SOURCE_META = 'mepPreserveSource';

/**
 * The meta on a repair the editor's own plugins append to a transaction — this
 * plugin's `src`, `gap` and literal clears, the tables' normalisation,
 * `prosemirror-tables`' fixing of a table — which no content filter refuses
 * (`isRepair`; `refusableRange` in `webview/notes.ts`, read by the notes' and
 * the tables' filters). Such a transaction rewrites no text: the transaction it
 * follows was checked against the document this plugin's repair makes of it
 * (`fidelityPlan`, read by the check through `writtenEdit`), and refusing the
 * repair would leave that edit applied with attributes that no longer describe
 * it — a cleared `src` dropped writes the edited block's old text, beside its
 * new one.
 */
const REPAIR_META = 'mepRepair';

/** Marks `tr` as a repair a plugin appends (`REPAIR_META`). */
export function asRepair(tr: Transaction): Transaction {
    return tr.setMeta(REPAIR_META, true);
}

/** Whether `tr` is a repair a plugin appended (`REPAIR_META`). */
export function isRepair(tr: Transaction): boolean {
    return tr.getMeta(REPAIR_META) === true;
}

/** prosemirror-history's plugin key, as it names its meta; undo and redo carry it. */
const HISTORY_META = 'history$';

/**
 * The heading attributes that name something and must not be written twice: the
 * requirement id and the anchor. `attrsSuffix` is not compared — a class-only
 * suffix (`{.unnumbered}`) may legitimately repeat, and one that carries an id
 * has it in `anchor` — but the id in it is cleared with them, since it is where
 * the anchor is written.
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

/**
 * Where `transactions` take a position of the document they started from: the
 * position the content after it now starts at (`assoc` 1). For the start of an
 * old block that is where the block itself now starts, also when something was
 * inserted right before it — the insertion point is the inserted content's.
 */
function mapForward(transactions: readonly Transaction[], pos: number): number {
    return transactions.reduce((at, tr) => tr.mapping.map(at, 1), pos);
}

/**
 * How many top-level children `transactions` left as they were, from the start
 * (`head`) and, after those, from the end (`tail`): the same object at the same
 * index, starting where its old start maps to (`mapForward`) — the children no
 * step of an edit rebuilt, around the ones it did. The identity alone is not
 * enough: a drag-copy of a whole block carries the same object, and a copy
 * dropped directly before its original stands at the original's old index,
 * where the original's start does not map to (a copy directly after its
 * original, at the index from the end, alike). A pointer comparison and a
 * mapped position per child.
 */
function unchangedEnds(transactions: readonly Transaction[], before: Node, after: Node): { head: number; tail: number } {
    const most = Math.min(before.childCount, after.childCount);
    let head = 0;
    let offset = 0;
    while (head < most && before.child(head) === after.child(head) && mapForward(transactions, offset) === offset) {
        offset += before.child(head).nodeSize;
        head++;
    }
    let tail = 0;
    let oldEnd = before.content.size;
    let newEnd = after.content.size;
    while (head + tail < most) {
        const node = before.child(before.childCount - 1 - tail);
        if (node !== after.child(after.childCount - 1 - tail) || mapForward(transactions, oldEnd - node.nodeSize) !== newEnd - node.nodeSize) {
            break;
        }
        oldEnd -= node.nodeSize;
        newEnd -= node.nodeSize;
        tail++;
    }
    return { head, tail };
}

/**
 * For every top-level child of `after`, the index of the top-level child of
 * `before` it descends from, or `-1` for a node that descends from none (one a
 * split, a paste or the UI created).
 *
 * Identity first: ProseMirror never mutates a node, so a child that is the same
 * object as an old one *is* that one, wherever it now stands — which is what
 * makes a move a move. The children before the first one an edit changed and
 * after the last (`unchangedEnds`) are the ones they were; among the others,
 * where one old child stands more than once (a drag-copy of a whole block
 * carries the same object), the occurrence that starts where the old child's
 * start maps to (`mapForward`: past content inserted right before it, which is
 * the copy's place) is that child, and every other occurrence — one of those,
 * or one of a child that stands unchanged — is a copy that descends from none:
 * a copy dropped before its original, directly before it included, is the
 * copy, and the original keeps its id.
 * A child that is a new object descends from the old child
 * whose start the transactions map onto its start: typing into a node, setting
 * its markup or changing its type keep its start where it was, while the second
 * half of a split starts at a position no old start maps to. Where two old
 * starts land on one position (a node deleted, and its follower now starting
 * there), the one that was not deleted wins. A last pass maps with the other
 * bias, for content inserted exactly at an old start that took that node's
 * place (typing `- ` wraps a paragraph in a list that starts where it did).
 */
export function descent(transactions: readonly Transaction[], before: Node, after: Node): number[] {
    const { head, tail } = unchangedEnds(transactions, before, after);
    const shift = before.childCount - after.childCount;
    const result = Array.from({ length: after.childCount }, (_c, j) => (j < head ? j : j >= after.childCount - tail ? j + shift : -1));
    const inner = changedDescent(transactions, childrenBetween(before, head, before.childCount - tail), childrenBetween(after, head, after.childCount - tail));
    inner.forEach((i, k) => {
        result[head + k] = i < 0 ? -1 : head + i;
    });
    return result;
}

/** `descent` among the children an edit changed, `before` and `after` holding only those: indices into them. */
function changedDescent(transactions: readonly Transaction[], before: readonly TopLevelChild[], after: readonly TopLevelChild[]): number[] {
    const result = after.map(() => -1);
    const claimed = new Set<number>();

    const byIdentity = new Map<Node, number[]>();
    before.forEach((c, i) => {
        const list = byIdentity.get(c.node) ?? [];
        list.push(i);
        byIdentity.set(c.node, list);
    });
    const occurrences = new Map<Node, number[]>();
    after.forEach((c, j) => {
        if (byIdentity.has(c.node)) {
            const list = occurrences.get(c.node) ?? [];
            list.push(j);
            occurrences.set(c.node, list);
        }
    });
    occurrences.forEach((js, node) => {
        const olds = byIdentity.get(node) as number[];
        const free = [...js];
        if (free.length > 1) {
            for (const i of olds) {
                // Only where its content now starts: the other bias is the insertion point, where a copy dropped directly before it stands.
                const start = mapForward(transactions, before[i].offset);
                const k = free.findIndex(j => after[j].offset === start);
                if (k >= 0) {
                    result[free[k]] = i;
                    claimed.add(i);
                    free.splice(k, 1);
                }
            }
        }
        for (const i of olds) {
            if (!claimed.has(i) && free.length > 0) {
                result[free.shift() as number] = i;
                claimed.add(i);
            }
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

/** The top-level children of `doc` from index `from` up to `to`, with their offsets. */
function childrenBetween(doc: Node, from: number, to: number): TopLevelChild[] {
    let offset = 0;
    for (let i = 0; i < from; i++) {
        offset += doc.child(i).nodeSize;
    }
    const out: TopLevelChild[] = [];
    for (let i = from; i < to; i++) {
        const node = doc.child(i);
        out.push({ node, offset });
        offset += node.nodeSize;
    }
    return out;
}

/**
 * A top-level child of an edited document that the save writes by rule
 * (`FidelityPlan.rewritten`), and, for a copy of a whole block the starting
 * document holds (a drag-copy carries the same node object), the offset of
 * that block in the starting document (`copyOf`): the copy's textblocks were
 * read as that block's were.
 */
export interface RewrittenBlock extends TopLevelChild {
    copyOf: number | null;
}

/**
 * What `fidelityPlugin` changes for a transaction (`fidelityPlan`): the
 * attributes it sets, by the position of the node in the new document — every
 * `src` and `gap` it clears, a heading's duplicated ids, a copied block's
 * literal, a nested block's, a list item's — and the top-level children whose
 * `src` it clears by rule, cleared already or not, which the save then writes
 * by rule (`rewritten`): every textblock in them is written again, the ones the
 * edit did not touch included — a list item beside the one typed in, the other
 * cells of a table. A block the plan keeps is not among them, wherever it now
 * stands: a move is written from its `src` as it was read.
 */
export interface FidelityPlan {
    readonly updates: ReadonlyMap<number, Attrs>;
    readonly rewritten: readonly RewrittenBlock[];
}

const NO_PLAN: FidelityPlan = { updates: new Map(), rewritten: [] };

/** The plan made for a single transaction, with what it was made of: the plugin applies the plan the check read. */
const plans = new WeakMap<Transaction, { after: Node; preserving: boolean; undo: boolean; plan: FidelityPlan }>();

/**
 * What `fidelityPlugin` changes for `transactions`, which took `before` to
 * `after` (`FidelityPlan`) — the one computation of it, with two readers: the
 * plugin applies it (`applyFidelityPlan`), and the check of an edit reads the
 * document it makes and the blocks it rewrites (`writtenEdit`). For a single
 * transaction the plan is remembered, so the repair the plugin appends to it
 * is the very plan the transaction was checked against.
 */
export function fidelityPlan(transactions: readonly Transaction[], before: Node, after: Node): FidelityPlan {
    const single = transactions.length === 1 && transactions[0].before === before ? transactions[0] : null;
    const preserving = transactions.some(isPreserving);
    const undo = transactions.some(isHistory);
    const known = single ? plans.get(single) : undefined;
    if (known && known.after === after && known.preserving === preserving && known.undo === undo) {
        return known.plan;
    }
    const plan = planFor(transactions, before, after);
    if (single) {
        plans.set(single, { after, preserving, undo, plan });
    }
    return plan;
}

/** `tr` with the attributes of `plan` set; positions are unchanged by it, so they hold in any order. */
export function applyFidelityPlan<T extends Transform>(tr: T, plan: FidelityPlan): T {
    plan.updates.forEach((attrs, pos) => {
        tr.setNodeMarkup(pos, undefined, attrs);
    });
    return tr;
}

/**
 * The document the save writes once `tr` is applied with the repair
 * `fidelityPlugin` appends to it, and the top-level blocks of it the save
 * writes by rule (`fidelityPlan`) — what the check of an edit reads
 * (`noteRefusal` in `webview/notes.ts`), so that it checks exactly the
 * document the plugin then makes: a copy whose id or literal the plan strips
 * is checked as it will be written, without them.
 */
export function writtenEdit(tr: Transaction): { doc: Node; rewritten: RewrittenBlock[] } {
    const plan = fidelityPlan([tr], tr.before, tr.doc);
    const doc = plan.updates.size === 0 ? tr.doc : applyFidelityPlan(new Transform(tr.doc), plan).doc;
    return { doc, rewritten: plan.rewritten.map(block => ({ ...block, node: doc.nodeAt(block.offset) as Node })) };
}

/**
 * `fidelityPlan`, made. Only the top-level children an edit changed are
 * judged (`unchangedEnds`), and the one after them, whose predecessor may
 * have: every other child is the same object, following the same one, and no
 * rule changes it — so the plan costs what the edit touched, not what the
 * document holds, and the check of an edit can ask for it on every keystroke.
 */
function planFor(transactions: readonly Transaction[], oldDoc: Node, newDoc: Node): FidelityPlan {
    if (!transactions.some(tr => tr.docChanged) || transactions.some(isPreserving)) {
        return NO_PLAN;
    }
    const { head, tail } = unchangedEnds(transactions, oldDoc, newDoc);
    // The changed children, and an unchanged one on either side: the one before is what the first of
    // them follows, the one after is judged too. `before`, `after` and `from` index into these alone.
    const lo = Math.max(0, head - 1);
    const before = childrenBetween(oldDoc, lo, Math.min(oldDoc.childCount, oldDoc.childCount - tail + 1));
    const after = childrenBetween(newDoc, lo, Math.min(newDoc.childCount, newDoc.childCount - tail + 1));
    const first = head - lo;
    const end = after.length;
    const oldEnd = oldDoc.childCount - tail - lo;
    const newEnd = newDoc.childCount - tail - lo;
    const inner = changedDescent(transactions, before.slice(first, oldEnd), after.slice(first, newEnd));
    const from = after.map((_c, j) => {
        if (j < first || j >= newEnd) {
            return j < first ? j : j - newEnd + oldEnd;
        }
        return inner[j - first] < 0 ? -1 : first + inner[j - first];
    });
    const ancestor = (j: number): Node | null => (from[j] < 0 ? null : before[from[j]].node);
    const undo = transactions.some(isHistory);
    // Whether a node is a top-level child of the starting document: one of the changed ones or their
    // neighbours, or one a step's slice carries (a drag-copy's carries the whole block), asked of a map
    // of them all, built when first needed. Any other node a step left at the top level is one it rebuilt;
    // were one taken for rebuilt that is not, it would be written by rule, and checked so — never kept unchecked.
    const changedBefore = new Set(before.map(c => c.node));
    const carried = new Set<Node>();
    for (const tr of transactions) {
        for (const step of tr.steps) {
            (step as unknown as { slice?: Slice }).slice?.content.forEach(node => {
                carried.add(node);
            });
        }
    }
    let offsets: Map<Node, number> | null = null;
    const offsetOf = (node: Node): number | undefined => {
        if (offsets === null) {
            const made = new Map<Node, number>();
            oldDoc.forEach((child, offset) => {
                if (!made.has(child)) {
                    made.set(child, offset);
                }
            });
            offsets = made;
        }
        return offsets.get(node);
    };
    const present = (node: Node): boolean => changedBefore.has(node) || (carried.has(node) && offsetOf(node) !== undefined);

    const updates = new Map<number, Record<string, unknown>>();
    const rewrites = new Set<number>();
    const set = (j: number, key: string, value: unknown) => {
        if (key === 'src' && value === null) {
            rewrites.add(j);
        }
        const attrs = updates.get(j) ?? after[j].node.attrs;
        if (attrs[key] !== value) {
            updates.set(j, { ...attrs, [key]: value });
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

    for (let j = first; j < end; j++) {
        const node = after[j].node;
        const old = ancestor(j);
        if (undo) {
            if (EDITABLE_TOP_NODES.has(node.type.name) && old && !present(node)
                && node.attrs.src !== null && node.attrs.src === old.attrs.src && !sameBody(node, old)) {
                set(j, 'src', null);
            }
            continue;
        }
        // An editable node that is none of the starting document's top-level children is new or edited.
        if (EDITABLE_TOP_NODES.has(node.type.name) && !present(node)) {
            set(j, 'src', null);
        }
        if ('gap' in node.attrs && node.attrs.gap !== null && !keepsGap(j)) {
            set(j, 'gap', null);
        }
    }

    // The literals of the list items in the changed children, by position: an edited or new block's
    // (`itemLiterals`), and a copy's, whose items lose only their ids — and the copy its `src`,
    // which writes them, when one does.
    const items = new Map<number, string | null>();
    // The changed children that are edited or new: their nested blocks are judged too.
    const fresh: TopLevelChild[] = [];
    if (!undo) {
        stripDuplicatedIds(newDoc, after, lo, first, end, ancestor, set);
        stripCopiedSuffixes(after, first, end, from, set);
        const literals = itemLiterals(transactions, oldDoc);
        for (let j = first; j < end; j++) {
            const c = after[j];
            if (!present(c.node)) {
                fresh.push(c);
                literals(c, false, items);
            } else if (from[j] < 0 && literals(c, true, items) && EDITABLE_TOP_NODES.has(c.node.type.name)) {
                set(j, 'src', null);
            }
        }
        for (let j = first; j < end; j++) {
            const node = after[j].node;
            // A quote an edit left ending in another block than a paragraph has no `> {…}` line left;
            // one whose paragraphs are only empty for now (Enter, text deleted to be retyped) keeps it.
            if (node.type.name === 'blockquote' && (node.attrs.attrsSuffix ?? null) !== null && !present(node)
                && quoteLostLiteral(node)) {
                set(j, 'attrsSuffix', null);
                set(j, 'attrsPlacement', null);
            }
        }
    }

    const plan = new Map<number, Attrs>();
    updates.forEach((attrs, j) => {
        plan.set(after[j].offset, attrs);
    });
    if (!undo) {
        // Setting a top-level node's markup leaves its nested nodes' attributes as they are.
        const nested = (pos: number, patch: Attrs) => {
            plan.set(pos, { ...(plan.get(pos) ?? (newDoc.nodeAt(pos) as Node).attrs), ...patch });
        };
        for (const pos of nestedSuffixes(fresh)) {
            nested(pos, { attrsSuffix: null, attrsPlacement: null });
        }
        items.forEach((literal, pos) => {
            nested(pos, { literal });
        });
    }
    const rewritten: RewrittenBlock[] = [];
    for (const j of [...rewrites].sort((a, b) => a - b)) {
        const c = after[j];
        if (EDITABLE_TOP_NODES.has(c.node.type.name)) {
            rewritten.push({ ...c, copyOf: from[j] < 0 && present(c.node) ? offsetOf(c.node) ?? null : null });
        }
    }
    return { updates: plan, rewritten };
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
 * so the serializer can go on trusting them. What it changes is decided by
 * `fidelityPlan`, which the check of an edit reads too (`writtenEdit`); the
 * plugin only applies it.
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
 * **Attribute literals** (`attrsSuffix`, a list item's `literal`) are a block's
 * own, and an id in one names a single element: the second half of a split
 * paragraph or item does not carry `{#id}` again, nor does a copy of a whole
 * block or a pasted one, nor any item in it (the block is then written by
 * rule). A class, and any other attribute, is kept: a copy of
 * `A wide one. {.wide #w}` is `A wide one. {.wide}`, one of `Classed. {.c}` is
 * the same text again. A block wrapped inside another loses the literal only a
 * top-level block writes (`stripCopiedSuffixes`, `itemLiterals`,
 * `nestedSuffixes`).
 *
 * **Requirement ids** must not be written twice. A top-level heading that did
 * not carry its `reqPrefix`, `anchor` and `attrsSuffix` before this transaction
 * (a split, a paste, a copy) loses its `reqPrefix` and `anchor`, the id in its
 * `attrsSuffix` (a class stays) and its `src`, when another top-level heading carries the
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
            const plan = fidelityPlan(transactions, oldState.doc, newState.doc);
            return plan.updates.size === 0 ? null : asRepair(applyFidelityPlan(newState.tr, plan));
        },
    });
}

/**
 * The literal `kept` of a copy of `node` (`withoutId`), as long as the copy
 * still reads back with it once written whole (`literalsReadBack`): the form
 * written without the id is read with the block's text, which the literal
 * alone does not say. `null` otherwise, the copy losing it.
 */
function copiedLiteral(node: Node, kept: string | null): string | null {
    if (kept === null || kept === node.attrs.attrsSuffix) {
        return kept;
    }
    return literalsReadBack(node.type.create({ ...node.attrs, attrsSuffix: kept }, node.content, node.marks)) ? kept : null;
}

/**
 * The attribute-literal rule of `fidelityPlugin`, for every block but a heading
 * (whose literal holds its anchor, `stripDuplicatedIds`): a top-level block
 * that descends from none loses the id its literal gives (`withoutId`), and
 * keeps the rest — or loses the whole literal when the rest cannot be written
 * so that the preview reads it back. Splitting a paragraph copies its attributes into the second
 * half, and `{#id}` written twice is two elements with one id; the half that
 * stands where the paragraph stood keeps it. A copy of a whole block (a
 * drag-copy carries the same node, whose `src` holds the literal) loses it as
 * well, and its `src` with it, as a heading's copy does its duplicated id: page
 * and save then agree that the copy has no id. A literal without an id is left
 * as it is, and so is a copy's `src`. Asked of the changed children
 * (`first`–`end`); every other one descends from itself.
 */
function stripCopiedSuffixes(after: TopLevelChild[], first: number, end: number, from: number[], set: (j: number, key: string, value: unknown) => void): void {
    for (let j = first; j < end; j++) {
        const node = after[j].node;
        const literal = (node.attrs.attrsSuffix ?? null) as string | null;
        const kept = literal === null ? null : copiedLiteral(node, withoutId(literal, literalHolder(node)));
        if (from[j] < 0 && node.type.name !== 'heading' && kept !== literal) {
            set(j, 'attrsSuffix', kept);
            if (kept === null) {
                set(j, 'attrsPlacement', null);
            }
            if (EDITABLE_TOP_NODES.has(node.type.name)) {
                set(j, 'src', null);
            }
        }
    }
}

/**
 * Nested blocks of a changed top-level node that carry an attribute literal,
 * by position. Only a top-level block's literal is written (`serialize.ts`): a
 * paragraph wrapped into a quote or a list would keep drawing a class the file
 * no longer holds, so it loses it — the page shows what will be saved.
 */
function nestedSuffixes(changed: readonly TopLevelChild[]): number[] {
    const out: number[] = [];
    for (const c of changed) {
        if (c.node.isTextblock || c.node.isAtom) {
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
 * The list items of a changed top-level node whose literal the file will not
 * hold as it stands, added to `out` by position with the literal they keep;
 * whether there was one. In an edited or new node (`copy` false): an item that
 * descends from no old item keeps its literal without the id (`withoutId`) —
 * the second half of a split item copies its attributes, and `{#id}` written
 * twice is two elements with one id; the half that starts where the item
 * started keeps it whole (at the start of its text, the empty first half), as
 * a pasted item does not — and one on an item that no longer starts with a
 * paragraph (`itemTakesLiteral`) loses it, since it cannot be written there;
 * an empty one keeps it (`- {.a}`), so deleting the text to retype it loses
 * nothing. An item descends from an old one when an old item started at the
 * position its start maps to; setting a literal keeps the item's start. In a
 * copy of a whole block (`copy` true) every item is a copy and keeps its
 * literal without the id, whatever the block's own literal: the rule of the
 * block's literal (`stripCopiedSuffixes`), for its items.
 */
function itemLiterals(transactions: readonly Transaction[], before: Node): (c: TopLevelChild, copy: boolean, out: Map<number, string | null>) => boolean {
    // Made when the first item with a literal is met: most edits are in no such list.
    let starts: Set<number> | null = null;
    const itemStarts = (): Set<number> => {
        if (starts === null) {
            const found = new Set<number>();
            before.descendants((node, pos) => {
                if (node.type.name === 'list_item') {
                    // Where the item starts now. Not asked whether it was deleted: setting
                    // its markup replaces its opening token, which maps as a deletion.
                    found.add(mapForward(transactions, pos));
                }
                return !node.isTextblock;
            });
            starts = found;
        }
        return starts;
    };
    return (c, copy, out) => {
        let found = false;
        if (c.node.isTextblock || c.node.isAtom) {
            return found;
        }
        c.node.descendants((node, pos) => {
            const literal = node.type.name === 'list_item' ? (node.attrs.literal as string | null) : null;
            const at = c.offset + 1 + pos;
            if (literal !== null) {
                const kept = !copy && !itemTakesLiteral(node) ? null : copy || !itemStarts().has(at) ? withoutId(literal, 'list_item') : literal;
                if (kept !== literal) {
                    out.set(at, kept);
                    found = true;
                }
            }
            return !node.isTextblock;
        });
        return found;
    };
}

/**
 * The heading rule of `fidelityPlugin`: a heading among the changed children
 * (`first`–`end` of `after`, which starts at index `lo` of `doc`) that newly
 * carries a duplicated id loses it — its requirement id, its anchor and the id
 * its literal gives, the rest of the literal kept. One outside them is the
 * heading it was and had its ids before.
 */
function stripDuplicatedIds(
    doc: Node,
    after: TopLevelChild[],
    lo: number,
    first: number,
    end: number,
    ancestor: (j: number) => Node | null,
    set: (j: number, key: string, value: unknown) => void,
): void {
    // Every heading of the document, by index, gathered when a changed one carries an id.
    let headings: { node: Node; index: number }[] | null = null;
    const allHeadings = (): { node: Node; index: number }[] => {
        if (headings === null) {
            const found: { node: Node; index: number }[] = [];
            doc.forEach((node, _offset, index) => {
                if (node.type.name === 'heading') {
                    found.push({ node, index });
                }
            });
            headings = found;
        }
        return headings;
    };
    for (let j = first; j < end; j++) {
        const node = after[j].node;
        if (node.type.name !== 'heading' || IDENTITY_ATTRS.every(key => node.attrs[key] === null)) {
            continue;
        }
        const old = ancestor(j);
        const hadThem = old !== null && old.type === node.type
            && STRIPPED_ATTRS.every(key => old.attrs[key] === node.attrs[key]);
        if (hadThem) {
            continue;
        }
        const duplicated = IDENTITY_ATTRS.some(key => {
            const value = node.attrs[key] as unknown;
            return value !== null && allHeadings().some(other => other.index !== lo + j && other.node.attrs[key] === value);
        });
        if (!duplicated) {
            continue;
        }
        for (const key of IDENTITY_ATTRS) {
            set(j, key, null);
        }
        // The literal writes the anchor; what else it gives (`{.unnumbered}`) a copy keeps.
        const literal = (node.attrs.attrsSuffix ?? null) as string | null;
        set(j, 'attrsSuffix', literal === null ? null : copiedLiteral(node, withoutId(literal, 'heading')));
        // The slice held the id; whatever carried it along is not this node's text.
        set(j, 'src', null);
    }
}
