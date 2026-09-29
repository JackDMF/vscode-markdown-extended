import { Document, isAlias, isMap, isScalar, isSeq, Pair, parseDocument, Scalar, visit } from 'yaml';

/**
 * The front matter as properties: read from the YAML, written back **in place**.
 *
 * Pure — no DOM, no `vscode` — so the page (`webview/properties.ts`) and the
 * tests load the same lines. The page edits the front matter's `src`; this
 * module says what the YAML holds and returns the new text for one edit.
 *
 * **In place, not round-tripped.** The YAML is parsed with the `yaml` package's
 * `parseDocument`, which gives every node its offsets in the text, and an edit
 * replaces exactly the characters of the node it changes — a scalar's value, a
 * list item's line, a pair's lines — and nothing else. The document is never
 * written back through a dumper: key order, comments, quoting style, anchors,
 * blank lines and indentation of every key not edited stay byte for byte, and
 * so does the edited key's own line around its value (a trailing comment, an
 * anchor before it). Line endings are the file's: an added line is terminated
 * with the `eol` the caller passes, read from the front matter itself.
 *
 * **Typing from the value, not from a schema.** Each top-level key is one
 * property, and its kind is read from its value:
 *
 * - a scalar that is `true` or `false` (any case YAML reads as a boolean) — `boolean`, a checkbox;
 * - `uid`, or a key ending in `uid` or `id` whose value is a UUID — `id`, read-only;
 * - a string that is a date, `YYYY-MM-DD` — `date`;
 * - `lang` — `choice`, a text field offering the values `lang` has anywhere in the file;
 * - any other one-line scalar (a string, a number, an empty value) — `text`;
 * - a sequence whose items are all one-line scalars — `list`, chips, in its own
 *   style: a flow sequence (`[a, b]`) stays flow, a block one (`- a`) block;
 * - anything else — a map, a sequence holding a map or a list, a multi-line
 *   string, an alias — `source`: one row saying what it holds, whose value is
 *   edited as YAML in the block's source.
 *
 * No enumeration is guessed from values beyond `lang` (`ENUMERATED_KEYS`), and no
 * schema is read: the hook for one — an extension saying what a key is — is a
 * later step (ARCHITECTURE.md, *Properties*).
 */

/** How a property is shown and edited. */
export type PropertyKind = 'text' | 'date' | 'boolean' | 'list' | 'choice' | 'id' | 'source';

export interface Property {
    key: string;
    kind: PropertyKind;
    /** The value as the field shows it: the scalar's text (`''` for an empty value); a boolean's `true`/`false`; a source row's summary. */
    text: string;
    /** A list's items, as strings. */
    items?: readonly string[];
    /** A list written as a flow sequence (`[a, b]`). */
    flow?: boolean;
    /** A choice's values: the ones the key has in the file, the current one first. */
    choices?: readonly string[];
    /** Where the key starts in the body, for the source opened at it. */
    offset: number;
}

export interface PropertiesRead {
    properties: Property[];
    /** Why the YAML cannot be shown as properties (a syntax error, not a map); `null` when it can. */
    error: string | null;
}

/** The front matter's three parts: its opening line, the YAML between, its closing line (each with its terminator). */
export interface FrontMatterParts {
    open: string;
    body: string;
    /** `''` for a front matter the end of the file closed. */
    close: string;
}

/** The keys whose values are offered from the file's own vocabulary. The hook for more (a schema) is a later step. */
export const ENUMERATED_KEYS: ReadonlySet<string> = new Set(['lang']);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FENCE = /^(?:-{3,}|\.{3})[ \t]*$/;

/** The line ending the front matter is written with. */
export function eolOf(src: string): '\n' | '\r\n' {
    return src.includes('\r\n') ? '\r\n' : '\n';
}

/** Split a front matter's `src` into its fences and the YAML between. */
export function splitFrontMatter(src: string): FrontMatterParts {
    const firstEnd = lineEnd(src, 0);
    const open = src.slice(0, firstEnd);
    const rest = src.slice(firstEnd);
    const stripped = rest.replace(/(?:\r\n|\r|\n)$/, '');
    const lastStart = Math.max(stripped.lastIndexOf('\n'), stripped.lastIndexOf('\r')) + 1;
    if (rest !== '' && FENCE.test(stripped.slice(lastStart))) {
        return { open, body: rest.slice(0, lastStart), close: rest.slice(lastStart) };
    }
    return { open, body: rest, close: '' };
}

