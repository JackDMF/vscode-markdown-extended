import * as assert from 'assert';
import { FILE_STAYS, NO_TARGET_HINT, Slot, Slotted, VERB, Wording, arrange, barDescription, barName, crumbName, crumbPartName, firstFocus, overflowOrder, wording } from '../../../src/editor/verbs';
import { undoHint } from '../../../src/editor/webview/hint';
import { attributesRemovedHint } from '../../../src/editor/webview/attributes';
import { UNDO_BINDING, keyLabel } from '../../../src/editor/keys';

/** A verb as the model reads it: an id to tell it by, its slot, and whether it opens in place or is refused. */
type V = Slotted & { id: string };
const v = (id: string, slot: Slot, opensInPlace: boolean, more: Partial<V> = {}): V => ({ id, slot, opensInPlace, ...more });

const ids = (verbs: readonly V[]) => verbs.map(x => x.id);
const dividers = (verbs: readonly V[]) => verbs.filter(x => x.separated).map(x => x.id);

/**
 * The bars' model (`verbs.ts`), against the sketch's rows (wave 1, #7 + #14):
 * one order, one divider rule, one first focus, one wording, one hint pattern.
 */
suite('Editor object bars: the verbs\' model', () => {
    suite('arrange: slot order and dividers', () => {
        test('an image\'s verbs, listed in any order, stand Open file · Edit image… · Attributes… · Delete image, the divider before Delete only', () => {
            const arranged = arrange([
                v('delete-image', 'destroy', false),
                v('image-attributes', 'attributes', true),
                v('open-image', 'open', false),
                v('edit-image', 'edit', true),
            ]);
            assert.deepStrictEqual(ids(arranged), ['open-image', 'edit-image', 'image-attributes', 'delete-image']);
            assert.deepStrictEqual(dividers(arranged), ['delete-image']);
        });

        test('a note: Convert · Edit source · Delete note', () => {
            const arranged = arrange([v('delete-note', 'destroy', false), v('convert-note', 'type', false), v('edit-source', 'source', true)]);
            assert.deepStrictEqual(ids(arranged), ['convert-note', 'edit-source', 'delete-note']);
            assert.deepStrictEqual(dividers(arranged), ['delete-note']);
        });

        test('a requirement heading\'s lenses get no divider: no verb of its own precedes them', () => {
            const arranged = arrange([v('lens:a', 'actions', false), v('lens:b', 'actions', false), v('lens-overflow', 'actions', true)]);
            assert.deepStrictEqual(dividers(arranged), []);
        });

        test('a source block\'s code action stands after a divider, before the divider of Delete block', () => {
            const arranged = arrange([
                v('edit-source', 'source', true),
                v('show-in-text-editor', 'open', false),
                v('delete-block', 'destroy', false),
                v('code-action:fix', 'actions', false),
            ]);
            assert.deepStrictEqual(ids(arranged), ['show-in-text-editor', 'edit-source', 'code-action:fix', 'delete-block']);
            assert.deepStrictEqual(dividers(arranged), ['code-action:fix', 'delete-block']);
        });

        test('the divider a presentation set itself stays: a table\'s before Attributes…', () => {
            const arranged = arrange([
                v('row', 'type', true), v('column', 'type', true), v('align', 'type', true),
                v('block-attributes', 'attributes', true, { separated: true }),
                v('edit-source', 'source', true), v('delete-table', 'destroy', false),
            ]);
            assert.deepStrictEqual(ids(arranged), ['row', 'column', 'align', 'block-attributes', 'edit-source', 'delete-table']);
            assert.deepStrictEqual(dividers(arranged), ['block-attributes', 'delete-table']);
        });

        test('Attributes of Bold… stands with Attributes…, after no divider of its own', () => {
            const arranged = arrange([
                v('open-link', 'open', false), v('edit-link', 'edit', true), v('link-attributes', 'attributes', true),
                v('remove-link', 'destroy', false), v('inline-attributes', 'attributes', true),
            ]);
            assert.deepStrictEqual(ids(arranged), ['open-link', 'edit-link', 'link-attributes', 'inline-attributes', 'remove-link']);
            assert.deepStrictEqual(dividers(arranged), ['remove-link']);
        });

        test('a Delete alone gets no divider: nothing stands before it but the title', () => {
            assert.deepStrictEqual(dividers(arrange([v('delete-block', 'destroy', false)])), []);
        });
    });

    suite('firstFocus: the first verb that opens in place and is not refused, else the bar', () => {
        const rows: { name: string; verbs: V[]; focus: number }[] = [
            { name: 'link → Edit link…', verbs: [v('open-link', 'open', false), v('edit-link', 'edit', true), v('link-attributes', 'attributes', true), v('remove-link', 'destroy', false)], focus: 1 },
            { name: 'image → Edit image…', verbs: [v('open-image', 'open', false), v('edit-image', 'edit', true), v('image-attributes', 'attributes', true), v('delete-image', 'destroy', false)], focus: 1 },
            { name: 'table → Row', verbs: [v('row', 'type', true), v('column', 'type', true), v('align', 'type', true), v('block-attributes', 'attributes', true), v('edit-source', 'source', true), v('delete-table', 'destroy', false)], focus: 0 },
            { name: 'one-line note → Edit source', verbs: [v('convert-note', 'type', false), v('edit-source', 'source', true), v('delete-note', 'destroy', false)], focus: 1 },
            { name: 'multi-line note, Edit source refused → the bar', verbs: [v('convert-note', 'type', false), v('edit-source', 'source', true, { refusal: 'a line break' }), v('delete-note', 'destroy', false)], focus: -1 },
            { name: 'emoji → the bar', verbs: [v('convert-emoji-to-text', 'type', false), v('delete-emoji', 'destroy', false)], focus: -1 },
            { name: 'requirement heading → the bar', verbs: [v('lens:a', 'actions', false), v('lens:b', 'actions', false), v('lens-overflow', 'actions', true)], focus: -1 },
            { name: 'bold, no {…} → Attributes…', verbs: [v('edit-attributes', 'attributes', true)], focus: 0 },
            { name: 'container, Attributes… refused → Edit classes…', verbs: [v('edit-classes', 'edit', true), v('block-attributes', 'attributes', true, { refusal: 'dropped' }), v('remove-container', 'destroy', false)], focus: 0 },
            { name: 'source block → Edit source (a box), not Show in text editor', verbs: [v('show-in-text-editor', 'open', false), v('edit-source', 'source', true), v('delete-block', 'destroy', false)], focus: 1 },
            { name: 'snippet → the bar: Change snippet… asks the host, nothing opens in place', verbs: [v('open-snippet', 'open', false), v('show-in-text-editor', 'open', false), v('change-snippet', 'edit', false), v('delete-directive', 'destroy', false)], focus: -1 },
            { name: 'badge, no verbs → the bar', verbs: [], focus: -1 },
            // #8: on a two-part bar the first in-place verb acting on the current part — an admonition's Type▾ and Edit title… act on the outer one.
            {
                name: 'Admonition › Heading → Attributes of Heading…, not Type▾',
                verbs: [v('edit-title', 'edit', true, { outer: true }), v('change-type', 'type', true, { outer: true }), v('block-attributes', 'attributes', true), v('remove-menu', 'destroy', true)],
                focus: 2,
            },
            { name: 'List › List item → Attributes…, never Remove▾', verbs: [v('block-attributes', 'attributes', true), v('remove-attributes', 'destroy', true)], focus: 0 },
        ];
        for (const row of rows) {
            test(row.name, () => assert.strictEqual(firstFocus(row.verbs), row.focus));
        }
    });

    suite('overflowOrder: what leaves a bar for its "…" first — destroy, other extensions\', then from the right; never the first focus', () => {
        const order = (verbs: V[]) => overflowOrder(verbs).map(k => verbs[k].id);
        test('a table: Delete table, Edit source, Attributes…, Align, Column — Row (first focus) stays', () => {
            const verbs = [v('row', 'type', true), v('column', 'type', true), v('align', 'type', true), v('block-attributes', 'attributes', true), v('edit-source', 'source', true), v('delete-table', 'destroy', false)];
            assert.deepStrictEqual(order(verbs), ['delete-table', 'edit-source', 'block-attributes', 'align', 'column']);
        });
        test('a link in bold: Remove, Attributes of Bold…, Attributes…, Open — Edit… (first focus) stays', () => {
            const verbs = [v('open-link', 'open', false), v('edit-link', 'edit', true), v('link-attributes', 'attributes', true), v('bold-attributes', 'attributes', true), v('remove-link', 'destroy', false)];
            assert.deepStrictEqual(order(verbs), ['remove-link', 'bold-attributes', 'link-attributes', 'open-link']);
        });
        test('other extensions\' actions leave before the object\'s own verbs, from the right', () => {
            const verbs = [v('show-in-text-editor', 'open', false), v('edit-source', 'source', true), v('code-action:a', 'actions', false), v('code-action:b', 'actions', false), v('delete-block', 'destroy', false)];
            assert.deepStrictEqual(order(verbs), ['delete-block', 'code-action:b', 'code-action:a', 'show-in-text-editor']);
        });
        test('a bar with no first focus: everything may leave, the destroying verb first', () => {
            const verbs = [v('convert-emoji-to-text', 'type', false), v('delete-emoji', 'destroy', false)];
            assert.deepStrictEqual(order(verbs), ['delete-emoji', 'convert-emoji-to-text']);
        });
        test('two destroying verbs keep their order', () => {
            const verbs = [v('edit', 'edit', true), v('remove-a', 'destroy', false), v('delete-b', 'destroy', false)];
            assert.deepStrictEqual(order(verbs), ['remove-a', 'delete-b']);
        });
        test('#8: an admonition bar with a heading — Remove▾ first, then from the right; Attributes of Heading… (the first focus) never moves', () => {
            const verbs = [v('edit-title', 'edit', true, { outer: true }), v('change-type', 'type', true, { outer: true }), v('block-attributes', 'attributes', true), v('remove-menu', 'destroy', true)];
            assert.deepStrictEqual(order(verbs), ['remove-menu', 'change-type', 'edit-title']);
        });
    });

    test('#8: a two-part bar\'s name and a part\'s, the braces left out; the undo hint names the part', () => {
        assert.strictEqual(crumbName({ name: 'List item', literal: '{.lead}' }, { name: 'List', literal: '{.steps}' }), 'List item .lead in List .steps');
        assert.strictEqual(crumbName({ name: 'List item', literal: null }, { name: 'List', literal: '{.steps}' }), 'List item in List .steps');
        assert.strictEqual(crumbName({ name: 'Heading', literal: '{#sync-rules}' }, null), 'Heading #sync-rules');
        assert.strictEqual(crumbPartName({ name: 'List', literal: '{.steps}' }), 'Attributes of List, .steps');
        assert.strictEqual(crumbPartName({ name: 'List item', literal: null }), 'Attributes of List item, none');
        assert.strictEqual(attributesRemovedHint('List item'), 'List item attributes removed');
        assert.strictEqual(attributesRemovedHint('Quote'), 'Quote attributes removed');
    });

    suite('wording: label, short form, hint', () => {
        const rows: { w: Wording; label: string; short: string; done: string | null }[] = [
            { w: { verb: 'Open', noun: '' }, label: 'Open', short: 'Open', done: null },
            { w: { verb: 'Open', noun: 'file' }, label: 'Open file', short: 'Open', done: null },
            { w: { verb: 'Open', noun: 'snippet' }, label: 'Open snippet', short: 'Open', done: null },
            { w: { verb: 'Edit', noun: 'link', opens: true }, label: 'Edit link…', short: 'Edit…', done: null },
            { w: { verb: 'Edit', noun: 'image', opens: true }, label: 'Edit image…', short: 'Edit…', done: null },
            { w: { verb: 'Edit', noun: 'title', opens: true, titled: false }, label: 'Edit title…', short: 'Edit title…', done: null },
            { w: { verb: 'Edit', noun: 'classes', opens: true, titled: false }, label: 'Edit classes…', short: 'Edit classes…', done: null },
            { w: { verb: 'Change', noun: 'snippet', opens: true }, label: 'Change snippet…', short: 'Change…', done: null },
            { w: { verb: 'Remove', noun: 'link', keeps: ', keep text' }, label: 'Remove link, keep text', short: 'Remove, keep text', done: 'Link removed' },
            { w: { verb: 'Remove', noun: 'sidebar', keeps: ', keep text' }, label: 'Remove sidebar, keep text', short: 'Remove, keep text', done: 'Sidebar removed' },
            { w: { verb: 'Remove', noun: 'container', keeps: ', keep content' }, label: 'Remove container, keep content', short: 'Remove, keep content', done: 'Container removed' },
            { w: { verb: 'Remove', noun: 'admonition', keeps: ', keep content' }, label: 'Remove admonition, keep content', short: 'Remove, keep content', done: 'Admonition removed' },
            { w: { verb: 'Remove', noun: 'attributes', keeps: ', keep text', titled: false }, label: 'Remove attributes, keep text', short: 'Remove attributes, keep text', done: 'Attributes removed' },
            { w: { verb: 'Remove', noun: 'attributes', keeps: ', keep formatting', titled: false }, label: 'Remove attributes, keep formatting', short: 'Remove attributes, keep formatting', done: 'Attributes removed' },
            { w: { verb: 'Delete', noun: 'image' }, label: 'Delete image', short: 'Delete', done: 'Image deleted' },
            { w: { verb: 'Delete', noun: 'note' }, label: 'Delete note', short: 'Delete', done: 'Note deleted' },
            { w: { verb: 'Delete', noun: 'emoji' }, label: 'Delete emoji', short: 'Delete', done: 'Emoji deleted' },
            { w: { verb: 'Delete', noun: 'embed' }, label: 'Delete embed', short: 'Delete', done: 'Embed deleted' },
            { w: { verb: 'Delete', noun: 'table' }, label: 'Delete table', short: 'Delete', done: 'Table deleted' },
            { w: { verb: 'Delete', noun: 'block' }, label: 'Delete block', short: 'Delete', done: 'Block deleted' },
            { w: { verb: 'Delete', noun: 'directive' }, label: 'Delete directive', short: 'Delete', done: 'Directive deleted' },
            { w: { verb: 'Delete', noun: 'code block' }, label: 'Delete code block', short: 'Delete', done: 'Code block deleted' },
            { w: { verb: 'Convert to text', noun: 'emoji' }, label: 'Convert to text', short: 'Convert to text', done: 'Emoji converted to text' },
            { w: { verb: 'Convert to text', noun: 'embed' }, label: 'Convert to text', short: 'Convert to text', done: 'Embed converted to text' },
        ];
        for (const row of rows) {
            test(`${row.label} → ${row.short}, ${row.done ?? 'no hint'}`, () => {
                assert.deepStrictEqual(wording(row.w), { label: row.label, short: row.short, done: row.done });
            });
        }
    });

    test('the bar\'s name and accessible description', () => {
        assert.strictEqual(barName('Emoji', ':rocket:'), 'Emoji :rocket:');
        assert.strictEqual(barName('Sidenote'), 'Sidenote');
        assert.strictEqual(barDescription('Emoji :rocket:', 2), 'Emoji :rocket:, 2 actions, arrow keys to choose');
        assert.strictEqual(barDescription('Bold', 1), 'Bold, 1 action, arrow keys to choose');
        assert.strictEqual(barDescription('Status badge', 0), 'Status badge, no actions available');
    });

    test('an undo hint ends in the key the page\'s keymap undoes with', () => {
        const hint = undoHint('Image deleted');
        assert.match(hint, /^Image deleted — (Ctrl|Cmd)\+Z$/);
        assert.ok(hint.endsWith(keyLabel(UNDO_BINDING, hint.includes('Cmd'))));
        assert.strictEqual(FILE_STAYS, 'Delete from this document — the file stays');
    });

    test('a code block: Delete code block, short Delete, "Code block deleted"; Language… is its type verb; Alt+Enter with nothing to act on says so', () => {
        assert.deepStrictEqual(wording({ verb: 'Delete', noun: 'code block' }), { label: 'Delete code block', short: 'Delete', done: 'Code block deleted' });
        assert.strictEqual(VERB.language, 'Language…');
        assert.strictEqual(NO_TARGET_HINT, 'No actions here — Alt+Enter acts on objects such as links, images, tables and code blocks');
    });
});
