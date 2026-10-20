import * as assert from 'assert';
import { LANGUAGES } from '../../../src/editor/languages';

/**
 * The generated language list (`scripts/languages.mjs`) against the installed
 * highlight.js: the one place the derivation is checked. A bump that changes
 * the list fails here until `npm run languages` runs again.
 */
suite('Editor code blocks: the language list', () => {
    test('equals what the installed highlight.js highlights — ids, names, aliases', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const hljs = require('highlight.js') as { listLanguages(): string[]; getLanguage(id: string): { name?: string; aliases?: string[] } | undefined };
        const expected = hljs.listLanguages()
            .map(id => ({ id, name: hljs.getLanguage(id)?.name ?? id, aliases: [...(hljs.getLanguage(id)?.aliases ?? [])] }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        assert.deepStrictEqual(LANGUAGES.map(l => ({ ...l, aliases: [...l.aliases] })), expected);
    });
});
