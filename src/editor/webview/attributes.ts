/**
 * **Attributes…**: the field that sets the markdown-it-attrs literal of a
 * block — the Formatting menu's entry for the block at the caret, and the verb
 * of the same name on the bars of the blocks that have one (a heading, a table,
 * a block already carrying a literal — a bar is not drawn for this verb alone).
 * One field for every surface (`attributesField`), so the menus, a bar and
 * the bubble cannot prefill, refuse or announce differently; how it shows a
 * literal and reads one back — the braces its own, the value between them —
 * is `attributeLiteral.ts`; what the literal does to the document is
 * `commitAttributes` (`objects.ts`).
 *
 * Where each block's literal goes — where markdown-it-attrs reads it for that
 * construct, checked against the plugin's patterns and the engine
 * (`attributes.test.ts` renders every row):
 *
 * | Block | Written | The plugin gives it to |
 * | --- | --- | --- |
 * | Paragraph (an image alone in one too) | after a space at the end of its last line: `text {.x}` | the `<p>` |
 * | Heading | at the end of its line: `## Title {.x}`; its `#id` is the heading's anchor | the `<hN>` |
 * | List item | at the end of its first paragraph, at any depth: `- text {.x}` | the `<li>` |
 * | Quote | a line of its own under its last paragraph, inside it: `> {.x}` | the `<blockquote>` |
 * | Table | a line of its own under a blank line after it: `{.x}` (one right under it stays there) | the `<table>` |
 * | Fenced code | after the opening fence's info string: ```` ```js {.x} ```` | the `<code>` |
 * | Indented code | fenced as it takes one (```` ``` {.x} ````, "Code block fenced"); inside a quote, a list or a container refused | the `<code>` |
 * | Rule (selected) | after the rule: `--- {.x}` | the `<hr>` |
 * | List (one it has already) | where it stood: under its last line, or under a blank line | the `<ul>`/`<ol>` |
 *
 * Refused, with the reason, rather than guessed:
 *
 * | Block | Why |
 * | --- | --- |
 * | Container | the preview draws a literal on the `:::` line or on a line of its own before the closing `:::`, but the container node has no slot for it: one written either way is a source block |
 * | Admonition | a literal on the `!!!` line styles the title; the box's (a last line of its body) opens as source |
 * | Quote ending in a list, code or a quote | a `> {…}` line under it goes to that block, not the quote |
 * | List item not starting with a paragraph that ends in text | there is no line end to put it at |
 * | List inside a quote, an admonition or a container | only a top-level list's literal is written; a nested one's is source |
 * | Requirement heading | its anchor is Req Explorer's |
 * | Source block, front matter, injected content | not rich text, or not in the file |
 * | A literal the plugin would not read back whole | `literalRefusal`: not `{…}`, `{.}`, two lines, a `{` in a rule's value |
 *
 * A heading inside a quote, an admonition or a container takes one where it
 * stands, at the end of its line (`> ## Title {.x}`): the save writes a
 * heading's literal at any depth. Otherwise the caret in a nested block acts
 * on the list item or the top-level block around it (`attributesTargetAt`):
 * only a top-level block's literal is written (`fidelity.ts`), and a list
 * item's at any depth.
 */
import { EditorView } from 'prosemirror-view';
import { showChangeHint, undoHint } from './hint';
import { wording } from '../verbs';
import { FENCED_DONE } from '../fences';
import { FieldAdorn, FieldStep, KeysLine, refusedStep } from './inlineField';
import { ATTR_BRACES, ATTR_PLACEHOLDER, attributesTitle, innerOf, isRemoval, keysFor, keysLine, literalFrom, stripOuterPair } from '../attributeLiteral';
import type { Said } from '../tips';
import {
    AttributesTarget, InlineHolderAt, changeInlineLiteralRefusal, changeInlineLiteralTransaction, commitAttributes, currentObject, holderNames, literalObjectOf, literalOf,
    literalOfObject,
} from './objects';

/** The field's own label — its accessible name; its heading names the element (`Paragraph · Attributes`, `attributesTitle`). */
export const ATTRIBUTES_FIELD_LABEL = 'Attributes';

/** The braces the attributes field draws, fixed, and what a change typed or pasted loses (`attributeLiteral.ts`). */
const ATTR_ADORN: FieldAdorn = { ...ATTR_BRACES, strip: stripOuterPair };

/**
 * The attributes field every route opens — a block's, an inline element's,
 * Span with class's — for the element called `name` whose literal is
 * `literal` (`null`: none): the value between the braces the field draws
 * (`innerOf`), selected; empty with the placeholder `.class` when there never
 * was one, and no placeholder once an existing one is emptied; headed
 * `<Name> · Attributes`; its keys line saying what Enter does with the value
 * as typed (`keysFor`). `commit` gets the literal to write (`literalFrom`:
 * braced, `''` for a removal) and `refused`, which keeps the field open with
 * what was typed and the reason (`refusedStep`). Where an empty value removes
 * nothing (`removable` false: a span is its literal, Remove attributes undoes
 * it), the keys line never says it does.
 *
 * Enter in a field left as it was shown commits nothing — `unchanged` runs
 * instead, the focus back where it was — so a literal the author wrote with
 * spaces inside its braces (`{ .a }`) is not rewritten, no undo step is made
 * and nothing is said to have been set. Only where there is a shown value to
 * leave: an empty field over `{}` or over no literal commits as it always did.
 */