export function joinFrontMatter(parts: FrontMatterParts): string {
    return parts.open + parts.body + parts.close;
}

/** The properties the YAML holds, one per top-level key, in the file's order. */
export function readProperties(body: string): PropertiesRead {
    const doc = parse(body);
    if (doc.errors.length > 0) {
        return { properties: [], error: `The YAML does not parse: ${doc.errors[0].message.split('\n')[0]}` };
    }
    const contents = doc.contents;
    if (contents === null || (isScalar(contents) && contents.value === null)) {
        return { properties: [], error: null };
    }
    if (!isMap(contents)) {
        return { properties: [], error: 'The front matter is not a list of keys.' };
    }
    const properties: Property[] = [];
    for (const pair of contents.items) {
        properties.push(propertyOf(doc, body, pair as Pair));
    }
    return { properties, error: null };
}

function propertyOf(doc: Document.Parsed, body: string, pair: Pair): Property {
    const keyNode = pair.key;
    const offset = isScalar(keyNode) && keyNode.range ? keyNode.range[0] : 0;
    const key = isScalar(keyNode) ? String(keyNode.value) : String(keyNode);
    const value = pair.value;
    const property = (kind: PropertyKind, text: string, extra: Partial<Property> = {}): Property => ({ key, kind, text, offset, ...extra });
    if (!isScalar(keyNode)) {
        return property('source', 'a complex key');
    }
    if (value === null || value === undefined) {
        return property('text', '');
    }
    if (isAlias(value)) {
        return property('source', `alias of ${value.source}`);
    }
    if (isScalar(value)) {
        if (value.type === Scalar.BLOCK_LITERAL || value.type === Scalar.BLOCK_FOLDED || (typeof value.value === 'string' && /[\r\n]/.test(value.value))) {
            return property('source', 'multi-line text');
        }
        if (typeof value.value === 'boolean') {
            return property('boolean', value.value ? 'true' : 'false');
        }
        const text = scalarText(body, value);
        if (isIdKey(key) && (key === 'uid' || UUID.test(text))) {
            return property('id', text);
        }
        if (typeof value.value === 'string' && DATE.test(value.value)) {
            return property('date', text);
        }
        if (ENUMERATED_KEYS.has(key) && (typeof value.value === 'string' || value.value === null)) {
            return property('choice', text, { choices: valuesOf(doc, key, text) });
        }
        return property('text', text);
    }
    if (isSeq(value)) {
        const items = value.items;
        if (items.every(item => isScalar(item) && !(typeof item.value === 'string' && /[\r\n]/.test(item.value)) && item.type !== Scalar.BLOCK_LITERAL && item.type !== Scalar.BLOCK_FOLDED)) {
            return property('list', items.map(item => scalarText(body, item as Scalar)).join(', '), {
                items: items.map(item => scalarText(body, item as Scalar)),
                flow: value.flow === true,
            });
        }
        return property('source', `${count(items.length)}, nested`);
    }
    if (isMap(value)) {
        return property('source', `${count(value.items.length)}, nested`);
    }
    return property('source', 'a value of its own kind');
}

function count(n: number): string {
    return n === 1 ? '1 item' : `${n} items`;
}

/** `uid`, or a key whose name ends in `uid` or `id` (`to-uid`, `docId`). */
function isIdKey(key: string): boolean {
    return /(?:uid|id)$/i.test(key);
}

/** A scalar as a field shows it: a string's value, anything else as written (`1.0` stays `1.0`), an empty value `''`. */
function scalarText(body: string, scalar: Scalar): string {
    if (scalar.value === null) {
        return '';
    }
    if (typeof scalar.value === 'string') {
        return scalar.value;
    }
    const range = scalar.range;
    return range ? body.slice(range[0], range[1]) : String(scalar.value);
}

/** The values `key` has anywhere in the file, `current` first, each once. */
function valuesOf(doc: Document.Parsed, key: string, current: string): string[] {
    const seen = current === '' ? [] : [current];
    visit(doc, {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- the visitor's key is the node type's name
        Pair(_, pair) {
            if (isScalar(pair.key) && pair.key.value === key && isScalar(pair.value) && typeof pair.value.value === 'string') {
                const v = pair.value.value;
                if (v !== '' && !seen.includes(v)) {
                    seen.push(v);
                }
            }
        },
    });
    return seen;
}

// ---------------------------------------------------------------------------
// Edits: each returns the new body, or `null` when the key is not there (or not
// of the kind the edit needs) in the body it was given.
// ---------------------------------------------------------------------------

