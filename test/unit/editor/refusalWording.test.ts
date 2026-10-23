import * as assert from 'assert';
import { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { editorSchema, parseDocument } from '../../../src/editor';
import * as fences from '../../../src/editor/fences';
import { markNoun } from '../../../src/editor/refusal';
import * as serialize from '../../../src/editor/serialize';
import { Said, TipPart, saidParts, saidText } from '../../../src/editor/tips';
import { VERB } from '../../../src/editor/verbs';
import { lockForms } from '../../../src/editor/webview/focusPlace';
import { applyKey, undoKey } from '../../../src/editor/webview/hint';
import { SYSTEM_FILE_LOCK } from '../../../src/editor/webview/images';
import { NESTED_NOTE_LOCK, NOTE_LOCK } from '../../../src/editor/webview/notes';
import * as objects from '../../../src/editor/webview/objects';
import { CONTAINER_TITLE_REFUSAL } from '../../../src/editor/webview/objectToolbar';
import { deleteColumnRefusal, deleteRowRefusal } from '../../../src/editor/webview/tables';
import { INLINE_ATTRS_LOCK, NO_INCLUDES_REFUSAL, PROPERTIES_PRESENT_REFUSAL } from '../../../src/editor/webview/toolbar/actions';
import * as commands from '../../../src/editor/webview/toolbar/commands';
import { exportBusyNote, exportWaitNote } from '../../../src/editor/webview/toolbar/toolbar';
import { hostEngine, topChildren } from './helpers';

/** A document parsed as the host does, in a state. */
function stateOf(md: string): EditorState {
    return EditorState.create({ doc: parseDocument(hostEngine(), md).doc });
}

/** Where `needle` starts in `doc`'s text, as a position. */
function posOf(doc: Node, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(needle)) {
            found = pos + (node.text ?? '').indexOf(needle);
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}"`);
    return found;
}

const loss = { at: null } as unknown as Record<string, unknown>;

