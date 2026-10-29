import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { Token } from '../../../src/@types/markdown-it';
import { groupSourceBlocks, splitLines } from '../../../src/editor/blocks';
import { inPlaceEnv } from '../../../src/editor/footnoteEngine';
import { definitionOf } from '../../../src/editor/inlineEngine';
import { parseDocument } from '../../../src/editor/parse';
import { serializeDocument } from '../../../src/editor/serialize';
import { EditorState } from 'prosemirror-state';
import { sortFootnotesTransaction } from '../../../src/editor/webview/footnotes';
import { editorPlugins } from '../../../src/editor/webview/plugins';
import { hostEngine, replaceChild, topChildren, touched } from './helpers';

/**
 * Daniel's archive, read in place (wave 4 #5b, plan section 11): never copied,
 * edited or committed. Skipped unless `MEP_ARCHIVE_ROOT` names it. Every
 * Markdown file holding `[^` or `^[` is parsed by the host's engine; none of
 * its blocks stays a source block for a footnote (AC1), it is written back
 * byte for byte untouched, every block holding a reference is written back
 * byte for byte when forced through its writer — a difference is accepted only
 * when the same one appears with the references taken out of both sides (a
 * list's indentation, a table's padding), and listed — and every entry forced
 * is its source, or differs only by a character reference written as its
 * character (R2, listed).
 */
const ROOT = process.env.MEP_ARCHIVE_ROOT;

/** What the plan's grep finds: a reference or a definition, or an inline footnote. */
const FOOTNOTE_SYNTAX = /\[\^|\^\[/;

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

/** The footnote tokens the engine reads in `src` in place: references and inline footnotes, and definitions. */
function footnoteTokens(tokens: readonly Token[]): { refs: number; inline: number; definitions: number } {
    const count = { refs: 0, inline: 0, definitions: 0 };
    for (const t of tokens) {
        count.definitions += t.type === 'footnote_reference_open' ? 1 : 0;
        for (const child of t.children ?? []) {
            if (child.type === 'footnote_ref') {
                const label = (child.meta as { label?: unknown } | null)?.label;
                count[typeof label === 'string' ? 'refs' : 'inline']++;
            }
        }
    }
    return count;
}

/** The references (`[^x]`, `^[…]`) `node` holds. */
function references(node: Node): number {
    let n = 0;
    node.descendants(child => {
        n += child.type.name === 'footnote_ref' ? 1 : 0;
    });
    return n;
}

/** `doc` with the references of its top-level block `index` taken out (as atoms: a `^[` that is a superscript's stays), and their spellings in order. */
function withoutReferences(doc: Node, index: number): { doc: Node; spellings: string[] } {
    let start = 0;
    for (let k = 0; k < index; k++) {
        start += doc.child(k).nodeSize;
    }
    const found: { pos: number; size: number; spelling: string }[] = [];
    doc.child(index).descendants((child, pos) => {
        if (child.type.name === 'footnote_ref') {
            found.push({ pos: start + 1 + pos, size: child.nodeSize, spelling: child.attrs.label !== null ? `[^${child.attrs.label as string}]` : `^[${child.attrs.source as string}]` });
        }
    });
    const tr = new Transform(doc);
    for (const atom of [...found].reverse()) {
        tr.delete(atom.pos, atom.pos + atom.size);
    }
    return { doc: tr.doc, spellings: found.map(f => f.spelling) };
}

/** `text` with each of `spellings` taken out once, in order: what the writer wrote for the references, verbatim. */
function withoutSpellings(text: string, spellings: readonly string[]): string {
    let out = text;
    let from = 0;
    for (const spelling of spellings) {
        const at = out.indexOf(spelling, from);
        if (at < 0) {
            return out;
        }
        out = out.slice(0, at) + out.slice(at + spelling.length);
        from = at;
    }
    return out;
}

/**
 * A changed paragraph's own rewrites, which an entry's text gets as any other (R2): a character
 * reference as its character, `[` and `]` escaped, a hard break's spelling, the lines wrapped
 * anew — the same text.
 */
function sameText(a: string, b: string): boolean {
    // A line's prefix (indentation, a quote's `>`) goes with the line break it follows: a rewrap moves both.
    const plain = (t: string) => decoded(t).replace(/\\([[\]\\])/g, '$1').replace(/ {2}(?=\n)|\\(?=\n)/g, '').replace(/\n[ \t>]*/g, ' ').replace(/\s+/g, ' ').trim();
    return plain(a) === plain(b);
}

/** `text` with each character reference as its character, as a touched paragraph writes it (R2); nothing else changed. */
function decoded(text: string): string {
    return text.replace(/&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);/g, e => hostEngine().utils.unescapeAll(e));
}

/** The first differing line of `a` and `b`, by line number, both sides. */
function firstDiff(a: string, b: string): string {
    const x = a.split('\n');
    const y = b.split('\n');
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (x[i] !== y[i]) {
            return `L${i + 1}: -${JSON.stringify(x[i]?.slice(0, 120))} +${JSON.stringify(y[i]?.slice(0, 120))}`;
        }
    }
    return 'none';
}

