import { Mark, Node } from 'prosemirror-model';

/**
 * Whether a node inside a top-level block is the same: type, marks, text and
 * children, at every depth — attributes aside, except a leaf's. A nested
 * paragraph's or list's attributes (`lineWidth`, `tight`, `src`) are facts
 * about its source that the page does not keep up to date as a person types,
 * and only the host's parse sets them again; a leaf's (an image's address, a
 * wiki embed's source, a footnote reference's label) are what it holds.
 */
function sameInside(a: Node, b: Node): boolean {
    if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) {
        return false;
    }
    if (a.isText) {
        return a.text === b.text;
    }
    if (a.isLeaf) {
        return a.sameMarkup(b);
    }
    return sameChildren(a, b);
}

function sameChildren(a: Node, b: Node): boolean {
    if (a.childCount !== b.childCount) {
        return false;
    }
    for (let i = 0; i < a.childCount; i++) {
        if (!sameInside(a.child(i), b.child(i))) {
            return false;
        }
    }
    return true;
}

/**
 * Whether top-level block `a` is `b` as the page's re-sync reads it: the same
 * type, marks, text and structure, attributes aside at every depth (a leaf's
 * inside it excepted, `sameInside`). A source block — a top-level leaf — is
 * the same only with the same `src` where both have one: its source is what
 * it holds, and two raw blocks the parse divided otherwise (a comment the next
 * one closes) hold other text.
 */
export function sameContent(a: Node, b: Node): boolean {
    if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) {
        return false;
    }
    if (a.isLeaf) {
        const x: unknown = a.attrs.src;
        const y: unknown = b.attrs.src;
        return !(typeof x === 'string' && typeof y === 'string' && x !== y);
    }
    return sameChildren(a, b);
}

/**
 * How many top-level children `old` and `next` share at the start (`head`)
 * and at the end (`tail`), the same as `sameContent` reads them: what the
 * page's re-sync from `old` to `next` keeps in place, every node in them given
 * `next`'s attributes (`webview/resync.ts`) — the run between is replaced. `head + tail` never exceeds either document's count.
 * Without `vscode` or the page, so the host can tell in advance what a re-sync
 * will replace (`host/insertCheck.ts`).
 */
export function sharedEnds(old: Node, next: Node): { head: number; tail: number } {
    const oldCount = old.childCount;
    const newCount = next.childCount;
    let head = 0;
    while (head < oldCount && head < newCount && sameContent(old.child(head), next.child(head))) {
        head++;
    }
    let tail = 0;
    while (tail < oldCount - head && tail < newCount - head
        && sameContent(old.child(oldCount - 1 - tail), next.child(newCount - 1 - tail))) {
        tail++;
    }
    return { head, tail };
}
