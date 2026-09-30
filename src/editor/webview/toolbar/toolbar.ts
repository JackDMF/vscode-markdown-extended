/**
 * The formatting toolbar at the top of the page, its menus and preview card,
 * and the bubble over a text selection — drawn from the action table
 * (`actions.ts`) and applied through `commands.ts`.
 *
 * - **The row** is one line of uniform controls: the block-type menu, the five
 *   native marks, the Formatting, Annotation and Insert menus. It never wraps;
 *   narrow, it scrolls sideways, so every control keeps its place. A mark's
 *   glyph is its real element (`<i>`, `<em>`, …) held to the button's size.
 * - **A menu** lists its entries as real samples — the element the parser makes,
 *   styled by the page's cascade — each normalized to one entry height (a block
 *   sample is scaled down with `zoom` until it fits), the syntax beside it.
 * - **The preview card** shows the hovered or focused entry at its natural size,
 *   in a short example, 300 ms after the pointer or the focus reaches it.
 * - **The bubble** offers, over a text selection, the five native marks, the
 *   extension's five (highlight, super- and subscript, strikethrough, key)
 *   and the two notes (`inBubble`).
 *
 * Everything lives inside the page's `body.markdown-body`, so a sample is
 * styled by the same stylesheets as the document; only the chrome is
 * `styles/editor.css`. The menus and the card are positioned `fixed` in a layer
 * of their own: the row scrolls, and a scrolling box clips what hangs out of it.
 *
 * Controls act on `mousedown` + `preventDefault`, so the editor keeps its focus
 * and its selection; they are reachable by Tab, menus by the arrow keys.
 */
