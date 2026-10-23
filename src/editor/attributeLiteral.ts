/**
 * How a markdown-it-attrs literal is shown in the attributes field and read
 * back from it: the field draws the braces itself, fixed, and the value is
 * only what stands between them — so an id is typed first without deleting a
 * dot, and a closing brace cannot be lost. `attrs.ts` holds the plugin's
 * reading rules; this holds the field's spelling rules. Every route to the
 * field (a bar's Attributes…, the menus, the bubble's `{…}`, Span with
 * class…) reads them here, as do the tests.
 *
 * No ProseMirror and no DOM here, so every module can read it.
 */
import type { TipPart } from './tips';

/** The braces the field draws around its value: written by the field, never typed. */
export const ATTR_BRACES = { open: '{', close: '}' } as const;

/** What an attributes field with no literal yet says: a class, the first thing one usually writes. */
export const ATTR_PLACEHOLDER = '.class';

/** The syntax the keys line shows: what goes between the braces. */
const ATTR_SYNTAX = '.class #id key=value';

/** What the field shows for `literal`: one outer pair of braces off; none (`null`) is ''. */
export function innerOf(literal: string | null): string {
    if (literal === null) {
        return '';
    }
    const value = literal.trim();
    return stripOuterPair(value);
}

/** Whether `literal` holds anything an empty field could remove: none (`null`) and `{}` hold nothing. The one reading of "had a literal" the keys line (`keysFor`) and the verbs' tooltips (`attributesTyped`) share. */
export function holdsLiteral(literal: string | null): boolean {
    return innerOf(literal).trim() !== '';
}

/**
 * What a verb's tooltip says to type, in the keys line's own terms (`keysLine`): the syntax, and — only
 * where the element has a literal (`holdsLiteral`) — that an empty value removes it, as the field's keys
 * line says it. A bare run has nothing to remove.
 */
export function attributesTyped(literal: string | null): string {
    return holdsLiteral(literal) ? `${ATTR_SYNTAX}; empty removes it` : ATTR_SYNTAX;
}

/**
 * The tooltip of a part's or a block's **Attributes…** (#8 review 1, W1/W4):
 * the part named — "Attributes of List item: .class #id key=value. Leave
 * empty to remove them." — the removal said only where there is a literal
 * (`holdsLiteral`), `extra` after it, and Enter's one verb, "set", as the
 * field's keys line says it.
 */
export function attributesTip(name: string, literal: string | null, extra = ''): string {
    return `Attributes of ${name}: ${ATTR_SYNTAX}.${holdsLiteral(literal) ? ' Leave empty to remove them.' : ''}${extra} Enter to set, Esc to cancel.`;
}

/**
 * One outer pair of braces off `value` when it has both — a `{…}` pasted or
 * completed by typing its `}` — else `value` as it is. Only the outermost
 * pair: `{.a} {.b}` gives `.a} {.b`, which the commit then refuses.
 */
export function stripOuterPair(value: string): string {
    return value.length >= 2 && value.startsWith(ATTR_BRACES.open) && value.endsWith(ATTR_BRACES.close) ? value.slice(1, -1) : value;
}

/**
 * What the field commits for `inner`: '' (nothing but spaces too) stays '' —
 * a removal; else a lone leading `{` or trailing `}` dropped, then braced.
 */
export function literalFrom(inner: string): string {
    let value = inner.trim();
    if (value === '') {
        return '';
    }
    if (value.startsWith(ATTR_BRACES.open)) {
        value = value.slice(1);
    }
    if (value.endsWith(ATTR_BRACES.close)) {
        value = value.slice(0, -1);
    }
    return `${ATTR_BRACES.open}${value}${ATTR_BRACES.close}`;
}

/** Whether `literal`, as committed, removes the literal: nothing, or `{}`. */
export function isRemoval(literal: string): boolean {
    const value = literal.trim();
    return value === '' || value === `${ATTR_BRACES.open}${ATTR_BRACES.close}`;
}

/** The one title every route to the attributes field shows, naming the element edited: `Bold · Attributes`. */
export function attributesTitle(name: string): string {
    return `${name} · Attributes`;
}

/** What the keys line says: Enter sets (and, when there was a literal, an empty field removes it), or Enter removes `literal`. */
export type KeysState = { kind: 'set'; hadLiteral: boolean } | { kind: 'removes'; literal: string };

/**
 * The keys line: `↵ set · Esc cancel[ · empty removes] · .class #id key=value`,
 * the syntax in the code font; or, once an existing literal was emptied,
 * `↵ removes .x #y · Esc keeps them`, the literal as the field showed it.
 */
export function keysLine(state: KeysState): readonly TipPart[] {
    if (state.kind === 'removes') {
        return ['↵ removes ', { code: state.literal }, ' · Esc keeps them'];
    }
    return [`↵ set · Esc cancel · ${state.hadLiteral ? 'empty removes · ' : ''}`, { code: ATTR_SYNTAX }];
}

/**
 * The keys state for the field's `value` now, read from what Enter will commit (`literalFrom`): a
 * literal it had (`hadLiteral`) that commits as a removal — emptied, or only a stray brace left —
 * is removed by Enter; else Enter sets.
 */
export function keysFor(value: string, hadLiteral: string | null): KeysState {
    const had = holdsLiteral(hadLiteral);
    return had && isRemoval(literalFrom(value)) ? { kind: 'removes', literal: innerOf(hadLiteral).trim() } : { kind: 'set', hadLiteral: had };
}