export function attributesField(
    name: string,
    literal: string | null,
    commit: (literal: string, refused: (reason: Said) => FieldStep) => FieldStep | void,
    options: { removable?: boolean; unchanged?: () => void } = {},
): FieldStep {
    const removable = options.removable ?? true;
    const shown = innerOf(literal);
    const step: FieldStep = {
        value: shown,
        label: ATTRIBUTES_FIELD_LABEL,
        heading: attributesTitle(name),
        placeholder: literal === null ? ATTR_PLACEHOLDER : '',
        keys: (value: string): KeysLine => {
            const state = keysFor(value, removable ? literal : null);
            return state.kind === 'removes' ? { parts: keysLine(state), removes: true } : keysLine(state);
        },
        adorn: ATTR_ADORN,
        commit: typed => {
            if (options.unchanged !== undefined && shown.trim() !== '' && typed === shown) {
                return options.unchanged();
            }
            return commit(literalFrom(typed), reason => refusedStep(step, typed, reason));
        },
    };
    return step;
}

/** What the caret hint says once a literal is set or removed: the change is on the page, the way back is named. */
export const ATTRIBUTES_SET_HINT = 'Attributes set';
/**
 * What the caret hint says once the literal of the element called `name` is
 * removed (#8): the part named, as the bars' Remove words it (`verbs.ts`) —
 * "List item attributes removed" — whichever route removed them.
 */
export function attributesRemovedHint(name: string): string {
    return wording({ verb: 'Remove', noun: `${name} attributes` }).done;
}

/**
 * The attributes field for `target` (`attributesField`), named by its block.
 * `Enter` commits: refused — the field kept open with what was typed and the
 * reason under it — when markdown-it-attrs would not read the literal back,
 * or the save the block it stands in — a removal as much as a new literal
 * (`commitAttributes`) — else one transaction — one undo step — and the hint
 * that says so.
 */
export function attributesStep(view: EditorView, target: AttributesTarget): FieldStep {
    return attributesField(target.name, literalOf(target.node), (value, refused) => {
        // Asked first, so a refusal keeps the field open with what was typed; the
        // transaction is built after the focus is back, which may commit a source box.
        const asked = commitAttributes(view.state, target, value);
        if (asked !== null && 'refusal' in asked) {
            return refused(asked.refusal);
        }
        view.focus();
        const made = asked === null ? null : commitAttributes(view.state, target, value);
        if (made === null) {
            return;
        }
        if ('refusal' in made) {
            // What the focus moved (a source box's commit) changed the answer: the field stays, saying why.
            return refused(made.refusal);
        }
        // Said only when the state moved, as the object bar's verbs say it: a filter refusing it leaves the state as it was.
        const before = view.state;
        view.dispatch(made.tr);
        if (view.state !== before) {
            showChangeHint(view, undoHint(made.fenced ? FENCED_DONE : made.removed ? attributesRemovedHint(target.name) : ATTRIBUTES_SET_HINT));
        }
    }, { unchanged: () => view.focus() });
}

/**
 * The field step for an inline holder (`attributeHolderAt`): a link's, a
 * styled run's, an image's, a bare run of formatting's — the one step the
 * bars' **Attributes…**, the Formatting menu's **Attributes of Code…**,
 * `Alt+Enter`'s bar and the bubble's `{…}` open (`attributesField`), named by
 * the element (`holderNames`: Bold, Strong, Italic, Emphasis, Code …), not by
 * the bar it was opened from. `Enter` sets it through
 * `changeInlineLiteralTransaction` — on a bare run the same mark is given the
 * literal over its run — an empty field removes it; a refusal keeps the field
 * open with what was typed and the reason.
 */
export function holderAttributesStep(view: EditorView, at: InlineHolderAt): FieldStep {
    return attributesField(holderNames(at).label, literalOfObject(at.object), (value, refused) => {
        const current = literalObjectOf(currentObject(view.state, at.object));
        if (current === null) {
            view.focus();
            return;
        }
        const refusal = changeInlineLiteralRefusal(view.state, current, value);
        if (refusal !== null) {
            return refused(refusal);
        }
        // The focus first, as the bars' verbs do: what it moves (a source box's commit) is followed.
        view.focus();
        const now = literalObjectOf(currentObject(view.state, current));
        const tr = now === null ? null : changeInlineLiteralTransaction(view.state, now, value);
        if (tr === null) {
            // What the focus moved (a source box's commit) changed the answer: the field stays, saying why.
            const after = now === null ? null : changeInlineLiteralRefusal(view.state, now, value);
            return after === null ? undefined : refused(after);
        }
        const removed = isRemoval(value);
        const before = view.state;
        view.dispatch(tr);
        if (view.state !== before) {
            showChangeHint(view, undoHint(removed ? attributesRemovedHint(holderNames(at).label) : ATTRIBUTES_SET_HINT));
        }
    }, { unchanged: () => view.focus() });
}
