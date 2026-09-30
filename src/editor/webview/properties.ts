/**
 * The front matter as a properties panel (Daniel, 2026-09-29, sketch 8): a
 * header `▸ Properties  <n>` with **Edit as source** at its right, collapsed by
 * default and remembered per document; expanded, one row per top-level key —
 * the key in mono, since it *is* the key, and a control typed from its value
 * (`frontMatter.ts` says which) — and a last row, **+ Add property**.
 *
 * A generic panel for Markdown Extended Pro, never a form of any one tool's: it
 * knows YAML, not what a key means. Every edit is one in-place change of the
 * YAML text (`frontMatter.ts`), written as the node's new `src` in one
 * transaction — one undo step, posted like any block edit.
 *
 * **Keys.** `Tab` moves between rows (the browser's order: each row's control,
 * the chips' **+ add**, then **+ Add property**); `Enter` commits a row, `Esc`
 * reverts it, and a second `Esc` puts the caret in the text below. A row's
 * value is committed when the focus leaves it too — unlike the inline field,
 * which is gone once it loses the focus: a row stays and shows its value, and a
 * value that showed typed and then silently reverted would say something the
 * file does not hold. `Ctrl+Z` in a field with typing of its own undoes the
 * typing; anywhere else in the panel it is the editor's undo, so *Removed
 * `key` — Ctrl+Z* is true wherever the focus is.
 *
 * **What stays source.** A nested map, a list of maps, a multi-line string or an
 * alias is one row, *`<n>` items, nested · edit as source*, which opens the YAML
 * in the panel's source box at that key. So does a YAML the parser refuses, or
 * one that is not a map: the panel then says why and offers only the source.
 */
import { Node } from 'prosemirror-model';
import { NodeView } from 'prosemirror-view';
import {
    FrontMatterParts, KeyRef, Property, PropertiesRead, addItem, addProperty, eolOf, isDate, joinFrontMatter, readProperties,
    removeItem, removeProperty, setBoolean, setText, splitFrontMatter,
} from '../frontMatter';
import { CompletionListView } from './completionList';
import { undoKey } from './hint';
import { EditorPort, SourceEditor, element, isUndoRedo } from './nodeViews';

type GetPos = () => number | undefined;

let choiceSeq = 0;

/** Set while a redraw gives the focus back: a choice's list opens for a person's focus, not for the redraw's. */
let restoringFocus = false;

/** The choice list's footer: its keys, as the other completion lists say theirs. */
const CHOICE_KEYS = '↑↓ choose · ↵ set · Esc close';

/** Where the panel's open state is remembered, per document. */
const STORAGE_PREFIX = 'markdownExtended.properties.expanded:';

/** Each panel by its DOM, so the toolbar's **Insert → Properties** can reach the view ProseMirror made. */
const panels = new WeakMap<globalThis.Node, PropertiesView>();

/** Open the panel at `pos` and start adding a property. False when there is no panel there. */
export function addPropertyAt(dom: globalThis.Node | null): boolean {
    const panel = dom ? panels.get(dom) : undefined;
    if (!panel) {
        return false;
    }
    panel.startAdding();
    return true;
}

/** What had the focus before a redraw, so the redraw can give it back. */
interface FocusMemo {
    slot: string;
    value: string | null;
    committed: string | null;
    selection: [number, number] | null;
}

function remembered(key: string): boolean {
    try {
        return window.localStorage.getItem(STORAGE_PREFIX + key) === '1';
    } catch {
        return false;
    }
}

function remember(key: string, expanded: boolean): void {
    try {
        window.localStorage.setItem(STORAGE_PREFIX + key, expanded ? '1' : '0');
    } catch {
        // A webview without storage forgets; the panel opens collapsed again.
    }
}

function button(className: string, text: string, label?: string): HTMLButtonElement {
    const b = element('button', className, text);
    b.type = 'button';
    if (label) {
        b.setAttribute('aria-label', label);
        b.title = label;
    }
    return b;
}

