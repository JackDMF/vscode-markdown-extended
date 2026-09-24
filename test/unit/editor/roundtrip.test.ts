import * as assert from 'assert';
import { parseDocument, serializeDocument } from '../../../src/editor';
import { conformanceDocument, constructsFixture, hostEngine, readText, toCrlf } from './helpers';

/**
 * An untouched document leaves the editor byte for byte: every block is
 * emitted from its source slice. Run over Req Explorer's conformance documents
 * (every construct that corpus authors) and this repository's own fixture
 * (every construct this extension renders), in both line-ending styles.
 */
suite('Editor round trip', () => {
    const md = hostEngine();
    const options = { defaultWrap: 90 };

    const cases: Array<{ name: string; file: string; present: boolean }> = [
        { name: 'FR-CON.md', ...conformanceDocument('FR-CON.md') },
        { name: 'FR-CON.de.md', ...conformanceDocument('FR-CON.de.md') },
        { name: 'constructs.md', file: constructsFixture, present: true },
    ];

    for (const c of cases) {
        const why = c.present ? '' : ` — skipped: not found at ${c.file} (set REQ_EXPLORER_ROOT)`;

        test(`${c.name} round-trips byte for byte${why}`, function () {
            if (!c.present) {
                this.skip();
            }
            const text = readText(c.file);
            assert.strictEqual(serializeDocument(parseDocument(md, text), options), text);
        });

        test(`${c.name} round-trips byte for byte with CRLF line endings${why}`, function () {
            if (!c.present) {
                this.skip();
            }
            const text = toCrlf(readText(c.file));
            const parsed = parseDocument(md, text);
            assert.strictEqual(parsed.eol, '\r\n');
            assert.strictEqual(serializeDocument(parsed, options), text);
        });
    }

    test('a document without a final newline, and one of blank lines only, round-trip', () => {
        for (const text of ['# Title\n\nLast line', '\n\n\n', '', 'one\r\ntwo\rthree\n']) {
            assert.strictEqual(serializeDocument(parseDocument(md, text), options), text);
        }
    });
});