/** Every refusal #10 reworded, as it is made: constants, and one call of each producer with representative input. */
function reworded(): [string, Said][] {
    const table = topChildren(parseDocument(hostEngine(), '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n').doc)[0];
    const cell = table.lastChild?.firstChild as Node;
    const list = topChildren(parseDocument(hostEngine(), '- one\n- two\n').doc)[0];
    const item = list.child(1);
    const lit = '{.x}';
    const out: [string, Said][] = [
        ['L1', lockForms('source').press], ['L2', lockForms('property').press], ['L3', lockForms('button').press],
        ['L4a', exportBusyNote('pdf' as never)], ['L4b', exportWaitNote('html' as never, 'pdf' as never)],
        ['L9', commands.ATOM_LOCK], ['L10', commands.GAP_LOCK], ['L11a', commands.ALL_LOCK], ['L11b', commands.WHOLE_LOCK], ['L12', commands.TABLE_LOCK],
        ['C3', serialize.CELL_PIPE_REFUSAL], ['C4', serialize.CELL_BREAK_REFUSAL], ['C5', serialize.emojiRawRefusal('inline code')],
        ['C12', serialize.mergedReason('bold text')],
        ...(['lost', 'made', 'text', 'address', 'title', 'block', 'unread'] as const).map((kind): [string, Said] => [`cause ${kind}`, serialize.causeReason({ kind, noun: kind === 'title' ? 'link' : 'emphasis' })]),
        ['C14 glued', serialize.SIDEBAR_GLUED_BEFORE], ['C14a', serialize.SIDEBAR_NOT_READ], ['C14b', serialize.SIDEBAR_MADE], ['C14c', serialize.MATH_MADE],
        ['C17a', objects.IMAGE_LOCK], ['C17b', objects.DROP_LOCK], ['C17c', objects.IMAGE_PLACE_REFUSAL], ['C19', SYSTEM_FILE_LOCK],
        ['C22', INLINE_ATTRS_LOCK], ['C23', objects.NO_ATTRS_REFUSAL], ['C24', CONTAINER_TITLE_REFUSAL],
        ['X4', serialize.SIDEBAR_REWRITTEN_REFERENCE], ['X5', serialize.SIDEBAR_REWRITTEN], ['X6', serialize.SIDEBAR_LEFT_MATH],
        ['X7', serialize.sidebarRewrittenBeside(table, cell, false)], ['X7 reference', serialize.sidebarRewrittenBeside(table, cell, true)],
        ['X8', serialize.LITERAL_MADE], ['X9', serialize.literalLostReason({ ...loss, literal: lit } as never)],
        ['X10 cause', serialize.literalRewritten({ ...loss, literal: null, cause: { kind: 'lost', noun: 'emphasis' } } as never)],
        ['X10 made', serialize.literalRewritten({ ...loss, literal: null } as never)], ['X10 literal', serialize.literalRewritten({ ...loss, literal: lit } as never)],
        ['C13 cause', serialize.literalRewrittenBeside(table, cell, { ...loss, literal: null, cause: { kind: 'lost', noun: 'emphasis' } } as never)],
        ['C13 made', serialize.literalRewrittenBeside(list, item, { ...loss, literal: null } as never)],
        ['C13 literal', serialize.literalRewrittenBeside(table, cell, { ...loss, literal: lit } as never)],
        ['C13 own', serialize.literalRewrittenBeside(table, table, { ...loss, literal: lit } as never)],
        ['X13', PROPERTIES_PRESENT_REFUSAL], ['X15', objects.NESTED_CODE_ATTRS_REFUSAL], ['X16', objects.ITEM_ATTRS_REFUSAL],
        ['F9', objects.LITERAL_READ_WITH_BLOCK_REFUSAL], ['F10', objects.literalAlreadyLostRefusal({ ...loss, literal: null } as never)],
        ['F10 literal', objects.literalAlreadyLostRefusal({ ...loss, literal: lit } as never)], ['F11', fences.LANGUAGE_WORD_REFUSAL],
        // #15: a note's literal holding a marker it would pair with (R2); a sidebar's removal that glues it (R4).
        ['R2', objects.noteLiteralMarkerRefusal('right sidebar', '@')], ['R4', objects.noteLiteralRemoveGlued('left sidebar', '5')],
        ['R2 Convert', objects.noteLiteralConvertRefusal('right sidebar', '@')], ['R6 |', objects.literalCellRefusal('|')], ['R6 `', objects.literalCellRefusal('`')],
    ];
    for (const typed of ['{.}', '{width = 300}', '{a="x}', '{title="a}b"}', '{k="a\\"b"}', '{href=x}', '{src=x}', '{title=x}']) {
        const place = typed.startsWith('{href') || typed.startsWith('{title=x') ? 'link' : typed.startsWith('{src') ? 'image' : typed.includes('a}b') ? 'span' : 'paragraph';
        const said = objects.literalRefusal(typed, place);
        assert.ok(said !== null, typed);
        out.push([`F ${typed}`, said]);
    }
    return out;
}

/** What #8 and the kept strings say: already plain (wording.md), checked for internals only. */
const KEPT: [string, Said][] = [
    ['NODE_LOCK', commands.NODE_LOCK], ['NO_TEXT_LOCK', commands.NO_TEXT_LOCK], ['WRAP_LOCK', commands.WRAP_LOCK], ['REQUIREMENT_HEADING_LOCK', commands.REQUIREMENT_HEADING_LOCK],
    ['LINK_LOCK', objects.LINK_LOCK], ['NOTE_LOCK', NOTE_LOCK], ['NESTED_NOTE_LOCK', NESTED_NOTE_LOCK], ['NO_BLOCK_ATTRS_REFUSAL', objects.NO_BLOCK_ATTRS_REFUSAL],
    ['NO_INCLUDES_REFUSAL', NO_INCLUDES_REFUSAL], ['SIDEBAR_GLUED_AFTER', serialize.SIDEBAR_GLUED_AFTER],
    ['SIDEBAR_GLUED_URL', serialize.SIDEBAR_GLUED_URL], ['NO_FENCE', fences.NO_FENCE_REFUSAL], ['BACKTICK_INFO', fences.BACKTICK_INFO_REFUSAL],
    ['LANGUAGE_FOLLOWED', fences.LANGUAGE_FOLLOWED_REFUSAL], ['LANGUAGE_LITERAL', fences.LANGUAGE_LITERAL_REFUSAL],
];