import { EditorState, NodeSelection, Plugin, PluginView, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { LinkChoice, LinkedFile } from '../../protocol';
import { editorSchema } from '../../schema';
import { firstFree } from '../clearance';
import { showHint } from '../hint';
import { FieldStep, InlineField, fieldHeading, fieldKeys } from '../inlineField';
import { clearPendingRange, showPendingRange } from '../pendingRange';
import { editRawSourceAt } from '../nodeViews';
import { addPropertyAt } from '../properties';
import { inNoteOf, toggleNote, wrapNodeLockReason } from '../notes';
import {
    applySpanTransaction, attributesTargetAt, changeLinkTransaction, currentObject, editImageTransaction, IMAGE_LOCK, insertFilesTransaction, insertLinkTransaction, insertLockReason,
    LINK_LOCK, literalRefusal, objectAtSelection, spanLockReason,
} from '../objects';
import { ATTRIBUTES_FIELD_KEYS, attributesStep } from '../attributes';
import { insertTableTransaction } from '../tables';
import {
    MENU_LABELS, NO_INCLUDES_REFUSAL, PREVIEW_CARD_CLASS, PROPERTIES_PRESENT_REFUSAL, ROW_LAYOUT, SPAN_FIELD_PREFILL, SUBMENU_SYNTAX, SampleSpec, TOOLBAR_ACTIONS, ToolbarAction, ToolbarMenu, ToolbarSubmenu,
    elideDataUris, inBubble, inRow, menuOf, submenuOf, tooltipOf,
} from './actions';
import {
    SourceContext, WRAP_LOCK, blockCommand, blockLockReason, canWrapSource, currentBlock, insertPropertiesTransaction, insertSourceTransaction, insertWrapperTransaction, isCurrent,
    markActive, markRefusal, toggleMarkup, wrapSourceTransaction,
} from './commands';

/** What the toolbar needs from the page. */
export interface ToolbarHost {
    sourceContext(): SourceContext;
    /** Send the document now and ask the host to parse it again (`edit.reparse`). */
    flushReparse(): void;
    /** Ask the host to render a new source block. */
    requestRender(src: string): void;
    /** Whether any extension offers includes for this document (the `document` message's `includes`). */
    includesOffered(): boolean;
    /** Ask the host for an include line; the page inserts the answer after the current block (`main.ts`). */
    pickInclude(): void;
    /** What a link's (with `images`, an image's) path may complete to: the host's answer to `linkChoices`. */
    linkChoices(query: string, images: boolean): Promise<LinkChoice[]>;
    /** Ask the host for an image file (VS Code's open dialog); `chosen` gets it, as the page inserts it, unless the page moved on. */
    pickImage(chosen: (files: LinkedFile[]) => void): void;
}

/** How long the pointer or the focus rests on an entry before its preview card shows. */
const PREVIEW_DELAY_MS = 300;

/** Draw a sample: the element the parser makes, with its classes, attributes and content. */
export function renderSample(spec: SampleSpec): HTMLElement {
    const node = document.createElement(spec.tag);
    if (spec.className) {
        node.className = spec.className;
    }
    for (const [name, value] of Object.entries(spec.attrs ?? {})) {
        node.setAttribute(name, value);
    }
    for (const child of spec.children ?? []) {
        node.append(typeof child === 'string' ? child : renderSample(child));
    }
    return node;
}

function sampleHolder(spec: SampleSpec): HTMLElement {
    const holder = span('mep-sample');
    holder.append(renderSample(spec));
    return holder;
}

function span(className: string, text?: string): HTMLElement {
    const node = document.createElement('span');
    node.className = className;
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function div(className: string): HTMLElement {
    const node = document.createElement('div');
    node.className = className;
    return node;
}

interface ActionState {
    enabled: boolean;
    active: boolean;
    /** Why a disabled action is disabled, when there is something to say. */
    reason: string | null;
}

/** Whether each action applies at the selection, and whether it is what the selection already has. */
function evaluate(action: ToolbarAction, state: EditorState, includes: boolean): ActionState {
    const apply = action.apply;
    switch (apply.kind) {
        case 'mark': {
            const type = editorSchema.marks[apply.mark];
            const reason = markRefusal(state, type, apply.markup);
            return { enabled: reason === null && toggleMarkup(type, apply.markup)(state), active: markActive(state, type, apply.markup), reason };
        }
        case 'wrap-node': {
            // Inside a note of its kind the action removes it, like a mark's button.
            if (inNoteOf(state, apply.node)) {
                return { enabled: true, active: true, reason: null };
            }
            const reason = wrapNodeLockReason(state, apply.node);
            return { enabled: reason === null, active: false, reason };
        }
        case 'block': {
            if (apply.node === 'horizontal_rule') {
                return { enabled: true, active: false, reason: null };
            }
            const reason = blockLockReason(state);
            const active = reason === null && isCurrent(currentBlock(state), apply.node, apply.level);
            return { enabled: reason === null && (active || blockCommand(apply.node, apply.level)(state)), active, reason };
        }
        case 'wrap-source': {
            const enabled = canWrapSource(state);
            return { enabled, active: false, reason: enabled ? null : WRAP_LOCK };
        }
        case 'insert-source':
        case 'insert-wrapper':
        case 'insert-table':
            return { enabled: true, active: false, reason: null };
        case 'insert-include':
            return { enabled: includes, active: false, reason: includes ? null : NO_INCLUDES_REFUSAL };
        case 'insert-properties': {
            const present = state.doc.firstChild?.type === editorSchema.nodes.front_matter;
            return { enabled: !present, active: false, reason: present ? PROPERTIES_PRESENT_REFUSAL : null };
        }
        case 'attr-span': {
            const reason = spanLockReason(state);
            return { enabled: reason === null, active: false, reason };
        }
        case 'block-attrs': {
            const target = attributesTargetAt(state);
            return 'refusal' in target ? { enabled: false, active: false, reason: target.refusal } : { enabled: true, active: false, reason: null };
        }
        case 'insert-link': {
            const reason = objectAtSelection(state)?.kind === 'link' ? null : insertLockReason(state, LINK_LOCK);
            return { enabled: reason === null, active: false, reason };
        }
        case 'insert-image': {
            const reason = insertLockReason(state, IMAGE_LOCK);
            return { enabled: reason === null, active: false, reason };
        }
    }
}

/** Anything that performs an action: a row button, a bubble button, a menu entry. */
interface Tool {
    action: ToolbarAction;
    el: HTMLElement;
}

interface Menu {
    id: ToolbarMenu | ToolbarSubmenu;
    panel: HTMLElement;
    /** Its entries in order, the submenu's opener included; the arrow keys move between them. */
    items: HTMLElement[];
    tools: Tool[];
    /** A top-level menu's face in the row. */
    face?: HTMLElement;
    /** A submenu's entry in its parent, and the parent. */
    opener?: HTMLElement;
    parent?: Menu;
    children: Menu[];
}

function setState(node: HTMLElement, enabled: boolean, active: boolean): void {
    node.classList.toggle('mep-active', active);
    node.classList.toggle('mep-disabled', !enabled);
    node.setAttribute('aria-disabled', String(!enabled));
}

function isDisabled(node: HTMLElement): boolean {
    return node.getAttribute('aria-disabled') === 'true';
}

class ToolbarView implements PluginView {
    private readonly mount: HTMLElement;
    private readonly row: HTMLElement;
    private readonly bubble: HTMLElement;
    /** Where the menus and the card are, outside the row that scrolls. */
    private readonly layer: HTMLElement;
    private readonly card: HTMLElement;
    private readonly tools: Tool[] = [];
    private readonly menus: Menu[] = [];
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];
    private cardTimer: ReturnType<typeof setTimeout> | undefined;
    /** The field an action asked for a value in (a span's literal, a link's address, an image's alt text), while it is open. */
    private fieldBar: { bar: HTMLElement; field: InlineField } | null = null;

    constructor(private readonly view: EditorView, private readonly host: ToolbarHost) {
        this.mount = view.dom.parentElement as HTMLElement;
        this.layer = div('mep-toolbar-layer');
        this.card = div(`${PREVIEW_CARD_CLASS}`);
        this.card.hidden = true;
        this.card.setAttribute('role', 'tooltip');
        this.layer.append(this.card);
        this.row = this.buildRow();
        this.bubble = this.buildBubble();
        this.mount.insertBefore(this.row, view.dom);
        this.mount.append(this.bubble, this.layer);

        // The editor keeps the focus and the selection whatever is pressed here.
        for (const surface of [this.row, this.bubble, this.layer]) {
            surface.addEventListener('mousedown', e => e.preventDefault());
        }
        this.listen(view.dom, 'focusin', () => this.placeBubble());
        this.listen(view.dom, 'focusout', e => this.focusLeft(e as FocusEvent));
        this.listen(this.bubble, 'focusout', e => this.focusLeft(e as FocusEvent));
        this.listen(document, 'mousedown', e => {
            const target = e.target as Node;
            if (!this.row.contains(target) && !this.layer.contains(target)) {
                this.closeAll();
            }
        }, true);
        // Fixed menus would stay where the page scrolled away from; a menu's own
        // scrolling (a long list of admonitions) is not that.
        this.listen(window, 'scroll', e => {
            if (!this.layer.contains(e.target as Node)) {
                this.closeAll();
            }
        }, true);
        this.listen(window, 'resize', () => this.closeAll());
        this.update(view);
    }

    update(view: EditorView): void {
        const state = view.state;
        const states = new Map<ToolbarAction, ActionState>();
        const includes = this.host.includesOffered();
        const stateOf = (action: ToolbarAction) => {
            let s = states.get(action);
            if (!s) {
                s = evaluate(action, state, includes);
                states.set(action, s);
            }
            return s;
        };
        for (const tool of this.tools) {
            const s = stateOf(tool.action);
            setState(tool.el, s.enabled, s.active);
            tool.el.title = s.enabled || !s.reason ? tooltipOf(tool.action) : `${tooltipOf(tool.action)}\n${s.reason}`;
        }
        for (const menu of this.menus) {
            if (menu.opener) {
                const enabled = menu.tools.some(t => stateOf(t.action).enabled);
                setState(menu.opener, enabled, false);
            }
            if (menu.face) {
                this.updateFace(menu, stateOf);
            }
        }
        this.placeBubble();
    }

    destroy(): void {
        clearTimeout(this.cardTimer);
        this.closeFieldBar();
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.row.remove();
        this.bubble.remove();
        this.layer.remove();
    }

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    // -- the row and the bubble ------------------------------------------------

    private buildRow(): HTMLElement {
        const row = div('mep-toolbar');
        row.setAttribute('role', 'toolbar');
        row.setAttribute('aria-label', 'Formatting');
        for (const group of ROW_LAYOUT) {
            const box = div('mep-row-group');
            for (const item of group) {
                if (item === 'marks') {
                    for (const action of TOOLBAR_ACTIONS.filter(inRow)) {
                        box.append(this.markButton(action));
                    }
                } else {
                    box.append(this.menuFace(item));
                }
            }
            row.append(box);
        }
        // The row's right end: what the page says about the document as a
        // whole (the diagnostics count, `diagnostics.ts`), not a control of the text.
        row.append(div('mep-row-status'));
        return row;
    }

    private buildBubble(): HTMLElement {
        const bubble = div('mep-bubble');
        bubble.setAttribute('role', 'toolbar');
        bubble.setAttribute('aria-label', 'Format selection');
        bubble.hidden = true;
        for (const action of TOOLBAR_ACTIONS.filter(inBubble)) {
            bubble.append(this.markButton(action));
        }
        return bubble;
    }

    /** A mark's button: its glyph is the element the mark renders as, held to the button's size. */
    private markButton(action: ToolbarAction): HTMLElement {
        const button = div('mep-tool mep-mark-tool');
        button.dataset.action = action.id;
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        button.append(sampleHolder(action.sample));
        const tool = { action, el: button };
        button.addEventListener('click', e => {
            e.preventDefault();
            this.activate(tool);
        });
        button.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.activate(tool);
            }
        });
        this.tools.push(tool);
        return button;
    }

    private menuFace(id: ToolbarMenu): HTMLElement {
        const menu = this.buildMenu(id, TOOLBAR_ACTIONS.filter(a => menuOf(a) === id));
        const face = div('mep-tool mep-menu-face');
        face.dataset.menu = id;
        face.setAttribute('role', 'button');
        face.setAttribute('aria-haspopup', 'menu');
        face.setAttribute('aria-expanded', 'false');
        face.tabIndex = 0;
        face.append(span('mep-face-label', MENU_LABELS[id]), span('mep-menu-caret', '▾'));
        menu.face = face;
        face.addEventListener('click', e => {
            e.preventDefault();
            if (menu.panel.hidden) {
                this.openMenu(menu, false);
            } else {
                this.closeAll();
            }
        });
        face.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                this.openMenu(menu, true);
            } else if (e.key === 'Escape' && !menu.panel.hidden) {
                e.preventDefault();
                this.closeAll();
            }
        });
        return face;
    }

    /**
     * A block-type face names the type the selection is in, as text; a locked
     * one says why. Any other face is disabled when none of its entries applies.
     */
    private updateFace(menu: Menu, stateOf: (a: ToolbarAction) => ActionState): void {
        const face = menu.face as HTMLElement;
        const all = [...menu.tools, ...menu.children.flatMap(c => c.tools)];
        let label = MENU_LABELS[menu.id];
        let reason: string | null = null;
        let enabled: boolean;
        if (menu.id === 'block-type') {
            // Named also while locked: a requirement heading is still a heading.
            const current = currentBlock(this.view.state);
            const active = menu.tools.map(t => t.action).find(a => a.apply.kind === 'block' && isCurrent(current, a.apply.node, a.apply.level));
            face.dataset.shows = active?.id ?? '';
            label = active?.label ?? label;
            reason = blockLockReason(this.view.state);
            enabled = reason === null;
        } else {
            enabled = all.some(t => stateOf(t.action).enabled);
            reason = enabled ? null : all.map(t => stateOf(t.action).reason).find(r => r !== null) ?? null;
        }
        (face.querySelector('.mep-face-label') as HTMLElement).textContent = label;
        setState(face, enabled, false);
        const title = menu.id === 'block-type' && label !== MENU_LABELS[menu.id] ? `${MENU_LABELS[menu.id]}: ${label}` : label;
        face.title = reason === null ? title : `${title}\n${reason}`;
        if (!enabled && !menu.panel.hidden) {
            this.closeAll();
        }
    }

    // -- menus -----------------------------------------------------------------

    private buildMenu(id: ToolbarMenu | ToolbarSubmenu, actions: readonly ToolbarAction[], parent?: Menu): Menu {
        const panel = div('mep-menu');
        panel.dataset.menu = id;
        panel.setAttribute('role', 'menu');
        panel.setAttribute('aria-label', MENU_LABELS[id]);
        panel.hidden = true;
        this.layer.append(panel);
        const menu: Menu = { id, panel, items: [], tools: [], parent, children: [] };
        this.menus.push(menu);

        for (const action of actions) {
            const sub = parent ? null : submenuOf(action);
            if (sub !== null) {
                if (!menu.children.some(c => c.id === sub)) {
                    const child = this.buildMenu(sub, actions.filter(a => submenuOf(a) === sub), menu);
                    menu.children.push(child);
                    panel.append(this.submenuEntry(menu, child));
                }
                continue;
            }
            panel.append(this.menuEntry(menu, action));
        }
        panel.addEventListener('keydown', e => this.menuKey(menu, e));
        return menu;
    }

    private entry(menu: Menu): HTMLElement {
        const item = div('mep-menu-item');
        item.setAttribute('role', 'menuitem');
        item.tabIndex = -1;
        menu.items.push(item);
        return item;
    }

    private menuEntry(menu: Menu, action: ToolbarAction): HTMLElement {
        const item = this.entry(menu);
        item.dataset.action = action.id;
        const sample = span('mep-entry-sample');
        sample.append(sampleHolder(action.sample));
        item.append(sample, span('mep-entry-syntax', action.syntax.split('\n')[0]));
        const tool = { action, el: item };
        menu.tools.push(tool);
        this.tools.push(tool);
        item.addEventListener('click', e => {
            e.preventDefault();
            this.activate(tool);
        });
        item.addEventListener('mouseenter', () => {
            this.closeSubmenus(menu);
            this.scheduleCard(action, item, menu);
        });
        item.addEventListener('mouseleave', () => this.hideCard());
        item.addEventListener('focus', () => this.scheduleCard(action, item, menu));
        item.addEventListener('blur', () => this.hideCard());
        return item;
    }

    /** The entry that opens a submenu: its name and syntax, and a chevron. */
    private submenuEntry(menu: Menu, child: Menu): HTMLElement {
        const item = this.entry(menu);
        item.classList.add('mep-submenu-item');
        item.dataset.submenu = child.id;
        item.setAttribute('aria-haspopup', 'menu');
        item.setAttribute('aria-expanded', 'false');
        const label = span('mep-entry-sample');
        label.append(span('mep-entry-label', MENU_LABELS[child.id]));
        item.append(label, span('mep-entry-syntax', SUBMENU_SYNTAX[child.id as ToolbarSubmenu]), span('mep-menu-caret', '▸'));
        child.opener = item;
        item.addEventListener('mouseenter', () => {
            this.hideCard();
            this.openMenu(child, false);
        });
        item.addEventListener('click', e => {
            e.preventDefault();
            this.openMenu(child, false);
        });
        return item;
    }

    private menuKey(menu: Menu, e: KeyboardEvent): void {
        const focused = document.activeElement as HTMLElement | null;
        const index = focused ? menu.items.indexOf(focused) : -1;
        if (index < 0) {
            return;
        }
        const child = menu.children.find(c => c.opener === focused);
        const move = (step: number) => {
            const count = menu.items.length;
            for (let i = 1; i <= count; i++) {
                const next = menu.items[(((index + step * i) % count) + count) % count];
                if (!isDisabled(next)) {
                    next.focus({ preventScroll: true });
                    return;
                }
            }
        };
        const stop = () => {
            e.preventDefault();
            e.stopPropagation();
        };
        switch (e.key) {
            case 'ArrowDown':
                stop();
                move(1);
                break;
            case 'ArrowUp':
                stop();
                move(-1);
                break;
            case 'Enter':
            case ' ':
                stop();
                if (child) {
                    this.openMenu(child, true);
                } else {
                    const tool = menu.tools.find(t => t.el === focused);
                    if (tool) {
                        this.activate(tool);
                    }
                }
                break;
            case 'ArrowRight':
                if (child) {
                    stop();
                    this.openMenu(child, true);
                }
                break;
            case 'ArrowLeft':
            case 'Escape':
                if (e.key === 'ArrowLeft' && !menu.parent) {
                    break;
                }
                stop();
                this.closeMenu(menu);
                (menu.opener ?? menu.face)?.focus();
                break;
            case 'Tab':
                this.closeAll();
                break;
        }
    }

    private openMenu(menu: Menu, focusFirst: boolean): void {
        if (menu.face && isDisabled(menu.face)) {
            return;
        }
        if (menu.parent) {
            this.closeSubmenus(menu.parent);
        } else {
            this.closeAll();
        }
        menu.panel.hidden = false;
        (menu.face ?? menu.opener)?.setAttribute('aria-expanded', 'true');
        this.fitSamples(menu);
        this.place(menu);
        if (focusFirst) {
            menu.items.find(i => !isDisabled(i))?.focus({ preventScroll: true });
        }
    }

    private closeMenu(menu: Menu): void {
        for (const child of menu.children) {
            this.closeMenu(child);
        }
        if (!menu.panel.hidden) {
            menu.panel.hidden = true;
            (menu.face ?? menu.opener)?.setAttribute('aria-expanded', 'false');
        }
        if (this.card.dataset.menu === menu.id) {
            this.hideCard();
        }
    }

    private closeSubmenus(menu: Menu): void {
        for (const child of menu.children) {
            this.closeMenu(child);
        }
    }

    private closeAll(): void {
        for (const menu of this.menus) {
            if (!menu.parent) {
                this.closeMenu(menu);
            }
        }
        this.hideCard();
    }

    /** Under its face, or beside its opener; kept inside the window. */
    private place(menu: Menu): void {
        const panel = menu.panel;
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        let left: number;
        let top: number;
        if (menu.face) {
            const r = menu.face.getBoundingClientRect();
            left = r.left;
            top = r.bottom + 2;
        } else {
            const r = (menu.opener as HTMLElement).getBoundingClientRect();
            const p = (menu.parent as Menu).panel.getBoundingClientRect();
            left = p.right - 2;
            top = r.top - 4;
            if (left + width > window.innerWidth) {
                left = p.left - width + 2;
            }
        }
        panel.style.left = `${Math.max(0, Math.min(left, window.innerWidth - width))}px`;
        panel.style.top = `${Math.max(0, Math.min(top, window.innerHeight - height))}px`;
    }

    /**
     * Every entry is one height. A block sample (a heading, an admonition box, a
     * table) is scaled down with `zoom` until it fits the entry; an inline one
     * keeps its natural size and is clipped to the entry. Measured when the menu
     * opens, so it holds for whatever the stylesheets make of the sample.
     */
    private fitSamples(menu: Menu): void {
        for (const holder of Array.from(menu.panel.querySelectorAll<HTMLElement>('.mep-entry-sample'))) {
            const sample = holder.querySelector<HTMLElement>('.mep-sample > *');
            if (!sample) {
                continue;
            }
            sample.style.removeProperty('zoom');
            if (getComputedStyle(sample).display.startsWith('inline')) {
                continue;
            }
            const box = holder.getBoundingClientRect();
            const r = sample.getBoundingClientRect();
            const zoom = Math.min(1, r.height > 0 ? box.height / r.height : 1, r.width > 0 ? box.width / r.width : 1);
            if (zoom < 1) {
                sample.style.setProperty('zoom', zoom.toFixed(3));
            }
        }
    }

    // -- the preview card ------------------------------------------------------

    private scheduleCard(action: ToolbarAction, item: HTMLElement, menu: Menu): void {
        this.hideCard();
        if (!action.preview) {
            return;
        }
        this.cardTimer = setTimeout(() => this.showCard(action, item, menu), PREVIEW_DELAY_MS);
    }

    /**
     * The entry's construct at its natural size, from the cascade, with its
     * syntax beneath. The card is a formatting context of its own and clips what
     * it holds (`editor.css`), and `markdown-extended.css` keeps its margin
     * layout out of it, so a note or a sidebar renders stacked inside the card
     * at any window width instead of floating out of it.
     */
    private showCard(action: ToolbarAction, item: HTMLElement, menu: Menu): void {
        const preview = action.preview;
        if (!preview || menu.panel.hidden) {
            return;
        }
        const body = div('mep-preview-body');
        for (const node of preview.nodes) {
            body.append(renderSample(node));
        }
        const syntax = div('mep-preview-syntax');
        syntax.textContent = elideDataUris(preview.markdown);
        this.card.replaceChildren(body, syntax);
        // A disabled entry says why where the eye already is, not only in its tooltip.
        const now = evaluate(action, this.view.state, this.host.includesOffered());
        if (!now.enabled && now.reason) {
            const why = div('mep-preview-refusal');
            why.textContent = now.reason;
            this.card.append(why);
        }
        this.card.dataset.action = action.id;
        this.card.dataset.menu = menu.id;
        this.card.hidden = false;
        const p = menu.panel.getBoundingClientRect();
        const r = item.getBoundingClientRect();
        const width = this.card.offsetWidth;
        const height = this.card.offsetHeight;
        let left = p.right + 6;
        if (left + width > window.innerWidth) {
            left = p.left - width - 6;
        }
        this.card.style.left = `${Math.max(0, left)}px`;
        this.card.style.top = `${Math.max(0, Math.min(r.top, window.innerHeight - height))}px`;
    }

    private hideCard(): void {
        clearTimeout(this.cardTimer);
        this.cardTimer = undefined;
        this.card.hidden = true;
        delete this.card.dataset.action;
        delete this.card.dataset.menu;
    }

    // -- acting ----------------------------------------------------------------

    private activate(tool: Tool): void {
        if (isDisabled(tool.el)) {
            return;
        }
        this.closeAll();
        this.run(tool.action);
    }

    private run(action: ToolbarAction): void {
        const view = this.view;
        const apply = action.apply;
        switch (apply.kind) {
            case 'mark':
                toggleMarkup(editorSchema.marks[apply.mark], apply.markup)(view.state, view.dispatch);
                view.focus();
                return;
            case 'wrap-node':
                toggleNote(apply.node)(view.state, view.dispatch);
                view.focus();
                return;
            case 'block':
                blockCommand(apply.node, apply.level)(view.state, view.dispatch);
                view.focus();
                return;
            case 'wrap-source': {
                const tr = wrapSourceTransaction(view.state, apply, this.host.sourceContext());
                if (!tr) {
                    return;
                }
                view.dispatch(tr);
                // The block is source now; the host parses it and sends it back
                // rendered as the preview renders it.
                this.host.flushReparse();
                if (apply.definition !== undefined && tr.selection instanceof NodeSelection) {
                    editRawSourceAt(view, tr.selection.to);
                } else {
                    view.focus();
                }
                return;
            }
            case 'insert-source': {
                const { tr, pos, src } = insertSourceTransaction(view.state, apply.template, this.host.sourceContext());
                view.dispatch(tr);
                this.host.requestRender(src);
                editRawSourceAt(view, pos);
                return;
            }
            case 'insert-wrapper':
                view.dispatch(insertWrapperTransaction(view.state, apply));
                view.focus();
                return;
            case 'insert-table':
                view.dispatch(insertTableTransaction(view.state, apply.columns, apply.rows));
                view.focus();
                return;
            case 'insert-include':
                // VS Code's QuickPick takes the choice; the line comes back as
                // `includeChosen` and is inserted then, at the selection as it is.
                this.host.pickInclude();
                return;
            case 'insert-properties': {
                const tr = insertPropertiesTransaction(view.state, this.host.sourceContext().eol);
                if (tr) {
                    view.dispatch(tr);
                    // The panel is drawn: open it at the name of the first property.
                    addPropertyAt(view.nodeDOM(0));
                }
                return;
            }
            case 'attr-span':
                this.askSpanLiteral();
                return;
            case 'block-attrs':
                this.askBlockAttributes();
                return;
            case 'insert-link':
                this.askLink();
                return;
            case 'insert-image':
                // VS Code's open dialog takes the choice; the file comes back as
                // `filesChosen` and goes in then, at the selection as it is.
                this.host.pickImage(files => this.insertPicked(files));
                return;
        }
    }

    // -- the span's field ------------------------------------------------------

    /**
     * **Span with class**: the inline field, in a bar of the object toolbar's
     * kind under the selection, asks for the `{…}` literal — `{.}` with the caret
     * after the dot, so the class is typed at once — and `Enter` makes the
     * selection `[text]{literal}`. The selection stays in the state while the
     * field has the focus; a re-sync meanwhile maps it, so the commit applies to
     * the text it was opened for.
     */
    private askSpanLiteral(): void {
        const view = this.view;
        if (spanLockReason(view.state) !== null) {
            return;
        }
        this.openFieldBar('span', 'Span attributes', 'span-attributes', {
            value: SPAN_FIELD_PREFILL.value,
            caret: SPAN_FIELD_PREFILL.caret,
            label: 'Attributes',
            keys: ATTRIBUTES_FIELD_KEYS,
            commit: value => {
                view.focus();
                const refusal = literalRefusal(value, 'span');
                const tr = refusal === null ? applySpanTransaction(view.state, value) : null;
                if (tr === null) {
                    showHint(view, refusal ?? 'These attributes cannot be given to this text here.', 'refusal');
                    return;
                }
                view.dispatch(tr);
            },
        });
    }

    /**
     * **Attributes…**: the inline field, in a bar at the block the caret is in,
     * labelled with that block's name (`Paragraph · Attributes`) and prefilled
     * with its literal — or `{.}`, the caret after the dot — and `Enter` sets it
     * where markdown-it-attrs reads it for that block (`commitAttributes`).
     */
    private askBlockAttributes(): void {
        const target = attributesTargetAt(this.view.state);
        if ('refusal' in target) {
            showHint(this.view, target.refusal, 'refusal');
            return;
        }
        this.openFieldBar('block-attributes', target.name, 'block-attributes', attributesStep(this.view, target));
    }

    // -- links and images ------------------------------------------------------

    /**
     * **Insert → Link…** and `Ctrl+K`. In a link, its address, prefilled — the
     * object toolbar's **Edit link…** does the same. Over selected text, the
     * address; at a caret, the text first and then the address (an empty text
     * is the address itself). The address field completes from the host: the
     * workspace's files relative to the document, `#` headings of this document
     * or of the file typed before the `#`. False where no link can be made.
     */
    askLink(): boolean {
        const view = this.view;
        const complete = (query: string) => this.host.linkChoices(query, false);
        const object = objectAtSelection(view.state);
        if (object?.kind === 'link') {
            this.openFieldBar('link', 'Link', 'link-address', {
                value: object.mark.attrs.href as string,
                label: 'Address',
                complete,
                commit: value => {
                    view.focus();
                    const current = currentObject(view.state, object);
                    const tr = current?.kind === 'link' ? changeLinkTransaction(view.state, current, value) : null;
                    if (tr) {
                        view.dispatch(tr);
                    }
                },
            }, { from: object.from, to: object.to });
            return true;
        }
        const reason = insertLockReason(view.state, LINK_LOCK);
        if (reason !== null) {
            showHint(view, reason, 'refusal');
            return false;
        }
        const address = (text: string): FieldStep => ({
            value: '',
            label: 'Address',
            complete,
            commit: href => {
                view.focus();
                if (href.trim() === '') {
                    return;
                }
                const tr = insertLinkTransaction(view.state, text, href);
                if (tr === null) {
                    showHint(view, 'The link cannot be made here: the note around it could not be written back with it.', 'refusal');
                    return;
                }
                view.dispatch(tr);
            },
        });
        this.openFieldBar('link', 'Link', 'link-address', view.state.selection.empty
            ? { value: '', label: 'Text', placeholder: 'Text — empty: the address', commit: text => address(text) }
            : address(''));
        return true;
    }

    /**
     * The files the host chose (**Insert → Image…**) put at the selection as
     * it is now; one image is then selected and its alt text asked for in the
     * field, the file's name prefilled — `Esc` keeps that name.
     */
    private insertPicked(files: readonly LinkedFile[]): void {
        const view = this.view;
        view.focus();
        if (files.length === 0) {
            return;
        }
        const tr = insertFilesTransaction(view.state, files);
        if (tr === null) {
            showHint(view, insertLockReason(view.state, IMAGE_LOCK) ?? 'The image cannot be inserted here.', 'refusal');
            return;
        }
        view.dispatch(tr);
        const sel = view.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type !== editorSchema.nodes.image) {
            return;
        }
        const at = sel.from;
        const node = sel.node;
        this.openFieldBar('image', 'Image', 'image-alt', {
            value: (node.attrs.alt as string | null) ?? '',
            label: 'Alt text',
            commit: alt => {
                view.focus();
                const now = view.state.doc.nodeAt(at);
                const tr2 = now && now.type === node.type && now.attrs.src === node.attrs.src
                    ? editImageTransaction(view.state, at, alt, now.attrs.src as string) : null;
                if (tr2) {
                    view.dispatch(tr2);
                }
            },
        });
    }

    /**
     * A bar of the object toolbar's kind under the selection, holding the
     * inline field for `step` — and, when its commit names another step, the
     * next field in its place. The selection stays in the state while the
     * field has the focus; a re-sync meanwhile maps it, so the commit applies
     * where the field was opened.
     */
    private openFieldBar(object: string, barLabel: string, verb: string, first: FieldStep, range?: { from: number; to: number }): void {
        this.closeFieldBar();
        const view = this.view;
        const bar = div('mep-object-toolbar');
        bar.dataset.trigger = 'toolbar';
        bar.dataset.object = object;
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', barLabel);
        bar.addEventListener('mousedown', e => {
            if (!(e.target instanceof HTMLInputElement)) {
                e.preventDefault();
            }
        });
        const label = span('mep-object-label', barLabel);
        const close = () => {
            if (this.fieldBar?.bar === bar) {
                this.fieldBar = null;
            }
            bar.remove();
            clearPendingRange(view);
        };
        const open = (step: FieldStep) => {
            const field = new InlineField({
                value: step.value,
                caret: step.caret,
                label: step.label,
                placeholder: step.placeholder,
                complete: step.complete,
                onCommit: value => {
                    const next = step.commit(value);
                    if (next) {
                        open(next).focus();
                        return;
                    }
                    close();
                },
                onCancel: reason => {
                    close();
                    if (reason === 'escape') {
                        view.focus();
                    }
                },
            });
            field.el.dataset.verb = verb;
            label.textContent = fieldHeading(barLabel, step.label);
            bar.replaceChildren(label, field.el, ...(step.keys ? [fieldKeys(step.keys)] : []));
            this.fieldBar = { bar, field };
            return field;
        };
        this.mount.append(bar);
        const field = open(first);
        // Where no content is, as every bar (`clearance.ts`): under the
        // selection's last line, above its first, or beside its block. Placed
        // before the field takes the focus, which scrolls it into view.
        const sel = view.state.selection;
        const start = view.coordsAtPos(sel.from, 1);
        const end = view.coordsAtPos(sel.to, -1);
        const base = this.mount.getBoundingClientRect();
        const width = bar.offsetWidth;
        const height = bar.offsetHeight;
        const gap = 6;
        const x = Math.max(base.left, Math.min(start.left, base.right - width));
        const blockDom = sel.$from.depth >= 1 ? view.nodeDOM(sel.$from.before(1)) : null;
        const beside = (blockDom instanceof Element ? blockDom.getBoundingClientRect().right : -Infinity) + gap;
        const below = end.bottom + gap;
        const found = firstFree(view, this.mount, [
            { x, y: below },
            { x, y: start.top - height - gap },
            { x: beside, y: start.top, when: () => beside + width <= base.right },
            { x: base.right - width, y: start.top },
        ], { width, height }, bar);
        bar.style.left = `${Math.max(base.left, Math.min(found?.x ?? x, base.right - width)) - base.left}px`;
        bar.style.top = `${(found?.y ?? below) - base.top}px`;
        // What the field acts on stays visible while the field has the focus.
        showPendingRange(view, range?.from ?? sel.from, range?.to ?? sel.to);
        field.focus();
    }

    private closeFieldBar(): void {
        this.fieldBar?.field.dispose();
        this.fieldBar?.bar.remove();
        this.fieldBar = null;
    }

    // -- the bubble ------------------------------------------------------------

    private focusLeft(e: FocusEvent): void {
        const to = e.relatedTarget as Node | null;
        if (to && (this.bubble.contains(to) || this.view.dom.contains(to))) {
            return;
        }
        this.bubble.hidden = true;
    }

    /**
     * Over a non-empty text selection in editable text, while the editor (or
     * the bubble) has the focus: above the selection's first line, centred on it
     * when the selection is on one line — unless there it would cover content
     * (the line above, a table's row above) or sit under the sticky toolbar;
     * then beside the block, just right of its edge on the selection's line,
     * where the block is narrower than the column — close to what it acts on,
     * as the mapping between a control and its object weakens with distance —
     * else below the selection's last line where that is free, else at the
     * column's right edge on its line, else below: a bar never covers content
     * where it can help it (`clearance.ts`), and never the row above, which is
     * what the person reads while choosing. Hidden otherwise.
     */
    private placeBubble(): void {
        const view = this.view;
        const sel = view.state.selection;
        const focused = view.hasFocus() || this.bubble.contains(document.activeElement);
        const inText = sel instanceof TextSelection && !sel.empty
            && sel.$from.parent.inlineContent && sel.$to.parent.inlineContent && !sel.$from.parent.type.spec.code;
        if (!focused || !inText) {
            this.bubble.hidden = true;
            return;
        }
        this.bubble.hidden = false;
        const start = view.coordsAtPos(sel.from, 1);
        const end = view.coordsAtPos(sel.to, -1);
        const base = this.mount.getBoundingClientRect();
        const width = this.bubble.offsetWidth;
        const height = this.bubble.offsetHeight;
        const gap = 6;
        const oneLine = Math.abs(start.top - end.top) < 2;
        let x = oneLine ? (start.left + end.right) / 2 - width / 2 : start.left;
        x = Math.max(base.left, Math.min(x, base.right - width));
        const above = start.top - height - gap;
        const below = end.bottom + gap;
        // Beside the block: just right of its box, which only a block narrower than the column — a table — leaves room for.
        const blockDom = sel.$from.depth >= 1 ? view.nodeDOM(sel.$from.before(1)) : null;
        const beside = (blockDom instanceof Element ? blockDom.getBoundingClientRect().right : -Infinity) + gap;
        const found = firstFree(view, this.mount, [
            { x, y: above },
            // Close to what it acts on: a narrow table's edge is a few pixels from its cell.
            { x: beside, y: start.top, when: () => beside + width <= base.right },
            { x, y: below },
            // At the column's right edge on the selection's line.
            { x: base.right - width, y: start.top },
        ], { width, height }, this.bubble);
        // Nowhere free: below, never over the row above, which is read while choosing.
        this.bubble.style.left = `${(found?.x ?? x) - base.left}px`;
        this.bubble.style.top = `${(found?.y ?? below) - base.top}px`;
    }

    /** Whether the bubble is shown now: while it is, the object toolbar shows no block's bar, so there is one thing at a time. */
    get bubbleShown(): boolean {
        return !this.bubble.hidden;
    }
}

