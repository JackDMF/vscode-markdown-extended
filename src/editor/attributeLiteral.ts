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
 * What a refusal says before the spelling it suggests (`Write it as width=300.`): the one wording
 * the message (`literalRefusal`) and `refusalParts` share.
 */
export const WRITE_IT_AS = 'Write it as ';

/**
 * What a refusal says of the value it names, the words that follow it: the one list the messages
 * (`literalRefusal`) are built from and `refusalParts` recognises them by — a reason is `value ` and
 * one of these, never a sentence that happens to begin with the same letters.
 */
export const VALUE_PREDICATE = {
    openQuote: 'has an open quote',
    notClosed: 'is not closed',
    isText: 'is text, not an attribute list',
    noList: 'is no attribute list',
    innerBrace: 'holds a } inside a value',
    ruleBrace: 'holds a { inside a value',
    backtick: 'holds a backtick',
    readBefore: 'holds what markdown-it reads before markdown-it-attrs here',
    linkOwn: 'sets the link\'s href or title',
} as const;

const VALUE_PREDICATES: readonly string[] = Object.values(VALUE_PREDICATE);

/**
 * A refusal's reason as the field draws it: the values it names — the one typed, which it begins
 * with (`value` and a `VALUE_PREDICATE`), and the one it suggests after `WRITE_IT_AS` — in the code
 * font, the sentence plain. The reason is read as the message is built (`literalRefusal`), not
 * re-worded: a reason that does not name the value, or suggests nothing, has no part to set apart.
 * `typed` is the field's value as it was, which the commit read as `literalFrom(typed)`.
 */
export function refusalParts(reason: string, typed: string): readonly TipPart[] {
    const value = innerOf(literalFrom(typed));
    const parts: TipPart[] = [];
    let rest = reason;
    if (value !== '' && VALUE_PREDICATES.some(predicate => rest.startsWith(`${value} ${predicate}`))) {
        parts.push({ code: value });
        rest = rest.slice(value.length);
    }
    const at = rest.lastIndexOf(WRITE_IT_AS);
    if (at >= 0 && rest.endsWith('.')) {
        const before = rest.slice(0, at);
        if (before !== '') {
            parts.push(before);
        }
        parts.push(WRITE_IT_AS, { code: rest.slice(at + WRITE_IT_AS.length, -1) }, '.');
    } else if (rest !== '') {
        parts.push(rest);
    }
    return parts;
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
