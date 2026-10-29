import * as assert from 'assert';
import { MarkdownIt, Token } from '../../../src/@types/markdown-it';
import { FOOTNOTES_IN_PLACE, footnoteMeta, inPlaceEnv } from '../../../src/editor/footnoteEngine';
import { DEFAULT_INLINE_ENGINE, createInlineEngine } from '../../../src/editor/inlineEngine';
import { hostEngine } from './helpers';

/** Each top-level footnote definition the parse kept: its label and the lines it stands for. */
function definitions(tokens: readonly Token[]): { label: string; open: number[] | null; close: number[] | null }[] {
    const out: { label: string; open: number[] | null; close: number[] | null }[] = [];
    for (const [i, t] of tokens.entries()) {
        if (t.type === 'footnote_reference_open' && t.level === 0) {
            const close = tokens.slice(i).find(c => c.type === 'footnote_reference_close' && c.level === 0);
            out.push({ label: (t.meta as { label: string }).label, open: t.map, close: close?.map ?? null });
        }
    }
    return out;
}

/** The top-level tokens' types and maps, as a grouping reads them. */
function topLevel(tokens: readonly Token[]): string[] {
    return tokens.filter(t => t.level === 0 && t.nesting >= 0).map(t => `${t.type} ${t.map?.join('-') ?? '·'}`);
}

/** The archive's shapes (CA-btk22): a `␣␣` hard break, then a 2-space or an unindented (lazy) line. */
const ENTRIES = [
    'Gott hat die Welt[^Welt] so geliebt, der Sklave[^Sklave] auch.',
    '',
    '[^Welt]: *Welt*  ',
    '  Das Wort kósmos wird eng mit der Menschheit in Verbindung gebracht.',
    '',
    '[^Sklave]: *Sklave*  ',
    'Oder „Diener“. Die Tatsache, dass „Sklave“ hier im Singular steht.',
    '',
    '[^unused]: Nothing refers to it.',
    '',
].join('\n');

/**
 * Footnotes where they are written (wave 4 #5b, `footnoteEngine.ts`): under
 * `FOOTNOTES_IN_PLACE` the editor's parse keeps each definition where the file
 * has it, a top-level group with its lines; without it, the plugin is the
 * preview's, unchanged.
 */
suite('Editor footnote engine', () => {
    const md = hostEngine();

    test('in place, each definition is a top-level group with the lines it stands for, a 2-space and a lazy line included; an unused one too', () => {
        const tokens = md.parse(ENTRIES, inPlaceEnv());
        // As markdown-it maps a block that may go on: the blank line after it too, which the grouping leaves to the next gap.
        assert.deepStrictEqual(definitions(tokens), [
            { label: 'Welt', open: [2, 5], close: [2, 5] },
            { label: 'Sklave', open: [5, 8], close: [5, 8] },
            { label: 'unused', open: [8, 9], close: [8, 9] },
        ]);
        assert.ok(!tokens.some(t => t.type === 'footnote_block_open'), 'no list after the blocks');
    });

    test('without the flag the plugin is the preview\'s: the definitions move into the list after the blocks, the unused one is dropped', () => {
        const tokens = md.parse(ENTRIES, {});
        assert.deepStrictEqual(definitions(tokens), []);
        assert.deepStrictEqual(tokens.filter(t => t.type === 'footnote_open').map(t => (t.meta as { label: string }).label), ['Welt', 'Sklave']);
        // What `rendersId` looks for: the list's ids, as the preview renders them.
        const html = md.render(ENTRIES, {});
        assert.ok(html.includes('id="fn1"') && html.includes('id="fnref2"') && !html.includes('Nothing refers to it'), html);
    });

    test('a definition still interrupts a paragraph, and the paragraph keeps its own line', () => {
        const text = 'A line[^a] of text\n[^a]: The note.\n';
        assert.deepStrictEqual(topLevel(md.parse(text, inPlaceEnv())), ['paragraph_open 0-1', 'footnote_reference_open 1-2']);
    });

    test('the page\'s engine keeps them in place alike: the same top-level groups with the same lines', () => {
        const page = createInlineEngine(DEFAULT_INLINE_ENGINE);
        assert.deepStrictEqual(topLevel(page.parse(ENTRIES, inPlaceEnv())), topLevel(md.parse(ENTRIES, inPlaceEnv())));
    });

    test('an inline footnote carries its text, and whether it holds a footnote of its own', () => {
        // One to a paragraph: two on a line are a superscript between their carets (markdown-it-sup-alt).
        const tokens = md.parse('A^[one *two*] B\n\nC^[see[^a]] D\n\n[^a]: A.\n', inPlaceEnv());
        const refs = tokens.flatMap(t => t.children ?? []).filter(t => t.type === 'footnote_ref');
        assert.deepStrictEqual(refs.map(footnoteMeta), [{ source: 'one *two*', nested: false }, { source: 'see[^a]', nested: true }]);
    });

    test('a reference says its label; a token the engine did not number says so; any other token is none', () => {
        const tokens = md.parse('x[^a]\n\n[^a]: A.\n', inPlaceEnv());
        const ref = tokens.flatMap(t => t.children ?? []).find(t => t.type === 'footnote_ref') as Token;
        assert.deepStrictEqual(footnoteMeta(ref), { label: 'a' });
        assert.deepStrictEqual(footnoteMeta(tokens.find(t => t.type === 'footnote_reference_open') as Token), { label: 'a' });
        assert.deepStrictEqual(footnoteMeta({ type: 'footnote_ref', meta: { id: 3 } } as unknown as Token), { broken: true });
        assert.strictEqual(footnoteMeta(tokens[0]), null);
    });

    test('a part read on its own reads `[^x]` as a reference when the document defines x, as text when not', () => {
        const refs = (env: Record<string, unknown>) => md.parse('See[^x] and[^y].\n', env).flatMap(t => t.children ?? []).filter(t => t.type === 'footnote_ref').map(t => (t.meta as { label: string }).label);
        assert.deepStrictEqual(refs(inPlaceEnv(undefined, ['x'])), ['x']);
        assert.deepStrictEqual(refs(inPlaceEnv()), []);
    });

    test('the environment is fresh, keeps what it was given and never the footnotes of a parse before', () => {
        const base: Record<string, unknown> = { currentDocument: 'file' };
        md.parse(ENTRIES, base);
        const env = inPlaceEnv(base);
        assert.deepStrictEqual(env, { currentDocument: 'file', [FOOTNOTES_IN_PLACE]: true });
        assert.notStrictEqual(env, base);
    });

    test('a definition inside a quote renders as the editor draws a source block holding it', () => {
        const html = (md as MarkdownIt).render('> [^x]: Quoted note.\n', inPlaceEnv());
        assert.ok(html.includes('<div class="footnote-item mep-fn-raw" data-label="x">') && html.includes('Quoted note.'), html);
    });
});
