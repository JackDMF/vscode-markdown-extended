/**
 * **Attributes…**: the field that sets the markdown-it-attrs literal of a
 * block — the Formatting menu's entry for the block at the caret, and the verb
 * of the same name on the bars of the blocks that have one (a heading, a table,
 * a block already carrying a literal — a bar is not drawn for this verb alone).
 * One step for every surface, so the menu
 * and a bar cannot prefill, refuse or announce differently; what the literal
 * does to the document is `commitAttributes` (`objects.ts`).
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
 * | Rule (selected) | after the rule: `--- {.x}` | the `<hr>` |
 * | List (one it has already) | where it stood: under its last line, or under a blank line | the `<ul>`/`<ol>` |
 *
 * Refused, with the reason, rather than guessed:
 *
 * | Block | Why |
 * | --- | --- |
 * | Container | markdown-it-attrs takes a literal off the `:::` line, and the container's renderer drops it |
 * | Admonition | the plugin gives a literal on the `!!!` line to the title bar, not the box |
 * | Quote ending in a list, code or a quote | a `> {…}` line under it goes to that block, not the quote |
 * | List item not starting with a paragraph that ends in text | there is no line end to put it at |
 * | Requirement heading | its anchor is Req Explorer's |
 * | Indented code | it has no opening line |
 * | Source block, front matter, injected content | not rich text, or not in the file |
 * | A literal the plugin would not read back whole | `literalRefusal`: not `{…}`, `{.}`, two lines, a `{` in a rule's value |
 *
 * The caret in a nested block acts on the list item or the top-level block
 * around it (`attributesTargetAt`): only a top-level block's literal is written
 * (`fidelity.ts`), and a list item's at any depth.
 */
import { EditorView } from 'prosemirror-view';
import { showHint, undoKey } from './hint';
import { FieldStep } from './inlineField';
import { AttributesTarget, commitAttributes, literalOf } from './objects';
import { SPAN_FIELD_PREFILL } from './toolbar/actions';

/** The field's own label; its heading is the block's name before it (`Paragraph · Attributes`). */
export const ATTRIBUTES_FIELD_LABEL = 'Attributes';

/**
 * What the attributes field says at its right — its keys, then the syntax it
 * takes, since `{.}` alone shows only the class. **Span with class** shows it too.
 */
export const ATTRIBUTES_FIELD_KEYS = '↵ set · Esc cancel · {.class #id key=value}';

/** What the caret hint says once a literal is set or removed: the change is on the page, the way back is named. */
export const ATTRIBUTES_SET_HINT = 'Attributes set';
export const ATTRIBUTES_REMOVED_HINT = 'Attributes removed';

/**
 * The field step for `target`: its literal prefilled (selected, so typing
 * replaces it), or `{.}` with the caret after the dot when it has none. `Enter`
 * commits: refused with the reason beside the caret when markdown-it-attrs
 * would not read the literal back, or the save the block it stands in — a
 * removal as much as a new literal (`commitAttributes`) — else one
 * transaction — one undo step — and the hint that says so.
 */
export function attributesStep(view: EditorView, target: AttributesTarget): FieldStep {
    const literal = literalOf(target.node);
    return {
        value: literal ?? SPAN_FIELD_PREFILL.value,
        caret: literal === null ? SPAN_FIELD_PREFILL.caret : undefined,
        label: ATTRIBUTES_FIELD_LABEL,
        keys: ATTRIBUTES_FIELD_KEYS,
        commit: value => {
            view.focus();
            const made = commitAttributes(view.state, target, value);
            if (made === null) {
                return;
            }
            if ('refusal' in made) {
                showHint(view, made.refusal, 'refusal');
                return;
            }
            // Said only when the state moved, as the object bar's verbs say it: a filter refusing it leaves the state as it was.
            const before = view.state;
            view.dispatch(made.tr);
            if (view.state !== before) {
                showHint(view, `${made.removed ? ATTRIBUTES_REMOVED_HINT : ATTRIBUTES_SET_HINT} — ${undoKey()}`, 'neutral');
            }
        },
    };
}