/** The words no refusal says: the internals (`plugin`, `markdown-it`, "the preview would …", a note's "part"). */
const INTERNALS = /plugin(?!s: Disabled)|markdown-it|the preview would|nothing escapes|\bpart\b(?! of the address)|literal/i;

/**
 * One rule for every refusal #10 reworded (DECISIONS, round 2 #10; ux-critic
 * #10): what happened, then the remedy; no internals; short enough to read;
 * a single character it names quoted around its mono part; the keys as the
 * platform names them, from the bindings; the text editor named by its verb.
 */
suite('Editor refusal wording: one rule for every refusal (#10)', () => {
    test('no internals, a remedy, at most 220 characters', () => {
        for (const [id, said] of reworded()) {
            const text = saidText(said);
            assert.doesNotMatch(text, INTERNALS, `${id}: ${text}`);
            assert.ok(text.includes(' — ') || /[.!?]["”]? +["A-Z]/.test(text) || /\. [A-Z]/.test(text), `${id} says what to do: ${text}`);
            assert.ok(text.length <= 220, `${id} is ${text.length} characters`);
        }
        for (const [id, said] of KEPT) {
            assert.doesNotMatch(saidText(said), INTERNALS, `${id}: ${saidText(said)}`);
        }
    });

    test('a single character named is quoted around its mono part; a key is never typed in, it comes from the binding', () => {
        for (const [id, said] of [...reworded(), ...KEPT]) {
            const parts: readonly TipPart[] = saidParts(said);
            parts.forEach((p, i) => {
                if (typeof p !== 'string' && 'code' in p && [...p.code].length === 1) {
                    const before = parts[i - 1];
                    const after = parts[i + 1];
                    assert.ok(typeof before === 'string' && before.endsWith('"') && typeof after === 'string' && after.startsWith('"'), `${id}: "${p.code}" quoted`);
                }
            });
            const text = saidText(said).replace(applyKey(), '').replace(undoKey(), '');
            assert.doesNotMatch(text, /\b(Ctrl|Cmd)\b/, `${id}: ${text}`);
            const full = saidText(said);
            for (const m of full.matchAll(/show in text editor/gi)) {
                assert.strictEqual(m[0], VERB.showInTextEditor, id);
                // Named as the button it is: in quotes (#10 build critique).
                const at = m.index ?? 0;
                assert.ok(full[at - 1] === '"' && full[at + m[0].length] === '"', `${id}: the verb in quotes: ${full}`);
            }
        }
    });

    test('the table\'s Delete row and Delete column say what a table needs, and the verb that removes it all', () => {
        const only = stateOf('| a | b |\n| - | - |\n\nAfter.\n');
        const headerOnly = only.apply(only.tr.setSelection(TextSelection.create(only.doc, posOf(only.doc, 'a'))));
        assert.strictEqual(deleteRowRefusal(headerOnly), 'A table needs at least one row — Delete table deletes the whole table.');
        const narrow = stateOf('| a |\n| - |\n| 1 |\n');
        const inCell = narrow.apply(narrow.tr.setSelection(TextSelection.create(narrow.doc, posOf(narrow.doc, '1'))));
        assert.strictEqual(deleteColumnRefusal(inCell), 'A table needs at least one column — Delete table deletes the whole table.');
        assert.strictEqual(deleteRowRefusal(stateOf('Text.\n')), 'Put the caret in a row first.');
    });
});

/**
 * The marks a refusal names, by the row's own names (ux-critic #10, finding 1):
 * the one source is `inlineLiterals.ts` through `markNoun`.
 */