export class PropertiesView implements NodeView, SourceEditor {
    readonly dom: HTMLElement;
    private readonly header: HTMLElement;
    private readonly toggle: HTMLButtonElement;
    private readonly count: HTMLElement;
    private readonly sourceButton: HTMLButtonElement;
    private readonly content: HTMLElement;
    private parts: FrontMatterParts;
    private read: PropertiesRead;
    private expanded: boolean;
    /** The source box, while it is open. */
    private area: HTMLTextAreaElement | null = null;
    private untrackArea: (() => void) | null = null;
    /** The row (by index) of the list whose **+ add** field is open. */
    private addingItem: number | null = null;
    /** The **+ Add property** row's state while it is open: the name typed, and whether the value is asked now. */
    private adding: { name: string; value: string; stage: 'name' | 'value' } | null = null;
    /** The rows whose typing is not in the document yet, for a save to commit. */
    private readonly dirty = new Map<string, () => void>();
    private untrackDirty: (() => void) | null = null;

    constructor(private node: Node, private readonly getPos: GetPos, private readonly port: EditorPort) {
        this.dom = element('div', 'mep-atom mep-front-matter mep-properties');
        this.dom.contentEditable = 'false';
        this.header = element('div', 'mep-props-header');
        this.toggle = button('mep-props-toggle', '');
        this.count = element('span', 'mep-props-count');
        this.sourceButton = button('mep-props-source', 'Edit as source');
        this.sourceButton.title = 'Edit the YAML as text';
        this.header.append(this.toggle, this.sourceButton);
        this.content = element('div', 'mep-props-rows');
        this.dom.append(this.header, this.content);
        this.parts = splitFrontMatter(node.attrs.src as string);
        this.read = readProperties(this.parts.body);
        this.expanded = remembered(port.documentKey());
        this.toggle.addEventListener('click', () => this.setExpanded(!this.expanded));
        this.sourceButton.addEventListener('mousedown', e => {
            // A press while the box is open would blur it (a commit) and the click reopen it.
            if (this.area) {
                e.preventDefault();
            }
        });
        this.sourceButton.addEventListener('click', () => {
            if (this.area) {
                this.closeSource(true, true);
            } else {
                this.openSource(null);
            }
        });
        this.dom.addEventListener('keydown', e => this.onKey(e));
        // A press on a button or a checkbox while a field holds typing does not
        // take the focus: the blur would commit the typing and draw the rows
        // again between the press and the release, and the click would land on
        // nothing. The action commits the typing itself first (`flushDirty`).
        this.dom.addEventListener('mousedown', e => {
            const target = e.target as HTMLElement | null;
            if (this.dirty.size > 0 && target && !target.closest('input.mep-prop-input, textarea')) {
                e.preventDefault();
            }
        }, true);
        panels.set(this.dom, this);
        this.render();
    }

    // -- NodeView ------------------------------------------------------------

    update(node: Node): boolean {
        if (node.type !== this.node.type) {
            return false;
        }
        const changed = node.attrs.src !== this.node.attrs.src;
        this.node = node;
        if (changed) {
            this.parts = splitFrontMatter(node.attrs.src as string);
            this.read = readProperties(this.parts.body);
            this.render();
        }
        return true;
    }

    selectNode(): void {
        this.dom.classList.add('ProseMirror-selectednode');
    }

    deselectNode(): void {
        this.dom.classList.remove('ProseMirror-selectednode');
    }

    /** Every event inside is the panel's: its fields, buttons and source box. */
    stopEvent(event: Event): boolean {
        return event.type !== 'dragstart';
    }

    ignoreMutation(): boolean {
        return true;
    }

    destroy(): void {
        this.untrackArea?.();
        this.untrackDirty?.();
        this.untrackArea = null;
        this.untrackDirty = null;
    }

    /** A save: every row's typing and the open source box go into the document now. */
    commitSource(): void {
        this.flushDirty();
        if (this.area) {
            this.writeSource(this.area.value);
        }
    }

    // -- the verbs the page reaches -----------------------------------------------

    /** **Insert → Properties** made the panel: open it at the name of a new property. */
    startAdding(): void {
        this.adding = { name: '', value: '', stage: 'name' };
        this.expanded = true;
        remember(this.port.documentKey(), true);
        this.render();
        this.focusSlot('add:name');
    }

    // -- drawing -------------------------------------------------------------

    private setExpanded(expanded: boolean): void {
        this.expanded = expanded;
        remember(this.port.documentKey(), expanded);
        this.render();
        this.toggle.focus();
    }

