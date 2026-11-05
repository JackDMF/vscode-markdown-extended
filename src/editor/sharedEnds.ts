import { Mark, Node } from 'prosemirror-model';

/** Same type, marks and content — the node may still differ in its attributes. */
export function sameContent(a: Node, b: Node): boolean {
    return a.type === b.type && Mark.sameSet(a.marks, b.marks) && a.content.eq(b.content);
}

/**
 * How many top-level children `old` and `next` share at the start (`head`)
 * and at the end (`tail`), content alike, attributes aside: what the page's
 * re-sync from `old` to `next` keeps in place (`webview/resync.ts`) — the run
 * between is replaced. `head + tail` never exceeds either document's count.
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