suite('Editor refusal wording: the marks and parts it names', () => {
    const marks = ['code', 'sup', 'sub'] as const;

    test('C1: a reference\'s "|" under inline code, superscript or subscript names that one mark, and the note', () => {
        const delims: Record<string, string> = { code: '`', sup: '^', sub: '~' };
        for (const name of marks) {
            const d = delims[name];
            const state = stateOf(`A ++ref ${d}ab${d} x|body++ z.\n`);
            const at = posOf(state.doc, 'ab') + 1;
            const said = serialize.unwritableInNote(state.tr.insertText('|', at).doc);
            const noun = markNoun(editorSchema.marks[name].create());
            assert.ok(said !== null, name);
            assert.strictEqual(saidText(said), `"|" can't go in ${noun} in a sidenote — it would end the note there. Type it outside the ${noun}.`, name);
        }
    });

    test('C5 and X1: an emoji or a note under a mark whose text is written as it is names that mark', () => {
        for (const name of marks) {
            const mark = editorSchema.marks[name].create();
            const noun = markNoun(mark);
            const emoji = stateOf('Glad :) here.\n');
            const at = posOf(emoji.doc, 'here') - 2;
            const coded = emoji.tr.addMark(at - 1, at + 1, mark).doc;
            assert.strictEqual(serialize.unwritableEmoji(coded), `An emoji can't be ${noun} — it would be saved as plain text. Format the text beside it instead.`, name);
            const note = stateOf('A ++ref|body++ z.\n');
            let notePos = -1;
            note.doc.descendants((node, pos) => {
                if (node.type.name === 'sidenote') {
                    notePos = pos;
                }
            });
            const sidenote = note.doc.nodeAt(notePos) as Node;
            const noted = note.tr.replaceWith(notePos, notePos + sidenote.nodeSize, sidenote.mark([mark])).doc;
            const said = serialize.unwritableInNote(noted);
            assert.strictEqual(said === null ? null : saidText(said), `A note can't go inside ${noun} — it would be lost when saved. Put it outside the ${noun}.`, name);
        }
    });

    test('C6, C7 and C12 take the row\'s four names: italic text, emphasis, bold text, strong emphasis', () => {
        const names = [['em', '*'], ['em', '_'], ['strong', '**'], ['strong', '__']].map(([m, markup]) => markNoun(editorSchema.marks[m].create({ markup })));
        assert.deepStrictEqual(names, ['italic text', 'emphasis', 'bold text', 'strong emphasis']);
        for (const noun of names) {
            assert.ok(serialize.causeReason({ kind: 'lost', noun }).includes(`this ${noun} would lose`));
            assert.ok(serialize.mergedReason(noun).includes(`the two ${noun} parts`));
        }
    });

    test('C13 names the part to change once: a table\'s row, a list\'s item', () => {
        const table = topChildren(parseDocument(hostEngine(), '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n').doc)[0];
        const cell = table.lastChild?.firstChild as Node;
        const lost = { at: null, literal: null, cause: { kind: 'lost', noun: 'emphasis' } } as never;
        assert.strictEqual(saidText(serialize.literalRewrittenBeside(table, cell, lost)), `This table can't be changed here: row 3 wouldn't be saved as shown. Fix row 3 once with "${VERB.showInTextEditor}".`);
        const list = topChildren(parseDocument(hostEngine(), '- one\n- two\n').doc)[0];
        assert.ok(saidText(serialize.literalRewrittenBeside(list, list.child(1), lost)).includes('item 2 wouldn\'t be saved as shown'));
    });
});

/**
 * #8's texts (the admonition's and the container's are #8's, ux-critic #10;
 * critique items 10–13): each reached by its route, under #10's rules — what
 * happened, then what to do; no internals; no "title bar" (VS Code has one).
 */
