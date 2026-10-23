import * as assert from 'assert';
import { Node, ResolvedPos } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { saidText } from '../../../src/editor/tips';
import {
    ADMONITION_ATTRS_REFUSAL, AttributesTarget, CrumbPart, NESTED_LIST_ATTRS_REFUSAL, attributesTargetAt, blockPartsAt, crumbsAt, followAll, isMarkObject, literalOf,
    objectAtSelection, sameObject,
} from '../../../src/editor/webview/objects';
import { resyncTransaction } from '../../../src/editor/webview/resync';
import { hostEngine } from './helpers';

function stateOf(text: string): EditorState {
    return EditorState.create({ doc: parseDocument(hostEngine(), text, {}).doc });
}

/** `state` with a caret at character `index` of the first text `needle` stands in. */
function at(state: EditorState, needle: string, index = 1): EditorState {
    let found = -1;
    state.doc.descendants((node, pos) => {
        if (found < 0 && node.isText && (node.text ?? '').includes(needle)) {
            found = pos + (node.text ?? '').indexOf(needle) + index;
        }
        return found < 0;
    });
    assert.ok(found >= 0, `no "${needle}" in the document`);
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, found)));
}

/** The position of the first node of `type`, or of the innermost one whose text holds `needle`. */
function nodePos(state: EditorState, type: string, needle?: string): number {
    let found = -1;
    state.doc.descendants((node, pos) => {
        if ((found < 0 || needle !== undefined) && node.type.name === type && (needle === undefined || node.textContent.includes(needle))) {
            found = pos;
        }
        return true;
    });
    assert.ok(found >= 0, `no ${type}${needle ? ` holding "${needle}"` : ''}`);
    return found;
}

/** A part as the test reads it: its role, name, literal, where its target stands (or `run`/none) and its refusal. */
function shape(part: CrumbPart | null): unknown {
    if (part === null) {
        return null;
    }
    const target = part.target === null ? null : 'pos' in part.target ? part.target.pos : `run ${part.target.object.from}`;
    return { role: part.role, name: part.name, literal: part.literal, target, refusal: part.refusal === null ? null : saidText(part.refusal), anchor: part.anchor };
}

interface Fixture {
    what: string;
    source: string;
    needle: string;
    current: (s: EditorState) => unknown;
    outer: (s: EditorState) => unknown;
}

const part = (role: 'current' | 'outer', name: string, literal: string | null, target: number | string | null, anchor: CrumbPart['anchor'], refusal: string | null = null) =>
    ({ role, name, literal, target, refusal, anchor });