const toolbarViews = new WeakMap<EditorView, ToolbarView>();

/** The status slot at the right end of the view's formatting row; `null` without a toolbar. */
export function toolbarStatusSlot(view: EditorView): HTMLElement | null {
    return view.dom.parentElement?.querySelector<HTMLElement>(':scope > .mep-toolbar > .mep-row-status') ?? null;
}

/** Whether the selection bubble of `view` is shown: the object toolbar hides every block's bar meanwhile. */
export function selectionBubbleShown(view: EditorView): boolean {
    return toolbarViews.get(view)?.bubbleShown ?? false;
}

/**
 * The toolbar and the bubble, as a plugin: its view is built with the editor's
 * and follows every state it takes. `Ctrl+K` (`Cmd+K`) is **Insert → Link…**;
 * the key is kept from VS Code, whose `Ctrl+K` starts a chord.
 */
export function toolbarPlugin(host: ToolbarHost): Plugin {
    return new Plugin({
        view: view => {
            const toolbar = new ToolbarView(view, host);
            toolbarViews.set(view, toolbar);
            return toolbar;
        },
        props: {
            handleKeyDown(view, event) {
                if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
                    return false;
                }
                event.preventDefault();
                event.stopPropagation();
                toolbarViews.get(view)?.askLink();
                return true;
            },
        },
    });
}
