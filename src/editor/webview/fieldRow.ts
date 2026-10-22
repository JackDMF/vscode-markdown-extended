/**
 * The row a bar draws while it shows a field: its heading and divider, the
 * field, and the aside — the keys line, a refusal's reason. One drawer for
 * both owners of a field bar, the object bars (`ObjectBar.openField`) and the
 * formatting row's field bar (`ToolbarView.openFieldBar`): each keeps its own
 * lifecycle — the commit, the cancel, the next step, its claim on the slot —
 * and hands the drawing here, so what the row says and how it is announced
 * cannot differ between them.
 */
import type { FieldStep, InlineChoice, InlineField } from './inlineField';

/** The keys line a bar draws at a field's right (`FieldStep.keys`). */
export function fieldKeys(text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = 'mep-field-keys';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = text;
    return el;
}

/**
 * What a bar draws at a field's right, the one rule for every bar that shows
 * a field: the reason a commit was refused (`FieldStep.refusal`), announced,
 * else the keys line (`fieldKeys`), else nothing.
 */
export function fieldAside(step: { keys?: string; refusal?: string }): HTMLElement[] {
    if (step.refusal) {
        const el = document.createElement('span');
        el.className = 'mep-field-refusal';
        el.setAttribute('role', 'alert');
        el.textContent = step.refusal;
        return [el];
    }
    return step.keys ? [fieldKeys(step.keys)] : [];
}

/** One bar's field row: drawn by `render`, redrawn as the value changes (`changed`), fitted to the room before it is placed (`fit`). */
export class FieldRow {
    /**
     * `head`: what stands before the field — the heading and its divider — as
     * the owner made them; `step`: the field's step, `null` for a choice
     * (which has no aside); `events.contentChanged`: the row changed size, the
     * owner's slot places it again.
     */
    constructor(
        private readonly bar: HTMLElement,
        private readonly head: readonly HTMLElement[],
        private readonly field: InlineField | InlineChoice,
        private readonly step: FieldStep | null,
        private readonly events: { contentChanged(): void },
    ) {}

    /** The heading, the field, the aside, in place of whatever the bar showed. */
    render(): void {
        this.bar.replaceChildren(...this.head, this.field.el, ...(this.step === null ? [] : fieldAside(this.step)));
    }

    /** The value changed as it is typed. */
    changed(_value: string): void {
        // Nothing to redraw yet.
    }

    /** Before the bar is placed, at most `room` wide. */
    fit(_room: number): void {
        // Nothing to fit yet.
    }

    /** The field went: the bar is its owner's again. */
    destroy(): void {
        // Nothing left behind yet.
    }

    /** For the owner that redraws in a size it cannot know: the slot asks again. */
    protected resized(): void {
        this.events.contentChanged();
    }
}
