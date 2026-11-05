import { Node } from 'prosemirror-model';
import { Environment, MarkdownIt } from '../../@types/markdown-it';
import { InlineEngineDefinition, definitionOf } from '../inlineEngine';
import { parseDocument } from '../parse';
import type { InsertedBlocks } from '../protocol';
import { editorSchema } from '../schema';
import { sharedEnds } from '../sharedEnds';

/**
 * Whether the page's re-sync from `page` — its document with another
 * extension's blocks inserted as the source block at `index` — to `parsed`,
 * the host's parse of its text, replaces that source block and nothing else:
 * then undo takes out exactly the parsed blocks, as `insertBlock` promises
 * (ARCHITECTURE.md, "Undo after the parse"). Also when the source block stays
 * in place, read as one of its kind (a raw block of HTML), and all else is
 * kept. Not when the parse read the blocks into a construct left open before
 * them (a code fence, an HTML comment), read what follows into one they leave
 * open, or anything else outside them changed: the re-sync would replace a
 * wider run, and the insertion's history step would no longer reach it.
 */
export function insertionStandsAlone(page: Node, index: number, parsed: Node): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= page.childCount) {
        return false;
    }
    const { head, tail } = sharedEnds(page, parsed);
    // The page's children [head, end) are replaced by `added` of the parse's.
    const end = page.childCount - tail;
    const added = parsed.childCount - head - tail;
    if (head === end) {
        return added === 0;
    }
    return head === index && end === index + 1 && added > 0;
}

/** What the host writes for an edit that carries inserted blocks: `text`, or why not and what instead. */
export interface InsertionVerdict {
    /** The text to write: the edit's, or the edit's without the insertion; `undefined`: nothing. */
    text: string | undefined;
    /** Why the blocks are not written: `not-separate` (they do not stand alone), `error-state` (cannot be told). */
    refused?: 'not-separate' | 'error-state';
}

/**
 * The host's word on an edit carrying blocks another extension inserted
 * (`insertBlock`), before it writes anything: the edit's `text` when its
 * parse leaves the blocks standing alone (`insertionStandsAlone`), else the
 * same text without them (`insert.without`) — typing and box commits that
 * went in the same edit are kept — and `not-separate`. Neither the page's
 * document nor the text can be read, or `without` changes nothing: nothing
 * written, `error-state`. Without `vscode`: the session and the page tests
 * ask the same.
 */
export function judgeInsertion(md: MarkdownIt, text: string, insert: InsertedBlocks, env: Environment = {}, definition: InlineEngineDefinition = definitionOf(md)): InsertionVerdict {
    const { start, end, text: replacement } = insert.without;
    const valid = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= text.length;
    const without = valid ? text.slice(0, start) + replacement + text.slice(end) : text;
    if (without === text) {
        return { text: undefined, refused: 'error-state' };
    }
    let alone: boolean;
    try {
        alone = insertionStandsAlone(Node.fromJSON(editorSchema, insert.page), insert.index, parseDocument(md, text, env, definition).doc);
    } catch {
        return { text: without, refused: 'error-state' };
    }
    return alone ? { text } : { text: without, refused: 'not-separate' };
}