const FIXTURES: Fixture[] = [
    {
        what: 'List › List item, both carrying one', source: '- Queue the edit {.lead}\n- Send\n\n{.steps}\n', needle: 'Queue',
        current: s => part('current', 'List item', '{.lead}', nodePos(s, 'list_item', 'Queue'), 'line'), outer: () => part('outer', 'List', '{.steps}', 0, 'block'),
    },
    {
        what: 'List › List item, the item only', source: '- a {.i}\n- b\n', needle: 'a',
        current: s => part('current', 'List item', '{.i}', nodePos(s, 'list_item', 'a'), 'line'), outer: () => part('outer', 'List', null, 0, 'block'),
    },
    {
        what: 'List › List item, the list only', source: '- a\n- b\n\n{.l}\n', needle: 'a',
        current: s => part('current', 'List item', null, nodePos(s, 'list_item', 'a'), 'line'), outer: () => part('outer', 'List', '{.l}', 0, 'block'),
    },
    {
        what: 'List › List item, both bare', source: '- a\n- b\n', needle: 'b',
        current: s => part('current', 'List item', null, nodePos(s, 'list_item', 'b'), 'line'), outer: () => part('outer', 'List', null, 0, 'block'),
    },
    {
        what: 'a nested item: its List is the top-level one (F2)', source: '- a\n  - inner\n', needle: 'inner',
        current: s => part('current', 'List item', null, nodePos(s, 'list_item', 'inner'), 'line'),
        outer: () => part('outer', 'List', null, 0, 'block'),
    },
    {
        what: 'a list inside a quote: its List drawn, refused (F3)', source: '> - a\n> - b\n', needle: 'a',
        current: s => part('current', 'List item', null, nodePos(s, 'list_item', 'a'), 'line'),
        outer: () => part('outer', 'List', null, null, 'block', saidText(NESTED_LIST_ATTRS_REFUSAL)),
    },
    {
        // #8 review 1: before, the quote's literal was unreachable from its list (the refused List part stood outer).
        what: 'fail-first: a list inside a quote carrying one: Quote › List item, two parts', source: '> Intro\n>\n> - a\n> - b\n>\n> Outro\n> {.q}\n', needle: 'a',
        current: s => part('current', 'List item', null, nodePos(s, 'list_item', 'a'), 'line'), outer: () => part('outer', 'Quote', '{.q}', 0, 'block'),
    },
    {
        what: 'Quote › Heading, the quote carrying one', source: '> ## Sync rules {#sync-rules}\n> Text\n> {.warning}\n', needle: 'Sync',
        current: s => part('current', 'Heading', '{#sync-rules}', nodePos(s, 'heading'), 'line'), outer: () => part('outer', 'Quote', '{.warning}', 0, 'block'),
    },
    {
        what: 'Quote › Heading, the quote bare: no outer part', source: '> ## Sync rules {#sync-rules}\n> Text\n', needle: 'Sync',
        current: s => part('current', 'Heading', '{#sync-rules}', nodePos(s, 'heading'), 'line'), outer: () => null,
    },
    {
        what: 'Admonition › Heading, the heading carrying one: a title part', source: '!!! warning\n    ## Sync rules {#sync-rules}\n    Body\n', needle: 'Sync',
        current: s => part('current', 'Heading', '{#sync-rules}', nodePos(s, 'heading'), 'line'), outer: () => part('outer', 'Admonition', null, null, 'block'),
    },
    {
        what: 'Admonition › Heading, the heading bare: no outer part', source: '!!! warning\n    ## Sync rules\n    Body\n', needle: 'Sync',
        current: s => part('current', 'Heading', null, nodePos(s, 'heading'), 'line'), outer: () => null,
    },
    {
        what: 'Container › Heading (F4)', source: '::: note\n## Title {.h}\n:::\n', needle: 'Title',
        current: s => part('current', 'Heading', '{.h}', nodePos(s, 'heading'), 'line'), outer: () => part('outer', 'Container', null, null, 'block'),
    },
    {
        what: 'Quote › Bold', source: '> A **term**{.term} here\n> {.warning}\n', needle: 'term',
        current: s => part('current', 'Bold', '{.term}', `run ${nodePos(s, 'paragraph') + 3}`, 'run'), outer: () => part('outer', 'Quote', '{.warning}', 0, 'block'),
    },
    {
        what: 'Table › Bold', source: '| a | b |\n| - | - |\n| **x**{.k} | y |\n\n{.wide}\n', needle: 'x',
        current: s => part('current', 'Bold', '{.k}', `run ${nodePos(s, 'table_cell', 'x') + 1}`, 'run'), outer: () => part('outer', 'Table', '{.wide}', 0, 'block'),
    },
    {
        what: 'List item › Bold', source: '- a **term**{.t} {.lead}\n- b\n', needle: 'term',
        current: s => part('current', 'Bold', '{.t}', `run ${nodePos(s, 'paragraph') + 3}`, 'run'), outer: s => part('outer', 'List item', '{.lead}', nodePos(s, 'list_item', 'term'), 'line'),
    },
    {
        what: 'List item (bare) › Bold: the List carrying one', source: '- a **term**{.t}\n- b\n\n{.steps}\n', needle: 'term',
        current: s => part('current', 'Bold', '{.t}', `run ${nodePos(s, 'paragraph') + 3}`, 'run'), outer: () => part('outer', 'List', '{.steps}', 0, 'block'),
    },
    {
        what: 'a plain paragraph: one part', source: 'Text here.\n', needle: 'Text',
        current: () => part('current', 'Paragraph', null, 0, 'block'), outer: () => null,
    },
];

