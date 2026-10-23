import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Node } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { parseDocument } from '../../../src/editor/parse';
import { serializeDocument } from '../../../src/editor/serialize';
import { NOTE_NODES } from '../../../src/editor/schema';
import { LiteralObject, changeInlineLiteralTransaction } from '../../../src/editor/webview/objects';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine, replaceChild, topChildren, touched } from './helpers';

/**
 * Daniel's archive, read in place (#15 step 7, risk 1): never copied, edited
 * or committed. Skipped unless `MEP_ARCHIVE_ROOT` names it. Every Markdown file
 * holding a `{…}` glued to a note's or a sidebar's closing marker is parsed by
 * the host's engine; none of its blocks stays a source block for a note's
 * literal, it is written back byte for byte untouched, every block holding a
 * note literal is written back byte for byte when forced through its writer
 * — a difference is accepted only when the same one appears with the literals
 * taken out of both sides (a rewrap, a hard break's spelling), and listed —
 * and removing each literal and setting it again gives the file's bytes.
 */
const ROOT = process.env.MEP_ARCHIVE_ROOT;

/** What the plan's grep finds: a `{…}` right after `++`, `!!`, `$` or `@`. */
const GLUED = /(\+\+|!!|\$|@)\{[^}]*\}/;

/** The closing marker of each note kind, after which its literal is written. */
const CLOSING: Readonly<Record<string, string>> = { sidenote: '++', marginal_note: '!!', left_sidebar: '$', right_sidebar: '@' };

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

function write(parsed: { doc: Node; eol: '\n' | '\r\n'; tail: string }, doc = parsed.doc): string {
    return serializeDocument({ doc, eol: parsed.eol, tail: parsed.tail }, { defaultWrap: 90 });
}

/** Each note of `node` carrying a literal, with its position inside `node`. */
function noteLiterals(node: Node): { name: string; literal: string; pos: number; node: Node }[] {
    const out: { name: string; literal: string; pos: number; node: Node }[] = [];
    node.descendants((child, pos) => {
        if (NOTE_NODES.has(child.type.name) && typeof child.attrs.literal === 'string') {
            out.push({ name: child.type.name, literal: child.attrs.literal as string, pos, node: child });
        }
    });
    return out;
}

/** `text` with each note literal taken off the closing marker it is glued to, once each, in order. */
function stripped(text: string, notes: readonly { name: string; literal: string }[]): string {
    let out = text;
    let from = 0;
    for (const { name, literal } of notes) {
        const at = out.indexOf(CLOSING[name] + literal, from);
        if (at < 0) {
            return out;
        }
        out = out.slice(0, at + CLOSING[name].length) + out.slice(at + CLOSING[name].length + literal.length);
        from = at + CLOSING[name].length;
    }
    return out;
}

/** The first differing line of `a` and `b`, by line number, both sides. */
function firstDiff(a: string, b: string): string {
    const x = a.split('\n');
    const y = b.split('\n');
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] !== y[i]) {
            return `L${i + 1}: -${JSON.stringify(x[i])} +${JSON.stringify(y[i])}`;
        }
    }
    return 'none';
}

suite('Editor note attributes: Daniel\'s archive round-trips (gated, MEP_ARCHIVE_ROOT)', function () {
    this.timeout(120000);
    const files = ROOT && fs.existsSync(ROOT) ? markdownFiles(ROOT).filter(f => GLUED.test(fs.readFileSync(f, 'utf8'))) : [];

    suiteSetup(function () {
        if (!ROOT) {
            this.skip();
        }
    });

    test('every file with a glued {…}: no note literal keeps a block raw; byte-identical untouched, forced and after remove + set', () => {
        assert.ok(files.length > 0, `no file with a glued {…} under ${ROOT}`);
        const failures: string[] = [];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            const md = hostEngine();
            const name = path.relative(ROOT as string, file);
            const blocks = groupSourceBlocks(md.parse(src, {}), splitLines(src), definitionOf(md)).blocks;
            const raw = blocks.filter(b => b.kind === 'raw');
            const noteRaw = raw.filter(b => /attributes on (sidenote|marginal_note|left_sidebar|right_sidebar)_open/.test(b.reason));
            const parsed = parseDocument(md, src, {});
            const untouched = write(parsed) === src;
            const report = [`${name}: raw blocks ${raw.length} (${raw.map(b => b.reason).join('; ') || 'none'}), raw for a note literal ${noteRaw.length}, untouched ${untouched ? 'identical' : 'DIFFERS'}`];
            if (noteRaw.length > 0 || !untouched) {
                failures.push(report[0]);
            }
            const children = topChildren(parsed.doc);
            let offset = 0;
            const offsets = children.map(child => {
                const at = offset;
                offset += child.nodeSize;
                return at;
            });
            children.forEach((block, i) => {
                const notes = noteLiterals(block);
                if (notes.length === 0) {
                    return;
                }
                const line = src.slice(0, src.indexOf((block.attrs.src as string | null) ?? '\u0000')).split('\n').length;
                // (c) forced through the writer.
                const forced = write(parsed, replaceChild(parsed.doc, i, touched(block)));
                let verdict = 'identical';
                if (forced !== src) {
                    const bare = stripped(src, notes);
                    const bareParsed = parseDocument(md, bare, {});
                    const bareForced = write(bareParsed, replaceChild(bareParsed.doc, i, touched(topChildren(bareParsed.doc)[i])));
                    const same = stripped(forced, notes) === bareForced;
                    verdict = `${same ? 'differs as without the literals (accepted)' : 'DIFFERS'}: ${firstDiff(src, forced)}`;
                    if (!same) {
                        failures.push(`${name} block at L${line}: ${verdict}`);
                    }
                }
                // (d) each literal removed, then set again, through the field's transaction.
                const removedSet = notes.map(note => {
                    let state = EditorState.create({ doc: parsed.doc, plugins: editorPlugins() });
                    const at = offsets[i] + 1 + note.pos;
                    const object = (): LiteralObject => {
                        const node = state.doc.nodeAt(at) as Node;
                        return { kind: 'note', from: at, to: at + node.nodeSize, node };
                    };
                    const off = changeInlineLiteralTransaction(state, object(), '');
                    if (off === null) {
                        return `${note.literal}: removal refused`;
                    }
                    state = state.apply(off);
                    const on = changeInlineLiteralTransaction(state, object(), note.literal);
                    if (on === null) {
                        return `${note.literal}: setting it again refused`;
                    }
                    state = state.apply(on);
                    const out = write(parsed, state.doc);
                    // The edit writes the block by rule: its bytes are the forced rewrite's, accepted above or identical.
                    return out === src || (out === forced && verdict.includes('accepted')) ? null : `${note.literal}: ${firstDiff(src, out)}`;
                }).filter((r): r is string => r !== null);
                if (removedSet.length > 0) {
                    failures.push(`${name} block at L${line}: remove + set ${removedSet.join('; ')}`);
                }
                report.push(`  block at L${line} (${block.type.name}, ${notes.map(n => `${n.name} ${n.literal}`).join(', ')}): forced ${verdict}; remove + set ${removedSet.length > 0 ? removedSet.join('; ') : forced === src ? 'identical' : 'as forced'}`);
            });
            console.log(report.join('\n'));
        }
        assert.deepStrictEqual(failures, []);
    });
});
