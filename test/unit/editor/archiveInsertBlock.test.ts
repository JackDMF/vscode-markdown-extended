import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Node } from 'prosemirror-model';
import { undo } from 'prosemirror-history';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { parseDocument } from '../../../src/editor/parse';
import { serializeDocument } from '../../../src/editor/serialize';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { insertBlockTransaction } from '../../../src/editor/webview/toolbar/commands';
import { hostEngine, topChildren } from './helpers';

/**
 * Daniel's archive, read in place (Studienhilfe plan, MR 2, risk 2): never
 * copied, edited or committed. Skipped unless `MEP_ARCHIVE_ROOT` names it.
 * A Bible quote block as the Studienhilfe writes it (`bibeltext`: verse
 * marks, sidenotes) is inserted the way `insertBlock` inserts it — after the
 * first, the middle and the last block of every file, after every list and
 * after the first list, the first block a neighbour follows without a blank
 * line and the first followed by a blank line written otherwise (spaces on it,
 * a second one, another line ending) — into each file that the editor writes
 * back untouched. Each time the text differs from the file by added lines
 * only: a blank line and the block, and one blank line after it only where the
 * next block stood tight to the one before. The host's parse of it reads one block
 * more, the quote, written back unchanged; one undo gives the file's bytes.
 */
const ROOT = process.env.MEP_ARCHIVE_ROOT;

const QUOTE = [
    '> ## Römer 12:1-2 Probeeinfügung {.rbi8}',
    '> ^1^ Daher bitte ich euch inständig, Brüder, durch die Erbarmungen Gottes, eure Leiber als ein lebendiges, heiliges, für Gott annehmbares Schlachtopfer darzustellen, [das ist] ein heiliger Dienst++*|„Ein heiliger Dienst“. Gr.: latréian; J17(hebr.): ʽavōdhathchém, „euer Dienst (eure Verehrung, Anbetung)“. Siehe 2Mo 12:25, Fn.++ gemäß eurer Vernunft. ^2^ Und formt euch nicht mehr nach diesem System der Dinge++†|Od.: „[dieser] Ordnung der Dinge“. Gr.: aiṓni; lat.: saeculo.++, sondern werdet durch die Neugestaltung eures Sinnes umgewandelt, damit ihr durch Prüfung feststellen könnt, was der gute und annehmbare und vollkommene Wille Gottes ist.',
];

function markdownFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
            out.push(...markdownFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            out.push(full);
        }
    }
    return out;
}

function write(parsed: { eol: '\n' | '\r\n'; tail: string }, doc: Node): string {
    return serializeDocument({ doc, eol: parsed.eol, tail: parsed.tail }, { defaultWrap: 90 });
}

/**
 * How `written` differs from `src` when the quote went in: `'blank'` (a blank
 * line and the block), `'blank+after'` (and a blank line after it), or `null`
 * for any other difference. Lines are compared with their terminators, so a
 * file of mixed line endings is judged byte for byte too; a file without a
 * final line break may gain one on its last line, the block going after it.
 */
function addedOnly(src: string, written: string): 'blank' | 'blank+after' | null {
    const lines = written.split(/(?<=\n)/);
    const blank = (line: string | undefined) => line === '\n' || line === '\r\n';
    const bare = (line: string) => line.replace(/\r?\n$/, '');
    // A file without a final line break gains one where the block goes after its last line.
    const same = (text: string) => text === src || (!src.endsWith('\n') && (text === `${src}\n` || text === `${src}\r\n`));
    for (let j = 1; j + QUOTE.length <= lines.length; j++) {
        if (!blank(lines[j - 1]) || !QUOTE.every((q, k) => bare(lines[j + k]) === q)) {
            continue;
        }
        const without = [...lines.slice(0, j - 1), ...lines.slice(j + QUOTE.length)];
        if (same(without.join(''))) {
            return 'blank';
        }
        if (blank(without[j - 1]) && same([...without.slice(0, j - 1), ...without.slice(j)].join(''))) {
            return 'blank+after';
        }
    }
    return null;
}

