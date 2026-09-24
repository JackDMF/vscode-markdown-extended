import * as assert from 'assert';
import { EMPHASIS_TAGS, editorSchema } from '../../../src/editor/schema';
import { hostEngine } from './helpers';

/** The element a mark's `toDOM` opens, for a mark carrying `markup`. */
function schemaTag(markName: 'em' | 'strong', markup: string): string {
    const type = editorSchema.marks[markName];
    const spec = type.spec.toDOM?.(type.create({ markup }), true) as unknown as [string];
    return spec[0];
}

/**
 * `markdown-it-ib` renders the four emphasis delimiters as four elements, and a
 * stylesheet can tell them apart; the editor draws each as the preview does.
 * The engine is the authority, so each case is read from it rather than stated.
 */
suite('Editor schema: emphasis is drawn as the engine renders it', () => {
    test('the engine renders *a* _b_ **c** __d__ as <i>, <em>, <b>, <strong>', () => {
        assert.strictEqual(hostEngine().renderInline('*a* _b_ **c** __d__'), '<i>a</i> <em>b</em> <b>c</b> <strong>d</strong>');
    });

    for (const [markName, markup] of [['em', '*'], ['em', '_'], ['strong', '**'], ['strong', '__']] as const) {
        test(`${markName} with markup ${markup} is drawn as the element the engine renders ${markup}x${markup} as`, () => {
            const rendered = /^<(\w+)>x<\/\1>$/.exec(hostEngine().renderInline(`${markup}x${markup}`));
            assert.ok(rendered, 'the engine renders the delimiter as one element');
            assert.strictEqual(schemaTag(markName, markup), rendered[1]);
            assert.strictEqual(EMPHASIS_TAGS[markup], rendered[1]);
        });
    }

    test('each element is read back as its own delimiter', () => {
        const rules = (['em', 'strong'] as const).flatMap(name => (editorSchema.marks[name].spec.parseDOM ?? [])
            .map(rule => ({ mark: name, tag: (rule as { tag?: string }).tag, markup: (rule.attrs as { markup?: string } | undefined)?.markup })));
        assert.deepStrictEqual(rules, [
            { mark: 'em', tag: 'i', markup: '*' },
            { mark: 'em', tag: 'em', markup: '_' },
            { mark: 'strong', tag: 'b', markup: '**' },
            { mark: 'strong', tag: 'strong', markup: '__' },
        ]);
    });
});