/** A text, date or choice property's new value, written in the scalar's own quoting style where it reads back as that value. */
export function setText(body: string, key: string, text: string): string | null {
    const pair = findPair(body, key);
    if (!pair) {
        return null;
    }
    const value = pair.value;
    if (value === null || value === undefined) {
        const colon = colonAfterKey(body, pair);
        return colon < 0 || text === '' ? null : splice(body, colon + 1, colon + 1, ` ${newScalarSource(text)}`);
    }
    if (!isScalar(value) || !value.range) {
        return null;
    }
    if (scalarText(body, value) === text) {
        return body;
    }
    const [start, end] = value.range;
    if (value.value === null && text === '') {
        return body;
    }
    const written = scalarSource(text, value);
    // An empty value stands right after the colon: the new one needs its space.
    const lead = start === end && start > 0 && !/\s/.test(body[start - 1]) ? ' ' : '';
    return splice(body, start, end, lead + written);
}

/** A boolean property set, in the case the file writes it (`true`, `True`, `TRUE`). */
export function setBoolean(body: string, key: string, checked: boolean): string | null {
    const pair = findPair(body, key);
    const value = pair?.value;
    if (!pair || !isScalar(value) || typeof value.value !== 'boolean' || !value.range) {
        return null;
    }
    const [start, end] = value.range;
    const was = body.slice(start, end);
    let written = checked ? 'true' : 'false';
    if (was === was.toUpperCase()) {
        written = written.toUpperCase();
    } else if (was[0] === was[0].toUpperCase()) {
        written = written[0].toUpperCase() + written.slice(1);
    }
    return splice(body, start, end, written);
}

/** An item added at the end of a list, in the list's style. */
export function addItem(body: string, key: string, item: string, eol: '\n' | '\r\n'): string | null {
    const pair = findPair(body, key);
    const seq = pair?.value;
    if (!pair || !isSeq(seq) || !seq.range) {
        return null;
    }
    const written = newScalarSource(item, true);
    if (seq.flow) {
        return rewriteFlow(body, seq.range, [...(seq.items as Scalar[]).map(i => itemSource(body, i)), written]);
    }
    const last = seq.items[seq.items.length - 1] as Scalar;
    if (!last?.range) {
        return null;
    }
    const lineStart = startOfLine(body, last.range[0]);
    const prefix = body.slice(lineStart, last.range[0]);
    const at = lineEndAfter(body, last.range[1]);
    const terminated = at > 0 && body[at - 1] === '\n';
    return splice(body, at, at, `${terminated ? '' : eol}${prefix}${written}${terminated ? eol : ''}`);
}

/** The list's item at `index` removed; the last one leaves an empty flow list (`[]`), since a block list cannot be empty. */
export function removeItem(body: string, key: string, index: number, eol: '\n' | '\r\n'): string | null {
    const pair = findPair(body, key);
    const seq = pair?.value;
    if (!pair || !isSeq(seq) || !seq.range || index < 0 || index >= seq.items.length) {
        return null;
    }
    const items = seq.items as Scalar[];
    if (seq.flow) {
        return rewriteFlow(body, seq.range, items.filter((_, i) => i !== index).map(i => itemSource(body, i)));
    }
    const item = items[index];
    if (!item.range) {
        return null;
    }
    if (items.length === 1) {
        const colon = colonAfterKey(body, pair);
        const end = lineEndAfter(body, item.range[1]);
        const terminated = end > 0 && body[end - 1] === '\n';
        return colon < 0 ? null : splice(body, colon, end, `: []${terminated ? eol : ''}`);
    }
    return splice(body, startOfLine(body, item.range[0]), lineEndAfter(body, item.range[1]), '');
}

/**
 * A new key at the end of the YAML. The value is written as typed where it
 * reads back as one scalar or a flow list of scalars (`2026-09-29`, `true`,
 * `[a, b]`), so a new row is typed from its value as every other; anything else
 * is quoted. `null` when the key is there already.
 */
export function addProperty(body: string, key: string, value: string, eol: '\n' | '\r\n'): string | null {
    if (key === '' || findPair(body, key) !== null) {
        return null;
    }
    const line = `${newScalarSource(key)}:${value === '' ? '' : ` ${newValueSource(value)}`}`;
    const lead = body === '' || body.endsWith('\n') || body.endsWith('\r') ? '' : eol;
    return body + lead + line + eol;
}

