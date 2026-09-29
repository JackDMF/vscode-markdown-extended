import * as vscode from 'vscode';
import type { ParsedDocument } from '../parse';
import { MappedPagePosition, PositionMap, createPositionMap } from '../positions';

/**
 * The host's side of the position mapping, for what the host will build on it
 * next — completion, diagnostics and hover in the page.
 *
 * The mapping itself is `../positions.ts`, the module the page reports its
 * caret with; this file only turns its answers into `vscode.Position`s and
 * keeps the map of the one text it was last asked about. The map is built on
 * the host's parse of the text the page holds (`VisualEditorSession.toSource`
 * and `toPage` refuse while the document holds another), whose nodes are the
 * page's wherever its serialization reads back as itself — which is the
 * serializer's promise (`serialize.ts`). Until a re-sync, a page edit that did
 * not read back so (a construct the next parse restructures) could hold its
 * positions elsewhere; the page's own answers, from its own document, cannot.
 */
export class HostPositions {
    private cached: { text: string; map: Promise<PositionMap> } | undefined;

    /** `parse` parses a text of this document the way the session does; `defaultWrap` is the file's wrap setting. */
    constructor(
        private readonly parse: (text: string) => Promise<ParsedDocument>,
        private readonly defaultWrap: () => number,
    ) { }

    /** The map for `text`, parsed once per text. */
    mapFor(text: string): Promise<PositionMap> {
        if (this.cached?.text !== text) {
            const map = this.parse(text).then(parsed => createPositionMap(parsed, { defaultWrap: this.defaultWrap() }));
            this.cached = { text, map };
            // A failed parse is not kept: the next question tries again.
            map.catch(() => {
                if (this.cached?.map === map) {
                    this.cached = undefined;
                }
            });
        }
        return this.cached.map;
    }

    forget(): void {
        this.cached = undefined;
    }
}

/** A page position in `map`'s text as a `vscode.Position`, and whether it is only the nearest one. */
export function toSource(map: PositionMap, pos: number): { position: vscode.Position; approximate: boolean } | undefined {
    const mapped = map.sourcePositionOf(pos);
    return mapped === null ? undefined : { position: new vscode.Position(mapped.line, mapped.character), approximate: mapped.approximate };
}

/** The page position a `vscode.Position` of `map`'s text stands at, or the nearest one. */
export function toPage(map: PositionMap, position: vscode.Position): MappedPagePosition | undefined {
    return map.pagePositionOf({ line: position.line, character: position.character }) ?? undefined;
}