suite('Editor insertBlock: Daniel\'s archive takes a quote block line for line (gated, MEP_ARCHIVE_ROOT)', function () {
    // About 20 000 insertions, each parsed again: minutes.
    this.timeout(1800000);

    suiteSetup(function () {
        if (!ROOT || !fs.existsSync(ROOT)) {
            this.skip();
        }
    });

    test('after the first, middle and last block, a list, a tight seam, an odd blank line: added lines only, one block more on the host\'s parse, one undo gives the bytes', () => {
        const files = markdownFiles(ROOT as string);
        assert.ok(files.length > 0);
        const md = hostEngine();
        const failures: string[] = [];
        let skipped = 0;
        let inserts = 0;
        let tight = 0;
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            const name = path.relative(ROOT as string, file);
            const parsed = parseDocument(md, src, {});
            if (write(parsed, parsed.doc) !== src) {
                // Not this check's business: the archive round-trip suites judge files the editor rewrites.
                skipped++;
                continue;
            }
            const children = topChildren(parsed.doc);
            if (children.length === 0) {
                continue;
            }
            // The first, middle and last block, and the first of each seam that matters: a list, a
            // neighbour tight to the block before, a blank line written otherwise than as one line break.
            const at = new Set([0, Math.floor(children.length / 2), children.length - 1]);
            for (const kind of [
                (child: Node) => /_list$/.test(child.type.name),
                (_child: Node, next: Node | undefined) => next?.attrs.gap === '',
                (_child: Node, next: Node | undefined) => typeof next?.attrs.gap === 'string' && next.attrs.gap !== '' && next.attrs.gap !== parsed.eol,
            ]) {
                const i = children.findIndex((child, k) => kind(child, children[k + 1]));
                if (i >= 0) {
                    at.add(i);
                }
            }
            const offsets: number[] = [];
            let offset = 0;
            for (const child of children) {
                offsets.push(offset);
                offset += child.nodeSize;
            }
            for (const i of at) {
                inserts++;
                const where = `${name} after block ${i} (${children[i].type.name})`;
                let state = EditorState.create({ doc: parsed.doc, plugins: editorPlugins() });
                state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, offsets[i])));
                const inserted = insertBlockTransaction(state, QUOTE.join('\n'), parsed.eol);
                if (inserted === null) {
                    failures.push(`${where}: refused`);
                    continue;
                }
                const after = state.apply(inserted.tr);
                const written = write(parsed, after.doc);
                const diff = addedOnly(src, written);
                if (diff === null) {
                    failures.push(`${where}: not added lines only`);
                    continue;
                }
                if (diff === 'blank+after') {
                    tight++;
                }
                const reparsed = parseDocument(md, written, {});
                const quote = reparsed.doc.childCount > i + 1 ? reparsed.doc.child(i + 1) : null;
                if (reparsed.doc.childCount !== children.length + 1 || quote?.type.name !== 'blockquote') {
                    failures.push(`${where}: the host's parse reads ${reparsed.doc.childCount - children.length} blocks more, ${quote?.type.name ?? 'none'} where the quote went`);
                }
                if (write(reparsed, reparsed.doc) !== written) {
                    failures.push(`${where}: the host's parse is not written back unchanged`);
                }
                let undone = after;
                undo(after, tr => {
                    undone = after.apply(tr);
                });
                if (write(parsed, undone.doc) !== src) {
                    failures.push(`${where}: undo does not give the file's bytes`);
                }
            }
        }
        console.log(`insertBlock over the archive: ${files.length} files, ${skipped} rewritten by the editor (not judged), ${inserts} insertions, ${tight} with a blank line after for a tight neighbour, ${failures.length} failures`);
        assert.deepStrictEqual(failures.slice(0, 40), []);
    });
});
