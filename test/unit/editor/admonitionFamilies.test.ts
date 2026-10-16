import * as assert from 'assert';
import * as path from 'path';
import { ADMONITION_FAMILIES, ADMONITION_TYPES } from '../../../src/syntax/markers';
import { readText, repoRoot } from './helpers';

/**
 * The admonition types by look (`ADMONITION_FAMILIES`): the plugin's list is
 * the families flattened, and an alias is one because the stylesheet says so —
 * a selector list there names it with its canonical type.
 */
suite('Admonition families: the plugin\'s types grouped as the stylesheet draws them', () => {
    test('flattened, the families are the plugin\'s list, in its order', () => {
        assert.deepStrictEqual([...ADMONITION_TYPES], [
            'note',
            'summary', 'abstract', 'tldr',
            'info', 'todo',
            'tip', 'hint',
            'success', 'check', 'done',
            'question', 'help', 'faq',
            'warning', 'attention', 'caution',
            'failure', 'fail', 'missing',
            'danger', 'error', 'bug',
            'example', 'snippet',
            'quote', 'cite',
        ]);
        assert.strictEqual(ADMONITION_FAMILIES.length, 11);
        assert.strictEqual(ADMONITION_FAMILIES.flatMap(f => f.aliases).length, 16);
    });

    test('every alias shares a selector list with its canonical type in markdown-it-admonition.css', () => {
        const css = readText(path.join(repoRoot, 'styles', 'markdown-it-admonition.css'));
        const lists = css.split('{').map(chunk => chunk.slice(chunk.lastIndexOf('}') + 1).split(',').map(s => s.trim()));
        const names = (selectors: string[]) => new Set(selectors.map(s => /^\.admonition\.([\w-]+)/.exec(s)?.[1]).filter((n): n is string => n !== undefined));
        for (const family of ADMONITION_FAMILIES) {
            for (const alias of family.aliases) {
                assert.ok(lists.some(list => {
                    const named = names(list);
                    return named.has(alias) && named.has(family.type);
                }), `${alias} is drawn as ${family.type}`);
            }
        }
        const canonical = new Set(ADMONITION_FAMILIES.map(f => f.type));
        const known = new Set(ADMONITION_FAMILIES.flatMap(f => [f.type, ...f.aliases]));
        for (const list of lists) {
            const named = [...names(list)];
            assert.ok(named.filter(n => canonical.has(n)).length <= 1, `one look per selector list: ${named.join(', ')}`);
            assert.deepStrictEqual(named.filter(n => !known.has(n)), [], 'every type the stylesheet draws belongs to a family');
        }
    });
});
