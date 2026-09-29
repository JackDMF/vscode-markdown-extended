/**
 * The completion list's chrome — one component for the two places the page
 * completes: under a field (a link's address, `inlineField.ts`) and under the
 * caret (other extensions' completions, `completion.ts`). Rows of a label and
 * a dimmed detail in VS Code's suggest widget colours, the chosen row
 * highlighted, and one dim line under them that says the keys, since nothing
 * else says what `Tab` and `Enter` do. A press on a row is prevented, so the
 * field or the text keeps the focus; a click picks it.
 */

/** One row: what it shows (`label`, `detail`), what it names (`kind`), and the value it stands for, when it has one. */
export interface ListEntry {
    label: string;
    detail?: string;
    kind?: string;
    value?: string;
}

export class CompletionListView {
    /** `.mep-completions`: the caller puts it where it belongs and positions it. */
    readonly el: HTMLElement;
    private readonly options: HTMLElement;
    private readonly keys: HTMLElement;
    private chosenIndex = -1;

    constructor(readonly id: string, label: string, footer: string, private readonly onPick: (index: number) => void) {
        this.el = document.createElement('div');
        this.el.className = 'mep-completions';
        this.options = document.createElement('div');
        this.options.className = 'mep-completion-options';
        this.options.id = id;
        this.options.setAttribute('role', 'listbox');
        this.options.setAttribute('aria-label', label);
        this.keys = document.createElement('div');
        this.keys.className = 'mep-completions-keys';
        this.keys.setAttribute('aria-hidden', 'true');
        this.keys.textContent = footer;
        this.el.append(this.options, this.keys);
        // The press is not a move of the focus.
        this.el.addEventListener('mousedown', e => {
            e.preventDefault();
            e.stopPropagation();
        });
    }

    /** The dim line under the rows. */
    set footer(text: string) {
        this.keys.textContent = text;
    }

    /** The row chosen now, `-1` for none. */
    get chosen(): number {
        return this.chosenIndex;
    }

    /** Draw `items`, `chosen` the one chosen (`-1` for none). */
    render(items: readonly ListEntry[], chosen = -1): void {
        this.options.replaceChildren(...items.map((item, i) => {
            const option = document.createElement('div');
            option.className = 'mep-completion';
            option.id = `${this.id}-${i}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            if (item.value !== undefined) {
                option.dataset.value = item.value;
            }
            if (item.kind) {
                option.dataset.kind = item.kind;
            }
            const label = document.createElement('span');
            label.className = 'mep-completion-label';
            label.textContent = item.label;
            option.append(label);
            if (item.detail) {
                const detail = document.createElement('span');
                detail.className = 'mep-completion-detail';
                detail.textContent = item.detail;
                option.append(detail);
            }
            option.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                this.onPick(i);
            });
            return option;
        }));
        this.chosenIndex = -1;
        this.choose(chosen);
    }

    /** Mark row `index` chosen and bring it into the list's view; its element, for `aria-activedescendant`. */
    choose(index: number): HTMLElement | undefined {
        this.chosenIndex = index;
        const options = Array.from(this.options.querySelectorAll<HTMLElement>('.mep-completion'));
        options.forEach((option, i) => {
            option.setAttribute('aria-selected', String(i === index));
            option.classList.toggle('mep-chosen', i === index);
        });
        const option = options[index];
        if (option) {
            // Within the list only: `scrollIntoView` would scroll the page too,
            // to wherever the list stands before it is placed.
            const box = this.options;
            const top = option.offsetTop - box.offsetTop;
            const bottom = top + option.offsetHeight;
            if (top < box.scrollTop) {
                box.scrollTop = top;
            } else if (bottom > box.scrollTop + box.clientHeight) {
                box.scrollTop = bottom - box.clientHeight;
            }
        }
        return option;
    }

    remove(): void {
        this.el.remove();
    }
}
