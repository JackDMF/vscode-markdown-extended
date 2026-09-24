/**
 * The formatting toolbar at the top of the page and the bubble over a text
 * selection, drawn from the action table (`actions.ts`) and applied through
 * `commands.ts`.
 *
 * Both live inside the page's `body.markdown-body`, next to the editor, so a
 * sample element in a button — `<i>`, `<mark>`, `<span class="sn-ref">`, a whole
 * admonition box — is styled by the same cascade as the document: the button
 * looks like the construct because it *is* the construct. Their own chrome
 * (frame, hover, focus, the menus) is `styles/editor.css`, in `--vscode-*`
 * colours.
 *
 * Tools are `role="button"` elements rather than `<button>`s: a button's
 * user-agent font would stand between the page's cascade and the sample. They
 * act on `mousedown` + `preventDefault`, so the editor keeps its focus and its
 * selection, and are reachable by Tab and act on Enter or Space.
 */
import { EditorState, NodeSelection, Plugin, PluginView, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { editorSchema } from '../../schema';
import { editRawSourceAt } from '../nodeViews';
import {
    BUBBLE_GROUPS, MENU_FACES, MENU_LABELS, SampleSpec, TOOLBAR_ACTIONS, TOOLBAR_GROUPS, ToolbarAction, ToolbarGroup, ToolbarMenu, tooltipOf,
} from './actions';
import {
    SourceContext, blockCommand, blockLockReason, canWrapSource, currentBlock, insertSourceTransaction, isCurrent, markActive,
    toggleMarkup, wrapSourceTransaction,
} from './commands';

/** What the toolbar needs from the page. */
export interface ToolbarHost {
    sourceContext(): SourceContext;
    /** Send the document now and ask the host to parse it again (`edit.reparse`). */
    flushReparse(): void;
    /** Ask the host to render a new source block. */
    requestRender(src: string): void;
}

/** Draw a sample: the element the parser makes, with its classes, text and children. */
export function renderSample(spec: SampleSpec): HTMLElement {
    const node = document.createElement(spec.tag);
    if (spec.className) {
        node.className = spec.className;
    }
    for (const [name, value] of Object.entries(spec.attrs ?? {})) {
        node.setAttribute(name, value);
    }
    if (spec.text !== undefined) {
        node.append(spec.text);
    }
    for (const child of spec.children ?? []) {
        node.append(renderSample(child));
    }
    return node;
}

function sampleOf(action: ToolbarAction): HTMLElement {
    const holder = document.createElement('span');
    holder.className = action.zoom !== undefined ? 'mep-sample mep-sample-block' : 'mep-sample';
    const sample = renderSample(action.sample);
    if (action.zoom !== undefined) {
        sample.style.setProperty('zoom', String(action.zoom));
    }
    holder.append(sample);
    return holder;
}

interface ActionState {
    enabled: boolean;
    active: boolean;
    /** Why a disabled action is disabled, when there is something to say. */
    reason: string | null;
}

/** Whether each action applies at the selection, and whether it is what the selection already has. */
function evaluate(action: ToolbarAction, state: EditorState): ActionState {
    const apply = action.apply;
    switch (apply.kind) {
        case 'mark': {
            const type = editorSchema.marks[apply.mark];
            return { enabled: toggleMarkup(type, apply.markup)(state), active: markActive(state, type, apply.markup), reason: null };
        }
        case 'block': {
            if (apply.node === 'horizontal_rule') {
                return { enabled: true, active: false, reason: null };
            }
            const reason = blockLockReason(state);
            const active = reason === null && isCurrent(currentBlock(state), apply.node, apply.level);
            return { enabled: reason === null && (active || blockCommand(apply.node, apply.level)(state)), active, reason };
        }
        case 'wrap-source':
            return { enabled: canWrapSource(state), active: false, reason: null };
        case 'insert-source':
            return { enabled: true, active: false, reason: null };
    }
}

interface Tool {
    action: ToolbarAction;
    el: HTMLElement;
}

interface Dropdown {
    menu: ToolbarMenu;
    root: HTMLElement;
    face: HTMLElement;
    list: HTMLElement;
    items: Tool[];
}

function setState(el: HTMLElement, enabled: boolean, active: boolean): void {
    el.classList.toggle('mep-active', active);
    el.classList.toggle('mep-disabled', !enabled);
    el.setAttribute('aria-disabled', String(!enabled));
}

class ToolbarView implements PluginView {
    private readonly mount: HTMLElement;
    private readonly toolbar: HTMLElement;
    private readonly bubble: HTMLElement;
    private readonly tools: Tool[] = [];
    private readonly dropdowns: Dropdown[] = [];
    private readonly listeners: [EventTarget, string, EventListener, boolean][] = [];

    constructor(private readonly view: EditorView, private readonly host: ToolbarHost) {
        this.mount = view.dom.parentElement as HTMLElement;
        this.toolbar = this.surface('mep-toolbar', 'Formatting', TOOLBAR_GROUPS, true);
        this.bubble = this.surface('mep-bubble', 'Format selection', BUBBLE_GROUPS, false);
        this.bubble.hidden = true;
        this.mount.insertBefore(this.toolbar, view.dom);
        this.mount.append(this.bubble);

        this.listen(view.dom, 'focusin', () => this.placeBubble());
        this.listen(view.dom, 'focusout', e => this.focusLeft(e as FocusEvent));
        this.listen(this.bubble, 'focusout', e => this.focusLeft(e as FocusEvent));
        this.listen(document, 'mousedown', e => {
            for (const d of this.dropdowns) {
                if (!d.root.contains(e.target as Node)) {
                    this.closeMenu(d);
                }
            }
        }, true);
        this.update(view);
    }

    update(view: EditorView): void {
        const state = view.state;
        const states = new Map<ToolbarAction, ActionState>();
        const stateOf = (action: ToolbarAction) => {
            let s = states.get(action);
            if (!s) {
                s = evaluate(action, state);
                states.set(action, s);
            }
            return s;
        };
        for (const tool of this.tools) {
            const s = stateOf(tool.action);
            setState(tool.el, s.enabled, s.active);
            tool.el.title = s.enabled || !s.reason ? tooltipOf(tool.action) : `${tooltipOf(tool.action)}\n${s.reason}`;
        }
        for (const d of this.dropdowns) {
            this.updateFace(d, stateOf);
        }
        this.placeBubble();
    }

    destroy(): void {
        for (const [target, type, listener, capture] of this.listeners) {
            target.removeEventListener(type, listener, capture);
        }
        this.toolbar.remove();
        this.bubble.remove();
    }

    // -- building -------------------------------------------------------------

    private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
        target.addEventListener(type, listener, capture);
        this.listeners.push([target, type, listener, capture]);
    }

    private surface(className: string, label: string, groups: readonly ToolbarGroup[], withMenus: boolean): HTMLElement {
        const root = document.createElement('div');
        root.className = className;
        root.setAttribute('role', 'toolbar');
        root.setAttribute('aria-label', label);
        // The editor keeps the focus and the selection whatever is pressed here.
        root.addEventListener('mousedown', e => e.preventDefault());
        for (const group of groups) {
            const box = document.createElement('div');
            box.className = 'mep-toolbar-group';
            box.dataset.group = group;
            const menus = new Map<ToolbarMenu, Dropdown>();
            for (const action of TOOLBAR_ACTIONS.filter(a => a.group === group)) {
                if (action.menu === undefined) {
                    box.append(this.tool(action, 'mep-tool'));
                } else if (withMenus) {
                    let dropdown = menus.get(action.menu);
                    if (!dropdown) {
                        dropdown = this.dropdown(action.menu);
                        menus.set(action.menu, dropdown);
                        box.append(dropdown.root);
                    }
                    const item = this.tool(action, 'mep-tool mep-menu-item', () => this.closeMenu(dropdown as Dropdown));
                    item.setAttribute('role', 'menuitem');
                    dropdown.list.append(item);
                    dropdown.items.push(this.tools[this.tools.length - 1]);
                }
            }
            if (box.childElementCount > 0) {
                root.append(box);
            }
        }
        return root;
    }

    private tool(action: ToolbarAction, className: string, after?: () => void): HTMLElement {
        const el = document.createElement('div');
        el.className = className;
        el.dataset.action = action.id;
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
        el.append(sampleOf(action));
        const activate = () => {
            if (el.getAttribute('aria-disabled') === 'true') {
                return;
            }
            after?.();
            this.run(action);
        };
        el.addEventListener('click', e => {
            e.preventDefault();
            activate();
        });
        el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate();
            }
        });
        this.tools.push({ action, el });
        return el;
    }

    private dropdown(menu: ToolbarMenu): Dropdown {
        const root = document.createElement('div');
        root.className = 'mep-dropdown';
        root.dataset.menu = menu;
        const face = document.createElement('div');
        face.className = 'mep-tool mep-menu-face';
        face.setAttribute('role', 'button');
        face.setAttribute('aria-haspopup', 'menu');
        face.setAttribute('aria-expanded', 'false');
        face.tabIndex = 0;
        const list = document.createElement('div');
        list.className = 'mep-menu';
        list.setAttribute('role', 'menu');
        list.setAttribute('aria-label', MENU_LABELS[menu]);
        list.hidden = true;
        root.append(face, list);
        const dropdown: Dropdown = { menu, root, face, list, items: [] };
        const toggle = () => {
            if (face.getAttribute('aria-disabled') === 'true') {
                return;
            }
            if (list.hidden) {
                this.openMenu(dropdown);
            } else {
                this.closeMenu(dropdown);
            }
        };
        face.addEventListener('click', e => {
            e.preventDefault();
            toggle();
        });
        face.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                toggle();
                if (!list.hidden) {
                    (list.querySelector('.mep-menu-item:not(.mep-disabled)') as HTMLElement | null)?.focus();
                }
            }
        });
        root.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !list.hidden) {
                e.preventDefault();
                this.closeMenu(dropdown);
                face.focus();
            }
        });
        this.dropdowns.push(dropdown);
        return dropdown;
    }

    private openMenu(dropdown: Dropdown): void {
        for (const d of this.dropdowns) {
            if (d !== dropdown) {
                this.closeMenu(d);
            }
        }
        dropdown.list.hidden = false;
        dropdown.face.setAttribute('aria-expanded', 'true');
    }

    private closeMenu(dropdown: Dropdown): void {
        dropdown.list.hidden = true;
        dropdown.face.setAttribute('aria-expanded', 'false');
    }

    /**
     * A menu's face is a sample too: the block-type control shows the type the
     * selection is in, the admonition menu a fixed one. Locked, the face says why.
     */
    private updateFace(d: Dropdown, stateOf: (a: ToolbarAction) => ActionState): void {
        const active = d.items.find(t => stateOf(t.action).active)?.action;
        const shown = active ?? TOOLBAR_ACTIONS.find(a => a.id === MENU_FACES[d.menu]) as ToolbarAction;
        if (d.face.dataset.shows !== shown.id) {
            d.face.dataset.shows = shown.id;
            const caret = document.createElement('span');
            caret.className = 'mep-menu-caret';
            caret.textContent = '▾';
            d.face.replaceChildren(sampleOf(shown), caret);
        }
        const reason = d.menu === 'block-type' ? blockLockReason(this.view.state) : null;
        setState(d.face, reason === null, false);
        const label = active ? `${MENU_LABELS[d.menu]}: ${active.label}` : MENU_LABELS[d.menu];
        d.face.title = reason === null ? label : `${label}\n${reason}`;
        if (reason !== null) {
            this.closeMenu(d);
        }
    }

    // -- acting ---------------------------------------------------------------

    private run(action: ToolbarAction): void {
        const view = this.view;
        const apply = action.apply;
        switch (apply.kind) {
            case 'mark':
                toggleMarkup(editorSchema.marks[apply.mark], apply.markup)(view.state, view.dispatch);
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
        }
    }

    // -- the bubble -----------------------------------------------------------

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
     * when the selection is on one line — or below its last line when above
     * would put it under the sticky toolbar. Hidden otherwise.
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
        let y = start.top - height - gap;
        if (y < this.toolbar.getBoundingClientRect().bottom) {
            y = end.bottom + gap;
        }
        this.bubble.style.left = `${x - base.left}px`;
        this.bubble.style.top = `${y - base.top}px`;
    }
}

/** The toolbar and the bubble, as a plugin: its view is built with the editor's and follows every state it takes. */
export function toolbarPlugin(host: ToolbarHost): Plugin {
    return new Plugin({ view: view => new ToolbarView(view, host) });
}