suite('Editor footnotes: Daniel\'s archive round-trips (gated, MEP_ARCHIVE_ROOT)', function () {
    this.timeout(180000);
    const files = ROOT && fs.existsSync(ROOT) ? markdownFiles(ROOT).filter(f => FOOTNOTE_SYNTAX.test(fs.readFileSync(f, 'utf8'))) : [];

    suiteSetup(function () {
        if (!ROOT) {
            this.skip();
        }
    });

    test('every file with a footnote: no source block for a footnote, byte-identical untouched, forced as without its references, entries as written', () => {
        assert.ok(files.length > 0, `no file with [^ or ^[ under ${ROOT}`);
        const failures: string[] = [];
        const totals = { files: 0, withTokens: 0, refs: 0, inline: 0, definitions: 0, blocks: 0, forcedSame: 0, forcedAccepted: 0, entries: 0, entriesSame: 0, entriesEntities: 0, entriesRewritten: 0 };
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            const md = hostEngine();
            const name = path.relative(ROOT as string, file);
            const tokens = md.parse(src, inPlaceEnv());
            const found = footnoteTokens(tokens);
            totals.files++;
            totals.withTokens += found.refs + found.inline + found.definitions > 0 ? 1 : 0;
            totals.refs += found.refs;
            totals.inline += found.inline;
            totals.definitions += found.definitions;
            const raw = groupSourceBlocks(tokens, splitLines(src), definitionOf(md)).blocks.filter(b => b.kind === 'raw');
            const footnoteRaw = raw.filter(b => /footnote/.test(b.reason));
            const parsed = parseDocument(md, src, {});
            const untouched = write(parsed) === src;
            const report = [`${name}: references ${found.refs}, inline ${found.inline}, definitions ${found.definitions}; raw blocks ${raw.length} (${raw.map(b => b.reason).join('; ') || 'none'}), for a footnote ${footnoteRaw.length}; untouched ${untouched ? 'identical' : 'DIFFERS'}`];
            if (footnoteRaw.length > 0 || !untouched) {
                failures.push(report[0]);
            }
            const children = topChildren(parsed.doc);
            children.forEach((block, i) => {
                const entry = block.type.name === 'footnote_entry';
                if (!entry && references(block) === 0) {
                    return;
                }
                const line = src.slice(0, src.indexOf((block.attrs.src as string | null) ?? '\u0000')).split('\n').length;
                const forced = write(parsed, replaceChild(parsed.doc, i, touched(block)));
                let verdict = 'identical';
                if (entry) {
                    totals.entries++;
                    if (forced === src) {
                        totals.entriesSame++;
                    } else if (decoded(forced) === decoded(src)) {
                        totals.entriesEntities++;
                        verdict = `character references written as characters (R2, accepted): ${firstDiff(src, forced)}`;
                    } else if (sameText(forced, src)) {
                        totals.entriesRewritten++;
                        verdict = `the same text, escaped or wrapped anew as a changed paragraph is (R2, accepted): ${firstDiff(src, forced)}`;
                    } else {
                        verdict = `DIFFERS: ${firstDiff(src, forced)}`;
                        failures.push(`${name} entry at L${line}: ${verdict}`);
                    }
                } else {
                    totals.blocks++;
                    if (forced === src) {
                        totals.forcedSame++;
                    } else {
                        // The same block forced with the references taken out of both sides: what the writer does anyway.
                        const bare = withoutReferences(parsed.doc, i);
                        const bareForced = write(parsed, replaceChild(bare.doc, i, touched(bare.doc.child(i))));
                        const rest = withoutSpellings(forced, bare.spellings);
                        // Exactly as without them, or the same text wrapped anew there: a reference's width moves a line break.
                        const same = rest === bareForced || sameText(rest, bareForced);
                        verdict = `${same ? `differs as without the references (accepted${rest === bareForced ? '' : ', wrapped anew'})` : 'DIFFERS'}: ${firstDiff(src, forced)}`;
                        if (same) {
                            totals.forcedAccepted++;
                        } else {
                            failures.push(`${name} block at L${line}: ${verdict}`);
                        }
                    }
                }
                if (verdict !== 'identical') {
                    report.push(`  ${entry ? 'entry' : 'block'} at L${line} (${block.type.name}): forced ${verdict}`);
                }
            });
            console.log(report.join('\n'));
        }
        console.log(`archive footnotes: ${JSON.stringify(totals)}`);
        assert.deepStrictEqual(failures, []);
    });

    test('`^21^[Lass dich …]{class=unused}` (S-34-65) is a superscript and a span, no footnote; S312\'s `^[od. …], wo … Anleitung^` a superscript', () => {
        const read = (needle: RegExp) => {
            const file = files.find(f => needle.test(f));
            assert.ok(file, `${needle} under ${ROOT}`);
            return fs.readFileSync(file, 'utf8');
        };
        const md = hostEngine();
        const s34 = read(/S-34-65/);
        assert.ok(s34.includes('^21^['), 'the S-34-65 shape is there');
        assert.deepStrictEqual(footnoteTokens(md.parse(s34, inPlaceEnv())), { refs: 0, inline: 0, definitions: 0 });
        const s312 = read(/S312-tk22-X_04/);
        const line64 = s312.split('\n')[63];
        assert.ok(/\^\[od\./.test(line64), `L64 is the shape: ${line64.slice(0, 80)}`);
        const tokens = md.parse(line64, inPlaceEnv());
        const children = tokens.flatMap(t => t.children ?? []);
        assert.ok(children.some(c => c.type === 'sup_open') && !children.some(c => c.type === 'footnote_ref'), 'a superscript, no footnote');
    });

    test('Sort footnotes on a copy in memory: only definition lines move, as whole blocks; the set of lines is the same', () => {
        let sorted = 0;
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            const parsed = parseDocument(hostEngine(), src, {});
            const state = EditorState.create({ doc: parsed.doc, plugins: editorPlugins(() => true) });
            const tr = sortFootnotesTransaction(state);
            if (tr === null) {
                continue;
            }
            sorted++;
            const out = write(parsed, state.apply(tr).doc);
            const name = path.relative(ROOT as string, file);
            const lines = (t: string) => t.split('\n').filter(l => l.trim() !== '');
            assert.deepStrictEqual([...lines(out)].sort(), [...lines(src)].sort(), `${name}: the same lines`);
            const definitionLines = (t: string) => lines(t).filter((_l, i, all) => !all.slice(0, i + 1).some(x => x.startsWith('[^')));
            assert.deepStrictEqual(definitionLines(out), definitionLines(src), `${name}: everything before the first definition stays in place`);
            const blocks = (t: string) => t.slice(t.indexOf('\n[^') + 1).split(/\n(?=\[\^)/).map(b => b.trimEnd()).sort();
            assert.deepStrictEqual(blocks(out), blocks(src), `${name}: each definition moved whole`);
            console.log(`${name}: sorted, ${blocks(src).length} definitions moved as whole blocks`);
        }
        assert.ok(sorted > 0, 'a file whose footnotes are out of order');
    });
});