    private render(): void {
        const memo = this.captureFocus();
        const n = this.read.properties.length;
        const open = this.expanded || this.area !== null;
        this.toggle.replaceChildren(
            element('span', 'mep-props-chevron', open ? '▾' : '▸'),
            element('span', 'mep-props-title', 'Properties'),
        );
        this.count.textContent = String(n);
        this.toggle.append(this.count);
        this.toggle.setAttribute('aria-expanded', String(open));
        this.toggle.title = open ? 'Hide the properties' : 'Show the properties';
        this.toggle.dataset.slot = 'toggle';
        this.sourceButton.dataset.slot = 'source';
        this.sourceButton.setAttribute('aria-pressed', String(this.area !== null));
        this.dom.classList.toggle('mep-expanded', open);
        if (this.area) {
            // The box is the edit: a redraw leaves it alone, as a raw block's does.
            return;
        }
        this.content.hidden = !open;
        if (!open) {
            this.content.replaceChildren();
            this.restoreFocus(memo);
            return;
        }
        const rows: HTMLElement[] = [];
        if (this.read.error !== null) {
            const row = element('div', 'mep-prop-row mep-prop-error');
            row.append(element('span', 'mep-prop-summary', `${this.read.error} `), this.sourceLink(null, -1));
            rows.push(row);
        } else {
            this.read.properties.forEach((property, index) => rows.push(this.row(property, index)));
            rows.push(this.addRow());
        }
        this.content.replaceChildren(...rows);
        this.restoreFocus(memo);
    }

    /**
     * The key as the model names it now: row `index` of the current read, when it
     * still holds `key`. An action looks it up when it runs, not when its row was
     * drawn — a commit in between (the typing a click made leave) may have moved
     * every offset after it — and by position as well as name, since `1:` and
     * `'1':` are two keys that read as one name.
     */
    private ref(index: number, key: string): KeyRef | null {
        const property = this.read.properties[index];
        return property && property.key === key ? { offset: property.offset, key } : null;
    }

    /** Write a row's edit, or nothing when the key moved away or the model refused it. */
    private apply(index: number, key: string, edit: (body: string, ref: KeyRef) => string | null): boolean {
        const ref = this.ref(index, key);
        const body = ref === null ? null : edit(this.parts.body, ref);
        if (body === null || body === this.parts.body) {
            return false;
        }
        this.write(body);
        return true;
    }

    private row(property: Property, index: number): HTMLElement {
        const row = element('div', 'mep-prop-row');
        row.dataset.key = property.key;
        row.dataset.kind = property.kind;
        const key = element('span', 'mep-prop-key', property.key);
        key.title = property.key;
        const value = element('div', 'mep-prop-value');
        value.append(...this.control(property, index));
        row.append(key, value);
        if (property.kind !== 'id') {
            // Beside the value it removes, not at the row's far end; a Tab stop of its own.
            const remove = button('mep-prop-remove', '×', `Remove ${property.key}`);
            remove.dataset.slot = `remove:${index}`;
            remove.addEventListener('click', () => this.removeRow(index, property.key));
            value.append(remove);
            // Shift+Delete on any of the row's controls removes the row too (a chip's field keeps its Backspace).
            row.addEventListener('keydown', e => {
                if (e.key === 'Delete' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.removeRow(index, property.key);
                }
            });
        }
        return row;
    }

    private removeRow(index: number, key: string): void {
        this.flushDirty();
        if (this.apply(index, key, removeProperty)) {
            this.port.hint(`Removed ${key} — ${undoKey()}`, this.header);
            this.focusAfterRemoval(index);
        }
    }

    /** After a row went, the focus on the row now in its place, else the one before, else the header. */
    private focusAfterRemoval(index: number): void {
        const rows = Array.from(this.content.querySelectorAll<HTMLElement>('.mep-prop-row[data-key]'));
        const target = rows[index] ?? rows[index - 1];
        const control = target?.querySelector<HTMLElement>('input, [tabindex="0"], button');
        (control ?? this.toggle).focus({ preventScroll: true });
    }

