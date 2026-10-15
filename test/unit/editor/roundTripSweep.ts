import { Mark, Node } from 'prosemirror-model';
import { parseDocument, serializeDocument } from '../../../src/editor';
import { editorSchema as S } from '../../../src/editor/schema';
import { DEFAULT_INLINE_ENGINE, attrsEngineFor, currentInlineDefinition } from '../../../src/editor/inlineEngine';
import { literalNotReadBack, setInlineEngine } from '../../../src/editor/serialize';
import { touched } from './helpers';

/**
 * The brute-force round trip of inline formatting: runs of text side by side,
 * each with a set of marks from a pool and literals placed on them, written by
 * the save, parsed again by the real engine, and compared with the model — so
 * the save's own verdict (`literalNotReadBack`) is held to what the parser
 * does, case by case: a case it lets through must read back as the model, and
 * a case it refuses must not. The full sweep is `test/sweep/inlineRoundTrip.ts`;
 * the unit suite runs a fixed subset (`roundTripSweep.test.ts`).
 */

/** The marks a run may carry, each with the attributes it is made with. */
const POOL: readonly [string, Record<string, unknown>][] = [
    ['em', { markup: '*' }], ['em', { markup: '_' }], ['strong', { markup: '**' }], ['strong', { markup: '__' }],
    ['strike', {}], ['sub', {}], ['sup', {}], ['mark', {}], ['code', {}], ['kbd', {}], ['attr_span', {}], ['link', { href: 'u', title: null }],
];

const takesLiteral = (name: string) => S.marks[name].spec.attrs !== undefined && 'literal' in (S.marks[name].spec.attrs ?? {});

/** Every set of one or two marks of different types from the pool, by their indices. */
function markSets(): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < POOL.length; i++) {
        out.push([i]);
        for (let j = i + 1; j < POOL.length; j++) {
            if (POOL[i][0] !== POOL[j][0]) {
                out.push([i, j]);
            }
        }
    }
    return out;
}

function marksOf(indices: readonly number[], literals: Readonly<Record<number, string>>): Mark[] {
    return indices.map(i => {
        const [name, attrs] = POOL[i];
        const a: Record<string, unknown> = { ...attrs };
        if (name === 'attr_span') {
            a.literal = literals[i] ?? '{.s}';
        } else if (takesLiteral(name)) {
            a.literal = literals[i] ?? null;
        }
        return S.marks[name].create(a);
    });
}

/** One case: the runs' texts with their mark sets, and the literals placed, by run and pool index. */
export interface SweepCase {
    runs: { text: string; marks: number[] }[];
    literals: { run: number; mark: number; literal: string }[];
}

/**
 * The two-run cases: every pair of mark sets, without a literal, with one on a
 * mark of the second run, or of the first — over `texts`: by default text the
 * typographer rewrites, or two words (`foo`, `abc`: `foo_abc_{.x}` glues the
 * delimiter to a letter).
 */
export function* twoRunCases(texts: readonly [string, string] = ["don't", 'a...(c)']): Generator<SweepCase> {
    const sets = markSets();
    for (const a of sets) {
        for (const b of sets) {
            const runs = [{ text: texts[0], marks: a }, { text: texts[1], marks: b }];
            yield { runs, literals: [] };
            for (const i of b) {
                if (takesLiteral(POOL[i][0])) {
                    yield { runs, literals: [{ run: 1, mark: i, literal: '{.x}' }] };
                }
            }
            for (const i of a) {
                if (takesLiteral(POOL[i][0])) {
                    yield { runs, literals: [{ run: 0, mark: i, literal: '{.y}' }] };
                }
            }
        }
    }
}

/** The three-run cases, over the delimiter marks: one literal on the second or third run, or two of a kind on the first and third. */
export function* threeRunCases(): Generator<SweepCase> {
    const pool = [0, 2, 4, 5, 6, 7, 8, 9];
    const sets: number[][] = [];
    for (let i = 0; i < pool.length; i++) {
        sets.push([pool[i]]);
        for (let j = i + 1; j < pool.length; j++) {
            sets.push([pool[i], pool[j]]);
        }
    }
    const texts = ['foo', 'bar', 'baz'];
    for (const a of sets) {
        for (const b of sets) {
            for (const c of sets) {
                const runs = [a, b, c].map((marks, r) => ({ text: texts[r], marks }));
                for (let r = 1; r < 3; r++) {
                    for (const i of runs[r].marks) {
                        yield { runs, literals: [{ run: r, mark: i, literal: '{.x}' }] };
                    }
                }
                for (const i of a) {
                    if (c.includes(i)) {
                        yield { runs, literals: [{ run: 0, mark: i, literal: '{.y}' }, { run: 2, mark: i, literal: '{.x}' }] };
                    }
                }
            }
        }
    }
}