suite('Editor breadcrumb: one resolver for the bar and the menu (#8 step 2)', () => {
    for (const f of FIXTURES) {
        test(f.what, () => {
            const state = at(stateOf(f.source), f.needle);
            const crumbs = crumbsAt(state);
            assert.ok(crumbs !== null, 'crumbs');
            assert.deepStrictEqual(shape(crumbs.current), f.current(state), 'current');
            assert.deepStrictEqual(shape(crumbs.outer), f.outer(state), 'outer');
        });
    }

    test('fail-first: the bar and the menu agree — the bar\'s object is the menu\'s target, or holds it', () => {
        // Before #8, at `- a {.i}` under a list carrying `{.l}`, the bar was the list's ("List attributes")
        // while the menu said "Attributes of List item…" (wave0 row "Item + list").
        const items = [{ source: '- a {.i}\n- b\n{.l}\n', needle: 'a', what: 'Item + list' }, { source: '- a {.i}\n- b\n\n{.l}\n', needle: 'a', what: 'Item + list, a blank line' }];
        for (const f of [...FIXTURES, ...items]) {
            const state = at(stateOf(f.source), f.needle);
            const object = objectAtSelection(state);
            const target = attributesTargetAt(state);
            const crumbs = crumbsAt(state);
            if (object === null) {
                continue;
            }
            if (isMarkObject(object) || object.kind === 'image') {
                const inline = crumbs?.current.target;
                assert.ok(inline && 'object' in inline && sameObject(inline.object, object), `${f.what}: the inline part is the bar's object`);
            } else if (object.kind === 'admonition' || object.kind === 'container' || object.kind === 'table') {
                assert.ok('refusal' in target || (target.pos >= object.from && target.pos < object.to), `${f.what}: the menu's target lies in the ${object.kind}`);
            } else {
                assert.ok(!('refusal' in target), `${f.what}: ${'refusal' in target ? saidText(target.refusal) : ''}`);
                assert.strictEqual(object.from, target.pos, `${f.what}: the bar is the ${object.kind} at ${object.from}, the menu's target at ${target.pos}`);
                assert.strictEqual(object.node, target.node, f.what);
            }
        }
    });

    test('the menu\'s target: a heading in a quote is the heading, a quote\'s paragraph the quote, an admonition\'s paragraph refused', () => {
        const heading = at(stateOf('> ## Sync rules\n> Text\n'), 'Sync');
        const target = attributesTargetAt(heading);
        assert.ok(!('refusal' in target) && target.name === 'Heading');
        const paragraph = attributesTargetAt(at(stateOf('> ## Sync rules\n> Text\n'), 'Text'));
        assert.ok(!('refusal' in paragraph) && paragraph.name === 'Quote');
        assert.deepStrictEqual(attributesTargetAt(at(stateOf('!!! note\n    Body\n'), 'Body')), { refusal: ADMONITION_ATTRS_REFUSAL });
    });

    test('the Block type menu\'s two entries: the List after the item; no outer entry for an admonition\'s heading', () => {
        const item = blockPartsAt(at(stateOf('- a\n- b\n'), 'b'));
        assert.ok(!('refusal' in item.current) && item.current.name === 'List item');
        assert.strictEqual(item.outer?.name, 'List');
        assert.strictEqual(blockPartsAt(at(stateOf('Text.\n'), 'Text')).outer, null);
        assert.strictEqual(blockPartsAt(at(stateOf('!!! warning\n    ## Sync rules {#s}\n    Body\n'), 'Sync')).outer, null, 'the admonition keeps no literal: no entry');
        assert.strictEqual(blockPartsAt(at(stateOf('> - a\n> - b\n'), 'a')).outer?.refusal, NESTED_LIST_ATTRS_REFUSAL);
    });

    test('cached per state, and O(depth): the same parts for a 10- and a 1000-item list, read off the caret\'s ancestors only', () => {
        const count = (state: EditorState): { calls: number; value: unknown } => {
            const proto = ResolvedPos.prototype as unknown as { node(d?: number | null): Node };
            const original = proto.node;
            let calls = 0;
            proto.node = function (this: ResolvedPos, d?: number | null) {
                calls++;
                return original.call(this, d);
            };
            try {
                const value = crumbsAt(state);
                return { calls, value };
            } finally {
                proto.node = original;
            }
        };
        const list = (n: number) => Array.from({ length: n }, (_, k) => `- item ${k + 1}`).join('\n') + '\n\n{.steps}\n';
        const small = at(stateOf(list(10)), 'item 1', 2);
        const large = at(stateOf(list(1000)), 'item 1', 2);
        const a = count(small);
        const b = count(large);
        assert.ok(a.calls > 0 && a.calls === b.calls, `as many steps for 1000 items as for 10: ${a.calls} vs ${b.calls}`);
        assert.ok(a.calls <= 40, `a few steps per level: ${a.calls}`);
        const again = count(small);
        assert.strictEqual(again.value, a.value, 'the same answer');
        assert.strictEqual(again.calls, 0, 'from the cache: no step at all');
    });
});