    private control(property: Property, index: number): HTMLElement[] {
        switch (property.kind) {
            case 'text':
            case 'choice':
            case 'date':
                return this.field(property, index);
            case 'boolean': {
                const box = element('input', 'mep-prop-check');
                box.type = 'checkbox';
                box.checked = property.text === 'true';
                box.dataset.slot = `value:${index}`;
                box.setAttribute('aria-label', property.key);
                box.addEventListener('change', () => {
                    const checked = box.checked;
                    this.flushDirty();
                    this.apply(index, property.key, (body, ref) => setBoolean(body, ref, checked));
                });
                return [box];
            }
            case 'id': {
                const id = element('span', 'mep-prop-id', property.text);
                id.tabIndex = 0;
                id.setAttribute('role', 'button');
                id.dataset.slot = `value:${index}`;
                id.title = 'Read-only — click to copy';
                id.setAttribute('aria-label', `${property.key}, read-only: ${property.text}. Copy`);
                const copy = () => {
                    copyText(property.text);
                    this.port.hint(`Copied ${property.key}`, id);
                };
                id.addEventListener('click', copy);
                id.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        copy();
                    }
                });
                return [id];
            }
            case 'list':
                return [this.chips(property, index)];
            case 'source': {
                const summary = element('span', 'mep-prop-summary', `${property.text} · `);
                return [summary, this.sourceLink(property, index)];
            }
        }
    }

    /**
     * A text, date or choice row: a one-line field committing on `Enter` and on
     * leaving, reverting on `Esc`, as wide as its value. A date is a text field
     * too, holding the date as the file writes it (`YYYY-MM-DD`) — the browser's
     * date input shows it in the system's locale (`09/29/2026`), a second
     * spelling beside the file's — with a calendar button (and `Alt+↓`) opening
     * the browser's picker. A choice (`lang`) lists the values the file uses in
     * the editor's own completion list under the field, opened on focus and
     * narrowed as typed.
     */
    private field(property: Property, index: number): HTMLElement[] {
        const input = element('input', 'mep-prop-input');
        const slot = `value:${index}`;
        input.type = 'text';
        input.value = property.text;
        input.spellcheck = false;
        input.placeholder = property.kind === 'date' ? 'YYYY-MM-DD' : 'empty';
        input.dataset.slot = slot;
        input.dataset.committed = property.text;
        input.setAttribute('aria-label', property.key);
        fitToValue(input);
        const out: HTMLElement[] = [input];
        /** Write the field's value; `false` when it cannot be (not a date), the reason said beside it. */
        const commit = (): boolean => {
            if (property.kind === 'date' && input.value !== property.text && !isDate(input.value)) {
                this.port.hint(`A date is written YYYY-MM-DD — Esc keeps ${property.text}`, input.isConnected ? input : this.header);
                return false;
            }
            this.clean(slot);
            const text = input.value;
            if (text !== property.text) {
                this.apply(index, property.key, (body, ref) => setText(body, ref, text));
            }
            return true;
        };
        let openPicker: (() => void) | null = null;
        if (property.kind === 'date') {
            const native = element('input', 'mep-prop-date-native');
            native.type = 'date';
            native.tabIndex = -1;
            native.setAttribute('aria-hidden', 'true');
            native.addEventListener('change', () => {
                if (isDate(native.value)) {
                    input.value = native.value;
                    commit();
                }
            });
            const pick = button('mep-prop-date-pick', '', `Choose ${property.key} in a calendar`);
            pick.tabIndex = -1;
            pick.append(calendarIcon());
            openPicker = () => {
                this.flushDirty();
                native.value = isDate(input.value) ? input.value : '';
                try {
                    native.showPicker();
                } catch {
                    native.focus();
                }
            };
            pick.addEventListener('click', () => openPicker?.());
            out.push(pick, native);
        }
        const choices = property.kind === 'choice' ? new ChoiceList(input, property.key, property.choices ?? [], value => {
            input.value = value;
            fitToValue(input);
            commit();
        }) : null;
        input.addEventListener('input', () => {
            fitToValue(input);
            choices?.filter();
            this.markDirty(slot, () => {
                if (!commit()) {
                    // Leaving with a value that is not a date: the file keeps its own.
                    input.value = property.text;
                    this.clean(slot);
                }
            });
        });
        input.addEventListener('focus', () => {
            if (!restoringFocus) {
                choices?.open();
            }
        });
        input.addEventListener('keydown', e => {
            if (choices?.handleKey(e)) {
                return;
            }
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                commit();
            } else if (e.key === 'ArrowDown' && e.altKey && openPicker) {
                e.preventDefault();
                e.stopPropagation();
                openPicker();
            } else if (e.key === 'Escape') {
                if (input.value !== property.text) {
                    e.preventDefault();
                    e.stopPropagation();
                    input.value = property.text;
                    fitToValue(input);
                    this.clean(slot);
                }
            }
        });
        input.addEventListener('blur', () => {
            choices?.close();
            if (input.value !== property.text) {
                // After the focus has moved: the redraw gives it back to where it went.
                setTimeout(() => {
                    this.dirty.get(slot)?.();
                }, 0);
            }
        });
        return out;
    }

    /** A list as chips, each removable, and **+ add**; the list's own style (flow or block) is the model's to keep. */
    private chips(property: Property, index: number): HTMLElement {
        const box = element('div', 'mep-prop-chips');
        const items = property.items ?? [];
        items.forEach((item, at) => {
            const chip = element('span', 'mep-prop-chip');
            chip.append(element('span', 'mep-prop-chip-text', item));
            const remove = button('mep-prop-chip-remove', '×', `Remove ${item}`);
            remove.tabIndex = -1;
            remove.addEventListener('click', () => {
                this.flushDirty();
                this.removeItemAt(index, property.key, at, item);
            });
            chip.append(remove);
            box.append(chip);
        });
        const slot = `add-item:${index}`;
        if (this.addingItem === index) {
            const input = element('input', 'mep-prop-input mep-prop-chip-input');
            input.type = 'text';
            input.placeholder = 'add';
            input.spellcheck = false;
            input.size = 10;
            input.dataset.slot = slot;
            input.dataset.committed = '';
            input.setAttribute('aria-label', `Add to ${property.key}`);
            const commit = (): boolean => {
                this.clean(slot);
                const value = input.value.trim();
                if (value === '') {
                    return false;
                }
                const eol = eolOf(this.node.attrs.src as string);
                if (this.apply(index, property.key, (body, ref) => addItem(body, ref, value, eol))) {
                    input.value = '';
                } else {
                    this.port.hint(`${value} cannot be added to ${property.key} here — edit it as source`, input.isConnected ? input : this.header);
                }
                return true;
            };
            input.addEventListener('input', () => this.markDirty(slot, () => {
                commit();
            }));
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    // The field stays open for the next item.
                    commit();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.clean(slot);
                    this.addingItem = null;
                    this.render();
                    this.focusSlot(`add-button:${index}`);
                } else if (e.key === 'Backspace' && input.value === '' && items.length > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.removeItemAt(index, property.key, items.length - 1, items[items.length - 1]);
                }
            });
            input.addEventListener('blur', () => {
                setTimeout(() => {
                    // Still adding: the redraw after an item went in gave the new field the focus.
                    if (this.addingItem !== index || (document.activeElement as HTMLElement | null)?.dataset.slot === slot) {
                        return;
                    }
                    this.dirty.get(slot)?.();
                    if (this.addingItem === index) {
                        this.addingItem = null;
                        this.render();
                    }
                }, 0);
            });
            box.append(input);
        } else {
            const add = button('mep-prop-chip mep-prop-chip-add', '+ add', `Add to ${property.key}`);
            add.dataset.slot = `add-button:${index}`;
            add.addEventListener('click', () => {
                this.flushDirty();
                this.addingItem = index;
                this.render();
                this.focusSlot(slot);
            });
            box.append(add);
        }
        return box;
    }

    private removeItemAt(index: number, key: string, at: number, item: string): void {
        const eol = eolOf(this.node.attrs.src as string);
        if (this.apply(index, key, (body, ref) => removeItem(body, ref, at, eol))) {
            this.port.hint(`Removed ${item} — ${undoKey()}`, this.header);
        } else {
            // An anchored item an alias elsewhere names, and the like: the model refuses rather than break the YAML.
            this.port.hint(`${item} cannot be removed here — edit ${key} as source`, this.header);
        }
    }

    /** The trailing row: **+ Add property**, then the name, then the value. */
    private addRow(): HTMLElement {
        const row = element('div', 'mep-prop-row mep-prop-add');
        const adding = this.adding;
        if (adding === null) {
            const add = button('mep-prop-add-button', '+ Add property');
            add.dataset.slot = 'add:button';
            add.addEventListener('click', () => {
                this.flushDirty();
                this.startAdding();
            });
            row.append(add);
            return row;
        }
        const name = element('input', 'mep-prop-input mep-prop-key-input');
        name.type = 'text';
        name.placeholder = 'name';
        name.spellcheck = false;
        name.value = adding.name;
        name.dataset.slot = 'add:name';
        // Nothing is committed yet: Ctrl+Z here undoes the typing, not the document.
        name.dataset.committed = '';
        name.setAttribute('aria-label', 'New property name');
        const value = element('input', 'mep-prop-input');
        value.type = 'text';
        value.placeholder = 'value';
        value.spellcheck = false;
        value.value = adding.value;
        value.dataset.slot = 'add:value';
        value.dataset.committed = '';
        value.setAttribute('aria-label', 'New property value');
        value.disabled = adding.stage === 'name';
        fitToValue(name);
        fitToValue(value);
        name.addEventListener('input', () => {
            adding.name = name.value;
            fitToValue(name);
        });
        value.addEventListener('input', () => {
            adding.value = value.value;
            fitToValue(value);
        });
        const cancel = () => {
            this.adding = null;
            this.render();
            this.focusSlot('add:button');
        };
        name.addEventListener('keydown', e => {
            if ((e.key === 'Enter' && !e.isComposing) || (e.key === 'Tab' && !e.shiftKey && name.value.trim() !== '')) {
                e.preventDefault();
                e.stopPropagation();
                const key = name.value.trim();
                if (key === '') {
                    return;
                }
                if (this.read.properties.some(p => p.key === key)) {
                    this.port.hint(`Already a property: ${key}`, name);
                    return;
                }
                adding.name = key;
                adding.stage = 'value';
                this.render();
                this.focusSlot('add:value');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
            }
        });
        value.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                const body = addProperty(this.parts.body, adding.name, value.value.trim(), eolOf(this.node.attrs.src as string));
                if (body === null) {
                    const reason = this.read.properties.some(p => p.key === adding.name)
                        ? `Already a property: ${adding.name}`
                        : `${adding.name} cannot be added here — edit the YAML as source`;
                    this.port.hint(reason, name);
                    return;
                }
                this.adding = null;
                this.write(body);
                this.focusSlot('add:button');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancel();
            } else if (e.key === 'Tab' && e.shiftKey) {
                // Back to the name, which is still being chosen.
                e.preventDefault();
                e.stopPropagation();
                adding.stage = 'name';
                this.render();
                this.focusSlot('add:name');
            }
        });
        row.append(name, value);
        return row;
    }

    /** *edit as source*: the source box, opened at the property's key (or at the start). */
    private sourceLink(property: Property | null, index: number): HTMLButtonElement {
        const link = button('mep-prop-source-link', 'edit as source');
        link.dataset.slot = `source:${index}`;
        link.title = property ? `Edit ${property.key} as YAML` : 'Edit the YAML as text';
        link.addEventListener('click', () => {
            this.flushDirty();
            // The key where it is now: a commit just made may have moved it.
            const now = property ? this.read.properties[index] : undefined;
            this.openSource(now && now.key === property?.key ? now : null);
        });
        return link;
    }

    // -- the source box ---------------------------------------------------------------

    /** The YAML between the fences in a textarea, the caret at `property`'s key and its line scrolled into view. */
    private openSource(property: Property | null): void {
        if (this.area) {
            return;
        }
        this.flushDirty();
        const body = this.parts.body;
        const area = element('textarea', 'mep-raw-editor mep-props-editor');
        area.value = body.replace(/\r\n?/g, '\n').replace(/\n$/, '');
        area.rows = Math.max(3, area.value.split('\n').length + 1);
        area.spellcheck = false;
        area.setAttribute('aria-label', 'Front matter YAML');
        area.addEventListener('keydown', e => {
            if (isUndoRedo(e)) {
                e.stopPropagation();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.closeSource(false, true);
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                this.closeSource(true, true);
            }
        });
        area.addEventListener('blur', () => this.closeSource(true, false));
        this.area = area;
        this.untrackArea = this.port.trackSourceEditor(this);
        this.render();
        this.content.hidden = false;
        this.content.replaceChildren(area);
        const at = property ? normalizedOffset(body, property.offset) : area.value.length;
        area.focus({ preventScroll: true });
        area.setSelectionRange(at, at);
        const line = area.value.slice(0, at).split('\n').length - 1;
        const style = getComputedStyle(area);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || 18;
        const top = area.getBoundingClientRect().top + (parseFloat(style.paddingTop) || 0) + line * lineHeight;
        // Clear of the formatting row fixed at the top, with the margin the page keeps above a
        // caret it scrolls to (main.ts, SCROLL_MARGIN: 64px).
        if (property !== null || top < 64 || top > window.innerHeight - lineHeight) {
            window.scrollBy(0, top - 80);
        }
    }

    /** `refocus`: closed by a key or the header's button, which gives the focus back to that button; a blur leaves it where it went. */
    private closeSource(commit: boolean, refocus: boolean): void {
        const area = this.area;
        if (!area) {
            return;
        }
        this.area = null;
        this.untrackArea?.();
        this.untrackArea = null;
        const value = area.value;
        this.render();
        if (commit) {
            this.writeSource(value);
        }
        if (refocus) {
            this.focusSlot('source');
        }
    }

    private writeSource(value: string): void {
        const eol = eolOf(this.node.attrs.src as string);
        const text = value.replace(/\r\n?/g, '\n');
        const body = text.trim() === '' ? '' : text.replace(/\n/g, eol) + eol;
        if (body !== this.parts.body) {
            this.write(body);
        }
    }

    // -- writing -------------------------------------------------------------------

    /** The new YAML as the node's `src`: one transaction, one undo step. */
    private write(body: string): void {
        const pos = this.getPos();
        if (pos === undefined) {
            return;
        }
        const src = joinFrontMatter({ ...this.parts, body });
        if (src !== this.node.attrs.src) {
            this.port.commitFrontMatter(pos, src);
        }
    }

    /** Every row's typing into the document now, before an action that reads it. */
    private flushDirty(): void {
        for (const commit of [...this.dirty.values()]) {
            commit();
        }
    }

    private markDirty(slot: string, commit: () => void): void {
        this.dirty.set(slot, commit);
        if (this.untrackDirty === null) {
            this.untrackDirty = this.port.trackSourceEditor({ commitSource: () => this.commitSource() });
        }
    }

    private clean(slot: string): void {
        this.dirty.delete(slot);
        if (this.dirty.size === 0 && this.untrackDirty) {
            this.untrackDirty();
            this.untrackDirty = null;
        }
    }

    // -- keys and focus --------------------------------------------------------------

    private onKey(e: KeyboardEvent): void {
        const target = e.target as HTMLElement | null;
        if (target === this.area) {
            return;
        }
        if (isUndoRedo(e)) {
            // A field with no committed value of its own (a new property's) is all typing.
            const typing = target instanceof HTMLInputElement && target.type === 'text'
                && (target.dataset.committed === undefined || target.value !== target.dataset.committed);
            // Kept from VS Code either way: its undo would revert the document.
            e.stopPropagation();
            if (!typing) {
                const redo = e.key.toLowerCase() === 'y' || e.shiftKey;
                if (this.port.history(redo ? 'redo' : 'undo')) {
                    e.preventDefault();
                }
            }
            return;
        }
        if (e.key === 'Escape' && !e.defaultPrevented) {
            // Nothing left to revert: out of the panel, into the text below.
            e.preventDefault();
            e.stopPropagation();
            this.port.leaveFrontMatter();
        }
    }

    private captureFocus(): FocusMemo | null {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !this.dom.contains(active) || !active.dataset.slot) {
            return null;
        }
        const input = active instanceof HTMLInputElement && active.type === 'text' ? active : null;
        return {
            slot: active.dataset.slot,
            value: input ? input.value : null,
            committed: input ? input.dataset.committed ?? null : null,
            selection: input && input.selectionStart !== null && input.selectionEnd !== null ? [input.selectionStart, input.selectionEnd] : null,
        };
    }

    /** The focus back on the element of the same slot; typing not yet committed kept, while the value under it did not change. */
    private restoreFocus(memo: FocusMemo | null): void {
        if (memo === null || this.dom.contains(document.activeElement)) {
            return;
        }
        const el = this.content.querySelector<HTMLElement>(`[data-slot="${cssEscape(memo.slot)}"]`)
            ?? this.header.querySelector<HTMLElement>(`[data-slot="${cssEscape(memo.slot)}"]`);
        if (!el) {
            this.toggle.focus({ preventScroll: true });
            return;
        }
        restoringFocus = true;
        try {
            el.focus({ preventScroll: true });
        } finally {
            restoringFocus = false;
        }
        if (el instanceof HTMLInputElement && el.type === 'text' && memo.value !== null) {
            if (memo.committed === el.dataset.committed && memo.value !== el.value) {
                el.value = memo.value;
            }
            const [from, to] = memo.selection ?? [el.value.length, el.value.length];
            el.setSelectionRange(Math.min(from, el.value.length), Math.min(to, el.value.length));
        }
    }

    private focusSlot(slot: string): void {
        const el = this.dom.querySelector<HTMLElement>(`[data-slot="${cssEscape(slot)}"]`);
        el?.focus({ preventScroll: true });
        if (el instanceof HTMLInputElement && el.type === 'text') {
            el.setSelectionRange(el.value.length, el.value.length);
        }
    }
}

