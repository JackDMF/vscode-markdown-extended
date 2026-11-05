import { Node } from 'prosemirror-model';
import { Environment, MarkdownIt } from '../../@types/markdown-it';
import { InlineEngineDefinition, definitionOf } from '../inlineEngine';
import { ParsedDocument, parseDocument } from '../parse';
import type { InsertedBlocks } from '../protocol';
import { editorSchema } from '../schema';
import { insertionStandsAlone } from '../sharedEnds';

export { insertionStandsAlone };

/** What the host writes for an edit that carries inserted blocks: `text`, or why not and what instead. */
export interface InsertionVerdict {
    /** The text to write: the edit's, or the edit's without the insertion; `undefined`: nothing. */
    text: string | undefined;
    /** Why the blocks are not written: `not-separate` (they do not stand alone), `error-state` (cannot be told). */
    refused?: 'not-separate' | 'error-state';
    /** The parse of the edit's text, when that is the text to write: the host need not parse it again to post it. */
    parsed?: ParsedDocument;
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
    let parsed: ParsedDocument;
    let alone: boolean;
    try {
        parsed = parseDocument(md, text, env, definition);
        alone = insertionStandsAlone(Node.fromJSON(editorSchema, insert.page), insert.index, parsed.doc);
    } catch {
        return { text: without, refused: 'error-state' };
    }
    return alone ? { text, parsed } : { text: without, refused: 'not-separate' };
}
