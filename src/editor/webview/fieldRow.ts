/**
 * The row a bar draws while it shows a field: its heading and divider, the
 * field, and the aside — the keys line, a refusal's reason. One drawer for
 * both owners of a field bar, the object bars (`ObjectBar.openField`) and the
 * formatting row's field bar (`ToolbarView.openFieldBar`): each keeps its own
 * lifecycle — the commit, the cancel, the next step, its claim on the slot —
 * and hands the drawing here, so what the row says and how it is announced
 * cannot differ between them.
 *
 * Two heading rules, one per kind of field, chosen by the step: a field that
 * edits a value of its object is headed by the object and the value
 * (`fieldHeading`: *Link · Address*, *Code block · Language*); an attributes
 * field by the element whose attributes it edits (`FieldStep.heading`,
 * `attributesTitle`: *Bold · Attributes*), whichever bar opened it.
 *
 * The keys line stays while the field is open. A refusal adds its reason on a
 * line of its own under the field — the input marked `aria-invalid` and
 * described by the reason — until the next edit takes it away. The refused
 * value comes back in a new input that takes the focus (`refusedStep`), so the
 * reason is read once, as the focus enters it: no `role="alert"` besides,
 * which would say it a second time. Where the bar's room is too narrow for the
 * keys line beside the field, it goes under the field (`mep-narrow`, `fit`).
 */
import type { TipPart } from '../tips';
import type { FieldStep, InlineChoice, InlineField, KeysLine } from './inlineField';

let rowSeq = 0;

/** A keys line's parts drawn: words as text, a `code` part in the code font. */
function drawParts(el: HTMLElement, parts: readonly TipPart[]): void {
    el.replaceChildren(...parts.map(p => {
        if (typeof p === 'string') {
            return p;
        }
        if ('code' in p) {
            const code = document.createElement('code');
            code.textContent = p.code;
            return code;
        }
        return p.keys;
    }));
}

/** The keys line of `step` for the value as it is now; `null` when it has none. */
function keysOf(step: FieldStep, value: string): KeysLine | null {
    const keys = typeof step.keys === 'function' ? step.keys(value) : step.keys;
    return keys === undefined || keys === '' ? null : keys;
}

/** One bar's field row: drawn by `render`, redrawn as the value changes (`changed`), fitted to the room before it is placed (`fit`). */
export class FieldRow {
    private readonly id = ++rowSeq;
    private keys: HTMLElement | null = null;
    private reason: HTMLElement | null = null;
    /** What the keys line says now, as one string: it is redrawn only when that changes. */
    private said: string | null = null;

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

    /** The heading, the field, the keys line and a refusal's reason, in place of whatever the bar showed. */
    render(): void {
        const step = this.step;
        this.bar.classList.add('mep-field-bar');
        this.bar.classList.toggle('mep-attr-bar', step?.adorn !== undefined);
        this.bar.classList.remove('mep-narrow', 'mep-title-alone', 'mep-refused');
        this.keys = null;
        this.reason = null;
        this.said = null;
        if (step !== null) {
            this.drawKeys(this.field.el.value);
            if (step.refusal) {
                const el = document.createElement('span');
                el.className = 'mep-field-refusal';
                el.id = `mep-field-reason-${this.id}`;
                // The line takes the row; its text is the capped, amber-marked box inside it (`.mep-field-refusal-text`).
                const text = document.createElement('span');
                text.className = 'mep-field-refusal-text';
                if (step.refusalParts) {
                    drawParts(text, step.refusalParts(step.refusal, step.value));
                } else {
                    text.textContent = step.refusal;
                }
                el.append(text);
                this.reason = el;
            }
        }
        this.bar.replaceChildren(...this.head, this.field.box, ...(this.keys ? [this.keys] : []), ...(this.reason ? [this.reason] : []));
        this.describe();
    }

    /** The value changed: the keys line says what Enter does with it now, and a refusal's reason goes. */
    changed(value: string): void {
        if (this.step === null) {
            return;
        }
        const redrawn = this.drawKeys(value);
        const refused = this.reason !== null;
        if (refused) {
            this.reason?.remove();
            this.reason = null;
            this.describe();
        }
        if (redrawn || refused) {
            this.events.contentChanged();
        }
    }

    /**
     * Before the bar is placed, at most `room` wide: measured at the mount's
     * left edge (an absolute box's room is what lies right of its `left`), a
     * keys line that no longer fits beside the field goes under it; a field
     * that no longer fits beside the title goes under that, and the title,
     * alone on its row, takes its divider with it (`mep-title-alone`).
     */
    fit(room: number): void {
        this.bar.style.maxWidth = `${Math.floor(room)}px`;
        this.bar.classList.remove('mep-narrow', 'mep-title-alone');
        const left = this.bar.style.left;
        this.bar.style.left = '0px';
        const box = this.field.box;
        const keys = this.keys;
        if (keys !== null) {
            this.bar.classList.toggle('mep-narrow', keys.offsetTop >= box.offsetTop + box.offsetHeight - 1);
        }
        const title = this.head[0];
        if (title !== undefined && !title.hidden) {
            this.bar.classList.toggle('mep-title-alone', box.offsetTop >= title.offsetTop + title.offsetHeight - 1);
        }
        this.bar.style.left = left;
    }

    /** The field went: the bar is its owner's again. */
    destroy(): void {
        this.bar.classList.remove('mep-field-bar', 'mep-attr-bar', 'mep-narrow', 'mep-title-alone', 'mep-refused');
    }

    /** The keys line for `value`, drawn anew when what it says changed; true when it did (its width may have). */
    private drawKeys(value: string): boolean {
        const keys = this.step === null ? null : keysOf(this.step, value);
        const parts: readonly TipPart[] = keys === null ? [] : typeof keys === 'string' ? [keys] : 'parts' in keys ? keys.parts : keys;
        const removes = keys !== null && typeof keys !== 'string' && 'removes' in keys;
        const said = keys === null ? '' : JSON.stringify([parts, removes]);
        if (said === this.said) {
            return false;
        }
        this.said = said;
        if (keys === null) {
            this.keys?.remove();
            this.keys = null;
            this.describe();
            return true;
        }
        const el = this.keys ?? document.createElement('span');
        el.className = 'mep-field-keys';
        el.id = `mep-field-keys-${this.id}`;
        // Read as the field's description (`aria-describedby`), not as text of its own.
        el.setAttribute('aria-hidden', 'true');
        el.classList.toggle('mep-keys-removes', removes);
        drawParts(el, parts);
        if (this.keys === null && this.field.box.isConnected) {
            this.field.box.after(el);
        }
        this.keys = el;
        this.describe();
        return true;
    }

    /** The input described by the refusal's reason while there is one, else by the keys line; invalid while refused. */
    private describe(): void {
        const input = this.field.el;
        const by = this.reason ?? this.keys;
        if (by === null) {
            input.removeAttribute('aria-describedby');
        } else {
            input.setAttribute('aria-describedby', by.id);
        }
        if (this.reason !== null) {
            input.setAttribute('aria-invalid', 'true');
        } else {
            input.removeAttribute('aria-invalid');
        }
        // The frame of an attributes field turns amber with it (`mep-attr-bar`, `mep-refused`).
        this.bar.classList.toggle('mep-refused', this.reason !== null);
    }
}