/** The calendar glyph, drawn in the text's colour: an inline SVG, so no icon font has to be there. */
function calendarIcon(): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M4 1h1v1h6V1h1v1h2v12H2V2h2V1zm-1 4v8h10V5H3zm1-2v1h8V3H4zm1 4h2v2H5V7z');
    svg.append(path);
    return svg;
}

/** An offset in text with `\r\n` as an offset in its `\n` form, the textarea's. */
function normalizedOffset(text: string, offset: number): number {
    const before = text.slice(0, offset);
    return before.replace(/\r\n?/g, '\n').length;
}

function cssEscape(value: string): string {
    return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/** A read-only value to the clipboard: the async API where the webview grants it, else the selection's copy. */
function copyText(text: string): void {
    const fallback = () => {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        try {
            document.execCommand('copy');
        } catch {
            // Nothing more to try.
        }
        area.remove();
    };
    try {
        navigator.clipboard.writeText(text).catch(fallback);
    } catch {
        fallback();
    }
}

/**
 * A field as wide as its value, so what stands beside it (a row's ×) is beside
 * the value and not at the row's end. `field-sizing: content` does it where the
 * browser has it (`editor.css`); `size` is the fallback.
 */
function fitToValue(input: HTMLInputElement): void {
    input.size = Math.max(8, Math.min(80, (input.value || input.placeholder).length + 1));
}

/**
 * The values a choice row offers (`lang`), in the editor's one completion list
 * (`completionList.ts`) under the field: opened on focus, narrowed to the
 * values holding what is typed, `↓`/`↑` choose, `Enter` sets the chosen one
 * (with none chosen, the typed text), `Esc` closes the list before it reverts
 * the row. Any other value may be typed; the list offers, it does not constrain.
 */
class ChoiceList {
    private view: CompletionListView | null = null;
    private shown: readonly string[] = [];
    private readonly id = `mep-prop-choices-${++choiceSeq}`;

    constructor(
        private readonly input: HTMLInputElement,
        private readonly label: string,
        private readonly values: readonly string[],
        private readonly pick: (value: string) => void,
    ) {
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', this.id);
        input.autocomplete = 'off';
    }

    open(): void {
        this.show(this.values);
    }

    /** The values holding what is typed; all of them while the field holds one of them exactly. */
    filter(): void {
        const q = this.input.value.trim().toLowerCase();
        this.show(q === '' || this.values.includes(this.input.value) ? this.values : this.values.filter(v => v.toLowerCase().includes(q)));
    }

    close(): void {
        this.view?.remove();
        this.view = null;
        this.shown = [];
        this.input.setAttribute('aria-expanded', 'false');
        this.input.removeAttribute('aria-activedescendant');
    }

    /** A key the list takes: true when it did. */
    handleKey(e: KeyboardEvent): boolean {
        const view = this.view;
        if (view === null || this.shown.length === 0) {
            return false;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (e.altKey) {
                return false;
            }
            e.preventDefault();
            e.stopPropagation();
            const n = this.shown.length;
            const next = e.key === 'ArrowDown' ? (view.chosen + 1) % n : (view.chosen <= 0 ? n - 1 : view.chosen - 1);
            const option = view.choose(next);
            if (option) {
                this.input.setAttribute('aria-activedescendant', option.id);
            }
            return true;
        }
        if (e.key === 'Enter' && !e.isComposing && view.chosen >= 0) {
            e.preventDefault();
            e.stopPropagation();
            const value = this.shown[view.chosen];
            this.close();
            this.pick(value);
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            return true;
        }
        return false;
    }

    private show(values: readonly string[]): void {
        if (values.length === 0) {
            this.close();
            return;
        }
        this.shown = values;
        const view = this.view ?? new CompletionListView(this.id, this.label, CHOICE_KEYS, i => {
            const value = this.shown[i];
            this.close();
            this.pick(value);
        });
        view.render(values.map(value => ({ label: value, value, detail: value === this.input.dataset.committed ? 'current' : undefined })));
        if (this.view === null) {
            this.view = view;
            this.input.after(view.el);
        }
        view.el.style.left = `${this.input.offsetLeft}px`;
        view.el.style.minWidth = `${this.input.offsetWidth}px`;
        this.input.setAttribute('aria-expanded', 'true');
    }
}