/**
 * A paragraph's inline content as the comparison sees it: each character that
 * is not white space with the marks it carries — type, literal, address. White
 * space is the writer's to move, emphasis' delimiter the writer's to choose.
 * With `typographed`, the text typed again where the typographer replaced it:
 * a read with the typographer on is compared with the model as typed.
 */
function signature(p: Node, typographed = false): string {
    const out: string[] = [];
    p.descendants(child => {
        if (!child.isText) {
            return;
        }
        const key = child.marks.map(m => `${m.type.name}${m.attrs.literal ?? ''}${m.attrs.href ? `<${String(m.attrs.href)}>` : ''}`).sort().join('+');
        for (const ch of typographed ? asTyped(child.text ?? '') : child.text ?? '') {
            if (/\S/.test(ch)) {
                out.push(`${ch}[${key}]`);
            }
        }
    });
    return out.join(' ');
}

/** What markdown-it's typographer makes of what the cases type, typed again. */
const TYPOGRAPHED: Readonly<Record<string, string>> = { '’': '\'', '‘': '\'', '“': '"', '”': '"', '…': '...', '©': '(c)', '–': '--', '—': '---' };

function asTyped(text: string): string {
    return [...text].map(ch => TYPOGRAPHED[ch] ?? ch).join('');
}

/** What the save does with a case: what it writes, whether its verdict refuses it, and whether the written text reads back as the model. */
export interface Judged {
    written: string;
    refused: boolean;
    readsBack: boolean;
}

/** The case judged, or `null` where the schema refuses its marks together. */
export function judge(c: SweepCase): Judged | null {
    let p: Node;
    try {
        const content = c.runs.map((run, r) => S.text(run.text, marksOf(run.marks, Object.fromEntries(c.literals.filter(l => l.run === r).map(l => [l.mark, l.literal])))));
        p = touched(S.nodes.paragraph.create(null, [S.text('A '), ...content, S.text(' y.')]));
        p.check();
    } catch {
        return null;
    }
    const written = serializeDocument({ doc: S.nodes.doc.create(null, [p]), eol: '\n', tail: '' }, { defaultWrap: 400 }).trim();
    const refused = literalNotReadBack(p) !== null;
    // Read back by an engine of the verdict's own definition, the typographer as it is set: the sweep can contradict it.
    const definition = currentInlineDefinition();
    const first = parseDocument(attrsEngineFor(definition), `${written}\n`, {}, definition).doc.child(0);
    const readsBack = first.type.name === 'paragraph' && signature(first, definition.typographer) === signature(S.nodes.paragraph.create(null, p.content));
    return { written, refused, readsBack };
}

/** A sweep's tally: the cases judged, refused, let through though they read back otherwise, and refused though they read back. */
export interface Tally {
    cases: number;
    refused: number;
    corrupt: string[];
    overRefused: string[];
}

/** Every `every`-th case of `cases` judged (`judge`), from the `offset`-th, the page's engine with the typographer on or off. */
export function sweep(cases: Iterable<SweepCase>, every = 1, offset = 0, typographer = false): Tally {
    // With VS Code's typographer on, the page's engine rewrites quotes and dashes: the verdict must not take that for a loss.
    setInlineEngine({ ...DEFAULT_INLINE_ENGINE, typographer });
    try {
        return sweepWith(cases, every, offset);
    } finally {
        setInlineEngine(DEFAULT_INLINE_ENGINE);
    }
}

function sweepWith(cases: Iterable<SweepCase>, every: number, offset: number): Tally {
    const tally: Tally = { cases: 0, refused: 0, corrupt: [], overRefused: [] };
    let k = 0;
    for (const c of cases) {
        if ((k++ - offset) % every !== 0) {
            continue;
        }
        const judged = judge(c);
        if (judged === null) {
            continue;
        }
        tally.cases++;
        tally.refused += judged.refused ? 1 : 0;
        if (!judged.refused && !judged.readsBack) {
            tally.corrupt.push(judged.written);
        }
        if (judged.refused && judged.readsBack) {
            tally.overRefused.push(judged.written);
        }
    }
    return tally;
}