suite('Editor refusal wording: the nested attributes\' texts (#8 step 3)', () => {
    /** The refusal the menu's target meets with the caret at `needle`. */
    const refusalAt = (md: string, needle: string): Said => {
        const state = stateOf(md);
        const at = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, needle) + 1)));
        const target = objects.attributesTargetAt(at);
        assert.ok('refusal' in target, `${md}: refused`);
        return target.refusal;
    };
    const outerAt = (md: string, needle: string): Said | null => {
        const state = stateOf(md);
        const at = state.apply(state.tr.setSelection(TextSelection.create(state.doc, posOf(state.doc, needle) + 1)));
        return objects.blockPartsAt(at).outer?.refusal ?? null;
    };

    const routes = (): [string, Said][] => [
        ['admonition paragraph', refusalAt('!!! note\n    Body text.\n', 'Body')],
        ['container paragraph', refusalAt('::: box\nInside.\n:::\n', 'Inside')],
        ['quote ending in a list', refusalAt('> Text.\n>\n> - item\n', 'Text')],
        ['quote ending in a code block', refusalAt('> Text.\n>\n> ```\n> x\n> ```\n', 'Text')],
        ['list in a quote (its List part)', outerAt('> - a\n> - b\n', 'a') ?? 'none'],
        ['item without a text line', refusalAt('- ```\n  x\n  ```\n', 'x')],
        ['!!! note {.x}', objects.sourceExplanation('attributes on admonition_title_open', '!!! note {.x}\n    Body\n') ?? 'none'],
        ['!!! note "T" {.x}', objects.sourceExplanation('attributes on admonition_title_open', '!!! note "T" {.x}\n    Body\n') ?? 'none'],
        ['quote paragraph', objects.sourceExplanation('attributes on paragraph_open', '> text {.x}\n') ?? 'none'],
    ];

    test('each is reached by its route, and says what happened, then what to do — no internals, no "title bar", at most 220 characters', () => {
        const expected: Record<string, Said> = {
            'admonition paragraph': objects.ADMONITION_ATTRS_REFUSAL,
            'container paragraph': objects.CONTAINER_ATTRS_REFUSAL,
            'list in a quote (its List part)': objects.NESTED_LIST_ATTRS_REFUSAL,
            'item without a text line': objects.ITEM_ATTRS_REFUSAL,
            '!!! note {.x}': objects.ADMONITION_TITLE_LITERAL_EMPTY,
            '!!! note "T" {.x}': objects.ADMONITION_TITLE_LITERAL,
            'quote paragraph': objects.QUOTE_PARAGRAPH_LITERAL,
        };
        for (const [id, said] of routes()) {
            if (expected[id] !== undefined) {
                assert.strictEqual(said, expected[id], id);
            }
            const text = saidText(said);
            assert.doesNotMatch(text, INTERNALS, `${id}: ${text}`);
            assert.doesNotMatch(text, /title bar/i, `${id}: ${text}`);
            assert.ok(text.includes(' — ') || /[.!?)]["”]? +["A-Z]/.test(text), `${id} says what to do: ${text}`);
            assert.ok(text.length <= 220, `${id} is ${text.length} characters`);
        }
        assert.strictEqual(saidText(refusalAt('> Text.\n>\n> - item\n', 'Text')), saidText(objects.quoteAttrsRefusal(topChildren(parseDocument(hostEngine(), '> Text.\n>\n> - item\n').doc)[0])));
        assert.strictEqual(objects.sourceExplanation('attributes on table_open', '| a |\n'), null, 'other source blocks keep their own words');
    });

    test('a value the user types is set in mono: ":::", "!!!", "{.x}", "> {.x}"', () => {
        const mono = (said: Said) => saidParts(said).filter((p): p is { code: string } => typeof p !== 'string' && 'code' in p).map(p => p.code);
        assert.deepStrictEqual(mono(objects.CONTAINER_ATTRS_REFUSAL), [':::', ':::']);
        assert.deepStrictEqual(mono(objects.ADMONITION_TITLE_LITERAL_EMPTY), ['{.x}', '!!!', '{.x}', '!!! note "Title" {.x}']);
        assert.deepStrictEqual(mono(objects.QUOTE_PARAGRAPH_LITERAL), ['{.x}', '> {.x}']);
    });
});