/**
 * An open field's target through a host resync (#8 review 1): a resync that
 * replaces the target's block leaves its neighbour at the place, which is
 * never followed onto; one that only sets its markup keeps it (its changed
 * literal is the commit's to refuse); one that inserts above moves it.
 */
suite('Editor breadcrumb: a field\'s target through a resync (#8 review 1)', () => {
    /** The top-level block at `pos` of `text` as a target, and `next` as the resync turns it into. */
    const follow = (text: string, pos: number, next: string) => {
        const state = stateOf(text);
        const node = state.doc.nodeAt(pos) as Node;
        const target: AttributesTarget = { pos, node, name: 'Block' };
        const tr = resyncTransaction(state, stateOf(next).doc);
        const gone = followAll([target], [tr], tr.doc);
        return { gone: gone.has(target), target };
    };

    test('fail-first: a paragraph replaced by the resync is gone — the next paragraph is not followed onto', () => {
        assert.strictEqual(follow('Alpha {.a}\n\nBeta\n\nGamma\n', 0, 'Beta\n\nGamma\n').gone, true);
    });

    test('fail-first: a list replaced by the resync is gone — the next list is not followed onto', () => {
        assert.strictEqual(follow('- one\n- two\n\n{.steps}\n\n* three\n* four\n', 0, '* three\n* four\n').gone, true);
    });

    test('a markup-only change keeps the target, its node now carrying the other literal', () => {
        const { gone, target } = follow('- one\n- two\n\n{.steps}\n', 0, '- one\n- two\n\n{.other}\n');
        assert.strictEqual(gone, false);
        assert.strictEqual(target.pos, 0);
        assert.strictEqual(literalOf(target.node), '{.other}');
    });

    test('a paragraph inserted above moves the target; one inserted right at its place too', () => {
        const above = follow('Intro\n\n- one\n- two\n', 7, 'New\n\nIntro\n\n- one\n- two\n');
        assert.deepStrictEqual([above.gone, above.target.pos, above.target.node.type.name], [false, 12, 'bullet_list']);
        const first = follow('- one\n- two\n', 0, 'New\n\n- one\n- two\n');
        assert.deepStrictEqual([first.gone, first.target.pos, first.target.node.type.name], [false, 5, 'bullet_list']);
    });
});