/** A key removed with its value: its lines, a trailing comment on them included. */
export function removeProperty(body: string, key: string): string | null {
    const pair = findPair(body, key);
    if (!pair || !isScalar(pair.key) || !pair.key.range) {
        return null;
    }
    const start = startOfLine(body, pair.key.range[0]);
    const value = pair.value as { range?: [number, number, number] | null } | null;
    let end = value?.range ? value.range[1] : pair.key.range[1];
    end = end > start && body[end - 1] === '\n' ? end : lineEndAfter(body, end);
    return splice(body, start, end, '');
}

// ---------------------------------------------------------------------------

function parse(body: string): Document.Parsed {
    return parseDocument(body, { uniqueKeys: true });
}

function findPair(body: string, key: string): Pair | null {
    const doc = parse(body);
    if (doc.errors.length > 0 || !isMap(doc.contents)) {
        return null;
    }
    for (const pair of doc.contents.items) {
        if (isScalar(pair.key) && String(pair.key.value) === key) {
            return pair as Pair;
        }
    }
    return null;
}

function colonAfterKey(body: string, pair: Pair): number {
    const range = (pair.key as Scalar).range;
    return range ? body.indexOf(':', range[1]) : -1;
}

function splice(text: string, from: number, to: number, insert: string): string {
    return text.slice(0, from) + insert + text.slice(to);
}

/** The line terminator's end at or after `pos` (the end of the text when the line has none). */
function lineEnd(text: string, pos: number): number {
    const m = /\r\n|\r|\n/.exec(text.slice(pos));
    return m ? pos + m.index + m[0].length : text.length;
}

function lineEndAfter(text: string, pos: number): number {
    const i = text.indexOf('\n', pos);
    return i < 0 ? text.length : i + 1;
}

function startOfLine(text: string, pos: number): number {
    return text.lastIndexOf('\n', pos - 1) + 1;
}

function itemSource(body: string, item: Scalar): string {
    return item.range ? body.slice(item.range[0], item.range[1]) : newScalarSource(String(item.value), true);
}

/** A flow list written again from its items' own text, its inner padding (`[ a ]`) kept. */
function rewriteFlow(body: string, range: [number, number, number], items: readonly string[]): string {
    const was = body.slice(range[0], range[1]);
    const pad = /^\[[ \t]/.test(was) ? ' ' : '';
    const written = items.length === 0 ? '[]' : `[${pad}${items.join(', ')}${pad}]`;
    return splice(body, range[0], range[1], written);
}

/** Whether `text` written plain reads back as exactly that string (not a number, a boolean, a comment, a map). */
function readsAsPlainString(text: string, inFlow = false): boolean {
    if (text === '' || /[\r\n]/.test(text) || (inFlow && /[,[\]{}]/.test(text))) {
        return false;
    }
    const doc = parseDocument(text);
    return doc.errors.length === 0 && isScalar(doc.contents) && doc.contents.type === Scalar.PLAIN && doc.contents.value === text;
}

/** `text` in the scalar's own style: quoted as it was quoted; plain where plain reads back as the same kind of value; else single-quoted. */
function scalarSource(text: string, scalar: Scalar): string {
    if (scalar.type === Scalar.QUOTE_DOUBLE) {
        return doubleQuoted(text);
    }
    if (scalar.type === Scalar.QUOTE_SINGLE) {
        return singleQuoted(text);
    }
    if (typeof scalar.value === 'number' || typeof scalar.value === 'bigint') {
        const doc = parseDocument(text);
        if (doc.errors.length === 0 && isScalar(doc.contents) && typeof doc.contents.value === 'number') {
            return text;
        }
    }
    return newScalarSource(text);
}

/** A string written fresh: plain where that reads back as the string, else single-quoted. */
function newScalarSource(text: string, inFlow = false): string {
    return readsAsPlainString(text, inFlow) ? text : singleQuoted(text);
}

/** A new key's value: as typed where it is one scalar or a flow list of scalars, else a quoted string. */
function newValueSource(text: string): string {
    if (!/[\r\n]/.test(text)) {
        const doc = parseDocument(text);
        const c = doc.contents;
        if (doc.errors.length === 0 && ((isScalar(c) && c.type === Scalar.PLAIN) || (isSeq(c) && c.flow && c.items.every(i => isScalar(i))))) {
            return text;
        }
    }
    return singleQuoted(text);
}

function singleQuoted(text: string): string {
    return `'${text.replace(/'/g, "''")}'`;
}

function doubleQuoted(text: string): string {
    // JSON's escapes are YAML's for a double-quoted scalar.
    return JSON.stringify(text);
}
